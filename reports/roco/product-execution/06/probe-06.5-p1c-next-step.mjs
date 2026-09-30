/**
 * P1-C（task-45）只读复核探针：「下一局练一件事」为什么会空。
 *
 * 要证的两件事：
 *   ① **空的成因是规则表不覆盖**，不是数据没到 —— 同一份输入里 `facts` 明明有换人/伤害/补位；
 *   ② 规则表三条（全是「挑错」）在「换宠打出显著伤害后投降」这类正面/中性局面上**一条都不中**。
 *
 * 输入：`raw-06.1-timeline.json` 的三局真引擎读数（复用 06.1 的产物）+ 一个**手搓**的
 * 「换宠 → 288 伤害 → 投降」夹具（事件形状照 `env.py` 的 `_bump`，逐字段核过）。
 *
 * 用法（仓库根）：node reports/roco/product-execution/06/probe-06.5-p1c-next-step.mjs
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import {publicView} from '../../../../src/server/roco-service.js';
import {rocoGameView, rocoMatchReview, rocoMatchDepth} from '../../../../src/coach/roco-experience.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(HERE, 'raw-06.1-timeline.json'), 'utf8'));

const out = {runs: [], synthetic: {}, rule_table: {}};

// ── ① 三局真引擎读数：next_step 有没有、facts 里有没有料 ──────────────────────
for (const [name, run] of Object.entries(raw.runs)) {
  if (!run?.steps?.length || !run?.views) continue;
  const events = run.steps.flatMap((s) => s.events ?? []);
  const finalView = publicView(run.views.final);
  const lastLive = run.views.last_live ? publicView(run.views.last_live) : null;
  const depth = rocoMatchDepth({
    events, game: rocoGameView(lastLive ?? finalView, {matchId: finalView?.match_id ?? null}),
    turns: finalView?.turn ?? null, skills: null,
  });
  const {review} = rocoMatchReview({
    matchId: finalView?.match_id ?? null, finalView, lastLiveView: lastLive,
    events, turns: finalView?.turn ?? null, result: finalView?.battle_result ?? null, memory: null,
  });
  const row = [review?.learning ? `这一局学到一件事：${review.learning}` : '', depth?.next_step?.text ?? null]
    .filter(Boolean).join(' ');
  out.runs.push({
    run: name,
    events: events.length,
    result: finalView?.battle_result ?? null,
    review_null: review === null,
    review_learning: review?.learning ?? null,
    next_step_rule: depth?.next_step?.rule ?? null,
    next_step_text: depth?.next_step?.text ?? null,
    row_text_length: row.length,
    // 「数据到没到」的证据：这些都是 depth 自己算出来的账
    data: depth?.counts ?? null,
    player_max_blow: Math.max(0, ...events.filter((e) => e?.kind === 'damage' && e?.detail?.side === 'player')
      .map((e) => Number(e.detail.damage) || 0)),
    player_switches: events.filter((e) => e?.kind === 'switch' && e?.detail?.side === 'player').length,
  });
}

// ── ② 手搓夹具：换宠 → 288 伤害 → 投降（lead-mac 报的那一局形状）─────────────
const view = {
  schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', state_version: 20, turn: 3, phase: 'ended',
  match_id: 'm-p1c', rules_version: 'roco-world-s4-2026-09-10/mobile_s4_candidate_v3',
  decision_id: 'm-p1c:v20', battle_result: 'escaped',
  self: {active: 1, energy_max: 10, energy_charge: 5, pets: [
    {slot: 0, pet_id: 'pet_000001', name: '喵喵', hp: 180, max_hp: 300, energy: 3, fainted: false, statuses: {}},
    {slot: 1, pet_id: 'pet_000002', name: '水蓝蓝', hp: 120, max_hp: 300, energy: 4, fainted: false, statuses: {}},
  ], skills: [], loadouts: {}, magic: null},
  opponent: {active: 0, living_count: 2, energy_max: 10, energy_charge: 5,
    field: {slot: 0, pet_id: 'pet_000007', name: '魔力猫', hp: 40, max_hp: 300, energy: 3, fainted: false, statuses: {}},
    bench: [{slot: 1, fainted: false}]},
  legal: [{kind: 'skill', label: '甩水', skill_id: 'skill_000418'}],
};
const events = [
  {seq: 0, turn: 1, kind: 'turn_start', text: '第 1 回合开始。', detail: {}},
  {seq: 1, turn: 1, kind: 'switch', text: '我方换上了水蓝蓝。', detail: {side: 'player', to_slot: 1}},
  {seq: 2, turn: 1, kind: 'damage', text: '魔力猫受到 288 伤害。', detail: {side: 'player', target_slot: 0, damage: 288, type_multiplier: 1, skill_id: 'skill_000418'}},
  {seq: 3, turn: 2, kind: 'damage', text: '水蓝蓝受到 30 伤害。', detail: {side: 'enemy', target_slot: 1, damage: 30, type_multiplier: 1}},
  {seq: 4, turn: 2, kind: 'escape', text: '我方撤退。', detail: {side: 'player'}},
];
const depthSyn = rocoMatchDepth({events, game: rocoGameView(view, {matchId: 'm-p1c'}), turns: 3, skills: null});
const {review: reviewSyn} = rocoMatchReview({
  matchId: 'm-p1c', finalView: view, lastLiveView: view, events, turns: 3, result: 'escaped', memory: null,
});
const rowSyn = [reviewSyn?.learning ? `这一局学到一件事：${reviewSyn.learning}` : '', depthSyn?.next_step?.text ?? null]
  .filter(Boolean).join(' ');
out.synthetic = {
  events: events.length,
  fact_groups: (depthSyn?.facts ?? []).map((f) => f.id),
  data_present: {
    player_switches: depthSyn?.counts?.player_switches ?? null,
    heaviest_blow_text: (depthSyn?.facts ?? []).find((f) => f.id === 'heaviest-blow')?.text ?? null,
  },
  next_step_rule: depthSyn?.next_step?.rule ?? null,
  next_step_text: depthSyn?.next_step?.text ?? null,
  review_null: reviewSyn === null,
  review_goal: reviewSyn?.goal ?? null,
  review_learning: reviewSyn?.learning ?? null,
  // 页面那一栏实际会写进去什么（两条分支的取值口径与 roco.js 一致）
  row_text_review_branch: rowSyn,
  row_empty_review_branch: rowSyn.length === 0,
  row_text_fallback_branch: depthSyn?.next_step?.text ?? '',
  row_empty_fallback_branch: !(depthSyn?.next_step?.text ?? ''),
};

// ── ③ 规则表逐条：命中条件 + 在该夹具下中不中 ────────────────────────────────
const factList = (depthSyn?.facts ?? []).map((f) => f.id);
out.rule_table = {
  order: ['enemy-type-advantage-hit', 'our-resist-repeat', 'enemy-replacement-first'],
  hits_on_synthetic: {
    'enemy-type-advantage-hit': events.some((e) => e.kind === 'damage' && e.detail?.side === 'enemy' && Number(e.detail?.type_multiplier) > 1),
    'our-resist-repeat': false,
    'enemy-replacement-first': events.some((e) => e.kind === 'replacement' && e.detail?.side === 'enemy'),
  },
  facts_available: factList,
};
console.log(JSON.stringify(out, null, 1));
