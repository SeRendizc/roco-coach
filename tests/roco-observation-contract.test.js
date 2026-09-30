// 分计划 01.2 / 01.3：Node 公开视图（`publicView`）的**观察契约**与「已亮明」转发。
//
// 这一层是**白名单**：引擎给什么这里才有什么；引擎没给的一个字节都不许补，
// 引擎给了的（契约字段、已见阵容、对手已出招）也不许在这里丢掉 ——
// 丢字段的后果不是报错，而是页面上那条事实**永远画不出来**（天气/魔力都踩过这个坑）。
//
// 判据（每条都带必红方向）：
//   ① 契约字段（match_id / rules_version / decision_id）原样转发；引擎没给 ⇒ **键不出现**；
//   ② `seen_roster` 只在真有亮明事件时出现（**不是空数组**），且只带公开字段；
//   ③ 对手**已经打出来**的技能走 `opponent.revealed_skills`（带名字，形状同 `legal[].skill`）；
//   ④ 未亮明的后备**即使被塞进 id**，Node 白名单也必须把它剥掉（反向控制）；
//   ⑤ 带亮明的回执里同样不许出现私有 state / seed / 对手配招。
//
// 运行：node --test tests/roco-observation-contract.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {publicView, createRocoService} from '../src/server/roco-service.js';
import {RocoClient} from '../src/coach/roco-client.js';

const RULESET = 'roco-world-s4-2026-09-10';
const MATCH = 'm-abc123def456';

/** 引擎回执的**真实形状**（两个公开面 + 私有域里 `publicView` 读得到的那些键）。 */
function engineResult({revealed = null, withContract = true, contract = {}} = {}) {
 const contractKeys = withContract
  ? {match_id: MATCH, rules_version: `${RULESET}/legacy_sim_v1`, decision_id: `${MATCH}:v3`}
  : {};
 const field = (name) => ({
  slot: 0, pet_id: 'pet_000417', name, hp: 30, max_hp: 30, energy: 1, fainted: false,
  statuses: {}, marks: {}, defense_cooldown: 0, charging: false,
  types: ['水系'], stats: {atk: 90, def: 80, hp: 130, spa: 95, spd: 90, spe: 70},
  class: null, stage: null, stats_source: 'species-race',
 });
 const own = {
  slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', hp: 44, max_hp: 44, energy: 2, fainted: false,
  statuses: {}, marks: {}, buffs: {}, defense_cooldown: 0, charging: false, entered_turn: 1,
  types: ['幽系'], stats: {atk: 100, def: 90, hp: 140, spa: 100, spd: 95, spe: 85},
  class: null, stage: null, stats_source: 'species-race',
 };
 const opponent = (bench) => ({
  active: 0, living_count: 2,
  field: {slot: 0, pet_id: 'pet_000417', hp: 30, max_hp: 30, energy: 1, fainted: false,
   statuses: {}, marks: {}, defense_cooldown: 0, charging: false},
  bench,
 });
 return {
  state_version: 3, turn: 2, phase: 'battle', result: null,
  public: {
   schema_version: 1, ruleset_id: RULESET, ruleset_config_id: 'legacy_sim_v1',
   ...contractKeys, ...contract,
   state_version: 3, side: 'player', turn: 2, phase: 'battle', result: null,
   unverified_overrides: [],
   self: {active: 0, items: {}, loadouts: {pet_000225: ['skill_000576']},
    pets: [{slot: 0, pet_id: 'pet_000225', hp: 44, max_hp: 44, energy: 2, fainted: false,
     statuses: {}, marks: {}, buffs: {}, defense_cooldown: 0, charging: false, entered_turn: 1}]},
   opponent: opponent([{slot: 1, fainted: false}]),
   assumptions: {opponent_bench: 'full_hp_nominal_loadout', note: '…'},
   ...(revealed ? {revealed} : {}),
  },
  ui: {
   schema_version: 1, ruleset_id: RULESET, ruleset_config_id: 'legacy_sim_v1',
   ...contractKeys, ...contract,
   state_version: 3, turn: 2, phase: 'battle', result: null, side: 'player',
   unverified_overrides: [],
   self: {active: 0, energy_max: 10, energy_charge: 5, pets: [own], skills: [], loadouts: {}, magic: null},
   opponent: {active: 0, living_count: 2, energy_max: 10, energy_charge: 5, field: field('圆号鱼'),
    bench: [{slot: 1, fainted: false}]},
   legal: {player: []},
   notes: {opponent_bench: '…', coach_protocol: '…', unverified_overrides: []},
   ...(revealed ? {revealed} : {}),
  },
  legal: {player: [], enemy: [{kind: 'skill'}, {kind: 'switch'}]},
  events: [], strategy: {name: 'greedy_damage', version: 1},
  needs_replacement: [], unsupported_seen: [],
 };
}

const REVEALED = {
 opponent_roster: [
  {slot: 0, pet_id: 'pet_000417', name: '圆号鱼', revealed_via: 'opening_preview',
   revealed_turn: 1, revealed_event_seq: 0},
  {slot: 1, pet_id: 'pet_000112', name: '雪影娃娃', revealed_via: 'opening_preview',
   revealed_turn: 1, revealed_event_seq: 0},
 ],
 opponent_skills: {
  pet_000417: [{skill_id: 'skill_000286', kind: 'skill',
   skill: {name: '水炮', element: '水系', power: 80, power_status: 'static_value_present',
    energy: 3, damage_class: 'special', desc: '…', is_trait: false}}],
 },
};

test('① 契约字段原样转发；引擎没给 ⇒ 这个键不出现（旧 fixture 一个字节不变）', () => {
 const view = publicView(engineResult());
 assert.equal(view.match_id, MATCH);
 assert.equal(view.rules_version, `${RULESET}/legacy_sim_v1`);
 assert.equal(view.decision_id, `${MATCH}:v3`);

 const legacy = publicView(engineResult({withContract: false}));
 for (const key of ['match_id', 'rules_version', 'decision_id']) {
  assert.equal(key in legacy, false, `引擎没给 ${key}，Node 却补了一个`);
 }
});

test('①b 必红方向：空串 / 非字符串不许当成契约字段转发', () => {
 const view = publicView(engineResult({contract: {match_id: '', rules_version: 42, decision_id: null}}));
 assert.equal('match_id' in view, false);
 assert.equal('rules_version' in view, false);
 assert.equal('decision_id' in view, false);
});

test('② seen_roster 只在真有亮明事件时出现，且只带公开字段', () => {
 const view = publicView(engineResult({revealed: REVEALED}));
 assert.deepEqual(view.seen_roster, [
  {slot: 0, pet_id: 'pet_000417', name: '圆号鱼', revealed_via: 'opening_preview', revealed_turn: 1},
  {slot: 1, pet_id: 'pet_000112', name: '雪影娃娃', revealed_via: 'opening_preview', revealed_turn: 1},
 ]);
 const blob = JSON.stringify(view.seen_roster);
 for (const banned of ['hp', 'energy', 'loadout', 'skill_', 'stats', 'panel', 'talent']) {
  assert.ok(!blob.includes(banned), `已见阵容里混进了隐藏/无关字段：${banned}`);
 }
 // 没有亮明事件 ⇒ **没有这个键**（不是空数组，与「没天气不出现 weather」同口径）
 assert.equal('seen_roster' in publicView(engineResult()), false);
});

test('③ 对手已出招的技能转发（带名字）；没打过就没有这个键', () => {
 const view = publicView(engineResult({revealed: REVEALED}));
 const rows = view.opponent.revealed_skills.pet_000417;
 assert.deepEqual(rows.map((row) => row.skill_id), ['skill_000286']);
 assert.equal(rows[0].name, '水炮', '已出招技能没有名字，页面只能显示 id');
 assert.equal(rows[0].element, '水系');
 assert.equal('revealed_skills' in publicView(engineResult()).opponent, false);
});

test('④ 反向控制：未亮明的后备即使被塞进 id，白名单也必须剥掉，且不许凭空给 seen_roster', () => {
 const result = engineResult();
 result.ui.opponent.bench = [{slot: 1, fainted: false, pet_id: 'pet_000112',
  name: '雪影娃娃', hp: 99, stats: {atk: 1}}];
 const view = publicView(result);
 assert.deepEqual(view.opponent.bench, [{slot: 1, fainted: false}],
  '未亮明的后备不该带身份/血量 —— Node 的白名单被放宽了');
 assert.equal('seen_roster' in view, false, '没有亮明事件却给了已见阵容');
});

test('⑤ 带亮明的回执里同样不许出现私有 state / seed / 对手配招', () => {
 const result = engineResult({revealed: REVEALED});
 result.state = {seed: 12345, _pending_enemy: {kind: 'skill'}};
 const view = publicView(result);
 const blob = JSON.stringify(view);
 for (const banned of ['"_pending', '"state"', '"seed"', '"_pending_enemy"']) {
  assert.ok(!blob.includes(banned), `公开视图里出现了私有状态：${banned}`);
 }
 assert.equal('loadouts' in view.opponent, false, '对手配招不该出现在公开视图里');
 assert.equal(view.cpu_legal_count, 2, '私有域的合法动作条数是既有字段，形状不许变');
});

// ── 冻结要求的两条**反向用例**（Lead 2026-09-30）：白名单那一行是必需的；串局必须 fail closed ──

test('⑥ 反向控制：不传 `openingPreview` ⇒ 请求体里**没有** `opening_preview`（白名单那一行是必需的）', async () => {
 const client = new RocoClient({repoRoot: '.'});
 const payloads = [];
 client._request = async (method, path, payload) => {
  payloads.push({method, path, payload});
  return {ok: false, error: 'stub：这一条只验请求体形状'};
 };
 await client.battleNew({team: ['pet_000225'], seed: 1});
 assert.equal('opening_preview' in payloads.at(-1).payload, false,
  '调用方没传，请求体里却出现了 opening_preview');
 assert.equal(payloads.at(-1).path, '/battle/new');

 await client.battleNew({team: ['pet_000225'], seed: 1, openingPreview: true});
 assert.equal(payloads.at(-1).payload.opening_preview, true,
  '传了 true 却没进请求体 —— `battleNew` 的白名单那一行没生效（静默丢掉）');

 await client.battleNew({team: ['pet_000225'], seed: 1, openingPreview: false});
 assert.equal('opening_preview' in payloads.at(-1).payload, false,
  'false 不该被当成「展示了预览」发出去');
});

/** 假引擎客户端：只实现 service 用到的几个入口，回执形状与真引擎一致。 */
function makeFakeClient({matchId = MATCH} = {}) {
 const calls = {battleNew: [], battleAdvance: []};
 const receipt = (mid) => {
  const row = engineResult();
  row.state = {state_version: row.state_version, events: [], ruleset_config_id: 'legacy_sim_v1'};
  row.match_id = mid;
  if (mid === null) { delete row.match_id; delete row.public.match_id; delete row.ui.match_id; }
  else { row.public.match_id = mid; row.ui.match_id = mid; }
  return row;
 };
 const client = {
  calls,
  nextAdvanceMatchId: matchId,
  startService: async () => ({port: 0}),
  stopService: async () => ({ok: true}),
  health: async () => ({ok: true}),
  battleNew: async (args) => { calls.battleNew.push(args); return {ok: true, result: receipt(matchId)}; },
  battleAdvance: async (args) => {
   calls.battleAdvance.push(args);
   return {ok: true, result: receipt(client.nextAdvanceMatchId)};
  },
 };
 return client;
}

test('⑦ `match_id` 不一致 ⇒ fail closed（409 match_mismatch）；一致才继续；老回执读不到 ⇒ 跳过守卫', async () => {
 const fake = makeFakeClient({matchId: 'm-one'});
 const svc = createRocoService({client: fake});
 const started = await svc.startBattle({team: ['pet_000225', 'pet_000190', 'pet_000445'], seed: 1});
 assert.equal(started.ok, true, started.error);
 assert.equal(started.view.match_id, 'm-one', '开局回执没有转发 match_id');
 assert.equal(fake.calls.battleNew.length, 1);

 // ① 同一个 match_id：正常推进
 fake.nextAdvanceMatchId = 'm-one';
 const ok = await svc.advanceBattle({battle_id: started.battle_id});
 assert.equal(ok.ok, true, ok.error);
 assert.equal(fake.calls.battleAdvance.length, 1);

 // ② 引擎回执变成另一局：**明确拒绝**，不许静默继续（「新局不继承旧局事实」的入口就在这里）
 fake.nextAdvanceMatchId = 'm-two';
 const bad = await svc.advanceBattle({battle_id: started.battle_id});
 assert.equal(bad.ok, false, '串局却成功了');
 assert.equal(bad.status, 409);
 assert.equal(bad.error_type, 'match_mismatch');
 assert.match(bad.error, /对不上/);

 // ③ 老引擎 / 老 fixture 读不到 match_id：**跳过**守卫，不给老协议安一个假守卫
 fake.nextAdvanceMatchId = null;
 const legacy = await svc.advanceBattle({battle_id: started.battle_id});
 assert.equal(legacy.ok, true, legacy.error);

 await svc.stop();
});
