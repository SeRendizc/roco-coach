#!/usr/bin/env node
/**
 * 04.2 · ⑦ 请求体白名单 + `_request` 本地拒绝（独立实测）。
 * 手法：不真发请求 —— 用假的 `_http` 把「实际会发出去的 body」抓下来并计数。
 * 用法：node scripts/roco/verify-042-body.mjs [ROOT]
 */
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const {RocoClient} = await import(`file:///${R}/src/coach/roco-client.js`);

const PUBLIC = {
  schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', ruleset_config_id: 'cfg-default',
  side: 'player', turn: 3, state_version: 7, match_id: 'm-fixture', decision_id: 'm-fixture:v7',
  self: {active: 0, items: {}, pets: [{pet_id: 'pet_000225', slot: 0, hp: 120, max_hp: 180,
    energy: 4, statuses: {}, marks: {}, buffs: {}}], loadouts: {pet_000225: ['skill_000246']}},
  opponent: {active: 0, field: {pet_id: 'pet_000417', slot: 0, hp: 100, max_hp: 160, energy: 3,
    statuses: {}, marks: {}, buffs: {}}, bench: [{slot: 1, fainted: false}]},
  assumptions: {opponent_bench: 'full_hp_nominal_loadout'},
};
const WHITELIST = ['analysis_seeds', 'beam', 'budget_ms', 'damage_preview', 'depth', 'public',
  'ruleset_id', 'state_version'];

let pass = true;
const check = (l, ok, e = '') => { if (!ok) pass = false; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${l}${e ? '  ' + e : ''}`); };

function makeClient() {
  const c = new RocoClient({baseUrl: 'http://127.0.0.1:9', rulesetId: 'roco-world-s4-2026-09-10'});
  const sent = [];
  c._http = async (method, path, body) => {
    sent.push({method, path, body: body ? JSON.parse(Buffer.from(body).toString('utf8')) : null});
    // `_request` 读的是 `{status, text}`（见 roco-client.js:607-627）
    return {status: 200, text: JSON.stringify({ok: true, result: {state_version: 7}})};
  };
  return {c, sent};
}

// ── 1) planActions 的 body 键集 ──
console.log('=== [1] planActions 实际发出的 body 键集 ===');
{
  const {c, sent} = makeClient();
  await c.planActions(PUBLIC, {stateVersion: 7, depth: 2, beam: 4, budgetMs: 1500,
    analysisSeeds: [11, 29], damagePreview: true, seed: 424242, opponentHint: 'X'});
  const body = sent[0]?.body ?? {};
  console.log('  body keys =', Object.keys(body).join(','));
  console.log('  含 seed? ', 'seed' in body, '| 含 opponentHint/opponent_hint? ',
    'opponentHint' in body || 'opponent_hint' in body);
  check('body ⊆ 白名单', Object.keys(body).every((k) => WHITELIST.includes(k)),
    Object.keys(body).filter((k) => !WHITELIST.includes(k)).join(','));
  check('body 里没有 seed', !('seed' in body));
  check('http 调用次数 = 1（真的发出去了）', sent.length === 1);
}

// ── 2) 隐藏键：public.seed ⇒ 本地拒绝 + 0 次 HTTP ──
console.log('\n=== [2] 隐藏键本地拒绝（连发都不发）===');
for (const [label, state] of [
  ['public.seed', {...PUBLIC, seed: 424242}],
  ['public.self.seed（深层）', {...PUBLIC, self: {...PUBLIC.self, seed: 7}}],
  ['public.history[0].seed', {...PUBLIC, history: [{seed: 9}]}],
  ['public.opponent._pending_enemy', {...PUBLIC, opponent: {...PUBLIC.opponent, _pending_enemy: {kind: 'skill'}}}],
  ['public.rng_seed（别名）', {...PUBLIC, rng_seed: 123}],
]) {
  const {c, sent} = makeClient();
  const res = await c.planActions(state, {stateVersion: 7});
  const code = res?.error ?? res?.code ?? null;
  console.log(`  ${label.padEnd(30)} code=${code} | http次数=${sent.length} | msg=${String(res?.message ?? '').slice(0, 60)}`);
  check(`${label} ⇒ 本地拒绝(hidden_information) 且 0 次 HTTP`,
    code === 'hidden_information' && sent.length === 0);
}

// ── 3) 干净 public ⇒ 正常发出 ──
console.log('\n=== [3] 干净 public（控件）===');
{
  const {c, sent} = makeClient();
  const res = await c.planActions(PUBLIC, {stateVersion: 7});
  console.log('  http次数 =', sent.length, '| path =', sent[0]?.path, '| error =', res?.error ?? null);
  check('控件：干净 public 正常发出（1 次 HTTP）', sent.length === 1 && !res?.error);
}

console.log('\nRESULT =', pass ? 'BODY-WHITELIST PASS' : 'BODY-WHITELIST CHECK-NEEDED');
process.exit(pass ? 0 : 1);
