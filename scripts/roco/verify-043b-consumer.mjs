#!/usr/bin/env node
/**
 * 04.3b 独立复验（消费侧）：原样传 / ⑨a 独立期望 / 前置闸两向 / 裁剪 64。
 * 手法：真 `executeTool('plan_actions')` + 假桥假规划器；换人期望**我自己**从 seen_roster 现算。
 * 只读；用法：node scripts/roco/verify-043b-consumer.mjs [ROOT]
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const TB = await import(`file:///${R}/src/coach/toolbox.js`);
const {executeTool, configureRocoTools, resetRocoTools, normalizeOpponentScenarioRows} = TB;

let pass = true;
const check = (l, ok, e = '') => { if (!ok) pass = false; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${l}${e ? '  ' + e : ''}`); };

const SV = 7;
const TOOL_STATE = {schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', rules_version: 'rv-1',
  match_id: 'm-043b', decision_id: 'm-043b:v7', state_version: SV, turn: 3,
  self: {active: 0, items: {}, pets: [{pet_id: 'pet_000225', slot: 0, hp: 120, max_hp: 180, energy: 4}]},
  opponent: {active: 0, field: {pet_id: 'pet_000417', slot: 0, hp: 100, max_hp: 160, energy: 3}}};
const VIEW = JSON.parse(readFileSync(join(ROOT, 'reports/roco/product-execution/03/raw-03.3-view-pvp.json'), 'utf8'));

/** 我自己实现的「公开面能证明的换人位次」期望（语义同判据：排除场上位次与倒下位次）。 */
function myExpectedSwitchSlots(view) {
  const active = Number.isInteger(view?.opponent?.field?.slot) ? view.opponent.field.slot : null;
  const dead = new Set((view?.opponent?.bench ?? [])
    .filter((r) => Number.isInteger(r?.slot) && r.fainted === true).map((r) => r.slot));
  const slots = (view?.seen_roster ?? [])
    .map((r) => r?.slot)
    .filter((s) => Number.isInteger(s) && s !== active && !dead.has(s));
  return [...new Set(slots)].sort((a, b) => a - b);
}

function engine(result) {
  return {ok: true, code: null, error_type: null, message: null, latency_ms: 1, state_version: SV,
    ruleset_id: 'roco-world-s4-2026-09-10', unsupported: [], limitations: [], result};
}
function harness({outlook = null, builder = null, engineFactory = () => engine({recommended_label: '抓挠',
  recommendation_stable: true, expected: {min: 0, max: 0, mean: 0}, worst: {min: 0, max: 0},
  coverage: 1, timed_out: false, first_second_margin: {min: 0, max: 0, mean: 0}})} = {}) {
  resetRocoTools();
  const plannerCalls = [];
  configureRocoTools({client: {planActions: async () => engineFactory()}, stateVersion: () => SV});
  configureRocoTools({planner: async (req) => { plannerCalls.push(req); return {...engineFactory(), state_version: req.state_version}; }});
  if (outlook) configureRocoTools({opponentOutlook: outlook});
  if (builder) configureRocoTools({actionScenarioBuilder: builder});
  return {plannerCalls, run: (ctx) => executeTool('plan_actions', {state: TOOL_STATE, state_version: SV}, {matchId: 'm-043b', ...ctx}), done: () => resetRocoTools()};
}

// ── [1][2] 真 view：原样传 + 独立期望 ──
console.log('=== [1][2] 真 view（raw-03.3-view-pvp.json）===');
const h = harness();
let sent, receipt;
try {
  receipt = await h.run({rocoActionView: VIEW});
  sent = h.plannerCalls[0]?.opponentScenarios;
} finally { /* keep receipts */ }
console.log('  注入条数 =', Array.isArray(sent) ? sent.length : sent);
const mySlots = myExpectedSwitchSlots(VIEW);
const sw = (sent ?? []).filter((r) => r.kind === 'switch_in_seen');
const pool = (sent ?? []).filter((r) => r.evidence_basis === 'learnable_pool_hypothesis');
const stay = (sent ?? []).filter((r) => r.kind === 'stay_attack' || r.kind === 'stay_defense');
console.log('  我自己现算的换人期望位次 =', JSON.stringify(mySlots));
console.log('  实际换人情景位次 =', JSON.stringify(sw.map((r) => r.slots?.[0]).sort((a, b) => a - b)));
console.log('  留场 =', stay.length, '| 换人 =', sw.length, '| 池情景 =', pool.length);
check('真 view 能注入（非空）', Array.isArray(sent) && sent.length > 0);
check('换人情景数 == 我从 seen_roster 现算的期望', sw.length === mySlots.length, `实际 ${sw.length} vs 期望 ${mySlots.length}`);
check('换人位次逐个来自公开面',
  JSON.stringify(sw.map((r) => r.slots?.[0]).sort((a, b) => a - b)) === JSON.stringify(mySlots));
check('留场与换人**并存**（不塌缩）', stay.length > 0 && sw.length > 0);
check('池情景 slots 照传空数组（不猜位次）',
  pool.length > 0 && pool.every((r) => Array.isArray(r.slots) && r.slots.length === 0), `池情景 n=${pool.length}`);
check('池情景保留 evidence_basis=learnable_pool_hypothesis 标记',
  pool.every((r) => r.evidence_basis === 'learnable_pool_hypothesis'));
const fields = new Set((sent ?? []).flatMap((r) => Object.keys(r)));
console.log('  实际发出的字段 =', [...fields].sort().join(','));
check('字段是引擎契约那几样（kind/slots/species_ids/skill_ids/evidence_basis/evidence_ids/scenario_id）',
  ['scenario_id', 'kind', 'slots', 'species_ids', 'skill_ids', 'evidence_basis', 'evidence_ids']
    .every((k) => fields.has(k)));
const unav = receipt.opponentScenarios?.unavailable ?? [];
console.log('  unavailable.what =', JSON.stringify(unav.map((r) => r.what)));
const p3row = unav.find((r) => r.what === 'bench_hp_and_moveset');
console.log('  P3 行 =', JSON.stringify(p3row));
check('P3 残留（bench_hp_and_moveset）照实传递', Boolean(p3row));
check('P3 的 why 点明假设来源（满血/规范配招）', /满血|规范配招/.test(String(p3row?.why ?? '')));
check('limitations 点名 P3 残留', (receipt.limitations ?? []).some((l) => /P3 残留/.test(String(l))));
check('回执带 03b 协议与声明',
  receipt.opponentScenarios?.protocol === 'rc604-opponent-action-scenarios/v1'
  && receipt.opponentScenarios?.declarations?.is_probability === false);
console.log('  回执 counts =', JSON.stringify(receipt.opponentScenarios?.counts),
  '| source =', receipt.opponentScenarios?.source);

// 把「实际会发出去的 rows」落盘，交给真引擎做集成验证
writeFileSync('E:/roco-scratch/043b-sent-rows.json', JSON.stringify({rows: sent, view: VIEW}, null, 2));
console.log('  rows 已落盘 E:/roco-scratch/043b-sent-rows.json');

// ── [3] 前置闸两向 ──
console.log('\n=== [3] 前置闸两向 ===');
const clientSnap = {turn: 3, state_version: SV, self: [{pet_id: 'pet_000007', hp: 100, max_hp: 120}],
  self_active: 0, foe: [{pet_id: 'pet_000239', hp: 90, max_hp: 110}],
  foe_bench: [{slot: 1, fainted: false}, {slot: 2, fainted: true}],
  seen_roster: (VIEW.seen_roster ?? []).slice(0, 2)};
{
  const hb = harness();
  try {
    const rc = await hb.run({roco_battle: clientSnap});
    console.log('  客户端快照 ⇒ planner 收到 =', JSON.stringify(hb.plannerCalls[0]?.opponentScenarios),
      '| source =', rc.opponentScenarios?.source, '| available =', rc.opponentScenarios?.available);
    console.log('    why =', String(rc.opponentScenarios?.unavailable?.[0]?.why ?? '').slice(0, 120));
    check('缺 opponent.field ⇒ 不注入', hb.plannerCalls[0]?.opponentScenarios === undefined);
    check('source=view-missing-active', rc.opponentScenarios?.source === 'view-missing-active');
    check('available=null（不是 false/true）', rc.opponentScenarios?.available === null);
    check('原因点名 opponent.field 与 留场/换人',
      /opponent\.field/.test(String(rc.opponentScenarios?.unavailable?.[0]?.why ?? ''))
      && /留场|换人/.test(String(rc.opponentScenarios?.unavailable?.[0]?.why ?? '')));
  } finally { hb.done(); }
}
{
  const hc = harness();
  try {
    const rc = await hc.run({rocoActionView: VIEW});
    check('完整视图照常注入（前置闸没把功能关掉）',
      Array.isArray(hc.plannerCalls[0]?.opponentScenarios) && hc.plannerCalls[0].opponentScenarios.length > 0);
  } finally { hc.done(); }
}
{
  const hn = harness();
  try {
    const rc = await hn.run();
    check('完全没有视图 ⇒ source=missing-view 且不注入',
      hn.plannerCalls[0]?.opponentScenarios === undefined && rc.opponentScenarios?.source === 'missing-view');
  } finally { hn.done(); }
}

// ── [4] 70 ⇒ 64 截断 ──
console.log('\n=== [4] 70 条 ⇒ 64 条（按 scenario_id 定序）+ 6 条逐条登记 ===');
const many = Array.from({length: 70}, (_v, i) => ({scenario_id: `s${String(i).padStart(3, '0')}`,
  kind: 'stay_attack', slots: [0], species_ids: ['pet_000239'], skill_ids: [], evidence_ids: ['x'],
  evidence_basis: 'observed'}));
{
  // 走 **03b 路径**（actionScenarioBuilder）——截断只在这条路上生效；opponentOutlook 是测试用覆盖，
  // 不截断（这一点我单独登记，见报告 §观察）
  const ht = harness({builder: () => ({protocol: 'rc604-opponent-action-scenarios/v1', available: true,
    unknown_reason: null, scenarios: many, counts: {stay: 70, switch: 0, observed: 70, hypothesis: 0},
    sources: {stay_available: true, switch_available: false, pool_candidates: 0}, unavailable: [],
    declarations: {is_probability: false}})});
  try {
    const rc = await ht.run();
    const sentRows = ht.plannerCalls[0]?.opponentScenarios ?? [];
    console.log('  发出条数 =', sentRows.length, '| 首/末 id =', sentRows[0]?.scenario_id, '/', sentRows[sentRows.length - 1]?.scenario_id);
    const over = (rc.opponentScenarios?.unavailable ?? []).filter((r) => String(r.what).startsWith('over_engine_limit:'));
    console.log('  over_engine_limit 登记 =', over.length, '| 样例 =', JSON.stringify(over[0]));
    check('只发 64 条', sentRows.length === 64, `实际 ${sentRows.length}`);
    check('按 scenario_id 定序（前 64 条）',
      JSON.stringify(sentRows.map((r) => r.scenario_id)) === JSON.stringify(many.slice(0, 64).map((r) => r.scenario_id)));
    check('6 条逐条登记 over_engine_limit:*', over.length === 6);
    check('登记的是被裁掉那 6 条（s064..s069）',
      JSON.stringify(over.map((r) => String(r.what).split(':')[1]).sort()) === JSON.stringify(many.slice(64).map((r) => r.scenario_id).sort()));
  } finally { ht.done(); }
}
{
  // 对照：opponentOutlook（测试用 provider）**不截断** —— 如实登记
  const hp = harness({outlook: () => ({scenarios: many, unavailable: []})});
  try {
    await hp.run({rocoActionView: VIEW});
    console.log('  对照 opponentOutlook 路径发出条数 =', (hp.plannerCalls[0]?.opponentScenarios ?? []).length,
      '（该路径不截断 —— 生产不用它，登记备查）');
  } finally { hp.done(); }
}

// ── 归一化：原样传（不映射）──
console.log('\n=== [1b] normalizeOpponentScenarioRows 原样传 ===');
const norm = normalizeOpponentScenarioRows([
  {scenario_id: 'a', kind: 'switch_in_seen', slots: [], species_ids: ['p1'], skill_ids: ['k1'],
   evidence_basis: 'learnable_pool_hypothesis', evidence_ids: ['e1'], extra_ignored: 1},
  {scenario_id: 'b', kind: 'stay_attack', slots: [2], species_ids: ['p2'], skill_ids: ['k2'], evidence_basis: 'observed'},
]);
console.log('  →', JSON.stringify(norm));
check('slots=[] 原样保留', JSON.stringify(norm.rows?.[0]?.slots) === '[]');
check('kind 不被映射', norm.rows?.[0]?.kind === 'switch_in_seen' && norm.rows?.[1]?.kind === 'stay_attack');
check('evidence_basis 保留', norm.rows?.[0]?.evidence_basis === 'learnable_pool_hypothesis');
check('species_ids/skill_ids 原样', JSON.stringify(norm.rows?.[1]?.species_ids) === '["p2"]');

console.log('\nRESULT =', pass ? '04.3b CONSUMER PASS' : '04.3b CONSUMER CHECK-NEEDED');
process.exit(pass ? 0 : 1);
