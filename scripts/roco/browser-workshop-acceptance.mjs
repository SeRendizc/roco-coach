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
//   ③ 三条口径（模式 / 候选规则（待实机核对）/ 匹配前对手未知）按人类 2026-09-23 第六轮要求
//      **已从玩家层真删**：判据断言它们在玩家层（含真鼠标打开的小芽面板）**一次都不出现**；
//      口径本身没丢 —— `body.dataset.rocoMode` / `rocoPrematch` 与开发者抽屉里的注册表原文仍可核对。
//      候选池总量由模块的 `data-tw-pool-total`（≥600）记账。
//      （演变：2026-09-22「玩家层各出现一次」→ 09-23 白天「收进小芽面板 `#mode-chips`」→ 第六轮「真删」。）
//      「已选 3 只固定栏」这类 v3 废止口径必须没有。
//   ④ **没有真实环境分布就绝不给胜率或伪精确强度数字**：玩家可见文本里不许出现
//      「数字 + %」或「胜率/概率 + 数字」；算不出来的轴必须写「现在算不出来」并点名缺什么，
//      不许补 0。
//      ⚠ 2026-09-29（task-14）**改钉**：`PSEUDO_PRECISION` 一个字没改，改的是**豁免口径** ——
//      ①「可核对的冻结机制原文」（`sourcedMechanismLines`，交叉核对产物）照旧豁免；
//      ② 新增「**交代了来源**的假设值」（`sourcedAssumptionLines`：同一句里既有数字+%、
//        又写明「假设的权重 / 各体系等权 / 不是实测出场率」）也豁免 —— 那是如实交代来源的正确写法，
//        原来被当成伪精确（22/23 连红）；③ 挂上"假设"两个字的**胜率/概率**仍然红（禁语优先）。
//      判据只会更严不会更松：新增的两条**反向控制**证明"该放行的放行、该红的还红"。
//   ⑤ 两档（1440×900 / 390×844）都没有横向溢出（`clientW == scrollW`），
//      390px 下模块里每个可点元素 ≥44px，且**常规流**里的区块顺序是
//      「队伍槽位 → 候选池」（→ 若「当前评估」「小芽短提示」还在流里，必须依次排在后面）。
//      2026-09-23 版式演变：人类批注「右下角的小芽模块整体删除」→ `.tw-coach` 删除；
//      紧接着「阵容评估 → 左侧悬浮抽屉」→ `.tw-eval` 也不在流里，改由 `#tw-eval-drawer`
//      承担（判据里另加一条等价断言：真鼠标点 `#tw-eval-toggle` 能打开、面板可见且有内容）。
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
// 2026-09-28：定位的中文词表**只从产品那一份取**（`roco-service.js` 的 `BOX_ROLE_LABELS`
// 就是卡上 `role_label` 的来源）。以前 41 号判据自己抄了一份词表，抄错了一个字
// （写的是「恢复」，产品给的是「回复」）—— 那让「定位」这颗牙从来咬不到东西，
// 却因为是"少一个词"而看不出来。判据的口径词表必须与产品同源，不许各写一份。
import {BOX_ROLE_LABELS} from '../../src/server/roco-service.js';

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
 *
 * ⚠ 2026-09-29 改钉说明（task-14）：这个正则**一个字都没改**。
 * 「有来源交代的假设值」（例如「这类占 14%（各体系等权）——这是假设的权重，不是实测出场率」）
 * 走的是**豁免那一套**（`sourcedAssumptionLines` + `exemptSourcedLines`，与冻结机制原文同一条路），
 * 而**不是**放宽这里 —— 没有来源交代的 `\d+%` 照样要红（反向控制见 22/23 号那两条）。
 */
export const PSEUDO_PRECISION = /\d+(?:\.\d+)?\s*%|(?:胜率|概率|百分比|强度分)[^。；，]{0,6}\d/;

/**
 * 「这一句里同时交代了来源」的**闭集短语**（只有服务端自己标的假设才配这几句）。
 *
 * 为什么要有它：`f30126a`（P0-04）把那一句改成
 * 「撞上「翼王飞翼」这类最吃亏（赛前假设这类占 **14%**（各体系等权）——**这是假设的权重，不是实测出场率**）」
 * —— 那是**如实交代来源**的正确写法，却被 `PSEUDO_PRECISION` 当成伪精确（22/23 连红）。
 * 与机制原文那条一样：**先把可核对的来源句换成占位符，再拿同一个正则扫**，正则不动。
 *
 * 三条硬边界（都在 `sourcedAssumptionLines` 里落实）：
 *   ① 来源短语必须在**同一句**里（跨句不算）；
 *   ② 句子里出现「胜率 / 概率 / 百分比 / 强度分 + 数字」的**一律不豁免** —— 那几个词是禁语，
 *      挂上「假设」两个字也不能算交代来源（否则「本队胜率 58%（假设）」就被放过了）；
 *   ③ 没有来源短语 ⇒ 不豁免（反向控制：`这套阵容胜率 58%` 必须仍然红）。
 */
export const SOURCED_ASSUMPTION_PHRASES = Object.freeze([
  '假设的权重', '各体系等权', '按同等权重', '赛前假设', '不是实测', '不是实测出场率',
  '这是假设', '假设的对手分布', '没有实测数据',
]);


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

/**
 * 「**交代了来源**的假设值」那些句子（task-14）。
 *
 * 与 `sourcedMechanismLines` 同一条做法、同一个出口：它产出**一串可替换的句子**，
 * 交给 `exemptSourcedLines` 换成占位符，`PSEUDO_PRECISION` 一个字符都不用改。
 * 区别只在"来源"是什么：机制原文的来源是**冻结产物交叉核对**；这里是**句子里写明了这是假设**。
 *
 * 只豁免**同时满足**这三条的句子（缺一不豁免，宁可红着让人来改文案）：
 *   · 句子里有 `数字 + %`；
 *   · 同一句里有 `SOURCED_ASSUMPTION_PHRASES` 里的来源短语；
 *   · 同一句里**没有**「胜率 / 概率 / 百分比 / 强度分 + 数字」——那几个词是禁语，挂"假设"也不行。
 */
export function sourcedAssumptionLines(text) {
  const out = [];
  // 按句切：句号 / 分号 / 换行 / 感叹问号（中文全角与半角都算）。
  for (const sentence of String(text ?? '').split(/(?<=[。；！？!?\n])/)) {
    if (!/\d+(?:\.\d+)?\s*%/.test(sentence)) continue;
    if (!SOURCED_ASSUMPTION_PHRASES.some((phrase) => sentence.includes(phrase))) continue;
    if (/(?:胜率|概率|百分比|强度分)[^。；，]{0,6}\d/.test(sentence)) continue;   // ② 禁语优先
    const trimmed = sentence.trim();
    if (trimmed) out.push(trimmed);
  }
  return [...new Set(out)];
}

/** 两条来源豁免合起来用（机制原文 + 交代了来源的假设值）——**唯一的出口**，别再各写一份。 */
export function exemptAllSourced(text, {sourcedLines = []} = {}) {
  return exemptSourcedLines(text, [...sourcedLines, ...sourcedAssumptionLines(text)]);
}

/** 玩家可见文本：不许工程词、不许伪精确、必须有玩家可读的未知说明。 */
export function playerCopyProblems(text, {sourcedLines = []} = {}) {
  const problems = [];
  // 冻结效果原文里的百分数（例如特性「图书守卫者」的「双攻+100%」）不是伪精确强度：
  // 做法是把**已核对过的原文**换成占位符再扫，而**不是**放宽正则——
  // 手写一个「这套阵容胜率 58%」照样会被抓到（反证见 tests/roco-workshop.test.js）。
  // ⚠ 2026-09-29（task-14）：同上，**交代了来源的假设值**（「…占 14%（各体系等权）——这是假设的权重，
  // 不是实测出场率」）也走这一条豁免出口；没有来源交代的百分数仍然照红。
  const {text: scanned, exempted} = exemptAllSourced(text, {sourcedLines});
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
  // 2026-09-23（人类 v3h 版式）：魔力读数从 `#self-resource`/`#foe-resource`
  // （已被收进 `#b3-sink[hidden]`，玩家看不到）迁到**换宠屏的底栏聚能位**：
  // `body[data-b3-charge]='mana'` + `[data-b3-charge-value]` =「♥ n / pool」。
  if (facts?.chargeState !== 'mana') {
    problems.push(`换宠屏的聚能位必须切到 mana 态（body[data-b3-charge] 实际 ${JSON.stringify(facts?.chargeState)}）`);
  }
  if (!/♥/.test(String(facts?.selfText ?? ''))) {
    problems.push(`魔力读数必须写成「♥ n」（底栏聚能实际「${facts?.selfText}」）`);
  }
  if (Number.isFinite(facts?.engineSelfMana) && Number(facts?.selfMana) !== Number(facts.engineSelfMana)) {
    problems.push(`底栏读到的魔力 ${facts?.selfMana} ≠ 引擎给的 view.mana.self ${facts?.engineSelfMana}`);
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
  return (small ?? []).map((row) => `${row.tag}.${row.cls ?? ''} 只有 ${row.w}×${row.h}`
    + (row.path ? `（${row.path}${row.text ? ` · 「${row.text}」` : ''}）` : ''));
}

/**
 * 移动端**常规流**里的区块顺序必须是「队伍槽位 → 候选池」（→ 若「当前评估」「小芽短提示」
 * 还在流里，必须依次排在后面）。
 *
 * 2026-09-23 版式演变（判据跟着走，一次都没放松）：
 *   · 人类批注「右下角的小芽模块整体删除」→ `.tw-coach` 可以不存在；
 *   · 紧接着「阵容评估 → 左侧悬浮抽屉」→ `.tw-eval` 也**不在常规流里**了（改成 `#tw-eval-drawer`
 *     的固定抽屉）。「当前评估」这条口径没有丢：它由主流程里另加的一条等价断言守
 *     （抽屉存在 + 真鼠标点 `#tw-eval-toggle` 能打开 + 打开后 `#tw-eval-panel` 真的可见且里面有内容）。
 * （反证仍然成立：`['tw-team','tw-eval','tw-cand',…]` 这种把评估插到候选池前面的顺序 → 不等于期望 → 红。）
 */
export function mobileOrderProblems(order, tops) {
  const problems = [];
  const required = ['tw-team', 'tw-cand'];
  const present = required.filter((cls) => (order ?? []).includes(cls));
  const missing = required.filter((cls) => !present.includes(cls));
  if (missing.length) problems.push(`模块缺少必需区块：${missing.join(', ')}`);
  const optional = ['tw-eval', 'tw-coach'].filter((cls) => (order ?? []).includes(cls));
  const expect = [...present, ...optional];
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
    try { rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120}); } catch {}
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
  // A3（2026-09-22）：样例池按**物种**去重 —— 队伍「同物种最多一只」，
  // 而箱子前几个实例（own-0001/own-0002…）天生同种，slice(0, N) 会被服务端判 400。
  const ids = (() => {
    const seen = new Set(); const out = [];
    for (const row of [...owned.instances].sort((a, b) => a.instance_id.localeCompare(b.instance_id))) {
      if (seen.has(row.species_id)) continue;
      seen.add(row.species_id); out.push(row.instance_id);
    }
    return out;
  })();
  // ── 2026-09-28：两条判据的样例改成「从数据现算」，不再拿旧世界的数字当常量 ──────────
  //
  // 判据 `候选按拥有与否分组` 旧口径：「人类实测 Q2：候选里**约一半**是我不拥有的物种
  //   （实测 50 个候选里 25 个非我拥有）」—— 那是 2026-09-22 的**当时实测**。
  // 判据 `41-同名不同种看得出区别` 旧样例：own-0042/pet_000556 与 own-0043/pet_000575
  //   （都叫「棋契陛下」）—— 那一对是**旧可玩层 48 只**里的。
  //
  // 两者本轮都变了（人类 2026-09-28 拍板「**所有精灵实装**，这样就不需要我的精灵了，
  // 直接全筛选」）：可玩层 48 → 542（`owned-pets.json` 542 实例 / 542 物种），
  // 候选宇宙仍是 622 ⇒ 非我拥有的物种只剩 **80**，「约一半」在数据上已经不成立；
  // 而「棋契陛下」这一对**已按人类的剔除决定撤下**（`data/roco/normalized/.../layer-playable-48/pets.json`
  // 的 `excluded_capture_ids` 里 4086 写着「图鉴同名 8 条形态，本来就认不出是哪一条」）。
  //
  // 所以这里把两件事都**从当前数据现算**，判据写成"跟着数据走"：
  //   · `nonOwnedSpeciesExpected` = 候选宇宙(pack 622) − 我拥有的物种(owned) —— 唯一事实源；
  //   · `sameNameSample` = 当前**同时**满足「同名不同物种 + 两只都在我盒子里」的样例
  //     （页面 `#tw-scope-mine` 搜索框按名字查，所以"两只都在我盒子里"是前提，
  //     否则搜不出两行；而"两只都要在迁移层登记过定位"是本条判据的另一颗牙 —— 见下面的注释）。
  const onDemandBuilds = JSON.parse(readFileSync(join(ROOT, 'data/roco/derived/on-demand-builds.json'), 'utf8'));
  const fullCatalog = JSON.parse(readFileSync(
    join(ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json'), 'utf8'));
  const roster48 = JSON.parse(readFileSync(join(ROOT,
    'data/roco/normalized/roco-world-s4-2026-09-10/roster-48.json'), 'utf8'));
  const ownedSpeciesSet = new Set(owned.instances.map((i) => i.species_id));
  const candidateUniverseExpected = Number(owned.candidate_universe?.pack_pet_entities ?? fullCatalog.pets.length);
  const nonOwnedSpeciesExpected = [...new Set(fullCatalog.pets.map((p) => p.pet_id))]
    .filter((id) => !ownedSpeciesSet.has(id));
  const sameNameGroups = (() => {
    const byName = new Map();
    for (const p of fullCatalog.pets) {
      if (!ownedSpeciesSet.has(p.pet_id)) continue;   // 页面在「我的精灵」档按名字搜 ⇒ 两只都要我拥有
      const name = String(p.name ?? '');
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(p);
    }
    const groups = [...byName.entries()].filter(([, arr]) => arr.length >= 2)
      .map(([name, arr]) => ({name, ids: arr.map((p) => p.pet_id)}));
    // ⚠ 2026-09-28 实测（逐条问 `/api/roco/box?kind=mine`）：页面卡上的「定位」来自 `index.layer`
    //   （`roster-48.json`），而能分辨同名对的**形态名**来自 `title`（产品侧 2026-09-28 已把
    //   「我的盒子」卡名改成形态名优先）。这里按「信号强度」排序，**优先挑页面上真的分得出
    //   区别的那一对**（排序不是判据；判据仍要求两行文本不同 + 两个不同信号，够不到就红）。
    const inRoster = new Set(roster48.pets.map((p) => p.pet_id));
    const roleInRoster = (id) => roster48.pets.find((p) => p.pet_id === id)?.role ?? null;
    const titlesOf = (g) => new Set(g.ids.map((id) => fullCatalog.pets
      .find((p) => p.pet_id === id)?.title ?? null).filter(Boolean));
    return [...groups].sort((a, b) => {
      const rank = (g) => {
        const roleDiff = new Set(g.ids.map(roleInRoster).filter(Boolean)).size >= 2;
        const titleDiff = titlesOf(g).size >= 2;
        if (roleDiff) return 0;                      // 定位就能分开（最强）
        if (titleDiff) return 1;                     // 只有形态名能分开（当前同名对多数如此）
        return 2;                                    // 页面看不出区别 —— 判据会红（如实）
      };
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    });
  })();
  // 当前数据里最优的那一对（判据的样例就是它；搜不出两行时按上面的排序再试别的同名组）。
  const sameNameSample = sameNameGroups[0] ?? null;
  const sameNameCandidatesTried = [];
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
      const host=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=host?host.shadowRoot:null;
      const sEl=(sr&&typeof sr.elementFromPoint==='function')?sr.elementFromPoint(${r.x},${r.y}):null;
      const pathOf=(node)=>{const out=[];let n=node;while(n){out.push(String(n.tagName||'')
        +(n.id?'#'+n.id:'')+(n.className?'.'+String(n.className).trim().split(/\\s+/).join('.'):''));
        n=n.parentNode||n.host||null;if(out.length>6)break;}return out.join('<');};
      return JSON.stringify({tag:el?el.tagName:null,cls:el?String(el.className||'').slice(0,40):null,
        path:el?pathOf(el):null,shadowTag:sEl?sEl.tagName:null,shadowPath:sEl?pathOf(sEl):null});})()`));
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
    const click = await mouseClick(`${ROOT_SEL} >>> .tw-row[data-tw-species="${probe.species}"]`);
    await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0') >= ${beforeCount + 1}`,
      {tries: 40, ms: 120});
    const after = Number((await facts()).selected ?? 0);
    // 判据红了要能看出「点上去落在了谁身上」：把命中的路径与点后的模块状态一起带回去。
    const topAfter = await js(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twState ?? null`);
    return {added: after > beforeCount, probe, beforeCount, after,
      click: click?.top ?? null, topAfter};
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
  /**
   * **反向控制**（task-14 加）：证明判据**不是什么都抓** —— 喂"应当放行"的样本，必须一条都不报。
   *
   * 为什么与 `counter` 分开写：`counter` 断言"必须命中"，这一条断言"必须不命中"。
   * 两者是一对：只有一条的话，判据可以靠"永远报错"或"永远不报"骗过验收。
   * `samples` 是若干份**应当无话可说**的样本；只要有一份被报出来，这条就红
   *（样本里若混了"本来就该红"的（例如胜率 58% 挂"假设"），用 `mustHit` 单独点出来）。
   */
  const control = (id, judge, {samples = [], mustHit = [], problemsOf = playerCopyProblems} = {}, actual = '') => {
    const leaked = samples.map((text) => problemsOf(text)).filter((problems) => problems.length);
    const missed = mustHit.map((text) => problemsOf(text)).filter((problems) => !problems.length);
    const problems = [...leaked.flat(), ...missed.map(() => '应当命中的样本没被命中')];
    counterproofs.push({id, judge, ok: problems.length === 0,
      hit: problems.join(' | ') || '（两份样本都按预期：该空的空、该响的响）', actual: String(actual)});
    log(problems.length ? '✖' : '✔', `[反证 ${id}]`, judge,
      '—实际：', (problems.join(' | ') || '按预期（该空的空、该响的响）').slice(0, 240));
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
    // 2026-09-22（人类视觉规格）：模式/候选规则/对手未知这三枚徽记**页头已经写着**，
    // 模块里再放一份就是「同屏重复」，所以从模块撤掉了。判据改成：
    //   ① 这三条信息在**页面上**（页头）恰好出现一次；
    //   ② 模块自己只留「候选来自全图鉴 600+」这条它才知道的信息。
    // 页头那三条口径用 `body.innerText` 数（模块在 shadow root 里，body.innerText 看不到它，
    // 正好用来数「页面上出现几次」）；模块自己那条从 dataset 读（`twPoolTotal`）。
    // 2026-09-23：页头按人类规格精简后，这三条口径搬进了**小芽面板**（默认收起）与内联位置。
    // `innerText` **不含** hidden 子树，会把面板里的那几条漏掉（实测得到 -1）；
    // 改用 `textContent`（含收起的面板），并继续**排除**工程抽屉那份 —— 语义仍是
    // 「玩家层恰好各出现一次，不许重复」。模块仍在 shadow root 里，textContent 也看不到它。
    // 2026-09-22（人类实测 Q2）：候选里约一半是**我不拥有的物种**（实测 50 个候选 25 个非我拥有）。
    // 2026-09-23（人类批注）：原来那两行 `[data-tw-group]` 分组说明**已删**（`groupPoolRows()`
    // 现在插的是空串）。判据按新设计做**等价替换**，口径不放松：
    //   ① **作用域分档**（`#tw-scope-all` 全图鉴 / `#tw-scope-mine` 我的精灵）真的改变结果集，
    //      且「我的精灵」一档里**只含我拥有的**；
    //   ② **逐卡**携带拥有与否的状态标签（「你还没有这一只」/「持有 · 可正式上场」）；
    //   ③ 「图鉴参考不能正式出战」这层含义仍可读到 —— 由卡上的状态标
    //      「图鉴 · 按需推算（未核验）」＋行标「你还没有这一只」承担（原分组说明由它们承担）。
    const readOwnership = async () => JSON.parse(await js(`(()=>{
      const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?.shadowRoot??null;
      const rows=sr?[...sr.querySelectorAll('#tw-cand-list .tw-row')]:[];
      const tagOf=(r)=>{const el=r.querySelector('.tw-state-tag');return el?(el.textContent||'').trim():'';};
      const rowtagOf=(r)=>{const el=r.querySelector('.tw-rowtag');return el?(el.textContent||'').trim():'';};
      const nameOf=(r)=>(r.querySelector('.tw-name')?.textContent||'').trim();
      const held=rows.filter((r)=>r.dataset.twStatus==='held');
      const notHeld=rows.filter((r)=>r.dataset.twStatus!=='held');
      return JSON.stringify({
        scope:(sr&&sr.querySelector('#tw-scope-all')?.getAttribute('aria-pressed')==='true')?'all':'mine',
        total:Number(root?.dataset.twPoolTotal||'0'),
        heldCount:Number(root?.dataset.twPoolHeld||'0'),
        refCount:Number(root?.dataset.twPoolRef||'0'),
        rowCount:rows.length,
        taggedRows:rows.filter((r)=>Boolean(tagOf(r))).length,
        // 2026-09-28：这两条是**当前这一页**的逐卡事实（不是从"少了几个"倒推的）——
        // 判据要在"真的含非我拥有物种的那一页"上量它们。
        notOwnedRows:notHeld.filter((r)=>/你还没有这一只/.test(rowtagOf(r))).length,
        onDemandRows:notHeld.filter((r)=>/图鉴|按需推算|未核验/.test(tagOf(r))).length,
        hasNotOwned:notHeld.some((r)=>/你还没有这一只/.test(rowtagOf(r))),
        hasTrial:notHeld.some((r)=>/图鉴|按需推算|未核验/.test(tagOf(r))),
        heldTagOk:held.every((r)=>/持有|可正式上场/.test(tagOf(r))),
        notOwnedSample:notHeld[0]?{name:nameOf(notHeld[0]),status:notHeld[0].dataset.twStatus,
          tag:tagOf(notHeld[0]),rowtag:rowtagOf(notHeld[0])}:null,
        heldSample:held[0]?{name:nameOf(held[0]),status:held[0].dataset.twStatus,
          tag:tagOf(held[0]),rowtag:rowtagOf(held[0])}:null});})()`));
    const scopeOwnership = {};
    for (const [scope, sel] of [['all', `${ROOT_SEL} >>> #tw-scope-all`],
      ['mine', `${ROOT_SEL} >>> #tw-scope-mine`]]) {
      await mouseClick(sel);
      await sleep(900);
      scopeOwnership[scope] = await readOwnership();
    }
    // 回到**全图鉴**：后面的 `08` / `09` 与按名字搜索都按全量宇宙量。
    await mouseClick(`${ROOT_SEL} >>> #tw-scope-all`);
    await sleep(900);
    // 2026-09-28（新增）：**真鼠标翻页**找一页真的含「非我拥有」物种的候选页。
    // 为什么需要：候选按物种排序，而"非我拥有"的 80 只**全在高位**（最小的一只排在第 139 位），
    // 第一页 12 张全是"持有" —— 在那一页上量「你还没有这一只」根本量不到东西
    // （旧口径"约一半非我拥有、第一页就混着"已经不成立，见判据里的改钉说明）。
    // 页数上限 60 是防呆（候选宇宙 622 / 每页 12 ≈ 52 页）；翻不到就如实写进 actual，让判据红。
    const catalogPageInfo = async () => js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?root.shadowRoot:null;
      const el=sr?sr.querySelector('#tw-cand-page'):null;
      const m=el?(el.textContent||'').match(/(\\d+)\\s*\\/\\s*(\\d+)/):null;
      return {page:m?Number(m[1]):0,pages:m?Number(m[2]):0,
        nextDisabled:sr?Boolean(sr.querySelector('#tw-cand-next')?.disabled):true};})()`);
    const mixedOwnershipPage = {page: 0, fetchedFacts: false, facts: null, trace: []};
    if (nonOwnedSpeciesExpected.length >= 1) {
      let remaining = 60;
      while (remaining > 0) {
        const info = await catalogPageInfo();
        if (!info.page || info.page > 60 || info.pages === 0) {
          mixedOwnershipPage.trace.push({page: info.page, note: '页码读不出来或超出上限，停'});
          break;
        }
        const facts = await readOwnership();
        mixedOwnershipPage.trace.push({page: info.page, rowCount: facts.rowCount,
          notOwnedRows: facts.notOwnedRows});
        if (facts.scope !== 'all') { mixedOwnershipPage.trace.push({note: '不在全图鉴档，停'}); break; }
        if (facts.notOwnedRows >= 1) {
          mixedOwnershipPage.page = info.page;
          mixedOwnershipPage.fetchedFacts = true;
          mixedOwnershipPage.facts = facts;
          break;
        }
        if (info.nextDisabled || info.page >= info.pages) break;
        await mouseClick(`${ROOT_SEL} >>> #tw-cand-next`);
        await sleep(400);
        remaining -= 1;
      }
      // 翻页只影响候选列表的 offset，不影响后面的搜索（搜索一律回第 1 页）；
      // 但仍然**显式还原**一次，别把"停在第 N 页"留给后面的判据。
      await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)}).shadowRoot;
        const i=sr.getElementById('tw-search');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));
        return true;})()`);
      await sleep(600);
    }
    if (!mixedOwnershipPage.fetchedFacts) {
      log(`⚠ 没翻到含「非我拥有」物种的候选页 —— 那几条判据会红；翻页记账 ${JSON.stringify(mixedOwnershipPage.trace).slice(0, 300)}`);
    }
    // 2026-09-28 改钉（本条判据）：`候选按拥有与否分组` 有**四条**必须同时成立的面 ——
    //   ① 作用域分档真的换结果集、且「我的精灵」只含我拥有的（原样保留）；
    //   ② **逐卡**状态标签说清拥有与否（「你还没有这一只」/「持有 · 可正式上场」）（原样保留）；
    //   ③ 卡上的「图鉴 · 按需推算（未核验）」状态标（原样保留）；
    //   ④ **候选池里确实混着我不拥有的物种**（本轮新增/改钉，见下）。
    const ownershipProblems = (f) => {
      const bad = [];
      if (!(f?.allTotal >= 1)) bad.push(`「全图鉴」一档没有结果（total=${f?.allTotal}）`);
      if (!(f?.mineTotal >= 1)) bad.push(`「我的精灵」一档没有结果（total=${f?.mineTotal}）`);
      if (f?.allTotal === f?.mineTotal) {
        bad.push(`「全图鉴」与「我的精灵」结果条数相同（${f?.allTotal}）——作用域分档没真的换结果集`);
      }
      if (!(f?.rowCount >= 1)) bad.push('全图鉴这一页没有任何候选卡');
      if (!(f?.taggedRows === f?.rowCount)) {
        bad.push(`有 ${(f?.rowCount ?? 0) - (f?.taggedRows ?? 0)} 张候选卡没有状态标签`);
      }
      // 2026-09-28 改钉：旧口径「候选里约一半是我不拥有的物种（实测 50 个候选 25 个非我拥有）」
      // 在数据上**已经不成立**（可玩层 48→542、候选宇宙仍 622 ⇒ 非我拥有只剩 80 只，
      // 而且按物种排序时它们**不在第一页**：第一页 12 只全是我拥有的）。
      // 判据保留的意图是「候选池里**确实混着**我不拥有的物种，而且页面把这件事说清」，
      // 所以：先按数据现算非我拥有的物种数（== 0 必须红 —— 不许把这条改成恒真），
      // 再**翻到一页真的含非我拥有物种的页面**上量逐卡标签（在全是"持有"的那一页上量，
      // 「你还没有这一只」这颗牙根本咬不到东西）。
      if (!(f?.nonOwnedExpected >= 1)) {
        bad.push(`数据里非我拥有的候选物种 = ${f?.nonOwnedExpected}（候选宇宙 − 我拥有的物种）`
          + '——候选池根本没混着我不拥有的物种，这条判据不成立');
      }
      if (!(f?.notOwnedRows >= 1)) {
        bad.push(`翻到第 ${f?.mixedPage ?? '?'} 页仍只有我拥有的卡（非我拥有 ${f?.notOwnedRows ?? 0} 张）`
          + '——页面把"我没有的物种"整档藏起来了');
      }
      if (!f?.hasNotOwned) bad.push('没有一张卡标出「你还没有这一只」（拥有与否没逐卡说清）');
      if (!f?.hasTrial) bad.push('没有一张卡标出「图鉴 / 按需推算（未核验）」（「不能正式出战」这层含义丢了）');
      if (f?.heldTagOk === false) bad.push('持有的卡没有写「持有 · 可正式上场」');
      if (!(f?.mineRefCount === 0 && f?.mineRowCount >= 1)) {
        bad.push(`「我的精灵」一档里混进了非持有的卡（rows=${f?.mineRowCount} ref=${f?.mineRefCount}）`);
      }
      return bad;
    };
    // ③ 那层含义单独也留一条牙：非我拥有的卡上必须写「图鉴 · 按需推算（未核验）」。
    const trialLabelProblems = (f) => (!(f?.onDemandRows >= 1)
      ? [`非我拥有的卡里没有一张带「图鉴 · 按需推算（未核验）」状态标（onDemandRows=${f?.onDemandRows ?? 0}）`]
      : []);
    const poolOwnership = {
      allTotal: scopeOwnership.all.total,
      mineTotal: scopeOwnership.mine.total,
      mineRowCount: scopeOwnership.mine.rowCount,
      mineRefCount: scopeOwnership.mine.refCount,
      // 2026-09-28：**逐卡**那几项一律用「真的翻到含非我拥有物种的那一页」量到的 DOM 事实。
      // 为什么不能用第一页那一份：候选按物种排序、非我拥有的 80 只全在高位（最小的一只排在第
      // 139 位）⇒ 第 1 页 12 张全是"持有"，在那一页上量「你还没有这一只」永远量不到
      // （ws-run2 实测：那条旧读取点红在「没有一张卡标出…」，而**第 14 页**上明明有）。
      rowCount: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.rowCount : 0,
      taggedRows: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.taggedRows : 0,
      hasNotOwned: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.hasNotOwned : false,
      hasTrial: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.hasTrial : false,
      heldTagOk: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.heldTagOk : null,
      notOwnedSample: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.notOwnedSample : null,
      heldSample: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.heldSample : null,
      page1RowCount: scopeOwnership.all.rowCount,
      page1TaggedRows: scopeOwnership.all.taggedRows,
      // 现算的数据事实 + 真的翻到含非我拥有物种的那一页之后量到的 DOM 事实
      nonOwnedExpected: nonOwnedSpeciesExpected.length,
      candidateUniverseExpected,
      mixedPage: mixedOwnershipPage.page,
      notOwnedRows: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.notOwnedRows : 0,
      onDemandRows: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.onDemandRows : 0,
      hasNotOwnedMixed: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.hasNotOwned : false,
      hasTrialMixed: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.hasTrial : false,
      heldTagOkMixed: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.heldTagOk : null,
      mixedNotOwnedSample: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.notOwnedSample : null,
      mixedHeldSample: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.heldSample : null,
      mixedRowCount: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.rowCount : 0,
      mixedTaggedRows: mixedOwnershipPage.facts ? mixedOwnershipPage.facts.taggedRows : 0,
    };
    // 量「非我拥有」这件事必须在**真的含非我拥有物种的那一页**上做（见上面 ④）。
    const mixedProbeProblems = (f) => {
      const bad = [];
      if (!(f?.mixedPage >= 1)) bad.push('没翻到任何一页含非我拥有物种的候选页（连第一页都没量到）');
      if (!(f?.notOwnedRows >= 1)) {
        bad.push(`翻到第 ${f?.mixedPage ?? '?'} 页仍只有我拥有的卡（非我拥有 ${f?.notOwnedRows ?? 0} 张）`);
      }
      if (!f?.hasNotOwnedMixed) bad.push('混着的那一页上没有一张卡标出「你还没有这一只」');
      if (!f?.hasTrialMixed) bad.push('混着的那一页上没有一张非我拥有的卡标出「图鉴 · 按需推算（未核验）」');
      return bad;
    };
    const ownProbs = ownershipProblems(poolOwnership);
    const mixedProbs = mixedProbeProblems(poolOwnership);
    const trialProbs = trialLabelProblems(poolOwnership);
    check('候选按拥有与否分组', '候选池里确实混着我不拥有的物种，且页面把「是不是我的」逐卡说清。'
      + '【2026-09-28 改钉，旧口径原文：「人类实测 Q2：候选里**约一半**是我不拥有的物种'
      + '（实测 50 个候选 25 个非我拥有）」—— 那是 2026-09-22 的当时实测；本轮人类拍板'
      + '「所有精灵实装，这样就不需要我的精灵了，直接全筛选」之后，可玩层 48 → 542、'
      + '候选宇宙仍 622 ⇒ 非我拥有的物种只剩 80，「约一半」在数据上已经不成立。'
      + '保留的意图是「候选池里确实混着我不拥有的物种 + 页面把这件事说清」，'
      + '比例换成**现算**的物种数（=0 必红）。'
      + '【按人类 2026-09-23 批注，原 `#tw-cand-list > [data-tw-group]` 两行分组说明**已删**；'
      + '改由三条等价断言承担：① `#tw-scope-all`（全图鉴）与 `#tw-scope-mine`（我的精灵）结果集真的不同、'
      + '且「我的精灵」只含我拥有的；② **逐卡**状态标签说清拥有与否；'
      + '③ 「图鉴参考不能正式出战」由卡上的「图鉴 · 按需推算（未核验）」状态标承担】',
      ownProbs.length === 0,
      ownProbs.join(' | ')
      || `候选宇宙 ${poolOwnership.candidateUniverseExpected} 只、我拥有 ${poolOwnership.mineTotal} 只`
        + `⇒ 非我拥有 ${poolOwnership.nonOwnedExpected} 只；`
        + `全图鉴 ${poolOwnership.allTotal} 条 / 我的精灵 ${poolOwnership.mineTotal} 条（ref=${poolOwnership.mineRefCount}）；`
        + `翻到第 ${poolOwnership.mixedPage} 页：本页 ${poolOwnership.mixedRowCount} 张，带状态标 ${poolOwnership.mixedTaggedRows} 张，`
        + `非我拥有 ${poolOwnership.notOwnedRows} 张；`
        + `非拥有样例 ${JSON.stringify(poolOwnership.mixedNotOwnedSample)}；`
        + `拥有样例 ${JSON.stringify(poolOwnership.mixedHeldSample)}`);
    counter('候选按拥有与否分组', '作用域分档形同虚设（两档结果条数相同）+ 卡片不带拥有与否状态标 + '
      + '翻到的页面里一张非我拥有的卡都没有，必须被同一条判据抓住',
      ownershipProblems({allTotal: 24, mineTotal: 24, mineRowCount: 24, mineRefCount: 0,
        rowCount: 24, taggedRows: 0, hasNotOwned: false, hasTrial: false, heldTagOk: false,
        nonOwnedExpected: 80, notOwnedRows: 0, mixedPage: 12}),
      '{"allTotal":24,"mineTotal":24,"taggedRows":0,"hasNotOwned":false,"notOwnedRows":0}');
    // 第二条反证（2026-09-28 新增，专打"非我拥有的候选数 = 0"这颗新牙）：
    // 数据里一只非我拥有的物种都没有 ⇒ 这条判据必须红（改成恒真的写法会当场被这条抓住）。
    counter('候选按拥有与否分组', '数据里非我拥有的候选物种 = 0（候选宇宙 == 我拥有的物种）必须被同一条判据抓住',
      ownershipProblems({allTotal: 622, mineTotal: 622, mineRowCount: 12, mineRefCount: 12,
        rowCount: 12, taggedRows: 12, hasNotOwned: false, hasTrial: false, heldTagOk: true,
        nonOwnedExpected: 0, notOwnedRows: 0, mixedPage: 1}),
      '{"nonOwnedExpected":0,"notOwnedRows":0}');
    check('候选池混着非我拥有的物种（逐卡标签）',
      '真鼠标翻到**含非我拥有物种的那一页**：那张卡写着「你还没有这一只」+「图鉴 · 按需推算（未核验）」'
      + '【2026-09-28 拆出来的独立牙：全是"持有"的那一页量不到这两句话】',
      mixedProbs.length === 0 && trialProbs.length === 0,
      mixedProbs.concat(trialProbs).join(' | ')
      || `第 ${poolOwnership.mixedPage} 页 ${poolOwnership.mixedRowCount} 张里非我拥有 ${poolOwnership.notOwnedRows} 张；`
        + `样例 ${JSON.stringify(poolOwnership.mixedNotOwnedSample)}`);
    counter('候选池混着非我拥有的物种（逐卡标签）', '把非我拥有那张卡的「你还没有这一只」与「未核验」两处标都去掉，必须被抓住',
      mixedProbeProblems({...poolOwnership, hasNotOwnedMixed: false})
        .concat(trialLabelProblems({...poolOwnership, onDemandRows: 0})),
      '{"hasNotOwnedMixed":false,"onDemandRows":0}');

    // 2026-09-23（人类第六轮，「口径文案真删」）：三条口径（模式 / 候选规则 / 匹配前对手未知）
    // 的容器 `#mode-chips` 已**从 HTML 删除**（不是隐藏），界面上一处不留。
    // 这条判据的等价形态（2026-09-22 是「玩家层各出现一次」→ 白天「收进小芽面板 `#mode-chips`」）：
    //   ① 玩家层（`document.body.textContent` 去掉默认收起的 `#about-drawer`）里那三条**一次都不许出现**；
    //   ② 真鼠标点 `#coach-entry` 打开小芽面板，面板里同样一次都不许出现；
    //   ③ 口径没丢：`body.dataset.rocoMode` / `rocoPrematch` 与开发者抽屉里的注册表原文仍可核对；
    //   ④ 候选池总量仍由模块 `data-tw-pool-total`（≥600）记账。
    const openCoachPanel = async () => {
      for (let i = 0; i < 3; i += 1) {
        if (await js(`(()=>{const c=document.getElementById('companion-card');
          return Boolean(c)&&c.hidden===false&&c.getClientRects().length>0;})()`)) return true;
        await mouseClick('#coach-entry');
        await sleep(420);
      }
      return false;
    };
    const closeCoachPanel = async () => {
      if (await js(`(()=>{const c=document.getElementById('companion-card');return Boolean(c)&&c.hidden===false;})()`)) {
        await mouseClick('#close-companion');
        await sleep(360);
      }
    };
    const coachPanelOpen = await openCoachPanel();
    const headerBadges = await js(`(()=>{const t=document.body.textContent||'';
      const d=document.getElementById('about-drawer');
      const dt=d?(d.textContent||''):'';
      const count=(needle)=>(t.split(needle).length-1)-(dt.split(needle).length-1);
      const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const card=document.getElementById('companion-card');
      const chips=document.getElementById('mode-chips');
      const panelText=card?(card.textContent||''):'';
      const raw=(document.getElementById('mode-raw')?.textContent||'')
        +' | '+(document.getElementById('mode-probe')?.textContent||'');
      return JSON.stringify({mode:count('标准 PVP 六宠阵容工坊'),
        candidate:count('候选规则（待实机核对）'),prematch:count('匹配前对手未知'),
        poolTotal:Number(root?.dataset.twPoolTotal||'0'),
        panelOpen:Boolean(card)&&card.hidden===false&&card.getClientRects().length>0,
        chipsFound:Boolean(chips),
        panelHasCopy:/候选规则（待实机核对）|匹配前对手未知/.test(panelText),
        datasetMode:document.body.dataset.rocoMode??null,
        datasetPrematch:document.body.dataset.rocoPrematch??null,
        drawerRaw:raw});})()`).then(JSON.parse);
    await closeCoachPanel();

    check('03-徽记与候选池', '三条口径按人类 2026-09-23 第六轮要求**已从玩家层真删**（一次都不出现，'
      + '真鼠标打开的小芽面板里也没有）；候选池总量仍由模块 `data-tw-pool-total`（≥600）记账；'
      + '口径本身没丢 —— `body.dataset.rocoMode` / `rocoPrematch` 与开发者抽屉里的注册表原文仍可核对。'
      + '【2026-09-22 的口径是「三条各出现一次」→ 09-23 白天改到小芽面板 `#mode-chips` → 第六轮人类'
      + '再次明确定为「真删」（容器已从 HTML 删除）。这条判据从「断言出现」等价改成「断言不出现」，'
      + '并保留数据层/抽屉的可核对性（旧读取点 `#mode-line` 与 `#mode-chips` 都已删除）】',
      headerBadges.mode===0&&headerBadges.candidate===0&&headerBadges.prematch===0
      &&Number(headerBadges.poolTotal)>=600
      &&headerBadges.datasetMode==='pvp-standard-six-pet'
      &&headerBadges.datasetPrematch==='UNKNOWN_PREMATCH'
      &&/pvp-standard-six-pet|标准 PVP/.test(String(headerBadges.drawerRaw??''))
      &&headerBadges.chipsFound===false&&headerBadges.panelHasCopy===false,
      `玩家层出现次数 ${JSON.stringify(headerBadges)}；真鼠标点开小芽=${coachPanelOpen}，`
      + `#mode-chips=${headerBadges.chipsFound ? '**又被加回来了**' : '缺失（符合「真删」）'}`);

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

    // 2026-09-23（人类批注）：`#tw-favourite`（只看收藏）**已删除**，原步骤会直接抛 fatal。
    // 等价替换：仍然用**真实鼠标**切换一档候选范围 → 候选池真的重新取数（`data-twPoolTotal` 变：
    // 全图鉴 622 ↔ 我的精灵 80）→ 模块回到 ok；再切回「全图鉴」，后面的按名搜索仍在全量宇宙上量。
    // （原「只看收藏」与「我的精灵」是同一类**收窄作用域**的操作，口径不变；
    //   ⚠ `data-twSeq` 只记**评估**请求，范围切换只重取候选池 —— 所以这里量的是结果集本身。）
    const poolTotalOf = async () => Number((await facts()).poolTotal ?? 0);
    const totalBeforeScope = await poolTotalOf();
    const mineClick = await mouseClick(`${ROOT_SEL} >>> #tw-scope-mine`);
    await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twPoolTotal||'0') !== ${totalBeforeScope}`,
      {tries: 60, ms: 150});
    await sleep(360);
    const scopeMineOn = await facts();
    const totalMine = Number(scopeMineOn.poolTotal ?? 0);
    const allClick = await mouseClick(`${ROOT_SEL} >>> #tw-scope-all`);
    await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twPoolTotal||'0') !== ${totalMine}`,
      {tries: 60, ms: 150});
    await sleep(420);
    const scopeAllBack = await facts();
    check('09-范围分档开关', '真实鼠标点「我的精灵」→ 候选池真的重新取数（结果集从全量收窄）且模块回到 ok；'
      + '再点「全图鉴」回到原结果集与 ok。'
      + '【原 `#tw-favourite`（只看收藏）已按人类 2026-09-23 删除，由范围分档 '
      + '`#tw-scope-mine` / `#tw-scope-all` 承担（同样是「收窄候选范围」这一类操作）】',
      scopeMineOn.state === 'ok' && scopeAllBack.state === 'ok'
      && totalMine !== totalBeforeScope && totalMine > 0
      && Number(scopeAllBack.poolTotal) === totalBeforeScope,
      `点「我的精灵」后 state=${scopeMineOn.state}（selected=${scopeMineOn.selected}，`
      + `total ${totalBeforeScope}→${totalMine}）；点回「全图鉴」后 state=${scopeAllBack.state}`
      + `（total=${scopeAllBack.poolTotal}）；命中=${JSON.stringify(mineClick.top)} / ${JSON.stringify(allClick.top)}`);

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
        // 2026-09-25：**必须看像素**。这个框（#tw-analysis-box）在标记里写死 hidden，
        // 而代码只给它设 .open —— 于是"理论阵容"一直不可见，而判据只读 DOM 内容，长期是绿的
        //（「判据读取点 ≠ 玩家真正看的像素」的又一例）。所以这里同时取 hidden/高度。
        const details=sr?sr.getElementById('tw-analysis-box'):null;
        return {count:Number(root?.dataset.twAnalysis||'0'),slots:filled,
          box:{hidden:details?.hidden===true,open:details?.open===true,
            h:details?Math.round(details.getBoundingClientRect().height):null},
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
        // 有内容就必须**看得见**（这不是"接口存在"，是玩家真的能看到那一格）。
        const box = facts?.analysis?.box;
        if (box && Number(facts?.analysis?.count) >= 1 && (box.hidden === true || !(box.h > 0))) {
          bad.push(`理论阵容有 ${facts.analysis.count} 只，但那个框不可见（hidden=${box.hidden} 高度=${box.h}）`);
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
      counter('10-图鉴物种照实拒绝', '理论阵容**有内容却是隐藏的**（只读 DOM 不看像素的读法）必须被抓住',
        catalogProblems({state: 'ok', analysis: {count: 1, slots: [{status: 'on_demand', canBattle: 'trial'}],
          box: {hidden: true, open: true, h: 0}}, playerText: ''}),
        '{count:1, box:{hidden:true,h:0}}');
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
    check('18-满六只五轴', '选满六只后出现完整诊断：五轴都在（**接口层**）；能算的给值，算不出的给原因且不带值（不补 0）。'
      + '【2026-09-25（人类投诉「五项全算不出来 + 大片没用的信息」）：页面上算不出来的轴**合并成一行** ⇒ DOM 轴节点数 = '
      + '能算的轴数 + 1；接口层仍是五轴逐条（口径没放松，只是不再把同一句话印四遍）】',
      axisProblemsFound.length === 0
      // 2026-09-25：`+1` 那个"恒有 1 行算不出来"的前提**已经过期** —— 四轴改成三档判定（`measured`/`assumption`/`unknown`）之后
      // `meta-prior` 可以带 assumption ⇒ **五轴全可算** ⇒ DOM 轴节点数应等于「能算的轴数 +（还有不可算的轴 ? 1 : 0）」。
      // 条件式而不是放宽：两种状态下都要求 DOM 与接口层**逐条对齐**（多一个/少一个仍然红）。
      && sixDom.axisNodes === (sixRoute.json.axes ?? []).filter((axis) => axis.available).length
        + ((sixRoute.json.axes ?? []).some((axis) => !axis.available) ? 1 : 0),
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
    // ── 2026-09-25（人类五条投诉）的真机判据：抽屉滚得动 / 折叠头两态等高 / 箭头方向 / 轴合并成一行 / 合并行不带数字 ──
    //    全部**真鼠标**驱动（wheel / click），量布局与计算样式，不看页面自述。
    const drawerScrollProblems = ({sh, ch, st}) => {
      if (!(sh > ch)) return [];      // 内容装得下 ⇒ 这条不适用（如实记账，不假装验过）
      return st > 0 ? [] : [`面板内容超出（scrollHeight ${sh} > clientHeight ${ch}）却滚不动：scrollTop=${st}`];
    };
    const foldHeadProblems = ({collapsedH, openH}) => (Math.abs(collapsedH - openH) <= 4 ? []
      : [`折叠头收起/展开两态高度差 ${Math.abs(collapsedH - openH)}px > 4px（人类：「上面那个收起那么大」）`]);
    const arrowProblems = ({collapsedArrow, openArrow}) => {
      const norm = (v) => String(v ?? '').replace(/["']/g, '');
      const bad = [];
      if (norm(collapsedArrow) !== '▸') bad.push(`收起态箭头应为 ▸（右），实际 ${JSON.stringify(collapsedArrow)}`);
      if (norm(openArrow) !== '▾') bad.push(`展开态箭头应为 ▾（下），实际 ${JSON.stringify(openArrow)}`);
      return bad;
    };
    // 2026-09-25（前提变化的**条件式**判据，不是放宽）：四轴改成三档判定（`measured`/`assumption`/`unknown`）之后，
    // `meta-prior/v1.json` 可以带 **assumption**（7 体系各 1/7）⇒ **五轴全部可算** ⇒ `missCount` 从 1 变 **0**，合并行**不该再渲染**。
    // 所以这条判据要在**两种状态**下都成立：① 还有不可算的轴 ⇒ 合并成**至多一行**且那行**不许出现数字**；
    // ② 五轴全可算 ⇒ **不许**再渲染「算不出来」那一行。两种状态各自都可被证伪（见下面的两条反证）。
    const mergedAxisProblems = ({axisCount, availCount, missCount, missText}) => {
      const bad = [];
      if (missCount > 1) bad.push(`不可算的轴必须合并成一行（data-tw-axis="missing" 至多 1 个），实际 ${missCount} 个`);
      if (axisCount !== availCount + missCount) {
        bad.push(`轴节点数 ${axisCount} ≠ 能算 ${availCount} + 合并行 ${missCount}`);
      }
      const digits = [...new Set(String(missText ?? '').match(/\d/g) ?? [])];
      if (missCount > 0 && digits.length) bad.push(`合并那一行不许出现数字（实际出现 ${digits.join('')}）—— 那是"又给了一个数"的错觉`);
      if (missCount === 0 && String(missText ?? '').trim().length) {
        bad.push('五轴全可算时不许再渲染「算不出来」那一行（前提变了、文案必须跟上）');
      }
      return bad;
    };
    const availAxisProblems = ({availCount, availText}) => {
      if (availCount < 1) return ['至少要有 1 个能算的轴，否则这一页没有任何真值可看'];
      return /\d/.test(String(availText ?? '')) ? [] : [`能算的轴必须写出真值（含数字），实际「${availText}」`];
    };
    await mouseClick(`${ROOT_SEL} >>> #tw-eval-toggle`);
    await sleep(420);
    const evalMetrics = JSON.parse(await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)}).shadowRoot;
      const panel=sr.getElementById('tw-eval-panel');
      const axes=[...sr.querySelectorAll('.tw-axis')];
      const avail=axes.filter((a)=>a.dataset.twAvailable==='true');
      const miss=axes.filter((a)=>a.dataset.twAxis==='missing');
      // 2026-09-25：必须按 id 取。原来按 class 取 .tw-about，而页面里还有另一个
      // .tw-about（理论阵容框 #tw-analysis-box，标记里带 hidden）—— 选择器撞上它之后
      // 量到的是「隐藏元素的 0 高度」，判据 37/38 于是红得毫无意义。
      const about=sr.getElementById('tw-missing-axes-box');
      const sum=about?about.querySelector('summary'):null;
      const r=panel.getBoundingClientRect();
      return JSON.stringify({panel:{sh:panel.scrollHeight,ch:panel.clientHeight,st:panel.scrollTop,
        cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2)},
        axisCount:axes.length,availCount:avail.length,missCount:miss.length,
        availText:avail.map((a)=>(a.textContent||'').trim()).join(' | '),
        missText:miss.map((a)=>(a.textContent||'').trim()).join(' | '),
        about:{collapsedH:sum?Math.round(sum.getBoundingClientRect().height):null,
          collapsedArrow:sum?getComputedStyle(sum,'::after').content:null}});})()`));
    let wheelState = null;
    try {
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: evalMetrics.panel.cx,
        y: evalMetrics.panel.cy, deltaX: 0, deltaY: 200});
      await sleep(300);
      wheelState = JSON.parse(await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)}).shadowRoot;
        const p=sr.getElementById('tw-eval-panel');
        return JSON.stringify({st:p.scrollTop,sh:p.scrollHeight,ch:p.clientHeight});})()`));
    } catch (error) { wheelState = {error: error.message}; }
    let aboutOpenState = null;
    try {
      await mouseClick(`${ROOT_SEL} >>> #tw-missing-axes-box > summary`);
      await sleep(320);
      aboutOpenState = JSON.parse(await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)}).shadowRoot;
        const a=sr.getElementById('tw-missing-axes-box');const s=a?.querySelector('summary');
        return JSON.stringify({open:a.open,h:Math.round(s.getBoundingClientRect().height),
          arrow:getComputedStyle(s,'::after').content});})()`));
    } catch (error) { aboutOpenState = {error: error.message}; }

    // 37-「引擎规范配招」那一行必须有**四个技能名**（2026-09-27；服务端原来根本没发 skills，
    //    于是这行一直空着、换招起点是 0/4 —— 审计高 6。判据在页面上看，不在 API 层看）。
    const loadoutLine = JSON.parse(await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)}).shadowRoot;
      const rows=[...sr.querySelectorAll('.tw-loadout')];
      const texts=rows.map((el)=>String(el.textContent||'').replace(/\\s+/g,' ').trim());
      const joined=texts.join(' | ');
      return JSON.stringify({rows:texts.length,sample:texts[0]??null,
        hasCanonical:/引擎规范配招：/.test(joined),emptyHint:/引擎未给技能/.test(joined)});})()`));
    check('37-配招那一行有四个技能名', '每只已选精灵下面那行要么是你选的、要么是引擎规范配招，'
      + '**不能是空的**（空的等于换招要从零挑四个）【审计高 6】',
      loadoutLine.rows > 0 && loadoutLine.hasCanonical && !loadoutLine.emptyHint,
      `配招行 ${loadoutLine.rows} 条；示例「${loadoutLine.sample ?? '—'}」`);
    // 39-「最怕的体系」那一栏必须真的写出**体系名**（2026-09-27；§C6.303 改了取数却没看渲染结果）。
    //    服务端给 `value.label`，客户端原来读 `value.archetype_label` ⇒ 名字被丢、只剩分数。
    //    这一条**读那一格的正文**，不是"整页不炸"；反证喂一段"名字被丢"的样本给同一条判据。
    const archetypeCell = JSON.parse(await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)}).shadowRoot;
      const boxes=[...sr.querySelectorAll('[data-tw-axis], .tw-axis, .tw-axis-row')];
      const hit=boxes.map((el)=>String(el.textContent||'').replace(/\\s+/g,' ').trim())
        .find((t)=>t.includes('最怕的体系'));
      return JSON.stringify({found:Boolean(hit),text:(hit??'').slice(0,160)});})()`));
    // 判据只依赖正文（纯函数）：有名字 + 有占比说法
    //
    // ⚠ 2026-09-29 改钉（task-14；`f30126a` 是按 P0-04 改的文案，判据没跟着改，于是 39 号连红）：
    // 旧断言（**留档**）：
    //   if (!/大约每 \d+ 局遇到 1 次|环境里占多少没有数据/.test(body)) bad.push('没有说这类体系在环境里占多少');
    // 它当时认的是「大约每 N 局遇到 1 次」——而 `f30126a` 正是把那种说法**当成伪观测频率**改掉的：
    // 现在写的是「赛前假设这类占 14%（各体系等权）——这是假设的权重，不是实测出场率」。
    // 所以这一条**改钉不删、而且把旧文案反过来**：旧说法（"大约每 N 局遇到 1 次"）现在**要判红**，
    //  因为它把**假设的**权重说成了观测频率（那正是 P0-04 点名的那件事）。
    // 新口径两条都要：
    //   ① 有占比说法：要么给出「这类占 X%」并**交代来源**（假设的权重 / 各体系等权 / 不是实测），
    //      要么如实写「环境里占多少没有数据」；
    //   ② 不许退回旧说法。
    const OLD_FREQUENCY_CLAIM = /大约每 \d+ 局遇到 1 次/;
    const archetypeProblems = (text) => {
      const body = String(text ?? '');
      const bad = [];
      if (!/撞上「[^」]+」这类/.test(body)) bad.push('没有写出体系名（只剩含糊说法或分数）');
      if (OLD_FREQUENCY_CLAIM.test(body)) {
        bad.push('把**假设的**权重说成了观测频率（「大约每 N 局遇到 1 次」）—— P0-04 明确不许');
      }
      const shareWithSource = /这类占\s*\d+(?:\.\d+)?\s*%/.test(body)
        && SOURCED_ASSUMPTION_PHRASES.some((phrase) => body.includes(phrase));
      const honestUnknown = /环境里占多少没有数据/.test(body);
      if (!shareWithSource && !honestUnknown) {
        bad.push('没有说这类体系在环境里占多少（要给「这类占 X%」并交代来源，或如实说没有数据）');
      }
      return bad;
    };
    const archetypeBad = archetypeProblems(archetypeCell.text);
    check('39-「最怕的体系」写出体系名', '这一栏要有**名字**（「撞上「X」这类」）而不是只剩分数或含糊的「某类体系」；'
      + '占比要么给「这类占 X%」并**交代来源**（假设的权重 / 各体系等权 / 不是实测），要么如实说没有数据；'
      + '**不许**把假设的权重说成观测频率【§C6.303 改了取数没验渲染；2026-09-29 task-14 改钉】',
      archetypeCell.found && archetypeBad.length === 0,
      `命中=${archetypeCell.found} 示例「${archetypeCell.text}」${archetypeBad.length ? ' · ' + archetypeBad.join('；') : ''}`);
    counter('39-「最怕的体系」写出体系名', '喂**旧文案**（「大约每 5 局遇到 1 次」）给同一条判据必须红 —— 证明它不是"什么都认"',
      archetypeProblems('撞上某类体系时最吃亏（这类在环境里大约每 5 局遇到 1 次）'),
      '样本：撞上某类体系时…（旧文案：假设的权重说成观测频率）');
    control('39-反向控制：新文案不许被判红',
      '「撞上「X」这类最吃亏（赛前假设这类占 14%（各体系等权）——这是假设的权重，不是实测出场率）」'
      + '与如实说「环境里占多少没有数据」两种写法都**不许**红（判据不许挑字眼）',
      {problemsOf: archetypeProblems,
        samples: [
          '最怕的体系 撞上「翼王飞翼」这类最吃亏（赛前假设这类占 14%（各体系等权）——这是假设的权重，不是实测出场率）',
          '最怕的体系 撞上「翼王飞翼」这类最吃亏（环境里占多少没有数据）',
        ],
        // 该红的三种（**一条都不许因为改钉被放过**）：
        //   ① 旧文案（假设的权重说成观测频率）+ 没名字 ② 有名字但占比**没交代来源** ③ 只有名字、没有占比
        mustHit: [
          '撞上某类体系时最吃亏（这类在环境里大约每 5 局遇到 1 次）',
          '撞上「翼王飞翼」这类最吃亏（这类占 14%）',
          '撞上「翼王飞翼」这类最吃亏（原始数值 0.583333 · 相对分）',
        ]},
      '样本：新文案（带来源） / 如实说没有数据');

    const scrollProblems = wheelState ? drawerScrollProblems({...evalMetrics.panel, st: wheelState.st}) : ['滚轮取样失败'];
    check('36-评估抽屉滚得动', '评估抽屉内容超出面板高度时必须**滚得动**（真滚轮 → scrollTop > 0）'
      + '【人类 2026-09-25：「这个阵容评估也是显示不完，下滑不了」】',
      scrollProblems.length === 0,
      `scrollHeight=${evalMetrics.panel.sh} clientHeight=${evalMetrics.panel.ch} `
      + `（需要滚=${evalMetrics.panel.sh > evalMetrics.panel.ch}）；滚轮后 scrollTop=${wheelState?.st ?? '—'}`);
    counter('36-评估抽屉滚得动', '「内容超出却滚不动」的形态喂同一条判据必须报',
      drawerScrollProblems({sh: 900, ch: 400, st: 0}), '{sh:900,ch:400,st:0}');

    // ── 前提变了 ⇒ **条件式判据**（2026-09-25，不是放宽）──────────────────────────
    // 这个折叠头（`#tw-missing-axes-box`）只在**有算不出来的轴**时才渲染。
    // 四轴改成三档判定之后五轴全部可算（`missCount` 从 1 变 0）⇒ 那一行整块不渲染 ⇒
    // 折叠头根本不存在。原来那两条判据无条件去点它，于是红得毫无意义
    //（而且旧选择器按 class 取，撞上了另一个 hidden 的 `.tw-about`，量到 0 高度）。
    // 现在：**在**就按原口径判；**不在**则要求"确实没有算不出来的轴"，否则才是真红。
    const foldPresent = Number.isFinite(evalMetrics.about.collapsedH) && evalMetrics.about.collapsedH > 0;
    const foldAbsentReason = foldPresent ? null
      : (evalMetrics.missCount === 0
        ? '前提不成立：五轴全部可算 ⇒「还有 N 个口径算不出来」那一行不渲染（如实记账，不假装验过）'
        : `有 ${evalMetrics.missCount} 个轴算不出来，那一行/折叠头却不存在 —— 这是真红`);
    const foldProblems = foldPresent
      ? foldHeadProblems({collapsedH: evalMetrics.about.collapsedH, openH: aboutOpenState?.h ?? 0})
      : (foldAbsentReason && evalMetrics.missCount !== 0 ? [foldAbsentReason] : []);
    check('37-折叠头两态等高', '「看是哪几个 / 为什么」的折叠头在收起/展开两态高度差 ≤ 4px'
      + '（前提：存在算不出来的轴）【人类 2026-09-25：「上面那个收起那么大」】',
      foldProblems.length === 0,
      foldPresent ? `收起 ${evalMetrics.about.collapsedH}px / 展开 ${aboutOpenState?.h ?? '—'}px` : foldAbsentReason);
    counter('37-折叠头两态等高', '展开态加回 padding-top:9px 的形态必须报',
      foldHeadProblems({collapsedH: 44, openH: 73}), '{collapsedH:44,openH:73}');

    const arrowProbs = foldPresent
      ? arrowProblems({collapsedArrow: evalMetrics.about.collapsedArrow, openArrow: aboutOpenState?.arrow})
      : (foldAbsentReason && evalMetrics.missCount !== 0 ? [foldAbsentReason] : []);
    check('38-折叠箭头方向', '折叠箭头遵守惯例：收起 ▸（右）/ 展开 ▾（下）（前提：存在算不出来的轴）'
      + '【人类 2026-09-25：「箭头还是反的」】',
      arrowProbs.length === 0, arrowProbs.join(' | ')
      || (foldPresent
        ? `收起 ${JSON.stringify(evalMetrics.about.collapsedArrow)} / 展开 ${JSON.stringify(aboutOpenState?.arrow)}`
        : foldAbsentReason));
    counter('38-折叠箭头方向', '把两个态的箭头对调必须报',
      arrowProblems({collapsedArrow: '"▾"', openArrow: '"▴"'}), '收起 ▾ / 展开 ▴');

    const mergedProbs = mergedAxisProblems(evalMetrics);
    check('39-不可算的轴合并成一行', '算不出来的轴在页面上**只占一行**（旧的逐轴平铺必须消失），且那一行不出现任何数字',
      mergedProbs.length === 0, mergedProbs.join(' | ')
      || `轴节点 ${evalMetrics.axisCount} = 能算 ${evalMetrics.availCount} + 合并 ${evalMetrics.missCount}；合并行原文「${evalMetrics.missText.slice(0, 120)}」`);
    counter('39-不可算的轴合并成一行', '恢复逐轴平铺（四个独立行 + 行里带数字）必须报',
      mergedAxisProblems({axisCount: 5, availCount: 1, missCount: 4, missText: '环境价值：现在算不出来 0.00'}), '{axisCount:5,availCount:1,missCount:4,missText:"…0.00"}');
    // 2026-09-25 新增的**状态反证**：前提变了但文案没跟上（五轴全可算、却还挂着「算不出来」那一行）必须报。
    // 没有这一条，「条件式」就退化成了"两种状态都不查"。
    counter('39-不可算的轴合并成一行', '五轴全可算却仍渲染「算不出来」那一行（前提变了文案没跟上）必须报',
      mergedAxisProblems({axisCount: 5, availCount: 5, missCount: 0, missText: '还有四个口径现在算不出来'}),
      '{axisCount:5,availCount:5,missCount:0,missText:"还有四个口径现在算不出来"}');

    const availProbs = availAxisProblems(evalMetrics);
    check('40-能算的轴给真值', '能算的轴必须写出真值（含数字），且不可算的那些一个数字都不许给',
      availProbs.length === 0 && mergedProbs.length === 0,
      availProbs.join(' | ') || `能算 ${evalMetrics.availCount} 个：「${evalMetrics.availText.slice(0, 120)}」`);
    counter('40-能算的轴给真值', '把能算的轴换成空话（无数字）必须报',
      availAxisProblems({availCount: 1, availText: '现在能算'}), '{availCount:1,availText:"现在能算"}');

    // ② 同名不同物种必须看得出区别（人类：「这个什么陛下有啥区别？我根本看不出来啊」）
    //    ⚠ 2026-09-28 **改钉（第二次）**：两条都动了 ——
    //    ① 样例：旧写法写死搜「棋契」—— 那两只是 own-0042/pet_000556 与 own-0043/pet_000575，
    //       本轮人类 2026-09-28 拍板「所有精灵实装」后已按人类的剔除决定撤下
    //       （`layer-playable-48/pets.json` 的 `excluded_capture_ids` 4086「图鉴同名 8 条形态，
    //       本来就认不出是哪一条」）⇒ 搜「棋契」0 行。改成从当前数据**现算**样例
    //       （main() 顶上的 `sameNameGroups`：同名不同物种 + 两只都在我盒子里）。
    //    ② 第三条要求：「两行的**定位**不止一种」→「两行各带一个能区分它们的**信号**，且两个信号不同」
    //       （信号按「定位优先、其次形态名」取）。
    //       为什么改：旧样例（棋契陛下 own-0042/pet_000556 输出 vs own-0043/pet_000575 坦克）
    //       天生一输出一坦克；而当前数据里的同名对（如「千棘盔」pet_000271 / pet_000378）
    //       是 role 未登记的那一档物种，两边都写「定位未登记」
    //       ⇒ 「定位不止一种」在现在的数据上**不可能满足**，红的原因不是页面没做。
    //       玩家真正能分辨那一对的**唯一可见信号是形态名**（`title`：全量图鉴里
    //       「同名 + 同编号 + 只有形态名不同」的登记有 55 组 / 154 条），
    //       而产品侧 2026-09-28 已把「我的盒子」那张卡的 `name` 改成形态名优先
    //       （`src/server/roco-service.js`：`name: e?.title ?? i.species_name ?? e?.name`）
    //       ⇒ 两行现在文本不同、定位也可能带得出来。
    //       **口径没放松**：文本逐字相同 ⇒ 红；两行都拿不出任何区分信号 ⇒ 红（见下面两条反证）。
    //    ⚠ 2026-09-27 **改钉**：原来这条要求"要能同时看到 **Lv50 与 Lv80**" —— 那是拿**掷出来的
    //    Demo 等级**当区别手段。当晚等级口径改成「默认都 60 级」（人类拍板 + 官方上限 60）
    //    ⇒ 所有个体都是 Lv60，**等级不再是可用维度**（但**必须显示出来**，同值也算）。
    // ⚠ 2026-09-28 实测：之前这里**自己抄了一份角色词表**且抄错了 —— 写的是「恢复」，
    //   而产品（`BOX_ROLE_LABELS.recovery`）给的是「回复」。后果：定位那颗牙从来没咬到过东西
    //   （读到的永远 null），却因为"少匹配一个词"而看不出是判据自己的错。
    //   现在直接取产品那一份（`BOX_ROLE_LABELS` 的 values），口径同源。
    const ROLE_WORDS = Object.values(BOX_ROLE_LABELS);
    /** 卡上的「形态名」：名字里那对括号标注（「千棘盔（磨损的样子）」→「磨损的样子」）。 */
    const formSignalOf = (lineText) => {
      const m = /（([^）]{1,30})）/.exec(String(lineText));
      return m ? m[1] : null;
    };
    /**
     * 一行文本切出「信号」：
     *   · `roleSignal` —— 「定位」那栏的原文（能取到角色词才给；「定位未登记」不算）；
     *   · `formSignal` —— 形态名（见上）；
     *   · `hasRoleSlot`/`hasFormSlot` —— 这一行**结构里**有没有这两栏/括号
     *     （用来把"页面根本没画定位那栏"和"画了但那只是占位文案"分开）。
     * 区分信号本身由 `signalOf()` 算：定位优先，其次形态名；两个都没有 ⇒ null（**不编**）。
     */
    const splitSignals = (lineText) => {
      const text = String(lineText ?? '');
      // 定位只认「·」分出来的**那一小段**（实测形如
      // 「千棘盔 水系毒系 Lv60 · 回复 持有 · 可正式上场 在你的盒子里」：定位在第二段）。
      // 这样写是为了避免名字/系别/状态标里恰好含角色词时误判。
      const segments = text.split('·').map((part) => part.trim());
      const role = ROLE_WORDS.filter((word) => segments.some((part) => part.includes(word)));
      return {
        roleSignal: role.length === 1 ? role[0] : (role.length > 1 ? `多个角色词(${role.join('/')})` : null),
        formSignal: formSignalOf(text),
        hasRoleSlot: segments.length >= 2,
        hasFormSlot: /（[^）]{1,30}）/.test(text),
      };
    };
    /** 由 `splitSignals()` 的结果合成区分信号（定位优先、其次形态名；两个都有就都带上）。 */
    const signalOfFromParts = (parts) => {
      const picked = [parts?.roleSignal, parts?.formSignal].filter(Boolean);
      return picked.length ? picked.join('+') : null;
    };
    /** 一行的**区分信号**：按「定位优先，其次形态名」取 —— 两个都取到时合成
     *  `"定位+形态"`（同定位的两行照样能靠形态名分开，这正是「千棘盔」那一对的形状）。
     *  两个都没有 ⇒ null（**不编**）。 */
    const signalOf = (lineText) => signalOfFromParts(splitSignals(lineText));
    const sameNameProblems = (texts) => {
      const bad = [];
      if (texts.length < 2) return [`同名不同物种的两行没同时出现（只有 ${texts.length} 行）—— 判据不许变空`];
      if (new Set(texts).size !== texts.length) bad.push(`同名两行的可见文本完全相同：「${texts[0]}」`);
      // ⚠ 2026-09-29 改钉（人类报的 A3：「pvp选精灵看不到等级？」）：等级写法从 `Lv60` 统一成 **`Lv.60`**
      // —— 与**盒子页**卡片上一直用的 `Lv.60` 一致（同一份数据在两个页面上不该有两种写法）。
      // 所以正则从 `/Lv\d+/` 放宽成 `/Lv\.?\d+/`：**点可有可无**，但「Lv + 数字」这条**意图一字未变**
      // （每一行都必须带出自己的等级读数）。
      // 旧断言留档：if (!texts.every((t) => /Lv\d+/.test(t))) { … }
      if (!texts.every((t) => /Lv\.?\d+/.test(t))) {
        bad.push(`每行都要带自己的等级读数：${JSON.stringify(texts)}`);
      }
      // ⚠ 2026-09-28 改钉（旧断言原文：「两行要各自带出定位、且不止一种（看到的定位：…）」——
      //   旧口径只认「定位」这一种信号）。新口径：**区分信号不同**（定位优先、其次形态名；
      //   两个都取到时合成"定位+形态"，所以同定位的两行也能靠形态名分开）。
      const parts = texts.map((t) => splitSignals(t));
      const signals = parts.map((p) => signalOfFromParts(p));
      // 「没有信号」要分清两种形状（两者的修法完全不同，不能混成一句）：
      //   ① 页面**根本没画**定位那栏、名字里也没形态标注 ⇒ 版式缺了一块；
      //   ② 栏目都在，但那一行写的是「定位未登记」这种占位 ⇒ 是数据没登记（不该判页面红）。
      const missing = parts.filter((p) => !signalOfFromParts(p));
      if (missing.length > 0) {
        const noSlot = missing.filter((p) => !p.hasRoleSlot && !p.hasFormSlot).length;
        if (noSlot > 0) {
          bad.push(`有 ${noSlot} 行既没有定位栏、也没有形态名标注（版式里那两块都缺）：${JSON.stringify(texts)}`);
        }
        if (missing.length - noSlot > 0) {
          bad.push(`有 ${missing.length - noSlot} 行的定位/形态名都没登记（栏位在、内容是占位文案）`
            + `：${JSON.stringify(texts)} —— 这一对在当前数据里分不出来（判红如实说，不是"页面没做"）`);
        }
      }
      if (new Set(signals.filter(Boolean)).size < 2) {
        bad.push(`两行的区分信号不是两种（定位优先、其次形态名；读到 ${JSON.stringify(signals)}）：`
          + `${JSON.stringify(texts)}`);
      }
      return bad;
    };
    const searchSameName = async (name) => {
      await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)}).shadowRoot;
        const i=sr.getElementById('tw-search');i.value=${JSON.stringify(name)};
        i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
      await sleep(1500);
      return JSON.parse(await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)}).shadowRoot;
        return JSON.stringify([...sr.querySelectorAll('#tw-cand-list .tw-row')]
          .map((r)=>(r.textContent||'').replace(/\\s+/g,' ').trim()));})()`));
    };
    let sameNameTexts = [];
    let sameNameUsed = null;
    try {
      // ⚠ 必须先在**「我的精灵」档**量：全图鉴档的同名条目自带分支后缀
      // （实测「棋契陛下（白棋棋骑士分支）」等 4 条 / 「小星光（星光能量的样子）」），
      // 看着能区分；人类截图那一屏是「我的精灵」档 —— **没有**分支后缀，那才是"看不出来"的真实场景。
      await mouseClick(`${ROOT_SEL} >>> #tw-scope-mine`);
      await sleep(900);
      // 先试现算出来的那一对；它万一搜不出两行，就按数据顺序再试别的同名组
      // （都是同一条判据在量，只是换个同名样例；一组都搜不出两行 ⇒ 判据自己红）。
      for (const candidate of sameNameGroups.slice(0, 4)) {
        if (!candidate) continue;
        const texts = await searchSameName(candidate.name);
        sameNameCandidatesTried.push({name: candidate.name, rows: texts.length});
        if (!sameNameUsed || texts.length > sameNameTexts.length) {
          sameNameUsed = candidate; sameNameTexts = texts;
        }
        if (texts.length >= 2) break;
      }
    } catch (error) { sameNameTexts = []; }
    const sameNameProbs = sameNameProblems(sameNameTexts);
    check('41-同名不同种看得出区别', '候选池里同名不同物种的两行：① 可见文本必须不同；'
      + '② 各带自己的等级读数；③ 各带一个**能区分它们的信号、且两个信号不同**'
      + '（信号按「定位优先、其次形态名」取）'
      + '【人类 2026-09-25：「这个什么陛下有啥区别？我根本看不出来啊」】'
      + '【2026-09-28 改钉①：样例从当前数据现算（同名不同物种 + 两只都在我盒子里），'
      + '旧样例「棋契陛下」已按人类剔除决定撤下（`excluded_capture_ids` 4086）】'
      + '【2026-09-28 改钉②：旧口径是「两行的**定位**不止一种」（旧样例一输出一坦克）；'
      + '当前同名对（如「千棘盔」pet_000271 / pet_000378）是 role 未登记的物种、两边都写'
      + '「定位未登记」⇒ 定位这一条在现在的数据上不可能满足，而玩家真正能分辨那对的信号是'
      + '**形态名**（`title`）。产品侧 2026-09-28 已把「我的盒子」卡名改成形态名优先，'
      + '所以改成「区分信号不同（定位优先、其次形态名）」——文本逐字相同、或两行都拿不出信号仍然必红】',
      sameNameProbs.length === 0,
      sameNameProbs.join(' | ')
      || `样例「${sameNameUsed?.name}」（${(sameNameUsed?.ids ?? []).join(' / ')}）两行：${JSON.stringify(sameNameTexts)}`
        + `；读到信号 ${JSON.stringify(sameNameTexts.map((t) => signalOf(t)))}`
        + `；试过的同名组 ${JSON.stringify(sameNameCandidatesTried)}`);
    counter('41-同名不同种看得出区别', '把两行还原成只画名字+属性（投诉当时的样子：两行逐字相同）必须报',
      sameNameProblems(['千棘盔 水系毒系 持有 · 可正式上场 在你的盒子里',
        '千棘盔 水系毒系 持有 · 可正式上场 在你的盒子里']), '两行逐字相同');
    // 第二条反证（2026-09-27 那颗老牙，口径升级后仍然要咬得住）：
    // 两行只有等级、谁也拿不出区分信号（定位未登记 + 没有形态名）必须报。
    counter('41-同名不同种看得出区别', '两行只有等级、两行都拿不出区分信号（定位未登记且无形态名）必须报',
      sameNameProblems(['千棘盔 水系毒系 Lv60 · 定位未登记 持有 · 可正式上场 在你的盒子里',
        '千棘盔 水系毒系 Lv60 · 定位未登记 持有 · 可正式上场 在你的盒子里']), '定位未登记 + 无形态名');
    // 第三条反证（2026-09-28 新增：专打"形态名不算信号"那种放宽写法）：
    // 两行**只有一行**带形态名、另一行没有 ⇒ 仍然报（"两个信号不同"没被满足）。
    counter('41-同名不同种看得出区别', '只有一行带形态名、另一行什么信号都没有必须报',
      sameNameProblems(['千棘盔 水系毒系 Lv60 · 定位未登记 持有 · 可正式上场 在你的盒子里',
        '千棘盔（磨损的样子） 水系毒系 Lv60 · 定位未登记 持有 · 可正式上场 在你的盒子里']),
      '只有一行有形态名');
    // 第四条反证（2026-09-28 新增）：同名组**一只都没有**（样例撤下/数据换代）时必须报 ——
    // 这正是本轮判据变红的那种形状，不许再靠"换个名字接着搜"悄悄绕过。
    counter('41-同名不同种看得出区别', '当前数据里一对同名不同物种都找不到（搜不到任何行）必须报',
      sameNameProblems([]), '同名组 0 行');
    // 搜索框还原，别影响后面的截图
    await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)}).shadowRoot;
      const i=sr.getElementById('tw-search');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await sleep(900);

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
    // ⚠ 2026-09-29（task-14）：这一条与 22 号走**同一个豁免出口**（`exemptAllSourced`）——
    // 原来这里只用机制原文那一份，于是「交代了来源的假设值」被当成伪精确（22/23 连红）。
    const pseudoNow = exemptAllSourced(playerNow, {sourcedLines}).text.match(PSEUDO_PRECISION);
    check('23-无胜率与百分数', '可见文本里不出现「数字 + %」或「胜率/概率 + 数字」这种伪精确说法'
      + '（可核对的冻结机制原文、以及**交代了来源**的假设值除外）',
      pseudoNow === null, pseudoNow ? `命中「${pseudoNow[0]}」`
        : `扫过 ${playerNow.length} 字无命中（豁免机制原文 ${sourcedLines.length} 条、假设值 ${sourcedAssumptionLines(playerNow).length} 条）`);
    counter('23-无胜率与百分数', '把「胜率 58%」写进可见文本必须被同一条判据抓住',
      playerCopyProblems('这套阵容胜率 58%'), '「这套阵容胜率 58%」');
    counter('23-无胜率与百分数（假机制绕过）', '把「胜率 62%」塞进 mechanism.line（核不回产物）必须照样被抓住',
      playerCopyProblems('（机制原文）胜率 62%', {sourcedLines: sourcedMechanismLines({next_candidates: [{mechanism: {line: '胜率 62%'}}]})}),
      '{"next_candidates":[{"mechanism":{"line":"胜率 62%"}}]}');
    // ⚠ 2026-09-29 **新增（反向控制，task-14 要求"交代了来源的 ⇒ 必须不红"）**：
    // 豁免那一套最容易变成空转 —— 上面几条证明"没来源的会红"，这一条证明"有来源的不会误红"。
    control('23-反向控制：交代了来源的假设值不许被判成伪精确',
      '同一句话里有数字+%、有来源短语（各体系等权 / 这是假设的权重 / 不是实测出场率）⇒ 不许红；'
      + '而挂上「假设」两个字的**胜率**仍然要红（禁语优先）',
      {
        // ⚠ 样本都补一句「未知」——`playerCopyProblems` 还管"必须有未知说明"，
        // 不补的话这一条会因为**另一个维度**红，就测不到伪精确这一件事了。
        samples: ['撞上「翼王飞翼」这类最吃亏（赛前假设这类占 14%（各体系等权）——这是假设的权重，不是实测出场率）。（未知项另有说明）'],
        mustHit: ['这套阵容胜率 58%（这是假设的权重）。（未知项另有说明）'],
      },
      '样本：占 14%…各体系等权（应空） / 胜率 58%（这是假设的权重）（应命中）');
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
        // 判据红了要能一眼看出**是哪一个**元素：把父链（带 id/class）与一小段文本带上。
        const chain=(()=>{const parts=[];let n=el;while(n){parts.push(n.tagName
          +(n.id?'#'+n.id:'')+(n.className?'.'+String(n.className).trim().split(/\\s+/).join('.'):''));
          n=n.parentNode??n.host??null;if(parts.length>4)break;}return parts.join('<');})();
        out.push({tag:el.tagName,cls:String(el.className||'').slice(0,26),
          w:Math.round(r.width),h:Math.round(r.height),path:chain,
          text:String(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,16)});}
      // 容器读数：窄屏下「0 宽」的小元素到底是自己塌了，还是**父容器**没宽度。
      const box=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();
        return {w:Math.round(r.width),h:Math.round(r.height)};};
      const slots=sr?sr.getElementById('tw-slots'):null;
      const firstSlot=sr?sr.querySelector('#tw-slots .tw-slot'):null;
      const firstDetail=sr?sr.querySelector('#tw-slots .tw-slot .tw-detail'):null;
      return JSON.stringify({count:out.length,small:out.filter((x)=>x.w<44||x.h<44),
        boxes:{slots:box(slots),slot:box(firstSlot),detail:box(firstDetail),
          team:box(sr?sr.querySelector('.tw-panel.tw-team'):null)}});})()`));
    const touchProblems = touchTargetProblems(targets.small);
    check('30-触控目标', '390×844：模块里每个可见可点元素（按钮 / summary / 输入框）都 ≥44×44',
      touchProblems.length === 0,
      touchProblems.join(' | ') || `量了 ${targets.count} 个元素，全部达标`);
    if (touchProblems.length) log('[30 诊断] 容器框：', JSON.stringify(targets.boxes));
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
    // 「当前评估」在 2026-09-23 版式里改成**左侧悬浮抽屉**（`#tw-eval-drawer` + `#tw-eval-toggle`），
    // 不再占常规流的格子。口径不放松：抽屉必须存在、**真鼠标**点得开、打开后那一块真的可见且有内容。
    const evalDrawerState = async () => JSON.parse(await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?.shadowRoot??null;
      const drawer=sr?sr.getElementById('tw-eval-drawer'):null;
      const toggle=sr?sr.getElementById('tw-eval-toggle'):null;
      const panel=sr?sr.getElementById('tw-eval-panel'):null;
      const body=sr?sr.getElementById('tw-eval-body'):null;
      const box=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();
        return {w:Math.round(r.width),h:Math.round(r.height)};};
      return JSON.stringify({found:Boolean(drawer&&toggle&&body&&panel),
        open:drawer?(drawer.dataset.open??null):null,
        panelBox:box(panel),panelVisible:Boolean(panel)&&panel.getBoundingClientRect().width>0
          &&panel.getBoundingClientRect().height>0,
        bodyLen:body?(body.innerHTML||'').length:0,toggleBox:box(toggle)});})()`));
    const evalBefore = await evalDrawerState();
    let evalAfter = evalBefore;
    let evalToggleError = null;
    if (evalBefore.found) {
      try {
        await mouseClick(`${ROOT_SEL} >>> #tw-eval-toggle`);
        await sleep(420);
        evalAfter = await evalDrawerState();
        await mouseClick(`${ROOT_SEL} >>> #tw-eval-toggle`);   // 收回去，别影响后面的截图
        await sleep(320);
      } catch (error) { evalToggleError = error.message; }
    }
    const evalReachable = evalBefore.found && evalBefore.bodyLen > 0
      && evalAfter.open === 'yes' && evalAfter.panelVisible === true;
    check('31-移动端顺序', '390×844：常规流里的区块顺序固定为「队伍槽位 → 候选池」'
      + '（→ 若「当前评估」「小芽短提示」还在流里，必须依次排在后面）；'
      + '「当前评估」改由左侧悬浮抽屉承担（真鼠标点 `#tw-eval-toggle` 能打开、面板可见且有内容）。'
      + '【2026-09-23 版式演变：`.tw-coach`（✦ 小芽 · 阵容阶段）按人类批注删除；`.tw-eval` 由人类要求'
      + '改成 `#tw-eval-drawer` 固定抽屉（不在常规流）。「当前评估」这条口径由抽屉可达性这条等价断言守】',
      orderProblems.length === 0 && evalReachable && evalToggleError === null,
      (orderProblems.join(' | ')
        || `顺序=${JSON.stringify(order.order)} 顶部位置=${JSON.stringify(order.tops)}`)
      + `；阵容评估抽屉：存在=${evalBefore.found} 内容 ${evalBefore.bodyLen} 字节，`
      + `点开后 data-open=${JSON.stringify(evalAfter.open)} 面板可见=${evalAfter.panelVisible} `
      + `面板尺寸=${JSON.stringify(evalAfter.panelBox)} 切换按钮=${JSON.stringify(evalBefore.toggleBox)}`
      + `${evalToggleError ? `（点不动：${evalToggleError}）` : ''}`);
    counter('31-移动端顺序', '把顺序改成「评估在候选池前面」必须被同一条判据抓住',
      mobileOrderProblems(['tw-team', 'tw-eval', 'tw-cand', 'tw-coach'],
        [{cls: 'tw-team', top: 0}, {cls: 'tw-eval', top: 100}, {cls: 'tw-cand', top: 200}, {cls: 'tw-coach', top: 300}]),
      'order=[tw-team,tw-eval,tw-cand,tw-coach]');
    shots.push(await shootModule('workshop-05-six-selected-390x844'));

    // 窄屏再走一遍：清空 → 选两只，量一次 2～5 只的形态
    await mouseClick(`${ROOT_SEL} >>> #tw-reset`);
    await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0')===0`);
    await sleep(360);
    // 2026-09-25（A/B 定位后的**加严**，不是放宽）：先断言候选区**当时真的看得见**。
    // 原先这条在「候选列表被挤成 0px（零面积滚动框不参与命中测试）」时报的是"点击落空"，
    // 定位成本很高（实测 390×844 下面板 289px、头部+档位+筛选+翻页吃满 284px）。
    const candBox = JSON.parse(await js(`(()=>{const host=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=host?.shadowRoot??null;const list=sr?.querySelector('#tw-cand-list')??null;
      const row=list?.querySelector('.tw-row')??null;
      return JSON.stringify({clientH:list?list.clientHeight:null,scrollH:list?list.scrollHeight:null,
        geoH:list?Math.round(list.getBoundingClientRect().height):null,
        rowH:row?Math.round(row.getBoundingClientRect().height):null});})()`));
    check('31b-窄屏候选区有可见高度', '390×844：候选列表必须至少露出一整行（0 高度 = 玩家真的点不到）',
      Number(candBox.clientH) >= 44 && Number(candBox.rowH) >= 44,
      `列表可见高 clientH=${candBox.clientH} 几何高=${candBox.geoH} scrollH=${candBox.scrollH} 行高=${candBox.rowH}`);
    const narrowAdds = [];
    for (const name of pickNames.slice(0, 2)) narrowAdds.push({name, ...(await addByName(name))});
    const narrowTwo = await facts();
    const narrowDom = await domFacts();
    const narrowMetrics = await metrics();
    steps.push({at: 'narrow-two', facts: narrowTwo, dom: narrowDom, metrics: narrowMetrics, adds: narrowAdds});
    screens.push({viewport: '390x844', at: 'two-selected', ...narrowMetrics});
    check('32-窄屏候选区', '390×844：选到第 2 只后仍然不横向溢出，三个候选与缺口清单都在',
      narrowMetrics.scrollW === narrowMetrics.clientW && Number(narrowTwo.next) === 3 && narrowDom.gapNodes >= 1,
      `clientW=${narrowMetrics.clientW} scrollW=${narrowMetrics.scrollW} selected=${narrowTwo.selected} `
      + `next=${narrowTwo.next} 缺口=${narrowDom.gapNodes}；加人过程=${JSON.stringify(narrowAdds)}`);
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
    // 2026-09-23（v3h）：魔力读数在**换宠屏**的底栏聚能位（`body[data-b3-charge]='mana'` +
    // `[data-b3-charge-value]` =「♥ n / pool」）。旧读取点 `#self-resource` / `#foe-resource`
    // 已被收进 `#b3-sink[hidden]`（`getBoundingClientRect` 全 0，玩家看不到）——
    // 所以先**真鼠标**切到「更换」，再读那一处。
    const switchTab = await mouseClick('.b3-wrap [data-b3-tab="switch"]');
    await sleep(420);
    const battleFacts = JSON.parse(await js(`(()=>{const b=document.body.dataset;
      const charge=document.getElementById('b3-charge');
      const chargeVal=document.querySelector('[data-b3-charge-value]');
      const note=document.getElementById('unverified-note'), panel=document.getElementById('battle-panel');
      const v=window.rocoDemo.state.view;
      const manaOf=(t)=>{const m=/(\\d+)/.exec(String(t||''));return m?Number(m[1]):null;};
      return JSON.stringify({mode:b.rocoMode??null,standardPvp:b.rocoStandardPvp??null,
        groups:b.rocoActionGroups??null,hidden:b.rocoActionsHidden??null,
        selfText:charge?(charge.textContent||'').replace(/\\s+/g,' ').trim():null,
        foeText:'',
        selfMana:manaOf(chargeVal?chargeVal.textContent:''),
        engineSelfMana:Number.isFinite(v&&v.mana&&v.mana.self)?v.mana.self:null,
        foeMana:Number.isFinite(v&&v.mana&&v.mana.opponent)?v.mana.opponent:null,
        chargeState:b.b3Charge??null,
        noteHidden:note?note.hidden:null,noteText:note?note.textContent.trim():null,
        battleVisible:Boolean(panel)&&!panel.hidden});})()`));
    const battleProblems = sixPetBattleProblems(battleFacts);
    // 开局失败时页面会把服务端原文写进 `#plan-status`——把它带进断言信息里（报错原文就是证据）。
    const planStatus = await js(`document.getElementById('plan-status')?.textContent ?? null`);
    check('35-标准 PVP 战斗页', '按 v3 候选规则开局：魔力来自引擎（4/4，写在换宠屏的底栏聚能位上）、'
      + '无物品/逃跑、未核验假设如实标出。'
      + '【按人类 2026-09-23 版式，旧读取点 `#self-resource`/`#foe-resource`（已收进 `#b3-sink[hidden]`）由 '
      + '换宠屏的 `#b3-charge` / `[data-b3-charge-value]`（mana 态「♥ n / pool」）承担】',
      battleProblems.length === 0 && battleStarted,
      (battleProblems.join(' | ') || `mode=${battleFacts.mode} mana=${battleFacts.selfMana}/${battleFacts.foeMana} `
        + `（换宠屏聚能「${battleFacts.selfText}」，切屏命中 ${switchTab?.top?.path ?? '—'}）`
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

    // ── ⑬ RC-503：候选规则下的 Coach 取舍（真鼠标打开小芽 → 要一份建议）──────────
    // 这一条量的是**教练层在 v3 候选规则下**给不给那四样，以及建议是不是引擎真给的动作。
    //
    // 2026-09-23（人类改版）：小芽是**弹出式二级窗口**；旧的 `#xy-settings` 折叠与
    // 「让小芽看一眼」（`#plan`）/「让双方各走一步」（`#auto-turn`）**都被删掉了**。
    // 等价替换（读取点 `#hint-body` 与断言口径一字未变）：
    //   · 真鼠标点 `#coach-entry` → 打开小芽弹窗，并顺带读面板里的模型状态
    //     （原 `#xy-settings` 折叠里的那一排由面板第一排 `#model-list` 承担）；
    //   · 「要一份建议」走页面自己暴露的**同一条路径**
    //     `window.rocoDemo.requestPlan({reason:'manual',explicit:true})`（`roco.js` 里 `#plan` 的 click 监听）；
    //   · 读完关掉弹窗（`#close-companion`），免得盖住 `#hint` 浮条。
    const coachEntryClick = await mouseClick('#coach-entry');
    await sleep(420);
    const coachPanelOpened = await openCoachPanel();
    const coachPanel = JSON.parse(await js(`(()=>{const card=document.getElementById('companion-card');
      const cells=[...document.querySelectorAll('#model-list .model-cell')].map((el)=>(el.textContent||'').trim());
      const mem=document.getElementById('open-memory');
      return JSON.stringify({open:Boolean(card)&&card.hidden===false,cells,
        memoryButton:mem?(mem.textContent||'').trim():null});})()`));
    coachPanel.opened = coachPanelOpened;
    await closeCoachPanel();
    await sleep(320);
    await js(`window.rocoDemo.requestPlan({reason:'manual',explicit:true})`);
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
        hintHidden:Boolean(document.getElementById('hint')?.hidden),
        hasPlan:Boolean(window.rocoDemo.state.plan),
        bodyLen:(body.innerHTML||'').length,
        status:(document.getElementById('plan-status')||{}).textContent||''});})()`));
    coachFacts.clickPath = `小芽入口 ${coachEntryClick?.top?.path ?? '—'} / `
      + `面板（弹窗打开=${coachPanel.open}，模型格 ${coachPanel.cells.length} 个：${coachPanel.cells.join(' / ')}；`
      + `记忆入口「${coachPanel.memoryButton}」） / `
      + `看一眼（原 \`#plan\` 已删，走同一条 requestPlan({reason:'manual',explicit:true}) 路径）`;
    const coachProblems = coachCompareProblems(coachFacts);
    check('36-候选规则下的 Coach 取舍', 'v3 候选规则下：并列比较 ≥2 条且逐条都是引擎给的合法动作、'
      + '未来 2—3 回合 ≥2 条、如实标置信/未核验、不出现胜率或百分数。'
      + '【按人类 2026-09-23 版式，读取点 `#hint-body` 不变；`#plan`「让小芽看一眼」与 `#xy-settings` 折叠**已删**，'
      + '改由弹出式小芽窗口（真鼠标点 `#coach-entry`，面板里读 `#model-list`）＋同一条 '
      + '`requestPlan({reason:\'manual\',explicit:true})` 路径触发】',
      coachProblems.length === 0,
      (coachProblems.join(' | ') || `并列 ${coachFacts.actions} 条（${JSON.stringify(coachFacts.labels)}）`
        + `；未来 ${coachFacts.futures} 条；规则配置 ${coachFacts.planMode}`)
      + `；诊断（浮条 hidden=${coachFacts.hintHidden} / 有 plan=${coachFacts.hasPlan} / 取舍区 ${coachFacts.bodyLen} 字节 / `
      + `状态「${String(coachFacts.status).slice(0, 90)}」/ 点击命中 ${coachFacts.clickPath}）`);
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
