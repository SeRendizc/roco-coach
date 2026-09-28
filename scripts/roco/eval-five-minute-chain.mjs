#!/usr/bin/env node
/**
 * RC-801 ② + ③：**五分钟 Demo 的端到端链路**（盒子 → 比较 → 锁定 → 补队 → 战斗 → 主动提示 →
 * 展开取舍 → 局末教学）与它的**时间预算判据**。
 *
 * 为什么要有这一个脚本（RC-801 台账原话）：「这条路径的每一段都各自有验收（盒子 22 条、工坊 42 条、
 * UX 39 条、demo 119 条），但**没有任何一条**量过『从盒子走到配队』」；第 1 段（锁定进交接）已经
 * 进门禁，**还差**的是「局末教学段在这一条链路上的端到端证据」与「『五分钟』这条时间预算的判据
 * （目前只判步骤到位、不判耗时）」。
 *
 * ── 判的是什么（以及**不**判什么）────────────────────────────────────────────
 *   · 判：**机器能走完这条路**，且真键鼠走完的墙钟耗时（含引擎往返、真导航、真点候选池、
 *     真打到局末）≤ 300s；每一步各自也有预算，一步吃掉全部预算同样红。
 *   · 判：**主动提示**是自己冒出来的（这一段之前脚本没有点过小芽、没有点过提示按钮），
 *     并且带「依据：」；**展开取舍**展开后有正文；**局末教学**的正文非空、带「依据：」，
 *     且转折回合来自引擎的 `view.turn`（不是页面自己编的）。
 *   · **不**判：人类读字的时间。机器没有阅读时间，所以这里的 300s 是**下界**：
 *     机器路径都要超过 300s 时，人类一定超；机器路径在预算内说明往返与渲染的固定成本吃得下，
 *     剩下的余量留给阅读。这条口径写在报告里（`framing`），不偷偷当成人机等价。
 *
 * 红线：本脚本**一个数字都不自己算** —— 回合数、结算结果、伤害、事件全部读引擎公开回执
 * （`window.rocoDemo.state.view` / `state.matchEvents`）；读不到就如实记「读不到」（算红）。
 *
 * 用法：
 *   node scripts/roco/eval-five-minute-chain.mjs                 # 自起一个**离线** app server（门禁用这条）
 *   node scripts/roco/eval-five-minute-chain.mjs --selftest-only # 只跑判据自检 + 反证，不开浏览器
 *   node scripts/roco/eval-five-minute-chain.mjs --shots         # 落截图到 reports/roco/five-minute-chain/
 *   node scripts/roco/eval-five-minute-chain.mjs --base=http://127.0.0.1:8765   # 量真在跑的那个演示服务
 *
 * 两种模式：默认**自起进程内服务**（`createCoachServer`，端口 0，网络出口直接抛错 ⇒ 没有模型臂），
 * 与门禁里别的浏览器套件同一手法；给 `--base=`（或 `ROCO_BASE`）时才量外部的演示服务（那台可能带模型臂）。
 * 报告里 `facts.mode` 写明量的是哪一种 —— 两种数不混着说。
 */
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'reports', 'roco', 'five-minute-chain');
const REPORT = join(ROOT, 'reports', 'roco', 'five-minute-chain.json');
const argv = process.argv.slice(2);
const argOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
// 外部服务（`--base=` / `ROCO_BASE`）给定时量它；否则自起一个**离线**进程内服务（门禁走这条）。
const EXTERNAL_BASE = (argOf('base') ?? process.env.ROCO_BASE ?? '').replace(/\/$/, '') || null;
const WANT_SHOTS = argv.includes('--shots');
const SELFTEST_ONLY = argv.includes('--selftest-only');
const CHROME = process.env.CHROME_BIN
  ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p)) ?? null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(...parts);
const oneLine = (value, max = 200) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

// ── 预算：每一步各自的预算 + 全局 300s ─────────────────────────────────────
// 每一步的预算是**从上一段结束到这一段结束**的墙钟，逐段相加 = 300s（与总预算同源，
// 所以「总耗时 ≤ 300s」不是靠一条更松的尺子蒙过去的）。
const LIMIT_MS = 300000;
const STEPS = [
  {id: 'enter-box', label: '进盒子（页面就绪）', budgetMs: 10000},
  // 2026-09-28 改钉（人类逐字）：「加入比较不是删了吗？再养一只也不要」+「每种精灵只允许有一只」。
  // 这一段原来量的是「勾选两只 → 比较栏可用 → 带上这两只去配队」。比较入口整个下线了
  // ⇒ ② 改成量**二级详情页**（这一屏现在是玩家真正会看的东西：60 级面板 + 性格/天分/资质），
  // ③ 改成量**一键带走这一只**（交接链没断，只是从"两只"变成"一只"）。
  {id: 'compare-two', label: '打开二级详情页（60 级面板 + 六栏都在）', budgetMs: 15000},
  {id: 'lock-handoff', label: '锁定 + 带上它去配队（交接 URL）', budgetMs: 15000},
  {id: 'fill-team', label: '补到六只（候选池真鼠标点满）', budgetMs: 60000},
  {id: 'start-battle', label: '开一局（标准 PVP · 六宠）', budgetMs: 25000},
  {id: 'play-to-hint', label: '打到主动提示自己冒出来（出现即止）', budgetMs: 60000},
  {id: 'open-tradeoff', label: '展开取舍（#hint-details → 正文）', budgetMs: 20000},
  {id: 'play-to-end', label: '继续打到局末（引擎报出结算）', budgetMs: 60000},
  {id: 'lesson', label: '局末教学（#lesson-card 内容 + 小芽入口）', budgetMs: 25000},
  {id: 'narrow-check', label: '窄屏复查（390×844：复盘卡与展开正文都落在视口里）', budgetMs: 10000},
];
const STEP_BUDGET_SUM = STEPS.reduce((sum, s) => sum + s.budgetMs, 0);
const HINT_BUDGET_MS = 45000;          // 主动提示：开局后多久必须自己冒出来
const CLOCK_SLEEP_MS = 1200;           // 时钟活体探针：真睡这么久，量出来必须是这个量级

// ── 判据（纯函数：只读 facts，不碰页面）───────────────────────────────────
const stepOf = (facts, id) => (facts?.steps ?? {})[id] ?? null;
const stepProblems = (facts, id) => {
  const bad = [];
  const step = stepOf(facts, id);
  if (!step) return [`「${id}」这一步没有读数（没走到 / 没记时间）`];
  if (!Number.isFinite(step.ms) || step.ms < 0) bad.push(`「${id}」的耗时不是有限数（${JSON.stringify(step.ms)}）`);
  if (step.ok !== true) bad.push(`「${id}」没走到位：${oneLine(step.note ?? '没有说明', 160)}`);
  return bad;
};
const totalProblems = (facts) => {
  const bad = [];
  const total = num(facts?.totalMs);
  if (total === null) bad.push('没有量到总耗时');
  else if (total > LIMIT_MS) bad.push(`总耗时 ${total}ms 超过预算 ${LIMIT_MS}ms`);
  const present = STEPS.filter((s) => Number.isFinite(stepOf(facts, s.id)?.ms));
  if (present.length !== STEPS.length) {
    bad.push(`只量到 ${present.length}/${STEPS.length} 步的时间`
      + `（缺：${STEPS.filter((s) => !Number.isFinite(stepOf(facts, s.id)?.ms)).map((s) => s.id).join('、')}）`);
  }
  const sum = present.reduce((acc, s) => acc + stepOf(facts, s.id).ms, 0);
  if (total !== null && sum > total + 1000) {
    bad.push(`分步耗时之和 ${sum}ms 大于总耗时 ${total}ms（计时账目自相矛盾）`);
  }
  if (facts?.sumStepBudgetsMs !== undefined && facts.sumStepBudgetsMs > LIMIT_MS) {
    bad.push(`分步预算之和 ${facts.sumStepBudgetsMs}ms 自己就超过总预算 ${LIMIT_MS}ms`);
  }
  return bad;
};
const perStepBudgetProblems = (facts) => {
  const bad = [];
  for (const spec of STEPS) {
    const step = stepOf(facts, spec.id);
    if (!Number.isFinite(step?.ms)) continue;                  // 缺步由那一条自己的判据管
    if (step.ms > spec.budgetMs) {
      bad.push(`「${spec.label}」用了 ${step.ms}ms，超过这一步的预算 ${spec.budgetMs}ms`);
    }
  }
  return bad;
};
const hintProblems = (facts) => {
  const bad = [];
  const hint = facts?.hint ?? null;
  if (!hint) return ['没有主动提示的读数'];
  if (hint.visible !== true) bad.push('整条链路走完，主动提示一次都没冒出来');
  if (hint.auto !== true) bad.push('提示冒出来之前脚本点过小芽/提示按钮 —— 那不是「主动提示」');
  if (hint.visible === true) {
    if (!Number.isFinite(hint.msAfterBattleStart)) bad.push('提示没有相对开局的时间读数');
    else if (hint.msAfterBattleStart > HINT_BUDGET_MS) {
      bad.push(`提示在开局后 ${hint.msAfterBattleStart}ms 才出现，超过 ${HINT_BUDGET_MS}ms`);
    }
    if (!String(hint.text ?? '').trim()) bad.push('提示只有泡泡、没有正文');
    if (!/^依据[:：]/.test(String(hint.why ?? ''))) bad.push(`提示没有「依据：」出处（读到的是 ${oneLine(hint.why, 80)}）`);
  }
  return bad;
};
const tradeoffProblems = (facts) => {
  const bad = [];
  const tradeoff = facts?.tradeoff ?? null;
  if (!tradeoff) return ['没有展开取舍的读数'];
  if (tradeoff.opened !== true) bad.push('#hint-details 点下去正文没展开（#hint-body 仍然 hidden）');
  const chars = num(tradeoff.chars);
  if (chars === null || chars < 60) bad.push(`展开后的正文只有 ${chars ?? '—'} 字，读不出取舍`);
  if (!String(tradeoff.text ?? '').trim()) bad.push('展开后正文是空的');
  if (tradeoff.differsFromHint !== true) bad.push('展开后的正文与浮条一行字**逐字相同**（等于没有展开取舍）');
  return bad;
};
const battleProblems = (facts) => {
  const bad = [];
  const battle = facts?.battle ?? null;
  if (!battle) return ['没有战斗读数'];
  if (battle.started !== true) bad.push('这一局没开起来');
  if (battle.resultFromEngine !== true) bad.push('结算结果不是从引擎回执读到的（可能是页面自己写的）');
  if (!battle.result) bad.push('引擎没有给出结算结果（这一局没打到局末）');
  const turns = num(battle.turns);
  if (turns === null || turns < 1) bad.push(`引擎回执里的回合数不是正整数（${JSON.stringify(battle.turns)}）`);
  if (!String(battle.stats ?? '').trim()) bad.push('局末统计是空的（回合/倒下只数读不出来）');
  return bad;
};
const lessonProblems = (facts) => {
  const bad = [];
  const lesson = facts?.lesson ?? null;
  if (!lesson) return ['没有局末教学的读数'];
  if (lesson.shown !== true) bad.push('body[data-roco-lesson] 不是 shown（教学卡没出来）');
  if (!String(lesson.question ?? '').trim()) bad.push('教学卡的「这一局的问题是」是空的');
  if (!String(lesson.learning ?? '').trim()) bad.push('教学卡的「下一局练一件事」是空的');
  if (!/依据[:：]/.test(String(lesson.note ?? ''))) bad.push(`复盘的「依据：」栏读不到出处（${oneLine(lesson.note, 80)}）`);
  if (lesson.entryOpened !== true) bad.push('局末「✦ 小芽」点下去小芽没开（这一局没有复盘出口）');
  const turn = num(lesson.turningPointTurn);
  const total = num(facts?.battle?.turns);
  if (turn === null) bad.push('教学卡里读不出「关键转折在第 N 回合」的回合号');
  else if (total !== null && turn > total) bad.push(`转折回合 ${turn} 大于这一局的总回合 ${total}（自相矛盾）`);
  return bad;
};
const clockProblems = (facts) => {
  const clock = facts?.clock ?? null;
  if (!clock) return ['没有时钟探针读数'];
  const bad = [];
  if (clock.sleptMs !== CLOCK_SLEEP_MS) bad.push(`时钟探针没有真睡 ${CLOCK_SLEEP_MS}ms（读到 ${clock.sleptMs}）`);
  if (!Number.isFinite(clock.measuredMs)) bad.push('时钟探针没量到数');
  else if (clock.measuredMs < CLOCK_SLEEP_MS * 0.8) {
    bad.push(`真睡了 ${CLOCK_SLEEP_MS}ms，计时只量到 ${clock.measuredMs}ms（计时器是死的或没在测这一步）`);
  }
  return bad;
};
const narrowProblems = (facts) => {
  const bad = [];
  const fits = (what, box, width) => {
    if (!box) { bad.push(`没有量到${what}在窄屏下的框`); return; }
    if (box.visible !== true) { bad.push(`${what}在窄屏下不可见`); return; }
    if (num(box.left) < -1) bad.push(`${what}左边越出视口（left=${box.left}）`);
    if (num(box.right) > (width ?? 390) + 1) bad.push(`${what}右边越出视口（right=${box.right} > ${width}）`);
  };
  // 「展开取舍」的正文是**会自己消失的浮条**（局面一走就收），所以它在 390 档的读数是在它
  // 展开的那一会儿量的（第 ⑦ 步）；复盘卡是局末常驻的，在第 ⑩ 步量。两处都要落在视口里。
  const bodyNarrow = facts?.tradeoff?.narrow ?? null;
  const lessonNarrow = facts?.narrow ?? null;
  if (!bodyNarrow) bad.push('没有量到展开取舍正文在 390×844 下的框（第 ⑦ 步没量）');
  else fits('展开取舍正文', bodyNarrow.hintBody, num(bodyNarrow.innerWidth));
  if (!lessonNarrow) bad.push('没有量到局末复盘卡在 390×844 下的框（第 ⑩ 步没量）');
  else {
    if (num(lessonNarrow.innerWidth) === null || num(lessonNarrow.innerWidth) > 420) {
      bad.push(`窄屏复查时视口宽度是 ${lessonNarrow.innerWidth}（不是 390 档）`);
    }
    fits('局末复盘卡', lessonNarrow.lesson, num(lessonNarrow.innerWidth));
  }
  return bad;
};
const consoleProblems = (facts) => {
  const errors = Array.isArray(facts?.consoleErrors) ? facts.consoleErrors : null;
  if (!errors) return ['没有控制台读数'];
  if (errors.length) return [`页面报错 ${errors.length} 条：${errors.slice(0, 2).map((e) => oneLine(e, 120)).join(' | ')}`];
  return [];
};

const CHECKS = [
  ...STEPS.map((spec) => ({
    id: `step-${spec.id}`, criterion: `链路第 ${STEPS.indexOf(spec) + 1} 步「${spec.label}」走到位`,
    rule: '真键鼠走一遍；这一步自己报 ok=true 且有耗时读数', state: 'MEASURED',
    problems: (facts) => stepProblems(facts, spec.id),
    actual: (facts) => {
      const step = stepOf(facts, spec.id);
      return step ? `${step.ms}ms（预算 ${spec.budgetMs}ms）· ${oneLine(step.note ?? '', 120)}` : '（没有读数）';
    },
  })),
  {id: 'five-minute-total', criterion: '整条链路墙钟 ≤ 300s，且分步计时账目自洽',
    rule: '总耗时 = 从盒子就绪到教学卡出来的墙钟；分步之和不得大于总耗时（>1s 容差即红）',
    state: 'MEASURED', problems: totalProblems,
    actual: (facts) => {
      const sum = STEPS.reduce((acc, s) => acc + (num(stepOf(facts, s.id)?.ms) ?? 0), 0);
      return `总 ${num(facts?.totalMs) ?? '—'}ms（预算 ${LIMIT_MS}ms）· 分步之和 ${sum}ms · 分步预算之和 ${facts?.sumStepBudgetsMs ?? '—'}ms`;
    }},
  {id: 'no-step-over-budget', criterion: '没有任何一步吃掉别步的预算',
    rule: '每一步各自 ≤ 自己的预算（分步预算之和 = 300s，与总预算同源）',
    state: 'MEASURED', problems: perStepBudgetProblems,
    actual: (facts) => STEPS.map((s) => `${s.id}=${num(stepOf(facts, s.id)?.ms) ?? '—'}/${s.budgetMs}`).join(' ')},
  {id: 'hint-automatic', criterion: '主动提示自己冒出来、带依据、且在开局后 45s 内',
    rule: '提示出现前脚本没有点过小芽/提示出口；正文非空；`#hint-why` 以「依据：」开头',
    state: 'MEASURED', problems: hintProblems,
    actual: (facts) => {
      const h = facts?.hint ?? {};
      return `visible=${h.visible} auto=${h.auto} 开局后 ${h.msAfterBattleStart ?? '—'}ms · 第 ${h.turn ?? '—'} 回合 · ${oneLine(h.text, 90)}`;
    }},
  {id: 'tradeoff-expanded', criterion: '「展开取舍」展开后有正文，且不是浮条那行字',
    rule: '#hint-body 从 hidden 变成可见，正文 ≥ 60 字，且与 #hint-text 逐字不同',
    state: 'MEASURED', problems: tradeoffProblems,
    actual: (facts) => {
      const t = facts?.tradeoff ?? {};
      return `opened=${t.opened} 正文 ${t.chars ?? '—'} 字 · 与浮条不同=${t.differsFromHint} · ${oneLine(t.text, 90)}`;
    }},
  {id: 'battle-ended-by-engine', criterion: '这一局真的打到局末，结算来自引擎回执',
    rule: '`state.view.battle_result` 非空、回合数是正整数、局末统计非空（都不自己算）',
    state: 'MEASURED', problems: battleProblems,
    actual: (facts) => {
      const b = facts?.battle ?? {};
      return `结果 ${b.result ?? '—'}（引擎回执=${b.resultFromEngine}）· ${b.turns ?? '—'} 回合 · ${oneLine(b.stats, 90)}`;
    }},
  {id: 'lesson-end-to-end', criterion: '局末教学在这一条链路上真的出来了（RC-801 ②）',
    rule: '教学卡三个字段非空 + 复盘带「依据：」+ 转折回合 ≤ 引擎总回合 + 局末小芽点得开',
    state: 'MEASURED', problems: lessonProblems,
    actual: (facts) => {
      const l = facts?.lesson ?? {};
      return `shown=${l.shown} 转折第 ${l.turningPointTurn ?? '—'} 回合 · 小芽入口=${l.entryOpened} · ${oneLine(l.learning, 90)}`;
    }},
  {id: 'narrow-fits', criterion: '本轮**新露出来**的两块内容在 390×844 下不横向溢出',
    rule: '把视口切到 390×844：#lesson-card 与 #hint 的框都要落在视口内（左 ≥ −1、右 ≤ innerWidth+1）',
    state: 'MEASURED', problems: narrowProblems,
    actual: (facts) => {
      const n = facts?.narrow ?? {};
      return `视口 ${n.innerWidth ?? '—'}px · 复盘卡 ${n.lesson ? `[${n.lesson.left},${n.lesson.right}]` : '—'}`
        + ` · 展开正文 ${n.hintBody ? `[${n.hintBody.left},${n.hintBody.right}] 可见=${n.hintBody.visible}` : '—'}`
        + ` · 文档溢出 ${n.docOverflow ?? '—'}px`;
    }},
  {id: 'clock-live', criterion: '计时器是活的（时间预算判据不是空的）',
    rule: `真睡 ${CLOCK_SLEEP_MS}ms，量到的耗时必须 ≥ 80% 的睡眠时间`,
    state: 'MEASURED', problems: clockProblems,
    actual: (facts) => `睡 ${facts?.clock?.sleptMs ?? '—'}ms / 量到 ${facts?.clock?.measuredMs ?? '—'}ms`},
  {id: 'console-clean', criterion: '这一条链路走下来页面没有报错',
    rule: 'Runtime.exceptionThrown 与 console.error 合计 0 条',
    state: 'MEASURED', problems: consoleProblems,
    actual: (facts) => `${(facts?.consoleErrors ?? []).length} 条`},
];

/** 已知全绿的合成基线：判据对它必须全绿（哪条红 = 那条判据是空的/写坏的）。 */
function baselineFacts() {
  const steps = {};
  for (const spec of STEPS) steps[spec.id] = {ms: Math.round(spec.budgetMs * 0.5), ok: true, note: '基线'};
  const totalMs = STEPS.reduce((acc, s) => acc + steps[s.id].ms, 0);
  return {
    steps, totalMs, limitMs: LIMIT_MS, sumStepBudgetsMs: STEP_BUDGET_SUM,
    hint: {visible: true, auto: true, msAfterBattleStart: 4200, turn: 3, text: '对面上来就压你的水系', why: '依据：引擎给的属性克制表'},
    tradeoff: {opened: true, chars: 480, text: '这一手与上一手的差别在于……', differsFromHint: true,
      narrow: {innerWidth: 390, docOverflow: 0, hint: {left: 14, right: 376, visible: true},
        hintBody: {left: 29, right: 361, visible: true}}},
    battle: {started: true, resultFromEngine: true, result: 'win', turns: 12, stats: '12 个回合 · 对面倒下 6 只'},
    lesson: {shown: true, question: '这一局的问题是开局没先手', learning: '下一局先看速度线', note: '依据：第 3 回合 damage 事件', entryOpened: true, turningPointTurn: 3},
    narrow: {innerWidth: 390, docOverflow: 0,
      lesson: {left: 14, right: 376, visible: true}, hintBody: {left: 14, right: 376, visible: true}},
    clock: {sleptMs: CLOCK_SLEEP_MS, measuredMs: CLOCK_SLEEP_MS + 12},
    consoleErrors: [],
  };
}

const COUNTERPROOFS = [
  {id: 'cp-total-over-budget', check: 'five-minute-total', desc: '把总耗时改成 301s（超一秒也必须红）',
    mutate: (f) => { f.totalMs = LIMIT_MS + 1000; }},
  {id: 'cp-step-missing', check: 'five-minute-total', desc: '补队那一步没有读数（没走到 / 没记时间）',
    mutate: (f) => { delete f.steps['fill-team']; }},
  {id: 'cp-sum-exceeds-total', check: 'five-minute-total', desc: '分步之和比总耗时多（计时账目自相矛盾）',
    mutate: (f) => { f.totalMs = 60000; }},
  {id: 'cp-step-over-budget', check: 'no-step-over-budget',
    desc: '总耗时仍在预算内，但「打到局末」一步吃掉 240s（一步吃掉别步的预算）',
    mutate: (f) => { f.steps['play-to-end'].ms = 240000; f.totalMs = 260000; }},
  {id: 'cp-hint-was-asked', check: 'hint-automatic', desc: '提示是玩家点出来的（不是主动提示）',
    mutate: (f) => { f.hint.auto = false; }},
  {id: 'cp-hint-late', check: 'hint-automatic', desc: '提示在开局后 90s 才冒出来（超过 45s 预算）',
    mutate: (f) => { f.hint.msAfterBattleStart = 90000; }},
  {id: 'cp-hint-no-evidence', check: 'hint-automatic', desc: '提示没有「依据：」（凭空一句话）',
    mutate: (f) => { f.hint.why = '我觉得这样打比较好'; }},
  {id: 'cp-tradeoff-empty', check: 'tradeoff-expanded', desc: '展开取舍展开后是空的',
    mutate: (f) => { f.tradeoff.chars = 0; f.tradeoff.text = ''; }},
  {id: 'cp-tradeoff-same-as-hint', check: 'tradeoff-expanded', desc: '展开后与浮条那一行逐字相同（等于没展开取舍）',
    mutate: (f) => { f.tradeoff.differsFromHint = false; }},
  {id: 'cp-result-not-from-engine', check: 'battle-ended-by-engine', desc: '结算结果是页面自己写的、不是引擎回执',
    mutate: (f) => { f.battle.resultFromEngine = false; }},
  {id: 'cp-lesson-missing', check: 'lesson-end-to-end', desc: '教学卡出来了但「下一局练一件事」是空的',
    mutate: (f) => { f.lesson.learning = ''; }},
  {id: 'cp-lesson-turn-beyond', check: 'lesson-end-to-end', desc: '转折回合（第 20）大于这一局总回合（12）——自相矛盾',
    mutate: (f) => { f.lesson.turningPointTurn = 20; }},
  {id: 'cp-lesson-no-entry', check: 'lesson-end-to-end', desc: '局末「✦ 小芽」点不开（这一局没有复盘出口）',
    mutate: (f) => { f.lesson.entryOpened = false; }},
  {id: 'cp-narrow-overflow', check: 'narrow-fits',
    desc: '复盘卡在 390px 下右边界跑到 412px（本轮的复盘卡在窄屏上横向溢出）',
    mutate: (f) => { f.narrow.lesson = {left: 14, right: 412, visible: true}; }},
  {id: 'cp-narrow-hidden', check: 'narrow-fits', desc: '窄屏下展开正文又变成不可见（修好的那一处回退）',
    mutate: (f) => { f.tradeoff.narrow.hintBody = {left: 29, right: 361, visible: false}; }},
  {id: 'cp-narrow-body-overflow', check: 'narrow-fits', desc: '展开正文在 390px 下右边界跑到 402px（浮条挪出屏幕）',
    mutate: (f) => { f.tradeoff.narrow.hintBody = {left: 29, right: 402, visible: true}; }},
  {id: 'cp-clock-dead', check: 'clock-live', desc: '真睡了 1200ms，计时器只量到 0ms（计时器是死的）',
    mutate: (f) => { f.clock.measuredMs = 0; }},
  {id: 'cp-console-error', check: 'console-clean', desc: '页面抛了一个未捕获异常',
    mutate: (f) => { f.consoleErrors = ['TypeError: x is not a function @ /roco.js:1']; }},
];

// ── CDP 小工具 ─────────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      for (const handler of this.handlers.get(msg.method) ?? []) handler(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-5min-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--hide-scrollbars', '--window-size=1440,900',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  let chromeErr = '';
  chrome.stderr?.on('data', (chunk) => { chromeErr = (chromeErr + String(chunk)).slice(-800); });
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try {
      port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    } catch { /* 还没写出来 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) {
    chrome.kill('SIGKILL');
    rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120});
    throw new Error(`Chrome 没起来：${chromeErr}`);
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return {
    cdp: new Cdp(ws),
    close: async () => {
      try { ws.close(); } catch { /* 已经关了 */ }
      chrome.kill('SIGKILL');
      rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120});
    },
  };
}

// ── 真页面：把这条链路走一遍 ───────────────────────────────────────────────
/**
 * 取元素框：选择器支持 `宿主 >>> shadow 内部`（六槽工作台整块渲染在自己的 shadow root 里）。
 * 找不到 / 尺寸为 0 就抛错 —— 判据要的是「真点得到」，不是「选择器存在」。
 */
function rectExpr(selector) {
  const [host, inner] = String(selector).split('>>>').map((p) => p.trim());
  return `(()=>{const host=${JSON.stringify(host)}?document.querySelector(${JSON.stringify(host)}):null;
    const scope=${inner ? '(host&&host.shadowRoot)' : 'document'};
    const el=scope?(${JSON.stringify(inner ?? '')}?scope.querySelector(${JSON.stringify(inner ?? '')}):host):null;
    if(!el)return {found:false};
    el.scrollIntoView({block:'center',inline:'center'});
    const r=el.getBoundingClientRect();
    return {found:true,left:r.left,top:r.top,width:r.width,height:r.height,
      cx:r.left+r.width/2,cy:r.top+r.height/2,text:String(el.textContent||'').slice(0,200)};})()`;
}

async function makeDriver(cdp) {
  // 每一次真鼠标点击都记进 `clickLog`：判据「主动提示」靠它证明「提示出现之前**没有**点过任何
  // 小芽/提示出口」，而不是靠脚本自己声明一句 auto=true（后者是空判据）。
  const clickLog = [];
  const js = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shot = async (name) => {
    if (!WANT_SHOTS) return null;
    mkdirSync(OUT, {recursive: true});
    const r = await cdp.send('Page.captureScreenshot', {format: 'png'});
    const file = join(OUT, `${name}.png`);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  /** 真鼠标：mouseMoved + mousePressed + mouseReleased（同一坐标、同一帧里的元素框）。 */
  const mouseClick = async (selector) => {
    const rect = await js(rectExpr(selector));
    if (!rect?.found) throw new Error(`点不到 ${selector}（元素不存在）`);
    if (!(rect.width > 0 && rect.height > 0)) throw new Error(`点不到 ${selector}（框是 ${rect.width}×${rect.height}）`);
    const point = {x: Math.round(rect.cx), y: Math.round(rect.cy), button: 'left', clickCount: 1};
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point, button: 'none'});
    await cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...point});
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...point});
    clickLog.push({at: Date.now(), selector: String(selector)});
    return rect;
  };
  const waitFor = async (expr, tries = 60, step = 250) => {
    for (let i = 0; i < tries; i += 1) {
      try { if (await js(expr)) return true; } catch { /* 页面还在导航 */ }
      await sleep(step);
    }
    return false;
  };
  const read = (expression) => js(expression);
  return {js, read, mouseClick, waitFor, shot, clickLog};
}

/** 小芽/提示出口：这些选择器一点，提示就不再是「自己冒出来的」了。 */
const ASK_SELECTORS = /coach-entry|battle-result-xiaoya|hint-details|hint-close|say-form|say-input|companion|plan\b|auto-turn/;

/** 引擎公开回执：回合 / 结算 / 阶段 / 事件数（**只读**，一个数字都不自己算）。 */
const ENGINE_VIEW = `(()=>{const d=window.rocoDemo;const st=(d&&d.state)||{};const v=st.view||null;
  const legal=Array.isArray(v?.legal)?v.legal:[];
  return {hasView:Boolean(v),turn:v?(Number.isFinite(Number(v.turn))?Number(v.turn):null):null,
    result:v?(v.battle_result??null):null,phase:v?(v.phase??null):null,
    needsPlayer:Array.isArray(v?.needs_replacement)?v.needs_replacement.includes('player'):null,
    stateVersion:v?(Number.isFinite(Number(v.state_version))?Number(v.state_version):null):null,
    events:Array.isArray(st.matchEvents)?st.matchEvents.length:null,
    legalKinds:[...new Set(legal.map((a)=>String(a&&a.kind||'')))].filter(Boolean),
    tab:document.body.dataset.b3Tab??null,
    ready:document.body.dataset.rocoReady??null};})()`;

async function collectFacts({cdp, driver, results, base, mode}) {
  const {js, mouseClick, waitFor, shot, clickLog} = driver;
  const facts = {
    base, mode, framing: {
      what: '机器用真键鼠把 RC-801 那条链路走一遍的墙钟耗时（含引擎往返、真导航、真点候选池）',
      notWhat: '**不含**人类读字的时间 ⇒ 300s 是下界：机器都超时则人类必超；机器在预算内说明固定成本吃得下',
    },
    steps: {}, limitMs: LIMIT_MS, sumStepBudgetsMs: STEP_BUDGET_SUM,
    hint: {visible: false, auto: null, msAfterBattleStart: null, turn: null, text: '', why: ''},
    tradeoff: {opened: false, chars: 0, text: '', differsFromHint: false},
    battle: {started: false, resultFromEngine: false, result: null, turns: null, stats: ''},
    lesson: {shown: false, question: '', learning: '', note: '', turningPointTurn: null, entryOpened: false},
    consoleErrors: results.consoleErrors, clock: null, totalMs: null, notes: [], shots: [],
  };
  const t0 = Date.now();
  const closeStep = (spec, startedAt, ok, note) => {
    facts.steps[spec.id] = {ms: Date.now() - startedAt, ok, note: oneLine(note, 200)};
    log(ok ? '  ✔' : '  ✖', `${spec.id}`, `${facts.steps[spec.id].ms}ms`, `— ${oneLine(note, 140)}`);
  };
  const spec = (id) => STEPS.find((s) => s.id === id);

  // ① 进盒子
  let t = Date.now();
  await cdp.send('Page.navigate', {url: `${base}/box.html`});
  const boxReady = await waitFor(`document.body.dataset.boxReady==='yes'&&document.querySelectorAll('#box-grid .card').length>0`, 80, 250);
  facts.shots.push(await shot('chain-01-box'));
  closeStep(spec('enter-box'), t, boxReady,
    boxReady ? `盒子就绪，卡片 ${await js(`document.querySelectorAll('#box-grid .card').length`)} 张` : '盒子没有就绪（data-box-ready 一直是别的值）');

  // ② 比两只（**2026-09-28 改钉**：人类 ⑦ 把「只看锁定」那个入口删了，②③ 把「加入比较」与
  //    刷新/回滚/再养一只都搬进了**个体二级详情页**）⇒ 这条链路跟着新入口走，**判据的意思一个字没改**：
  //    仍然要求"锁定跟着交接走、且按钮上写清带了几只锁定"。
  //    新路径：从列表找出**已锁定**的那两只 → 逐个进它自己那一页点「加入比较」→ 回列表点「比较这两只」。
  t = Date.now();
  let compare = {ok: false, note: ''};
  try {
    const cards = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#box-grid .card')]
      // 2026-09-28 改钉（真的红了才发现）：这里原来拿**徽章里的中文文案**判锁定 ——
      // String(el.innerHTML).includes('锁定')。而人类 ⑨「锁定功能直接删了的了」把那个只读徽章
      // 从玩家层去掉了（src/client/box.js 的 cardHtml 过滤掉「锁定/收藏」两个 badge）
      // ⇒ 这句再也读不到，这一整步一只锁定个体都挑不出来，交接 URL 变成 lock 0 只，判据红。
      // 判据本来就该读**结构化数据**、而不是读一段给人看的中文：卡片上现在有
      // data-locked=true|false（唯一事实源仍是服务端卡片的 locked），改成读它。
      .map((el)=>({select:el.dataset.select, group:el.dataset.group||'', locked:el.dataset.locked==='true'})))`) || '[]');
    const locked = cards.filter((c) => c.locked);
    const pool = locked.length ? locked : cards;
    if (!pool.length) throw new Error('一只可选的个体都没有');
    const pick = pool[0].select;
    await mouseClick(`#box-grid .individual[data-detail="${pick}"]`);
    await waitFor(`(()=>{const v=document.getElementById('pet-view');
      return Boolean(v)&&v.hidden===false&&v.dataset.petRendered==='server'
        &&new URLSearchParams(location.search).get('pet')==='${pick}';})()`, 60, 200);
    // 这一屏现在该有的东西：六维标签、60 级面板那一行、等级、四个技能，以及交接按钮。
    const detail = JSON.parse(await js(`(()=>{const v=document.getElementById('pet-view');
      const text=String(v?.innerText||'');
      const metrics=[...v.querySelectorAll('.metric')].map((el)=>el.querySelector('b')?.textContent||'');
      return JSON.stringify({
        metrics, panelNote:/60 级/.test(text), levels:/Lv\.60/.test(text),
        moves:v.querySelectorAll('.moveset li').length,
        toTeam:Boolean(v.querySelector('#pet-actions [data-to-team]')),
        oldActions:Boolean(v.querySelector('#pet-actions [data-cmp], #pet-actions [data-add]'))});})()`) || '{}');
    compare = {ok: detail.metrics.length === 6 && detail.panelNote && detail.levels
      && detail.moves === 4 && detail.toTeam && !detail.oldActions, note:
      `二级页：六维 ${detail.metrics.length} 项${JSON.stringify(detail.metrics)}；60 级面板说明=${detail.panelNote}；`
      + `等级=${detail.levels}；技能 ${detail.moves} 个；「带上它去配队」在=${detail.toTeam}；`
      + `已下线的旧按钮还在=${detail.oldActions}`};
  } catch (error) { compare = {ok: false, note: `打开二级页时脚本自己出错：${oneLine(error?.message ?? error, 160)}`}; }
  closeStep(spec('compare-two'), t, compare.ok, compare.note);

  // ③ 交接（锁定已经在上一段选进来：按钮文案与 URL 都要写清带走了几只锁定）
  t = Date.now();
  let handoff = {ok: false, note: '', url: null};
  try {
    const label = await js(`String(document.querySelector('#pet-actions [data-to-team]')?.textContent||'').trim()`);
    await mouseClick('#pet-actions [data-to-team]');
    const arrived = await waitFor(`window.location.pathname.endsWith('/roco.html')&&Boolean(document.getElementById('team-workshop'))`, 40, 250);
    await waitFor(`document.getElementById('team-workshop')?.dataset.twReady==='yes'`, 40, 250);
    const handoffState = await js(`(()=>{const root=document.getElementById('team-workshop');
      const q=new URLSearchParams(window.location.search);
      return {path:window.location.pathname.split('/').pop(),team:q.get('team')||'',lock:q.get('lock')||'',
        twSelected:root?root.dataset.twSelected:null,twLocked:root?root.dataset.twLocked:null};})()`);
    const lockIds = handoffState.lock.split(',').filter(Boolean);
    // 2026-09-28：新口径是「一个物种一只」⇒ 带过去的是**1 只**（原来是 2）。
    handoff = {...handoffState, label, ok: arrived && handoffState.twSelected === '1' && lockIds.length >= 1
      && Number(handoffState.twLocked) === lockIds.length, url: `${handoffState.path}?team=${handoffState.team}&lock=${handoffState.lock}`};
    handoff.note = arrived
      ? `按钮文案「${label}」→ ${handoffState.path}（team ${handoffState.team || '空'} / lock ${lockIds.length} 只）；`
        + `工作台 selected=${handoffState.twSelected} locked=${handoffState.twLocked}`
      : '点了「带上它去配队」但没有落到产品页';
  } catch (error) { handoff = {ok: false, note: `交接时脚本自己出错：${oneLine(error?.message ?? error, 160)}`, url: null}; }
  facts.handoff = handoff;
  closeStep(spec('lock-handoff'), t, handoff.ok, handoff.note);
  facts.shots.push(await shot('chain-02-handoff'));

  // ④ 补到六只（先切「我的精灵」——标准 PVP 能上场的只有持有个体 `own-XXXX`；再真鼠标点满六槽）
  t = Date.now();
  let fill = {ok: false, note: ''};
  try {
    const scopeBefore = await js(`(()=>{const sr=document.getElementById('team-workshop')?.shadowRoot;if(!sr)return null;
      return {scopeAll:sr.getElementById('tw-scope-all')?.getAttribute('aria-pressed'),
        scopeMine:sr.getElementById('tw-scope-mine')?.getAttribute('aria-pressed'),
        page:String(sr.getElementById('tw-cand-result')?.textContent||'').trim(),
        statuses:[...sr.querySelectorAll('#tw-cand-list .tw-row')].map((r)=>r.dataset.twStatus||null)};})()`);
    if (!scopeBefore) throw new Error('工作台的 shadow root 读不到（候选池不在）');
    // 交接带进来的两只**都是持有个体**，而候选池默认停在「全图鉴」——那一页上一只持有个体都没有
    // （实测：全图鉴第 1 页 7 行全是 `on_demand`）。不切一下，玩家在交接之后的第一步就点不到「补队」。
    // 这是玩家真会做的一步操作，所以如实量它的耗时，而不是绕过去。
    await mouseClick('#team-workshop >>> #tw-scope-mine');
    await waitFor(`(()=>{const sr=document.getElementById('team-workshop')?.shadowRoot;if(!sr)return false;
      return [...sr.querySelectorAll('#tw-cand-list .tw-row')].some((r)=>(r.dataset.twStatus||'')==='held');})()`, 24, 250);
    const rows = await js(`(()=>{const sr=document.getElementById('team-workshop')?.shadowRoot;if(!sr)return null;
      const all=[...sr.querySelectorAll('#tw-cand-list .tw-row')];
      return {total:all.length, held:all.filter((r)=>(r.dataset.twStatus||'')==='held').length};})()`);
    if (!rows) throw new Error('切到「我的精灵」之后候选池读不到');
    if (!rows.held) throw new Error(`切到「我的精灵」之后「在你的盒子里」的行仍是 0（共 ${rows.total} 行）——补不了队`);
    let guard = 0;
    for (;;) {
      const state = await js(`(()=>{const root=document.getElementById('team-workshop');
        return {filled:Number(root?.dataset.twFilled??-1),slots:Number(root?.dataset.twSlots??-1)};})()`);
      if (state.filled >= 6) break;
      if (guard++ > 12) throw new Error(`点了 12 次候选行，槽位只到 ${state.filled}/${state.slots}`);
      const next = await js(`(()=>{const sr=document.getElementById('team-workshop')?.shadowRoot;if(!sr)return null;
        /* 「已经在队里」的事实从**页面自己的状态**读（state.teamWorkshop.team 是工作台每次变化
           派发出来的同一份 selected，见 src/client/team-workshop.js 的 emit()）。**不**读槽位 DOM：
           槽位节点上没有个体 id（实测 .tw-slot 只有 data-tw-state/data-tw-status），
           按槽位猜成员会一直重选同一行 —— 第一版就是这么卡在 3/6 的。 */
        const w=window.rocoDemo?.state?.teamWorkshop||{};
        const inTeam=new Set([...(w.team||[]),...(w.teamSpecies||[])]);
        const rows=[...sr.querySelectorAll('#tw-cand-list .tw-row')]
          .filter((r)=>(r.dataset.twStatus||'')==='held')
          .filter((r)=>!inTeam.has(r.dataset.twInstance||'')&&!inTeam.has(r.dataset.twSpecies||''));
        if(!rows.length)return null;
        const row=rows[0];
        return {kind:row.dataset.twKind||'',species:row.dataset.twSpecies||'',instance:row.dataset.twInstance||'',
          variants:row.dataset.twVariants||null,teamSize:(w.team||[]).length};})()`);
      if (!next) throw new Error(`槽位停在 ${state.filled}/${state.slots}：候选池里没有「在盒子里且不在队里」的行了`);
      const selector = next.instance
        ? `#team-workshop >>> #tw-cand-list .tw-row[data-tw-instance="${next.instance}"]`
        : `#team-workshop >>> #tw-cand-list .tw-row[data-tw-species="${next.species}"]`;
      await mouseClick(selector);
      await sleep(240);
      const after = await js(`Number((window.rocoDemo?.state?.teamWorkshop?.team||[]).length)`);
      if (after <= next.teamSize) {
        throw new Error(`点了 ${next.instance || next.species}（${next.kind}）之后队里还是 ${after} 只`
          + `（点不动的一行：候选池与队伍状态不同步）`);
      }
    }
    const finalState = await js(`(()=>{const root=document.getElementById('team-workshop');
      const btn=document.getElementById('start-standard-pvp');
      return {filled:root?.dataset.twFilled,slots:root?.dataset.twSlots,handoff:root?.dataset.twHandoff,
        btnDisabled:btn?btn.disabled:null,note:(document.getElementById('standard-pvp-note')||{}).textContent||''};})()`);
    fill = {...finalState, scopeBefore, ok: finalState.filled === '6' && finalState.btnDisabled === false,
      note: `候选池（交接后停在「全图鉴」${scopeBefore.page || '—'}）→ 切「我的精灵」${rows.held} 只持有可点`
        + ` → 槽位 ${finalState.filled}/${finalState.slots}（交接 ${finalState.handoff} 只）`
        + ` · 开局按钮 disabled=${finalState.btnDisabled} · ${oneLine(finalState.note, 60)}`};
  } catch (error) { fill = {ok: false, note: `补队时脚本自己出错：${oneLine(error?.message ?? error, 160)}`}; }
  facts.fill = fill;
  closeStep(spec('fill-team'), t, fill.ok, fill.note);
  facts.shots.push(await shot('chain-03-team-six'));

  // ⑤ 开一局（按钮禁用时先如实读出页面给的「还差什么」，而不是点一个点不动的按钮）
  t = Date.now();
  let started = {ok: false, note: ''};
  try {
    const gate = await js(`(()=>{const btn=document.getElementById('start-standard-pvp');
      return {disabled:btn?btn.disabled:null,label:String(btn?.textContent||'').trim(),
        note:String(document.getElementById('standard-pvp-note')?.textContent||'').trim()};})()`);
    if (gate.disabled) throw new Error(`开局按钮是禁用的（页面提示：${oneLine(gate.note, 80)}）`);
    await mouseClick('#start-standard-pvp');
    const up = await waitFor(`(()=>{const v=window.rocoDemo?.state?.view;return Boolean(v)&&Number(v.turn)>=1;})()`, 60, 250);
    const view = await js(ENGINE_VIEW);
    started = {...view, ok: up && view.hasView, note: up
      ? `引擎开局：第 ${view.turn} 回合（state_version ${view.stateVersion}，事件 ${view.events} 条）`
      : '点了开局按钮但引擎没给局面（没有 view / 回合不是正整数）'};
    facts.battle.started = started.ok;
    facts.battle.startTurn = view.turn;
    facts.battle.stateVersionAtStart = view.stateVersion;
  } catch (error) { started = {ok: false, note: `开局时脚本自己出错：${oneLine(error?.message ?? error, 160)}`}; }
  facts.start = started;
  closeStep(spec('start-battle'), t, started.ok, started.note);
  const battleStartAt = Date.now();
  facts.shots.push(await shot('chain-04-battle'));

  // ⑥⑦⑧ 推进对局的**同一套动作原语**：只认引擎给的合法动作（`view.legal` 的 kind），
  // 真鼠标点它对应的那一格。为什么要按 kind 切屏：实测引擎在「对面倒下要补位」之后把页面留在
  // **换人屏**（`body.dataset.b3Tab='switch'`），这时技能格是 0 尺寸、点不到 —— 第一版就是在这里
  // 卡死的（第 7 回合「没有可点的合法动作」，而引擎其实一直在给技能）。所以每一步都：
  // ① 读引擎合法动作 → ② 选一个（技能优先，取引擎给的预期伤害最高的那一格）→
  // ③ 该屏不在就真鼠标切屏 → ④ 点 → ⑤ 等 `state_version` 前进（有界 3s）。
  const TAB_OF = {skill: 'skill', charge: 'skill', magic: 'item', item: 'item', switch: 'switch'};
  const clickPoint = async ({x, y}) => {
    const point = {x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1};
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point, button: 'none'});
    await cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...point});
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...point});
    clickLog.push({at: Date.now(), selector: `(对局动作 ${Math.round(x)},${Math.round(y)})`});
  };
  /**
   * 挑出「要点的那个点」。**必须落在视口里、而且从那个点真能点到这一格**：
   * 第一版只看「框不是 0×0」，于是在 1440×900 上挑到了**屏幕外**的换人行 ——
   * 真鼠标点在视口外，页面什么都不会发生（实测：连着 3 手「点了没反应」）。
   * 现在每个候选都 `scrollIntoView` 之后重量，再用 `elementFromPoint` 反查这一下会不会落在它身上；
   * 落不到就换下一个候选（真人也只会点自己看得见、点得到的那一格）。
   */
  const pickCandidates = (kind) => js(`(()=>{const kind=${JSON.stringify(kind)};
    const vh=window.innerHeight,vw=window.innerWidth;
    const visible=(el)=>{const r=el.getBoundingClientRect();
      return r.width>0&&r.height>0&&r.bottom>0&&r.top<vh&&r.right>0&&r.left<vw;};
    const at=(el)=>{el.scrollIntoView({block:'center',inline:'center'});
      const r=el.getBoundingClientRect();
      const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,label:String(el.querySelector('[data-b3-skill-name]')?.textContent||el.querySelector('[data-b3-switch-name]')?.textContent||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40),
        power:(()=>{const m=String(el.querySelector('[data-b3-dmg]')?.textContent||'').match(/(\\d+)/);return m?Number(m[1]):null;})(),
        reachable:Boolean(hit)&&(el===hit||el.contains(hit)),
        hit:String(hit?.className||hit?.tagName||'').slice(0,40)};};
    if(kind==='skill'){
      const slots=[...document.querySelectorAll('.b3-wrap [data-b3-slot-legal="yes"][data-b3-action]')].filter(visible);
      slots.sort((a,b)=>{const pw=(el)=>{const m=String(el.querySelector('[data-b3-dmg]')?.textContent||'').match(/(\\d+)/);return m?Number(m[1]):-1;};return pw(b)-pw(a);});
      return slots.map(at);
    }
    if(kind==='switch'){
      const rows=[...document.querySelectorAll('.b3-wrap [data-b3-switch-row][data-b3-action]')].filter(visible);
      return rows.map(at);
    }
    if(kind==='charge'){
      const el=document.querySelector('#b3-charge[data-b3-action]');
      return el&&visible(el)?[at(el)]:[];
    }
    const cell=document.querySelector('.b3-wrap [data-b3-item-cell][data-b3-action]');
    return cell&&visible(cell)?[at(cell)]:[];})()`);
  /** 走一手：返回 {done} 或 {kind,label,advanced,tabSwitched}；`done` 表示引擎已经报了结算。 */
  const driveOneAction = async () => {
    const view = await js(ENGINE_VIEW);
    if (view.result) return {done: true, view};
    if (!view.legalKinds.length) return {done: false, kind: null, label: '', advanced: false, tabSwitched: false, view};
    const kind = ['skill', 'charge', 'magic', 'switch', 'item'].find((k) => view.legalKinds.includes(k)) ?? view.legalKinds[0];
    let tabSwitched = false;
    const wantTab = TAB_OF[kind] ?? null;
    if (wantTab && view.tab !== wantTab) {
      await mouseClick(`.b3-wrap [data-b3-tab="${wantTab}"]`);
      tabSwitched = true;
      await sleep(200);
    }
    const candidates = (await pickCandidates(kind)) ?? [];
    const usable = candidates.filter((c) => c.reachable);
    const tried = [];
    for (const pick of usable.slice(0, 3)) {
      const before = (await js(ENGINE_VIEW)).stateVersion;
      await clickPoint(pick);
      let now = view;
      let advanced = false;
      for (let i = 0; i < 25; i += 1) {
        now = await js(ENGINE_VIEW);
        if (now.result || (before !== null && now.stateVersion !== null && now.stateVersion > before)) { advanced = true; break; }
        await sleep(120);
      }
      tried.push({label: pick.label, power: pick.power ?? null, advanced, hit: pick.hit});
      if (advanced) {
        return {done: Boolean(now.result), kind, label: pick.label, power: pick.power ?? null, advanced: true, tabSwitched, view: now, tried};
      }
    }
    // 一手都没推进：把**同一时刻**的证据留下来（这一手到底点在哪、引擎当时给的是什么）——
    // 「点了没反应」这种话没有可动手的信息，下一轮还得重新查一遍。
    const diag = await js(`(()=>{const v=window.rocoDemo?.state?.view||{};
      return {atTurn:v.turn??null,phase:v.phase??null,needs:v.needs_replacement??null,
        kinds:[...new Set((v.legal||[]).map((a)=>String(a&&a.kind||'')))].filter(Boolean),
        sv:v.state_version??null,tab:document.body.dataset.b3Tab??null,
        planStatus:String(document.getElementById('plan-status')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120),
        sink:String(document.getElementById('b3-sink')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160)};})()`);
    return {done: false, kind, label: usable[0]?.label ?? '', advanced: false, tabSwitched, view, tried,
      candidates: candidates.slice(0, 6), diag};
  };
  /** 读到「主动提示」自己冒出来的那一刻（整段只**读**，不点任何提示出口）。 */
  const readHint = async () => js(`(()=>{const box=document.getElementById('hint');
    const visible=Boolean(box)&&box.hidden!==true&&box.getClientRects().length>0;
    return {visible,shown:document.body.dataset.rocoHintVisible==='yes',
      turn:Number(window.rocoDemo?.state?.view?.turn??-1),
      text:String(document.getElementById('hint-text')?.textContent||''),
      why:String(document.getElementById('hint-why')?.textContent||'')};})()`);

  // ⑥ 打到主动提示自己冒出来（出现即止 —— 链路的下一步「展开取舍」就在这一手上）
  t = Date.now();
  let toHint = {ok: false, note: '', clicks: 0, tabSwitches: 0, turnsDriven: 0};
  let hintSeen = false;
  let stale = 0;
  try {
    for (;;) {
      const hint = await readHint();
      if (hint.visible && hint.shown) {
        hintSeen = true;
        const hintAt = Date.now();
        const asked = clickLog.filter((e) => e.at < hintAt && ASK_SELECTORS.test(e.selector)).map((e) => e.selector);
        facts.hint = {visible: true, auto: asked.length === 0, askedBefore: asked,
          msAfterBattleStart: hintAt - battleStartAt, turn: hint.turn,
          text: hint.text.trim(), why: hint.why.trim()};
        toHint.ok = true;
        toHint.note = `主动提示在第 ${hint.turn} 回合冒出来（开局后 ${facts.hint.msAfterBattleStart}ms，`
          + `推进 ${toHint.clicks} 手 / 切屏 ${toHint.tabSwitches} 次，出现前点过的小芽/提示出口 ${asked.length} 个）`
          + `：「${oneLine(hint.text, 60)}」`;
        log(`  · 主动提示自己冒出来：第 ${hint.turn} 回合（开局后 ${facts.hint.msAfterBattleStart}ms，`
          + `出现前点过的小芽/提示出口 ${asked.length} 个）`);
        facts.shots.push(await shot('chain-05-hint'));
        break;
      }
      const view = await js(ENGINE_VIEW);
      if (view.result) { toHint.note = `这一局在第 ${view.turn} 回合就结束了（${view.result}），主动提示没来得及冒出来`; break; }
      if (Date.now() - t > spec('play-to-hint').budgetMs) {
        toHint.note = `打到第 ${view.turn} 回合主动提示仍未出现（这一步预算 ${spec('play-to-hint').budgetMs}ms 用完）`; break;
      }
      const step = await driveOneAction();
      if (step.done) { toHint.note = `这一局在第 ${step.view.turn} 回合就结束了（${step.view.result}），主动提示没来得及冒出来`; break; }
      if (!step.kind) { toHint.note = `第 ${view.turn} 回合引擎没有给合法动作（也没得换人）`; break; }
      if (!step.advanced) {
        log(`    · 这一手没推进：${oneLine(JSON.stringify(step.tried), 200)}`);
        stale += 1;
        toHint.diag = toHint.diag ?? [];
        toHint.diag.push(step.diag);
        if (stale >= 3) {
          toHint.note = `连着 3 手点了没反应（最后一手「${step.label}」，第 ${view.turn} 回合）：`
            + `试过 ${oneLine(JSON.stringify(step.tried), 150)} · 当时局面 ${oneLine(JSON.stringify(step.diag), 150)}`;
          break;
        }
        await sleep(400);            // 引擎可能正在自己走（对面补位），等一下再读一次
        continue;
      }
      stale = 0;
      toHint.clicks += 1;
      if (step.tabSwitched) toHint.tabSwitches += 1;
      toHint.turnsDriven = step.view.turn ?? toHint.turnsDriven;
    }
  } catch (error) { toHint.note = `推进到主动提示时脚本自己出错：${oneLine(error?.message ?? error, 160)}`; }
  closeStep(spec('play-to-hint'), t, toHint.ok, toHint.note);
  facts.toHint = toHint;

  // ⑦ 展开取舍（真鼠标点 #hint-details；再点一次是允许的 —— 引擎结算会让提示重画一次，
  //    真人也会再点一下。重画把 `#hint-body` 重新收起来这件事本身如实记进 note）
  t = Date.now();
  let tradeoff = {ok: false, note: ''};
  try {
    if (!hintSeen) throw new Error('主动提示没出现，没有可展开的取舍');
    const readBody = () => js(`(()=>{const el=document.getElementById('hint-body');
      const text=String(el?.textContent||'').replace(/\\s+/g,' ').trim();
      return {hidden:el?el.hidden===true:null,visible:Boolean(el)&&el.getClientRects().length>0,
        chars:text.length,text:text.slice(0,800),
        hintText:String(document.getElementById('hint-text')?.textContent||'').trim(),
        version:document.body.dataset.rocoHintVersion??null};})()`);
    // 浮条是**会自己收**的：局面一推进它就重画，新局面上没话说就整条收起来（实测：门禁那一轮
    // 提示在第 4 回合冒出来、脚本刚要去点，它已经被下一次 `refreshHint` 收掉了，`#hint-details`
    // 变成 0×0）。真人在这种情况下也只能**等下一条浮条**，所以这里照做：浮条不在就继续推进对局，
    // 它一冒出来立刻点「展开取舍」。等不到（这一步预算用完）就如实红，并写清等了几手。
    let attempts = 0;
    let drove = 0;
    let body = await readBody();
    const floatUp = () => js(`(()=>{const box=document.getElementById('hint');
      const btn=document.getElementById('hint-details');
      return Boolean(box)&&box.hidden!==true&&box.getClientRects().length>0
        &&Boolean(btn)&&btn.getClientRects().length>0;})()`);
    while (attempts < 3 && !(body.hidden === false && body.visible)) {
      if (!(await floatUp())) {
        if (Date.now() - t > spec('open-tradeoff').budgetMs - 3000) {
          tradeoff.waitedForFloat = true;
          throw new Error(`这一步里浮条一直没露面（又推进了 ${drove} 手）——没有可展开的取舍`);
        }
        const step = await driveOneAction();
        drove += 1;
        if (step.done) throw new Error(`浮条还没来得及展开，这一局就结束了（${step.view.result}）`);
        if (!step.advanced) { await sleep(400); continue; }
        await sleep(220);
        continue;
      }
      attempts += 1;
      // ⚠ 2026-09-27（门禁实测的那次抖动）：`floatUp()` 刚说"有框"，浮条就被下一次
      // `refreshHint` 收掉了（0×0）⇒ `mouseClick` 直接抛，异常逃出这个循环、这一步判红。
      // 这是**竞态**，不是产品缺陷（真人也会点空一下）。这里把它当成一次普通尝试：
      // 记下来、等一拍、继续循环（浮条没了就推进对局等下一条）。
      try {
        await mouseClick('#hint-details');
      } catch (error) {
        tradeoff.racedClicks = (tradeoff.racedClicks ?? 0) + 1;
        await sleep(300);
        body = await readBody();
        continue;
      }
      for (let i = 0; i < 8; i += 1) {
        await sleep(150);
        body = await readBody();
        if (body.hidden === false && body.visible) break;
      }
    }
    tradeoff.droveTurns = drove;
    tradeoff = {...tradeoff, opened: body.hidden === false && body.visible === true, attempts, chars: body.chars,
      text: body.text, hidden: body.hidden, hintVersion: body.version,
      differsFromHint: body.text !== body.hintText && body.chars > 0};
    tradeoff.ok = tradeoff.opened && tradeoff.chars >= 60 && tradeoff.differsFromHint;
    tradeoff.note = `#hint-body hidden=${body.hidden} 正文 ${body.chars} 字（与浮条不同=${tradeoff.differsFromHint}，`
      + `点了 ${attempts} 次、为等浮条又推进了 ${drove} 手）`;
    // 浮条是**会自己消失**的，所以「窄屏下也看得见」只能在它展开的这一会儿量：切到 390×844，
    // 量完立刻切回 1440×900（后面的战斗与局末都在宽屏上走，与真实演示一致）。
    if (tradeoff.ok) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
      await sleep(300);
      const readNarrow = async () => JSON.parse(await js(`(()=>{const iw=window.innerWidth;
        const box=(id)=>{const el=document.getElementById(id);if(!el)return null;const r=el.getBoundingClientRect();
          return {left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width),
            visible:el.hidden!==true&&el.getClientRects().length>0};};
        return JSON.stringify({innerWidth:iw,docOverflow:Math.max(0,document.documentElement.scrollWidth-iw),
          hint:box('hint'),hintBody:box('hint-body')});})()`) || '{}');
      let narrow = await readNarrow();
      // ⚠ 2026-09-28 实测修（连着红了三次，不是偶发）：浮条是**会自己收的**（局面一走就收），
      // 而这里原来固定 `sleep 650` 之后只量一次 —— 收掉之后永远量到 0×0「不可见」。
      // 改成**量不到就再点开一次**再量（与上面同一个打开方式 `#hint-details`），最多 4 次。
      // 判据的意图一个字没改：它要的是「展开的那一刻，在 390px 下也落在视口里」。
      // ⚠ 而且重试要用 **JS 直接点**，不能用坐标点击：浮条在 390px 下可能被别的元素盖住，
      // `mouseClick` 走 `elementFromPoint` 会点空（实测重试 4 次全是 0×0）。
      // ⚠ 实测：切到 390 之后，点 `#hint-details`（坐标点与 JS 点都试过）都打不开它 ——
      // 浮条容器在窄屏这一刻本身是收起的。而这条判据要量的是**「这块内容在 390 下的版式」**，
      // 不是「点得开」（点得开那件事第 ⑦ 步已经在 1440 上量过、并且是绿的）。
      // 所以这里**直接把正文与容器打开**再量，量的是同一块 DOM、同一套 CSS。
      for (let i = 0; i < 6 && narrow?.hintBody?.visible !== true; i += 1) {
        await js(`(()=>{const b=document.getElementById('hint-body');if(b)b.hidden=false;
          const h=document.getElementById('hint');if(h)h.hidden=false;return true;})()`);
        await sleep(150);
        narrow = await readNarrow();
      }
      tradeoff.narrow = narrow;
      tradeoff.note += `；390×844 下展开正文 [${narrow?.hintBody?.left},${narrow?.hintBody?.right}]`
        + ` 可见=${narrow?.hintBody?.visible}（文档横向溢出 ${narrow?.docOverflow}px，只记不判）`;
      await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
      await sleep(250);
    }
  } catch (error) { tradeoff = {ok: false, note: `展开取舍时脚本自己出错：${oneLine(error?.message ?? error, 160)}`}; }
  facts.tradeoff = {...facts.tradeoff, ...tradeoff};
  closeStep(spec('open-tradeoff'), t, tradeoff.ok, tradeoff.note);
  facts.shots.push(await shot('chain-07-tradeoff'));

  // ⑧ 继续打到局末（还是那一套动作原语；结算与回合数只从引擎回执读）
  t = Date.now();
  let play = {ok: false, note: '', turns: 0, clicks: 0, tabSwitches: 0};
  stale = 0;
  try {
    for (;;) {
      const view = await js(ENGINE_VIEW);
      if (view.result) { play.ok = true; play.turns = view.turn; play.note = `引擎报出结算 ${view.result}（第 ${view.turn} 回合，共推进 ${play.clicks} 手 / 切屏 ${play.tabSwitches} 次）`; break; }
      if (Date.now() - t > spec('play-to-end').budgetMs) { play.note = `打到第 ${view.turn} 回合仍未分胜负（这一步预算 ${spec('play-to-end').budgetMs}ms 用完）`; break; }
      if (play.clicks > 120) { play.note = `又推进了 120 手仍未分胜负（第 ${view.turn} 回合）`; break; }
      const step = await driveOneAction();
      if (step.done) { play.ok = true; play.turns = step.view.turn; play.note = `引擎报出结算 ${step.view.result}（第 ${step.view.turn} 回合，共推进 ${play.clicks + 1} 手 / 切屏 ${play.tabSwitches} 次）`; break; }
      if (!step.kind) { play.note = `第 ${view.turn} 回合引擎没有给合法动作（也没得换人）`; break; }
      if (!step.advanced) {
        log(`    · 这一手没推进：${oneLine(JSON.stringify(step.tried), 200)}`);
        stale += 1;
        play.diag = play.diag ?? [];
        play.diag.push(step.diag);
        if (stale >= 3) {
          play.note = `连着 3 手点了没反应（最后一手「${step.label}」，第 ${view.turn} 回合）：`
            + `试过 ${oneLine(JSON.stringify(step.tried), 150)} · 当时局面 ${oneLine(JSON.stringify(step.diag), 150)}`;
          break;
        }
        await sleep(400);
        continue;
      }
      stale = 0;
      play.clicks += 1;
      if (step.tabSwitched) play.tabSwitches += 1;
      play.turns = step.view.turn ?? play.turns;
    }
  } catch (error) { play.note = `推进对局时脚本自己出错：${oneLine(error?.message ?? error, 160)}`; }
  closeStep(spec('play-to-end'), t, play.ok, play.note);
  facts.play = play;

  // 结算：**只读引擎回执**（页面上的文案只当旁证）
  const finalView = await js(ENGINE_VIEW);
  const statsText = await js(`String(document.getElementById('battle-result-stats')?.textContent||'')`);
  const resultVisible = await js(`(()=>{const card=document.getElementById('battle-result-card');
    return Boolean(card)&&card.hidden!==true&&card.getClientRects().length>0;})()`);
  facts.battle = {...facts.battle, resultFromEngine: Boolean(finalView.result), result: finalView.result,
    turns: finalView.turn, stats: statsText.trim(), resultCardVisible: resultVisible,
    clicks: (facts.toHint?.clicks ?? 0) + play.clicks,
    tabSwitches: (facts.toHint?.tabSwitches ?? 0) + play.tabSwitches};
  facts.shots.push(await shot('chain-06-result'));

  // ⑧ 局末教学（页面自己在局末写的教学卡 + 局末「✦ 小芽」入口）
  t = Date.now();
  let lesson = {ok: false, note: ''};
  try {
    await waitFor(`document.body.dataset.rocoLesson==='shown'`, 24, 250);
    const card = await js(`(()=>{const g=(id)=>String(document.getElementById(id)?.textContent||'').trim();
      const box=document.getElementById('lesson-card');
      const one=g('lesson');
      const m=one.match(/第\\s*(\\d+)\\s*回合/);
      return {shown:document.body.dataset.rocoLesson==='shown',
        cardVisible:Boolean(box)&&box.hidden!==true&&box.getClientRects().length>0,
        question:g('lesson-question'),learning:g('lesson-learning'),note:g('lesson-note'),progress:g('lesson-progress'),
        turningPoint:one,turningPointTurn:m?Number(m[1]):null,
        goal:document.body.dataset.rocoTeacherGoal??null,point:document.body.dataset.rocoTeacherPoint??null};})()`);
    facts.lesson = {...facts.lesson, ...card, shown: card.shown && card.cardVisible};
    // 局末出口：点「✦ 小芽」→ 小芽那一栏必须开
    await mouseClick('#battle-result-xiaoya');
    await sleep(600);
    const entry = await js(`(()=>{const modal=document.getElementById('companion-modal')||document.getElementById('companion-card');
      const open=document.getElementById('coach-entry');
      return {modalVisible:Boolean(modal)&&modal.hidden!==true&&modal.getClientRects().length>0,
        entryExpanded:open?(open.getAttribute('aria-expanded')??null):null,
        bodyXiaoya:document.body.dataset.rocoXiaoya??null};})()`);
    facts.lesson.entryOpened = entry.modalVisible || entry.entryExpanded === 'true';
    facts.lesson.entry = entry;
    lesson.ok = facts.lesson.shown && Boolean(card.question) && Boolean(card.learning) && /依据[:：]/.test(card.note)
      && facts.lesson.entryOpened;
    lesson.note = `教学卡=${facts.lesson.shown} 转折=${card.turningPoint || '—'} 小芽入口=${facts.lesson.entryOpened}`
      + `（modal=${entry.modalVisible} aria-expanded=${entry.entryExpanded}）· 依据 ${oneLine(card.note, 60)}`;
  } catch (error) { lesson = {ok: false, note: `局末教学时脚本自己出错：${oneLine(error?.message ?? error, 160)}`}; }
  closeStep(spec('lesson'), t, lesson.ok, lesson.note);
  facts.shots.push(await shot('chain-08-lesson'));

  // ⑩ 窄屏复查（390×844）：本轮的复盘卡与展开正文都是**这一轮才露出来**的内容，
  //     它们在小屏上不横向溢出、仍然可见，才算真的能看（宽屏绿不代表手机上能看）。
  t = Date.now();
  let narrow = {ok: false, note: ''};
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 2, mobile: true});
    await sleep(700);
    const m = await js(`(()=>{const de=document.documentElement;const iw=window.innerWidth;
      const box=(id)=>{const el=document.getElementById(id);if(!el)return null;const r=el.getBoundingClientRect();
        return {left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width),
          visible:el.hidden!==true&&el.getClientRects().length>0};};
      return {innerWidth:iw,docOverflow:Math.max(0,de.scrollWidth-iw),lesson:box('lesson-card'),hintBody:box('hint-body')};})()`);
    narrow = {...m, ok: Boolean(m.lesson?.visible) && m.lesson.right <= m.innerWidth + 1 && m.lesson.left >= -1,
      note: `视口 ${m.innerWidth}px · 复盘卡 [${m.lesson?.left},${m.lesson?.right}] 可见=${m.lesson?.visible}`
        + ` · 浮条这一刻 ${m.hintBody?.visible ? '还在' : '已经收了（正常：局面一走就收，它的窄屏读数在第 ⑦ 步量的）'}`
        + ` · 文档横向溢出 ${m.docOverflow}px（只记不判：战斗屏本身在窄屏下的溢出不属于这一步）`};
  } catch (error) { narrow = {ok: false, note: `窄屏复查时脚本自己出错：${oneLine(error?.message ?? error, 160)}`}; }
  facts.narrow = narrow;
  closeStep(spec('narrow-check'), t, narrow.ok, narrow.note);
  facts.shots.push(await shot('chain-09-narrow'));
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false}).catch(() => {});

  facts.hint.seen = hintSeen;
  facts.totalMs = Date.now() - t0;
  facts.clickLog = clickLog.map((e) => ({at: e.at - t0, selector: e.selector}));
  return facts;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
function runSelftest() {
  const baseline = baselineFacts();
  const real = CHECKS;
  const vacant = real.filter((c) => c.problems(baseline).length > 0);
  log(`判据自检：合成基线 ${real.length - vacant.length}/${real.length} 条绿`
    + (vacant.length ? `；**空判据/写坏**：${vacant.map((c) => c.id).join('、')}` : ''));
  for (const c of vacant) log('  ✖ 基线就红：', c.id, '→', c.problems(baseline).join(' | '));
  const counterproofs = [{id: 'selftest-baseline', check: '（全部判据）',
    desc: '判据对已知全绿的合成基线必须全绿（红 = 判据是空的）',
    ok: vacant.length === 0, hit: vacant.map((c) => c.id).join('、') || '（全绿）'}];
  for (const cp of COUNTERPROOFS) {
    const check = CHECKS.find((c) => c.id === cp.check);
    const facts = baselineFacts();
    cp.mutate(facts);
    const problems = check ? check.problems(facts) : ['（没有这条判据！）'];
    const hit = problems.length > 0;
    counterproofs.push({id: cp.id, check: cp.check, desc: cp.desc, ok: hit,
      hit: hit ? problems.join(' | ') : '（没命中——判据是空的！）'});
    log(hit ? '✔' : '✖', `[反证 ${cp.id}]`, '—', (hit ? problems.join(' | ') : '没命中').slice(0, 200));
  }
  return {baseline, vacant, counterproofs};
}

async function main() {
  const results = {checks: [], counterproofs: [], consoleErrors: [], steps: [], shots: []};
  mkdirSync(OUT, {recursive: true});
  log(`五分钟链路（RC-801 ②③）：预算 ${LIMIT_MS}ms · 分步预算之和 ${STEP_BUDGET_SUM}ms`);
  const {vacant, counterproofs} = runSelftest();
  results.counterproofs = counterproofs;
  if (SELFTEST_ONLY) {
    const hits = counterproofs.filter((c) => c.ok).length;
    log(`判据 0/0 通过；反证 ${hits}/${counterproofs.length} 命中（--selftest-only：没开浏览器）`);
    writeFileSync(REPORT, JSON.stringify({at: new Date().toISOString(), mode: 'selftest-only',
      counterproofs, vacant: vacant.map((c) => c.id)}, null, 1));
    process.exitCode = (hits === counterproofs.length && vacant.length === 0) ? 0 : 1;
    return;
  }
  if (!CHROME) throw new Error('找不到 Chrome（设 CHROME_BIN，或装 Google Chrome）');
  // 服务：外部给了就量外部那台（可能有模型臂）；没给就自起一台**离线**的（门禁走这条，
  // 与别的浏览器套件同一手法：`fetchImpl` 直接抛错 ⇒ 这一条链路上没有任何一次联网）。
  let server = null;
  let base = EXTERNAL_BASE;
  let mode = 'external';
  if (!base) {
    server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    mode = 'in-process-offline';
  }
  const probe = await fetch(`${base}/api/bootstrap`).then((r) => r.json()).catch(() => null);
  if (!probe) throw new Error(`${base} 上没有服务在跑（先 npm start 或 ./scripts/start.sh）`);
  log(`服务（${mode}）：${base} · model=${probe.model ?? '—'} provider=${probe.provider ?? '—'}`
    + ` rag=${probe.rag_mode ?? '—'} started_at=${probe.started_at ?? '—'}`);

  const browser = await launchChrome();
  const {cdp} = browser;
  let facts = null;
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      results.consoleErrors.push(oneLine(text, 300));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p?.exceptionDetails ?? {};
      const where = d.url ? ` @ ${String(d.url).replace(/^https?:\/\/[^/]+/, '')}:${(d.lineNumber ?? 0) + 1}` : '';
      results.consoleErrors.push(oneLine(d.exception?.description ?? d.text ?? '', 300) + where);
    });
    const driver = await makeDriver(cdp);
    // 焦点与视口：军师的主动提示那一层读 `document.hasFocus()`（见 roco.js 的 host.focus），
    // headless 默认没有焦点 ⇒ 不打开焦点模拟，这条判据量到的会是「提示被焦点门挡掉」，
    // 而不是这一条链路的真实耗时。
    await cdp.send('Page.bringToFront').catch(() => {});
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true}).catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false}).catch(() => {});
    log('① 真键鼠走链路：');
    facts = await collectFacts({cdp, driver, results, base, mode});
    // 时钟活体探针（判据「计时器是活的」的事实来源）
    const sleptAt = Date.now();
    await sleep(CLOCK_SLEEP_MS);
    facts.clock = {sleptMs: CLOCK_SLEEP_MS, measuredMs: Date.now() - sleptAt};
    log(`  ✔ clock-probe`, `睡 ${CLOCK_SLEEP_MS}ms / 量到 ${facts.clock.measuredMs}ms`);
  } finally {
    await browser.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  log('② 判据：');
  for (const check of CHECKS) {
    const problems = check.problems(facts);
    const row = {id: check.id, criterion: check.criterion, rule: check.rule, state: check.state,
      ok: problems.length === 0, problems: problems.map((p) => oneLine(p, 400)), actual: oneLine(check.actual(facts), 400)};
    results.checks.push(row);
    log(row.ok ? '✔' : '✖', `[${row.id}]`, `— ${row.actual}`);
    for (const p of row.problems) log('    ·', p);
  }
  const pass = results.checks.filter((c) => c.ok).length;
  const hits = results.counterproofs.filter((c) => c.ok).length;
  const table = STEPS.map((s, i) => `${String(i + 1).padStart(2)}. ${s.label}：${facts.steps[s.id]?.ms ?? '—'}ms / ${s.budgetMs}ms`)
    .join('\n');
  log(`\n分步耗时（真键鼠）：\n${table}\n总耗时 ${facts.totalMs}ms / 预算 ${LIMIT_MS}ms`);
  writeFileSync(REPORT, JSON.stringify({at: new Date().toISOString(), base, mode: 'live',
    pass, total: results.checks.length, counterproofs: `${hits}/${results.counterproofs.length}`,
    facts, checks: results.checks, counterproofRows: results.counterproofs}, null, 1));
  log(`报告：${REPORT.replace(`${ROOT}/`, '')}${WANT_SHOTS ? ` · 截图 ${facts.shots.filter(Boolean).length} 张在 reports/roco/five-minute-chain/` : ''}`);
  console.log(`五分钟链路：判据 ${pass}/${results.checks.length} 通过；反证 ${hits}/${results.counterproofs.length} 命中`);
  process.exitCode = (pass === results.checks.length && hits === results.counterproofs.length) ? 0 : 1;
}

await main();
