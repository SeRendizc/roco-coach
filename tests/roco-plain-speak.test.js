/**
 * 判据：**说人话**（人类 2026-09-26：「这是个系统工程，不只是那个按钮；全部小芽都应该说人话，不应该自娱自乐」）。
 *
 * 规范在 `docs/roco/PLAIN-SPEAK.md`（八条规则 + 三层执行）。这份判据管**静态那一层**：
 * 扫"玩家可见文案"（剥注释、只取中文字符串字面量），对**硬禁词**计数并钉死。
 *
 * 为什么分两档：
 *   · **硬禁词**：今天已经是 0，所以要求**恒为 0**（回退即红）；
 *   · **欠账**：`src/coach/runtime.js` 里还有一批工程语气的本地事实回答，**计数只许降不许升**
 *     （棘轮：改小是成绩，改大必须在这份判据里写明理由）。
 * 这样"系统工程"才有牙齿：不靠人记得，靠判据挡。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TOOL_CONTRACTS} from '../src/coach/toolbox.js';
import {splitEvidence, playerEvidence} from '../src/client/evidence-view.js';
import {plain} from '../src/client/plain-text.js';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** 玩家可见文案的宿主文件（面板、聊天、教练回答）。 */
const FILES = ['src/server/roco-service.js', 'src/coach/runtime.js', 'src/coach/teacher.js',
 'src/coach/strategist.js', 'src/client/team-workshop.js', 'src/client/xiaoya.js', 'src/client/roco.js',
 // 2026-09-26 第 51 轮扩进来：静态页面文案（HTML 文本节点）也是玩家读的。
 // `toolbox.js` 刻意**不**进这份清单：它的中文串是给规划器的工具说明与错误码，不是玩家文案。
 // 2026-09-27：`nurture.html` 已整页退役（加点不要了）⇒ 从扫描清单里去掉。
 'src/client/roco.html', 'src/client/index.html', 'src/client/box.html', 'src/client/xiaoya.html',
 // 2026-09-27（审计 ②：**判据白名单漏了这三个**）：营地页、盒子页、练习页的**页面代码**
 // 也在拼玩家文案，一直没被扫过 —— 实测漏出 4 条（`box.js` 的「本仓库」、`nurture.js` 的
 // 「口径」与两个 `src/game/*.js` 路径；都是玩家点得到的）。补进来之后那 4 条当场红、已逐条改掉。
 'src/client/app.js', 'src/client/box.js'];
// 2026-09-27（审计 ②）：**词表搬到 `src/coach/plain-words.js`** —— 判据、真机探针
//（`scripts/roco/probe-answer-speak.mjs`）、移动端总扫（`browser-mobile-sweep.mjs`）三处
// 用的是同一份。词表写两份必然漂（这一轮就是靠"三处各写一份"才发现漏了两个词）。
import {BANNED_WORDS as BANNED, ENGINEER_TONE_WORDS as SOFT_WORDS, speakHits} from '../src/coach/plain-words.js';

/**
 * **欠账**（2026-09-26 实测），按文件钉住，只许减不许增：
 * 面板、三个渲染点、`roco-service.js`、`teacher/strategist/xiaoya/roco` 都已经**清零**；
 * 剩下的全在 `src/coach/runtime.js` —— 那是教练自己的回答与「依据」区（玩家展开能看到），
 * 里面还留着工程语气（`Σ(levelXpCost(...))`、`src/coach/memory.js`、「回执/判据/台账」这类）。
 * 逐条改由两份清单驱动：`/tmp/plain-speak/report.md`（静态扫描）与
 * `/tmp/answer-speak/report.md`（真机回答审计）。每改一条就把下面的数字调小。
 */
const DEBT = {
 // 2026-09-27（审计 ②）：**13 → 3**。这一轮把玩家读得到的那 10 条逐条改成人话：
 // 手游加点那条的「口径」、换宠/补位/技能数量三处的「本仓」、组队那条的「本仓战术卡/口径」、
 // 相性那条的「口径」、练习记录那条的「口径」、天气两条的「口径/policies.weather_policy/台账 EV-…」、
 // 依据栏那句「证据包里的条目」，以及三处被**丢掉的 `src()` 第二参数**（出处句退化成空标签）。
 // 剩下 3 条**只出现在两处写给模型看的槽位**（不是玩家文案）：
 //   · `:252` 一条 `evidence` 条目（`EV-ENERGY-MAX…ENGINE_HYPOTHESIS`）—— 按规范第三节的例外，
 //     折叠区里的"原始数值与说明"允许保留内部 id 与等级枚举，正文不许；
 //   · `:2574`/`:2584` 是**整改指令**（模型答错时回给模型的纠错词），玩家看不到这一份。
 // 判据这一层还分不出"玩家槽位"与"提示槽位"，所以用这个数字把**新增**挡住。
 //
 // 2026-09-27 同日再加 `.js` 之后：`runtime.js` **3 → 8**，多出来的 5 条**全在 `evidence`
 // （依据区）**—— `lineups.json`（手游加点那条的依据）、`engine.js` 两条（换宠/补位两条事实的
 // 出处）、`learnsets.json`（可学性那条的依据）、`engine.js createGame`（种子那条的依据）。
 // 它们是"这条事实从哪来"的凭据，按规范第三节的例外留在折叠区；**正文里的 6 处同名写法
 // 这一轮全部改掉了**（`pets.json`/`skills.json`/`types.json`/`battle-modes.json`/`weather_policy`
 // /`TYPE_ADVANTAGES`），并由行为级判据 ⑩ 盯着（它扫的是**真的回答正文**，不是源码）。
 // 同日再 +1（8 → 9）：换人对比那条边界的**出处**从 `reason`（给人/模型读的那句）挪到
 // `source` 字段之后，文件名出现在 `source` 里 —— 那正是"可回查"该待的地方。
 hard: {'src/coach/runtime.js': 9, 'src/client/roco.js': 1},
 // 2026-09-26 第 50 轮：`runtime.js` 的工程语气由 **33 → 19**（改的都是**玩家可见**的：
 // 证据行里的「没有回执」×5、「模型回答与工具回执不一致」这类降级说明、学习进度那条里的
 // 「门槛常量 QUIZ_MASTERY 与判据同源」、以及三条速度线的「引擎 roster 回执」）。
 // 2026-09-27（审计 ②）：**19 → 15**。改掉的是 `predictionScaffold()` 的四栏
 //（「工具回执」「证据包里的条目」「规则常量」×2）—— 它们是模型包里的"手里有什么"，
 // 模型会照抄进给玩家的回答，所以换成玩家也读得懂的说法（意思不变）。
 // 剩下的 15 条全在**提示词/纠错词/内部诊断字段**里（`FACT_DRAFT`、整改指令、影子记录、
 // `rejectedModelReasons` 的说明），不是玩家文案。
 soft: {'src/coach/runtime.js': 15, 'src/server/roco-service.js': 2, 'src/coach/strategist.js': 1},
};
/**
 * **HTML 文本节点**的欠账（2026-09-27 审计 ② 补的第三个洞）：
 * 原来只查 HTML 里的字面 `**`（判据 ⑥），文本节点里的工程词一个都不看 ——
 * `roco.html:774/793` 的「用户口径 D5」「工程口径」就是这么漏过去的（玩家点开抽屉就读到）。
 * 现在两类词都扫；实测全部 7 个 HTML 文本节点 **0 命中**，所以允许值就是 **0**（没有欠账）。
 */
const HTML_DEBT = {hard: {}, soft: {}};
/** 这一份判据扫的是"玩家可见文案"的**字面量**（剥注释、只取中文字符串）。 */
const visible = (source) => source
 .replace(/\/\*[\s\S]*?\*\//g, '')
 .replace(/<!--[\s\S]*?-->/g, '')
 .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
/** 中文字符串字面量（反引号/单引号/双引号三种），注释已剥。 */
function literals(source) {
 const out = [];
 for (const [index, line] of visible(source).split('\n').entries()) {
  if (/^\s*\*/.test(line)) continue;
  for (const match of line.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)) {
   const text = match[1] ?? match[2] ?? match[3] ?? '';
   if ((text.match(/[\u4e00-\u9fa5]/g) ?? []).length >= 4) out.push({line: index + 1, text});
  }
 }
 return out;
}
/**
 * HTML 的**文本节点**：标签之间、玩家在页面上真的读到的那些字（注释不算，属性不算）。
 * 单独抽成函数是为了让反证能拿违例样本过**同一份**判据（而不是另写一份扫描）。
 */
export function htmlTextNodes(source) {
 return [...String(source).replace(/<!--[\s\S]*?-->/g, '').matchAll(/>([^<>]+)</g)]
  .map((match) => match[1].replace(/\s+/g, ' ').trim()).filter((node) => node.length > 0);
}

test('① 硬禁词：除已登记的欠账外，玩家可见文案里一个都不许有（含反证）', () => {
 const hits = {}, counts = {};
 for (const file of FILES) {
  for (const {line, text} of literals(readFileSync(join(ROOT, file), 'utf8'))) {
   for (const word of BANNED) {
    if (!text.includes(word)) continue;
    counts[file] = (counts[file] ?? 0) + 1;
    if ((counts[file] ?? 0) > (DEBT.hard[file] ?? 0)) hits[`${file}:${line}`] = `「${word}」 ${text.slice(0, 60)}`;
   }
  }
 }
 const bad = Object.entries(hits).map(([where, what]) => `${where} ${what}`);
 assert.deepEqual(bad, [], `玩家可见文案里的硬禁词超出了已登记的欠账（只许减）：\n${bad.join('\n')}`);
 // 反证：这份扫描必须真的能抓到（否则上面那条是"什么都没查"）
 assert.ok(literals("const x = '本仓库没有这一项';\n").some((item) => item.text.includes('本仓')),
  '扫描器必须能抓到样本');          // 2026-09-27：样本从 `本仓库` 换成 `本仓`（超集，删了窄的那条）
 assert.ok(literals("const x = '本仓引擎里一共 3 个技能';\n").some((item) => item.text.includes('本仓')),
  '裸的「本仓」也必须抓到（这一轮实测它在玩家眼前出现过）');
});

test('② 工程语气的欠账只许降（棘轮）', () => {
 for (const file of FILES) {
  const hits = literals(readFileSync(join(ROOT, file), 'utf8'))
   .filter(({text}) => SOFT_WORDS.some((word) => text.includes(word)));
  const allowed = DEBT.soft[file] ?? 0;
  assert.ok(hits.length <= allowed,
   `${file} 的工程语气从 ${allowed} 涨到了 ${hits.length}（只许减）：\n`
   + hits.slice(0, 6).map((hit) => `  :${hit.line} ${hit.text.slice(0, 60)}`).join('\n'));
 }
});

test('③ 工具名映射：每个工具都要有中文名，两处表不许漂（审计点名：只覆盖 13 个里的 8 个）', () => {
 // 「小芽查了什么」是玩家可见的（`app.js` 与 `xiaoya.js` 各有一张映射表）。
 // 漏一个键的后果：玩家在那一栏里看到 `evaluate_team` 这种英文 id。
 const keys = (source) => {
  const match = source.match(/const names\s*=\s*\{([\s\S]*?)\};/) ?? source.match(/names=\{([\s\S]*?)\};/);
  return match ? [...match[1].matchAll(/([a-z_]+)\s*:/g)].map((m) => m[1]).sort() : [];
 };
 const app = keys(readFileSync(join(ROOT, 'src/client/app.js'), 'utf8'));
 const xiaoya = keys(readFileSync(join(ROOT, 'src/client/xiaoya.js'), 'utf8'));
 assert.ok(app.length >= 10, `app.js 的映射表要能被解析出来（实际 ${app.length} 个键）`);
 assert.deepEqual(app, xiaoya, '两张表必须覆盖同一批工具（否则一处改了另一处漂）');
 // 与工具合同同源：合同里有、映射里没有 ⇒ 红
 const contracted = Object.keys(TOOL_CONTRACTS).sort();
 const missing = contracted.filter((tool) => !app.includes(tool));
 assert.deepEqual(missing, [], `这些工具没有中文名，玩家会看到英文 id：${missing.join('、')}`);
 // 兜底也不许把英文 id 端出去
 for (const file of ['src/client/app.js', 'src/client/xiaoya.js']) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  assert.doesNotMatch(source, /names\[receipt\.tool\]\s*(\?\?|\|\|)\s*receipt\.tool/,
   `${file} 的兜底不许回落到英文工具 id`);
 }
});

test('③b 降级说明（`fallbackReason`，玩家可见）不许带工程语气', () => {
 // `fallbackReason` 会随回执直接显示给玩家（"为什么这次给的是引擎那份"）。
 // 它原来写的是「模型回答与工具回执不一致，显示已核验的本局分析」—— 玩家不懂"回执"。
 const source = readFileSync(join(ROOT, 'src/coach/runtime.js'), 'utf8');
 const reasons = [...source.matchAll(/fallbackReason:[\s\S]{0,400}?undefined/g)].map((m) => m[0]).join('\n');
 assert.ok(reasons.length > 0, '要能取到 fallbackReason 那一段');
 for (const word of ['回执', '判据', '台账', '兜底', '归一化', '白名单']) {
  assert.ok(!reasons.includes(word), `降级说明里不该出现「${word}」（玩家读不懂）`);
 }
 assert.match(reasons, /那份回答和引擎的记录对不上|模型输出过长|不知道/, '要能认出这几句人话');
});

test('④ 状态提示要有可见落点（审计的"静默黑洞"）：不许再写向已删除的元素', () => {
 // `#plan-status` 已按 2026-09-23 的版式删掉，而 `roco.js` 里 13 处写入还在 ⇒ 开局失败、
 // 推进被拒、规划超时这些消息**玩家一个字都看不到**。现在统一走 `sayStatus()` → `#plan-note`。
 const html = readFileSync(join(ROOT, 'src/client/roco.html'), 'utf8');
 const js = readFileSync(join(ROOT, 'src/client/roco.js'), 'utf8');
 assert.match(html, /id="plan-note"/, '页面必须有那个可见的落点');
 assert.match(js, /function sayStatus\(/, '要有一个统一的状态出口');
 // 代码里（不含注释）不许再出现写向 plan-status 的语句
 const code = visible(js).split('\n').filter((line) => !/^\s*\*/.test(line)).join('\n');
 assert.doesNotMatch(code, /\$\('plan-status'\)/, '不许再写向已删除的 #plan-status');
 assert.doesNotMatch(code, /setText\('plan-status'/, '也不许用 setText 写它（找不到元素会静默落空）');
 // 失败路径必须真的走那个出口
 for (const [what, pattern] of [['开局失败', /sayStatus\(`开局失败/], ['推进失败', /sayStatus\(`推进失败/],
  ['规划失败', /sayStatus\(`规划失败/], ['对手连续补位', /sayStatus\('对手连续补位/]]) {
  assert.match(code, pattern, `${what} 必须写到可见的落点`);
 }
});

test('⑤ 「依据」栏只给玩家看人话：工程记号挑出去，一条人话都没有时如实兜底', () => {
 // 真实证据行的样本（来自真机审计里抓到的原文）
 const real = [
  '烬尾狐：98/98 HP，能量 5，速度 38。',
  'RULES.guard={reduction:0.65,energy:1}',
  'profile.tokens=3；烬尾狐 level=2 used=1 capacity=5',
  '若对手不换宠、不防御，火花对当前目标计算伤害为 36；实际结算受对手行动影响。',
  'tactic:poison 是知识卡编号',
  'memory.events 里没有这一局',
 ];
 const {shown, internal} = splitEvidence(real);
 assert.ok(shown.some((line) => line.includes('98/98 HP')), `人话那几条要留下：${JSON.stringify(shown)}`);
 assert.ok(shown.some((line) => line.includes('计算伤害为 36')), '带数字的人话也要留下（守卫那一条不受影响）');
 for (const line of internal) {
  assert.doesNotMatch(line, /^烬尾狐：98\/98/, '人话不许被误判成工程记号');
 }
 assert.ok(internal.some((line) => line.includes('RULES.guard')), `工程串要被挑出去：${JSON.stringify(internal)}`);
 assert.ok(internal.some((line) => line.includes('memory.events')), 'memory.* 也要挑出去');
 // 一条人话都没有 ⇒ 如实兜底，**不许**把工程串端出去
 const only = playerEvidence(['RULES.guard={reduction:0.65,energy:1}']);
 assert.equal(only.length, 1);
 assert.doesNotMatch(only[0], /RULES\.guard|\{|\}/, `兜底不许暴露工程串：${only[0]}`);
 assert.match(only[0], /引擎的数据与规则表|没有额外的依据/, '兜底要说清是什么');
 // 空输入也要有话说（不许留空白让人以为是"没有依据"）
 assert.equal(playerEvidence([]).length, 1, '空证据也要给一句话');
 // 接线：两个页面的依据栏都要走这个过滤（robots 不许自己 map 原始行）
 for (const file of ['src/client/app.js', 'src/client/xiaoya.js']) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  assert.match(source, /playerEvidence\(/, `${file} 的依据栏必须走这个过滤`);
 }
});

test('⑥ 不渲染 markdown 的落点：HTML 文本节点与纯文本出口都不许漏出 `**`', () => {
 // 审计 R6 的原话：「判 R6 必须看落点，不能看字符串」——四个回答正文的落点确实渲染 markdown，
 // 真问题在 HTML 文本节点、`textContent`、裸 `innerHTML` 这几类。
 // 2026-09-27：`nurture.html` 已退役 ⇒ 不在清单里（页面本身不存在了）。
 const htmls = ['src/client/index.html', 'src/client/roco.html',
  'src/client/xiaoya.html', 'src/client/box.html', 'src/client/connect.html', 'src/client/workshop.html'];
 const bad = [];
 for (const file of htmls) {
  const text = readFileSync(join(ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');   // 注释不算
  for (const match of text.matchAll(/>([^<>]*\*\*[^<>]*)</g)) bad.push(`${file}: ${match[1].trim().slice(0, 50)}`);
 }
 assert.deepEqual(bad, [], `HTML 文本节点里不许出现字面星号（HTML 不渲染 markdown）：\n${bad.join('\n')}`);
 // 纯文本出口：这三处必须过 `plain()`
 const roco = readFileSync(join(ROOT, 'src/client/roco.js'), 'utf8');
 assert.match(roco, /desc\.textContent = plain\(/, '行动说明那一处要过 plain()');
 assert.match(roco, /state\.pick\.hint = plain\(text\)/, '配队提示那一处要过 plain()');
 assert.match(roco, /note\.textContent = plain\(/, '开局提示那一处要过 plain()');
 // `plain()` 行为：去星号与行内码，别动别的东西
 assert.equal(plain('对**自己场上那只**使用，**不占行动**'), '对自己场上那只使用，不占行动');
 assert.equal(plain('看 `view.self` 这一项'), '看 view.self 这一项');
 assert.equal(plain('## 标题\n正文'), '标题\n正文');
 assert.equal(plain(null), '', '空值给空串，不许印 null');
});

test('⑦ 写给模型的禁令句**不许到玩家眼前**（结构性拆分待做，客户端过滤先兜住）', () => {
 // 审计原文指的就是这一句：它是**给模型的禁令**，却被 `app.js:869` 当"依据"渲染给玩家。
 // 2026-09-26 第 54 轮：我试过把它从 `evidence` 结构性拆到 `modelNotes`，**回退了** ——
 // 那次改动动了证据内容与回包形状，把陪练的档位行为弄红（8 条判据），风险大于收益。
 // 现在的保证是**客户端那一道过滤**（`playerEvidence()`，判据 ⑤）：禁令句里含
 // `memory.events`、祈使语气等工程记号，会被挑出去、不给玩家看。
 const instruction = '跨局记录：memory.events 里一局都还没有（没有记录）。这一轮只接住玩家这句话本身，'
  + '不许提任何过去、不许念「0胜0负」、也不许把人推去开一局；玩家自己问账本时才讲账本。';
 const shown = playerEvidence([instruction]);
 assert.equal(shown.length, 1);
 assert.doesNotMatch(shown[0], /不许|memory\.events/, `禁令句不许出现在依据栏：${shown[0]}`);
 // 待办写在这里，免得下一个人以为已经拆干净了：**根因是字段兼作两种用途**，不是文案问题。
 const companion = readFileSync(join(ROOT, 'src/coach/companion.js'), 'utf8');
 assert.doesNotMatch(companion, /modelNotes/, '结构性拆分本轮已回退：不要留下半截实现');
 assert.match(companion, /evidence:\[/, '证据数组照旧存在（客户端那一道过滤负责玩家可见性）');
});

// ── 2026-09-27（审计 ② 的收口）：三个新洞，逐条钉住 ─────────────────────────

test('⑧ HTML 文本节点也要说人话（原来只查字面 `**`，`roco.html:793` 的「工程口径」就是这么漏的）', () => {
 // 被测对象：HTML 的**文本节点**（玩家在页面上真的读到的字），不是属性、不是注释。
 const bad = [];
 const seen = new Set();
 const targets = ['src/client/index.html', 'src/client/roco.html',
  'src/client/xiaoya.html', 'src/client/box.html', 'src/client/connect.html', 'src/client/workshop.html'];
 for (const file of targets) {
  const allowed = HTML_DEBT.hard[file] ?? HTML_DEBT.soft[file] ?? 0;
  let hits = 0;
  for (const node of htmlTextNodes(readFileSync(join(ROOT, file), 'utf8'))) {
   seen.add(`${file}:${node.slice(0, 16)}`);
   const {hard, soft} = speakHits(node);
   if (!hard.length && !soft.length) continue;
   hits += 1;
   if (hits > allowed) bad.push(`${file}: ${[...hard, ...soft].join('/')} → ${node.slice(0, 60)}`);
  }
 }
 assert.deepEqual(bad, [], `HTML 文本节点里的工程词超出了已登记的欠账（现在允许值是 0）：\n${bad.join('\n')}`);
 // 反证一：**这一轮真的抓到的那两句原文**过同一个判据必须报错（否则上面那条等于没查）
 for (const old of ['等实机录制确认之后才会补上（登记在用户口径 D5）。',
  '被模式隐藏的动作（工程口径）']) {
  assert.ok(speakHits(old).hard.includes('口径'), `违例样本必须被抓住：${old}`);
 }
 // 反证二：扫描器**真的读到了页面文本**（不是扫了 0 个节点就宣布干净）
 assert.ok(seen.size > 50, `要扫到足量文本节点（实际 ${seen.size} 个）`);
 assert.ok([...seen].some((key) => key.startsWith('src/client/roco.html:被模式隐藏的动作（排查用')),
  '改后的那句话要能被读到（证明扫描器读的是这一页）');
 // 注释不算文本节点（否则「注释里解释口径」会被误判）
 assert.equal(htmlTextNodes('<p>正文</p><!-- 口径 -->').length, 1);
});

test('⑨ 出处句不许把参数丢掉（审计点名：`src(名, 出处)` 只收一个参数）', () => {
 // 真事故：`runtime.js` 的 `const src=(what)=>…` 只收**一个**参数，而三处按两个参数调用
 //（`src('换宠','src/game/engine.js 的回合结算…')`）⇒ 出处被**悄悄丢掉**，
 // 玩家读到的是「游戏里的固定规则：换宠，不是估的」——一句半截话。
 // 现在只传一个、传的是那条规则本身；这条判据挡住「再传第二个参数」。
 const source = visible(readFileSync(join(ROOT, 'src/coach/runtime.js'), 'utf8'));
 /** 顶层逗号数（跳过括号/引号内的逗号）：≥1 说明这个调用传了两个以上参数。 */
 const topCommas = (args) => {
  let depth = 0; let commas = 0; let quote = null;
  for (const ch of args) {
   if (quote) { if (ch === quote) quote = null; continue; }
   if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
   if ('([{'.includes(ch)) depth += 1;
   else if (')]}'.includes(ch)) depth -= 1;
   else if (ch === ',' && depth === 0) commas += 1;
  }
  return commas;
 };
 const calls = [...source.matchAll(/\bsrc\(([^()\n]*)\)/g)].map((match) => match[1]).filter((arg) => arg.trim());
 assert.ok(calls.length >= 5, `要能取到那些出处句（实际 ${calls.length} 处）`);
 const dropped = calls.filter((args) => topCommas(args) >= 1);
 assert.deepEqual(dropped, [], `这些 src(...) 传了会被丢掉的第二个参数：${dropped.join(' | ')}`);
 // 反证：把出事那次的写法喂给同一个判定必须报错
 assert.ok(topCommas("'换宠','src/game/engine.js 的回合结算（switch 与 skill 互斥）'") >= 1,
  '两参数的样本必须被数出来');
 assert.equal(topCommas("'主动换宠占掉这一回合，倒下补位不占回合'"), 0, '一个参数的样本不许误判');
});

test('⑩ 行为级：本地事实回答的**正文**里不许出现内部说法（源码扫描抓不到的那一半）', async () => {
 // 为什么要有这一条：判据 ①/② 扫的是**源码字面量**，它证明不了「发出去的那句话干净」——
 // 模板拼接、跨行、正文与 `evidence` 共用一份字面量，都会让它失真（这一轮就抓到正文里
 // 6 处 `.json`/`engine.js`：源码扫描逐行匹配看得见，却分不出「正文」与「依据」）。
 // 这里直接调**真的那一层**（`localParametricFact`，0 次模型调用、0 次引擎查询），
 // 拿它**真的要发给玩家的 text** 过同一份词表。
 const {localParametricFact} = await import('../src/coach/runtime.js');
 const camp = null;                        // null = 营地那一档（判据里的调用形状）
 const mobile = {profile: {pets: []}};     // pets 是数组 ⇒ 手游那一档
 const asks = [
  ['能量上限是多少？', camp], ['能量上限是多少？', mobile],
  ['主动换宠还能出招吗？', camp], ['倒下补位免费吗？', camp],
  ['技能一共有多少种？', camp], ['本系加成是多少？', camp],
  ['加点每点加多少？', camp], ['加点每点加多少？', mobile],
 ];
 const bad = [];
 let answered = 0;
 for (const [message, context] of asks) {
  const answer = localParametricFact(message, context);
  if (!answer) { bad.push(`「${message}」本地答不出来（判据与实现漂了）`); continue; }
  answered += 1;
  const {hard, soft} = speakHits(answer.text);
  // 正文里的**英文枚举 / 文件名 / 代码标识**也一起挡（词表抓不到这类）
  const latin = answer.text.match(
   /[A-Za-z_]{3,}\.(js|json)|OFFICIAL_[A-Z]+|ENGINE_[A-Z_]+|RULES\.[a-z]|TYPE_ADVANTAGES|weather_policy/g);
  if (hard.length || soft.length || latin) {
   bad.push(`「${message}」（${context === null ? '营地' : '手游'}）正文命中 `
    + `${JSON.stringify([...hard, ...soft, ...(latin ?? [])])}：${answer.text.slice(0, 90)}`);
  }
 }
 assert.equal(answered, asks.length, `八种问法都要有本地答案（实际 ${answered} 条）`);
 assert.deepEqual(bad, [], `本地回答的正文里出现了内部说法：\n${bad.join('\n')}`);
 // 反证：把**改前**的那种正文过同一份词表必须报错（否则这条判据是空的）
 const before = '「本系加成」这一条**本仓没有可引用的来源**（口径：倍率 > 1 才算怕）；'
  + '逐格在 engine.js 的 TYPE_ADVANTAGES 里，数据来自 types.json。';
 const caught = speakHits(before);
 assert.deepEqual(caught.hard.sort(), ['.js', '本仓', '口径'].sort(),
  `违例样本必须被抓住：${JSON.stringify(caught)}`);
 assert.match(before, /ENGINE_[A-Z_]+|weather_policy|[A-Za-z_]{3,}\.(js|json)/,
  '样本里要有文件名/枚举，才能证明正则那一路也在查');
 // 那份正则**单独**也要能抓住文件名字（上面的 before 里同时有两种违规，分开验一次）
 assert.ok(/[A-Za-z_]{3,}\.(js|json)/.test('依据：来自 engine.js 与 types.json'),
  '文件名那一路必须真的会命中');
});

test('⑪ 模型自己说的内部术语也要翻成人话（数字一个都不许动）+ 真的接线了', async () => {
 // 为什么要有这一条：判据 ①/② 管的是**我们写的字**，⑩ 管的是**本地那一层的返回值**，
 // 而真机探针（`scripts/roco/probe-answer-speak.mjs`）抓到的是**模型正文**：
 // 「所以下面是推断，不是实测回执」「具体倍数和图鉴口径我这次没查到」——
 // 提示词里的内部叫法会被模型照着抄进给玩家的回答。这一条钉住"发出去之前换掉"。
 const {speakPlainly, jargonIn, JARGON_WORDS} = await import('../src/coach/plain-words.js');
 // ① 只换词：数字序列必须逐字相同（含小数、百分号、范围）
 const sample = '这是推断，不是实测回执（把握中等）：雨天水系 +75%，等级 3→4，命中 0.85 那一档。'
  + '图鉴口径里没有这一条，台账 EV-123 也没记。';
 const digits = (text) => (text.match(/\d+(?:\.\d+)?%?/g) ?? []).join('|');
 const out = speakPlainly(sample);
 assert.equal(digits(out.text), digits(sample), `换词不许动数字：${out.text}`);
 assert.deepEqual(out.replaced, ['回执→查到的记录', '口径→说法', '台账→记录'],
  `要如实报出换了哪几个词：${JSON.stringify(out.replaced)}`);
 assert.deepEqual(jargonIn(out.text), [], `换完不该还剩内部叫法：${out.text}`);
 // ② 幂等：换过一次再换一次，结果不变
 assert.equal(speakPlainly(out.text).text, out.text, '同一段话换两次必须一样');
 assert.deepEqual(speakPlainly(out.text).replaced, [], '第二遍不该再报"换了词"');
 // ③ 前缀不打架：`本仓库` 与 `本仓` 不能互相切坏
 assert.equal(speakPlainly('本仓库里没有这一项').text, '我这边里没有这一项');
 assert.equal(speakPlainly('本仓引擎里一共 3 个技能').text, '我这边引擎里一共 3 个技能');
 // ④ 映射表里不许留内部叫法当"人话"（否则等于把词换个位置）
 for (const [jargon, plain] of Object.entries(JARGON_WORDS)) {
  assert.notEqual(jargon, plain, `${jargon} 的替换词不能是它自己`);
  assert.deepEqual(jargonIn(plain), [], `${jargon} 的替换词本身不能是内部叫法：${plain}`);
 }
 // ⑤ 行为级：走一遍真的 `runCoach`，让 stub 模型说带内部叫法的话，看发出去的是什么
 const {runCoach, localProvider} = await import('../src/coach/runtime.js');
 const {freshMemory} = await import('../src/coach/memory.js');
 const ctx = {mode: 'camp', profile: {pets: [{id: 'own-1', species_id: 'pet_000012', name: '铠甲虫'}], lineup: []}};
 const provider = {name: 'stub-model',
  async generate() { return '按战术卡的口径，先定职责再挑人；这一轮没有回执。'; }};
 const answer = await runCoach({message: '雨天队该怎么搭？', role: 'auto', context: ctx,
  memory: freshMemory(), provider});
 assert.equal(answer.provider, 'stub-model', `这一条要真的走模型那一支：${answer.provider}`);
 assert.deepEqual(jargonIn(String(answer.text)), [],
  `发出去的正文里不许有内部叫法：${answer.text}`);
 assert.match(String(answer.text), /说法|查到的记录/, `要换成玩家说法：${answer.text}`);
 // 顺序按**映射表的书写顺序**（不是按句子里出现的先后）：这里排序后比，免得判据跟着表序漂
 assert.deepEqual([...(answer.validation?.speakPlain ?? [])].sort(), ['回执→查到的记录', '口径→说法'].sort(),
  `换词要留痕（回执里能查）：${JSON.stringify(answer.validation)}`);
 // 反证：本地那一支（`localProvider`）本来就不该被换（换词只处理模型抄来的说法）
 const local = await runCoach({message: '雨天队该怎么搭？', role: 'auto', context: ctx,
  memory: freshMemory(), provider: localProvider});
 assert.equal(local.validation?.speakPlain, undefined,
  `本地正文本来就是人话 ⇒ 不该留换词痕迹：${JSON.stringify(local.validation)}`);
});
