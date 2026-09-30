/**
 * 06.2 只读探针（task-14 勘察）：复盘结论对「当时信息 / 以后发生的事」的敏感性。
 *
 * 用**真代码**：`src/server/roco-service.js` 的 `publicView`（真白名单）、
 * `src/coach/roco-experience.js` 的 `rocoGameView` / `rocoMatchReview`、
 * `src/coach/teacher-review.js` 的 `reviewMatch`。
 * 输入是 `probe-06.1-timeline.py` 用真引擎跑出来的三局（`raw-06.1-timeline.json`）。
 *
 * 四组读数：
 *   E1 现网口径：整局事件 + 逐回合合法表（**按回合号后写覆盖**，照 `src/client/roco.js:4220`）⇒ 一份复盘；
 *   E2 **必做反例**「固定当时信息、只改以后发生的事 ⇒ 复盘结论不变」：把事件截到锚点回合**之前**
 *      （前缀与原局逐字节相同、玩家那一手与原局相同），看结论是不是同一份；
 *   E3 两向变异：① 只改**决策前**的事实（插入一次回复药 / 加大一次伤害）⇒ 结论**必须变**；
 *      ② 只改**终局结果**（win/loss/draw/escaped）⇒ 结论**不许**跟着变（06 通过条件「四类结局均不倒推胜负」）；
 *   E4 逐回合合法表被补位阶段覆盖的**用户可见影响**：同一份输入，只换 legalByTurn 的合并口径。
 *
 * 产出 `raw-06.2-review-invariance.json`。用法（仓库根）：
 *   node reports/roco/product-execution/06/probe-06.2-review-invariance.mjs
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import {publicView} from '../../../../src/server/roco-service.js';
import {rocoGameView, rocoMatchReview} from '../../../../src/coach/roco-experience.js';
import {reviewMatch, teacherMatchFacts} from '../../../../src/coach/teacher-review.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw-06.1-timeline.json');
const OUT = join(HERE, 'raw-06.2-review-invariance.json');
const raw = JSON.parse(readFileSync(RAW, 'utf8'));

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** 照 `src/client/roco.js:4212-4234` 的口径攒：整局事件 + 按回合号**后写覆盖**的合法表。 */
function clientAccumulate(run, {legalMerge = 'last-write-wins'} = {}) {
  const events = [];
  const legalByTurn = {};
  for (const step of run.steps) {
    events.push(...(step.events ?? []));
    const turn = step.turn;
    if (Number.isInteger(turn) && Array.isArray(step.legal) && step.legal.length) {
      if (legalMerge === 'first-write-wins' && legalByTurn[turn]) continue;
      legalByTurn[turn] = step.legal;
    }
  }
  return {events, legalByTurn};
}

function reviewOf(run, {events, legalByTurn, view, result, turns, memory = null}) {
  const finalView = publicView(view ?? run.views.final);
  const lastLiveView = view ? finalView : publicView(run.views.last_live);
  const out = rocoMatchReview({
    matchId: finalView?.match_id ?? null,
    finalView,
    lastLiveView,
    events,
    turns: turns ?? finalView?.turn ?? null,
    result: result === undefined ? (finalView?.battle_result ?? null) : result,
    memory,
    legalByTurn,
  });
  return {finalView, lastLiveView, review: out.review, progress: out.progress};
}

/** 只看「对这一次决策的判断」那一组字段（正文与依据另算）。 */
function verdict(review) {
  if (!review) return null;
  return {
    goal: review.goal ?? null,
    check_turn: review.check?.turn ?? null,
    check_situation: review.check?.situation ?? null,
    check_handling: review.check?.handling ?? null,
    tp_turn: review.turning_point?.turn ?? null,
    tp_rule: review.turning_point?.rule ?? null,
    mistake_available: review.mistake_available === true,
    teaching_a_mistake: review.teaching_a_mistake === true,
    alt_claimed: review.alternative?.claimed === true,
    alt_source: review.alternative?.source ?? null,
    alt_skipped: review.alternative?.skipped ?? null,
    alt_unknown: review.alternative?.unknown ?? null,
    alt_menu_n: Array.isArray(review.alternative?.menu) ? review.alternative.menu.length : null,
    outcome_category: review.outcome?.category ?? null,
    text: review.text ?? null,
  };
}

const sameVerdict = (a, b) => JSON.stringify([a?.goal, a?.check_turn, a?.check_handling, a?.tp_turn, a?.tp_rule])
  === JSON.stringify([b?.goal, b?.check_turn, b?.check_handling, b?.tp_turn, b?.tp_rule]);

const out = {source: 'raw-06.1-timeline.json', digest_of_source: digest(raw), experiments: {}};

// ── E1 现网口径（base 局）────────────────────────────────────────────────────
const base = raw.runs.base;
const acc = clientAccumulate(base);
const e1 = reviewOf(base, acc);
const anchorTurn = e1.review?.check?.turn ?? e1.review?.turning_point?.turn ?? null;
out.experiments.E1 = {
  what: '现网口径：整局事件 + 按回合号后写覆盖的合法表',
  events_n: acc.events.length,
  legal_turns: Object.keys(acc.legalByTurn).map(Number).sort((a, b) => a - b),
  legal_n_by_turn: Object.fromEntries(Object.entries(acc.legalByTurn).map(([t, rows]) => [t, rows.length])),
  anchor_turn: anchorTurn,
  verdict: verdict(e1.review),
  student_view: e1.review ? {
    learning: e1.review.learning ?? null,
    evidence: e1.review.evidence ?? [],
  } : null,
};

// ── E2 必做反例：固定当时信息（截到锚点回合**之前**），只改以后发生的事 ──────
{
  const prefixEvents = anchorTurn === null ? [] : acc.events.filter((e) => Number.isInteger(e?.turn) && e.turn < anchorTurn);
  const prefixLegal = anchorTurn === null ? {} : Object.fromEntries(
    Object.entries(acc.legalByTurn).filter(([turn]) => Number(turn) < anchorTurn));
  const anchorView = base.views.anchor ?? base.views.last_live;
  const then = reviewOf(base, {
    events: prefixEvents, legalByTurn: prefixLegal, view: anchorView,
    result: null, turns: anchorTurn === null ? 0 : anchorTurn - 1,
  });
  const prefixOfFull = acc.events.slice(0, prefixEvents.length);
  out.experiments.E2 = {
    what: '必做反例：固定当时信息（事件截到锚点回合之前，前缀逐字节相同）⇒ 结论应当不变',
    anchor_turn: anchorTurn,
    prefix_events_n: prefixEvents.length,
    prefix_identical_to_full_head: digest(prefixOfFull) === digest(prefixEvents),
    prefix_digest: digest(prefixEvents),
    then_only_verdict: verdict(then.review),
    full_match_verdict: verdict(e1.review),
    conclusion_invariant: sameVerdict(then.review ? verdict(then.review) : null, verdict(e1.review)),
  };
}

// ── E2b/E2c 更严格的反例：保留全部事件，**只改锚点之后的那一件事实** ──────────
{
  const full = verdict(e1.review);
  // ② 改「以后」且正是判据用的那一件：锚点回合之后的第一次我方「打在抵抗上」⇒ 改成中性
  const laterResist = acc.events.find((e) => e?.kind === 'damage' && (e?.detail?.side ?? '') === 'player'
    && Number.isFinite(e?.detail?.type_multiplier) && e.detail.type_multiplier < 1
    && Number.isInteger(e?.turn) && e.turn > (anchorTurn ?? 0));
  const neutralized = laterResist
    ? acc.events.map((e) => (e === laterResist ? {...e, detail: {...e.detail, type_multiplier: 1}} : e))
    : acc.events;
  const afterNeutralize = reviewOf(base, {...acc, events: neutralized});
  // ③ 对照：只改一件与任何判据都无关的「以后」事实（第 20 回合的回能数值）
  const unrelated = acc.events.map((e) => (e?.kind === 'energy_gain' && e?.turn === 20
    ? {...e, detail: {...e.detail, amount: (e.detail?.amount ?? 0) + 7}} : e));
  const afterUnrelated = reviewOf(base, {...acc, events: unrelated});
  out.experiments.E2b = {
    what: '必做反例（严格版）：保留整局，只把**锚点之后**那次抵抗改成中性 ⇒ 对锚点那一手的判断应当不变',
    anchor_turn: anchorTurn,
    mutated_event: laterResist ? {turn: laterResist.turn, kind: laterResist.kind,
      from_multiplier: laterResist.detail.type_multiplier, to_multiplier: 1} : null,
    before: full,
    after: verdict(afterNeutralize.review),
    verdict_changed: !sameVerdict(full, verdict(afterNeutralize.review)),
  };
  out.experiments.E2c = {
    what: '对照：只改一件与判据无关的「以后」事实（第 20 回合回能 +7）⇒ 判断应当不变',
    before: full,
    after: verdict(afterUnrelated.review),
    verdict_changed: !sameVerdict(full, verdict(afterUnrelated.review)),
  };
  // ④ 只改锚点那一手自己的结算（同回合的伤害倍率）⇒ 判断**必须**变（非恒等对照）
  const anchorBlow = acc.events.find((e) => e?.kind === 'damage' && (e?.detail?.side ?? '') === 'player'
    && Number.isFinite(e?.detail?.type_multiplier) && e.detail.type_multiplier < 1
    && e?.turn === anchorTurn);
  const anchorChanged = anchorBlow
    ? acc.events.map((e) => (e === anchorBlow ? {...e, detail: {...e.detail, type_multiplier: 1}} : e))
    : acc.events;
  out.experiments.E2d = {
    what: '非恒等对照：把**锚点回合**那次抵抗改成中性 ⇒ 判断必须变（否则这一层是死的）',
    anchor_turn: anchorTurn,
    mutated_event: anchorBlow ? {turn: anchorBlow.turn, from_multiplier: anchorBlow.detail.type_multiplier} : null,
    after: verdict(reviewOf(base, {...acc, events: anchorChanged}).review),
    verdict_changed: !sameVerdict(full, verdict(reviewOf(base, {...acc, events: anchorChanged}).review)),
  };
}

// ── E3 两向变异 ─────────────────────────────────────────────────────────────
{
  // ① 只改**决策前**的事实：锚点回合之前插入一次「我方用了回复药、回了 60 血」
  const heal = {kind: 'item', turn: Math.max(1, (anchorTurn ?? 2) - 1), seq: -1,
    detail: {side: 'player', item: '回复药', healed: 60},
    text: '（探针注入）我方使用了回复药。'};
  const withHeal = [heal, ...acc.events];
  const healed = reviewOf(base, {...acc, events: withHeal});
  // 再一条：把决策前的一次我方承伤加大（改的是「当时」能看见的血线）
  const hurt = acc.events.map((e) => (e?.kind === 'damage' && (e?.detail?.side ?? '') === 'enemy'
    && Number.isInteger(e?.turn) && e.turn < (anchorTurn ?? 0)
    ? {...e, detail: {...e.detail, damage: (e.detail?.damage ?? 0) + 40}} : e));
  const harder = reviewOf(base, {...acc, events: hurt});
  out.experiments.E3a = {
    what: '两向变异①：只改决策前的事实 ⇒ 判断**必须**跟着变（否则判据是空的）',
    injected_heal_verdict: verdict(healed.review),
    increased_pre_damage_verdict: verdict(harder.review),
    changed_by_heal: !sameVerdict(verdict(healed.review), verdict(e1.review)),
    changed_by_pre_damage: !sameVerdict(verdict(harder.review), verdict(e1.review)),
  };
  // ② 只改终局结果（四类）：结论不许跟着变
  const byResult = {};
  for (const result of ['win', 'loss', 'draw', 'escaped']) {
    byResult[result] = verdict(reviewOf(base, {...acc, result}).review);
  }
  const goals = [...new Set(Object.values(byResult).map((v) => `${v?.goal}|${v?.check_handling}|${v?.tp_turn}`))];
  out.experiments.E3b = {
    what: '两向变异②：只改终局结果（win/loss/draw/escaped）⇒ 判断不许跟着变',
    by_result: byResult,
    distinct_judgements: goals.length,
    verdict_stable_across_results: goals.length === 1,
  };
}

// ── E4 合法表合并口径的用户可见影响 ────────────────────────────────────────
{
  const firstWins = clientAccumulate(base, {legalMerge: 'first-write-wins'});
  const a = reviewOf(base, acc);
  const b = reviewOf(base, firstWins);
  out.experiments.E4 = {
    what: '同一份输入、只换 legalByTurn 的合并口径（后写覆盖 vs 首写保留）',
    anchor_turn: anchorTurn,
    last_write_wins: {...verdict(a.review), alternative_full: a.review?.alternative ?? null},
    first_write_wins: {...verdict(b.review), alternative_full: b.review?.alternative ?? null},
    differs: JSON.stringify(verdict(a.review)?.alt_menu_n) !== JSON.stringify(verdict(b.review)?.alt_menu_n)
      || JSON.stringify(a.review?.alternative ?? null) !== JSON.stringify(b.review?.alternative ?? null),
  };
  // E4b：锚点落在**碰撞回合**（同一回合既有出招表又有补位表）时的两套读数
  const collisionTurns = Object.keys(raw.turn_collisions_base ?? {}).map(Number).sort((x, y) => x - y);
  const cTurn = collisionTurns[0] ?? null;
  if (cTurn !== null) {
    // 截到碰撞回合那一回合**结算之后**（含倒地事件），让「先吃药」这一课有局面可讲
    const upto = acc.events.filter((e) => Number.isInteger(e?.turn) && e.turn <= cTurn);
    const legalAll = Object.fromEntries(Object.entries(acc.legalByTurn).filter(([t]) => Number(t) <= cTurn));
    const legalFirst = Object.fromEntries(
      Object.entries(firstWins.legalByTurn).filter(([t]) => Number(t) <= cTurn));
    const view = base.views.anchor ?? base.views.last_live;
    const ra = reviewOf(base, {events: upto, legalByTurn: legalAll, view, turns: cTurn});
    const rb = reviewOf(base, {events: upto, legalByTurn: legalFirst, view, turns: cTurn});
    out.experiments.E4b = {
      what: '锚点落在碰撞回合（该回合 battle 表被 replace 表覆盖）时的两套读数',
      collision_turn: cTurn,
      last_write_wins: {verdict: verdict(ra.review), alternative: ra.review?.alternative ?? null,
                        legal_used: legalAll[cTurn]?.length ?? null},
      first_write_wins: {verdict: verdict(rb.review), alternative: rb.review?.alternative ?? null,
                         legal_used: legalFirst[cTurn]?.length ?? null},
      text_differs: (ra.review?.text ?? null) !== (rb.review?.text ?? null),
    };
  }
}

// ── E5 两局对照：前缀（含第 3 回合出招决策）逐位相同、之后分叉 ──────────────
{
  const div = raw.runs.replace_diverged;
  const accDiv = clientAccumulate(div);
  const e5 = reviewOf(div, accDiv);
  const pair = raw.pairs['base-vs-replace_diverged'];
  out.experiments.E5 = {
    what: '同一 seed/同一队伍：只把第 3 回合**补位**那一手换成另一只（前缀逐位相同）',
    pair,
    base_verdict: verdict(e1.review),
    diverged_verdict: verdict(e5.review),
    conclusion_invariant: sameVerdict(verdict(e1.review), verdict(e5.review)),
    base_events_n: acc.events.length,
    diverged_events_n: accDiv.events.length,
  };
}

// ── 附：事实层读数（用于报告里逐条核对）────────────────────────────────────
out.facts = {
  history_row_keys: base.history_row_keys,
  private_serialize_keys: base.private_serialize_keys,
  turn_collisions: raw.turn_collisions_base,
  derived_check: raw.derived_check_base,
  player_faint_step: raw.player_faint_step,
  opening_preview_revealed: raw.opening_preview_revealed,
  base_teacher_facts: (() => {
    const f = teacherMatchFacts({events: acc.events});
    return {
      faints: f.faints, items: f.items, switches_n: f.switches.length,
      first_player_faint: f.faints.find((x) => x.side === 'player') ?? null,
    };
  })(),
};

writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`, 'utf8');
console.log(`OUT=${OUT}`);
console.log(`E1 anchor_turn=${out.experiments.E1.anchor_turn} goal=${out.experiments.E1.verdict?.goal} handling=${out.experiments.E1.verdict?.check_handling}`);
console.log(`E2 invariant=${out.experiments.E2.conclusion_invariant} then_only=${JSON.stringify(out.experiments.E2.then_only_verdict && {
  goal: out.experiments.E2.then_only_verdict.goal, handling: out.experiments.E2.then_only_verdict.check_handling})}`);
console.log(`E2b later_fact_changed_verdict=${out.experiments.E2b.verdict_changed} E2c unrelated_changed=${out.experiments.E2c.verdict_changed} E2d anchor_changed=${out.experiments.E2d.verdict_changed}`);
console.log(`E3a changed_by_heal=${out.experiments.E3a.changed_by_heal} changed_by_pre_damage=${out.experiments.E3a.changed_by_pre_damage}`);
console.log(`E3b distinct_judgements=${out.experiments.E3b.distinct_judgements}`);
console.log(`E4 differs=${out.experiments.E4.differs} E4b text_differs=${out.experiments.E4b?.text_differs}`);
console.log(`E5 invariant=${out.experiments.E5.conclusion_invariant} diverged_goal=${out.experiments.E5.diverged_verdict?.goal}`);
