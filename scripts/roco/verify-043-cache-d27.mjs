#!/usr/bin/env node
/**
 * 04.3 独立复验（Node 侧）：P6 缓存七元组 / 只缓存完成 / D-27 读侧 / opponentScenarios 透传白名单。
 * 手法：驱动**真** `executeTool('plan_actions')`（假桥 + 假规划器，不起 Python）。
 * 用法：node scripts/roco/verify-043-cache-d27.mjs [ROOT]
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const TB = await import(`file:///${R}/src/coach/toolbox.js`);
const {executeTool, configureRocoTools, resetRocoTools, readFirstSecondMargin,
  rocoPlanCacheKey, rocoPlanCacheSize, validToolArgs} = TB;
const {RocoClient} = await import(`file:///${R}/src/coach/roco-client.js`);

let pass = true;
const check = (l, ok, e = '') => { if (!ok) pass = false; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${l}${e ? '  ' + e : ''}`); };

const SV = 7;
// 形状对齐 tests/roco-plan-context.test.js 的 PLAN_TOOL_STATE（工具契约要的是公开 planner state）
const STATE = {schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', rules_version: 'rv-1',
  match_id: 'm-043', decision_id: 'm-043:v7', state_version: SV, turn: 3,
  self: {active: 0, items: {}, pets: [{pet_id: 'pet_000225', slot: 0, hp: 120, max_hp: 180, energy: 4}]},
  opponent: {active: 0, field: {pet_id: 'pet_000417', slot: 0, hp: 100, max_hp: 160, energy: 3}}};
console.log('validToolArgs(plan_actions, {state, state_version}) =',
  validToolArgs('plan_actions', {state: STATE, state_version: SV}));

// ── [4a] 七元组键 ──
console.log('=== [4a] rocoPlanCacheKey 七元组 ===');
const FULL = {match_id: 'm-043', state_version: SV, rules_version: 'rv-1', depth: 2, beam: 4,
  budget_ms: 2000, analysis_seeds: [11, 29]};
const fullKey = rocoPlanCacheKey(FULL);
console.log('  全 7 项 ⇒', fullKey);
check('全 7 项 ⇒ 非空键且 6 个 | 分隔符（7 段）',
  typeof fullKey === 'string' && fullKey.split('|').length === 7, `segments=${String(fullKey).split('|').length}`);
console.log('  逐项拿掉后的键：');
for (const k of Object.keys(FULL)) {
  const parts = {...FULL}; delete parts[k];
  const key = rocoPlanCacheKey(parts);
  console.log(`    -${k.padEnd(15)} ⇒ ${key === null ? 'null（不进缓存）' : key}`);
}
const idKeys = ['match_id', 'state_version', 'rules_version'];
for (const k of idKeys) {
  const parts = {...FULL}; delete parts[k];
  check(`身份项 ${k} 缺失 ⇒ 键为 null（不缓存）`, rocoPlanCacheKey(parts) === null);
}
for (const k of ['depth', 'beam', 'budget_ms', 'analysis_seeds']) {
  const parts = {...FULL}; delete parts[k];
  const key = rocoPlanCacheKey(parts);
  check(`参数项 ${k} 缺失 ⇒ 回落 default 占位（仍可缓存，但键不同）`,
    typeof key === 'string' && /default/.test(key), String(key).slice(-24));
}

// ── [4b/4c] 工具级：命中 / 只缓存完成 / 少一项不进缓存 ──
function engine(overrides = {}) {
  return {ok: true, code: null, error_type: null, message: null, latency_ms: 1,
    ruleset_id: 'roco-world-s4-2026-09-10', state_version: SV, unsupported: [], limitations: ['引擎自报的限制'],
    result: {recommended_label: '抓挠', recommendation_stable: true,
      expected: {min: -0.3, max: -0.2, mean: -0.24}, worst: {min: -0.3, max: -0.2},
      main_counter: '换上第2位', branches_evaluated: 12, depth_searched: 2, coverage: 1,
      timed_out: false, first_second_margin: {min: 0.01, max: 0.09, mean: 0.0732, scale: 'one-ply-value', note: 'x'},
      ...overrides.result}};
}

function harness({state = STATE, version = SV, engineFactory = () => engine()} = {}) {
  resetRocoTools();
  let v = version;
  configureRocoTools({client: {planActions: async () => engineFactory()}, stateVersion: () => v});
  configureRocoTools({planner: async (req) => ({...engineFactory(), state_version: req.state_version})});
  return {
    run: (st = state) => executeTool('plan_actions', {state: st, state_version: v}, {matchId: 'm-043'}),
    done: () => resetRocoTools(),
  };
}

console.log('\n=== [4b] 命中 / 只缓存完成 ===');
{
  const h = harness();
  try {
    const first = await h.run();
    const second = await h.run();
    console.log('  第 1 次 cache =', JSON.stringify(first.cache));
    console.log('  第 2 次 cache =', JSON.stringify(second.cache));
    check('第 1 次 stored=true, hit=false', first.cache?.hit === false && first.cache?.stored === true);
    check('第 2 次 hit=true, stored=false', second.cache?.hit === true && second.cache?.stored === false);
    check('命中回执带 key/keyParts/ageMs',
      typeof second.cache?.key === 'string' && Array.isArray(second.cache?.keyParts) === false
      && second.cache?.keyParts && typeof second.cache.ageMs === 'number',
      `keyParts=${JSON.stringify(second.cache?.keyParts)}`);
    check('keyParts 就是七元组（7 个字段）',
      JSON.stringify(Object.keys(second.cache?.keyParts ?? {}).sort())
      === JSON.stringify(['analysis_seeds', 'beam', 'budget_ms', 'depth', 'match_id', 'rules_version', 'state_version']),
      Object.keys(second.cache?.keyParts ?? {}).join(','));
    console.log('  缓存条数 =', rocoPlanCacheSize());
  } finally { h.done(); }
}

console.log('\n=== [4c] 我自己构造的「少一项」场景：拿掉 rules_version ⇒ 不进缓存、也不命中 ===');
{
  const noRv = {...STATE}; delete noRv.rules_version;
  const h = harness({state: noRv});
  try {
    const a = await h.run(noRv);
    const b = await h.run(noRv);
    console.log('  第 1 次 cache =', JSON.stringify(a.cache));
    console.log('  第 2 次 cache =', JSON.stringify(b.cache));
    console.log('  缓存条数 =', rocoPlanCacheSize());
    check('缺 rules_version ⇒ key=null 且 stored=false', a.cache?.key === null && a.cache?.stored === false);
    check('缺 identity ⇒ 第二次仍 hit=false（没被缓存）', b.cache?.hit === false);
    check('缓存条数仍为 0', rocoPlanCacheSize() === 0, String(rocoPlanCacheSize()));
  } finally { h.done(); }
}

console.log('\n=== [4d] 未完成的搜索不缓存（timed_out）===');
{
  const h = harness({engineFactory: () => engine({result: {timed_out: true}})});
  try {
    const a = await h.run();
    console.log('  timed_out ⇒ cache =', JSON.stringify(a.cache), '| timeout.state =', a.timeout?.state);
    check('timed_out ⇒ stored=false', a.cache?.stored === false);
    check('缓存条数 0（没把「没算完」永久化）', rocoPlanCacheSize() === 0, String(rocoPlanCacheSize()));
  } finally { h.done(); }
}

// ── [5] D-27 读侧 ──
console.log('\n=== [5] D-27 读侧：对象形给数；缺/坏 ⇒ unknown，绝不当 0 ===');
const known = readFirstSecondMargin({first_second_margin: {min: 0.01, max: 0.09, mean: 0.0732,
  scale: 'one-ply-value', note: 'x'}}, {available: true});
console.log('  对象形 ⇒', JSON.stringify(known));
check('对象形 ⇒ status=known 且 value=mean', known.status === 'known' && known.value === 0.0732);
for (const [label, field] of [['缺字段', undefined], ['标量形', 0.0732], ['缺 mean', {min: 0.01, max: 0.09}],
  ['mean=null', {min: 0.01, max: 0.09, mean: null}], ['数组', [0.01, 0.09]],
  ['mean=0（合法 0 也要走对象形）', {min: 0, max: 0, mean: 0}]]) {
  const v = readFirstSecondMargin({first_second_margin: field}, {available: true});
  const isZeroOk = label.startsWith('mean=0') && v.status === 'known' && v.value === 0;
  console.log(`  ${label.padEnd(10)} ⇒ status=${v.status} value=${JSON.stringify(v.value)} reason=${String(v.reason ?? '').slice(0, 48)}`);
  check(`${label} ⇒ 非 known 时 value=null（不当 0）`,
    isZeroOk || (v.status === 'unknown' && v.value === null));
}
const na = readFirstSecondMargin(null, {available: false});
check('没有完成的搜索 ⇒ not_applicable 且 value=null', na.status === 'not_applicable' && na.value === null);

console.log('\n=== [5b] 工具回执：缺字段 ⇒ null + limitations 点名 ===');
{
  const h = harness({engineFactory: () => engine({result: {first_second_margin: undefined}})});
  try {
    const rc = await h.run();
    console.log('  firstSecondMargin =', rc.firstSecondMargin, '| detail =', JSON.stringify(rc.firstSecondMarginDetail));
    console.log('  limitations =', JSON.stringify(rc.limitations));
    check('缺字段 ⇒ firstSecondMargin=null（不是 0）', rc.firstSecondMargin === null);
    check('detail.status=unknown', rc.firstSecondMarginDetail?.status === 'unknown');
    check('limitations 点名「边际量不可用」', (rc.limitations ?? []).some((l) => /边际量不可用/.test(String(l))));
  } finally { h.done(); }
}

// ── [7] opponentScenarios 透传仍走白名单 ──
console.log('\n=== [7] roco-client：opponentScenarios 透传是否仍受白名单约束 ===');
{
  const testSrc = readFileSync(join(ROOT, 'tests', 'roco-plan-context.test.js'), 'utf8');
  const m = testSrc.match(/const PLAN_BODY_KEYS = \[([^\]]+)\]/);
  const keys = m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')) : [];
  console.log('  测试里的白名单 =', JSON.stringify(keys));
  check('白名单含 opponent_scenarios（04.3 新增后已同步）', keys.includes('opponent_scenarios'));
  const c = new RocoClient({baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10'});
  const sent = [];
  c._http = async (method, path, body) => {
    sent.push({path, body: JSON.parse(Buffer.from(body).toString('utf8'))});
    return {status: 200, text: JSON.stringify({ok: true, result: {state_version: SV}})};
  };
  await c.planActions(STATE, {stateVersion: SV, opponentScenarios: [{scenario_id: 's1', kind: 'stay_attack'}]});
  const body = sent[0]?.body ?? {};
  console.log('  body keys =', Object.keys(body).join(','));
  check('传了情景 ⇒ body 里出现 opponent_scenarios', Array.isArray(body.opponent_scenarios));
  check('body ⊆ 白名单（没开新透传口子）',
    Object.keys(body).every((k) => keys.includes(k)), Object.keys(body).filter((k) => !keys.includes(k)).join(','));
  const c2 = new RocoClient({baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10'});
  const sent2 = [];
  c2._http = async (m2, p2, b2) => { sent2.push(JSON.parse(Buffer.from(b2).toString('utf8'))); return {status: 200, text: '{"ok":true,"result":{}}'}; };
  await c2.planActions(STATE, {stateVersion: SV, opponentScenarios: [], seed: 424242});
  console.log('  空数组 + seed ⇒ body keys =', Object.keys(sent2[0] ?? {}).join(','));
  check('空数组 ⇒ 不带 opponent_scenarios；seed 仍进不去',
    !('opponent_scenarios' in (sent2[0] ?? {})) && !('seed' in (sent2[0] ?? {})));
}

console.log('\nRESULT =', pass ? '04.3 NODE PROBE PASS' : '04.3 NODE PROBE CHECK-NEEDED');
process.exit(pass ? 0 : 1);
