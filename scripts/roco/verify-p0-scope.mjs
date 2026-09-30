#!/usr/bin/env node
/**
 * C-2/C-3 独立复验（harness-verifier）：**自己造入口**，公开面一律从真服务取，不手写。
 *  正：普通对局 + 模式对局(pvp-standard-six-pet，必须带 unverified_overrides) ⇒ validToolArgs 过
 *  负：rules_version 注入 ../etc/passwd · 非白名单字段含 / · path 在顶层/别的数组 · override.path 越界
 * 只读；用法：node scripts/roco/verify-p0-scope.mjs [ROOT]
 */
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const {validToolArgs} = await import(`file:///${R}/src/coach/toolbox.js`);
const {createRocoService} = await import(`file:///${R}/src/server/roco-service.js`);

let pass = true;
const check = (l, ok, e = '') => { if (!ok) pass = false; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${l}${e ? '  ' + e : ''}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));

console.log('=== 从**真服务**取公开面 ===');
const service = createRocoService({repoRoot: ROOT});
let normalPub = null; let modePub = null;
try {
  const roster = await service.roster({limit: 12});
  const six = (roster.pets ?? []).map((p) => p.pet_id).slice(0, 6);
  console.log('  roster 真取到 pet_id 数 =', six.length);

  // 普通对局（3 只训练场）
  const b1 = await service.startBattle({mode: 'demo-training-3v3', team: six.slice(0, 3), seed: 11});
  console.log('  startBattle(demo-training-3v3).ok =', b1.ok, '| battle_id =', b1.battle_id);
  const c1 = service._client();
  const l1 = await c1.battleLegal({state: service._sessions.get(b1.battle_id).state, strategy: 'greedy_damage', stateVersion: 0});
  const pub1 = l1?.ok === true ? (l1.result?.public ?? l1.result?.planner_public) : null;
  normalPub = pub1;
  console.log('  普通对局公开面 keys =', pub1 ? Object.keys(pub1).sort().join(',') : null);
  console.log('    rules_version =', JSON.stringify(pub1?.rules_version), '| 含 "/" =', String(pub1?.rules_version ?? '').includes('/'));
  console.log('    unverified_overrides =', JSON.stringify(pub1?.unverified_overrides));

  // 模式对局（六宠标准 PVP）
  const b2 = await service.startBattle({mode: 'pvp-standard-six-pet', team: six, seed: 11});
  console.log('  startBattle(pvp-standard-six-pet).ok =', b2.ok);
  const c2 = service._client();
  const l2 = await c2.battleLegal({state: service._sessions.get(b2.battle_id).state, strategy: 'greedy_damage', stateVersion: 0});
  modePub = l2?.ok === true ? (l2.result?.public ?? l2.result?.planner_public) : null;
  console.log('  模式对局公开面 unverified_overrides =', JSON.stringify(modePub?.unverified_overrides));
  console.log('    rules_version =', JSON.stringify(modePub?.rules_version));
} finally {
  await service.stop().catch(() => {});
}

console.log('\n=== 正例：真公开面必须过 ===');
const posN = normalPub ? validToolArgs('plan_actions', {state: normalPub, state_version: normalPub.state_version}) : null;
const posM = modePub ? validToolArgs('plan_actions', {state: modePub, state_version: modePub.state_version}) : null;
console.log('  普通对局 ⇒', posN, '| 模式对局 ⇒', posM);
check('普通对局真公开面 ⇒ validToolArgs 过（C-2 修好的那半）', posN === true);
check('模式对局真公开面 ⇒ validToolArgs 过（C-3 修好的那半）', posM === true);
check('模式对局**真的**带 unverified_overrides（否则这格扫不到 C-3）',
  Array.isArray(modePub?.unverified_overrides) && modePub.unverified_overrides.length > 0,
  `n=${modePub?.unverified_overrides?.length}`);

console.log('\n=== 负例：都必须在**真公开面**上被拒 ===');
const base = clone(normalPub ?? {});
const negs = [
  ['rules_version 注入路径', {...base, rules_version: '../etc/passwd'}],
  ['rules_version 注入绝对路径', {...base, rules_version: '/etc/passwd'}],
  ['非白名单字段 note 含 /（通用规则不许放宽）', {...base, note: 'a/b'}],
  ['顶层 path（C-3 只认 unverified_overrides[] 内）', {...base, path: 'a/b'}],
  ['别的数组里放 path', {...base, seen_roster: [...(base.seen_roster ?? []), {slot: 1, path: 'a/b'}]}],
];
for (const [label, state] of negs) {
  const ok = validToolArgs('plan_actions', {state, state_version: state.state_version ?? 0});
  console.log(`  ${label} ⇒ ${ok ? 'RED(过了!)' : 'rejected'}`);
  check(`负例：${label} ⇒ 拒`, ok === false);
}
if (modePub) {
  for (const bad of ['a/b', 'a.b/../c', '..']) {
    const st = clone(modePub);
    st.unverified_overrides = st.unverified_overrides.map((o, i) => (i === 0 ? {...o, path: bad} : o));
    const ok = validToolArgs('plan_actions', {state: st, state_version: st.state_version});
    console.log(`  unverified_overrides[0].path="${bad}" ⇒ ${ok ? 'RED(过了!)' : 'rejected'}`);
    check(`负例：override.path="${bad}" ⇒ 拒`, ok === false);
  }
  // 对照：**合法**的 override.path（真值原样）必须仍过 —— 别把功能一起拒掉
  const ok = validToolArgs('plan_actions', {state: clone(modePub), state_version: modePub.state_version});
  check('对照：模式公开面原样 ⇒ 仍过（作用域白名单没把功能拒掉）', ok === true);
}

console.log('\nRESULT =', pass ? 'P0 SCOPE PASS' : 'P0 SCOPE CHECK-NEEDED');
process.exit(pass ? 0 : 1);
