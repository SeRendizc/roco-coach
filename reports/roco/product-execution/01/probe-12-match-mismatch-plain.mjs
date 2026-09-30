// task-10 读数：`matchMismatch` 的**句子**是否人话 + **结构化字段**是否仍带得出内部 id。
//
// 运行（仓库根）：node reports/roco/product-execution/01/probe-12-match-mismatch-plain.mjs
// 产出：raw-match-mismatch.json

import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createRocoService} from '../../../../src/server/roco-service.js';
import {ENGINEER_TONE_WORDS, BANNED_WORDS} from '../../../../src/coach/plain-words.js';

const here = dirname(fileURLToPath(import.meta.url));

function fakeClient({matchId = 'm-one'} = {}) {
 const receipt = (mid, rules) => ({
  state_version: 3, turn: 2, phase: 'battle', result: null,
  rules_version: rules,
  ...(mid === null ? {} : {match_id: mid}),
  state: {state_version: 3, events: [], ruleset_config_id: 'legacy_sim_v1'},
  public: {schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10',
   ruleset_config_id: 'legacy_sim_v1', state_version: 3, turn: 2, phase: 'battle',
   result: null, unverified_overrides: [],
   ...(mid === null ? {} : {match_id: mid, rules_version: rules}),
   self: {active: 0, items: {}, loadouts: {}, pets: []},
   opponent: {active: 0, living_count: 1, field: null, bench: []}, assumptions: {}},
  ui: {schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 3, turn: 2,
   phase: 'battle', result: null, unverified_overrides: [],
   self: {active: 0, energy_max: 10, energy_charge: 5, pets: [], skills: []},
   opponent: {active: 0, living_count: 1, energy_max: 10, energy_charge: 5, field: null, bench: []},
   legal: {player: []}, notes: {unverified_overrides: []}},
  legal: {player: [], enemy: []}, events: [], strategy: {name: 'greedy_damage', version: 1},
  needs_replacement: [], unsupported_seen: [],
 });
 const client = {
  nextMatchId: matchId,
  nextRules: 'roco-world-s4-2026-09-10/legacy_sim_v1',
  startService: async () => ({port: 0}),
  stopService: async () => ({ok: true}),
  battleNew: async () => ({ok: true, result: receipt(matchId, 'roco-world-s4-2026-09-10/legacy_sim_v1')}),
  battleAdvance: async () => ({ok: true, result: receipt(client.nextMatchId, client.nextRules)}),
 };
 return client;
}

const jargon = (text) => ({
 hard: BANNED_WORDS.filter((word) => String(text).includes(word)),
 soft: ENGINEER_TONE_WORDS.filter((word) => String(text).includes(word)),
});

async function mismatchResponse({engineMatchId, engineRules, bound = 'm-one'}) {
 const fake = fakeClient({matchId: bound});
 const svc = createRocoService({client: fake});
 const started = await svc.startBattle({team: ['pet_000225', 'pet_000190', 'pet_000445'], seed: 1});
 if (!started.ok) throw new Error(`startBattle 失败：${started.error}`);
 fake.nextMatchId = engineMatchId;
 if (engineRules) fake.nextRules = engineRules;
 const res = await svc.advanceBattle({battle_id: started.battle_id});
 await svc.stop();
 return res;
}

const cases = {
 same_match: await mismatchResponse({engineMatchId: 'm-one'}),
 other_match: await mismatchResponse({engineMatchId: 'm-two'}),
 other_rules: await mismatchResponse({engineMatchId: 'm-one', engineRules: 'roco-world-s4-2026-09-10/legacy_sim_v1-changed'}),
 legacy_no_match_id: await mismatchResponse({engineMatchId: null}),
};

const summary = {
 same_match_ok: cases.same_match.ok === true,
 other_match: {
  ok: cases.other_match.ok, status: cases.other_match.status,
  error_type: cases.other_match.error_type, error: cases.other_match.error,
  error_context: cases.other_match.error_context ?? null,
  jargon: jargon(cases.other_match.error ?? ''),
  mentions_raw_ids: ['m-one', 'm-two'].some((id) => String(cases.other_match.error ?? '').includes(id)),
 },
 other_rules: {
  ok: cases.other_rules.ok, status: cases.other_rules.status,
  error_type: cases.other_rules.error_type, error: cases.other_rules.error,
  error_context: cases.other_rules.error_context ?? null,
  jargon: jargon(cases.other_rules.error ?? ''),
 },
 legacy_no_match_id: {ok: cases.legacy_no_match_id.ok,
  note: '老引擎/老 fixture 读不到 match_id ⇒ 跳过守卫（不假装知道）'},
};

writeFileSync(join(here, 'raw-match-mismatch.json'),
 JSON.stringify({summary, raw: cases}, null, 1) + '\n', 'utf8');
console.log(JSON.stringify(summary, null, 1));
console.log('WROTE raw-match-mismatch.json');
