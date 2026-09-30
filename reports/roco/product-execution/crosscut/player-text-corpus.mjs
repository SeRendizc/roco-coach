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
 *   · **可移植**：路径全部相对本文件解析，不写死机器路径；
 *   · **只收「玩家可见字段」，整对象 walk 是错的**（2026-10-01 实测两个坑）：
 *       ① `makeQuiz`/`practiceQuestion` 的 `id`/`sourceId`/`variantOf` 里带 `pet_000118` 这类**内部 id**
 *          —— 整对象 walk 会把它当文案收进来，制造**假** `internal-id` 命中（不是产品缺陷）；
 *       ② `coachContext` 这种上下文字典带时间戳（`…16.100Z`），会被 `precision` 判据误报。
 *       所以每个渲染器都**逐字段点名**（题干/讲解/依据/选项/正文），不写通用 walk。
 *   · **0 覆盖 = 失败**（文件末尾的 `CORPUS_PRODUCERS` + `auditProducerCoverage`）：
 *       曾经 `practiceQuestion` 渲染器 `return` 的是**对象**，而 `add()` 只收字符串/字符串数组
 *       ⇒ 它在 `byApi` 里**根本不存在**，而没有任何判据会红（「假覆盖」）。现在登记表 + 审计
 *       把「静默 0 条」变成**器材自己报错**，不靠人记得检查。
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
 * **已登记的生产者**：每一个都必须至少贡献 `min` 条字符串（`prefix:true` 时按「api 前缀」计，
 * 例：`makeQuiz(v0..v5)` 记在 `makeQuiz` 名下）。
 *
 * 为什么要有这张表（2026-10-01，Lead 裁决）：`practiceQuestion` 渲染器曾经 `return` 对象、
 * 被 `add()` **静默丢掉** ⇒ 这条关键生产者在门禁里根本不存在，而且**没有任何判据会红**。
 * 光补数据治不了根：**要让 0 覆盖本身变成失败**。所以 `collectCorpus()` 结束时跑审计，
 * 有登记却没贡献 ⇒ 直接抛错（`strict:true`，默认）；CLI 也据此 exit 1。
 */
export const CORPUS_PRODUCERS = Object.freeze([
  { api: 'reviewMatch', min: 1 },
  { api: 'matchStatsLine', min: 1 },
  { api: 'compareTurnAlternatives', min: 1 },
  { api: 'practiceQuestion', min: 1 },
  { api: 'makeQuiz', min: 6, prefix: true },
  { api: 'attentionText', min: 1 },
  { api: 'hoverLabel', min: 1 },
  { api: 'skillLesson', min: 4, prefix: true },
  { api: 'lessonFor', min: 1 },
  { api: 'chatReply', min: 1 },
  { api: 'memoryItems', min: 1 },
  { api: 'memorySummary', min: 1 },
  { api: 'transferAssessment', min: 1 },
  { api: 'coachSelfAudit', min: 1 },
  { api: 'adviceComparisonReport', min: 1 },
  { api: 'proactiveText', min: 1, prefix: true },
  { api: 'indistinguishableAdviceText', min: 1 },
  { api: 'rulesSections', min: 1 },
  // task-42（第三刀）：知识卡正文（title / principle / counterexample）——47+44 张卡共 ~270 条。
  // 下限 20 只是"不许静默消失"的门槛；**只收玩家可见字段**（`id`/`sourceId`/`variantOf` 含
  // `pet_000118` 这类内部 id，整对象 walk 会制造假 `internal-id`；`keywords` 是检索别名，见下）。
  { api: 'knowledgeCards', min: 20 },
]);

/**
 * **允许 0 条的渲染调用**：它们要么是别条渲染器的**输入**（返回对象），要么设计上返回 null，
 * 要么**取决于局面**（真为 null 不是被丢）。每一条都要写清理由 —— 没写理由的调用会在审计里
 * 落进 `unregistered`（同样报错），这样「新增一个渲染器但忘了登记」也躲不过去。
 */
export const OPTIONAL_PRODUCERS = Object.freeze([
  { api: 'summarizeMatch', why: '返回对象，是 reviewMatch/matchStatsLine 的输入（不直接给玩家）' },
  { api: 'observe(mid)', why: '返回对象，是 lessonFor/attentionText 的输入' },
  { api: 'rememberBattle', why: '设计上返回 null（只为构造 memory）' },
  { api: 'decisiveOpportunity(mid)', why: '取决于局面：这一组夹具确实没有收尾机会（null = 真的没有，不是被丢）' },
  { api: 'companionFacts', why: '返回对象，是 proactiveText/chatReply 的输入' },
  { api: 'coachContext', why: '返回对象；整对象含时间戳与内部字段（实测 `…16.100Z` 会被 precision 误报），只作输入' },
  { api: 'companionSignals', why: '返回对象，是 proactiveText 的输入' },
]);

/** 一条调用的计数：`prefix:true` 按前缀汇总（`makeQuiz(v0)` → `makeQuiz`）。 */
export function producerCounts(entries) {
  const counts = {};
  for (const entry of entries) {
    const api = String(entry?.api ?? '');
    const base = api.includes('(') ? api.slice(0, api.indexOf('(')) : api;
    counts[api] = (counts[api] ?? 0) + 1;
    if (base !== api) counts[base] = (counts[base] ?? 0) + 1;
  }
  return counts;
}

/**
 * 覆盖审计：**登记的生产者必须够数；出现过的调用必须登记过**（登记表或可选表）。
 * @returns {{ok:boolean, counts:object, missing:{api:string,min:number,got:number}[], unregistered:string[]}}
 */
export function auditProducerCoverage({ entries = [], attempted = [] } = {}) {
  const counts = producerCounts(entries);
  const missing = CORPUS_PRODUCERS
    .map((row) => ({ api: row.api, min: row.min, got: counts[row.api] ?? 0 }))
    .filter((row) => row.got < row.min);
  const known = new Set([...CORPUS_PRODUCERS.map((r) => r.api), ...OPTIONAL_PRODUCERS.map((r) => r.api)]);
  const unregistered = [...new Set(attempted)].filter((api) => !known.has(api) && !known.has(api.replace(/\(.*$/, '')));
  return { ok: missing.length === 0 && unregistered.length === 0, counts, missing, unregistered };
}

/**
 * 渲染语料。
 * @param {{strict?:boolean}} [options] `strict:true`（默认）时，覆盖审计不过就抛错 —— 器材自己红。
 * @returns {Promise<{entries:{file:string,api:string,text:string}[], failures:{api:string,err:string}[], coverage:object}>}
 */
export async function collectCorpus({ strict = true } = {}) {
  const engine = await imp('src/game/engine.js');
  const teacher = await imp('src/coach/teacher.js');
  const experience = await imp('src/coach/experience.js');
  const memoryMod = await imp('src/coach/memory.js');
  const companionMod = await imp('src/coach/companion.js');
  const sessionMod = await imp('src/coach/session.js');
  const progression = await imp('src/game/progression.js');
  const runtimeMod = await imp('src/coach/runtime.js');
  const rulesMod = await imp('src/game/rules.js');
  const contentMod = await imp('src/game/content.js');

  const entries = [];
  const failures = [];
  const attempted = [];
  const add = (file, api, text) => {
    if (typeof text === 'string' && text.trim()) entries.push({ file, api, text });
    else if (Array.isArray(text)) text.forEach((t) => add(file, api, t));
  };
  const tryRender = (api, file, fn) => {
    attempted.push(api);
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
    tryRender('compareTurnAlternatives', 'teacher.js:491', () => {
      const turns = (g.history || []).filter((x) => x?.type === 'turn');
      const h = turns[1] || turns[0];
      const r = h ? teacher.compareTurnAlternatives(h) : null;
      // 玩家可见字段：每个回合的差值句 / 「怎么读」 / 单回合完整句（`rows`/`gap` 是内部估值，不收）
      return r ? [r.line, r.rule, r.text].filter((x) => typeof x === 'string') : null;
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
      tryRender('lessonFor', 'experience.js:50', () => {
        const L = experience.lessonFor(hint);
        // 玩家可见字段：题干 / 两个选项 / 讲解（`id` 是内部标签，不收）
        return L ? [L.question, L.yes, L.no, L.explanation].filter((x) => typeof x === 'string') : null;
      });
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
  tryRender('coachSelfAudit', 'memory.js:236', () => {
    const row = memoryMod.coachSelfAudit?.(mem);
    // 玩家在记忆面板里读到的是这一句「接下来怎么办」（其余是计数与证据 id，不收）
    return row ? [row.action].filter((x) => typeof x === 'string') : null;
  });

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
      tryRender('chatReply', 'companion.js:1886', () => {
        const r = companionMod.chatReply({ message: '你好', memory: mem, facts, intent: 'chat' });
        // 玩家读到的就是 `text`（`parts`/`evidence` 是内部拼装件，不收）
        return r ? [r.text].filter((x) => typeof x === 'string') : null;
      });
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
  tryRender('adviceComparisonReport', 'runtime.js:2154', () => {
    const r = runtimeMod.adviceComparisonReport(BATTLE);
    // 玩家可见字段：`detail`（「有对照 / 只给了首选，没有与任何替代对照」那一句）。
    // ⚠ 它返回的是**对象**（`text`/`headline`/`lines` 都不存在）—— 旧渲染器正是因此静默 0 条。
    if (typeof r === 'string') return r;
    return r ? [r.detail].filter((x) => typeof x === 'string') : null;
  });
  tryRender('indistinguishableAdviceText', 'runtime.js', () => runtimeMod.indistinguishableAdviceText?.(BATTLE));

  // 规则页（`src/game/rules.js` 的 `rulesSections()`）：玩家能直接点开读的说明文本，
  // 也是「同一事实两种叫法」的高发区 —— task-36 之前它自己另写了一份「HP / 豆 / 生命」。
  // 收进语料，第 5 类判据（退役单位词）才能覆盖到它。
  tryRender('rulesSections', 'rules.js', () => {
    const sections = rulesMod.rulesSections?.() ?? [];
    return sections.flatMap((s) => (Array.isArray(s?.lines) ? s.lines : [])).filter((x) => typeof x === 'string');
  });

  // 知识卡（`src/game/content.js` 的 `TACTIC_CARDS` / `REFERENCE_CARDS`）：小芽检索到的规则卡，
  // 玩家在回答的「依据」里读得到 —— task-42（第三刀）的对象。
  // ⚠ 只收**玩家可见的三段正文**（title / principle / counterexample）：
  //   · `id`/`sourceId`/`variantOf` 含 `pet_000118` 这类内部 id ⇒ 整对象 walk 会制造**假** `internal-id`；
  //   · `keywords` 是**检索别名**（`src/coach/rag-index.js:981` 把 `card.keywords` 当 `aliases`），
  //     不是给玩家读的正文；而且它按 Lead 裁决**有意保留**旧说法「豆」⇒ 收进来会让第 5 类判据误报。
  tryRender('knowledgeCards', 'content.js', () => {
    const cards = [...(contentMod.TACTIC_CARDS ?? []), ...(contentMod.REFERENCE_CARDS ?? [])];
    return cards.flatMap((c) => [c?.title, c?.principle, c?.counterexample]).filter((x) => typeof x === 'string');
  });

  const coverage = auditProducerCoverage({ entries, attempted });
  if (!coverage.ok && strict) {
    const missing = coverage.missing.map((r) => `${r.api}(登记≥${r.min}，实际 ${r.got})`).join(' · ') || '（无）';
    const unknown = coverage.unregistered.join(' · ') || '（无）';
    throw new Error(
      `语料覆盖审计不过：登记却没贡献够的生产者=${missing}；出现过但没登记的渲染调用=${unknown}。`
      + '（「静默 0 条」= 这条生产者在门禁里不存在，而没有任何判据会红 —— 所以这里直接失败；'
      + '确属可选/纯输入的调用请登记进 OPTIONAL_PRODUCERS 并写明理由。）');
  }
  return { entries, failures, coverage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result = null;
  let auditFailed = false;
  try {
    result = await collectCorpus();
  } catch (error) {
    // 覆盖审计不过 ⇒ 器材自己红：把读数打全，再以非零码退出
    auditFailed = true;
    result = await collectCorpus({ strict: false });
    console.log(String(error?.message || error));
  }
  const { entries, failures, coverage } = result;
  const byApi = {};
  for (const e of entries) byApi[e.api] = (byApi[e.api] ?? 0) + 1;
  const producers = new Set(entries.map((e) => e.file.split(':')[0]));
  console.log(`语料条目=${entries.length} | 生产者文件=${producers.size} | 失败渲染器=${failures.length}`);
  console.log('按 API：' + Object.entries(byApi).map(([k, v]) => `${k}×${v}`).join(' · '));
  if (failures.length) console.log('失败渲染器：' + failures.map((f) => `${f.api}(${f.err})`).join(' | '));
  console.log(`覆盖审计：${coverage.ok ? 'ok' : '**不过**'}（登记生产者 ${CORPUS_PRODUCERS.length} 个 · 可选 ${OPTIONAL_PRODUCERS.length} 个）`);
  if (!coverage.ok) {
    for (const row of coverage.missing) console.log(`  ✖ 登记却没贡献够：${row.api}（min ${row.min}，实际 ${row.got}）`);
    for (const api of coverage.unregistered) console.log(`  ✖ 出现过但没登记：${api}`);
  }
  process.exitCode = auditFailed || !coverage.ok ? 1 : 0;
}
