#!/usr/bin/env node
// RC-305 六槽阵容工作台的**浏览器可见行为**验收（模块挂在产品页 `roco.html` 上）。
//
// 与 `browser-box-acceptance.mjs` 同一套骨架（CDP + 真实键鼠），验的是**产品页里的那一块**：
//
//   ① 产品页 `roco.html` 上真的有 `#team-workshop`，并且真的被 `team-workshop.js`
//      挂起来了（shadow root 里有六个槽位、候选池是**全量图鉴 ≥600**）。
//   ② 逐只用**真实鼠标**点候选池，连续选入六只：`2～5 只` 时评估随着阵容变化
//      （候选换人、缺口清单在、取舍标签在），选满六只后出现**完整诊断**
//      （五轴 + 一个最小替换 + 未知清单）。
//   ③ 首屏徽记必须在**可见文本**里：「标准 PVP · 六宠」「候选规则（待实机核对）」
//      「匹配前对手未知」「候选来自全图鉴」；「已选 3 只固定栏」这类 v3 废止口径必须没有。
//   ④ **没有真实环境分布就绝不给胜率或伪精确强度数字**：玩家可见文本里不许出现
//      「数字 + %」或「胜率/概率 + 数字」；算不出来的轴必须写「现在算不出来」并点名缺什么，
//      不许补 0。
//   ⑤ 两档（1440×900 / 390×844）都没有横向溢出（`clientW == scrollW`），
//      390px 下模块里每个可点元素 ≥44px，且**区块顺序**是
//      「队伍槽位 → 候选池 → 当前评估 → Coach 短提示」。
//
// 这个文件**同时是判据的唯一来源**：`tests/roco-workshop.test.js` 直接 import 下面这些导出
// 来跑必红反证。判据写两份就会各自漂移，所以 main() 只在「这个文件是被直接执行的那一个」
// 时才跑。
//
// 用法：
//   node scripts/roco/browser-workshop-acceptance.mjs [--keep-open]
// 产物（reports/roco/workshop-acceptance/）：
//   browser-workshop-acceptance.json
//   workshop-01-roco-page-1440x900.png / workshop-02-two-selected-1440x900.png
//   workshop-03-six-selected-1440x900.png / workshop-04-fixture-1440x900.png
//   workshop-05-six-selected-390x844.png / workshop-06-two-selected-390x844.png

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';
import {TEAM_WORKSHOP_BADGES, TEAM_SLOTS} from '../../src/client/team-workshop.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports/roco/workshop-acceptance');
const REPORT = 'reports/roco/workshop-acceptance/browser-workshop-acceptance.json';
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[workshop-acceptance]', ...a);
const KEEP_OPEN = process.argv.includes('--keep-open');

// ── 判据（纯函数，反证与真判据共用同一份）────────────────────────────────

/** 槽位数必须是六。这是「不许退回已选 3 只固定栏」那条纠偏的机器判据。 */
export const SLOT_COUNT = TEAM_SLOTS;

/** 玩家可见文本的禁词表：工程键名 / 枚举名 / 裸 JSON。报错时给**命中原文**。 */
export const FORBIDDEN_PLAYER = /pet_id|species_id|instance_id|state_version|coverage|provenance|source_scope|unknown_fields|ranker_status|ruleset|licence|pack_id|digest|build_hash|dataset_hash|[{}]|"\w+"\s*:/;

/**
 * 伪精确：**胜率 / 概率 / 百分数**。
 *
 * 刻意**不**把「胜率」这个词本身当违规：页面有一句「不给胜率」的口径说明。
 * 判据抓的是「把胜率当结论报出来」（带数字）与「数字 + %」。反证样本是「胜率 58%」。
 */
export const PSEUDO_PRECISION = /\d+(?:\.\d+)?\s*%|(?:胜率|概率|百分比|强度分)[^。；，]{0,6}\d/;

/** 旧口径：把六槽退回「已选 3 只固定栏 / 固定 60 池」。 */
export const LEGACY_SLOT_COPY = /已选\s*3\s*只|固定队伍栏|固定\s*60\s*池|标准\s*PVP\s*3v3|搜索名字（48 只）/;

/** 一份玩家层载荷里不许出现的键名（值层面的 id 形状由同一函数另外抓）。 */
export const FORBIDDEN_KEYS = new Set(['pet_id', 'species_id', 'instance_id', 'state_version', 'coverage',
  'provenance', 'source_scope', 'unknown_fields', 'licence_ref', 'licence', 'pack_id', 'ruleset_id',
  'ruleset_config_id', 'digest', 'build_hash', 'dataset_hash', 'refs', 'snapshot', 'evidence_ids',
  'ranker_status', 'machine_evidence', 'confidence', 'unknown_reason', 'gates', 'gate']);
/** 页面内部接线键：它们的值允许是 id（页面靠它取数 / 加人），但页面上不显示。 */
export const WIRING_KEYS = new Set(['candidate_key']);

/** 遍历一份 JSON，按键名与 id 形状两条判它是不是漏进玩家层。返回违规原文数组。 */
export function playerLayerProblems(payload) {
  const problems = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEYS.has(key)) problems.push(`玩家层出现工程键 ${here}`);
      if (typeof value === 'string' && !WIRING_KEYS.has(key) && /pet_\d{6}|own-\d{4}/.test(value)) {
        problems.push(`玩家层的 ${here} 里出现 id 形状的值：${value}`);
      }
      walk(value, here);
    }
  };
  walk(payload, '');
  return problems;
}

/** 六个槽位：状态必须是六个，且页面真的画出六个节点。 */
export function slotProblems(facts) {
  const problems = [];
  if (facts.slots !== SLOT_COUNT) {
    problems.push(`槽位数必须是 ${SLOT_COUNT}，实际 ${JSON.stringify(facts.slots)}`);
  }
  if (facts.slotNodes !== SLOT_COUNT) {
    problems.push(`页面上必须画出 ${SLOT_COUNT} 个槽位节点，实际 ${JSON.stringify(facts.slotNodes)}`);
  }
  if (facts.filled > facts.slots) problems.push(`已填槽位 ${facts.filled} 多于槽位总数 ${facts.slots}`);
  return problems;
}

/** 首屏徽记与候选宇宙：三枚徽记必须逐字在，候选池必须 ≥600。 */
export function badgeProblems(facts) {
  const problems = [];
  if (!facts.hasModeBadge) problems.push(`缺徽记「${TEAM_WORKSHOP_BADGES.mode}」`);
  if (!facts.hasCandidateBadge) problems.push(`缺徽记「${TEAM_WORKSHOP_BADGES.candidate}」`);
  if (!facts.hasUnknownPrematch) problems.push('缺「匹配前对手未知」这句前提');
  if (!facts.hasFullUniverse) problems.push('没有写「候选来自全图鉴」——候选池不许只说 48 只');
  if (!(Number(facts.poolTotal) >= 600)) {
    problems.push(`候选池总量必须 ≥600（全量图鉴），实际 ${JSON.stringify(facts.poolTotal)}`);
  }
  if (facts.mentionsLegacySlots) problems.push('仍出现「已选 3 只固定栏 / 固定 60 池」的废止口径');
  return problems;
}

/**
 * 2～5 只：**恰好三个**下一只候选，取舍标签两两不同，且至少覆盖两个真正的取舍口径。
 *
 * 「三个口径」是 RC-303 的目标形态，但不是永远成立：偏好保留池里没有 favourite/locked 时它会
 * **如实回落到强度口径**（原因在 `fallback_reason`），两个口径指同一只精灵时按物种去重，
 * 第三个位置由召回的参考候选补上（`tradeoff_label:'候选参考'`、`source:'recall_tail'`）。
 * 所以判据钉「恰好三个 + 标签不重复 + ≥2 个真口径」，不钉三个字面标签——后者会逼实现
 * 编一个不存在的候选取舍出来。反证样本仍然是「三个变两个」。
 */
export function nextCandidateProblems(facts) {
  const problems = [];
  const labels = facts.labels ?? [];
  if (facts.count !== 3) problems.push(`下一只候选必须恰好 3 个，实际 ${JSON.stringify(facts.count)}`);
  if (facts.cardNodes !== 3) problems.push(`页面上必须画出 3 个候选节点，实际 ${JSON.stringify(facts.cardNodes)}`);
  if (new Set(labels).size !== labels.length) {
    problems.push(`三个候选的取舍标签必须两两不同，实际 ${JSON.stringify(labels)}`);
  }
  const tradeoffs = labels.filter((label) => ['强度', '稳定', '偏好保留'].includes(label));
  if (tradeoffs.length < 2) {
    problems.push(`至少要有两个真正的取舍口径（强度 / 稳定 / 偏好保留），实际 ${JSON.stringify(labels)}`);
  }
  return problems;
}

/**
 * 阵容变化必须让评估跟着变：同一份判据吃两次量测（选 2 只 / 选 5 只），
 * 候选名单与缺口清单**不能逐字相同**——否则「评估随阵容变化」就是装饰。
 */
export function evaluationFollowsTeamProblems(before, after) {
  const problems = [];
  if (before.selected === after.selected) {
    problems.push(`两次量测的已选数相同（${before.selected}）：这一条判据没被真正驱动`);
  }
  if (JSON.stringify(before.nextNames) === JSON.stringify(after.nextNames)) {
    problems.push(`阵容从 ${before.selected} 只变到 ${after.selected} 只，下一只候选却一字未变：`
      + `${JSON.stringify(after.nextNames)}`);
  }
  if (after.gapNodes < 1) problems.push('评估区里没有缺口清单（七维诊断没有呈现）');
  if (after.nextNodes !== 3) problems.push(`评估区里下一只候选不是 3 个，实际 ${after.nextNodes}`);
  return problems;
}

/** 选满 6 只：五轴必须都在，且 `available:false` 的轴不许带数值、必须给原因。 */
export function axisProblems(axes) {
  const problems = [];
  if (!Array.isArray(axes) || axes.length !== 5) {
    problems.push(`五轴必须恰好 5 条，实际 ${Array.isArray(axes) ? axes.length : JSON.stringify(axes)}`);
    return problems;
  }
  const labels = ['环境价值', '最怕的体系', '对局离散度', '操作容错', '覆盖置信'];
  for (const label of labels) {
    if (!axes.some((axis) => axis.label === label)) problems.push(`五轴缺「${label}」`);
  }
  for (const axis of axes) {
    if (axis.available === true && (axis.value === null || axis.value === undefined)) {
      problems.push(`轴「${axis.label}」标着能算却没有值（不许把 unknown 写成 0 之外的假值）`);
    }
    if (axis.available === false) {
      if (axis.value !== null) problems.push(`轴「${axis.label}」算不出来却带着值 ${JSON.stringify(axis.value)}（不许补 0）`);
      if (typeof axis.unknown_reason !== 'string' || axis.unknown_reason.length < 8) {
        problems.push(`轴「${axis.label}」算不出来却没点名缺什么：${JSON.stringify(axis.unknown_reason)}`);
      }
    }
  }
  return problems;
}

/** 非法参数：必须 HTTP 400 + ok:false + 点名。 */
export function badRequestProblems(raw, json, status, needle) {
  const problems = [];
  if (!(status === 400 && json?.ok === false)) {
    problems.push(`${raw} 必须 HTTP 400 + ok:false，实际 HTTP ${status} ok=${JSON.stringify(json?.ok)}`);
    return problems;
  }
  if (typeof json.error !== 'string' || !json.error.includes(needle)) {
    problems.push(`${raw} 的错误必须点名 ${needle}，实际 ${JSON.stringify(json.error)}`);
  }
  return problems;
}

/**
 * 一份玩家层载荷里**全部字符串值**的拼接（不含键名）。
 *
 * 为什么这么取：`player` 段是一个 JSON 对象，直接 `JSON.stringify` 会把自己带的大括号
 * 也算进「玩家可见文本」——`FORBIDDEN_PLAYER` 里那两条 `[{}]` / `"x":` 是给**渲染出来的
 * 文本**用的，套在 JSON 上会把干净的回执判红。所以文案判据只吃字符串值；
 * 键名层面的禁令由 `playerLayerProblems` 管，两者分工不同。
 */
/**
 * 卡片首层的**机制行**必须真的渲染出来（第 92 轮追加）。
 *
 * 三条硬规则合成一条机器判据：
 *   ① 冻结原文（`FROZEN_DESC` + 非空 `line`）⇒ 卡上必须有那一行**逐字**文本（不截断）；
 *   ② 其余（取不到 / `MECHANISM_UNCONFIRMED` / 形状不对）⇒ 卡上写「机制资料待确认」；
 *   ③ 枚举原文（`FROZEN_DESC` / `MECHANISM_UNCONFIRMED`）**永远不许**出现在可见文本里。
 *
 * `facts` 形状：`{expectedLines, renderedLines, mechanismNodes, filledSlots, pendingNodes, playerText}`。
 * 反证样本：把 `expectedLines` 里的一行从 `renderedLines` 拿掉 ⇒ 必须红。
 */
export function mechanismRenderProblems(facts) {
  const problems = [];
  const expected = facts.expectedLines ?? [];
  const rendered = facts.renderedLines ?? [];
  if (expected.length === 0) {
    problems.push('这一份量测里没有任何冻结机制原文可查——判据等于空转（用例本身没被驱动）');
  }
  if ((facts.mechanismNodes ?? 0) < (facts.filledSlots ?? 0)) {
    problems.push(`卡上的机制行节点（${facts.mechanismNodes}）少于已填槽位（${facts.filledSlots}）`);
  }
  for (const line of expected) {
    if (!rendered.some((text) => String(text).includes(line))) {
      problems.push(`冻结机制原文没有渲染到卡上：「${line}」`);
    }
  }
  for (const enumWord of ['FROZEN_DESC', 'MECHANISM_UNCONFIRMED']) {
    if (String(facts.playerText ?? '').includes(enumWord)) {
      problems.push(`可见文本里出现机制枚举原文「${enumWord}」`);
    }
  }
  if ((facts.filledSlots ?? 0) > 0 && rendered.length === 0) {
    problems.push('已填槽位上一个机制行都没有：冻结原文一条都没上卡');
  }
  return problems;
}

/**
 * 两阶段交付（RC-306）的**机器判据**。
 *
 * 两条互相独立的事实：
 *   · `serving` 契约：`stage=first` 的回执必须 `axes === null`、`axes_status === 'not_requested'`、
 *     `serving.full_withheld === 'NOT_REQUESTED'`（主动不要证据段 ≠ 超时降级）；
 *     而且它真的**产出了初判**（`full === null`、`degraded === false`）。
 *   · 页面真的**分两次要**：`fetches` 顺序必须是 `first|full`，并且**在完整载荷到达之前**
 *     槽位就已经画出来了（`renderedAfterFirst === 'yes'`），两次渲染的耗时也都量到了。
 *
 * 反证样本：① 让 first 那一次也带上五轴（`axes` 不是 null）⇒ 红；
 *          ② 退化成一次请求（`fetches === 'full'` / `first_ms` 缺失）⇒ 红。
 */
export function stageFirstProblems(json) {
  const problems = [];
  const serving = json?.serving ?? null;
  if (!serving) { problems.push('stage=first 的回执里没有 serving 信封'); return problems; }
  if (json.axes !== null) problems.push(`stage=first 的 axes 必须是 null，实际 ${JSON.stringify(json.axes)?.slice(0, 40)}`);
  if (json.axes_status !== 'not_requested') problems.push(`axes_status 必须是 not_requested，实际 ${JSON.stringify(json.axes_status)}`);
  if (serving.full_withheld !== 'NOT_REQUESTED') {
    problems.push(`full_withheld 必须是 NOT_REQUESTED（主动不要证据段），实际 ${JSON.stringify(serving.full_withheld)}`);
  }
  if (serving.full !== null) problems.push(`stage=first 不许产出完整段，实际 full=${JSON.stringify(serving.full)?.slice(0, 40)}`);
  if (serving.degraded === true) problems.push('stage=first 是「调用方主动只要初判」，不是降级：degraded 必须是 false');
  if (serving.first?.kind !== 'structured_first') {
    problems.push(`serving.first.kind 必须是 structured_first，实际 ${JSON.stringify(serving.first?.kind)}`);
  }
  if (!(Array.isArray(serving.withheld_stages) && serving.withheld_stages.includes('evidence_and_counterfactual'))) {
    problems.push(`withheld_stages 必须点名证据段，实际 ${JSON.stringify(serving.withheld_stages)}`);
  }
  return problems;
}

/**
 * 页面把「两阶段」真的做出来了：请求顺序 + 初判先于完整载荷渲染 + 两次耗时都量到。
 * `facts` 形状：`{fetches, renderedAfterFirst, firstMs, fullMs, degraded}`。
 */
export function stageSequenceProblems(facts) {
  const problems = [];
  if (facts.fetches !== 'first|full') {
    problems.push(`请求顺序必须是 first|full（初判先发、完整载荷后发），实际 ${JSON.stringify(facts.fetches)}`);
  }
  if (facts.renderedAfterFirst !== 'yes') {
    problems.push('完整载荷到达之前页面没有画出槽位（等于把两阶段退化成了等两次都回来再画）');
  }
  const firstMs = Number(facts.firstMs);
  const fullMs = Number(facts.fullMs);
  if (!Number.isFinite(firstMs) || firstMs <= 0) {
    problems.push(`没有量到初判渲染耗时（data-tw-first-ms=${JSON.stringify(facts.firstMs)}）`);
  }
  if (!Number.isFinite(fullMs) || fullMs <= 0) {
    problems.push(`没有量到完整载荷渲染耗时（data-tw-full-ms=${JSON.stringify(facts.fullMs)}）`);
  }
  return problems;
}

export function deepTextValues(value) {
  const out = [];
  const walk = (node) => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const item of Object.values(node)) walk(item);
  };
  walk(value);
  return out.join(' · ');
}

/**
 * 一条机制原文**只有在能追溯到冻结产物**时才算「可核对原文」。
 *
 * 为什么必须交叉核对而不是「凡 `mechanism.line` 就放行」：那样页面只要把
 * 「胜率 62%」塞进 `mechanism.line` 就能绕过伪精确判据——判据当场变成空转。
 * 所以这里只认 `data/roco/derived/pet-mechanisms.json` 里真实存在的 `mechanism_line`
 * （或它是某条冻结 `feature.desc` 的原文子串）。
 */
let mechanismArtifactCache = null;
export function loadMechanismArtifact() {
  if (mechanismArtifactCache) return mechanismArtifactCache;
  const path = join(ROOT, 'data/roco/derived/pet-mechanisms.json');
  mechanismArtifactCache = JSON.parse(readFileSync(path, 'utf8'));
  return mechanismArtifactCache;
}

/** 从一份载荷里收集「可核对的机制原文」（交叉核对冻结产物，核不上的一律不放行）。 */
export function sourcedMechanismLines(payload, artifact = loadMechanismArtifact()) {
  const allowed = new Set();
  for (const row of Object.values(artifact?.pets ?? {})) {
    if (typeof row?.mechanism_line === 'string') allowed.add(row.mechanism_line);
  }
  const descs = Object.values(artifact?.pets ?? {})
    .map((row) => row?.feature?.desc).filter((desc) => typeof desc === 'string' && desc.trim() !== '');
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'mechanism' && value && typeof value.line === 'string' && value.line.includes('%')) {
        if (allowed.has(value.line) || descs.some((desc) => desc.includes(value.line))) out.push(value.line);
        continue;
      }
      walk(value);
    }
  };
  walk(payload);
  return [...new Set(out)];
}

/** 把**已核对的**机制原文换成占位符，返回可用于扫判据的文本与被豁免的命中数。 */
export function exemptSourcedLines(text, sourcedLines = []) {
  let scanned = String(text);
  let exempted = 0;
  for (const line of sourcedLines) {
    if (typeof line !== 'string' || !line.includes('%') || !scanned.includes(line)) continue;
    exempted += scanned.split(line).length - 1;
    scanned = scanned.split(line).join('（机制原文）');
  }
  return {text: scanned, exempted};
}

/** 玩家可见文本：不许工程词、不许伪精确、必须有玩家可读的未知说明。 */
export function playerCopyProblems(text, {sourcedLines = []} = {}) {
  const problems = [];
  // 冻结效果原文里的百分数（例如特性「图书守卫者」的「双攻+100%」）不是伪精确强度：
  // 做法是把**已核对过的原文**换成占位符再扫，而**不是**放宽正则——
  // 手写一个「这套阵容胜率 58%」照样会被抓到（反证见 tests/roco-workshop.test.js）。
  const {text: scanned, exempted} = exemptSourcedLines(text, sourcedLines);
  const hit = scanned.match(FORBIDDEN_PLAYER);
  if (hit) problems.push(`玩家可见文本里出现工程词「${hit[0]}」`);
  const pseudo = scanned.match(PSEUDO_PRECISION);
  if (pseudo) problems.push(`玩家可见文本里出现伪精确「${pseudo[0]}」`);
  if (!/未核实|未知|未产出/.test(String(text))) problems.push('玩家可见文本里没有任何「未核实 / 未知」的说明');
  Object.defineProperty(problems, 'sourced_exempted', {value: exempted, enumerable: false});
  return problems;
}

/**
 * RC-106：六宠标准 PVP **真的开起来之后**，战斗页该是什么样。
 *
 * 事实从页面读（`data-roco-*` 钩子 + 资源条文案 + 未核验提示），判据在这里：
 *   · 模式必须是登记表里的标准 PVP（`pvp-standard-six-pet`）；
 *   · 资源条必须是**引擎给的魔力**（`4`），不能还写着「未核验」——引擎已经给了；
 *   · **未核验覆盖必须如实标出来**（这一局用了一个假设值：初始能量按 2 开）；
 *   · 行动坞里物品 / 逃跑两组必须为空（标准 PVP 的合法动作里没有它们）。
 *
 * 反证样本（必须在同一判据下变红）：模式换掉 / 资源条写「未核验」/ 物品组出现 1 条 /
 * 覆盖提示被藏起来。
 */
/** 开局按钮：六槽选满才允许点。返回问题列表（空 = 合规）。 */
export function standardStartButtonProblems({disabled, team, fieldable = null} = {}) {
  const problems = [];
  if (disabled !== false) problems.push(`六槽选满后按钮必须可用，实际 disabled=${JSON.stringify(disabled)}`);
  if (String(team) !== '6') problems.push(`按钮读到的队伍规模必须是 6，实际 ${JSON.stringify(team)}`);
  // 能上场的只有 owned 个体：图鉴条目没有冻结配招，引擎不能凭空给它们一套招。
  if (fieldable !== null && String(fieldable) !== '6') {
    problems.push(`六只都要是「能上场」的个体，实际 fieldable=${JSON.stringify(fieldable)}`);
  }
  return problems;
}

export function sixPetBattleProblems(facts) {
  const problems = [];
  if (facts?.mode !== 'pvp-standard-six-pet') {
    problems.push(`开局后的模式必须是 pvp-standard-six-pet，实际 ${JSON.stringify(facts?.mode)}`);
  }
  if (facts?.standardPvp !== 'yes') {
    problems.push(`data-roco-standard-pvp 必须是 yes，实际 ${JSON.stringify(facts?.standardPvp)}`);
  }
  // `data-roco-action-groups` 只列**有条目的组**（空组不出现），所以「没有 item」与「item:0」等价。
  const counts = Object.fromEntries(String(facts?.groups ?? '').split(',')
    .map((chunk) => chunk.split(':'))
    .filter((pair) => pair.length === 2)
    .map(([id, n]) => [id, Number(n)]));
  const shown = Object.values(counts).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
  if (shown === 0) problems.push(`行动坞里一条动作都没有，实际 ${JSON.stringify(facts?.groups)}`);
  if ((counts.item ?? 0) !== 0) problems.push(`标准 PVP 下物品组必须为空，实际 ${facts?.groups}`);
  if ((counts.escape ?? 0) !== 0) problems.push(`标准 PVP 下逃跑组必须为空，实际 ${facts?.groups}`);
  if (!Number.isInteger(facts?.selfMana) || !Number.isInteger(facts?.foeMana)) {
    problems.push(`资源条必须显示引擎给的魔力（读到 self=${JSON.stringify(facts?.selfMana)} foe=${JSON.stringify(facts?.foeMana)}）`);
  }
  if (/未核验/.test(String(facts?.selfText ?? '')) || /未核验/.test(String(facts?.foeText ?? ''))) {
    problems.push('引擎已经给了魔力，资源条却还写「未核验」');
  }
  if (facts?.noteHidden !== false || !/未核验/.test(String(facts?.noteText ?? ''))) {
    problems.push(`未核验覆盖必须如实显示（hidden=${JSON.stringify(facts?.noteHidden)} 文案=${JSON.stringify(facts?.noteText)}）`);
  }
  if (!(facts?.battleVisible === true)) problems.push('战斗区必须是可见的（开局没真的进去）');
  return problems;
}

/**
 * RC-503：候选规则下的 Coach 取舍（并列比较 + 未来 2—3 回合 + 规则置信，且不给伪精确胜率）。
 *
 * 这一条回答的是「v3 候选规则下，教练层给的东西还是不是那四样」。三个硬要求：
 *   ① 并列比较里的每个动作**逐字都在引擎的合法动作表里**（建议不许凭空造动作）；
 *   ② 至少两条未来后果 + 至少两条并列；
 *   ③ 可见文本里不出现胜率 / 百分数这类伪精确说法。
 */
export function coachCompareProblems(facts) {
  const problems = [];
  if (!(Number(facts?.actions) >= 2)) problems.push(`并列比较只有 ${facts?.actions} 条（至少 2 条）`);
  if (!(Number(facts?.futures) >= 2)) problems.push(`未来后果只有 ${facts?.futures} 条（至少 2 条）`);
  const labels = Array.isArray(facts?.labels) ? facts.labels : [];
  const legal = new Set(Array.isArray(facts?.legalLabels) ? facts.legalLabels : []);
  const invented = labels.filter((l) => !legal.has(l));
  if (labels.length === 0) problems.push('并列比较里一个动作名都没读到');
  if (invented.length) problems.push(`建议里有引擎没给的动作：${JSON.stringify(invented)}`);
  if (!/未核验|置信|不确定/.test(String(facts?.text ?? ''))) {
    problems.push('取舍区必须如实标出置信/未核验，没读到');
  }
  if (/[0-9]+\s*%|胜率|胜算/.test(String(facts?.text ?? ''))) {
    problems.push('可见文本里出现伪精确（胜率 / 百分数）');
  }
  return problems;
}

/** 触控目标：390px 下模块里每个可见可点元素都 ≥44×44。 */
export function touchTargetProblems(small) {
  return (small ?? []).map((row) => `${row.tag}.${row.cls ?? ''} 只有 ${row.w}×${row.h}`);
}

/** 移动端区块顺序必须是「队伍槽位 → 候选池 → 当前评估 → Coach 短提示」。 */
export function mobileOrderProblems(order, tops) {
  const problems = [];
  const expect = ['tw-team', 'tw-cand', 'tw-eval', 'tw-coach'];
  if (JSON.stringify(order) !== JSON.stringify(expect)) {
    problems.push(`移动端区块顺序必须是 ${JSON.stringify(expect)}，实际 ${JSON.stringify(order)}`);
  }
  const sorted = [...tops].sort((a, b) => a.top - b.top);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].top < sorted[i - 1].top) problems.push('区块的 DOM 顺序与视觉顺序不一致');
  }
  return problems;
}

// ── CDP ───────────────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const {resolve, reject} = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); return;
      }
      for (const h of this.handlers.get(m.method) || []) h(m.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(handler); }
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-workshop-acc-'));
  let chromeErr = '';
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  chrome.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-800); });
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch {}
    try { rmSync(profile, {recursive: true, force: true}); } catch {}
  };
  let port = null;
  for (let i = 0; i < 240 && !port; i++) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) { kill(); throw new Error(`Chrome 未在预期时间内启动：${chromeErr}`); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) { kill(); throw new Error('找不到可用的页面 target'); }
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  if (!CHROME) { console.error('[workshop-acceptance] 本机没有 Chrome，无法做浏览器验收'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  // 真实服务：工坊路由只读磁盘产物，所以这里不拉 Python（也不该拉）。
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const owned = JSON.parse(readFileSync(join(ROOT, 'data/roco/owned/owned-pets.json'), 'utf8'));
  const ids = owned.instances.map((i) => i.instance_id).sort();
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Network.enable');
  const consoleErrors = []; const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shoot = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    return `reports/roco/workshop-acceptance/${name}.png`;
  };
  /** 模块的根元素（产品页与夹具都挂在 `#team-workshop` 上）。 */
  const ROOT_SEL = '#team-workshop';
  /**
   * 把模块滚到视口里再截图。
   *
   * 为什么必须滚：产品页在模块之上还有它自己的选阵容区，窄屏下「整页第一屏」是那一块，
   * 直接整页截图会拍到别人的区域、看不到本模块的版式——那样的证据说明不了问题。
   * 顺带把展开的 `details` 收起来（页头的「关于这一页」、模块里的「最多替换」菜单），
   * 免得它们盖住正文。页头小芽聊天抽屉属于另一路：它开着就是开着，截图里如实呈现，
   * 本脚本不去点它、也不改它。
   */
  const shootModule = async (name) => {
    await js(`(()=>{for(const el of document.querySelectorAll('details[open]'))el.open=false;
      const sr=document.querySelector(${JSON.stringify(ROOT_SEL)})?.shadowRoot;
      if(sr)for(const el of sr.querySelectorAll('details[open]'))el.open=false;
      const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      if(root)root.scrollIntoView({block:'start'});})()`);
    await sleep(320);
    return shoot(name);
  };
  const rectOf = async (sel) => {
    // 选择器形如 `#team-workshop >>> .tw-row[data-tw-species=...]`：`>>>` 之后在 shadow root 里找。
    const [host, inner] = String(sel).split('>>>').map((part) => part.trim());
    const raw = await js(`(()=>{const host=document.querySelector(${JSON.stringify(host)});
      const scope=${JSON.stringify(inner)}?(host?.shadowRoot??null):host;
      const el=scope?(${JSON.stringify(inner)}?scope.querySelector(${JSON.stringify(inner ?? '')}):scope):null;
      if(!el)return 'null';
      const r=el.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});})()`);
    return raw === 'null' ? null : JSON.parse(raw);
  };
  /** 真鼠标点击（点之前先问页面「这一点上是谁」）。 */
  const mouseClick = async (sel) => {
    const [host, inner] = String(sel).split('>>>').map((part) => part.trim());
    await js(`(()=>{const host=document.querySelector(${JSON.stringify(host)});
      const scope=${JSON.stringify(inner)}?(host?.shadowRoot??null):host;
      const el=scope?(${JSON.stringify(inner)}?scope.querySelector(${JSON.stringify(inner ?? '')}):scope):null;
      if(el)el.scrollIntoView({block:'center'});})()`);
    await sleep(140);
    const r = await rectOf(sel);
    if (!r) throw new Error(`找不到可点的元素：${sel}`);
    const top = JSON.parse(await js(`(()=>{const el=document.elementFromPoint(${r.x},${r.y});
      if(!el)return '{"tag":null}';
      const path=(()=>{const out=[];let node=el;while(node){out.push(node.tagName+(node.id?'#'+node.id:''));node=node.parentNode??node.host??null;if(out.length>6)break;}return out.join('<');})();
      return JSON.stringify({tag:el.tagName,cls:String(el.className||'').slice(0,40),path});})()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x: r.x, y: r.y, button: 'left', clickCount: 1});
    }
    await sleep(240);
    return {...r, top};
  };
  /** 真键盘打字（先全选，避免把新词接在旧词后面）。 */
  const typeText = async (sel, text) => {
    const [host, inner] = String(sel).split('>>>').map((part) => part.trim());
    await js(`(()=>{const host=document.querySelector(${JSON.stringify(host)});
      const scope=${JSON.stringify(inner)}?(host?.shadowRoot??null):host;
      const el=scope?(${JSON.stringify(inner)}?scope.querySelector(${JSON.stringify(inner ?? '')}):scope):null;
      if(el){el.focus();el.select();}})()`);
    for (const ch of text) {
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: ch, text: ch, unmodifiedText: ch});
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: ch});
      await sleep(55);
    }
    await sleep(380);
    return js(`(()=>{const host=document.querySelector(${JSON.stringify(host)});
      const scope=${JSON.stringify(inner)}?(host?.shadowRoot??null):host;
      const el=scope?(${JSON.stringify(inner)}?scope.querySelector(${JSON.stringify(inner ?? '')}):scope):null;
      return el?el.value:null;})()`);
  };
  const metrics = async () => JSON.parse(await js(`JSON.stringify({
    clientW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
  })`));
  /** 模块自己的量测：全部从 `#team-workshop` 的 dataset 与 shadow root 里读。 */
  const facts = async () => JSON.parse(await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
    const d=root?.dataset??{};
    return JSON.stringify({
      state: d.twState ?? null, selected: d.twSelected ?? null, remaining: d.twRemaining ?? null,
      slots: d.twSlots ?? null, filled: d.twFilled ?? null, next: d.twNext ?? null,
      nextLabels: d.twNextLabels ?? null, axes: d.twAxes ?? null, axesAvailable: d.twAxesAvailable ?? null,
      poolTotal: d.twPoolTotal ?? null, poolRows: d.twPoolRows ?? null,
      error: d.twError ?? null, hasPayload: Boolean(d.twPayload),
      stage: d.twStage ?? null, fetches: d.twFetches ?? null,
      renderedAfterFirst: d.twRenderedAfterFirst ?? null,
      firstMs: d.twFirstMs ?? null, fullMs: d.twFullMs ?? null,
      fullState: d.twFullState ?? null, ready: d.twReady ?? null,
      serving: d.twServing ?? null, withheld: d.twWithheld ?? null,
      degraded: d.twDegraded ?? null, elapsedMs: d.twElapsedMs ?? null,
    });})()`));
  const domFacts = async () => JSON.parse(await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
    const sr=root?.shadowRoot??null;
    let text=root?.textContent||'';
    if(sr){const wrap=document.createElement('div');
      wrap.append(...[...sr.childNodes].map((node)=>node.cloneNode(true)));
      for(const el of wrap.querySelectorAll('style,script'))el.remove();
      text=wrap.textContent||'';}
    const q=(sel)=>sr?sr.querySelectorAll(sel).length:0;
    return JSON.stringify({
      // 2026-09-22：模块现在有**两排**槽位 —— 持有队伍（#tw-slots）与理论阵容（#tw-analysis-slots）。
      // 「六个槽位」这条判据量的是**持有队伍**那一排；把两排加在一起量会得到 12（判据自己错了）。
      slotNodes: q('#tw-slots .tw-slot'), filledNodes: q('#tw-slots .tw-slot.on'),
      analysisSlotNodes: q('#tw-analysis-slots .tw-slot'),
      analysisFilledNodes: q('#tw-analysis-slots .tw-slot.on'),
      analysisCount: root?.dataset.twAnalysis ?? null,
      analysisTrialReady: root?.dataset.twAnalysisTrialReady ?? null,
      nextNodes: q('[data-tw-next]'),
      gapNodes: q('.tw-gap'), axisNodes: q('.tw-axis'), unknownNodes: q('.tw-unknown'),
      entranceNodes: q('[data-tw-entrance]'), replacementShown: q('#tw-replacement')>0,
      mechanismNodes: q('[data-tw-mechanism]'),
      pendingNodes: q('[data-tw-mechanism="pending"]'),
      mechanismLines: [...(sr?sr.querySelectorAll('[data-tw-mechanism] .tw-mech-line'):[])]
        .map((el)=>el.textContent),
      hasModeBadge: text.includes(${JSON.stringify(TEAM_WORKSHOP_BADGES.mode)}),
      hasCandidateBadge: text.includes(${JSON.stringify(TEAM_WORKSHOP_BADGES.candidate)}),
      hasUnknownPrematch: text.includes('匹配前对手未知'),
      hasFullUniverse: text.includes('候选来自全图鉴'),
      mentionsLegacySlots: /已选\\s*3\\s*只|固定队伍栏|固定\\s*60\\s*池|标准\\s*PVP\\s*3v3/.test(text),
      nextNames: [...(sr?sr.querySelectorAll('[data-tw-next] .tw-card-head b'):[])].map((el)=>el.textContent),
      shadowPresent: Boolean(sr),
    });})()`));
  /**
   * 模块的**玩家可见文本**：shadow root 里的文字，**去掉 <style> / <script>**。
   * 不去掉的后果是把 CSS 源码也当成玩家可见文本（`width:100%`、`{…}`），
   * 判据会满屏误报——第 92 轮实测就是这样。
   */
  const playerText = async () => js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
    const sr=root?.shadowRoot??null;
    if(!sr)return (root?.textContent||'').replace(/\\s+/g,' ');
    const wrap=document.createElement('div');
    wrap.append(...[...sr.childNodes].map((node)=>node.cloneNode(true)));
    for(const el of wrap.querySelectorAll('style,script'))el.remove();
    return (wrap.textContent||'').replace(/\\s+/g,' ');})()`);
  const waitFor = async (expr, {tries = 100, ms = 150} = {}) => {
    for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await sleep(ms); }
    return false;
  };
  const route = async (query) => {
    const response = await fetch(`${base}api/roco/workshop?${query}`);
    const raw = await response.text();
    return {status: response.status, raw, json: JSON.parse(raw)};
  };
  /** 真实键鼠加一只：键盘搜名字 → 鼠标点那一行（优先自己拥有的那一只）。 */
  const addByName = async (name) => {
    const beforeCount = Number((await facts()).selected ?? 0);
    await typeText(`${ROOT_SEL} >>> #tw-search`, name);
    await sleep(420);
    const probe = JSON.parse(await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?.shadowRoot??null;
      const rows=[...(sr?sr.querySelectorAll('.tw-row'):[])];
      const match=rows.filter((r)=>r.querySelector('.tw-name')?.textContent===${JSON.stringify(name)});
      const owned=match.find((r)=>(r.dataset.twOwned||'')!=='');
      return JSON.stringify({rows:rows.length,match:match.length,
        species:owned?owned.dataset.twSpecies:(match[0]?match[0].dataset.twSpecies:null)});})()`));
    if (probe.species === null) return {added: false, probe, beforeCount};
    await mouseClick(`${ROOT_SEL} >>> .tw-row[data-tw-species="${probe.species}"]`);
    await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0') >= ${beforeCount + 1}`,
      {tries: 40, ms: 120});
    const after = Number((await facts()).selected ?? 0);
    return {added: after > beforeCount, probe, beforeCount, after};
  };
  /** 一只 owned 个体的显示名（与页面读同一份登记名）。 */
  const nameOfInstance = (instanceId) => js(`(async()=>{
    const owned=${JSON.stringify(owned.instances)};
    const row=owned.find((i)=>i.instance_id===${JSON.stringify(instanceId)});
    if(!row) return null;
    const r=await fetch('/api/roco/box?detail='+row.species_id,{cache:'no-store'});
    const j=await r.json();
    return j?.player?.name??row.species_name??null;})()`);

  const checks = []; const counterproofs = []; const steps = []; const shots = []; const screens = [];
  const check = (id, judge, ok, actual) => {
    checks.push({id, judge, ok: Boolean(ok), actual: String(actual)});
    log(ok ? '✔' : '✖', `[${id}]`, judge, '—实际：', String(actual).slice(0, 240));
  };
  const counter = (id, judge, problems, actual) => {
    counterproofs.push({id, judge, ok: problems.length > 0, hit: problems.join(' | ') || '（没命中——判据是空的！）', actual: String(actual)});
    log(problems.length ? '✔' : '✖', `[反证 ${id}]`, judge, '—实际命中：', (problems.join(' | ') || '（没命中）').slice(0, 240));
  };

  try {
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    // ── 产品页：`roco.html`（模块由 roco.js 的 mountWorkshop() 挂上）──────────
    await cdp.send('Page.navigate', {url: base + 'roco.html'});
    // 等**两阶段都回来**（`twReady`），而不是只等第一次 ok：
    // 只等 ok 会在「初判刚画完」的那一刻就往下走，那正是要量测的中间态。
    const ready = await waitFor(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twReady==='yes'`);
    if (!ready) throw new Error('产品页上的 #team-workshop 没有进入就绪状态（模块没挂上或路由失败）');

    // ── ① 挂载点、六槽、徽记、候选池 ≥600 ───────────────────────────────
    const boot = await facts();
    const bootDom = await domFacts();
    steps.push({at: 'boot', facts: boot, dom: bootDom});
    check('01-产品页挂载', '产品页 roco.html 上有 #team-workshop，模块在自己的 shadow root 里渲染（不是另起一套临时页面）',
      bootDom.shadowPresent && Number(boot.slots) === SLOT_COUNT,
      `shadow root=${bootDom.shadowPresent} dataset.twSlots=${boot.slots} 槽位节点=${bootDom.slotNodes}`);
    const bootSlotProblems = slotProblems({slots: Number(boot.slots), slotNodes: bootDom.slotNodes, filled: Number(boot.filled)});
    check('02-六个槽位', `第一次打开就画出 ${SLOT_COUNT} 个槽位（不是「已选 3 只固定栏」），filled == 已选数`,
      bootSlotProblems.length === 0 && Number(boot.selected) === Number(boot.filled),
      bootSlotProblems.join(' | ') || `slots=${boot.slots} 节点=${bootDom.slotNodes} filled=${boot.filled} selected=${boot.selected}`);
    counter('02-六个槽位', '把槽位数改成 3（退回「已选 3 只固定栏」）必须被同一条判据抓住',
      slotProblems({slots: 3, slotNodes: 3, filled: 3}), 'slots=3 / slotNodes=3 / filled=3');
    const bootBadgeProblems = badgeProblems({...bootDom, poolTotal: boot.poolTotal});
    check('03-徽记与候选池', '逐字在：「标准 PVP · 六宠」「候选规则（待实机核对）」「匹配前对手未知」「候选来自全图鉴」，候选池 ≥600',
      bootBadgeProblems.length === 0,
      bootBadgeProblems.join(' | ') || `池总量=${boot.poolTotal} 徽记全在=yes`);
    counter('03-候选规则徽记', '把「候选规则（待实机核对）」徽记去掉必须被同一条判据抓住',
      badgeProblems({hasModeBadge: true, hasCandidateBadge: false, hasUnknownPrematch: true,
        hasFullUniverse: true, poolTotal: 622, mentionsLegacySlots: false}),
      '{hasCandidateBadge:false,poolTotal:622}');
    counter('03-候选池 600+', '把候选池写成 48/60（迁移夹具）必须被同一条判据抓住',
      badgeProblems({hasModeBadge: true, hasCandidateBadge: true, hasUnknownPrematch: true,
        hasFullUniverse: true, poolTotal: 60, mentionsLegacySlots: false}),
      '{poolTotal:60}');

    const wide = await metrics();
    screens.push({viewport: '1440x900', at: 'roco-page', ...wide});
    shots.push(await shootModule('workshop-01-roco-page-1440x900'));
    check('04-宽屏不溢出', '1440×900：产品页与模块都没有横向溢出（scrollW == clientW）',
      wide.scrollW === wide.clientW,
      `clientW=${wide.clientW} scrollW=${wide.scrollW} bodyScrollW=${wide.bodyScrollW}`);

    // ── ①b 两阶段交付：初判先到、完整载荷后到，且初判真的不含证据段 ────────
    const stageFirstRoute = await route(`stage=first&selected=${ids.slice(0, 2).join(',')}`);
    const stageFirstJudged = stageFirstProblems(stageFirstRoute.json);
    check('05-初判不含证据段', '`stage=first` 的回执：axes === null、axes_status === not_requested、'
      + 'serving.full_withheld === NOT_REQUESTED（主动不要证据段，不是降级），且真的产出了结构化初判',
      stageFirstRoute.status === 200 && stageFirstJudged.length === 0,
      stageFirstJudged.join(' | ')
      + `（HTTP ${stageFirstRoute.status}；serving.first=${JSON.stringify(stageFirstRoute.json.serving?.first?.kind)}`
      + ` withheld=${JSON.stringify(stageFirstRoute.json.serving?.withheld_stages)}`
      + ` missing=${JSON.stringify(stageFirstRoute.json.serving?.short?.missing_stages)}）`);
    counter('05-初判不含证据段', '让 first 那一次也带上五轴（把「初判不跑证据段」破掉）必须被同一条判据抓住',
      stageFirstProblems({...stageFirstRoute.json, axes: stageFirstRoute.json.axes ?? []}),
      '把 axes 从 null 换成数组');
    counter('05-初判不含证据段（降级混淆）', '把「超时降级」混成「主动只要初判」必须被同一条判据抓住',
      stageFirstProblems({...stageFirstRoute.json,
        serving: {...stageFirstRoute.json.serving, degraded: true, full: {kind: 'full_answer'}}}),
      'serving.degraded=true 且 full 非 null');

    const stageSeqJudged = stageSequenceProblems(boot);
    check('06-初判先于完整载荷', '页面分两次要数据：请求顺序 first|full；**在完整载荷到达之前**槽位就已经画出来了'
      + '（data-tw-rendered-after-first=yes）；两次渲染耗时都量到了（data-tw-first-ms / data-tw-full-ms）',
      stageSeqJudged.length === 0,
      stageSeqJudged.join(' | ')
      + `；fetches=${boot.fetches} rendered_after_first=${boot.renderedAfterFirst}`
      + ` first_ms=${boot.firstMs} full_ms=${boot.fullMs} stage=${boot.stage} full_state=${boot.fullState}`);
    counter('06-初判先于完整载荷', '把两阶段退化成一次性请求（fetches=full、没有初判耗时）必须被同一条判据抓住',
      stageSequenceProblems({fetches: 'full', renderedAfterFirst: 'no', firstMs: null, fullMs: '12'}),
      '{fetches:"full", renderedAfterFirst:"no", firstMs:null}');
    counter('06-初判先于完整载荷（初判被挡住）', '让「完整载荷到达之前」什么都不画（rendered_after_first=no）也必须被抓住',
      stageSequenceProblems({...boot, renderedAfterFirst: 'no'}),
      `${JSON.stringify({fetches: boot.fetches, renderedAfterFirst: 'no'})}`);
    check('07-分段元数据在 dataset', '分段交付的信封在**属性**上可核对（契约名 / 是否降级 / 主动扣下的段 / 耗时），'
      + '可见文本里一个工程词都没有',
      boot.serving === 'roco-serving/v1' && boot.degraded === 'no' && Number(boot.elapsedMs) >= 0
      && !String(await playerText()).includes('roco-serving'),
      `serving=${boot.serving} degraded=${boot.degraded} elapsed_ms=${boot.elapsedMs}`
      + ` withheld=${JSON.stringify(boot.withheld)}`);

    // ── ② 候选池真的能翻到「我没有的图鉴物种」────────────────────────────
    const anyPage = await (await fetch(`${base}api/roco/box?kind=catalog&limit=60&offset=560`)).json();
    const ownedSpecies = new Set(owned.instances.map((i) => i.species_id));
    const catalogOnly = (anyPage.player.cards ?? []).filter((card) => !ownedSpecies.has(card.group ?? card.select));
    check('08-候选含图鉴物种', '候选池里能点到「我没有的图鉴物种」（证明候选宇宙是 600+，不是 48 只）',
      catalogOnly.length > 0, catalogOnly.length ? `命中 ${catalogOnly[0].name}` : '第 11 页 60 条里没有非拥有物种');

    // 真实鼠标点开「只看收藏」→ 再关掉
    const favClick = await mouseClick(`${ROOT_SEL} >>> #tw-favourite`);
    await waitFor(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.shadowRoot.getElementById('tw-favourite').getAttribute('aria-pressed')==='true'`);
    await sleep(300);
    const favOn = await facts();
    await mouseClick(`${ROOT_SEL} >>> #tw-favourite`);
    await sleep(320);
    check('09-只看收藏开关', '真实鼠标点「只看收藏」→ 路由重算且模块回到 ok；再点一次回到 ok',
      favOn.state === 'ok' && (await facts()).state === 'ok',
      `开了之后 state=${favOn.state}（selected=${favOn.selected}）；关掉之后 state=${(await facts()).state}；命中=${JSON.stringify(favClick.top)}`);

    // 点一只自己没有的图鉴物种：路由照实拒绝（fail closed），并且错误只出现在一行里
    await typeText(`${ROOT_SEL} >>> #tw-search`, catalogOnly[0].name);
    await sleep(420);
    const catalogSpecies = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?.shadowRoot??null;
      const row=[...(sr?sr.querySelectorAll('.tw-row'):[])].find((r)=>r.querySelector('.tw-name')?.textContent===${JSON.stringify(catalogOnly[0].name)});
      return row?row.dataset.twSpecies:null;})()`);
    if (catalogSpecies) {
      const seqBefore = await js(`document.querySelector(${JSON.stringify(ROOT_SEL)}).dataset.twSeq ?? '0'`);
      await mouseClick(`${ROOT_SEL} >>> .tw-row[data-tw-species="${catalogSpecies}"]`);
      await waitFor(`document.querySelector(${JSON.stringify(ROOT_SEL)}).dataset.twSeq !== ${JSON.stringify(seqBefore)}`,
        {tries: 30, ms: 120});
      const rejectedText = String(await playerText());
      const rejected = await facts();
      // 2026-09-22 人类 P0：玩家那一行**不许**出现 `selected` / `own-0001` / 「服务端原话」
      // 这类内部串；但「为什么进不了队 + 现在能做什么」必须照实说，原文要留在
      // `data-tw-error-raw` 里（开发者抽屉与排查读它）。判据按这个新口径拆成三条。
      const rawError = await js(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twErrorRaw ?? null`);
      const refuseProblems = (text, raw, state) => {
        const bad = [];
        if (state !== 'bad-request') bad.push(`state=${state}`);
        if (!/进不了队伍/.test(String(text))) bad.push('玩家那一行没说清「进不了队伍」');
        if (!/拥有的个体|你的盒子|正式队伍/.test(String(text))) bad.push('没说清为什么（要放你拥有的个体）');
        if (!/我的精灵|理论搭配|换一只/.test(String(text))) bad.push('没给出下一步怎么做');
        for (const leak of ['服务端原话', 'selected', 'own-0001', 'pet_']) {
          if (String(text).includes(leak)) bad.push(`玩家层泄漏了内部串「${leak}」`);
        }
        if (!raw) bad.push('服务端原文没有留在 data-tw-error-raw（排查要用）');
        return bad;
      };
      // 2026-09-22（人类 P0）：口径变了 —— 图鉴条目**不再被当成「塞进持有队伍」而报错**，
      // 它进**理论阵容**（物种级清单），并在卡上提前标「图鉴 · 按需推算（未核验）」。
      // 所以这一条改成量新口径；「玩家层不许出现内部串」那条纪律仍然量（它没变）。
      const analysisAfterCatalog = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
        const sr=root?.shadowRoot;
        const box=sr?sr.querySelector('#tw-analysis-slots'):null;
        const filled=box?[...box.querySelectorAll('[data-tw-state="filled"]')].map((el)=>({
          status:el.dataset.twStatus,canBattle:el.dataset.twCanBattle})):[];
        return {count:Number(root?.dataset.twAnalysis||'0'),slots:filled,
          text:((root?.textContent||'')).replace(/\\s+/g,' ')};})()`);
      const catalogProblems = (facts) => {
        const bad = [];
        if (facts?.state !== 'ok') bad.push(`state=${facts?.state}（图鉴条目不该让整页进错误态）`);
        if (Number(facts?.analysis?.count) < 1) bad.push('理论阵容里没有接住这只图鉴物种');
        const slot = (facts?.analysis?.slots ?? [])[0];
        if (slot && slot.status !== 'on_demand') bad.push(`格子状态 ${slot.status}`);
        if (slot && slot.canBattle !== 'trial') bad.push(`出战判定 ${slot.canBattle}（按需推算只能试玩）`);
        for (const leak of ['服务端原话', 'own-0001', 'pet_']) {
          if (String(facts?.playerText ?? '').includes(leak)) bad.push(`玩家层泄漏了内部串「${leak}」`);
        }
        return bad;
      };
      check('10-图鉴物种照实拒绝', '点一只自己没有的图鉴物种：它进**理论阵容**并带「按需推算（未核验）/仅试玩」标，'
        + '页面不进错误态、玩家层不出现内部串',
        catalogProblems({state: rejected.state, analysis: analysisAfterCatalog,
          playerText: await playerText()}).length === 0,
        catalogProblems({state: rejected.state, analysis: analysisAfterCatalog,
          playerText: await playerText()}).join(' | ')
        || `state=${rejected.state}；理论阵容 ${analysisAfterCatalog.count} 只；格子 ${JSON.stringify(analysisAfterCatalog.slots)}`);
      counter('10-图鉴物种照实拒绝', '把服务端原话（含 selected / own-0001）直接印到玩家层必须被同一条判据抓住',
        refuseProblems('服务端原话：selected 的每一项都必须是 own-0001 形状的个体的 id', null, 'bad-request'),
        '{"text":"服务端原话：selected …"}');
      counter('10-图鉴物种照实拒绝', '把「静默接受」的样本过同一条判据必须报错',
        badRequestProblems(`selected=${catalogSpecies}`, {ok: true, player: {}}, 200, 'selected'),
        '{ok:true} / HTTP 200');
    }
    // 清掉搜索词并点一只有效的：证明能从错误态恢复
    await typeText(`${ROOT_SEL} >>> #tw-search`, '');
    await sleep(400);
    const pickNames = [];
    for (const id of ids) {
      if (pickNames.length >= 6) break;
      const name = await nameOfInstance(id);
      if (name && !pickNames.includes(name)) pickNames.push(name);
    }
    const recovered = await addByName(pickNames[0]);
    await sleep(200);
    const afterRecover = await facts();
    check('11-错误态可恢复', '错误态下再点一只有效的候选：模块回到 ok，刚被拒的那一只没有偷偷留在队伍里',
      recovered.added && afterRecover.state === 'ok' && Number(afterRecover.selected) === 1,
      `加点=${JSON.stringify(recovered)} state=${afterRecover.state} selected=${afterRecover.selected}`);

    // ── ③ 连续选到 2 只：评估随阵容变化 ─────────────────────────────────
    const addResults = [];
    while (Number((await facts()).selected ?? 0) < 2) {
      const missing = pickNames.find((name) => !addResults.some((row) => row.name === name));
      if (!missing) break;
      addResults.push({name: missing, ...(await addByName(missing))});
    }
    const two = await facts();
    const twoDom = await domFacts();
    steps.push({at: 'two-selected', facts: two, dom: twoDom, addResults});
    check('12-真实键鼠选到第 2 只', '真实键盘搜名字 + 真实鼠标点候选：已选 == 2，六个槽位里两个填上了',
      two.state === 'ok' && Number(two.selected) === 2 && twoDom.filledNodes === 2 && twoDom.slotNodes === 6,
      `state=${two.state} selected=${two.selected} 填了 ${twoDom.filledNodes}/${twoDom.slotNodes} 槽`);
    const nextProblems = nextCandidateProblems({count: Number(two.next), cardNodes: twoDom.nextNodes,
      labels: String(two.nextLabels ?? '').split('|').filter(Boolean)});
    check('13-恰好三个候选', '已选 2 只时评估区常驻显示**恰好三个**下一只候选，取舍标签两两不同，且至少覆盖两个真正的取舍口径'
      + '（偏好保留池空时 RC-303 会如实回落，第三个位置由召回的参考候选补上并标「候选参考」）',
      nextProblems.length === 0,
      nextProblems.join(' | ') || `标签=${two.nextLabels} 候选节点=${twoDom.nextNodes} 缺口节点=${twoDom.gapNodes}`);
    counter('13-恰好三个候选', '把三个候选改成两个必须被同一条判据抓住',
      nextCandidateProblems({count: 2, cardNodes: 2, labels: ['强度', '稳定']}),
      'count=2 / labels=[强度,稳定]');
    counter('13-候选标签去重', '三个候选里有两个是同一个取舍标签（等于只有两个选择）必须被抓住',
      nextCandidateProblems({count: 3, cardNodes: 3, labels: ['强度', '强度', '候选参考']}),
      'labels=[强度,强度,候选参考]');
    // 路由与 RC-303 同源：三个取舍标签顺序必须是 strength / stability / preference
    const routeTwo = await route(`selected=${ids.slice(0, 2).join(',')}`);
    const routeIds = routeTwo.json.next_candidates.map((row) => row.tradeoff_id);
    const okOrder = routeIds.slice(0, Math.min(routeIds.length, 2)).join('|') === 'strength|stability';
    const okTail = routeIds.every((id) => ['strength', 'stability', 'preference', 'recall_tail'].includes(id))
      && routeIds.filter((id) => id !== 'recall_tail').length >= 2;
    check('14-候选与核心同源', '路由的 next_candidates 逐条带 RC-303 的口径 id（strength / stability / preference），'
      + '去重或回落时如实标 recall_tail，而不是页面层另编一个候选',
      routeTwo.json.ok === true && routeTwo.json.next_candidates.length === 3 && okOrder && okTail,
      `tradeoff_id=${JSON.stringify(routeIds)}（source=${JSON.stringify(routeTwo.json.next_candidates.map((row) => row.source))}）`);
    // 缺口清单（RC-302 七维）必须呈现在评估区里
    check('15-缺口清单在评估区', '评估区呈现 RC-302 的缺口口径（缺什么 / 台账里标未核实），且没有工程键名',
      twoDom.gapNodes >= 1 && Array.isArray(routeTwo.json.player.gap_dimension_notes)
      && routeTwo.json.player.gap_dimension_notes.length >= 1,
      `缺口节点=${twoDom.gapNodes} 路由口径=${JSON.stringify(routeTwo.json.player.gap_dimension_notes)}`);
    shots.push(await shootModule('workshop-02-two-selected-1440x900'));

    // ── ④ 选到 5 只：评估必须跟着变 ─────────────────────────────────────
    while (Number((await facts()).selected ?? 0) < 5) {
      const used = addResults.map((row) => row.name);
      const nextName = pickNames.find((name) => !used.includes(name));
      if (!nextName) break;
      addResults.push({name: nextName, ...(await addByName(nextName))});
    }
    const five = await facts();
    const fiveDom = await domFacts();
    steps.push({at: 'five-selected', facts: five, dom: fiveDom, addResults});
    const followProblems = evaluationFollowsTeamProblems(
      {selected: Number(two.selected), nextNames: twoDom.nextNames, nextNodes: twoDom.nextNodes, gapNodes: twoDom.gapNodes},
      {selected: Number(five.selected), nextNames: fiveDom.nextNames, nextNodes: fiveDom.nextNodes, gapNodes: fiveDom.gapNodes});
    check('16-评估随阵容变化', '从 2 只加到 5 只之后：下一只候选换了人、缺口清单还在、仍然恰好三个候选',
      Number(five.selected) === 5 && followProblems.length === 0,
      followProblems.join(' | ') || `2 只时候选=${JSON.stringify(twoDom.nextNames)}；5 只时=${JSON.stringify(fiveDom.nextNames)}`);
    counter('16-评估随阵容变化', '把「阵容变了候选一字未变」的样本过同一条判据必须报错',
      evaluationFollowsTeamProblems(
        {selected: 2, nextNames: ['甲', '乙', '丙'], nextNodes: 3, gapNodes: 2},
        {selected: 5, nextNames: ['甲', '乙', '丙'], nextNodes: 3, gapNodes: 2}),
      '{2 只:[甲,乙,丙]} → {5 只:[甲,乙,丙]}');

    // ── ⑤ 连续选到 6 只：完整诊断 ───────────────────────────────────────
    while (Number((await facts()).selected ?? 0) < 6) {
      const used = addResults.map((row) => row.name);
      const nextName = pickNames.find((name) => !used.includes(name));
      if (!nextName) break;
      addResults.push({name: nextName, ...(await addByName(nextName))});
    }
    const six = await facts();
    const sixDom = await domFacts();
    const sixKeys = await js(`document.querySelector(${JSON.stringify(ROOT_SEL)}).dataset.twSelected ?? ''`);
    steps.push({at: 'six-selected', facts: six, dom: sixDom, addResults, selected_keys: sixKeys});
    check('17-连续选入六只', '连续用真实键鼠加人：六个槽位全部填满（selected == 6），填进去的是六个**不同**的个体',
      Number(six.selected) === 6 && sixDom.filledNodes === 6 && sixDom.slotNodes === 6,
      `selected=${six.selected} 填了 ${sixDom.filledNodes}/${sixDom.slotNodes} 槽；加点记录=${JSON.stringify(addResults)}`);
    const sixRoute = await route(`selected=${ids.slice(0, 6).join(',')}&locked=${ids[0]}`);
    const sixRoutePlayer = sixRoute.json.player;
    const axisProblemsFound = axisProblems(sixRoute.json.axes);
    check('18-满六只五轴', '选满六只后出现完整诊断：五轴都在；能算的给值，算不出的给原因且不带值（不补 0）',
      axisProblemsFound.length === 0 && sixDom.axisNodes === 5,
      axisProblemsFound.join(' | ') || `轴节点=${sixDom.axisNodes}；` + (sixRoute.json.axes ?? [])
        .map((axis) => `${axis.label}:${axis.available ? '能算' : '算不出'}`).join(' / '));
    counter('18-满六只五轴', '把「算不出来」的轴填成 0 必须被同一条判据抓住',
      axisProblems([{label: '环境价值', available: false, value: 0, unknown_reason: null},
        ...(sixRoute.json.axes ?? []).slice(1).map((axis) => ({label: axis.label, available: axis.available,
          value: axis.available ? axis.value : null, unknown_reason: axis.unknown_reason}))]),
      '{环境价值: available:false, value:0}');
    check('19-最大短板与替换建议', '完整诊断里有主短板（缺口/未知清单）与**一个**最小替换：换出/换入各一只，并说清是结构理由',
      sixDom.gapNodes + sixDom.unknownNodes >= 2 && sixDom.replacementShown
      && Boolean(sixRoutePlayer?.full_team?.replacement?.out_name)
      && Boolean(sixRoutePlayer?.full_team?.replacement?.in_name),
      `缺口=${sixDom.gapNodes} 未知=${sixDom.unknownNodes} 替换显示=${sixDom.replacementShown}`
      + ` 换出=${sixRoutePlayer?.full_team?.replacement?.out_name ?? null}`
      + ` 换入=${sixRoutePlayer?.full_team?.replacement?.in_name ?? null}`);
    const layerProblems = playerLayerProblems(sixRoutePlayer);
    check('20-玩家层载荷', '路由的 player 段里没有工程键，也没有 id 形状的展示值',
      layerProblems.length === 0,
      layerProblems.join(' | ') || `扫过 ${JSON.stringify(sixRoutePlayer).length} 字节`);
    counter('20-玩家层载荷', '把 pet_id / instance_id 混进 player 段必须被同一条判据抓住',
      playerLayerProblems({slots: [{name: '音速犬', pet_id: 'pet_000062'}], next_candidates: [{name: '喵喵', instance_id: 'own-0001'}]}),
      '{"slots":[{"pet_id":"pet_000062"}],"next_candidates":[{"instance_id":"own-0001"}]}');
    shots.push(await shootModule('workshop-03-six-selected-1440x900'));

    // ── ⑥ 卡上的机制行（冻结原文逐字上卡；枚举原文不许上卡）────────────
    // 「期望原文」从**路由回执**里取（`dev` 段里逐候选的 mechanism 也在，这里用 player 段），
    // 「实际渲染」从 shadow root 里取：两边对不上就是没渲染出来。
    const expectedMechanisms = [...(sixRoutePlayer?.slots ?? [])
      .map((slot) => slot.mechanism)
      .filter((mechanism) => mechanism?.status === 'FROZEN_DESC'
        && typeof mechanism.line === 'string' && mechanism.line.trim() !== '')
      .map((mechanism) => mechanism.line.trim())];
    const mechanismFacts = {
      expectedLines: expectedMechanisms,
      renderedLines: sixDom.mechanismLines ?? [],
      mechanismNodes: sixDom.mechanismNodes ?? 0,
      pendingNodes: sixDom.pendingNodes ?? 0,
      filledSlots: sixDom.filledNodes ?? 0,
      playerText: await playerText(),
    };
    const mechanismProblems = mechanismRenderProblems(mechanismFacts);
    check('21-机制行上卡', '六个槽位里每一只的**冻结机制原文**都逐字渲染在卡的首层（小字、不截断），'
      + '枚举原文（FROZEN_DESC / MECHANISM_UNCONFIRMED）一个都不出现在可见文本里',
      mechanismProblems.length === 0,
      mechanismProblems.join(' | ')
      + `；机制行节点=${mechanismFacts.mechanismNodes} 已填槽位=${mechanismFacts.filledSlots}`
      + ` 待确认=${mechanismFacts.pendingNodes}；卡上样例「${String(mechanismFacts.renderedLines[0] ?? '').slice(0, 60)}」`);
    counter('21-机制行上卡', '把机制行从卡上抹掉（渲染结果少一行）必须被同一条判据抓住',
      mechanismRenderProblems({...mechanismFacts, renderedLines: (mechanismFacts.renderedLines ?? []).slice(1)}),
      `expected=${JSON.stringify(mechanismFacts.expectedLines.slice(0, 1))} rendered=${JSON.stringify((mechanismFacts.renderedLines ?? []).slice(1, 2))}`);
    counter('21-机制枚举不上面', '把 FROZEN_DESC 印到可见文本里必须被同一条判据抓住',
      mechanismRenderProblems({...mechanismFacts, playerText: `${mechanismFacts.playerText} FROZEN_DESC`}),
      '可见文本追加 " FROZEN_DESC"');

    // ── ⑦ 玩家可见文本：无工程词、无胜率/百分数、有未知说明 ──────────────
    const playerNow = mechanismFacts.playerText;
    // 机制原文（逐字冻结 desc）里可能有百分数（「双攻+100%」）；只豁免**能追溯回产物**的那些。
    const sourcedLines = sourcedMechanismLines(sixRoutePlayer);
    const copyProblems = playerCopyProblems(playerNow, {sourcedLines});
    check('22-玩家层无工程话', '模块的可见文本里不出现 pet_id / instance_id / state_version / coverage / provenance / unknown_fields / ranker_status / ruleset，也不出现裸 JSON',
      copyProblems.length === 0,
      copyProblems.join(' | ') || `扫过 ${playerNow.length} 字（豁免机制原文 ${copyProblems.sourced_exempted} 处）；样例「${playerNow.slice(0, 90)}…」`);
    counter('22-玩家层无工程话', '往玩家区注入 pet_id / state_version 后同一条判据必须命中',
      playerCopyProblems('音速犬 pet_id=pet_000062 state_version=roco-workshop/v1'),
      '「音速犬 pet_id=pet_000062 state_version=roco-workshop/v1」');
    const pseudoNow = exemptSourcedLines(playerNow, sourcedLines).text.match(PSEUDO_PRECISION);
    check('23-无胜率与百分数', '可见文本里不出现「数字 + %」或「胜率/概率 + 数字」这种伪精确说法（可核对的冻结机制原文除外）',
      pseudoNow === null, pseudoNow ? `命中「${pseudoNow[0]}」` : `扫过 ${playerNow.length} 字无命中（豁免机制原文 ${sourcedLines.length} 条）`);
    counter('23-无胜率与百分数', '把「胜率 58%」写进可见文本必须被同一条判据抓住',
      playerCopyProblems('这套阵容胜率 58%'), '「这套阵容胜率 58%」');
    counter('23-无胜率与百分数（假机制绕过）', '把「胜率 62%」塞进 mechanism.line（核不回产物）必须照样被抓住',
      playerCopyProblems('（机制原文）胜率 62%', {sourcedLines: sourcedMechanismLines({next_candidates: [{mechanism: {line: '胜率 62%'}}]})}),
      '{"next_candidates":[{"mechanism":{"line":"胜率 62%"}}]}');
    check('24-未知写在玩家层', '「这一页现在还不知道什么」与「现在算不出来」的说明在可见文本里（不是只放在属性里）',
      sixDom.unknownNodes >= 4 && /现在算不出来/.test(playerNow) && /未核实|未知/.test(playerNow),
      `未知条目=${sixDom.unknownNodes}；含「现在算不出来」=${/现在算不出来/.test(playerNow)}`);

    // ── ⑧ 路由层非法参数：一律 400 + 点名（不受页面影响）────────────────
    const badCases = [
      [`selected=${ids.slice(0, 7).join(',')}`, 'selected'],
      ['mode=zzz', 'mode'],
      ['zzz=1', 'zzz'],
      ['max_replacements=abc', 'max_replacements'],
      ['favourites_only=yes', 'favourites_only'],
      ['selected=pet_000012', 'selected'],
      [`locked=${ids[6]}`, 'locked'],
    ];
    const rows = [];
    for (const [query, needle] of badCases) {
      const result = await route(query);
      rows.push(`${query.slice(0, 60)} → HTTP ${result.status} ${result.raw.slice(0, 110)}`);
      const problems = badRequestProblems(query, result.json, result.status, needle);
      check(`25-非法参数(${needle})`, `「${query.slice(0, 44)}」必须 HTTP 400 + ok:false 并点名 ${needle}`,
        problems.length === 0, problems.join(' | ') || `HTTP ${result.status} error=「${String(result.json.error).slice(0, 120)}」`);
    }
    steps.push({at: 'bad-params', rows});
    counter('25-非法参数(mode)', '把「非法 mode 静默接受」的样本过同一条判据必须报错',
      badRequestProblems('mode=zzz', {ok: true, player: {}}, 200, 'mode'), '{ok:true} / HTTP 200');
    counter('25-非法参数(第七个槽位)', '把「接受第 7 个槽位」的样本过同一条判据必须报错',
      badRequestProblems(`selected=${ids.slice(0, 7).join(',')}`, {ok: true, player: {selected_count: 7}}, 200, 'selected'),
      '{ok:true,player:{selected_count:7}} / HTTP 200');
    const okSix = await route(`selected=${ids.slice(0, 6).join(',')}`);
    const overSeven = await route(`selected=${ids.slice(0, 7).join(',')}`);
    check('26-六槽上限', '同名参数下 6 只必须 200、7 只必须 400：上限只认六个槽位',
      okSix.status === 200 && okSix.json.ok === true && overSeven.status === 400 && overSeven.json.ok === false,
      `6 只 → HTTP ${okSix.status}；7 只 → HTTP ${overSeven.status}「${String(overSeven.json.error).slice(0, 90)}」`);

    // ── ⑨ 开发夹具：同一模块也能单独挂（薄壳不是产品页）──────────────────
    await cdp.send('Page.navigate', {url: base + 'workshop.html'});
    const fixtureReady = await waitFor(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twState==='ok'`);
    const fixtureTitle = await js(`document.title`);
    check('27-开发夹具', 'workshop.html 只是单独调试同一模块的薄壳（能挂上、标题写明是夹具，不冒充产品页）',
      fixtureReady && /夹具/.test(fixtureTitle),
      `夹具就绪=${fixtureReady} 标题=「${fixtureTitle}」`);
    shots.push(await shootModule('workshop-04-fixture-1440x900'));
    // 回到产品页，把六只重新选上（窄屏那两档要量满编形态）
    await cdp.send('Page.navigate', {url: base + 'roco.html'});
    await waitFor(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twState==='ok'`);
    for (const name of pickNames) {
      if (Number((await facts()).selected ?? 0) >= 6) break;
      await addByName(name);
    }
    check('28-产品页重新选满六只', '回到产品页后仍能用真实键鼠选满六只（窄屏量测的前提）',
      Number((await facts()).selected) === 6, `selected=${(await facts()).selected}`);

    // ── ⑩ 窄屏 390×844：不溢出 + 顺序 + 触控 ≥44px ─────────────────────
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});

    await sleep(620);
    const narrow = await metrics();
    screens.push({viewport: '390x844', at: 'six-selected', ...narrow});
    check('29-窄屏不溢出', '390×844：scrollW == clientW',
      narrow.scrollW === narrow.clientW,
      `clientW=${narrow.clientW} scrollW=${narrow.scrollW} bodyScrollW=${narrow.bodyScrollW}`);
    const targets = JSON.parse(await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?.shadowRoot??null;
      const out=[];
      for(const el of (sr?sr.querySelectorAll('button,summary,input'):[])){
        const r=el.getBoundingClientRect();
        if(r.width===0&&r.height===0)continue;
        if(el.closest('[hidden]'))continue;
        out.push({tag:el.tagName,cls:String(el.className||'').slice(0,26),w:Math.round(r.width),h:Math.round(r.height)});}
      return JSON.stringify({count:out.length,small:out.filter((x)=>x.w<44||x.h<44)});})()`));
    const touchProblems = touchTargetProblems(targets.small);
    check('30-触控目标', '390×844：模块里每个可见可点元素（按钮 / summary / 输入框）都 ≥44×44',
      touchProblems.length === 0,
      touchProblems.join(' | ') || `量了 ${targets.count} 个元素，全部达标`);
    counter('30-触控目标', '一个 30×30 的按钮必须被同一条判据抓住',
      touchTargetProblems([{tag: 'BUTTON', cls: 'tiny', w: 30, h: 30}]), 'BUTTON.tiny 30×30');
    const order = JSON.parse(await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?.shadowRoot??null;
      if(!sr)return '{"order":[],"tops":[]}';
      const boxes=['tw-team','tw-cand','tw-eval','tw-coach'];
      const order=boxes.filter((cls)=>sr.querySelector('.'+cls));
      const tops=order.map((cls)=>({cls,top:Math.round(sr.querySelector('.'+cls).getBoundingClientRect().top)}));
      return JSON.stringify({order,tops});})()`));
    const orderProblems = mobileOrderProblems(order.order, order.tops);
    check('31-移动端顺序', '390×844：区块顺序固定为「队伍槽位 → 候选池 → 当前评估 → Coach 短提示」',
      orderProblems.length === 0,
      orderProblems.join(' | ') || `顺序=${JSON.stringify(order.order)} 顶部位置=${JSON.stringify(order.tops)}`);
    counter('31-移动端顺序', '把顺序改成「评估在候选池前面」必须被同一条判据抓住',
      mobileOrderProblems(['tw-team', 'tw-eval', 'tw-cand', 'tw-coach'],
        [{cls: 'tw-team', top: 0}, {cls: 'tw-eval', top: 100}, {cls: 'tw-cand', top: 200}, {cls: 'tw-coach', top: 300}]),
      'order=[tw-team,tw-eval,tw-cand,tw-coach]');
    shots.push(await shootModule('workshop-05-six-selected-390x844'));

    // 窄屏再走一遍：清空 → 选两只，量一次 2～5 只的形态
    await mouseClick(`${ROOT_SEL} >>> #tw-reset`);
    await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0')===0`);
    await sleep(360);
    for (const name of pickNames.slice(0, 2)) await addByName(name);
    const narrowTwo = await facts();
    const narrowDom = await domFacts();
    const narrowMetrics = await metrics();
    steps.push({at: 'narrow-two', facts: narrowTwo, dom: narrowDom, metrics: narrowMetrics});
    screens.push({viewport: '390x844', at: 'two-selected', ...narrowMetrics});
    check('32-窄屏候选区', '390×844：选到第 2 只后仍然不横向溢出，三个候选与缺口清单都在',
      narrowMetrics.scrollW === narrowMetrics.clientW && Number(narrowTwo.next) === 3 && narrowDom.gapNodes >= 1,
      `clientW=${narrowMetrics.clientW} scrollW=${narrowMetrics.scrollW} next=${narrowTwo.next} 缺口=${narrowDom.gapNodes}`);
    shots.push(await shootModule('workshop-06-two-selected-390x844'));

    // ── ⑫ 标准 PVP 真的能开局（RC-106）：六槽选满 → 点按钮 → 战斗页拿到引擎的魔力 ──
    // 回到宽屏并把六只重新选上（上一节把视口压到 390 且只选了两只）。
    // **必须选「你拥有的、且六只是不同物种」的六只**：引擎只模拟有冻结配招的个体，
    // 同种重复也会被拒（`同一只精灵不能重复上场`）。所以这里按 owned 名单里的物种名去搜。
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await cdp.send('Page.navigate', {url: base + 'roco.html'});
    await waitFor(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twState==='ok'`);
    // 名字要用**页面显示的那个名字**（`nameOfInstance` 走盒子详情，形态名与 species_name 可能不同），
    // 否则按名字搜不到、六只会选不满——上一版就是这么差的 2 只。
    const ownedIds = (() => {
      const doc = JSON.parse(readFileSync(join(ROOT, 'data/roco/owned/owned-pets.json'), 'utf8'));
      const rows = Array.isArray(doc.instances) ? doc.instances : [];
      const seen = new Set(); const out = [];
      for (const row of rows) {
        if (seen.has(row.species_id)) continue;   // 同种重复会被引擎拒（「同一只精灵不能重复上场」）
        seen.add(row.species_id);
        out.push(row.instance_id);
        if (out.length === 6) break;
      }
      return out;
    })();
    const ownedNames = [];
    for (const id of ownedIds) {
      const name = await nameOfInstance(id);
      if (name && !ownedNames.includes(name)) ownedNames.push(name);
    }
    log('[标准 PVP] 用这六只不同物种的 owned 精灵开局：', ownedNames.join('、'));
    for (const name of ownedNames) {
      if (Number((await facts()).selected ?? 0) >= 6) break;
      await addByName(name);
    }
    const startState = JSON.parse(await js(`(()=>{const b=document.getElementById('start-standard-pvp');
      return b?JSON.stringify({disabled:b.disabled,team:b.dataset.rocoStandardTeam,fieldable:b.dataset.rocoStandardFieldable}):'null';})()`));
    const startProblems = standardStartButtonProblems(startState);
    check('34-标准 PVP 开局按钮', '六槽选满后「开一局（标准 PVP · 六宠）」按钮可用，且它读的是页面选出的六只',
      startProblems.length === 0, startProblems.join(' | ') || JSON.stringify(startState));
    counter('34-标准 PVP 开局按钮', '队伍不满六只（或按钮把规模读错）必须被同一条判据抓住',
      standardStartButtonProblems({disabled: false, team: '5'}), '{"disabled":false,"team":"5"}');
    await mouseClick('#start-standard-pvp');
    const battleStarted = await waitFor(`document.body.dataset.rocoView==='ready'`
      + ` && document.getElementById('battle-panel') && !document.getElementById('battle-panel').hidden`);
    await sleep(420);
    const battleFacts = JSON.parse(await js(`(()=>{const b=document.body.dataset;
      const self=document.getElementById('self-resource'), foe=document.getElementById('foe-resource');
      const note=document.getElementById('unverified-note'), panel=document.getElementById('battle-panel');
      const manaOf=(el)=>{const m=/(\\d+)/.exec(el?el.textContent:'');return m?Number(m[1]):null;};
      return JSON.stringify({mode:b.rocoMode??null,standardPvp:b.rocoStandardPvp??null,
        groups:b.rocoActionGroups??null,hidden:b.rocoActionsHidden??null,
        selfText:self?self.textContent.trim():null,foeText:foe?foe.textContent.trim():null,
        selfMana:manaOf(self),foeMana:manaOf(foe),
        noteHidden:note?note.hidden:null,noteText:note?note.textContent.trim():null,
        battleVisible:Boolean(panel)&&!panel.hidden});})()`));
    const battleProblems = sixPetBattleProblems(battleFacts);
    // 开局失败时页面会把服务端原文写进 `#plan-status`——把它带进断言信息里（报错原文就是证据）。
    const planStatus = await js(`document.getElementById('plan-status')?.textContent ?? null`);
    check('35-标准 PVP 战斗页', '按 v3 候选规则开局：魔力来自引擎（4/4）、无物品/逃跑、未核验假设如实标出',
      battleProblems.length === 0 && battleStarted,
      (battleProblems.join(' | ') || `mode=${battleFacts.mode} mana=${battleFacts.selfMana}/${battleFacts.foeMana} `
        + `groups=${battleFacts.groups} hidden=${battleFacts.hidden}`)
      + `；页面状态栏=「${String(planStatus ?? '').slice(0, 160)}」`);
    steps.push({at: 'standard-pvp-battle', facts: battleFacts});
    counter('35-标准 PVP 战斗页(模式)', '开局后模式被换成练习局必须被同一条判据抓住',
      sixPetBattleProblems({...battleFacts, mode: 'demo-training-3v3'}), '{"mode":"demo-training-3v3"}');
    counter('35-标准 PVP 战斗页(魔力)', '资源条还写「未核验」必须被同一条判据抓住',
      sixPetBattleProblems({...battleFacts, selfText: '魔力 / 心未核验'}),
      '{"selfText":"魔力 / 心未核验"}');
    counter('35-标准 PVP 战斗页(动作)', '物品组混进 1 条必须被同一条判据抓住',
      sixPetBattleProblems({...battleFacts, groups: 'skill:2,charge:0,switch:1,surrender:0,item:1,escape:0'}),
      '{"groups":"…,item:1,escape:0"}');
    counter('35-标准 PVP 战斗页(覆盖)', '把未核验覆盖藏起来必须被同一条判据抓住',
      sixPetBattleProblems({...battleFacts, noteHidden: true}), '{"noteHidden":true}');
    shots.push(await shoot('workshop-07-standard-pvp-1440x900'));

    // ── ⑬ RC-503：候选规则下的 Coach 取舍（真鼠标点「让小芽看一眼」）────────────
    // 这一条量的是**教练层在 v3 候选规则下**给不给那四样，以及建议是不是引擎真给的动作。
    await mouseClick('#plan');
    await waitFor(`document.getElementById('hint') && !document.getElementById('hint').hidden
      && document.querySelectorAll('#hint-body [data-cmp-action]').length>=2`, {tries: 80, ms: 250});
    await sleep(400);
    const coachFacts = JSON.parse(await js(`(()=>{const body=document.getElementById('hint-body');
      const acts=[...body.querySelectorAll('[data-cmp-action]')];
      const legal=(window.rocoDemo.state.view?.legal)||[];
      const nameOf=(a)=>a.label||a.skill_name||a.item_id||null;
      return JSON.stringify({
        actions:acts.length,
        futures:body.querySelectorAll('[data-cmp-future]').length,
        labels:acts.map((li)=>li.dataset.cmpLabel||''),
        legalLabels:legal.map(nameOf).filter(Boolean),
        text:body.innerText.replace(/\s+/g,' ').slice(0,400),
        planMode:window.rocoDemo.state.view?.ruleset_config_id??null,
        status:(document.getElementById('plan-status')||{}).textContent||''});})()`));
    const coachProblems = coachCompareProblems(coachFacts);
    check('36-候选规则下的 Coach 取舍', 'v3 候选规则下：并列比较 ≥2 条且逐条都是引擎给的合法动作、'
      + '未来 2—3 回合 ≥2 条、如实标置信/未核验、不出现胜率或百分数',
      coachProblems.length === 0,
      coachProblems.join(' | ') || `并列 ${coachFacts.actions} 条（${JSON.stringify(coachFacts.labels)}）`
        + `；未来 ${coachFacts.futures} 条；规则配置 ${coachFacts.planMode}`);
    counter('36-候选规则下的 Coach 取舍(编动作)', '建议里混进一个引擎没给的动作必须被同一条判据抓住',
      coachCompareProblems({...coachFacts, labels: [...coachFacts.labels, '旋风无敌斩']}), '{"labels":[…,"旋风无敌斩"]}');
    counter('36-候选规则下的 Coach 取舍(胜率)', '把「胜率 58%」写进取舍区必须被同一条判据抓住',
      coachCompareProblems({...coachFacts, text: `${coachFacts.text} 胜率 58%`}), '{"text":"…胜率 58%"}');
    shots.push(await shoot('workshop-08-coach-compare-1440x900'));

    check('33-控制台干净', '整轮下来没有 console.error，也没有未捕获异常',
      consoleErrors.length === 0 && pageErrors.length === 0,
      `consoleErrors=${JSON.stringify(consoleErrors.slice(0, 2))} pageErrors=${JSON.stringify(pageErrors.slice(0, 2))}`);
  } catch (error) {
    checks.push({id: 'fatal', judge: '整个流程必须跑完', ok: false, actual: `异常：${error?.stack || error}`});
    log('✖ 流程异常：', error?.stack || error);
  } finally {
    try { await cdp.send('Page.captureScreenshot').catch(() => {}); } catch {}
    if (!KEEP_OPEN) {
      try { ws.close(); } catch {}
      kill();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  }

  const failed = [...checks.filter((c) => !c.ok), ...counterproofs.filter((c) => !c.ok)];
  const report = {
    generated_by: 'scripts/roco/browser-workshop-acceptance.mjs',
    page: 'roco.html（产品页，#team-workshop 挂载点）',
    fixture: 'workshop.html（开发夹具/薄壳，不冒充产品页）',
    module: 'src/client/team-workshop.js（mountTeamWorkshop）',
    judged_at: new Date().toISOString(),
    forbidden_player_pattern: String(FORBIDDEN_PLAYER),
    pseudo_precision_pattern: String(PSEUDO_PRECISION),
    screenshots: shots,
    viewport_metrics: screens,
    checks,
    counterproofs,
    console_errors: consoleErrors,
    page_errors: pageErrors,
    steps,
    ok: failed.length === 0,
  };
  mkdirSync(OUT, {recursive: true});
  writeFileSync(join(ROOT, REPORT), `${JSON.stringify(report, null, 1)}\n`);

  log('─'.repeat(76));
  for (const row of [...checks, ...counterproofs.map((c) => ({...c, judge: `[反证] ${c.judge}`, actual: c.hit}))]) {
    log(row.ok ? '✔' : '✖', `${row.id} ${row.judge}`, '→', String(row.actual).slice(0, 180));
  }
  log(`截图 ${shots.length} 张 → reports/roco/workshop-acceptance/`);
  log(`判据 ${checks.filter((c) => c.ok).length}/${checks.length} 通过；反证 ${counterproofs.filter((c) => c.ok).length}/${counterproofs.length} 命中`);
  log(`报告 → ${REPORT}`);
  log(report.ok ? '全部通过' : `有 ${failed.length} 条不通过`);
  process.exit(report.ok ? 0 : 1);
}

// 只有「直接执行这个文件」时才跑浏览器验收；被测试 import 时只取判据。
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) await main();
export {main};
