/**
 * 判据：机制对照表 `docs/roco/MECHANICS-VS-POKEMON.md` 的**出处纪律**。
 *
 * 为什么需要它：这份文档的内容一半来自**联网查证**（宝可梦算法），一半来自**人类口述**。
 * 本项目红线是「数字只来自引擎/数据层，查不到就说查不到」—— 所以这份文档里
 * **每一条结论都必须能回溯**：要么挂 URL，要么挂在仓内文件上。文档最容易烂的方式，
 * 就是后来的人往里面补一句"宝可梦是这样的"，谁也不查。
 *
 * 六条（全部静态：不联网、不跑浏览器、不读进程）：
 *   ① 每个 `##` / `###` 小节都至少带一个 `来源：` 或一个 URL（`来源：` 后面光有空话也不算）；
 *   ② 必须逐条点到本仓实现位置，且**这些文件真的存在**（`exists` 可注入，便于反证）；
 *   ③ 必须明确写出"本仓没有建的层"：星级 / 学习力 / 突破次数；
 *   ④ 主对照表必须是四列：`洛手 → 宝可梦 → 本仓 → 结论`，且至少 6 行（覆盖六个层）；
 *   ⑤ 宝可梦那一列必须真的有公开来源（去重 URL ≥ 4，实际 15 条）；
 *   ⑥ 反证：喂一段"有结论没出处"的合成文本给**同一个检查函数**，必须报错
 *      （检查函数是导出的纯函数，判据与反证共用一份）。
 *
 * 注：本判据**不**进 `package.json`（那是主线程统一注册的手工清单）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const DOC_PATH = fileURLToPath(new URL('../docs/roco/MECHANICS-VS-POKEMON.md', import.meta.url));
const readDoc = () => readFileSync(DOC_PATH, 'utf8');

/** 文档必须点到的仓内实现位置（少一个 = 对照表没落到代码上）。 */
export const REQUIRED_REPO_PATHS = [
  'src/coach/talent.js',                          // 性格表读取 + 面板换算（PANEL_FORMULA / TALENT_PVP_STEP / pvpPanelOf）
  'src/coach/individuals.js',                     // 天分三级各 +10（TALENT_STEP / TALENT_TIERS / refresh）
  'src/coach/natures-data.js',                    // 30 条性格的浏览器镜像（NATURES_MODIFIER）
  'src/coach/nature-advice.js',                   // 种族值读取 + 说法层（RACE_SOURCE / explainNature）
  'data/roco/systems/natures.json',               // 性格规则与百分比的唯一落盘处
  'data/roco/evidence/rule-evidence-ledger.json', // EV-NATURE-BALANCE-PVP（+20% / −10% 的出处）
  'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json', // 622 只六维 stats
];

/** 文档必须说清"本仓没有建"的三层（人类点名）。 */
export const MISSING_LAYERS = ['星级', '学习力', '突破次数'];

const URL_RE = /https?:\/\/[^\s)）>】"'，。；、]+/g;   // 抽取用（带 g）
const URL_HAS_RE = /https?:\/\/\S/;                    // 判定用（不带 g，不会踩 lastIndex）
// `来源：` 允许写成 `**来源**：`（文档里就是这么写的）—— 星号不算"出处"，不许因此放过
const SOURCE_RE = /来源\*{0,2}\s*[:：]/;
// "有出处"= URL，或仓内的顶层目录路径（src/ data/ tests/ docs/ reports/ scripts/ roco/）
// 前缀只要求"不是词字符/斜杠" —— 这样 `来源：data/roco/...`（冒号后直接接路径）也认
const REPO_PATH_RE = /(?:^|[^\w/-])(?:src|data|tests|docs|reports|scripts|roco)\/[\w./-]+/;
const HEADING_RE = /^(#{2,3})\s+(\S.*)$/;

/** 按行切开：每条 = {level, title, body}，body 是本节标题之后、下一个标题之前的正文。 */
export function sectionsOf(doc) {
  const lines = String(doc ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    const hit = HEADING_RE.exec(line.trim());
    if (hit) out.push({level: hit[1].length, title: hit[2].trim(), body: []});
    else if (out.length) out[out.length - 1].body.push(line);
  }
  return out.map((row) => ({...row, body: row.body.join('\n')}));
}

/**
 * ① 每条 `##`/`###` 小节必须有出处。**纯函数**（判据与反证共用）。
 * 两条规则：
 *   · 没有 `来源：` 也没有 URL ⇒ 报"没出处"；
 *   · 写了 `来源：` 但后面既没有 URL 也没有仓内路径（例如「来源：（待补）」）⇒ 也报
 *     —— 光有"来源"两个字不算出处。
 * 返回问题清单，空数组 = 通过。
 */
export function auditSections(doc) {
  const problems = [];
  const sections = sectionsOf(doc);
  if (!sections.length) return ['文档里一个小节（## / ###）都没有'];
  for (const row of sections) {
    const label = `「${'#'.repeat(row.level)} ${row.title}」`;
    const text = `${row.title}\n${row.body}`;
    const hasMarker = SOURCE_RE.test(text);
    const hasUrl = URL_HAS_RE.test(text);
    if (!hasMarker && !hasUrl) { problems.push(`${label}没有 来源：也没有 URL`); continue; }
    // 标了 `来源：` 的行，后面必须真的跟着 URL 或仓内路径（允许续到后两行）
    let filled = hasUrl;
    const lines = text.split('\n');
    for (let i = 0; !filled && i < lines.length; i += 1) {
      if (!SOURCE_RE.test(lines[i])) continue;
      const window = lines.slice(i, i + 3).join(' ');
      if (URL_HAS_RE.test(window) || REPO_PATH_RE.test(window)) filled = true;
    }
    if (!filled) problems.push(`${label}的 来源：后面既没有 URL 也没有仓内路径（等于没出处）`);
  }
  return problems;
}

/** ② 必须点到实现位置，且这些路径在仓库里真的存在（`exists` 注入，反证里可换掉）。 */
export function auditRepoPaths(doc, exists = existsSync) {
  const text = String(doc ?? '');
  const problems = [];
  for (const path of REQUIRED_REPO_PATHS) {
    if (!text.includes(path)) problems.push(`没有点到实现位置：${path}`);
    else if (!exists(new URL(`../${path}`, import.meta.url))) problems.push(`点了但文件不存在：${path}`);
  }
  return problems;
}

/** ③ "本仓没有建的层"必须逐条写明。 */
export function auditMissingLayers(doc) {
  const text = String(doc ?? '');
  return MISSING_LAYERS.filter((word) => !text.includes(word))
    .map((word) => `没有写明本仓缺这一层：${word}`);
}

/**
 * ⑤ 主对照表必须是**四列**：`洛手 → 宝可梦 → 本仓 → 结论`。
 * 找到表头（同时含四个列名的分隔行前面的那一行），逐行数格子。
 */
export function auditMainTable(doc) {
  const lines = String(doc ?? '').split('\n');
  const headerIndex = lines.findIndex((line) => line.trim().startsWith('|')
    && line.includes('洛手') && line.includes('宝可梦') && line.includes('本仓') && line.includes('结论'));
  if (headerIndex < 0) return ['找不到四列主表（表头必须同时含「洛手 / 宝可梦 / 本仓 / 结论」）'];
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const problems = [];
  const header = cells(lines[headerIndex]);
  if (header.length !== 4) problems.push(`主表表头不是 4 列（实际 ${header.length} 列）`);
  let rows = 0;
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    rows += 1;
    const width = cells(line).length;
    if (width !== 4) problems.push(`主表第 ${rows} 行不是 4 列（实际 ${width}）：${line.slice(0, 40)}…`);
  }
  if (rows < 6) problems.push(`主表行数太少（${rows} < 6）：覆盖不到六个层`);
  return problems;
}

/** ④ 宝可梦那一列必须**真的有公开来源**：去重后的 URL 至少 `min` 条。 */
export function auditUrlCount(doc, min = 4) {
  const urls = new Set(String(doc ?? '').match(URL_RE) ?? []);
  return urls.size >= min ? [] : [`宝可梦侧的公开 URL 太少（去重后 ${urls.size} < ${min}）`];
}

/** 四个检查合起来（正文档用它，反证也用它 —— 同一份检查函数）。 */
export function checkMechanicsDoc(doc, {exists = existsSync} = {}) {
  const problems = [
    ...auditSections(doc),
    ...auditRepoPaths(doc, exists),
    ...auditMissingLayers(doc),
    ...auditMainTable(doc),
    ...auditUrlCount(doc),
  ];
  return {ok: problems.length === 0, problems};
}

// ── 判据 ────────────────────────────────────────────────────────────────────

test('① 正文档：每个 ## / ### 小节都带 来源：或 URL', () => {
  const doc = readDoc();
  assert.deepEqual(auditSections(doc), [], '小节必须逐条挂出处');
  const sections = sectionsOf(doc);
  assert.ok(sections.length >= 8, `小节太少（${sections.length}）—— 六个层 + 总判断 + 来源清单是底线`);
});

test('② 正文档：点到本仓实现位置，且这些文件真的存在', () => {
  const doc = readDoc();
  assert.deepEqual(auditRepoPaths(doc), []);
  // 逐条再明确一次（这条是"实现位置"本身，不许只挂在 URL 上）
  for (const path of ['PANEL_FORMULA', 'TALENT_PVP_STEP', 'pvpPanelOf', 'TALENT_STEP', 'TALENT_TIERS', 'RACE_SOURCE']) {
    assert.match(doc, new RegExp(path), `必须点到 ${path}`);
  }
});

test('③ 正文档：写明本仓没建的层（星级 / 学习力 / 突破次数）', () => {
  const doc = readDoc();
  assert.deepEqual(auditMissingLayers(doc), []);
});

test('④ 正文档：主对照表是四列、覆盖六个层', () => {
  assert.deepEqual(auditMainTable(readDoc()), []);
});

test('⑤ 正文档：性格那一条必须把两种解释都写出来（不许替人类拍板）', () => {
  const doc = readDoc();
  for (const token of ['解释 A', '解释 B', 'EV-NATURE-BALANCE-PVP', '1.2', '0.9']) {
    assert.ok(doc.includes(token), `性格那一节必须写到：${token}`);
  }
  // 人类那两句原话必须逐字在（口径不许被转述改写）
  assert.ok(doc.includes('增加幅度从 10% 提到 20%'), '人类第 1 段原话必须在');
  assert.ok(doc.includes('性格都是一项 +10%，一项 -10%'), '人类第 3 段原话必须在');
});

test('⑥ 反证：合成的"有结论没出处"文本，同一个检查函数必须报错', () => {
  const synthetic = [
    '# 某个没有出处的对照表',
    '',
    '## 一、逐层对照',
    '',
    '### 1. 种族值',
    '',
    '洛手的种族值对标宝可梦，量级一致，没问题。',
    '',
    '### 2. 性格',
    '',
    '洛手性格是 +20%，宝可梦是 ±10%，所以洛手更极端。',
    '',
    '### 3. 星级',
    '',
    '洛手有升星，宝可梦没有。',
    '',
    '### 4. 学习力',
    '',
    '洛手没有学习力，宝可梦有。',
    '',
    '### 5. 突破次数',
    '',
    '两边的突破次数不一样。',
    '',
    '| 洛手 | 宝可梦 | 本仓 | 结论 |',
    '| --- | --- | --- | --- |',
    '| 有 | 有 | 有 | 一致 |',
    '| 有 | 有 | 有 | 一致 |',
    '| 有 | 有 | 有 | 一致 |',
    '| 有 | 有 | 有 | 一致 |',
    '| 有 | 有 | 有 | 一致 |',
    '| 有 | 有 | 有 | 一致 |',
  ].join('\n');
  const problems = auditSections(synthetic);
  assert.ok(problems.length >= 6, `每个无出处小节都要报（实际 ${problems.length}）`);
  assert.ok(problems.some((p) => p.includes('种族值')), `报错要点名小节：${problems}`);
  // 同一个总检查函数也必须判不合格（不能只有分项会报）
  const result = checkMechanicsDoc(synthetic);
  assert.equal(result.ok, false, '合成文本必须判不合格');
  assert.ok(result.problems.some((p) => p.includes('没有 来源')), `必须报"没出处"：${result.problems.slice(0, 3)}`);
});

test('⑦ 反证：加了 URL 就当过 —— 说明①卡的是出处，不是"文本像不像"', () => {
  const withSource = [
    '## 一、逐层对照',
    '',
    '来源：宝可梦侧见 https://pokemondb.net/mechanics/natures ，仓内见 src/coach/talent.js。',
    '',
    '### 1. 性格',
    '',
    '宝可梦 25 种性格、±10%、5 种中性：来源：https://pokemondb.net/mechanics/natures',
  ].join('\n');
  assert.deepEqual(auditSections(withSource), []);
  // 只差一个 URL，就必须红 —— 证明这条检查不是空跑
  const without = withSource.replace('：来源：https://pokemondb.net/mechanics/natures', '');
  assert.ok(auditSections(without).length >= 1);
  // `**来源**：` 这种写法也得认（文档里就是这么写的）
  assert.deepEqual(auditSections('## 一、层\n\n**来源**：data/roco/systems/natures.json\n'), []);
  // 但只有"来源"两个字、后面什么都没有 ⇒ 仍然算"等于没出处"
  const empty = auditSections('## 一、层\n\n**来源**：（待补）\n');
  assert.equal(empty.length, 1);
  assert.match(empty[0], /没有 URL 也没有仓内路径/);
});

test('⑧ 反证：路径检查可注入 —— 文件不存在必须报，"点了但不存在"不许放过', () => {
  const doc = `## 一、层\n\n来源：${REQUIRED_REPO_PATHS.join(' ')}\n`;
  const allThere = auditRepoPaths(doc, () => true);
  assert.deepEqual(allThere, [], '全部存在时应当通过');
  const missing = auditRepoPaths(doc, (url) => !String(url).includes('talent.js'));
  assert.ok(missing.some((p) => p.includes('src/coach/talent.js')), `必须抓到不存在的文件：${missing}`);
  // 一个字都没点的文档：每条都要报
  assert.equal(auditRepoPaths('## 空\n\n来源：https://example.com', () => true).length, REQUIRED_REPO_PATHS.length);
});

test('⑨ 正文档：整份文档过同一个总检查（正证；反证见 ⑥）', () => {
  const result = checkMechanicsDoc(readDoc());
  assert.deepEqual(result.problems, [], '整份对照表必须零问题');
  assert.equal(result.ok, true);
});
