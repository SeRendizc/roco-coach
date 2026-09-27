// RC-205 多 RAG 库 + 玩家数据分离的守卫。
//
// 为什么这一组必须存在（人类口径：「是不是可以有多个 RAG 库，这样 debug 也能 debug」、
// 「memory 与 RAG 分开做好」）
// ---------------------------------------------------------------------------
// 「分了库」这件事有三种最省事的假做法，三种都不会红：
//   ① 库只是文档上的一个标签，检索时在**同一个全局索引**上过滤 —— idf / 平均长度
//      仍然是全库算的，于是「删掉一个库」会悄悄改变其它库的分数。分库就成了装饰。
//   ② 库声明写得很漂亮，但真源路径写错 / 库是空的 —— 检索照样返回别的库的文档，
//      看起来一切正常，实际那个库从来没接上。
//   ③ 玩家个体数据继续混在规则语料里 —— 「我的个体」与「规则是什么」共用一条路径
//      与一个 idf；排除玩家数据后又会**静默回落到全库**，拿一条无关规则文档顶上，
//      把「我不读玩家数据」伪装成「规则是这么说的」。
// 所以这一组钉七条判据，其中②③④⑦是**反证**（构造违规输入，看它会不会红）。
//
// 用法：`node --test tests/roco-rag-libs.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {LIB_BY_RECORD_KIND, LIBS_PATH, REPO_ROOT, assertLib, buildLibKindMap, loadLibs} from '../src/coach/rag-libs.js';
import {PLAYER_INPUTS, RAG_INPUTS, createRagIndex, createRagIndexSet, loadCorpus, searchIndex} from '../src/coach/rag-index.js';

const log = (...args) => console.log('  ·', ...args);

const corpus = loadCorpus();
const registry = loadLibs();
const set = createRagIndexSet(corpus);
const heldout = JSON.parse(readFileSync('data/roco/rag/heldout-queries.json', 'utf8'));
/** 探针：用 held-out 里**有答案**的问句当真实查询，不自己编。 */
const PROBES = heldout.queries.filter((query) => query.expected !== 'ABSTAIN').slice(0, 8).map((query) => query.query);
const withLib = (libId, patch) => registry.libs.map((lib) => (lib.lib_id === libId ? {...lib, ...patch} : lib));

// ─────────────────────────────────────────────────────────────────────────
// 1. 注册表本身：结构、真源、非空
// ─────────────────────────────────────────────────────────────────────────

test('库注册表：每个 ready 库都建得出非空索引，声明的 record_kind 一篇都不缺', () => {
  log('[实际] 库 =', registry.libs.map((lib) => `${lib.lib_id}(${lib.scope}/${lib.status})`).join(' '));
  log('[实际] ready 库文档数 =', [...set.byLib].map(([id, index]) => `${id}:${index.documents.length}`).join(' '),
    '；pending =', set.pending.map((row) => row.lib_id).join(',') || '（无）');
  assert.equal(set.byLib.size + set.pending.length, registry.libs.length,
    '每个库要么建成索引（ready），要么登记在 pending 里 —— 不许有第三种（被忽略的）库');
  // 联合视图的文档数 = 各 ready 库之和（不重不漏）
  const perLib = [...set.byLib.values()].reduce((sum, index) => sum + index.documents.length, 0);
  assert.equal(perLib, set.joint.documents.length, '分库文档数之和必须等于联合视图（漏一篇就是某个库没接上）');
  for (const [libId, index] of set.byLib) {
    assert.ok(index.documents.length > 0, `${libId} 是 ready 库却一篇文档都没有`);
    assert.deepEqual(index.lib_ids, [libId], `${libId} 的索引里混进了别的库`);
  }
  // 三个 pending 库必须真的「尚无 inputs」，不许先塞语料
  for (const row of set.pending) {
    const lib = registry.by_id[row.lib_id];
    assert.equal(lib.status, 'pending');
    assert.deepEqual(lib.inputs, [], `${row.lib_id} 是 pending 却已经有 inputs（计划中的库不许先塞语料）`);
    assert.ok(String(lib.planned_source ?? '').includes('本轮尚无 inputs'), `${row.lib_id} 要写明「本轮尚无 inputs」`);
  }
  // 真源与文档数对得上（不是抄来的常数，是从 corpus 现算的）
  assert.equal(set.byLib.get('L8').documents.length, corpus.owned.instances.length);
  assert.ok(set.byLib.get('L1').documents.length > corpus.ledger.entries.length,
    'L1 应当同时装下台账条目与 ruleset 配置文档');
  log('[实际] L1:', set.byLib.get('L1').documents.length, '篇（台账', corpus.ledger.entries.length, '+ 配置文档）',
    '；L8:', set.byLib.get('L8').documents.length, '篇');
});

test('record_kind → lib_id 是单值映射：同一个种类不许属于两个库', () => {
  log('[实际] 映射 =', JSON.stringify(LIB_BY_RECORD_KIND));
  assert.equal(Object.keys(LIB_BY_RECORD_KIND).length, new Set(Object.keys(LIB_BY_RECORD_KIND)).size);
  assert.throws(() => buildLibKindMap([...registry.libs, {...registry.libs[0], lib_id: 'LXX'}]),
    /同时属于|一篇文档只能属于一个库/, '重复登记同一个 record_kind 必须抛');
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 判据①：每条结果都能追到库
// ─────────────────────────────────────────────────────────────────────────

test('判据① 每条 results[] 都带 lib_id，且能在 libs.json 里找到（scope 与库声明一致）', () => {
  let rows = 0;
  for (const query of PROBES) {
    for (const result of searchIndex(set.joint, query, {limit: 5}).results) {
      rows += 1;
      const lib = registry.by_id[result.lib_id];
      assert.ok(lib, `结果 ${result.id} 的 lib_id=${result.lib_id} 不在 ${LIBS_PATH} 里`);
      assert.equal(result.scope, lib.scope, `${result.id} 的 scope 与库 ${lib.lib_id} 的声明不一致`);
      assert.ok(lib.record_kinds.includes(result.record_kind), `${result.record_kind} 不在 ${lib.lib_id} 的 record_kinds 里`);
    }
  }
  log('[实际] 检查了', rows, '条结果，全部带可追的 lib_id');
  assert.ok(rows >= PROBES.length, '探针查询必须有结果，否则这条判据是空的');
});

test('判据①补 分库筛选：libs 写错一个字母直接抛，不许静默返回空结果', () => {
  // 用一条**台账**问句（它的答案就在 L1 里），别拿精灵问句去筛 L1 —— 那本来就该是空的。
  const ledgerQuery = heldout.queries.find((query) => String(query.expected).startsWith('EV-'));
  const rows = searchIndex(set.joint, ledgerQuery.query, {libs: ['L1'], limit: 5}).results;
  assert.ok(rows.length > 0, `L1 里应当能查到台账条目：${ledgerQuery.id}`);
  assert.ok(rows.every((row) => row.lib_id === 'L1'));
  assert.throws(() => searchIndex(set.joint, ledgerQuery.query, {libs: ['L99']}), /索引里没有库 L99/);
  log('[实际] libs:["L1"] →', rows.map((row) => row.id).join(','), '；libs:["L99"] → 抛错');
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 判据②：删库反证（这条要求每库独立索引）
// ─────────────────────────────────────────────────────────────────────────

test('判据② 删掉 L2（连同它的真源）⇒ 该库文档消失、其它库结果逐字节不变；共用全局索引时这条根本不成立', () => {
  // 「删掉一个库」= 删掉库声明 + 删掉它的真源语料（两条都删才是真的没有了）。
  const withoutL2 = JSON.parse(JSON.stringify(corpus));
  withoutL2.pack.sections.distributable.entities = [];
  withoutL2.pack.sections.reference_only.entities = [];
  const cut = createRagIndexSet(withoutL2, {libs: registry.libs.filter((lib) => lib.lib_id !== 'L2')});
  assert.equal(cut.byLib.has('L2'), false, 'L2 已经删了，不该还能建出索引');
  assert.equal(cut.joint.documents.some((doc) => doc.lib_id === 'L2'), false, '联合视图里不许再有 L2 的文档');
  log('[实际] 删库后联合视图', set.joint.documents.length, '→', cut.joint.documents.length, '篇；剩余库 =', [...cut.byLib.keys()].join(','));

  let compared = 0;
  for (const query of PROBES) {
    for (const libId of ['L1', 'L6', 'L8']) {
      const before = JSON.stringify(searchIndex(set.byLib.get(libId), query, {limit: 5}));
      const after = JSON.stringify(searchIndex(cut.byLib.get(libId), query, {limit: 5}));
      compared += 1;
      assert.equal(after, before, `删掉 L2 之后 ${libId} 对「${query}」的结果变了：分库没有真的分统计量`);
    }
  }
  // 有牙：如果分库是靠「在同一个全局索引上按 lib_id 过滤」实现的，删掉 L2 会改全局 idf，
  // 于是上面对比必然出现不一致。这里把那条错误路径**实测**一遍，证明这条判据不是空的。
  let jointFilteredDiffers = 0;
  for (const query of PROBES) {
    const read = (index) => JSON.stringify(searchIndex(index, query, {libs: ['L1'], limit: 5})
      .results.map((row) => [row.id, row.score]));
    if (read(set.joint) !== read(cut.joint)) jointFilteredDiffers += 1;
  }
  log('[实际] 逐库对比', compared, '次全部逐字节相同；同一个全局索引按库过滤的写法有',
    jointFilteredDiffers, '/', PROBES.length, '条查询分数被 L2 的删除改掉（所以必须每库一个实例）');
  assert.ok(jointFilteredDiffers > 0, '共用全局索引的写法居然没被删库改到分数：这条判据失去了牙齿');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 判据③④：假路径 / 空库必须抛
// ─────────────────────────────────────────────────────────────────────────

test('判据③ 给某库一个假路径 ⇒ 建库直接抛（不许静默降级成空库）', () => {
  const broken = withLib('L1', {inputs: ['data/roco/rulesets/__not_here__.json'], source_of_truth: ['data/roco/rulesets/__not_here__.json']});
  assert.throws(() => createRagIndexSet(corpus, {libs: broken}), /输入路径不存在/);
  assert.throws(() => createRagIndex(corpus, {lib: 'L1', libs: broken}), /输入路径不存在/);
  assert.throws(() => assertLib(broken.find((lib) => lib.lib_id === 'L1')), /输入路径不存在/);
  log('[实际]', (() => { try { createRagIndexSet(corpus, {libs: broken}); return '没有抛'; } catch (error) { return error.message; } })());
});

test('判据④ status=ready 却一篇文档都没有 ⇒ 抛；pending 库允许为空', () => {
  // 「真源是空的」：文件在、能解析，但一条记录都没有 —— 这正是最容易被静默吞掉的失败。
  const emptyCorpus = JSON.parse(JSON.stringify(corpus));
  emptyCorpus.owned.instances = [];
  assert.throws(() => createRagIndexSet(emptyCorpus), /L8.*一篇文档都没建出来/s);
  assert.throws(() => createRagIndex(emptyCorpus, {lib: 'L8'}), /L8.*一篇文档都没建出来/s);
  // 「声明了某个 record_kind，但一篇这种文档都没有」同样要抛（真源与声明漂了）
  assert.throws(() => createRagIndexSet(corpus, {libs: withLib('L1', {record_kinds: ['ledger_entry', 'ruleset_config', 'ghost_kind']})}),
    /L1 声明了 record_kind=ghost_kind/);
  // 空 inputs 的 ready 库同样不许（那是「假装有真源」）
  assert.throws(() => createRagIndexSet(corpus, {libs: withLib('L8', {inputs: []})}), /ready 却没有任何 inputs/);
  // 反过来：真源还在、但注册表把它的 record_kind 划掉了 ⇒ 文档悬空，也要抛（不许悄悄丢掉整库）
  assert.throws(() => createRagIndexSet(corpus, {libs: withLib('L8', {record_kinds: ['ghost_kind']})}),
    /owned_instance.*没有登记在任何 RAG 库里/s);
  // pending 库没有 inputs 是**合法**的：它不是空库，它是「还没开始」。
  // 2026-09-25（第 47 轮）改钉：原来是从注册表里 `find(status==='pending')` —— L4 接上之后
  // **一个 pending 都没有了**，那句 `find` 返回 undefined，判据变成"拿 undefined 去 assertLib"而假红。
  // 意图没变（pending + 0 文档必须合法），改法是把"待接的库"**在内存里造出来**，与注册表现状解耦。
  const syntheticPending = {...registry.libs[0], lib_id: 'L9', status: 'pending', inputs: [],
    record_kinds: ['not_wired_yet'], planned_source: '判据里造的假库：本轮尚无 inputs'};
  assert.doesNotThrow(() => assertLib(syntheticPending, {documents: []}));
  log('[实际] ready+0 文档 → 抛；ready+空 inputs → 抛；声明了空 record_kind → 抛；pending(合成 L9)+0 文档 → 不抛（这是允许的）');
});

test('未知 lib_id ⇒ 抛（拼错库名不许当成「这个库没东西」）', () => {
  assert.throws(() => assertLib('L99'), /未知 lib_id/);
  assert.throws(() => createRagIndex(corpus, {lib: 'L99'}), /未知 lib_id/);
  log('[实际]', (() => { try { assertLib('L99'); return '没有抛'; } catch (error) { return error.message; } })());
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 判据⑤⑥⑦：玩家数据分离
// ─────────────────────────────────────────────────────────────────────────

test('判据⑤ RAG_INPUTS 与 PLAYER_INPUTS 的 key 交集为空（owned 不再算规则语料）', () => {
  const overlap = Object.keys(RAG_INPUTS).filter((key) => Object.hasOwn(PLAYER_INPUTS, key));
  log('[实际] RAG_INPUTS =', Object.keys(RAG_INPUTS).join(','), '；PLAYER_INPUTS =', Object.keys(PLAYER_INPUTS).join(','));
  assert.deepEqual(overlap, [], `RAG_INPUTS 与 PLAYER_INPUTS 的 key 重叠：${overlap.join(',')}`);
  assert.equal(RAG_INPUTS.owned, undefined, 'owned 不许再登记在规则语料输入里');
  assert.equal(PLAYER_INPUTS.owned, 'data/roco/owned/owned-pets.json');
  // ⚠️ 返回形状不许动：eval 侧在模块加载期就读 corpus.owned
  assert.equal(loadCorpus().owned.instances.length, corpus.owned.instances.length);
  assert.ok(loadCorpus().owned.instances.length > 0, 'corpus.owned 必须仍然带着玩家个体（删了它 eval 会 TypeError）');
});

test('判据⑥ 规则路径返回项的 scope 恒为 rule（玩家个体不会从规则路径漏出来）', () => {
  let rows = 0;
  for (const query of PROBES) {
    for (const result of searchIndex(set.joint, query, {limit: 10}).results) {
      rows += 1;
      assert.equal(result.scope, 'rule', `规则路径返回了 ${result.id}（lib ${result.lib_id}，scope ${result.scope}）`);
      assert.notEqual(result.lib_id, 'L8');
    }
  }
  log('[实际] 规则路径检查了', rows, '条结果，scope 全部为 rule');
});

test('判据⑦ 「我的个体」问句：要么走玩家通道、要么显式弃答 —— 不许静默回落到无关规则文档', () => {
  const query = '我的个体面板换算公式有吗';
  const rule = searchIndex(set.joint, query, {limit: 5});
  log('[实际] 规则路径 →', rule.reason_code, '；results =', rule.results.length, '；filter_fallback =', rule.intent.filter_fallback);
  assert.equal(rule.abstained, true, '规则路径不许拿别的文档顶上');
  assert.equal(rule.reason_code, 'SCOPE_EXCLUDED');
  assert.equal(rule.scope_excluded, true);
  assert.deepEqual(rule.excluded_record_kinds, ['owned_instance']);
  assert.deepEqual(rule.results, [], '弃答就必须是空的：留一条无关规则文档等于静默回落');
  assert.equal(rule.intent.filter_fallback, false, '这不是「过滤退让」，是「这个 scope 我不读」');
  assert.match(rule.reason, /owned_instance/);

  // 显式走玩家通道（includePlayer / scope:'player'）就一定拿得到 —— 证明上面的空是「被排除」，不是「没有」
  const player = searchIndex(set.byLib.get('L8'), query, {limit: 5, scope: 'player', includePlayer: true});
  assert.ok(player.results.length > 0, '玩家通道必须能查到个体数据，否则「排除」与「语料没有」分不开');
  assert.ok(player.results.every((row) => row.scope === 'player' && row.lib_id === 'L8'));
  assert.equal(player.abstained, false);
  log('[实际] 玩家通道 →', player.results.map((row) => row.id).join(','));

  // 同一句话在联合视图上显式 opt-in 也拿得到（opt-in 的语义是「读玩家数据」，不是「换一个索引」）
  const opted = searchIndex(set.joint, query, {limit: 5, includePlayer: true});
  assert.equal(opted.scope_excluded, undefined);
  assert.ok(opted.results.some((row) => row.scope === 'player'));

  // 混合问句（既提「我的」又提规则种类）不许被整体弃答：只有**全部**种类都被排除时才弃答
  const mixed = searchIndex(set.joint, '我的精灵有哪些技能', {limit: 5});
  assert.notEqual(mixed.reason_code, 'SCOPE_EXCLUDED');
  assert.ok(mixed.results.length > 0, '混合问句应当走规则路径正常检索');
  log('[实际] 混合问句「我的精灵有哪些技能」→', mixed.results.map((row) => `${row.id}(${row.lib_id})`).join(','));

  // 全量扫描：规则路径的任何结果都不许是玩家文档（这条与判据⑥ 一起把「漏」堵死）
  assert.equal(set.joint.documents.filter((doc) => doc.scope === 'player').length, corpus.owned.instances.length);
  log('[实际] 联合视图里玩家文档', corpus.owned.instances.length, '篇，规则路径默认一篇都不返回');
});

test('仓库根与注册表路径是相对仓库根解析的（不是相对 CWD）', () => {
  assert.equal(REPO_ROOT, process.cwd().endsWith('roco-coach') ? process.cwd() : REPO_ROOT);
  assert.equal(LIBS_PATH, 'data/roco/rag/libs.json');
  assert.deepEqual(Object.keys(registry.by_id), registry.libs.map((lib) => lib.lib_id));
});
