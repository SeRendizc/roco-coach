/**
 * 玩家可见文本的**可复跑语料器材**（task-33；来源：`player-text-audit.md` 的 91 条渲染语料）。
 *
 * 用法：
 *   · 直接跑（打印语料统计）：`node reports/roco/product-execution/crosscut/player-text-corpus.mjs`
 *   · 被门禁判据引用：`import {collectCorpus} from '../reports/roco/product-execution/crosscut/player-text-corpus.mjs'`
 *
 * 为什么要有它：审计的结论是"**只 grep 源码会漏掉运行期拼出来的句子**"，
 * 所以这一类缺陷的判据必须建立在**真渲染**出来的字符串上。本文件只做"渲染 + 收集"，**不做判定**
 * （判定在 `tests/roco-player-text-gate.test.js`，那里还负责非恒真自证）。
 *
 * 纪律：
 *   · **只读**：不写任何文件、不绑端口、不启动服务；
 *   · **确定性**：对局由固定种子（1/3/17）真跑，没有随机、没有时间依赖；
 *   · **可移植**：路径全部相对本文件解析，不写死机器路径。
 */
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../../../../', import.meta.url);            // <repo>/
const imp = (rel) => import(new URL(rel, ROOT).href);

/** 引擎真跑一局（与 `tests/copy.test.js` 的 playMatch 同形）。 */
function playMatch(engine, seed) {
  let g = { ...engine.createGame(seed), id: `corpus-${seed}` };
  for (let i = 0; i < 80 && !g.result; i++) {
    const all = engine.legalActions(g);
    const skills = all.filter((a) => a.kind === 'skill');
    const list = skills.length ? skills : all;
    const pick = list[(seed + i) % list.length];
    if (!pick) break;
    g = engine.step(g, pick);
  }
  return g;
}

/** 局中状态（前 4 手）：`skillLesson`/`observe` 这类只在**进行中**的对局里才有输出。 */
function playSteps(engine, seed, steps) {
  let g = { ...engine.createGame(seed), id: `corpus-mid-${seed}` };
  for (let i = 0; i < steps && !g.result; i++) {
    const all = engine.legalActions(g);
    const skills = all.filter((a) => a.kind === 'skill');
    const list = skills.length ? skills : all;
    const pick = list[(seed + i) % list.length];
    if (!pick) break;
    g = engine.step(g, pick);
  }
  return g;
}

const SEEDS = [1, 3, 17];

/**
 * 渲染语料。
 * @returns {Promise<{entries: {file:string, api:string, text:string}[], failures:{api:string,err:string}[]}>}
 */
export async function collectCorpus() {
  const engine = await imp('src/game/engine.js');
  const teacher = await imp('src/coach/teacher.js');
  const experience = await imp('src/coach/experience.js');
  const memoryMod = await imp('src/coach/memory.js');
  const companionMod = await imp('src/coach/companion.js');
  const sessionMod = await imp('src/coach/session.js');
  const progression = await imp('src/game/progression.js');
  const runtimeMod = await imp('src/coach/runtime.js');
  const rulesMod = await imp('src/game/rules.js');

  const entries = [];
  const failures = [];
  const add = (file, api, text) => {
    if (typeof text === 'string' && text.trim()) entries.push({ file, api, text });
    else if (Array.isArray(text)) text.forEach((t) => add(file, api, t));
  };
  const tryRender = (api, file, fn) => {
    try { const v = fn(); add(file, api, v); return v; } catch (e) { failures.push({ api, err: String(e?.message || e) }); return null; }
  };

  const games = SEEDS.map((s) => playMatch(engine, s));
  const midGames = SEEDS.map((s) => playSteps(engine, s, 4));
  const summaries = games.map((g) => tryRender('summarizeMatch', 'teacher.js:156', () => teacher.summarizeMatch(g)));

  summaries.forEach((m, idx) => {
    if (!m) return;
    const g = games[idx];
    tryRender('reviewMatch', 'teacher.js:245', () => {
      const packet = teacher.reviewMatch({ lastMatch: m });
      return [packet.brief, packet.text, ...(packet.evidence || []), ...(packet.choices || [])];
    });
    tryRender('matchStatsLine', 'teacher.js:237', () => teacher.matchStatsLine(m));
    tryRender('compareTurnAlternatives', 'teacher.js:473', () => {
      const turns = (g.history || []).filter((x) => x?.type === 'turn');
      const h = turns[1] || turns[0];
      return h ? teacher.compareTurnAlternatives(h) : null;
    });
    tryRender('practiceQuestion', 'teacher.js:434', () => {
      const d = teacher.keyDecisionOf?.(m) ?? m.keyDecision;
      const q = teacher.practiceQuestion({ keyDecision: d, variant: 1 });
      // ⚠ 2026-10-01（task-40 / Lead 裁决 Q5）：这里原来**直接返回对象**，而下面的 `add()` 只收
      //   字符串与字符串数组 ⇒ 这一条**静默贡献 0 条语料**（`byApi` 里根本没有 `practiceQuestion`）。
      //   现在按"玩家真的看得到的那几段"展开：题干 / 讲解 / 课程句 / 选项。
      return q ? [q.question, q.explanation, q.lesson, ...(q.choices || [])].filter((x) => typeof x === 'string') : null;
    });
  });

  // 出题（07：问答老师的小测）—— `makeQuiz` 的题干/讲解/依据都是玩家可见文本。
  // 六档变式全渲染：题干模板相同、数字不同，正是"运行期拼出来的句子"那一类。
  // 为什么收进语料（2026-10-01，Lead 裁决 Q5）：07 要改题面/讲解，改之前它必须在门禁视野内，
  // 否则新文案是「门外文案」（`grep makeQuiz` 在本文件里当时是 0 命中）。
  const quizPanel = {id: 'pet_000118', name: '皇家狮鹫', speed: 120, source: '语料夹具'};
  const quizContext = {mode: 'camp', battle: null, profile: {pets: [
    {id: 'pet_000118', name: '皇家狮鹫', types: ['风系'], stats: {hp: 107, atk: 116, def: 127, spa: 69, spd: 65, spe: 120}}]}};
  for (let v = 0; v < 6; v++) {
    tryRender(`makeQuiz(v${v})`, 'teacher.js:79', () => {
      const q = teacher.makeQuiz(quizContext, {variant: v, panel: quizPanel});
      return q ? [q.question, q.explanation, q.lesson, ...(q.evidence || [])].filter((x) => typeof x === 'string') : null;
    });
  }

  // 局中：老师技能课 / 提示 / 悬停标签
  midGames.forEach((g) => {
    const hint = tryRender('observe(mid)', 'experience.js:12', () => experience.observe(g));
    if (hint) {
      tryRender('lessonFor', 'experience.js:50', () => experience.lessonFor(hint));
      const act = engine.legalActions(g).find((a) => a.kind === 'skill');
      if (act) tryRender('attentionText', 'experience.js:113', () => experience.attentionText(g, act));
    }
    tryRender('decisiveOpportunity(mid)', 'experience.js:380', () => experience.decisiveOpportunity(g));
    tryRender('hoverLabel', 'experience.js:637', () => experience.hoverLabel(g, null));
    engine.legalActions(g).filter((a) => a.kind === 'skill').forEach((a) => {
      tryRender(`skillLesson(${a.id})`, 'teacher.js:116', () => {
        const L = teacher.skillLesson(g, a);
        return L ? [L.text, ...(L.evidence || [])] : null;
      });
    });
  });

  // 记忆面（玩家在记忆面板里逐条看得到）
  let mem = memoryMod.freshMemory();
  tryRender('rememberBattle', 'memory.js:104', () => { mem = memoryMod.rememberBattle(mem, games[0]); return null; });
  tryRender('memoryItems', 'memory.js:726', () => memoryMod.memoryItems(mem).map((r) => r.label ?? r.text ?? ''));
  tryRender('memorySummary', 'memory.js', () => memoryMod.memorySummary?.(mem));
  tryRender('transferAssessment', 'memory.js:216', () => {
    const t = memoryMod.transferAssessment(mem, Object.keys(mem.reflections || {})[0] || '先手');
    return t ? [t.label, t.status, t.reason].filter((x) => typeof x === 'string') : null;
  });
  tryRender('coachSelfAudit', 'memory.js', () => memoryMod.coachSelfAudit?.(mem));

  // 陪练（裸插值最多的那一族）
  games.forEach((g) => {
    const facts = tryRender('companionFacts', 'companion.js', () => companionMod.companionFacts(mem, { mode: 'camp' }, Date.now()));
    const ctx = tryRender('coachContext', 'session.js', () => sessionMod.coachContext(g, progression.newProfile(), mem));
    if (ctx) {
      const signals = tryRender('companionSignals', 'companion.js', () => companionMod.companionSignals(g));
      const bundle = { ...ctx, turn: g.turn ?? 1, signals, cross: companionMod.companionLedger(mem, g, Date.now()) };
      ['result', 'first-faint', 'habit', 'late-night', 'long-session'].forEach((ev) => {
        tryRender(`proactiveText(${ev})`, 'companion.js', () => companionMod.proactiveText(ev, bundle, companionMod.eventRegister(ev, { lossStreak: 0 })));
      });
    }
    if (facts) {
      tryRender('chatReply', 'companion.js', () => companionMod.chatReply({ message: '你好', memory: mem, facts, intent: 'chat' }));
    }
  });

  // 建议对照（含"分不出来"那条）
  const BATTLE = {
    phase: 'battle', turn: 2, result: null, self_active: 0,
    self: [{ name: '多彩方方', hp: 566, max_hp: 566, energy: 9, alive: true, types: ['机械系'] },
      { name: '缇塔', hp: 508, max_hp: 508, energy: 10, alive: true, types: ['机械系'] }],
    foe: [{ name: '迪莫', hp: 425, max_hp: 425, energy: 9, alive: true, types: ['光系'] }],
    foe_bench: [],
    legal: [{ kind: 'skill', label: '齿轮扭矩', skill: { name: '齿轮扭矩', energy: 3, power: 80, element: '机械系' } },
      { kind: 'skill', label: '防御', skill: { name: '防御', energy: 0, power: 0, element: '普通系' } },
      { kind: 'switch', label: '换上第2位' }],
  };
  tryRender('adviceComparisonReport', 'runtime.js', () => {
    const r = runtimeMod.adviceComparisonReport(BATTLE);
    return typeof r === 'string' ? r : [r?.text, r?.headline, ...(r?.lines || [])].filter(Boolean);
  });
  tryRender('indistinguishableAdviceText', 'runtime.js', () => runtimeMod.indistinguishableAdviceText?.(BATTLE));

  // 规则页（`src/game/rules.js` 的 `rulesSections()`）：玩家能直接点开读的说明文本，
  // 也是「同一事实两种叫法」的高发区 —— task-36 之前它自己另写了一份「HP / 豆 / 生命」。
  // 收进语料，第 5 类判据（退役单位词）才能覆盖到它。
  tryRender('rulesSections', 'rules.js', () => {
    const sections = rulesMod.rulesSections?.() ?? [];
    return sections.flatMap((s) => (Array.isArray(s?.lines) ? s.lines : [])).filter((x) => typeof x === 'string');
  });

  return { entries, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { entries, failures } = await collectCorpus();
  const byApi = {};
  for (const e of entries) byApi[e.api] = (byApi[e.api] ?? 0) + 1;
  const producers = new Set(entries.map((e) => e.file.split(':')[0]));
  console.log(`语料条目=${entries.length} | 生产者文件=${producers.size} | 失败渲染器=${failures.length}`);
  console.log('按 API：' + Object.entries(byApi).map(([k, v]) => `${k}×${v}`).join(' · '));
  if (failures.length) console.log('失败渲染器：' + failures.map((f) => `${f.api}(${f.err})`).join(' | '));
}
