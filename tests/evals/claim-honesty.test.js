// 口径诚实性（claim honesty）的机器检查。
//
// 为什么需要它
// ------------
// 本机模型（Qwen3.5-4B-4bit + LoRA `qwen35-4b-tool-v4`）在**两套不同的窗口集**上
// 各有一个数字，两者都真实，但只有一个可以说成「模型在这套任务集上的能力」：
//
//   * 宽口径（**唯一**可以当作任务集能力引用的那一个）：
//     **1,752 个窗口、1,617 通过 = 92.29%**；
//     与规则基线**共享的 864 个窗口**上逐条配对：**退化 42、扳回 0**。
//     来源：`docs/roco/W4-02-MODEL-CANDIDATES.md` §5（按类别表 + 合计行）
//     与 §5.2（配对表）；`docs/roco/PROGRESS.md` 的 W4-02 行。
//   * 窄口径（**单世界门禁**）：**275/288 = 95.49%**。
//     来源：`docs/roco/W4-04-SFT-PREREGISTRATION.md` §6、
//     `docs/roco/SHADOW-REPLAY.md` §7.3。
//
// 窄口径是**更简单的窗口集**（每任务只取 1 个世界，288 个窗口），
// 而宽口径取满 9 个世界（1,752 个窗口）。用窄口径描述「整体能力」会把
// 42 条退化盖住——项目自己的 P0-6（`docs/roco/DEMO-PLAN.md`）就是这么要求的。
//
// 这个测试**不是**「文件里有没有某个字符串」。它判的是**这句话怎么用这个数字**：
// 只有当一句话把这个单世界数字当成模型的「能力 / 成绩 / 通过率 / 表现」，
// 而且**同一句里没有交代窗口集**、也不属于预先约定的几类合法语境时，才判红。
// 每一处放行都写在下面并注明了理由（放行必须窄，否则检查器就是装饰）。
//
// 运行：
//   env -u NODE_TEST_CONTEXT -u NODE_TEST_WORKER_ID node --test tests/evals/claim-honesty.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {localModelMode} from '../../src/coach/local-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const rel = (path) => relative(ROOT, path).split(sep).join('/');
const read = (path) => readFileSync(path, 'utf8');
const asPosix = (path) => path.split(sep).join('/');

// ── 争议数字的四种写法（任务指定的那一组）────────────────────────────────────
// `275/288`、`0.9549`、`95.49%`、`95.5%`。前置换行断言（`(?<![\d.])`）是为了
// 不误伤 `1.9549`、`1275/288` 这类无关数字。
const CONTESTED_TOKENS = [
  {id: 'ratio', re: /(?<![\d.])275\s*\/\s*288/g, label: '275/288'},
  {id: 'rate', re: /(?<![\d.])0\.9549/g, label: '0.9549'},
  {id: 'pct2', re: /(?<![\d.])95\.49\s*[%％]/g, label: '95.49%'},
  {id: 'pct1', re: /(?<![\d.])95\.5\s*[%％]/g, label: '95.5%'},
];

// 能力的说法。出现这些词，才谈得上「把数字说成能力」。
const ABILITY_FRAME = /能力|表现|水平|性能|通过率|准确率|正确率|成绩|得分|效果|胜任/;

// 能力主体的说法：数字紧贴着模型/适配器出现时，即使没有「能力」二字，
// 也是把它当成模型的成绩在报（例如一句标题「本地模型 v4：95.49%」）。
const ABILITY_SUBJECT = /本地模型|本机模型|小模型|模型|适配器|v4|Qwen/i;

/**
 * 放行 A1：**同一句里交代了窗口集/口径**。
 *
 * 任务明确要求不许误伤这一种用法（`单世界`、`288 条`、`每任务 1 个世界`、
 * `worlds_per_task 1`、影子回放的单世界门禁）。
 *
 * 注意这里**故意不把 `n/288` 的分母算作交代**：`275/288` 只写了分母，
 * 并不说明这是「1 个世界的 288 个窗口」而不是「世界池决定的 1,752 个窗口」——
 * 把分母当交代的话，比值写法就永远不可能被判红，检查器也就没用了。
 */
const WINDOW_DISCLOSURE = /288\s*条|288\s*窗口|288\s*个窗口|单世界|单个世界|一个世界|1\s*个世界|1\s*个可用世界|每任务\s*1\s*个世界|worlds_per_task|worldsFor\([^)]*,\s*1\s*\)|同一把尺子|同一任务集|影子回放|shadow-replay/i;

/**
 * 放行 A2：**同一处把 288 这把尺子写给了两个以上的 arm**。
 *
 * 例如「基座 225/288、v1 229、v2 268、v3 204、v4 275/288」——窗口数是逐行
 * 列出来的，读者看得见这是一张 arm × 288 的表，不是在讲整体能力。
 * 这条只对「同一单位里出现 ≥2 次 288」生效，单独一句 `275/288` 不满足。
 */
const sameUnitDenominators = (unit) => (unit.match(/288/g) || []).length >= 2;

/**
 * 放行 A3：**禁止性语境**。
 *
 * `docs/roco/DEMO-PLAN.md` 的 P0-6 验收行写的是「全局搜索**不得**出现用
 * `275/288` 描述『整体能力』的句子」——数字在反引号里、句子是否定。
 * 要求同时满足：句内有禁止/否定词，且争议数字本身在成对反引号内。
 */
const PROHIBITION = /不得|不许|不能|禁止|严禁|掩盖|盖住|别用|勿用/;

/** 放行 A4/A5/A6：任务点名的三类合法语境（按文档类型）。 */
const PREREG_DOC = 'docs/roco/W4-04-SFT-PREREGISTRATION.md';
const SHADOW_GATE_DOC = 'docs/roco/SHADOW-REPLAY.md';
const isRetiredArchive = (file) => /(^|\/)reports\/roco\/invalidated\//.test(file);

/** 争议数字是否落在成对的反引号里（`...`）。 */
function isBackticked(unit, index) {
  const backticksBefore = (unit.slice(0, index).match(/`/g) || []).length;
  return backticksBefore % 2 === 1;
}

function hasAbilityFrame(unit, tokens) {
  if (ABILITY_FRAME.test(unit)) return true;
  for (const token of tokens) {
    const around = unit.slice(Math.max(0, token.index - 16), token.index + token.label.length + 16);
    if (ABILITY_SUBJECT.test(around)) return true;
  }
  return false;
}

/**
 * 把文本切成人能读的「一句」。
 *
 * 表格行整行算一个单位（本项目的台账/状态文档一行就是一条完整记录，
 * 切开反而会把「同一把 288 条尺子」和数字分开）。散文按中文句末切，
 * **不按 `；` 切**，同样是为了不把口径和数字切开。
 */
function splitUnits(text) {
  const units = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    if (/^\s*\|/.test(raw)) {
      units.push({line: i + 1, text: raw});
      continue;
    }
    for (const part of raw.split(/(?<=[。！？])/)) {
      if (part.trim()) units.push({line: i + 1, text: part});
    }
  }
  return units;
}

/** 对一句给出裁定。返回值是放行理由或 `VIOLATION`。 */
function judgeUnit(unit, file, tokens) {
  if (WINDOW_DISCLOSURE.test(unit)) return 'allowed-window-disclosed';          // A1
  if (sameUnitDenominators(unit)) return 'allowed-ruler-written-per-arm';       // A2
  if (PROHIBITION.test(unit) && tokens.every((t) => isBackticked(unit, t.index))) {
    return 'allowed-prohibition';                                               // A3
  }
  // A4：预注册文档。整份文档就是「同一把尺子」的预注册，里面所有数字都是
  // **同一个窗口集内部**的横向比较（W4-04 §4/§6 自己写明了这一点），
  // 所以不在这里管它内部怎么比。
  if (file === PREREG_DOC) return 'allowed-preregistration';
  // A5：已作废的存档目录（`reports/roco/invalidated/` 的 README 就是这批证据的
  // 登记簿，逐行写的是 arm/288，并声明这批产物不得再被引用）。
  if (isRetiredArchive(file)) return 'allowed-retired-archive';
  // A6：影子回放门禁文档本身。这份文档通篇在讲那把单世界 288 窗口的尺子
  // （§1 写明「288 条 / 8 类」，§7.3 就是门禁表），它就是任务点名的那个门禁。
  if (file === SHADOW_GATE_DOC) return 'allowed-shadow-replay-gate-doc';
  if (hasAbilityFrame(unit, tokens)) return 'VIOLATION';
  return 'allowed-no-ability-claim';
}

/** 扫描一份文本，返回其中所有含争议数字的单位及其裁定。 */
export function auditClaimUnits({file, text}) {
  const found = [];
  for (const unit of splitUnits(text)) {
    const tokens = [];
    for (const token of CONTESTED_TOKENS) {
      token.re.lastIndex = 0;
      let match;
      while ((match = token.re.exec(unit.text)) !== null) {
        tokens.push({id: token.id, label: match[0], index: match.index});
      }
    }
    if (!tokens.length) continue;
    found.push({
      file, line: unit.line, text: unit.text,
      tokens: tokens.map((t) => t.label),
      verdict: judgeUnit(unit.text, file, tokens),
    });
  }
  return found;
}

/**
 * 宽口径诚实注记是否还在。
 *
 * 任务要求：模型候选文档与台账必须留着 **92.29%（或 1,617/1,752）** 与配对结果
 * **退化 42 / 扳回 0**。谁把这段注记删了，这里就红。
 */
export function checkBroadMeasurement(text) {
  const count = /(?<![\d.])92\.29\s*[%％]/.test(text)
    || /1[,，]?617\s*\/\s*1[,，]?752/.test(text)
    || /(?<![\d.])0\.9229\b/.test(text);
  const regressions = /退化\s*\**\s*42/.test(text);
  const recovered = /扳回\s*\**\s*0/.test(text);
  return {ok: count && regressions && recovered, count, regressions, recovered};
}

/**
 * 玩家页面上有没有「把本地模型打开」的入口。
 *
 * 具体搜的是四类东西（不是笼统地搜 `on`）：
 *   1. 客户端出现 `ROCO_LOCAL_MODEL`——这个开关只该由服务端进程环境读；
 *   2. 把 `on` 写进档位/mode 字段（`localModelMode = 'on'`、`mode: 'on'` …）；
 *   3. `<select>` 里存在 `value="on"` 的档位且该下拉框与本地模型相关；
 *   4. 与本地模型相关的 `<input type="checkbox|radio">`。
 */
export function findLocalModelOnAffordances({html = '', js = ''}) {
  const findings = [];
  const lineOf = (text, index) => text.slice(0, index).split('\n').length;
  const scan = (name, text) => {
    text.split('\n').forEach((line, i) => {
      if (/ROCO_LOCAL_MODEL/.test(line)) {
        findings.push({where: `${name}:${i + 1}`, why: '客户端出现 ROCO_LOCAL_MODEL（开关只该由服务端环境读）', text: line.trim().slice(0, 160)});
      }
      if (/(localModelMode|localModel|local_model|local-model|modelMode|mode)\s*[:=]\s*['"`]on['"`]/.test(line)) {
        findings.push({where: `${name}:${i + 1}`, why: '把 on 写进档位/mode 字段', text: line.trim().slice(0, 160)});
      }
      if (/['"`]on['"`]\s*[:=]?\s*(localModelMode|localModel|ROCO_LOCAL_MODEL)/.test(line)) {
        findings.push({where: `${name}:${i + 1}`, why: '把 on 当成档位取值', text: line.trim().slice(0, 160)});
      }
    });
    for (const block of text.match(/<select\b[\s\S]{0,600}?<\/select>/gi) || []) {
      if (/value\s*=\s*["']on["']/i.test(block) && /(local|本地模型|model)/i.test(block)) {
        findings.push({where: `${name}:${lineOf(text, text.indexOf(block))}`, why: '下拉框里存在与本地模型相关的 value="on" 档位', text: block.replace(/\s+/g, ' ').trim().slice(0, 160)});
      }
    }
    for (const control of text.match(/<input\b[^>]*type\s*=\s*["'](checkbox|radio)["'][^>]*>/gi) || []) {
      const at = text.indexOf(control);
      const around = text.slice(Math.max(0, at - 200), at + control.length + 200);
      if (/(local|本地模型|模型档位)/i.test(around)) {
        findings.push({where: `${name}:${lineOf(text, at)}`, why: '存在与本地模型相关的勾选/单选控件', text: control});
      }
    }
  };
  scan('roco.html', html);
  scan('roco.js', js);
  return findings;
}

/**
 * 轨迹文档对「模型候选那一半」的说法必须与台账一致。
 *
 * 第 41 轮已用本机模型补齐这一半；`docs/roco/AGENT-TRAJECTORIES.md` §5 原来
 * 还写着「需要 DeepSeek key……这一半仍未完成」。那条说法会把已经测出来的
 * 1,752 条宽口径结果说成不存在，所以要在两处同时钉住。
 */
export function checkModelArmStatus(text) {
  return {
    claimsUnfinished: /模型候选[^\n。]{0,40}(仍未完成|未完成)/.test(text)
      || /模型候选生成需要 DeepSeek key/.test(text),
    claimsDone: /1[,，]?752/.test(text) && /(本地模型补齐|已用本地模型|用本机模型补齐)/.test(text),
  };
}

// ── 扫描范围 ────────────────────────────────────────────────────────────────
function walk(dir, ext) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out.sort();
}

const DOC_FILES = [...walk(join(ROOT, 'docs'), '.md'), join(ROOT, 'README.md')];
const REPORT_FILES = walk(join(ROOT, 'reports'), '.md');
const CLIENT_FILES = [...walk(join(ROOT, 'src', 'client'), '.js'), ...walk(join(ROOT, 'src', 'client'), '.html')];
const SCAN_FILES = [...DOC_FILES, ...REPORT_FILES, ...CLIENT_FILES].filter((f) => existsSync(f));

const PATH = {
  modelCandidates: join(ROOT, 'docs/roco/W4-02-MODEL-CANDIDATES.md'),
  progress: join(ROOT, 'docs/roco/PROGRESS.md'),
  agentTrajectories: join(ROOT, 'docs/roco/AGENT-TRAJECTORIES.md'),
  localModel: join(ROOT, 'src/coach/local-model.js'),
  rocoHtml: join(ROOT, 'src/client/roco.html'),
  rocoJs: join(ROOT, 'src/client/roco.js'),
};

// ── 1. 扫描：单世界数字不得被当成整体能力 ────────────────────────────────────
test('扫描 docs / reports 的 markdown 与玩家端源码：单世界 288 数字不得被当成整体能力', () => {
  const perFile = [];
  const violations = [];
  const allowanceHistogram = {};
  let candidateUnits = 0;

  for (const file of SCAN_FILES) {
    const units = auditClaimUnits({file: rel(file), text: read(file)});
    candidateUnits += units.length;
    for (const unit of units) {
      allowanceHistogram[unit.verdict] = (allowanceHistogram[unit.verdict] || 0) + 1;
      if (unit.verdict === 'VIOLATION') violations.push(unit);
    }
    perFile.push({file: rel(file), contested: units.length, allowed: units.filter((u) => u.verdict !== 'VIOLATION').length, flagged: units.filter((u) => u.verdict === 'VIOLATION').length});
  }

  // 逐文件报表（含 0 的文件也报，证明它真的被读了）
  console.log(`\n[claim-honesty] 扫描 ${SCAN_FILES.length} 个文件（docs markdown + reports markdown + src/client）`);
  for (const row of perFile) {
    console.log(`  ${row.file}  争议=${row.contested} 放行=${row.allowed} 判红=${row.flagged}`);
  }
  // 每一处争议用法的完整审计轨迹：谁、哪一行、按哪条放行理由、原文是什么。
  // 这份清单就是「口径审计」的原始证据，改动语料时会直接显示出来。
  console.log('[claim-honesty] 争议用法逐条：');
  for (const file of SCAN_FILES) {
    for (const unit of auditClaimUnits({file: rel(file), text: read(file)})) {
      console.log(`  · ${unit.file}:${unit.line}  [${unit.tokens.join(', ')}] → ${unit.verdict}\n      ${unit.text.trim().slice(0, 220)}`);
    }
  }
  console.log('[claim-honesty] 放行理由分布：', allowanceHistogram);

  assert.equal(violations.length, 0, [
    '发现把单世界 288 窗口数字当作「整体能力」的句子（宽口径是 1,752 窗口 = 92.29%，配对退化 42/扳回 0）：',
    ...violations.map((v) => `  ${v.file}:${v.line}  [${v.tokens.join(', ')}]  ${v.text.trim()}`),
  ].join('\n'));

  // 反空转：检查器必须真的扫到了一批争议用法，而且每一条放行理由都**至少被用到一次**。
  // 少了这一段，一个「什么都匹配不到」的空检查器也能全绿。
  assert.ok(candidateUnits >= 12, `含争议数字的单位只有 ${candidateUnits} 个，扫描范围或数字写法可能已经变了`);
  for (const reason of ['allowed-window-disclosed', 'allowed-ruler-written-per-arm', 'allowed-prohibition', 'allowed-preregistration', 'allowed-retired-archive', 'allowed-shadow-replay-gate-doc']) {
    assert.ok((allowanceHistogram[reason] || 0) >= 1, `放行理由「${reason}」一次都没被用到——它要么写错了，要么语料已经变了（该理由必须被实际行使，否则是死代码）`);
  }
});

// ── 2. 宽口径数字必须留在它该在的地方 ───────────────────────────────────────
test('宽口径诚实注记：模型候选文档与台账都必须有 92.29%（或 1,617/1,752）与配对退化 42 / 扳回 0', () => {
  for (const [name, path] of [['模型候选文档', PATH.modelCandidates], ['台账', PATH.progress]]) {
    const result = checkBroadMeasurement(read(path));
    assert.ok(result.count, `${name}（${rel(path)}）里找不到宽口径数字（92.29% / 1,617/1,752）`);
    assert.ok(result.regressions, `${name}（${rel(path)}）里找不到配对结果「退化 42」`);
    assert.ok(result.recovered, `${name}（${rel(path)}）里找不到配对结果「扳回 0」`);
    assert.ok(result.ok, `${name}（${rel(path)}）的宽口径诚实注记不完整：${JSON.stringify(result)}`);
  }
});

// ── 3. 玩家页面不能把本地模型打开 ───────────────────────────────────────────
test('玩家页面不能把本地模型打开：客户端没有写 on 的入口', () => {
  const html = read(PATH.rocoHtml);
  const js = read(PATH.rocoJs);

  // 逐条点名搜了什么，失败时能直接看出是哪一类命中。
  assert.ok(!/ROCO_LOCAL_MODEL/.test(html), 'src/client/roco.html 出现了 ROCO_LOCAL_MODEL（这个开关只该由服务端进程环境读）');
  assert.ok(!/ROCO_LOCAL_MODEL/.test(js), 'src/client/roco.js 出现了 ROCO_LOCAL_MODEL（这个开关只该由服务端进程环境读）');
  assert.ok(!/(localModelMode|localModel|local_model|local-model|modelMode|mode)\s*[:=]\s*['"`]on['"`]/.test(html + js),
    '搜的是「把 on 写进档位/mode 字段」（例如 localModelMode = \'on\'、mode: "on"）');
  // 只针对「on」这个档位值，而不是笼统地禁掉 <select>/<input>——
  // 页面上将来出现与本地模型无关的下拉框或勾选框不该被这条测试误伤。
  assert.ok(!/<option\b[^>]*value\s*=\s*["']on["']/i.test(html),
    '搜的是 <option value="on">——下拉框里不该存在「on」这个档位');
  assert.ok(!/<input\b[^>]*type\s*=\s*["'](checkbox|radio)["'][^>]*value\s*=\s*["']on["'][^>]*>/i.test(html),
    '搜的是 value="on" 的勾选/单选控件——不该有能把本地模型拨到 on 的开关');

  const findings = findLocalModelOnAffordances({html, js});
  assert.deepEqual(findings, [], `玩家页面出现可切换本地模型的入口：\n${findings.map((f) => `  ${f.where} ${f.why} :: ${f.text}`).join('\n')}`);
});

test('local-model 的 feature flag 默认 off，未知取值一律退化成 off', () => {
  // 直接跑真实现，而不是在源码里找字符串。
  assert.equal(localModelMode({}), 'off', '未设置 ROCO_LOCAL_MODEL 时必须 off');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: undefined}), 'off');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: ''}), 'off');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: 'off'}), 'off');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: 'OFF'}), 'off');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: 'shadow'}), 'shadow');
  assert.equal(localModelMode({ROCO_LOCAL_MODEL: 'on'}), 'on');
  for (const junk of ['莫名其妙', '开', '开启', 'enabled', 'on!', 'on off', 'null', '2']) {
    assert.equal(localModelMode({ROCO_LOCAL_MODEL: junk}), 'off', `未知取值「${junk}」必须保守地当成 off`);
  }
  // 源码层再钉一道：即使将来有人重写函数体，默认值也得是 off。
  const source = read(PATH.localModel);
  assert.match(source, /env\.ROCO_LOCAL_MODEL\s*\|\|\s*'off'/, 'src/coach/local-model.js 的默认值不再是 off');
  assert.ok((source.match(/return 'off'/g) || []).length >= 2,
    'src/coach/local-model.js 至少要有一处「默认 off」和一处「未知取值退化成 off」');
});

// ── 4. 反向对照：检查器必须能红 ─────────────────────────────────────────────
test('反向对照：故意违规的输入必须被判红（检查器不能是「总是 true」）', () => {
  const CONTROL_FILE = 'inline://反向对照.md';

  // 4.1 把单世界比值/百分数当成整体能力
  const claimControls = [
    {name: '比值形式 + 整体能力', text: '本地模型（Qwen3.5-4B + LoRA v4）在这套任务集上的整体能力是 275/288，也就是 95.49%，可以直接替代规则臂。'},
    {name: '百分数形式 + 通过率', text: '本机小模型的通过率是 95.5%，说明它已经能胜任这套任务。'},
    {name: '标题式（主体紧贴数字，无「能力」二字）', text: '本地模型 v4：95.49%'},
  ];
  for (const control of claimControls) {
    const units = auditClaimUnits({file: CONTROL_FILE, text: control.text});
    assert.ok(units.some((u) => u.verdict === 'VIOLATION'),
      `检查器漏掉了故意违规（${control.name}）：${control.text}\n→ ${JSON.stringify(units)}`);
  }
  // 同一批文本只要补上窗口集交代，就应当变成放行——证明判的是「怎么用」，不是「有没有」。
  const disclosed = auditClaimUnits({file: CONTROL_FILE, text: '本地模型在单世界 288 条门禁上的整体能力是 275/288。'});
  assert.ok(disclosed.every((u) => u.verdict !== 'VIOLATION'),
    `交代了窗口集的句子不该被判红：${JSON.stringify(disclosed)}`);

  // 4.2 宽口径诚实注记被删掉
  const doc = read(PATH.modelCandidates);
  assert.equal(checkBroadMeasurement(doc).ok, true, '前置条件不成立：模型候选文档本身就没有完整注记');
  const stripped = doc
    .replace(/1,617\/1,752/g, '（已删）')
    .replace(/(?<![\d.])0\.9229\b/g, '（已删）')
    .replace(/(?<![\d.])92\.29\s*[%％]/g, '（已删）');
  assert.equal(checkBroadMeasurement(stripped).count, false, '删掉宽口径数字后检查器仍认为数字在位');
  assert.equal(checkBroadMeasurement(stripped).ok, false, '删掉宽口径注记后检查器仍判过——那不是检查器');

  // 4.3 伪造一个能把本地模型打开的 UI
  const cleanClient = {html: read(PATH.rocoHtml), js: read(PATH.rocoJs)};
  assert.deepEqual(findLocalModelOnAffordances(cleanClient), [], '真实页面不该有任何打开本地模型的入口');
  const fabricated = {
    html: '<select id="local-model-mode" aria-label="本地模型档位">\n<option value="off">关闭</option>\n<option value="on">打开（本地模型接管正文）</option>\n</select>',
    js: "async function setLocalMode(mode) {\n  await fetch('/api/roco/settings', {method: 'POST', body: JSON.stringify({ROCO_LOCAL_MODEL: mode})});\n}\nsetLocalMode('on');",
  };
  assert.ok(findLocalModelOnAffordances(fabricated).length > 0,
    '伪造的「打开本地模型」开关没有被检查器抓到');

  // 4.4 仍然声称「模型候选那一半没做」
  const stale = '模型候选生成需要 DeepSeek key（本机无 key），W4-02 的「模型候选轨迹」这一半仍未完成。';
  assert.equal(checkModelArmStatus(stale).claimsUnfinished, true, '过期说法没有被状态检查器抓到');
});

// ── 5. 轨迹文档与台账对「模型候选那一半」的说法必须一致 ─────────────────────
test('台账说模型候选那一半已补齐，轨迹文档不得再声称它没做', () => {
  const ledger = checkModelArmStatus(read(PATH.progress));
  assert.ok(ledger.claimsDone, 'docs/roco/PROGRESS.md 必须写明模型候选那一半已用本地模型补齐（1,752 条）');

  const trajectories = read(PATH.agentTrajectories);
  const status = checkModelArmStatus(trajectories);
  assert.equal(status.claimsUnfinished, false,
    'docs/roco/AGENT-TRAJECTORIES.md 仍在声称模型候选那一半未完成（第 41 轮已用本机模型补齐：1,752 条窗口、1,617/1,752 = 0.9229，配对退化 42/扳回 0）');
  assert.ok(status.claimsDone,
    'docs/roco/AGENT-TRAJECTORIES.md 应写明模型候选那一半已补齐，并给出 1,752 条这个宽口径数字');
});
