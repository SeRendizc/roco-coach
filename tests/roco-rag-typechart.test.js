// L3 属性相性库的守卫（本轮新增语料：`data/roco/normalized/roco-world-s4-2026-09-10/types.json`）。
//
// 为什么这一组必须存在
// --------------------
// 「把一张属性相性表接进 RAG」有四种最省事的假做法，四种都不会红：
//   ① 表接上了，但正文里没有「克制 / 抵抗」这两个字 —— 词法检索命中不到它。
//      探针 P10「冰系被哪些属性克制」当年失败就是这个原因；而只数「文档条数 > 0」的
//      判据照样全绿；
//   ② 判据从**产物**里读倍率（`doc.body` 说自己是多少就是多少）—— 产物写错了也全绿；
//      所以这里的每一条都**自己读 types.json 复算**，不信产物；
//   ③ 把本仓自研 pet-coach 引擎的 `src/game/engine.js` 的 `TYPE_ADVANTAGES`
//      （7 个属性、倍率 1.5 / 0.75，仓内审计已判 RETIRE）混进来当真源 ——
//      两套引擎的属性名与倍率档位都不一样，混起来会同时污染两边；
//   ④ **双属性照抄快照的封顶值（双弱 ×3）** —— 这是本仓 2026-09-25 之前的旧口径；
//      那一天人类裁决改用社区源的**相乘**口径（快照 3× vs 两个社区源 4×，差 41 格），
//      所以「双属性 = 两系相乘」现在是**要钉住的正向期望**，而 ×3 成了要挡住的那一档。
//      判据必须两边都咬：41 格逐格对账 + 反证（改回封顶 ⇒ 必红）。
//
// 所以这一组钉四条判据 + 两条反证（删条 / 档位与引擎无交集），另加一条「改钉不删」：
// 探针 P10 的旧期望原话必须还在，而新期望必须**实测**成立。
//
// 用法：`node --test tests/roco-rag-typechart.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {LIBS_PATH, loadLibs} from '../src/coach/rag-libs.js';
import {
  REPO_ROOT,
  createRagIndex,
  createRagIndexSet,
  groundDocument,
  loadCorpus,
  resolvePointer,
  searchIndex,
} from '../src/coach/rag-index.js';
import {RULES, TYPES} from '../src/game/engine.js';

const log = (...args) => console.log('  ·', ...args);

/** 真源：上游 `Pets/data/Types.lua` 的逐字段机械转录（本文件**自己读**它复算，不读产物）。 */
const TYPES_PATH = 'data/roco/normalized/roco-world-s4-2026-09-10/types.json';
const truth = JSON.parse(readFileSync(join(REPO_ROOT, TYPES_PATH), 'utf8'));
const TRUTH_KEYS = Object.keys(truth.types);
const SINGLE_KEYS = TRUTH_KEYS.filter((key) => !key.includes('|'));
const DUAL_KEYS = TRUTH_KEYS.filter((key) => key.includes('|'));

/** 单属性行 → `Map(攻击属性 → 倍率)`。双属性条目的期望值只能由它算出来。 */
const singleTable = (key) => {
  const table = new Map();
  for (const item of truth.types[key]?.weak ?? []) table.set(item.type, item.multiplier);
  for (const item of truth.types[key]?.resist ?? []) if (!table.has(item.type)) table.set(item.type, item.multiplier);
  return table;
};
const SINGLE_TABLES = new Map(SINGLE_KEYS.map((key) => [key, singleTable(key)]));

/**
 * 语料正文**应当**写出的 weak / resist —— 本文件独立复算，不读产物。
 *
 * 2026-09-25 人类裁决：「属性双属性叠加：快照 3×（现用）vs 两个社区源 4×，差 41 格。
 * **使用社区源**」⇒ 双属性的值 = 两条单属性行相乘；乘积为 1 的项从 weak / resist 两侧都消失。
 * 单属性继续逐字照抄快照那一行（18/18，一个字都没动）。
 */
function expectedRows(key) {
  const parts = String(key).split('|');
  if (parts.length !== 2) {
    return {weak: truth.types[key].weak ?? [], resist: truth.types[key].resist ?? []};
  }
  const candidates = [];
  const push = (item) => {
    if (item?.type && !candidates.some((row) => row.type === item.type)) candidates.push({type: item.type});
  };
  for (const item of truth.types[key].weak ?? []) push(item);
  for (const item of truth.types[key].resist ?? []) push(item);
  for (const part of parts) for (const attack of SINGLE_TABLES.get(part).keys()) push({type: attack});
  const valued = candidates.map(({type}) => ({
    type,
    multiplier: parts.reduce((product, part) => product * (SINGLE_TABLES.get(part).get(type) ?? 1), 1),
  }));
  return {weak: valued.filter((row) => row.multiplier > 1), resist: valued.filter((row) => row.multiplier < 1)};
}

/** 快照那一行的逐字倍率（未列出 = 中性 1.0）—— 用来做「与旧口径差在哪 41 格」的对账。 */
const snapshotMap = (key) => {
  const table = new Map();
  for (const item of truth.types[key].weak ?? []) table.set(item.type, item.multiplier);
  for (const item of truth.types[key].resist ?? []) if (!table.has(item.type)) table.set(item.type, item.multiplier);
  return table;
};

//: 与旧快照不同的 **41 格**：`键|攻击属性`。逐格手写在判据里（算出来的清单只能证明
//: 「代码与代码一致」，手写的清单才能证明「代码与裁决一致」）；全部是 3.0 → 4.0。
const FORTY_ONE_CELLS = [
  '光系|地系|草系', '光系|水系|草系', '冰系|地系|机械系', '冰系|地系|武系', '冰系|电系|地系',
  '冰系|草系|火系', '冰系|萌系|机械系', '地系|光系|草系', '地系|恶系|武系', '地系|水系|草系',
  '地系|翼系|冰系', '地系|草系|冰系', '幻系|光系|幽系', '幻系|幽系|幽系', '幽系|光系|幽系',
  '幽系|幻系|幽系', '幽系|恶系|光系', '幽系|毒系|恶系', '幽系|萌系|恶系', '恶系|冰系|武系',
  '恶系|地系|武系', '普通系|机械系|武系', '机械系|地系|武系', '机械系|地系|水系', '机械系|火系|水系',
  '机械系|草系|火系', '机械系|虫系|火系', '毒系|萌系|恶系', '水系|翼系|电系', '火系|冰系|地系',
  '火系|毒系|地系', '翼系|水系|电系', '草系|冰系|火系', '草系|地系|冰系', '草系|幻系|虫系',
  '草系|武系|翼系', '草系|萌系|毒系', '萌系|毒系|恶系', '虫系|草系|火系', '虫系|草系|翼系',
  '龙系|翼系|冰系',
];

const corpus = loadCorpus();
const index = createRagIndex(corpus);
const set = createRagIndexSet(corpus);
const l3Docs = index.documents.filter((doc) => doc.lib_id === 'L3');
const l3Index = set.byLib.get('L3');

// ── 正文解析（判据只认**正文里逐字写着**的东西） ──────────────────────────

/** 紧凑行：`克制（weak） 火系 ×2 地系 ×2` → [{type:'火系',multiplier:2}, …]。 */
function compactRow(body, label) {
  const line = body.split('\n').map((row) => row.trim()).find((row) => row.startsWith(label));
  assert.ok(line, `正文里必须有一行以「${label}」开头（词法检索要命中它）`);
  const rest = line.slice(label.length).trim();
  if (!rest || rest === '无') return [];
  const rows = [...rest.matchAll(/([^\s×]+)\s+×([0-9.]+)/g)].map((match) => ({type: match[1], multiplier: Number(match[2])}));
  const leftover = rest.replace(/([^\s×]+)\s+×([0-9.]+)/g, '').trim();
  assert.equal(leftover, '', `「${label}」行里除了「X系 ×N」还有别的东西：${leftover}`);
  assert.ok(rows.length > 0, `「${label}」行里没有任何「X系 ×N」项：${rest}`);
  return rows;
}

/** 方向句：`火系克制冰系 ×2` / `冰系抵抗水系 ×0.5` → 带方向的四元组。 */
function sentenceRows(body) {
  const rows = [];
  for (const match of body.matchAll(/([^\s]+?)克制([^\s]+?) ×([0-9.]+)/g)) {
    rows.push({dir: 'weak', left: match[1], right: match[2], multiplier: Number(match[3])});
  }
  for (const match of body.matchAll(/([^\s]+?)抵抗([^\s]+?) ×([0-9.]+)/g)) {
    rows.push({dir: 'resist', left: match[1], right: match[2], multiplier: Number(match[3])});
  }
  return rows;
}

/** 倍率复算：把正文里的方向句与**裁决口径**（单属性逐字 / 双属性相乘）逐条对，返回问题清单。 */
function verifySentenceRows(body, key) {
  const problems = [];
  const rows = expectedRows(key);
  const expected = [
    ...rows.weak.map((item) => ({dir: 'weak', left: item.type, right: key, multiplier: item.multiplier})),
    ...rows.resist.map((item) => ({dir: 'resist', left: key, right: item.type, multiplier: item.multiplier})),
  ];
  const actual = sentenceRows(body);
  const tagged = (row) => `${row.dir}:${row.left}:${row.right}:${row.multiplier}`;
  const actualSet = new Set(actual.map(tagged));
  for (const row of expected) {
    if (!actualSet.has(tagged(row))) problems.push(`正文缺 ${tagged(row)}`);
  }
  for (const row of actual) {
    if (!expected.some((item) => tagged(item) === tagged(row))) problems.push(`正文多/错 ${tagged(row)}`);
  }
  return problems;
}

/**
 * 逐格对账：把**语料正文**里那 102 条双属性文档的倍率与旧快照逐格比，返回差异格。
 *
 * `valueOf` 是「这一格写的是什么」。真语料传正文解析出来的值；反证传快照那一行的值
 * （= 旧口径），于是同一个函数必须从「41」变成「0」—— 那正是判据④会红的样子。
 */
function diffCellsAgainstSnapshot(valueOf) {
  const out = [];
  for (const key of DUAL_KEYS) {
    const snapshot = snapshotMap(key);
    for (const attack of SINGLE_KEYS) {
      const written = valueOf(key, attack);
      const snap = snapshot.get(attack) ?? 1.0;
      if (Math.abs(written - snap) > 1e-9) out.push(`${key}|${attack}`);
    }
  }
  return out.sort();
}

/** 真语料：正文里这一格写了多少（读产物，只用于**对账**；期望值另由 expectedRows 复算）。 */
function bodyMultiplier(key, attack) {
  const body = index.byId.get(`type_chart::${key}`).body;
  const row = [...compactRow(body, '克制（weak）'), ...compactRow(body, '抵抗（resist）')]
    .find((item) => item.type === attack);
  return row ? row.multiplier : 1.0;
}

const tiersOf = (multipliers) => [...new Set(multipliers)].sort((a, b) => a - b);

// ─────────────────────────────────────────────────────────────────────────
// 0. 注册表：L3 从 pending 转 ready（真源、record_kind、scope、RETIRE 钉）
// ─────────────────────────────────────────────────────────────────────────

test('注册表：L3 是 ready，inputs 就是那份转录；record_kinds / scope 不变；RETIRE 那句仍钉着', () => {
  const libs = loadLibs();
  const l3 = libs.by_id.L3;
  log('[实际] L3 =', JSON.stringify({status: l3.status, scope: l3.scope, inputs: l3.inputs, record_kinds: l3.record_kinds}));
  assert.equal(l3.status, 'ready');
  assert.equal(l3.scope, 'rule');
  assert.deepEqual(l3.record_kinds, ['type_chart']);
  assert.deepEqual(l3.inputs, [TYPES_PATH]);
  assert.deepEqual(l3.source_of_truth, [TYPES_PATH]);
  // 改钉不删：自研引擎那张表 RETIRE 的判断必须仍然写在库里（它正是「不许混」的钉子）。
  assert.match(l3.planned_source, /TYPE_ADVANTAGES/);
  assert.match(l3.planned_source, /已判 RETIRE/);
  assert.match(l3.planned_source, /不得用作真源/);
  // 反证③ 的一半：**inputs 里**不许出现自研引擎（真源只能有一个）。
  for (const field of ['inputs', 'source_of_truth']) {
    assert.equal(l3[field].some((path) => /src\/game\/engine\.js/.test(path)), false, `${field} 里混进了自研引擎`);
  }
  // 分库：L3 建得出索引，且不再挂在 pending 上。
  log('[实际] ready 库文档数 =', [...set.byLib].map(([id, entry]) => `${id}:${entry.documents.length}`).join(' '),
    '；pending =', set.pending.map((row) => row.lib_id).join(',') || '（无）');
  assert.equal(l3Index.documents.length, truth.counts.total);
  assert.equal(l3Index.documents.length, TRUTH_KEYS.length);
  assert.deepEqual(l3Index.lib_ids, ['L3']);
  assert.equal(set.pending.some((row) => row.lib_id === 'L3'), false, 'L3 已经 ready，不该还在 pending 里');
  // 联合视图不重不漏（分库之和 = 联合视图）。
  const perLib = [...set.byLib.values()].reduce((sum, entry) => sum + entry.documents.length, 0);
  assert.equal(perLib, set.joint.documents.length);
  assert.equal(l3Docs.length, 120);
});

// ─────────────────────────────────────────────────────────────────────────
// 1. 文档形状：每一条都能追回 types.json 的那个键（grounded 是 1.0 的前提）
// ─────────────────────────────────────────────────────────────────────────

test('文档形状：id/record_kind/lib_id/scope/provenance 指针逐条可解，且**追加在既有文档之后**', () => {
  for (const key of TRUTH_KEYS) {
    const doc = index.byId.get(`type_chart::${key}`);
    assert.ok(doc, `缺文档 type_chart::${key}`);
    assert.equal(doc.record_kind, 'type_chart');
    assert.equal(doc.lib_id, 'L3');
    assert.equal(doc.scope, 'rule');
    assert.equal(doc.name, key);
    assert.equal(doc.provenance.length, 1);
    assert.equal(doc.provenance[0].artifact_path, TYPES_PATH);
    assert.equal(doc.provenance[0].pointer, `types.${key}`);
    assert.equal(resolvePointer(truth, doc.provenance[0].pointer).found, true, `指针解析不到：types.${key}`);
    const grounded = groundDocument(doc);
    assert.equal(grounded.grounded, true, `${doc.id} 追不回磁盘：${grounded.problems.join('；')}`);
  }
  // 顺序：**每个库是连续一段，且新语料只许追加在末尾**。旧文档的相对顺序是报告逐字节一致性的一部分，
  // 所以新语料不许插进既有文档之间（rag-index.js 的注释里也写了这一条）。
  //
  // 2026-09-25（第 46 轮）改钉：这条原来写的是「L3 必须是末尾连续一段」—— 那是当时的事实快照。
  // 这一轮 L5 术语库上线、按纪律**追加在 L3 之后**，于是"末尾那一段"换人了。
  // 判据的**意图没变**（不许插队、每库连续），所以改成按这个意图写：逐库连续 + 顺序 = 注册表顺序。
  const blocks = [];
  for (const doc of index.documents) {
    if (!blocks.length || blocks.at(-1).lib_id !== doc.lib_id) blocks.push({lib_id: doc.lib_id, n: 0});
    blocks.at(-1).n += 1;
  }
  // 实际块序（2026-09-25 实测）：L2 图鉴 → L1 台账 → L6 冲突/政策 → **L1 ruleset 配置**
  // → L8 玩家个体 → L3 相性表 → **L5 术语表（本轮追加）**。L1 出现两次是**既有设计**
  // （台账条目与 ruleset 配置在两处产出），不是插队；这条判据钉的是"块序稳定 + 新语料在末尾"。
  assert.deepEqual(blocks.map((b) => b.lib_id), ['L2', 'L1', 'L6', 'L1', 'L8', 'L3', 'L5', 'L4'],
    `库的块序必须稳定（实际 ${blocks.map((b) => b.lib_id).join('→')}）`);
  const firstL3 = index.documents.findIndex((doc) => doc.lib_id === 'L3');
  assert.ok(firstL3 > 0, 'L3 前面必须有既有文档（否则「追加」这件事无从谈起）');
  assert.equal(index.documents.slice(firstL3, firstL3 + l3Docs.length).every((doc) => doc.lib_id === 'L3'), true,
    'L3 必须是连续一段');
  const lastOwned = corpus.owned.instances.at(-1).instance_id;
  assert.equal(index.documents[firstL3 - 1].id, `owned::${lastOwned}`,
    'L3 前面那一条必须仍是最后一条玩家个体（追加位置固定）');
  const ids = index.documents.map((doc) => doc.id);
  assert.equal(new Set(ids).size, ids.length, '文档 id 不许重复');
  log('[实际] 联合视图', index.documents.length, '篇；L3 从第', firstL3 + 1, '篇起连续', l3Docs.length, '篇（末尾追加）');
});

// ─────────────────────────────────────────────────────────────────────────
// 2. 判据① 正向：问得出来，而且倍率能从 types.json 逐字复算
// ─────────────────────────────────────────────────────────────────────────

test('判据① 正向：「冰系被什么克制」top-1 是 type_chart::冰系，正文倍率与真源逐字相同', () => {
  const result = searchIndex(index, '冰系被什么克制', {limit: 5});
  log('[实际] top3 =', result.results.slice(0, 3).map((row) => `${row.id}(${row.lib_id})@${row.score}`).join(' '));
  assert.equal(result.abstained, false, `这条问句必须答得出来：${result.reason}`);
  assert.equal(result.results[0].id, 'type_chart::冰系');
  assert.equal(result.results[0].lib_id, 'L3');
  const body = index.byId.get('type_chart::冰系').body;
  // 「克制 / 抵抗」必须逐字在正文里 —— 这是 P10 当年失败的根因（terms.json 不定义这两个词）。
  assert.ok(body.includes('克制'), '正文必须逐字写出「克制」');
  assert.ok(body.includes('抵抗'), '正文必须逐字写出「抵抗」');
  // 紧凑行与真源逐条相同（顺序 + 倍率），方向句也一样 —— 两处都复算，不信产物。
  assert.deepEqual(compactRow(body, '克制（weak）'), truth.types['冰系'].weak);
  assert.deepEqual(compactRow(body, '抵抗（resist）'), truth.types['冰系'].resist);
  assert.deepEqual(verifySentenceRows(body, '冰系'), []);
  // 判据的牙：把倍率改掉一个数字，同一个复算必须报问题（否则上面那两行是空的）。
  const tampered = body.replace('火系克制冰系 ×2', '火系克制冰系 ×4');
  assert.notDeepEqual(verifySentenceRows(tampered, '冰系'), []);
  assert.notDeepEqual(compactRow(tampered.replace('火系 ×2', '火系 ×4'), '克制（weak）'), truth.types['冰系'].weak);
  log('[实际] 冰系 weak =', JSON.stringify(truth.types['冰系'].weak.map((item) => `${item.type}×${item.multiplier}`).join(' ')),
    '；篡改倍率后复算报问题 =', verifySentenceRows(tampered, '冰系').length, '条');
});

test('判据① 补 进攻向问句（「火系克什么」）：top-k 里有 L3 条目，且「火系克制X系 ×N」能复算', () => {
  const result = searchIndex(index, '火系克什么', {limit: 10});
  const hits = result.results.filter((row) => row.lib_id === 'L3');
  log('[实际] top-1 =', result.results[0].id, '；top-10 里 L3 =', hits.length, '条');
  assert.ok(hits.length > 0, '进攻向问句必须能在 top-k 里拿到 L3 条目');
  // 进攻向的答案住在**别条文档**的正文里（`火系克制冰系` 写在「冰系」那一条上），
  // 所以这里按「正文里的方向句」复算，而不是按 top-1 的别名。
  const rows = [];
  for (const hit of hits) {
    for (const row of sentenceRows(index.byId.get(hit.id).body)) {
      if (row.dir === 'weak' && row.left === '火系') rows.push({...row, doc: hit.id});
    }
  }
  assert.ok(rows.length > 0, 'top-10 里必须至少有一条正文写着「火系克制X系」的文档（否则进攻向问句答不了）');
  for (const row of rows) {
    const defender = truth.types[row.right];
    assert.ok(defender, `正文提到了真源里没有的防御方：${row.right}`);
    // 期望值走**裁决口径**（单属性逐字 / 双属性两系相乘），不直接读快照那一行：
    // 双属性在 41 格上与快照不同，读快照会把「照抄旧口径」当成正确。
    const item = expectedRows(row.right).weak.find((entry) => entry.type === '火系');
    assert.ok(item, `${row.right} 在裁决口径下并不被火系克制，正文却这么写（${row.doc}）`);
    assert.equal(row.multiplier, item.multiplier, `${row.doc} 的 ${row.right} 倍率与裁决口径不一致`);
  }
  // 如实登记现状：top-1 是**同名防御向**文档（它写的是「什么克制火系」），
  // 所以这条路给出的是「火系被谁克制」。这条不设断言 —— 一旦将来补了 18 条
  // 「攻击方向」文档，top-1 会变，判据不该因此翻红；但它必须被打印出来给人看。
  log('[实际] 注意：进攻向问句的 top-1 =', result.results[0].id,
    '（同名文档的防御向正文）；可复算的「火系克制X系」行来自', [...new Set(rows.map((row) => row.doc))].join(','));
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 判据② 反证：删掉真源里的一条 ⇒ 同一个问题必须查不到它
// ─────────────────────────────────────────────────────────────────────────

test('反证② 删条：把「冰系」从真源内存副本里删掉 ⇒ 同一问题查不到 type_chart::冰系', () => {
  const query = '冰系被什么克制';
  const before = searchIndex(index, query, {limit: 10});
  assert.ok(before.results.some((row) => row.id === 'type_chart::冰系'), '删掉之前必须查得到（否则这条反证没有牙）');
  const cut = JSON.parse(JSON.stringify(corpus));
  delete cut.typeChart.types['冰系'];
  const cutIndex = createRagIndex(cut);
  const after = searchIndex(cutIndex, query, {limit: 10});
  log('[实际] 删前 top3 =', before.results.slice(0, 3).map((row) => row.id).join(','),
    '；删后 top3 =', after.results.slice(0, 3).map((row) => row.id).join(','));
  assert.equal(cutIndex.byId.has('type_chart::冰系'), false, '删条之后索引里不许还有它');
  assert.equal(cutIndex.documents.filter((doc) => doc.lib_id === 'L3').length, 119);
  assert.equal(after.results.some((row) => row.id === 'type_chart::冰系'), false, '删条之后不许再检索到它');
  // 同时确认这不是「整个库都空了」造成的假绿：含「冰系」的双属性文档还在，还能答。
  assert.ok(after.results.some((row) => row.id.startsWith('type_chart::')), '删一条不该把整库打空');
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 判据③ 反向：档位与自研引擎无交集（不许把两个引擎混起来）
// ─────────────────────────────────────────────────────────────────────────

test('判据③ 档位：快照是 {0.25, 0.5, 2, 3}，而**语料按裁决是 {0.25, 0.5, 2, 4}**；两者与自研引擎的 1.5 / 0.75 都无交集', () => {
  const fromTruth = tiersOf(TRUTH_KEYS.flatMap((key) => ['weak', 'resist']
    .flatMap((dir) => truth.types[key][dir].map((item) => item.multiplier))));
  const fromDocs = tiersOf(l3Docs.flatMap((doc) => ['克制（weak）', '抵抗（resist）']
    .flatMap((label) => compactRow(doc.body, label).map((item) => item.multiplier))));
  log('[实际] types.json（快照）的档位 =', JSON.stringify(fromTruth),
    '；L3 文档正文（= 裁决口径）的档位 =', JSON.stringify(fromDocs));
  assert.deepEqual(fromTruth, [0.25, 0.5, 2, 3], '快照里有 ×3：它正是那 41 格的封顶值');
  // **2026-09-25 人类裁决**：双属性按两系相乘 ⇒ 语料里出现 ×4，**不**出现封顶的 ×3。
  // （改钉不删：本条旧断言原话是 `assert.deepEqual(fromDocs, fromTruth);`，
  //   并另有 `for (const tier of [1.5, 0.75, 4])` 要求 ×4 不出现 —— 那两条已被裁决取代。）
  assert.deepEqual(fromDocs, [0.25, 0.5, 2, 4]);
  assert.equal(fromTruth.includes(4), false, '快照里本来就没有 ×4（相乘的那一档只存在于裁决口径）');
  assert.equal(fromDocs.includes(3), false, 'L3 正文里不该再出现封顶的 ×3（那是被裁决取代的旧口径）');
  const engineTiers = tiersOf([RULES.typeAdvantage, RULES.typeResist]);
  assert.deepEqual(engineTiers, [0.75, 1.5]);
  for (const tier of [1.5, 0.75]) {
    assert.equal(fromTruth.includes(tier), false, `相性表里不该出现 ${tier}（那是另一套口径）`);
    assert.equal(fromDocs.includes(tier), false, `L3 正文里不该出现 ${tier}（那是另一套口径）`);
  }
  assert.deepEqual(fromTruth.filter((tier) => engineTiers.includes(tier)), [], '两张表的档位不许有交集');
  assert.deepEqual(fromDocs.filter((tier) => engineTiers.includes(tier)), [], 'L3 正文的档位与自研引擎也不许有交集');
  // 结构上的第二重反证：自研引擎的属性数与手游的 18 属性对不上，它不可能是这张表的真源。
  assert.ok(Object.keys(TYPES).length < SINGLE_KEYS.length,
    `自研引擎 ${Object.keys(TYPES).length} 个属性 vs 手游 ${SINGLE_KEYS.length} 个 —— 引擎那张表更小，两者不是同一张`);
  assert.equal(TRUTH_KEYS.length, 120);
  assert.equal(SINGLE_KEYS.length, 18);
  assert.equal(DUAL_KEYS.length, 102);
});

// ─────────────────────────────────────────────────────────────────────────
// 4b. 判据①-补 单属性：18/18 与改前（快照那 18 行）逐字相同 —— 裁决没动单属性
// ─────────────────────────────────────────────────────────────────────────

test('判据①-补 单属性 18/18：正文与快照那一行逐字相同（裁决**没有**动单属性）', () => {
  let cells = 0;
  for (const key of SINGLE_KEYS) {
    const body = index.byId.get(`type_chart::${key}`).body;
    assert.deepEqual(compactRow(body, '克制（weak）'), truth.types[key].weak, `${key} 的 weak 被改动了`);
    assert.deepEqual(compactRow(body, '抵抗（resist）'), truth.types[key].resist, `${key} 的 resist 被改动了`);
    assert.deepEqual(verifySentenceRows(body, key), [], `${key} 的方向句被改动了`);
    cells += (truth.types[key].weak?.length ?? 0) + (truth.types[key].resist?.length ?? 0);
  }
  log('[实际] 单属性', SINGLE_KEYS.length, '条、共', cells, '格，逐格与快照相同');
  assert.equal(SINGLE_KEYS.length, 18);
  // 判据的牙：把单属性正文抠掉一个方向句，同一个复算必须报问题。
  const tampered = index.byId.get('type_chart::冰系').body.replace('火系克制冰系 ×2', '火系克制冰系 ×4');
  assert.notDeepEqual(verifySentenceRows(tampered, '冰系'), []);
});

// ─────────────────────────────────────────────────────────────────────────
// 4c. 判据②-补 双属性三条（人类点名的例子）+ 全量「等于两系相乘」
// ─────────────────────────────────────────────────────────────────────────

test('判据②-补 双属性 = 两系相乘：三条点名例子 + 102 条键全量复算 + 反写一致', () => {
  const cases = [
    ['冰系|地系', '火系', 1.0, '冰系抵抗火系 0.5 × 地系被火系克制 2'],
    ['火系|冰系', '地系', 4.0, '2 × 2'],
    ['虫系|草系', '火系', 4.0, '2 × 2'],
  ];
  for (const [key, attack, expected, why] of cases) {
    assert.equal(bodyMultiplier(key, attack), expected, `${key} 受 ${attack} 应为 ${expected}（${why}）`);
  }
  const mismatched = [];
  for (const key of TRUTH_KEYS) {
    const body = index.byId.get(`type_chart::${key}`).body;
    const expected = expectedRows(key);
    if (JSON.stringify(compactRow(body, '克制（weak）')) !== JSON.stringify(expected.weak)) mismatched.push(`${key}:weak`);
    if (JSON.stringify(compactRow(body, '抵抗（resist）')) !== JSON.stringify(expected.resist)) mismatched.push(`${key}:resist`);
  }
  log('[实际] 120 条键（18 单 + 102 双）逐条与裁决口径复算，不一致 =', mismatched.length, '条');
  assert.deepEqual(mismatched, []);
  for (const key of DUAL_KEYS) {
    const [a, b] = key.split('|');
    if (!truth.types[`${b}|${a}`]) continue;
    const body = index.byId.get(`type_chart::${key}`).body;
    const other = index.byId.get(`type_chart::${b}|${a}`).body;
    assert.deepEqual(compactRow(body, '克制（weak）'), compactRow(other, '克制（weak）'), `${key} 与反写不一致`);
    assert.deepEqual(compactRow(body, '抵抗（resist）'), compactRow(other, '抵抗（resist）'), `${key} 与反写不一致`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 5. 判据④ 双属性：**按两系相乘**，与旧快照恰好差 41 格（逐格列出）
// ─────────────────────────────────────────────────────────────────────────

test('判据④ 双属性按两系相乘：与旧快照恰好差 41 格（×3 → ×4），逐格对账', () => {
  // ① 全部 120 条键逐条复算（单属性逐字 + 双属性相乘），顺序与倍率都要对得上。
  for (const key of TRUTH_KEYS) {
    const body = index.byId.get(`type_chart::${key}`).body;
    const expected = expectedRows(key);
    assert.deepEqual(compactRow(body, '克制（weak）'), expected.weak, `${key} 的 weak 与裁决口径不一致`);
    assert.deepEqual(compactRow(body, '抵抗（resist）'), expected.resist, `${key} 的 resist 与裁决口径不一致`);
    assert.deepEqual(verifySentenceRows(body, key), [], `${key} 的方向句与裁决口径不一致`);
  }
  // ② 16 对「同一组合的两种写法」：内容逐字相同（键的写法不同，相性内容必须一样）。
  //    双向都查一遍（32 条键），但**对数**只数一次 —— 两个方向各有键，逐条数会得 32。
  const pairs = new Set();
  let mirroredRows = 0;
  for (const key of DUAL_KEYS) {
    const [a, b] = key.split('|');
    const reverse = `${b}|${a}`;
    if (!truth.types[reverse]) continue;
    mirroredRows += 1;
    pairs.add([a, b].sort().join('|'));
    const body = index.byId.get(`type_chart::${key}`).body;
    const other = index.byId.get(`type_chart::${reverse}`).body;
    assert.deepEqual(compactRow(body, '克制（weak）'), compactRow(other, '克制（weak）'));
    assert.deepEqual(compactRow(body, '抵抗（resist）'), compactRow(other, '抵抗（resist）'));
  }
  log('[实际] 互为反写的键 =', mirroredRows, '条 =', pairs.size, '对');
  assert.equal(mirroredRows, 32);
  assert.equal(pairs.size, 16, '同一组合的两种写法应当是 16 对');
  // ③ **41 格**：语料正文（= 相乘口径）与旧快照逐格对账，差异必须恰好是手写的那 41 格，
  //    且全部是「快照 3 → 裁决 4」。
  //    改钉不删：本条旧口径的原话是
  //      「41 格冲突维持快照口径（×3，不是相乘的 ×4）… 本仓**维持快照口径**：台账
  //        EV-TYPE-MULTIPLIER 已经表过态（可观察到 ×3 / ×2 / ×0.5 / ×0.25 四档，
  //        不再沿用「所有双弱 ×4」的旧说法）。要改成 4× 是改台账 + 改判据，不是改一句话」
  //    —— 2026-09-25 人类裁决正是「改台账 + 改判据」：**使用社区源的相乘口径**。
  const cells = diffCellsAgainstSnapshot((key, attack) => bodyMultiplier(key, attack));
  log('[实际] 语料正文与旧快照的差异格 =', cells.length, '（手写清单 =', FORTY_ONE_CELLS.length, '）');
  assert.deepEqual(cells, [...FORTY_ONE_CELLS].sort(), '41 格的清单与裁决时登记的清单不一致');
  assert.equal(cells.length, 41);
  for (const cell of cells) {
    const [a, b, attack] = cell.split('|');
    const snap = snapshotMap(`${a}|${b}`).get(attack);
    assert.equal(snap, 3, `${cell} 的快照值不是 3`);
    assert.equal(bodyMultiplier(`${a}|${b}`, attack), 4, `${cell} 的语料值不是 4`);
    assert.match(index.byId.get(`type_chart::${a}|${b}`).body, new RegExp(`${attack}克制${a}\\|${b} ×4`),
      `${a}|${b} 的 ${attack} 必须按裁决写 ×4`);
  }
  // 整库正文里一个封顶的 ×3 都不许有；而 ×4 必须真的存在（否则「改成相乘」是空话）。
  const withThree = l3Docs.filter((doc) => /×3(?![0-9.])/.test(doc.body)).map((doc) => doc.id);
  assert.deepEqual(withThree, [], `这些正文还在写快照的封顶值 ×3：${withThree.join(',')}`);
  const withFour = l3Docs.filter((doc) => /×4(?![0-9.])/.test(doc.body)).map((doc) => doc.id);
  assert.ok(withFour.length > 0, '改口之后必须真的有文档写 ×4');
  // 判据的牙：探测器对「×3 / ×4」必须真的敏感（否则上面两条是空的）。
  assert.equal(/×3(?![0-9.])/.test('草系克制光系|地系 ×3'), true);
  assert.equal(/×4(?![0-9.])/.test('草系克制光系|地系 ×4'), true);
  log('[实际] 写 ×4 的文档 =', withFour.length, '条；样例 =',
    cells.slice(0, 3).map((cell) => {
      const [a, b, attack] = cell.split('|');
      return `${a}|${b} 受 ${attack}：快照 ×3 → 裁决 ×4`;
    }).join('；'));
  // ④ **必红反证**：把语料换回「读快照那一行」的旧口径，同一个对账必须给出 0 格
  //    —— 判据③（要求恰好 41 格）因此必红。这里把两种口径的数一起打出来。
  const cappedCells = diffCellsAgainstSnapshot((key, attack) => snapshotMap(key).get(attack) ?? 1.0);
  log('[实际] 反证：旧口径（照抄快照行）与快照的差异 =', cappedCells.length,
    '格 ⇒ 判据③ 必红（41 ≠ 0）；裁决口径 =', cells.length, '格');
  assert.equal(cappedCells.length, 0, '旧口径本该与快照逐格相同（它的值就是从快照读的）');
  assert.notEqual(cappedCells.length, cells.length, '两种口径必须给出不同的格数，否则这条反证没有牙');
});

// ─────────────────────────────────────────────────────────────────────────
// 6. 改钉不删：P10 的旧期望原话还在，口径没动，新期望实测成立
// ─────────────────────────────────────────────────────────────────────────

test('改钉不删：P10 旧期望的原话逐字保留、探针口径没动，而新期望（答得出）实测成立', () => {
  const heldout = JSON.parse(readFileSync(join(REPO_ROOT, 'data/roco/rag/heldout-queries.json'), 'utf8'));
  const p10 = heldout.probe_queries.find((query) => query.id === 'P10');
  log('[实际] P10 =', JSON.stringify({expected: p10.expected, expectation_prior: p10.expectation_prior, category: p10.category}));
  assert.equal(p10.expectation_prior, 'ABSTAIN', '旧期望必须原话保留（删掉它 = 改钉又删钉）');
  assert.notEqual(p10.expected, p10.expectation_prior);
  assert.match(p10.why_prior, /语料里没有克制表/);
  assert.match(p10.why_prior, /期望弃答/);
  assert.deepEqual(p10.derivation_prior, {kind: 'pack_absence', ref: 'absence:克制表', anchors: ['克制表']});
  assert.match(p10.why, /旧期望「弃答」已被取代|已被取代/);
  // 探针的口径一个字都没动：只跑一次、不回调措辞、失败也登记、不过闸门。
  assert.match(heldout.probe_definition, /不根据结果回调措辞/);
  assert.match(heldout.probe_definition, /保留失败/);
  assert.match(heldout.probe_definition, /探针指标不过闸门/);
  assert.equal(heldout.probe_queries.length, 13);
  assert.equal(heldout.queries.length, 45);
  // 新期望必须**实测**成立（不是写在文件里就算数）。
  const result = searchIndex(index, p10.query, {limit: 1});
  assert.equal(result.results[0].id, p10.expected);
  assert.equal(result.results[0].lib_id, 'L3');
  assert.equal(result.abstained, false);
  log('[实际]', p10.query, '→', result.results[0].id, '（旧期望', p10.expectation_prior, '已随语料补齐而失效）');
});

// ─────────────────────────────────────────────────────────────────────────
// 7. 库清单：L3 的 label 与被改过的 update_mode 不许把真源说错
// ─────────────────────────────────────────────────────────────────────────

test('库清单：L3 的 update_mode 说的是「整库重建」，且 libs.json 里仍只有 L3 声明 type_chart', () => {
  const libs = JSON.parse(readFileSync(join(REPO_ROOT, LIBS_PATH), 'utf8'));
  const owners = libs.libs.filter((lib) => (lib.record_kinds ?? []).includes('type_chart')).map((lib) => lib.lib_id);
  assert.deepEqual(owners, ['L3']);
  const l3 = libs.libs.find((lib) => lib.lib_id === 'L3');
  assert.match(l3.update_mode, /整库重建/);
  assert.match(l3.label, /属性相性/);
  // 其它库的声明（2026-09-25 第 46 轮改钉）：这一轮 **L5 术语库转 ready**（人类批注要求
  // 「预制相关规则知识库进 RAG」，见 `tests/roco-rag-terms.test.js`），所以 pending 只剩 **L4 战术卡库**。
  // 判据的意图没变：**不许悄悄把没接上的库标成 ready**。旧期望（L4/L5 都 pending）按「改钉不删」留在注释里。
  // 2026-09-25（第 47 轮）改钉：L4 战术卡库这一轮也接上了 ⇒ **注册表里已经没有 pending 库**。
  // 意图没变：**不许悄悄把没接上的库标成 ready**（现在由 `tests/roco-rag-tactic-cards.test.js`
  // 的判据①③ 继续钉 L4；pending 的语义另有合成库判据，见 `roco-rag-libs.test.js` 判据④）。
  const pending = libs.libs.filter((lib) => lib.status === 'pending');
  assert.deepEqual(pending.map((lib) => lib.lib_id), [], '这一轮之后不该再有待接的库');
  const l5 = libs.libs.find((lib) => lib.lib_id === 'L5');
  assert.equal(l5.status, 'ready', 'L5 已接上（术语库）');
  assert.deepEqual(l5.record_kinds, ['term_entry']);
  const l4 = libs.libs.find((lib) => lib.lib_id === 'L4');
  assert.equal(l4.status, 'ready', 'L4 已接上（战术卡库）');
  assert.deepEqual(l4.record_kinds, ['tactic_card']);
  log('[实际] type_chart 的归属 =', owners.join(','), '；pending =', pending.map((lib) => lib.lib_id).join(','));
});
