#!/usr/bin/env node
// 真机问句探针：**这一次发出去的正文里有没有工程黑话**（2026-09-27，审计 ② 的真机那一半）。
//
// 为什么要有这一支：`tests/roco-plain-speak.test.js` 判的是**源码字面量**与**本地那一层的返回值**，
// 它证明不了"经过服务端、经过守卫、经过客户端渲染之后，玩家读到的还是不是人话"。
// 审计 ② 点到的正是这个缺口：`box.js` / `nurture.js` / `roco.html` 三处漏网的句子，
// 单元判据一条都没扫到。所以这里对着**正在跑的那个服务**逐句真问、把回答原文抓回来，
// 再用**同一份词表**（从单元判据里 import，不另抄一张）扫一遍。
//
// 用法：
//   node scripts/roco/probe-answer-speak.mjs                      # 默认打 8765
//   ROCO_EVAL_ORIGIN=http://127.0.0.1:8940 node scripts/roco/probe-answer-speak.mjs
//   node scripts/roco/probe-answer-speak.mjs --json               # 机器可读
//
// 产物：`reports/roco/answer-speak-probe.json`
//
// 边界（如实写）：这一支只问**事实类**问句（它们走本地路径、0 次模型调用），
// 所以它管的是"本地那一档的回答正文"；模型文风由 `eval-mobile-coach.mjs` 与人工审计管。
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildContext} from '../../src/coach/runtime.js';
import {freshMemory} from '../../src/coach/memory.js';
import {RESPONSE_INSTRUCTIONS} from '../../src/coach/client.js';
// 词表与判据共用同一份（`plain-words.js`）——**不要** import 那个测试文件：
// import 它会在探针进程里把整套判据跑一遍（实测：输出里混进 node:test 的汇总，退出码也会被带偏）。
import {speakHits} from '../../src/coach/plain-words.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = process.env.ROCO_EVAL_ORIGIN || 'http://127.0.0.1:8765';
const OUT = join(ROOT, 'reports', 'roco', 'answer-speak-probe.json');
const asJson = process.argv.includes('--json');

//: 正文里**额外**不许出现的东西（词表抓不到的那一类：英文枚举、数据文件名、代码标识）。
const LATIN_LEAK = /[A-Za-z_]{3,}\.(js|json)|OFFICIAL_[A-Z]+|ENGINE_[A-Z_]+|RULES\.[a-z]|weather_policy|TYPE_ADVANTAGES|policies\./g;

/** 这一批问句覆盖了这一轮改过的每一条本地回答（天气/相性/图鉴/可学性/换宠/补位/技能数/加点/训练点）。
 *
 * `retired: true` 的那几条是**加点退役**的问句（2026-09-27 人类：「加点不要了」）：
 * 除了"不许有工程黑话"之外，还要求正文**直说没有加点**、且**一个旧口径的数都不报**。 */
const ASKS = [
  {q: '雨天水系伤害加多少？'},
  {q: '火系克制什么属性？'},
  {q: '水系打火系有优势吗？'},
  {q: '我这几只里谁抗龙系？'},
  {q: '铠甲虫是谁？'},
  {q: '小翼龙带抓挠、震击合法吗？'},
  {q: '主动换宠还能出招吗？'},
  {q: '倒下补位免费吗？'},
  {q: '技能一共有多少种？'},
  {q: '加点每点加多少？', retired: true},
  {q: '我还差多少训练点满级？', retired: true},
  {q: '还有几个培养格？', retired: true},
  {q: '我的能量上限是多少？'},
  // 2026-09-27 新接入：进化链（数据来自社区图鉴层，答案里必须标出来路）
  {q: '喵喵几级进化？', evolution: true},
  // 2026-09-27 真机抓到的漏答：图鉴字段问句（`codex-fact`）**没接模型时**答的是占位句
  // 「这一问的答案在图鉴里，我先查一下再答。」——`policyFor` 判了它，`localFactAnswer` 里却
  // **没有这一支**。下面这几条是"真机那一档"的常驻判据：必须有回执、正文必须含回执里的数、
  // 不许再出现占位句（正文里带 `*` 的是加粗标记，判据不看排版）。
  {q: '喵喵的种族值是多少？', codex: {must: /种族值合计 \d+/}},
  {q: '寂灭骨龙的速度是多少？', codex: {must: /速度是 \d+/}},
  // 属性这一族：名字不在名单里时会被判成"技能"档 ⇒ 必须换另一档再查一次（回执 ≥2 次）
  {q: '喵喵是什么属性？', codex: {must: /草系/, minTools: 2}},
  {q: '喵喵的叶绿光束威力多少？', codex: {must: /威力 \d+/}},
  {q: '喵喵的技能表', codex: {must: /学得到的技能一共 \d+ 个/}},
  // fail closed 那一档：查不到就如实说查不到，**一个数都不许有**（图鉴规模 622 例外）
  {q: '不存在的精灵名啊的种族值是多少？', codex: {must: /没核到|查不到/, noNumbers: true}},
];
/** 退役问句的判据：直说没有加点 + 不报旧数（与 `tests/roco-nurture-page.test.js` ⑤ 同一口径）。 */
const RETIRED_LEAK = /训练点 ?\d|培养格|满级还差|还差 \d+ ?格|\+12 生命|\+4 攻击|\+3 速度/;

const boot = await fetch(`${ORIGIN}/api/bootstrap`);
const cookie = boot.headers.get('set-cookie')?.split(';')[0];
const session = await boot.json();
const box = await (await fetch(`${ORIGIN}/api/roco/box?kind=mine&limit=48`)).json();
const pets = (box.player?.cards ?? []).map((c) => ({id: c.select, species_id: c.group, name: c.name,
  types: c.types, level: c.level, role: c.role_label, mechanism: c.mechanism?.line ?? null}));
const context = {
  ...buildContext(null, {pets, pool_summary: {total: box.player?.total ?? pets.length, source: 'owned'}},
    pets[0]?.id ?? null, null, 'meadow', ''),
  coachAllowed: true,
};

/** `--ask '问句1|问句2'`：只问这几句（排查用；不写产物）。 */
const onlyArg = (() => {
  const i = process.argv.indexOf('--ask');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split('|').map((x) => x.trim()).filter(Boolean) : null;
})();
const LIST = onlyArg ? onlyArg.map((q) => ({q})) : ASKS;

const rows = [];
for (const ask of LIST) {
  const question = ask.q;
  let record = {question};
  try {
    const response = await fetch(`${ORIGIN}/api/coach`, {
      method: 'POST',
      headers: {'content-type': 'application/json', cookie, origin: ORIGIN, 'X-Coach-CSRF': session.csrf},
      body: JSON.stringify({message: question + RESPONSE_INSTRUCTIONS, role: 'auto', context,
        memory: freshMemory(), conversation: []}),
    });
    const data = await response.json();
    if (onlyArg && process.argv.includes('--dump')) {
      console.error(`      原始：${JSON.stringify({agentStop: data.agentStop, provider: data.provider,
        toolTrace: (data.toolTrace ?? []).map((t) => ({tool: t?.tool, ok: t?.result?.ok ?? null})),
        validation: data.validation ? {valid: data.validation.valid, reasons: data.validation.reasons} : null,
        fallbackReason: data.fallbackReason ?? null}).slice(0, 700)}`);
    }
    const text = String(data.text ?? data.error ?? '');
    const evidence = (data.evidence ?? []).join('\n');
    const hits = speakHits(text);
    const latin = text.match(LATIN_LEAK) ?? [];
    // 加点退役那几条：直说没有加点 + 不报旧数（真机这一侧的证据）
    const retiredProblems = !ask.retired ? []
      : [...(text.includes('没有加点') ? [] : ['正文没有直说"没有加点"']),
        ...(RETIRED_LEAK.test(text) ? [`正文里还报着旧口径的数：${text.match(RETIRED_LEAK)[0]}`] : [])];
    // 进化那一族：必须说得出链与等级，并标出来路（社区数据，不是官方文本）
    const evolutionProblems = !ask.evolution ? []
      : [...(/进化成/.test(text) ? [] : ['正文没说进化成谁']),
        ...(/Lv\.\d+/.test(text) ? [] : ['正文没给进化等级']),
        ...(/社区|非官方/.test(text) ? [] : ['正文没标出来路'])];
    // 图鉴字段问句（2026-09-27）：真机这一档的判据 —— 占位句、回执、正文里的数。
    const tools = Array.isArray(data.toolTrace) ? data.toolTrace : [];
    const codexProblems = !ask.codex ? []
      : [...(/我先查一下再答/.test(text) ? ['正文还是那句占位承诺（没真答）'] : []),
        ...(tools.length >= (ask.codex.minTools ?? 1) ? []
          : [`回执只有 ${tools.length} 次（至少 ${ask.codex.minTools ?? 1} 次）`]),
        ...(ask.codex.must.test(text) ? [] : [`正文没给出应有的读数（要匹配 ${ask.codex.must}）`]),
        ...(ask.codex.noNumbers && /\d/.test(text.replace(/622/g, '图鉴规模'))
          ? ['查不到时正文里出现了数值（可能是在编）'] : [])];
    record = {...record, retired: ask.retired === true, retiredProblems, evolution: ask.evolution === true,
      evolutionProblems, codex: ask.codex ? true : undefined, codexProblems,
      status: response.status, agentStop: data.agentStop ?? null,
      provider: data.provider ?? null, tools: tools.length, text: text.slice(0, 300),
      hard: hits.hard, soft: hits.soft, latin,
      // 依据区**允许**留文件名/编号（规范第三节的例外）——这里只记账，不判红。
      evidence_latin: (evidence.match(LATIN_LEAK) ?? []).length};
  } catch (error) {
    record = {...record, error: String(error?.message ?? error)};
  }
  rows.push(record);
  const bad = (record.hard?.length ?? 0) + (record.soft?.length ?? 0) + (record.latin?.length ?? 0)
    + (record.retiredProblems?.length ?? 0) + (record.evolutionProblems?.length ?? 0)
    + (record.codexProblems?.length ?? 0);
  if (!asJson) {
    console.error(`${bad ? 'FAIL' : 'ok  '} ${question}  stop=${record.agentStop} `
      + `正文命中=${JSON.stringify([...(record.hard ?? []), ...(record.soft ?? []), ...(record.latin ?? [])])}`
      + (record.retired ? ` 退役检查=${JSON.stringify(record.retiredProblems)}` : '')
      + (record.evolution ? ` 进化检查=${JSON.stringify(record.evolutionProblems)}` : '')
      + (record.codex ? ` 图鉴检查=${JSON.stringify(record.codexProblems)}（回执 ${record.tools} 次）` : ''));
    if (bad || onlyArg) console.error(`      正文：${record.text}`);
  }
}

const dirty = rows.filter((row) => (row.hard?.length ?? 0) + (row.soft?.length ?? 0)
  + (row.latin?.length ?? 0) + (row.retiredProblems?.length ?? 0)
  + (row.evolutionProblems?.length ?? 0) + (row.codexProblems?.length ?? 0) > 0);
const report = {
  schema: 'roco-answer-speak-probe/v1',
  generated_at: new Date().toISOString(),
  origin: ORIGIN,
  why: '单元判据扫的是源码字面量，证明不了"服务端发出来、玩家读到的"那一份还是不是人话（审计 ②）。',
  counters: {asked: rows.length, clean: rows.length - dirty.length, dirty: dirty.length},
  rows,
  known_limits: [
    '只问事实类问句（本地路径、0 次模型调用）：模型正文的文风不在这一支的范围内',
    '依据区（`evidence`）按规范第三节的例外**允许**保留文件名与编号，这里只记账（`evidence_latin`）',
    '它对的是"正在跑的那个进程"：旧进程会给出旧答案（这正是它的用处 —— 真机复现）',
    '图鉴那 6 条（`codex`）判的也是"没接模型"这一档：这一族走本地事实、0 次模型调用，'
      + '所以它既能验占位句有没有回来，也能验正文里的数是不是真从回执来（`tools` 记了查了几次）',
  ],
};
if (onlyArg) { console.error('（--ask 模式：不写产物）'); process.exitCode = 0; }
else {
mkdirSync(dirname(OUT), {recursive: true});
writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
if (asJson) console.log(JSON.stringify(report.counters));
console.error(`报告：reports/roco/answer-speak-probe.json（干净 ${report.counters.clean}/${report.counters.asked}；`
  + `脏 ${report.counters.dirty}）`);
if (dirty.length) process.exitCode = 1;
}
