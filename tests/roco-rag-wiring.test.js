// RC-205 RAG 接线的守卫（`ROCO_RAG_MODE` ∈ legacy|shadow|rag）。
//
// 为什么这一组必须存在
// --------------------
// 「把新检索引擎接进产品」有四种最省事的假做法，四种都不会红：
//   ① 只接一处：`toolbox.js` 的 `search_rules` 分派改了，但生产路径
//      （`createCoachServer({semantic:true})` 注入的 `retrieve`）在 `runtime.runTool` 里
//      **短路**掉了那个分派 —— 于是线上跑的还是老路，测试却全绿；
//   ② shadow 悄悄改了行为：多带一个字段本来是观察，结果卡片集合/正文也跟着变了；
//   ③ 兜底不吭声：RAG 空了就默默用词法结果顶上，回执里看不出走过哪条路；
//   ④ 索引是装饰品：删掉语料里的一条规则，答案一个字不变（那说明模型在凭记忆答）。
// 所以这一组钉八个方向，其中③④⑦⑧是**反证/对照**，不是声明。
//
// 用法：`node --test tests/roco-rag-wiring.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  RAG_MODES,
  configureRagRetrieval,
  currentRagMode,
  executeTool,
  ragAugmentSearchRules,
  ragMode,
  searchRulesWithRag,
} from '../src/coach/toolbox.js';
import {REPO_ROOT as RAG_ROOT} from '../src/coach/rag-libs.js';
import {SCORE_FLOOR, createRagIndexSet, loadCorpus, searchIndex} from '../src/coach/rag-index.js';
import {gatherAgentEvidence} from '../src/coach/runtime.js';
import {searchKnowledge} from '../src/coach/strategist.js';
import {buildContext} from '../src/coach/runtime.js';
import {createGame, buildVersusOpponent} from '../src/game/engine.js';

const log = (...args) => console.log('  ·', ...args);

const corpus = loadCorpus();
const indexSet = createRagIndexSet(corpus);
const heldout = JSON.parse(readFileSync(join(RAG_ROOT, 'data/roco/rag/heldout-queries.json'), 'utf8'));
const ANSWERABLE = heldout.queries.filter((query) => query.expected !== 'ABSTAIN');
const LEDGER_QUERY = '哪条台账说回合末自然回能被多源反驳';
const game = createGame(17, ['fox', 'turtle', 'deer'], {mode: 'pve', difficulty: 'normal', ...buildVersusOpponent(17, {level: 2})});
const context = buildContext(game, newProfile(), 'fox');
function newProfile() {
  return {pets: [{id: 'fox', name: '芽角鹿', level: 5, type: 'leaf', hp: 40, maxHp: 40, energy: 6, skills: []}], items: {potion: 1}, pool_summary: null};
}
/**
 * 注入形状②：只换**语料/索引**，检索逻辑仍然用生产那一份（toolbox 的 lookupWithModule）。
 * 这样测试里不存在第二份「规则通道 + 玩家通道」实现 —— 抄一份必然漂。
 */
const withIndexSet = (set) => configureRagRetrieval({mod: {searchIndex, SCORE_FLOOR}, set});

// ─────────────────────────────────────────────────────────────────────────
// 1. 两处插入点（静态 + 真的跑一遍）
// ─────────────────────────────────────────────────────────────────────────

test('判据① 两处插入点都在源码里（runtime.runTool 的注入分支 + toolbox 的 search_rules 分派）', () => {
  const runtimeSrc = readFileSync(join(RAG_ROOT, 'src/coach/runtime.js'), 'utf8');
  const toolboxSrc = readFileSync(join(RAG_ROOT, 'src/coach/toolbox.js'), 'utf8');
  const runToolBody = runtimeSrc.match(/async function runTool\(name,args,context,message,retrieve\)\{([\s\S]*?)\n\}/);
  assert.ok(runToolBody, 'runtime.js 里找不到 runTool');
  log('[实际] runTool 分支 =', runToolBody[1].replace(/\s+/g, ' ').trim().slice(0, 220));
  assert.match(runToolBody[1], /ragAugmentSearchRules\(injected/, 'runtime 的注入 retrieve 分支必须接 RAG（否则生产路径等于没接）');
  assert.match(runToolBody[1], /ragMode\(\)/, 'runtime 必须按 ROCO_RAG_MODE 处理注入回来的回执');
  assert.match(toolboxSrc, /if\(name==='search_rules'\)return ragMode\(\)==='legacy'/, 'toolbox 的 search_rules 分派必须有 rag 路径');
  assert.match(toolboxSrc, /searchRulesWithRag\(args\.query/, 'toolbox 必须走 RAG 入口而不是只改注释');
  // 浏览器模块图里不许顶层 import rag-index（它静态 import node:fs）
  const topLevel = toolboxSrc.split('\n').filter((line) => /^import .*rag-index/.test(line));
  assert.deepEqual(topLevel, [], 'toolbox.js 顶层不许 import rag-index.js（浏览器模块图里没有 node:fs）');
  assert.match(toolboxSrc, /import\('\.\/rag-index\.js'\)/, '必须走调用时动态 import');
});

test('判据①补 真的跑一遍 runtime 的注入分支：回执里必须出现 rag 字段', async () => {
  withIndexSet(indexSet);
  try {
    const seen = [];
    const result = await gatherAgentEvidence({
      message: '查一下回合末自然回能的规则，再看看换宠的代价',
      context,
      plan: async (task) => (task.receipts.some((receipt) => receipt.tool === 'search_rules') ? {stop: true} : {tool: 'search_rules', args: {query: LEDGER_QUERY}}),
      retrieve: async (query) => {
        const receipt = searchKnowledge(query, {limit: 3, game: context.battle, rulesVersion: context.battle?.version || '0.6'});
        seen.push(receipt);
        return receipt;
      },
    });
    const receipt = result.trace.find((row) => row.tool === 'search_rules')?.result;
    assert.ok(receipt, `trace 里必须有 search_rules 回执（stopped=${result.stopped}）`);
    log('[实际] 注入路径回执 keys =', Object.keys(receipt).join(','), '；rag =', JSON.stringify(receipt.rag).slice(0, 160));
    assert.ok(receipt.rag, '注入的 retrieve 走 runTool 分支后必须被 RAG 处理过（这就是"第二处插入点"）');
    assert.equal(receipt.rag.mode, ragMode());
    assert.equal(seen.length, 1, '注入的 retrieve 必须真的被调用（不是被绕过）');
  } finally {
    configureRagRetrieval(null);
  }
});

test('判据② ROCO_RAG_MODE 默认 shadow（不认识的值也落回 shadow，不落 legacy）', () => {
  log('[实际] RAG_MODES =', RAG_MODES.join(','), '；空 env →', ragMode({}), '；未设 →', ragMode({OTHER: '1'}),
    '；写成 RAGGY →', ragMode({ROCO_RAG_MODE: 'RAGGY'}), '；当前进程 =', currentRagMode());
  assert.equal(ragMode({}), 'shadow');
  assert.equal(ragMode({ROCO_RAG_MODE: undefined}), 'shadow');
  for (const mode of RAG_MODES) assert.equal(ragMode({ROCO_RAG_MODE: mode.toUpperCase()}), mode);
  assert.equal(ragMode({ROCO_RAG_MODE: 'RAGGY'}), 'shadow', '取值不认识时不许静默当 legacy（那会让人以为 rag 在跑）');
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 判据③④：legacy 逐字节相同 / shadow 只多一个字段
// ─────────────────────────────────────────────────────────────────────────

test('判据③ legacy 模式：回执与接线前**逐字节相同**（接线前就是那一行 searchKnowledge）', async () => {
  configureRagRetrieval({lookup: async () => { throw new Error('legacy 模式不该去碰 RAG'); }});
  try {
    for (const query of [LEDGER_QUERY, '换宠 回合', '我的个体面板换算公式有吗']) {
      const legacy = await searchRulesWithRag(query, {game: context.battle, rulesVersion: '0.6', limit: 3, mode: 'legacy'});
      const before = searchKnowledge(query, {limit: 3, game: context.battle, rulesVersion: '0.6'});
      assert.equal(JSON.stringify(legacy), JSON.stringify(before), `legacy 回执必须与改前逐字节相同：${query}`);
      assert.equal(Object.hasOwn(legacy, 'rag'), false, 'legacy 不许加字段');
      // 同一个输入跑两次，也一样（可复跑）
      assert.equal(JSON.stringify(await searchRulesWithRag(query, {game: context.battle, rulesVersion: '0.6', limit: 3, mode: 'legacy'})), JSON.stringify(legacy));
    }
    log('[实际] 3 条固定输入：legacy 回执 === 改前那一行 searchKnowledge 的输出（逐字节），且没有 rag 字段');
  } finally {
    configureRagRetrieval(null);
  }
});

test('判据④ shadow 模式：只多一个字段 `rag`，正文/卡片集合/method/missing 一个字节都不变', async () => {
  withIndexSet(indexSet);
  try {
    for (const query of [LEDGER_QUERY, '换宠 回合', '我的个体面板换算公式有吗', '不存在的东西在语料里有吗']) {
      const legacy = await searchRulesWithRag(query, {game: context.battle, rulesVersion: '0.6', limit: 3, mode: 'legacy'});
      const shadow = await searchRulesWithRag(query, {game: context.battle, rulesVersion: '0.6', limit: 3, mode: 'shadow'});
      const {rag, ...rest} = shadow;
      assert.equal(Object.keys(shadow).length, Object.keys(legacy).length + 1, `shadow 只许多一个字段：${query}`);
      assert.equal(JSON.stringify(rest), JSON.stringify(legacy), `shadow 除 rag 外必须逐字节相同：${query}`);
      assert.deepEqual(shadow.cards, legacy.cards, 'shadow 不许动卡片集合');
      assert.equal(shadow.method, legacy.method);
      assert.equal(shadow.missing, legacy.missing);
      assert.equal(rag.mode, 'shadow');
      assert.equal(rag.retrievalPath, 'lexical');
      assert.ok(rag.would_be, 'shadow 的用处就是记下"如果走 RAG 会拿到什么"');
      log(`[实际] 「${query}」shadow 多出的字段 =`, JSON.stringify(rag).slice(0, 150));
    }
  } finally {
    configureRagRetrieval(null);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 判据⑤⑥：rag 命中带 lib_id / 兜底如实写 lexical-fallback
// ─────────────────────────────────────────────────────────────────────────

test('判据⑤ rag 分支命中：结果行里有 lib_id，且正文投影后回执不超预算', async () => {
  withIndexSet(indexSet);
  try {
    const receipt = await searchRulesWithRag(LEDGER_QUERY, {game: context.battle, rulesVersion: '0.6', limit: 3, mode: 'rag'});
    log('[实际] retrievalPath =', receipt.rag.retrievalPath, '；library =', JSON.stringify(receipt.rag.library),
      '；ids =', receipt.rag.results.map((row) => row.id).join(','));
    assert.equal(receipt.rag.retrievalPath, 'rag');
    assert.ok(receipt.rag.results.length > 0);
    for (const row of receipt.rag.results) {
      assert.ok(row.lib_id, `${row.id} 缺 lib_id`);
      assert.equal(row.scope, 'rule');
      assert.ok(row.snippet && row.snippet.length <= 161, '正文必须投影（截断）后才进回执');
    }
    assert.ok(receipt.rag.library.includes('L1'));
    assert.equal(receipt.method, 'rag-index：别名表 + 结构化过滤 + BM25 + 证据/版本 rerank');
    // runtime 的单条回执预算是 10000 字符：rag 行比卡片重，必须投影
    assert.ok(JSON.stringify(receipt).length < 10000, `回执 ${JSON.stringify(receipt).length} 字符，会被 runtime 直接丢弃`);
    log('[实际] 回执字节 =', JSON.stringify(receipt).length, '（runtime 上限 10000）');
  } finally {
    configureRagRetrieval(null);
  }
});

test('判据⑥ 兜底路径：空/弃答/低于门槛/索引不可用 四种情况都如实写 lexical-fallback + 原因', async () => {
  const cases = [
    ['RAG 弃答', {lookup: async () => ({ok: false, reason: 'NO_MATCH：语料里没有可支撑的候选', would_be: {path: 'rag', reason_code: 'NO_MATCH', top: null}})}],
    ['RAG 低于门槛', {lookup: async () => ({ok: false, reason: `最高相关度 0.900 低于门槛 ${SCORE_FLOOR}`, would_be: {path: 'rag', reason_code: null, top: 'pet::pet_000001'}})}],
    ['索引层不可用', {lookup: async () => { throw new Error('注入：rag-index 加载失败'); }}],
    ['玩家通道也没结果', {lookup: async () => ({ok: false, reason: '问句只落在玩家个体数据上，玩家通道也没有过门槛的结果：SCOPE_EXCLUDED', would_be: {path: 'rag-player', reason_code: 'SCOPE_EXCLUDED', top: null}})}],
  ];
  for (const [name, impl] of cases) {
    configureRagRetrieval(impl);
    try {
      const lexical = searchKnowledge(LEDGER_QUERY, {limit: 3, game: context.battle, rulesVersion: '0.6'});
      const receipt = await searchRulesWithRag(LEDGER_QUERY, {game: context.battle, rulesVersion: '0.6', limit: 3, mode: 'rag'});
      assert.equal(receipt.rag.retrievalPath, 'lexical-fallback', `${name}：必须写明走的是词法兜底`);
      assert.ok(receipt.rag.reason && receipt.rag.reason.length > 4, `${name}：兜底必须给原因`);
      assert.deepEqual(receipt.cards, lexical.cards, `${name}：兜底就是原来的词法结果，不许换一份`);
      log(`[实际] ${name} → retrievalPath=${receipt.rag.retrievalPath}；reason=${receipt.rag.reason}`);
    } finally {
      configureRagRetrieval(null);
    }
  }
  // 「实现整个缺失」这一档（浏览器里 rag-index 加载不了）走的是默认实现（真实索引），
  // 所以单独确认一次：默认实现必须能命中，而不是被上面注入的假实现带偏。
  const real = await searchRulesWithRag(LEDGER_QUERY, {game: context.battle, rulesVersion: '0.6', limit: 3, mode: 'rag'});
  log('[实际] 默认实现（无注入，动态 import rag-index + 真语料）→', real.rag.retrievalPath,
    real.rag.results.map((row) => `${row.id}@${row.lib_id}`).join(','));
  assert.equal(real.rag.retrievalPath, 'rag', '默认实现（动态 import rag-index + 真语料）必须能命中');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 判据⑦：人类原话那条反证 —— 删掉一条规则，答案必须变
// ─────────────────────────────────────────────────────────────────────────

test('判据⑦ 反证：删掉一条台账规则 ⇒ ① 检索里不再出现它 ② rag 分支的 top-k 变了', async () => {
  const VICTIM = 'EV-MARKS-PERSISTENCE';
  const query = heldout.queries.find((item) => item.expected === VICTIM)?.query ?? '印记在精灵下场之后会不会消失';
  const mutated = JSON.parse(JSON.stringify(corpus));
  mutated.ledger.entries = mutated.ledger.entries.filter((entry) => entry.id !== VICTIM);
  assert.equal(mutated.ledger.entries.length, corpus.ledger.entries.length - 1);
  const cut = createRagIndexSet(mutated);

  // ① 检索结果里不再出现它（语料变了，索引真的跟着变）
  const fullHits = searchIndex(indexSet.joint, query, {limit: 10}).results.map((row) => row.id);
  const cutHits = searchIndex(cut.joint, query, {limit: 10}).results.map((row) => row.id);
  assert.ok(fullHits.includes(VICTIM), `删之前 ${VICTIM} 必须能被检索到（否则这条反证没意义）`);
  assert.equal(cutHits.includes(VICTIM), false, `删掉之后 ${VICTIM} 不许再被检索到`);
  assert.equal(cut.joint.byId.has(VICTIM), false);

  // ② 产品路径（rag 分支）的 top-k 必须跟着变 —— 答案不变就说明索引是装饰品
  withIndexSet(indexSet);
  const before = await searchRulesWithRag(query, {game: context.battle, rulesVersion: '0.6', limit: 3, mode: 'rag'});
  withIndexSet(cut);
  const after = await searchRulesWithRag(query, {game: context.battle, rulesVersion: '0.6', limit: 3, mode: 'rag'});
  configureRagRetrieval(null);
  const ids = (receipt) => receipt.rag.results.map((row) => row.id);
  log('[实际] 「' + query + '」删条前 top-k =', ids(before).join(','), '→ 删条后 =', ids(after).join(','));
  assert.equal(ids(before).includes(VICTIM), true, '删条前 rag 分支的 top-k 里必须有它');
  assert.equal(ids(after).includes(VICTIM), false, '删条后 rag 分支的 top-k 里不许再有它');
  assert.notDeepEqual(ids(after), ids(before), '删掉一条规则之后 top-k 必须变（不变 = 模型在凭记忆答，索引是装饰品）');
  assert.equal(before.rag.retrievalPath, 'rag');
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 判据⑧：45 条 held-out 上 rag 分支不弱于词法
// ─────────────────────────────────────────────────────────────────────────

test('判据⑧ 45 条 held-out：rag 分支的 recall@3 ≥ 词法（legacy）分支', async () => {
  withIndexSet(indexSet);
  const idMatches = (id, key) => id === key || id.startsWith(`${key}#`) || key.startsWith(`${id}#`);
  const hits = (ids, keys) => ids.some((id) => keys.some((key) => idMatches(id, key)));
  let ragHit = 0;
  let lexicalHit = 0;
  const rows = [];
  for (const query of ANSWERABLE) {
    const keys = [query.expected, ...(query.acceptable_entity_keys ?? [])].filter((key) => key && key !== 'ABSTAIN');
    const rag = await searchRulesWithRag(query.query, {game: null, rulesVersion: '0.6', limit: 3, mode: 'rag'});
    const lexical = searchKnowledge(query.query, {limit: 3, rulesVersion: '0.6'});
    const ragIds = rag.rag.retrievalPath === 'lexical-fallback' ? rag.cards.map((card) => card.id) : rag.rag.results.map((row) => row.id);
    const lexicalIds = lexical.cards.map((card) => card.id);
    if (hits(ragIds, keys)) ragHit += 1;
    if (hits(lexicalIds, keys)) lexicalHit += 1;
    rows.push({id: query.id, rag: hits(ragIds, keys), lexical: hits(lexicalIds, keys)});
  }
  configureRagRetrieval(null);
  const n = ANSWERABLE.length;
  const rate = (value) => value / n;
  log('[实际] 有答案的 held-out =', n, '；rag 分支 recall@3 =', rate(ragHit).toFixed(4),
    '；词法（卡片 id 空间）recall@3 =', rate(lexicalHit).toFixed(4));
  log('[实际] rag 没命中的 =', rows.filter((row) => !row.rag).map((row) => row.id).join(',') || '（无）');
  assert.ok(rate(ragHit) >= rate(lexicalHit), `rag 分支 recall@3 ${rate(ragHit)} 低于词法 ${rate(lexicalHit)}`);
  assert.ok(ragHit > 0, 'rag 分支一条都没命中，这条对照没有意义');
});

// ─────────────────────────────────────────────────────────────────────────
// 6. 判据⑨：引用白名单在 rag 模式下对 rag 形状的 id 生效（编造的 id 会被抓）
// ─────────────────────────────────────────────────────────────────────────

test('判据⑨ 引用白名单：rag 模式下编造的 pet:: id 被抓；发过的 id 与默认模式不受影响', async () => {
  const {checkGroundedAnswer} = await import('../src/coach/runtime.js');
  const delivered = {id: 'EV-MARKS-PERSISTENCE'};
  const answer = (text) => ({text, toolTrace: [{tool: 'search_rules', result: {rag: {results: [delivered]}}}]});
  // 只看**引用**这一类理由：id 里的数字会被数字守卫单独抓（那是另一条判据，不混进来）。
  const citations = (verdict) => verdict.reasons.filter((reason) => reason.startsWith('unsupported-citation:'));
  // 默认（legacy / shadow）：一个字都不变 —— 老白名单（tactic|ui|rule:）看不见 rag 形状的 id
  assert.deepEqual(citations(checkGroundedAnswer(answer('见 pet::pet_999999'))), []);
  // rag 模式：编造的被抓
  const faked = checkGroundedAnswer(answer('见 pet::pet_999999 这条'), {ragCitations: true});
  assert.deepEqual(citations(faked), ['unsupported-citation:pet::pet_999999']);
  // rag 模式：回执里真的发出去过的 id 可以引
  assert.deepEqual(citations(checkGroundedAnswer(answer('见 EV-MARKS-PERSISTENCE 这条'), {ragCitations: true})), []);
  // 老的卡片引用规则不变
  assert.equal(checkGroundedAnswer({text: '看 tactic:invented', knowledge: []}).valid, false);
  log('[实际] 默认 → 编造 id 不被发现（与改前一致）；ragCitations:true → ', faked.reasons.join('|'));
});

test('判据⑨补 searchKnowledge 不认识的策略显式抛（strategy:"rag" 不许静默走 IDF）', () => {
  assert.throws(() => searchKnowledge('换宠', {strategy: 'rag'}), /未知检索策略/);
  assert.doesNotThrow(() => searchKnowledge('换宠', {strategy: 'lexical'}));
  assert.doesNotThrow(() => searchKnowledge('换宠', {strategy: 'semantic'}));
  assert.doesNotThrow(() => searchKnowledge('换宠', {strategy: 'fusion'}));
  log('[实际] strategy:"rag" → 抛；lexical / semantic / fusion → 正常');
});

test('接线不改变其它工具：executeTool 的 search_rules 之外仍是同步返回（legacy 契约）', async () => {
  const sync = executeTool('read_state', {}, context);
  assert.equal(typeof sync?.then, 'undefined', 'read_state 必须仍然是同步返回（executeTool 的既有契约）');
  const legacy = await executeTool('search_rules', {query: LEDGER_QUERY}, context);
  assert.ok(legacy.cards || legacy.rag, '默认（shadow）下 search_rules 仍然给得出回执');
  assert.ok(legacy.rag && legacy.rag.mode === 'shadow');
  log('[实际] read_state 同步；search_rules（默认 shadow）→ cards', legacy.cards.length, '+ rag', legacy.rag.mode);
});
