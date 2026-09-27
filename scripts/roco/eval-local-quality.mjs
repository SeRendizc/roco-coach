// 本地 4B 的**回答质量**评测（人类 2026-09-26 ⑤：「评测要能证伪，不许自欺」）。
//
// 为什么不是"看几条觉得还行"：那是自欺。这里的评测有三条硬约束 ——
//   ① **判据能证伪**：每个用例的判据是**机器可判**的（必须出现什么、必须不出现什么），
//      不是"读起来像人话"；
//   ② **负对照**：同一套判据必须先拒绝一组**已知的烂回答**（「我在。」「小芽我随时都在」、
//      混英文的、编数字的）—— 判据要是连这些都放行，那它就是空的（`--selftest` 跑这一组）；
//   ③ **留出**：这些问句**不在**提示词、材料或训练集里；答案不写死，只写"必须满足什么"。
//
// 用法：
//   node scripts/roco/eval-local-quality.mjs --selftest         # 只跑负对照（不需要模型）
//   ORIGIN=http://127.0.0.1:8796 node scripts/roco/eval-local-quality.mjs   # 打真机
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseLocalOutput} from '../../src/coach/local-model.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const REPORT = 'reports/roco/local-quality/eval-local-quality.json';

/** 混英文词（`roster_total` / `hp` 这种）—— 真机实测里 4B 会照抄材料里的英文键名。 */
const LATIN = /[A-Za-z]{2,}/;
/** 空话：说了等于没说（真机抽样里出现过）。 */
const EMPTY_TALK = /随时都在|随时待命|我在。|咱们一起打|加油哦|相信我/;
/**
 * 没依据的数字形状：百分比 / 胜率 / 概率（红线：不许自己算）。
 * ⚠ **否定式不算**：引擎模板里就写着「这些是结构特征，不是胜率」——第一版判据把这句话误杀了
 * （真机实测：3 条正确的引擎回答被判不合格）。所以先剔掉"不是/没有/不算"这类否定语境。
 */
const INVENTED_NUMBER = /胜率|概率|百分之|(?<!\d)(?!10|20|75|50)\d{1,3}\s*%/;
// ↑ 百分比那一支**放过有出处的数**（性格 ±10%/±20%、天气 +75%/+50% 这些都是台账里的），
//   只抓"没出处的百分比"。第一版是一刀切 `\d+%`，把「速度抬 +20%」这条**正确**回答误杀了。
const NEGATED = /(不是|没有|不算|不表示|并非|别当成)[^。；]{0,12}(胜率|概率|百分比)/g;
const inventedNumberHit = (text) => INVENTED_NUMBER.test(String(text).replace(NEGATED, '（否定）'));

/**
 * 留出用例：问句 + **机器可判**的要求。
 * `want` 里每一项都必须出现（正则或函数）；`forbid` 里每一项都不许出现。
 * ⚠ 这里**不许**出现"某只精灵应该怎么答"的固定答案 —— 那是过拟合。
 */
export const CASES = [
  {id: 'need-tank', family: '组队',
   ask: '我这队最缺什么位置？', context: 'six',
   want: [/缺|少|没有/, /扛|坦|肉|防/],
   forbid: [EMPTY_TALK]},
  {id: 'order', family: '出场顺序',
   ask: '出场顺序怎么安排？', context: 'six',
   want: [/先|首|顺序/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER]},
  {id: 'speed-line', family: '速度线',
   ask: '这队谁该先手？', context: 'six',
   want: [/速度|先手|快/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER]},
  {id: 'nature-why', family: '性格',
   ask: '皇家狮鹫为什么适合开朗？', context: 'six',
   want: [/速度/, /魔攻|代价|牺牲/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER]},
  {id: 'nature-pick', family: '性格',
   ask: '皇家狮鹫用什么性格好？', context: 'six',
   want: [/性格|开朗|胆小|急躁|热情|莽撞|懒散|天真|稳重|悠闲/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER]},
  {id: 'swap-when', family: '换人',
   ask: '什么情况下该换人？', context: 'six',
   want: [/换|替|下场/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER]},
  {id: 'coverage', family: '打击面',
   ask: '这队的打击面怎么样？', context: 'six',
   want: [/属性|系|打|覆盖/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER]},
  {id: 'weakness', family: '弱点',
   ask: '这队最怕什么？', context: 'six',
   want: [/怕|弱|克/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER]},
  {id: 'practice', family: '培养方向',
   ask: '这几只我该先练谁？', context: 'six',
   want: [/先|练|优先/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER]},
  {id: 'turn-plan', family: '局内取舍',
   ask: '开局第一回合怎么打？', context: 'six',
   want: [/第一|开局|首/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER, LATIN]},
  {id: 'no-data', family: '缺数据',
   ask: '我上一局输在哪？', context: 'six',
   want: [/没有|没记|查不到|不知道|打一局/],
   forbid: [INVENTED_NUMBER]},
  {id: 'plain-talk', family: '术语',
   ask: '什么叫应对？', context: 'six',
   want: [/应对/],
   forbid: [EMPTY_TALK, INVENTED_NUMBER, LATIN]},
];

/** 负对照：这些回答**必须**被判不合格（否则判据是空的）。 */
export const BAD_ANSWERS = [
  {id: 'empty-talk', answer: '小芽我随时都在，咱们一起打！', why: '没信息量的空话'},
  {id: 'placeholder', answer: '我在。', why: '状态回报，不是回答'},
  {id: 'latin', answer: '先看你 roster_total 里那几只。', why: '英文键名泄漏'},
  {id: 'invented', answer: '这队胜率大概 62%，放心打。', why: '编了一个没依据的数字'},
  {id: 'way-off', answer: '今天天气不错，适合出门。', why: '答非所问'},
  // 「半好」的负对照：**切题了、也有该有的词**，但顺手编了一个没出处的数字。
  // 这一条专门防"判据只看关键词"——它必须被数字那一条抓住。
  {id: 'sneaky-number', answer: '这队缺个能扛伤害的坦克，补上之后胜率能到 65%。', why: '切题但编了胜率'},
  // 「半好」之二：切题但只会说空话（真机抽样里出现过）。
  {id: 'vague', answer: '这队缺个能扛伤害的坦克，相信我，随时都在。', why: '切题但空话'},
];

/** 一条回答过不过：返回 `{ok, reasons}`。**不修剪**：不合格就是不合格。 */
/**
 * 一条回答过不过：返回 `{ok, reasons}`。**不修剪**：不合格就是不合格。
 *
 * `source` 说这条回答是谁给的 —— **契约层（英文/Markdown/长度）只对模型回答生效**：
 * 引擎模板本来就是长文、正文里带 `**`（客户端会按 markdown 渲染），拿模型的短句契约去卡它
 * 是第一版判据的第二个误杀（真机实测 3 条）。
 */
export function judgeAnswer(row, answer, {source = 'model'} = {}) {
  const text = String(answer ?? '').trim();
  const reasons = [];
  if (!text) reasons.push('空回答');
  if (source === 'model') {
    // ⚠ 这里判的是**玩家看到的那段正文**（产品里的包装层已经按契约抽过 `answer` 字段）。
    // 第一版把正文再 `JSON.stringify` 一次喂给 `parseLocalOutput` ⇒ 连 `"answer":`/`"basis":`
    // 这两个键名里的字母都被当成"混英文"，两条本来合格的回答被误杀（真机实测）。
    if (LATIN.test(text)) reasons.push(`模型正文里有英文字母词：${text.match(LATIN)?.[0]}`);
    if (/[*#`]/.test(text)) reasons.push('模型正文里有 Markdown 记号');
    if (text.length > 200) reasons.push(`模型正文 ${text.length} 字，太长（说不完就没重点）`);
  }
  for (const pattern of row.want ?? []) {
    if (!pattern.test(text)) reasons.push(`缺少必须出现的内容：${pattern}`);
  }
  // **全局红线**（不分用例）：任何回答都不许出现没出处的胜率/概率/百分比 ——
  // 这条原来只写在个别用例的 forbid 里，于是「切题但顺手编个胜率」被放行
  // （负对照 `sneaky-number` 当场把它抓出来：判据不能只看关键词）。
  if (inventedNumberHit(text)) reasons.push('出现了没出处的胜率/概率/百分比（数字红线）');
  for (const pattern of row.forbid ?? []) {
    if (pattern === INVENTED_NUMBER) continue;          // 上面已按红线统一判过
    if (pattern.test(text)) reasons.push(`出现了不该有的内容：${pattern}`);
  }
  return {ok: reasons.length === 0, reasons};
}

/** 负对照自检：`judgeAnswer` 至少要对每条烂回答给出**至少一个**理由。 */
export function selfTest() {
  const problems = [];
  for (const bad of BAD_ANSWERS) {
    const row = CASES.find((one) => one.id === 'need-tank');
    const verdict = judgeAnswer(row, bad.answer);
    if (verdict.ok) problems.push(`负对照放行了「${bad.id}」（${bad.why}）—— 判据是空的`);
  }
  // 正对照：一条**合规且切题**的回答必须通过（否则判据是"一律拒绝"那种假的严）
  const good = '这队缺个能扛伤害的坦克，先把前排补上再谈输出。';
  const okVerdict = judgeAnswer(CASES[0], good);
  if (!okVerdict.ok) problems.push(`正对照被误杀：${okVerdict.reasons.join('；')}`);
  return problems;
}

function sixContext() {
  return {mode: 'camp', battle: null, profile: {pets: [
    {id: 'pet_000118', name: '皇家狮鹫', types: ['翼系'], role: '速攻', stats: {hp: 366, atk: 140, def: 100, spa: 95, spd: 100, spe: 132}},
    {id: 'pet_000137', name: '多多', types: ['地系'], role: '坦克', stats: {hp: 401, atk: 120, def: 150, spa: 110, spd: 105, spe: 60}},
    {id: 'pet_000143', name: '花魁蜂后', types: ['虫系'], role: '平衡', stats: {hp: 442, atk: 118, def: 112, spa: 125, spd: 120, spe: 88}}],
    lineup: [{id: 'pet_000118', name: '皇家狮鹫'}, {id: 'pet_000137', name: '多多'}, {id: 'pet_000143', name: '花魁蜂后'}]}};
}

async function main() {
  if (process.argv.includes('--selftest')) {
    const problems = selfTest();
    console.log(problems.length ? `✖ 负对照有问题：\n - ${problems.join('\n - ')}` : '✔ 负对照全部被抓到（判据不是空的）');
    process.exit(problems.length ? 1 : 0);
  }
  const origin = process.env.ORIGIN;
  if (!origin) { console.log('用法：ORIGIN=http://127.0.0.1:8796 node scripts/roco/eval-local-quality.mjs（或 --selftest）'); process.exit(2); }
  const bootRes = await fetch(`${origin}/api/bootstrap`);
  const boot = await bootRes.json();
  const cookie = (bootRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const rows = [];
  for (const [index, row] of CASES.entries()) {
    const t0 = Date.now();
    const res = await fetch(`${origin}/api/coach`, {method: 'POST',
      headers: {Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
      body: JSON.stringify({message: row.ask, role: 'auto', context: sixContext(), memory: {version: 1},
        conversation: [], stateToken: `quality-${process.pid}-${index}`}),
      signal: AbortSignal.timeout(120000)});
    const body = await res.json();
    const answer = String(body.text ?? '');
    // 契约包装：真机回的是自然语言正文，评测按契约的 answer 那一段判
    // 引擎模板（provider=local / local-fallback）不走模型契约那几条；模型回答要走。
    const source = String(body.provider ?? '').includes('mlx-local') ? 'model' : 'engine';
    const verdict = judgeAnswer(row, answer, {source});
    rows.push({id: row.id, family: row.family, ask: row.ask, provider: body.provider,
      secs: (Date.now() - t0) / 1000, ...verdict, answer: answer.replace(/\s+/g, ' ').slice(0, 160)});
    console.log(`${verdict.ok ? '✔' : '✖'} [${row.family}] ${row.ask} · ${body.provider} · ${rows.at(-1).secs.toFixed(1)}s`);
    if (!verdict.ok) console.log(`    ${verdict.reasons.join('；')}\n    ${rows.at(-1).answer}`);
  }
  const pass = rows.filter((one) => one.ok).length;
  const summary = {total: rows.length, pass, rate: Number((pass / rows.length).toFixed(3)),
    by_family: Object.fromEntries([...new Set(rows.map((one) => one.family))].map((family) => {
      const group = rows.filter((one) => one.family === family);
      return [family, `${group.filter((one) => one.ok).length}/${group.length}`];
    })),
    providers: rows.reduce((acc, one) => ({...acc, [one.provider]: (acc[one.provider] ?? 0) + 1}), {}),
    median_secs: [...rows.map((one) => one.secs)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]};
  mkdirSync(join(ROOT, dirname(REPORT)), {recursive: true});
  writeFileSync(join(ROOT, REPORT), `${JSON.stringify({generated_at: new Date().toISOString(), origin, summary, rows}, null, 1)}\n`);
  console.log(`\n合计 ${summary.total} 问：通过 ${summary.pass}（${(summary.rate * 100).toFixed(0)}%）· 中位延迟 ${summary.median_secs.toFixed(1)}s`);
  console.log('按族：', JSON.stringify(summary.by_family));
  console.log('回执来源：', JSON.stringify(summary.providers));
  console.log(`报告 → ${REPORT}`);
  process.exit(pass === rows.length ? 0 : 1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) await main();
