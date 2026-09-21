#!/usr/bin/env node
// W5-04：**判定层与规则到底一不一致**——用真实链路量那个开放问题。
//
// 要回答的两个问题
// ----------------
//   ① 「抑制」是不是等于「规则犯错」？（`docs/roco/W5-04-INTERVENTION-GATE.md` §12.4
//      明确写着「一致性没有被验证过，本文件不声称它成立」。这里把它变成可算的。）
//   ② 规则的 `decisive-gap` 分支在**手游引擎**上到底有没有触发过？
//      若从未触发，那 §12.4 的「两个量同源不同义」还要再强一层：
//      **规则侧根本没有分差可用**。
//
// 口径（判据写在 `docs/roco/W5-04-SUPPRESSION-VS-RULE.md`，跑之前就写好了）
// ----------------------------------------------------------------------
//   · 只走**真实路由**：`/api/roco/battle/new|plan|battle/advance`，
//     plan 对象**原样**交给 `rocoIntervention`，不重排、不捏造；
//   · 每个窗口都用**全新的 session**（`hints:0, lastAt:-Infinity`），
//     避免频率预算/冷却这类与本题无关的门控把窗口吃掉；
//   · 同一窗口分别跑 `ROCO_INTERVENTION_MODEL=off` 与 `=on`，逐字段比较。
//
// 跑法::
//
//     node scripts/roco/check-intervention-agreement.mjs
//     node scripts/roco/check-intervention-agreement.mjs --seeds 12 --turns 8

import {writeFileSync, mkdirSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer} from '../../src/server/index.js';
import {rocoIntervention, rocoPlanFeatures} from '../../src/coach/roco-experience.js';
import {resetInterventionLayer, INTERVENTION_LIMITS} from '../../src/coach/experience.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'reports', 'roco', 'intervention-agreement.json');
//: 规则里那个「明显分差」阈值。它是在**旧演示引擎**的分数尺子上定的。
const REASONABLE_GAP = 5;

const SPOKEN = new Set(['action_hint', 'micro_hint']);

function args(argv) {
  const value = (name, fallback) => {
    const index = argv.indexOf(name);
    return index >= 0 ? Number(argv[index + 1]) : fallback;
  };
  return {seeds: value('--seeds', 10), turns: value('--turns', 8), quiet: argv.includes('--quiet')};
}

function quantile(list, p) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(3));
}

function freshSession() {
  return {hints: 0, lastAt: -Infinity, dismissed: false, said: new Set(),
    readings: new Set(), topics: new Set(), limit: 3};
}

/** 血量比例：判定层的 `risk` 档位就是由它给出的（`situationRisk`）。 */
export function hpRatioOf(view) {
  const pet = view?.self?.pets?.find((p) => p.slot === view.self.active) ?? view?.self?.pets?.[0];
  if (!pet || !(pet.max_hp > 0)) return null;
  return Math.max(0, pet.hp) / pet.max_hp;
}

/** 血量档位 → 规则用的 `risk`（与 `experience.js` 的 `situationRisk` 同档）。 */
export function riskBand(hpRatio) {
  if (hpRatio === null) return null;
  if (hpRatio <= 0.35) return 0.8;
  if (hpRatio <= 0.6) return 0.5;
  return 0.2;
}

function observation({seed, turn, plan, off, on, view, mode = 'fresh', carried = null}) {
  const features = rocoPlanFeatures(plan);
  const hpRatio = hpRatioOf(view);
  const gap = features.gap;
  const risk = riskBand(hpRatio);
  const decisiveByGap = gap !== null && gap > REASONABLE_GAP;
  const decisiveByRisk = risk !== null && risk >= INTERVENTION_LIMITS.criticalRisk;
  return {
    seed, turn, hp_ratio: hpRatio === null ? null : Number(hpRatio.toFixed(4)),
    risk, gap, margin: features.margin,
    phase: off?.gate === null || off?.gate === undefined ? 'scored' : null,
    gate: off?.gate ?? null,
    rule_action: off?.action ?? null,
    rule_reason: off?.reason ?? null,
    rule_decisive: off?.decisive === true,
    decisive_by_gap: decisiveByGap,
    decisive_by_risk: decisiveByRisk,
    layer_action: on?.action ?? null,
    layer_decided_by: on?.layer?.decided_by ?? null,
    layer_suppressed: on?.layer?.suppress === true,
    layer_active: on?.layer?.active === true,
    layer_margin: on?.layer?.margin ?? null,
    // 「规则本来会开口」= 在没有判定层的情况下这一手会出提示。
    rule_speaks: SPOKEN.has(off?.action),
    layer_speaks: SPOKEN.has(on?.action),
    session_mode: mode,
    // 带 session 的两次（同一局里连续推进、频率预算与冷却都生效）：
    // 这才是「玩家一局里到底看到几条提示」的口径。
    carried_rule_action: carried?.off?.action ?? null,
    carried_layer_action: carried?.on?.action ?? null,
    carried_rule_speaks: SPOKEN.has(carried?.off?.action),
    carried_layer_speaks: SPOKEN.has(carried?.on?.action),
    carried_rule_gate: carried?.off?.gate ?? null,
    carried_layer_suppressed: carried?.on?.layer?.suppress === true,
  };
}

export function summarise(rows) {
  const scored = rows.filter((row) => row.gap !== null || row.margin !== null);
  const gaps = scored.map((row) => row.gap).filter((x) => x !== null);
  const margins = scored.map((row) => row.margin).filter((x) => x !== null);
  const quantile = (list, p) => {
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  };
  // 2×2：规则要开口 × 判定层抑制
  const cells = {
    rule_speaks_layer_suppresses: [],   // **分歧格**：层压掉了规则要说的话
    rule_speaks_layer_allows: [],       // 一致：都说
    rule_silent_layer_suppresses: [],   // 一致：都不说（层只是把「本来也不说」又标了一次）
    rule_silent_layer_allows: [],       // 一致：都不说
  };
  for (const row of scored) {
    const key = `${row.rule_speaks ? 'rule_speaks' : 'rule_silent'}_layer_${row.layer_suppressed ? 'suppresses' : 'allows'}`;
    if (cells[key]) cells[key].push(row);
  }
  // 门控挡下的窗口：判定层不该把它们变成提示（S6）
  const gated = rows.filter((row) => row.gate);
  const gated_spoken = gated.filter((row) => SPOKEN.has(row.rule_action) || SPOKEN.has(row.layer_action));
  // S5：「只抑制」——on 档开口集合必须是 off 档的子集
  const violations = scored.filter((row) => row.layer_speaks && !row.rule_speaks);
  const byHpBand = {};
  for (const row of scored) {
    const band = row.hp_ratio === null ? '未知' : row.hp_ratio <= 0.35 ? '≤0.35' : row.hp_ratio <= 0.6 ? '0.35—0.6' : '>0.6';
    const bucket = byHpBand[band] || (byHpBand[band] = {total: 0, rule_speaks: 0, layer_suppresses: 0, disagree: 0});
    bucket.total += 1;
    if (row.rule_speaks) bucket.rule_speaks += 1;
    if (row.layer_suppressed) bucket.layer_suppresses += 1;
    if (row.rule_speaks && row.layer_suppressed) bucket.disagree += 1;
  }
  const carried = scored.filter((row) => row.carried_rule_action !== null || row.carried_layer_action !== null);
  const thresholdCounts = scored.reduce((acc, row) => {
    if (row.margin === null) { acc.margin_null = (acc.margin_null || 0) + 1; return acc; }
    if (row.layer_suppressed) acc.below_threshold = (acc.below_threshold || 0) + 1;
    else acc.at_or_above_threshold = (acc.at_or_above_threshold || 0) + 1;
    return acc;
  }, {});
  return {
    windows: rows.length,
    scored: scored.length,
    margin_vs_threshold: thresholdCounts,
    // 「同一局里连续推进、预算与冷却都生效」的口径：玩家一局真的能看到几条
    carried: {
      n: carried.length,
      rule_speaks: carried.filter((row) => row.carried_rule_speaks).length,
      layer_speaks: carried.filter((row) => row.carried_layer_speaks).length,
      rule_blocked_by_gate: carried.filter((row) => row.carried_rule_gate).length,
    },
    gap: {
      n: gaps.length,
      min: gaps.length ? Number(Math.min(...gaps).toFixed(6)) : null,
      median: quantile(gaps, 0.5),
      p95: quantile(gaps, 0.95),
      max: gaps.length ? Number(Math.max(...gaps).toFixed(6)) : null,
      // 这一条是问题②的答案
      above_reasonable_gap_5: gaps.filter((x) => x > REASONABLE_GAP).length,
      all_zero: gaps.length > 0 && gaps.every((x) => x === 0),
    },
    margin: {
      n: margins.length,
      min: margins.length ? Number(Math.min(...margins).toFixed(6)) : null,
      median: quantile(margins, 0.5),
      p95: quantile(margins, 0.95),
      max: margins.length ? Number(Math.max(...margins).toFixed(6)) : null,
    },
    decisive: {
      by_gap: scored.filter((row) => row.decisive_by_gap).length,
      by_risk: scored.filter((row) => row.decisive_by_risk).length,
      any: scored.filter((row) => row.rule_decisive).length,
    },
    layer: {
      decided_by: scored.reduce((acc, row) => {
        const key = row.layer_decided_by ?? '(未判定)';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      suppressed: scored.filter((row) => row.layer_suppressed).length,
    },
    matrix: Object.fromEntries(Object.entries(cells).map(([key, list]) => [key, list.length])),
    disagreement_by_hp_band: byHpBand,
    // S5
    only_suppresses_violations: violations.length,
    only_suppresses_examples: violations.slice(0, 3).map((row) => ({seed: row.seed, turn: row.turn,
      rule_action: row.rule_action, layer_action: row.layer_action})),
    // S6
    gated_windows: gated.length,
    gated_windows_spoken: gated_spoken.length,
  };
}

async function main() {
  const options = args(process.argv.slice(2));
  const server = createCoachServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rows = [];
  // 门控反证：同一份 view/plan，逐个把五种硬门控打开，判定层**不许**在这些窗口开口。
  // 不构造这些窗口的话，S6 会因为「样本里没有门控」而**空过**——空过不等于通过。
  const gateCases = [];
  const previous = process.env.ROCO_INTERVENTION_MODEL;
  try {
    const bootRes = await fetch(`${base}/api/bootstrap`);
    const boot = await bootRes.json();
    const cookie = bootRes.headers.get('set-cookie') || '';
    const post = (path, data) => fetch(base + path, {method: 'POST', headers: {
      Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
    body: JSON.stringify(data)}).then((r) => r.json());

    // 判定层的**延迟**也一起量：它是产品路径上的一步，报告必须给延迟。
    // 只量 `rocoIntervention` 这一次调用的墙钟（含特征装配 + 逻辑回归推理），
    // 不含模型加载（那是懒加载、只发生一次）。
    const layerMs = [];
    const evaluate = (view, plan, mode, session, host = {}) => {
      process.env.ROCO_INTERVENTION_MODEL = mode;
      resetInterventionLayer();
      const started = performance.now();
      const detail = rocoIntervention({view, session: session ?? freshSession(), plan,
        host: {focus: true, preference: 'gentle', ...host}, now: 1000});
      if (mode === 'on') layerMs.push(performance.now() - started);
      return detail;
    };
    /** 把一次结论写回 session：开口就记一条并更新时间戳（频率预算与冷却是这样生效的）。 */
    const carry = (session, detail, now) => {
      if (SPOKEN.has(detail?.action)) {
        session.hints = (session.hints || 0) + 1;
        session.lastAt = now;
        if (detail?.decisionKey != null) session.said?.add?.(`turn:${detail.decisionKey}`);
      }
      return session;
    };

    let seedsDone = 0;
    for (let index = 0; index < options.seeds; index += 1) {
      const seed = 20260921 + index * 977;
      const started = await post('/api/roco/battle/new', {seed});
      if (!started.ok) continue;
      seedsDone += 1;
      const carriedOff = freshSession();
      const carriedOn = freshSession();
      let current = started;
      for (let turn = 0; turn < options.turns; turn += 1) {
        const view = current.view;
        if (!view || view.battle_result) break;
        if (view.phase === 'battle') {
          const plan = await post('/api/roco/plan', {battle_id: started.battle_id, depth: 2, beam: 4});
          if (plan.ok) {
            const now = 1000 + turn * 1000;
            const offCarried = evaluate(view, plan, 'off', carriedOff, {});
            const onCarried = evaluate(view, plan, 'on', carriedOn, {});
            carry(carriedOff, offCarried, now);
            carry(carriedOn, onCarried, now);
            rows.push(observation({seed, turn: view.turn ?? turn, plan,
              off: evaluate(view, plan, 'off'), on: evaluate(view, plan, 'on'), view,
              mode: 'fresh', carried: {off: offCarried, on: onCarried}}));
            if (turn === 0) {
              // `dismissed` **不在 `host` 上**：`interventionFeaturesOfGame` 读的是
              // `attention.dismissed || session.dismissed`。第一版把它放进 host，
              // 于是门控根本没触发（`gate: null`）而这一格被当成「通过了」——
              // 空过的检查比没有检查更危险，所以每一格都要核对**真的**触发了哪个门控。
              const gates = {
                'window-unfocused': {host: {focus: false}},
                'hint-dismissed': {session: {...freshSession(), dismissed: true}},
                background: {host: {background: true}},
                'not-in-match': {host: {active: false}},
                'explicit-quiet': {host: {preference: 'quiet'}},
              };
              for (const [name, spec] of Object.entries(gates)) {
                const offGated = evaluate(view, plan, 'off', spec.session ?? null, spec.host ?? {});
                const onGated = evaluate(view, plan, 'on', spec.session ? {...spec.session} : null, spec.host ?? {});
                gateCases.push({seed, gate_expected: name, gate: offGated.gate ?? null,
                  off_action: offGated.action, on_action: onGated.action,
                  off_speaks: SPOKEN.has(offGated.action), on_speaks: SPOKEN.has(onGated.action)});
              }
            }
          }
        } else {
          // 补位回合没有 plan（规划器只在 battle 阶段有意义），但它的**门控**仍然要记账。
          rows.push({seed, turn: view.turn ?? turn, hp_ratio: hpRatioOf(view), risk: riskBand(hpRatioOf(view)),
            gap: null, margin: null, phase: view.phase, gate: evaluate(view, null, 'off').gate ?? null,
            rule_action: evaluate(view, null, 'off').action ?? null, rule_reason: null, rule_decisive: false,
            decisive_by_gap: false, decisive_by_risk: false, layer_action: evaluate(view, null, 'on').action ?? null,
            layer_decided_by: null, layer_suppressed: false, layer_active: false, layer_margin: null,
            rule_speaks: SPOKEN.has(evaluate(view, null, 'off').action), layer_speaks: false});
        }
        const advanced = await post('/api/roco/battle/advance', {battle_id: started.battle_id, auto: true});
        if (!advanced.ok) break;
        current = advanced;
      }
    }
    const summary = summarise(rows);
    const report = {
      generated_by: 'scripts/roco/check-intervention-agreement.mjs',
      preregistration: 'docs/roco/W5-04-SUPPRESSION-VS-RULE.md',
      latency: {
        note: 'rocoIntervention 一次调用的墙钟（含特征装配与逻辑回归推理，不含模型加载）',
        n: layerMs.length,
        p50_ms: quantile(layerMs, 0.5),
        p95_ms: quantile(layerMs, 0.95),
        max_ms: layerMs.length ? Number(Math.max(...layerMs).toFixed(3)) : null,
      },
      settings: {seeds: options.seeds, seeds_started: seedsDone, turns: options.turns,
        reasonable_gap: REASONABLE_GAP, critical_risk: INTERVENTION_LIMITS.criticalRisk,
        session: '每个窗口都是全新 session（hints 0 / lastAt -Infinity）'},
      question: ('① 「抑制」是否等于「规则犯错」？② 规则的 decisive-gap 分支在手游引擎上'
        + '有没有触发过？'),
      summary,
      gate_cases: {
        total: gateCases.length,
        // 门控必须**真的**被触发，而且两边都不许开口
        gate_matched: gateCases.filter((c) => c.gate === c.gate_expected).length,
        spoken_under_gate: gateCases.filter((c) => c.off_speaks || c.on_speaks).length,
        failures: gateCases.filter((c) => c.off_speaks || c.on_speaks || c.gate !== c.gate_expected),
        detail: gateCases.slice(0, 20),
      },
      rows,
    };
    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
    process.stdout.write(`${JSON.stringify({summary, written_to: OUT}, null, 1)}\n`);
  } finally {
    if (previous === undefined) delete process.env.ROCO_INTERVENTION_MODEL;
    else process.env.ROCO_INTERVENTION_MODEL = previous;
    resetInterventionLayer();
    server.closeAllConnections?.();
    server.close();
  }
  return 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main().then((code) => process.exit(code)).catch((error) => {
    process.stderr.write(`[intervention-agreement] ${error?.stack || error}\n`);
    process.exit(1);
  });
}
