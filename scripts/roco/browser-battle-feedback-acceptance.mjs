#!/usr/bin/env node
/**
 * 战斗反馈验收：**伤害数字看得见** + **出手与受击有先后**（人类 2026-09-25 实测投诉）。
 *
 * 人类原话
 * --------
 *   ① 「我要的伤害显示呢？现在只有动效」—— 点完技能只看到立绘在动，看不到伤害/治疗数字。
 *   ② 「洛手攻击/动作都有先后，你不要同时做」—— 出手方的动作线索必须先出现，
 *      受击方的浮字/受击线索随后才出现，不能同一帧齐发。
 *
 * 为什么必须自起自跑、并**从页面外面量**
 * --------------------------------------
 * 这两件事都是「玩家眼睛能不能看见」的问题，节点在不在 DOM 里完全证明不了：
 *   · 第一版的真根因就是**节点在 DOM 里、但被立绘盖住**（`.b3-sprite{z-index:1}` 把
 *     `z-index:auto` 的飘字层 `.b3-fx` 压在下面），`elementFromPoint` 命中的是
 *     `.b3-sprite`/`.b3-spritebox`；
 *   · 第二版的真根因是**同一帧播放**（一个 `for` 循环把整回合事件的动效全排上去，
 *     实测出手/受击/数字三者的 `performance.now()` 差 0.1ms）。
 * 所以判据一律用页面里的 `MutationObserver`（`childList/subtree/attributes/characterData`）
 * 记「什么时候 DOM 真的变了」，外加逐帧 `elementFromPoint` 采样记「数字到底在不在最上层」。
 * **不采信客户端自述的任何时间戳字段**（`view.events[].t` 之类一概不读）。
 *
 * 它要钉住的五条（每条都能反证：喂一个坏输入必须红）
 * ------------------------------------------------
 *   J1 数字存在      一次行动里至少 1 个 `.b3-float`，文本含阿拉伯数字（伤害/治疗/属性变化都算）
 *   J2 真的在最上层  每个存活浮字至少一帧 `elementFromPoint(cx,cy)` 命中它自己（或其后代）；
 *                    命中 `.b3-sprite`/`.b3-spritebox`/别的元素 → 红；rect 0×0 或在视口外 → 红
 *                    （另有一条**补充探针**：把该浮字临时设成 `pointer-events:auto` 再量一次，
 *                     用来区分「真的被压在立绘下面」与「画在最上层、只是 hit-test 被跳过」；
 *                     判据本身只认 plain `elementFromPoint`，探针只写进实际值）
 *   J3 有先后        存在「出手方线索（.b3-attack / action 立绘 / data-b3-variant=action）→
 *                    受击方线索（对方侧的 .b3-hit 或伤害浮字）」，Δ ≥ 100ms；|Δ| < 100ms → 红；
 *                    受击方线索早于出手方线索 → 红（顺序反了）。
 *                    ⚠ **按「出手拍」配对**（同侧 ≤150ms 的出手线索算一拍）：速度高的那一方先行动，
 *                    它自己技能的效果浮字（如 `防御 70%` 盾浮字，实测 t=8.8ms）本来就会先出现，
 *                    拿「整条时间线第一条浮字」比会把合法顺序判红。
 *   J4 不残留        3.5s 采样结束时 `.b3-wrap .b3-float` 数为 0；且每个浮字存活 ≥ 300ms
 *   J5 前置          页面起得来 + 真进了战斗 + 点得到合法技能 + 无未捕获异常
 *                    （前置不成立时 J1—J4 记「读不懂」，**不许假绿**）
 *   J6 星不够的格子  `data-b3-cost-short="yes"` ⇒ 不可点 + 整格灰 + ⭐ 红；没触发到那一档时
 *                    **如实写「本轮没触发」**（不判红、也不假装验过）
 *   J7 背包屏数字    （2026-09-25 加入，来自人类决策 4「（甲）读法」）真鼠标点「物品」进背包屏，
 *                    读面板原文 + 引擎实数 `view.self.magic.{uses_left,cooldown,swapped}`，
 *                    断言：① 面板里**每一个**数字都能追溯到「引擎给的实数」或「已登记证据」
 *                    （`data/roco/derived/pvp-magic.json` 的 `per_battle_uses:2` / `cooldown_turns:3`）；
 *                    ② 该显示的数字（剩余次数 / 每局次数 / 冷却回合）**必须真的显示**
 *                    （把次数与冷却从文案里删掉也要红）；没采到背包屏时**判红**（读不到不算验过）。
 *                    ⚠ 同一口径另有一份在 `browser-battle-v3-acceptance.mjs`
 *                    （`item-numbers-must-be-registered`）—— 那个脚本要外部先起 8899、**不在门禁里**，
 *                    所以门禁里有牙的是**这一条**。
 *   J8 立绘框底边接缝 （2026-09-25 加入，来自人类决策 1「立绘框底边横线要处理（把接缝压掉）」）
 *                    真鼠标进战斗之后立刻 `Page.captureScreenshot {format:'png'}`（**整页、无 clip**，
 *                    deviceScaleFactor=1 ⇒ 客户区坐标 == 页面坐标）拿整页 PNG，按我方立绘框
 *                    `.b3-spritebox` 的 rect **直接取像素**（对手侧有就一并量），断言两条：
 *                    ① 框底那一行（`y = rect.bottom - 1`）与上一行的**平均跳变** ≤ 6
 *                       （真机实测：改前 46.4 → 改后 0.8）；
 *                    ② **跨框底那一步的 |Δ亮度|** ≤ 3（真机实测：改前 23.4、对手侧 24.5 → 改后 0.0 / 1.1）。
 *                    两条都必须成立，缺一即红；**没截图 / rect 为 0 / rect 越出图外 → 判红**
 *                    （读不到就不算验过，与 J6/J7 同一套诚实口径），原因写进 actual。
 *                    像素读数复用 `measure-spritebox-seam.mjs` 的 `readPng` / `seamMetrics`（纯函数）。
 *                    ⚠ `--no-shots` 不写盘 ⇒ 这一条**如实报「量不到」并判红**（门禁不带这个开关）。
 *   J9 自由动作不占行动 （2026-09-25 加入，人类「愿力强化不占行动、背包物品都不占行动」）
 *                    真鼠标点「物品」→ 真鼠标点愿力强化那一格 → 读 `view` 前后：回合**不变**、
 *                    state_version 前进、技能屏仍可点、`uses_left` 恰好 -1、`cooldown` == 已登记值；
 *                    再真鼠标点一个合法技能格 → 回合恰好 +1。
 *   J10 生命心 ♥ 常显  （2026-09-25 加入，人类「战斗页顶部的生命心要一直看得见」）
 *                    **心 = 魔力**，字段就是引擎公开视图里的 `view.mana.{self,opponent,pool}`
 *                    （当前心数 / 对手当前心数 / 本局每人几颗）。真鼠标进战斗之后读三份事实：
 *                    ① **开局后常显**：两侧心形计数**可见**、实心数 == `view.mana.{self,opponent}`、
 *                       心形总数 == `view.mana.pool`（**pool 从回执读，判据不写字面量 4**）；
 *                    ② **力竭掉心后**：真鼠标连出合法技能格把局面推到**引擎自己报出一次力竭**
 *                       （`events[].kind==='mana_loss'`），那一刻 DOM 的实心数 == 引擎那一步的
 *                       `view.mana`（**逐位一致**），且相对掉心前恰好 **-1**；
 *                    ③ **拿不到 mana 必须 hidden**：把 `state.view.mana` 抽掉再 `render()`
 *                       （合成「引擎没给」的输入）⇒ 两侧心形计数必须 `hidden`，页面上不许有心形字符
 *                       —— **绝不硬写 4 颗**；
 *                    ④ 上面两条各有**必红反证**（喂「无 mana 却显示 4 颗」/「把心的值与引擎错开 1」）。
 *                    ⚠ 走 legacy 回落路径时引擎**本来就没有 mana**（配置没声明）：那一路只验③，
 *                    ①②如实判红并写清原因（读不到就不算验过，与 J6/J7/J8/J9 同一套口径）。
 *
 * 自起自跑（这是能进门禁的前提）
 * ------------------------------
 *   · 自己起 app server，端口默认 **8895**（8896/8897/8898/8899 已被别的进程/代理占用），
 *     可用 `BATTLE_FEEDBACK_PORT=<随机端口>` 覆盖（主线程实测时就是这么避让的）；
 *   · 自己拉起 headless Chrome（`--remote-debugging-port=0`，端口从 DevToolsActivePort 读）；
 *   · 自己进战斗：真鼠标点「开一局（标准 PVP · 六宠）」；那条路走不通才回落到
 *     `?legacy3v3=1` 的旧「双方各 3 只」入口（两条路都用**真鼠标**，报告里记走了哪条）；
 *   · 真鼠标点一个**合法攻击技能格**，同时用页面里的 MutationObserver + 逐帧采样量 3.5s。
 *
 * 反证（不做等于没做）
 * --------------------
 *   · `feedbackProblems(facts)` 是**纯函数**，喂合成坏输入必须报红：R1 同时(D=0)、R2 顺序反了、
 *     R3 被立绘压住（复刻当前 bug）、R4 一个数字都没有；另有 R5 残留、R6 存活 10ms、
 *     R7 命中 `.b3-spritebox`、R8 没有出手方线索、R10 星不够却仍可点、R11 背包屏写死样例数字
 *     （「每局 5 次 / 冷却 9 回合」）与「把该显示的数字删掉」；
 *   · **R12（J8 的必红反证）** 喂一份「立绘框底边写死成 `rgb(36,52,68)`」的合成事实
 *     （复刻改前那三行实测色，等价于把 CSS 修复回退）→ J8 必须报「硬横线」；
 *     再喂一份「rect 全 0」的 → J8 必须报「量不到」。J8 的同一份纯函数两处都必须命中，没命中算失败。
 *   · **R13（J9 的必红反证）** 喂「自由动作之后回合前进了 / 没有可点技能格 / 冷却不是登记值 /
 *     量不到」→ J9 必须报。
 *   · **R14（J10 的必红反证）** 喂两份合成事实：①「无 mana 状态却硬写 4 颗」（`view.mana` 缺失、
 *     DOM 却画着 4 实心 + 心形字符可见）→ J10 必须报「拿不到 mana 却显示着」/「不许硬写 4 颗」；
 *     ②「把心的值与引擎故意错开 1」（引擎 `self=3/pool=4`、DOM 画成 4 实心）→ J10 必须报
 *     「实心数 ≠ 引擎 view.mana.self」。两处都必须命中，没命中算失败。
 *   · **合成基线必须绿**：`feedbackProblems(健康基线)` 必须是空数组；
 *   · **层叠复刻反证（真浏览器实测，不是推演）**：造一个只含复刻结构的最小页面
 *     （`.b3-spritebox` + `.b3-sprite{z-index:1}` + 没有 z-index 的 `.b3-fx` + 一个 `.b3-float`），
 *     用**同一段采样代码**量三档：① `now`（量真实页面时那一版 CSS）→ 命中 `.b3-sprite`；
 *     ② `zOnly`（只把 `.b3-fx` 抬到 `z-index:3`）→ plain 仍命中 `.b3-sprite`（`pointer-events:none`
 *     把飘字从 hit-test 里跳过），但探针命中 `.b3-float` —— 说明**光加 z-index 不够**；
 *     ③ `fixed`（`z-index:3` + `.b3-float{pointer-events:auto}`）→ 命中 `.b3-float`。
 *     三档的实测 class 都写进报告。
 *
 * 用法
 * ----
 *   node scripts/roco/browser-battle-feedback-acceptance.mjs
 *   node scripts/roco/browser-battle-feedback-acceptance.mjs --selftest-only   # 不开浏览器，只验判据/反证
 *   node scripts/roco/browser-battle-feedback-acceptance.mjs --no-shots
 * 产物
 * ----
 *   reports/roco/battle-feedback.json
 *   reports/roco/battle-feedback/*.png（`--no-shots` 时不写）
 * stdout 汇总行固定格式：`[battle-feedback] N/M 条通过`（退出码非 0 = 有红/有反证没命中）
 */

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';
// J8 的像素读数**直接复用**现成的测量器（`readPng` 解码 + `seamMetrics` 纯函数），不重写解码器。
// `measure-spritebox-seam.mjs` 只在被直接运行时才走 CLI（文件末尾有 isMain 判断），import 它没有副作用。
import {readPng, seamMetrics} from './measure-spritebox-seam.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const argv = process.argv.slice(2);
const SELFTEST_ONLY = argv.includes('--selftest-only');
const SHOTS = !argv.includes('--no-shots');
/** 端口写死 8895：8896–8899 已被别的进程/代理占用（实测 lsof）。 */
const PORT = Number(process.env.BATTLE_FEEDBACK_PORT ?? 8895);
const OUT_DIR = join(ROOT, 'reports/roco');
const REPORT_PATH = join(OUT_DIR, 'battle-feedback.json');
const SHOT_DIR = join(OUT_DIR, 'battle-feedback');
const WINDOW_MS = 3500;        // 一次行动的采样窗口
const ORDER_GAP_MIN = 100;     // J3：出手 → 受击至少要拉开的毫秒数
const FLOAT_ALIVE_MIN = 300;   // J4：浮字至少要活这么久（否则人眼看不见）
const CLICK_ATTEMPTS = 3;      // 「点了没反应」时的重试上限（每一次都是一次真实测量，全部留档）
/**
 * J8（2026-09-25 加入，来自人类决策 1「立绘框底边横线要处理（把接缝压掉）」）的两条阈值。
 *
 * 主线程在真无头 Chrome 1440×900 上实测（我方立绘框 `{x:279,y:251,w:420,h:465,bottom:716}`）：
 *   · 框底那一行 `y=715` 的「与上一行的平均跳变」：**改前 46.4 → 改后 0.8**；
 *   · 跨框底那一步的 |Δ亮度|：**改前 23.4（对手侧 24.5）→ 改后 0.0 / 1.1**。
 * 阈值取 **6 / 3** 的理由：都留出「改后值 × 7 倍以上」的余量（0.8 → 6；0.0/1.1 → 3），
 * 同时仍**远小于**改前值（46.4 的 1/7、23.4 的 1/8）—— 抗锯齿/立绘微差不会误报，
 * 但「接缝又回来了」这种回退一撞就红。
 */
const SEAM_BORDER_JUMP_MAX = 6;
const SEAM_STEP_MAX = 3;
/** J8 的整页截图名（`shoot()` 走的是无 clip 的 `Page.captureScreenshot`，落盘的就是整页）。 */
const SEAM_SHOT_NAME = '04-spritebox-seam';
/**
 * J7（2026-09-25 加入，来自人类决策 4「（甲）读法」）：背包屏的数字**允许显示**，
 * 但每一个数字都必须能追溯到「引擎给的实数」或「已登记证据」；没登记才不许写。
 * 已登记证据 = `data/roco/derived/pvp-magic.json`（`per_battle_uses:2` / `cooldown_turns:3`，
 * 证据 id `EV-PVP-WISH-POWER-UP`）。
 *
 * ⚠ 同一口径在 `browser-battle-v3-acceptance.mjs`（判据 `item-numbers-must-be-registered`）里
 * 也有一份 —— 那个脚本要外部先起 8899 服务、**不在 24 套门禁里**，所以门禁这一份是「有牙」的那份。
 * 两份是**同一个口径的两处实现**（不是同一份代码），改口径时两边都要改。
 */
const CHROME = [
  process.env.CHROME_BIN, process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[battle-feedback]', ...a);
const oneLine = (s, cap = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
const fx = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(fx(n)) : '—');
const sha = (rel) => {
  try { return {file: rel, sha256: createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex').slice(0, 16),
    bytes: statSync(join(ROOT, rel)).size, mtime: statSync(join(ROOT, rel)).mtime.toISOString()}; }
  catch (error) { return {file: rel, error: String(error?.message ?? error)}; }
};

// ── 页面里的采样器（同一份代码用在真实战斗页 + 层叠复刻页）─────────────────────
/**
 * 采样器（函数体注入页面执行；**不许引用外部作用域**，所以整段自包含）。
 *
 * 它只做三件事：
 *   ① 挂在 `.b3-wrap` 上收 MutationObserver，把每次回调记成
 *      `{t: performance.now(), kind, side, detail}`（kind ∈ cue / float / float-gone）；
 *   ② 逐帧（rAF，外加 60ms 定时器兜底）给每个**存活浮字**采一次
 *      `{text, side, cx, cy, w, h, measurable, hitClass, hitTag, hitIsFloat}`；
 *   ③ 每个浮字**只量第一次**的补充探针：把它临时设成 `pointer-events:auto`（同步量完立刻还原，
 *      不改变画面）再问一次 `elementFromPoint`，用来分辨「真的被压在立绘下面（看不见）」与
 *      「画在最上层、只是 hit-test 被 pointer-events:none 跳过（看得见但量不到）」；
 *   ④ `report()` 交出时间线 / 浮字档案 / 帧采样 / 结束时 `.b3-wrap .b3-float` 的直接计数。
 *
 * 侧别（self / foe）一律按 **DOM 归属**判定，不靠文本猜：
 *   `node.closest('[data-b3-side]')`（立绘画框 `data-b3-side`，或顶栏 `.b3-side`）
 *   → `[data-b3-self-card]` / `[data-b3-foe-card]` → `.b3-fighter--self` / `--foe`
 *   → `[data-b3-mirror="self|foe"]`。判定依据在 `sideEvidence` 里原样交出来。
 *
 * 时间戳只来自页面自己的 `performance.now()`；**客户端自述的时间字段一个都不读**。
 */
function battleFeedbackSampler() {
  const ROOT_SEL = '.b3-wrap';
  const FLOAT_SEL = '.b3-float';
  const FRAME_CAP = 480;
  const FRAME_DEDUPE_MS = 20;
  const nowMs = () => +performance.now().toFixed(2);
  const clsOf = (el) => {
    if (!el) return '';
    const c = el.className;
    return String(c && c.baseVal !== undefined ? c.baseVal : (c ?? ''));
  };
  const tagOf = (el) => (el && el.tagName ? String(el.tagName).toLowerCase() : null);
  const state = {
    timeline: [], floats: new Map(), frames: [], selfErrors: [],
    started: false, startT: null, clickT: null, endT: null,
    rootSeen: false, rootSwaps: 0, lastFrameT: -Infinity, rafSamples: 0, timerSamples: 0,
  };
  const nodes = new Map();          // floatId → 节点（不序列化）
  const seenPulse = new WeakMap();  // 卡片 → {attack:bool, hit:bool}
  const seenVariant = new WeakMap();// 立绘画框 → 上一次看到的 variant 值
  const seenSprite = new WeakMap(); // img.b3-sprite → 上一次看到的 src 是不是 action
  let idSeq = 0;
  let wrap = null;
  let observer = null;
  let rafId = 0;
  let timerId = 0;

  const sideOf = (node) => {
    let el = node;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || typeof el.closest !== 'function') return null;
    const attr = (x, name) => (x && x.getAttribute ? x.getAttribute(name) : null);
    const box = el.closest('[data-b3-side]');
    if (box) {
      const v = attr(box, 'data-b3-side');
      if (v === 'self' || v === 'foe') return v;
    }
    if (el.closest('[data-b3-self-card]')) return 'self';
    if (el.closest('[data-b3-foe-card]')) return 'foe';
    if (el.closest('.b3-fighter--self')) return 'self';
    if (el.closest('.b3-fighter--foe')) return 'foe';
    const mirror = el.closest('[data-b3-mirror]');
    if (mirror) {
      const v = attr(mirror, 'data-b3-mirror');
      if (v === 'self' || v === 'foe') return v;
    }
    return null;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return {left: +r.left.toFixed(2), top: +r.top.toFixed(2), right: +r.right.toFixed(2),
      bottom: +r.bottom.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2),
      cx: +(r.left + r.width / 2).toFixed(2), cy: +(r.top + r.height / 2).toFixed(2)};
  };
  const push = (kind, node, detail) => {
    state.timeline.push({t: nowMs(), kind, side: sideOf(node), detail: detail ?? {}});
  };
  const floatIdOf = (node) => {
    if (!node.__b3fbId) node.__b3fbId = `f${++idSeq}`;
    return node.__b3fbId;
  };
  const floatsIn = (node) => {
    if (!node || node.nodeType !== 1) return [];
    const out = [];
    if (typeof node.matches === 'function' && node.matches(FLOAT_SEL)) out.push(node);
    if (typeof node.querySelectorAll === 'function') out.push(...node.querySelectorAll(FLOAT_SEL));
    return out;
  };
  const registerFloat = (node) => {
    const id = floatIdOf(node);
    if (state.floats.has(id)) return;
    const rec = {id, text: String(node.textContent ?? '').trim(), side: sideOf(node), bornT: nowMs(),
      goneT: null, samples: [], rect: null, classes: clsOf(node), textChanges: 0};
    state.floats.set(id, rec);
    nodes.set(id, node);
    push('float', node, {role: 'float', floatId: id, text: rec.text, classes: rec.classes});
  };
  const unregisterFloat = (node) => {
    const id = floatIdOf(node);
    const rec = state.floats.get(id);
    if (!rec) return;
    rec.goneT = nowMs();
    nodes.delete(id);
    push('float-gone', node, {role: 'float-gone', floatId: id, text: rec.text, aliveMs: +(rec.goneT - rec.bornT).toFixed(2)});
  };
  /** 类名线索：元素上出现 `.b3-attack` / `.b3-hit` 的**那一刻**记一条 cue。 */
  const cueFromClass = (el) => {
    const c = clsOf(el);
    const prev = seenPulse.get(el) ?? {attack: false, hit: false};
    const out = [];
    if (/(^|\s)b3-attack(\s|$)/.test(c)) {
      if (!prev.attack) out.push({role: 'attack', what: '.b3-attack'});
      prev.attack = true;
    } else { prev.attack = false; }
    if (/(^|\s)b3-hit(\s|$)/.test(c)) {
      if (!prev.hit) out.push({role: 'hit', what: '.b3-hit'});
      prev.hit = true;
    } else { prev.hit = false; }
    seenPulse.set(el, prev);
    return out;
  };
  const primePulse = () => {
    if (!wrap) return;
    for (const sel of ['.b3-attack', '.b3-hit']) {
      for (const el of wrap.querySelectorAll(sel)) {
        const c = clsOf(el);
        const prev = seenPulse.get(el) ?? {attack: false, hit: false};
        // 采样开始前就挂着的类名是**残留**，不能算成这一次的线索。
        if (/(^|\s)b3-attack(\s|$)/.test(c)) prev.attack = true;
        if (/(^|\s)b3-hit(\s|$)/.test(c)) prev.hit = true;
        seenPulse.set(el, prev);
      }
    }
  };
  const onMutations = (records) => {
    try {
      for (const rec of records) {
        if (rec.type === 'childList') {
          for (const node of rec.addedNodes) for (const f of floatsIn(node)) registerFloat(f);
          for (const node of rec.removedNodes) for (const f of floatsIn(node)) unregisterFloat(f);
          continue;
        }
        if (rec.type === 'characterData') {
          const parent = rec.target?.parentElement ?? null;
          const holder = parent && typeof parent.closest === 'function' ? parent.closest(FLOAT_SEL) : null;
          if (holder) {
            const id = floatIdOf(holder);
            const r = state.floats.get(id);
            if (r) { r.text = String(holder.textContent ?? '').trim(); r.textChanges += 1; }
          }
          continue;
        }
        if (rec.type !== 'attributes') continue;
        const el = rec.target;
        if (!el || el.nodeType !== 1) continue;
        // ① 类名线索
        for (const cue of cueFromClass(el)) {
          push('cue', el, {...cue, attr: 'class', classes: clsOf(el)});
        }
        // ② 动作立绘：data-b3-variant 变成 action
        if (rec.attributeName === 'data-b3-variant') {
          const v = el.getAttribute('data-b3-variant');
          const prev = seenVariant.get(el) ?? null;
          if (v === 'action' && prev !== 'action') {
            push('cue', el, {role: 'attack', what: 'data-b3-variant=action', attr: 'data-b3-variant'});
          }
          seenVariant.set(el, v);
        }
        // ③ 立绘 src 换成动作立绘（img.b3-sprite 的 src / data-src）
        if (rec.attributeName === 'src' || rec.attributeName === 'data-src') {
          const isSprite = typeof el.matches === 'function' && el.matches('img.b3-sprite, .b3-sprite');
          if (isSprite) {
            const raw = String(el.getAttribute(rec.attributeName) ?? '');
            const isAction = /[?&]v=action(&|$)/.test(raw);
            const prev = seenSprite.get(el) ?? false;
            if (isAction && !prev) {
              push('cue', el, {role: 'attack', what: 'sprite src → action 立绘', attr: rec.attributeName, src: raw});
            }
            seenSprite.set(el, isAction);
          }
        }
        // ④ 容错：客户端若改用别的钩子写「出手/受击」（data-b3-cue / data-b3-fx），一样认
        if (/^data-b3-(cue|fx|feedback)$/.test(rec.attributeName ?? '')) {
          const v = String(el.getAttribute(rec.attributeName) ?? '');
          if (v === 'attack' || v === 'action') push('cue', el, {role: 'attack', what: `${rec.attributeName}=${v}`});
          else if (v === 'hit') push('cue', el, {role: 'hit', what: `${rec.attributeName}=${v}`});
        }
      }
    } catch (error) {
      state.selfErrors.push(`observer: ${String(error && error.message || error)}`);
    }
  };
  const sampleFrame = (source) => {
    if (!state.started) return;
    const t = nowMs();
    if (t - state.lastFrameT < FRAME_DEDUPE_MS) return;
    state.lastFrameT = t;
    if (source === 'raf') state.rafSamples += 1; else state.timerSamples += 1;
    const live = [];
    for (const [id, rec] of state.floats) {
      const node = nodes.get(id);
      if (!node || node.isConnected === false) continue;
      const r = rectOf(node);
      const inViewport = r.cx >= 0 && r.cy >= 0 && r.cx <= window.innerWidth && r.cy <= window.innerHeight;
      // 「量不到不算量到」：宽高为 0 或在视口外 → measurable=false（浮字宽高确实为 0 时也算红）
      const measurable = r.w > 0 && r.h > 0 && inViewport;
      let hit = null;
      let hitClass = null;
      let hitTag = null;
      let hitIsFloat = false;
      if (measurable) {
        hit = document.elementFromPoint(r.cx, r.cy);
        hitClass = hit ? clsOf(hit) : null;
        hitTag = tagOf(hit);
        hitIsFloat = Boolean(hit) && (hit === node || node.contains(hit));
      }
      // 补充探针（**只对该浮字量第一次**，同步量完立刻还原，不改变画面）：
      // 把浮字临时设成 `pointer-events:auto` 再问一次 elementFromPoint —— 这样能把
      // 「数字真的被压在立绘下面（看不见）」与「画在最上层、只是 hit-test 被 pointer-events:none
      // 沿继承链跳过（看得见但量不到）」分开。判据 J2 仍然只认上面那次 plain elementFromPoint。
      if (measurable && !rec.paintProbe) {
        const prevPE = node.style.pointerEvents;
        try {
          node.style.pointerEvents = 'auto';
          const top = document.elementFromPoint(r.cx, r.cy);
          rec.paintProbe = {t, hitClass: top ? clsOf(top) : null, hitTag: tagOf(top),
            hitIsFloat: Boolean(top) && (top === node || node.contains(top))};
        } catch (error) {
          rec.paintProbe = {t, error: String(error && error.message || error)};
        } finally {
          node.style.pointerEvents = prevPE;
        }
      }
      const sample = {id, text: rec.text, side: rec.side, t, cx: r.cx, cy: r.cy, w: r.w, h: r.h,
        inViewport, measurable, hitClass, hitTag, hitIsFloat, source};
      live.push(sample);
      rec.samples.push(sample);
      if (r.w > 0 && r.h > 0) rec.rect = {w: r.w, h: r.h, cx: r.cx, cy: r.cy};
    }
    state.frames.push({t, live});
    if (state.frames.length > FRAME_CAP) state.frames.shift();
  };
  const loop = () => {
    if (!state.started) return;
    try {
      const cur = document.querySelector(ROOT_SEL);
      if (cur && cur !== wrap) attach();
      sampleFrame('raf');
    } catch (error) {
      state.selfErrors.push(`frame: ${String(error && error.message || error)}`);
    }
    rafId = requestAnimationFrame(loop);
  };
  const sideEvidence = () => {
    const info = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {selector: sel, classes: clsOf(el), dataB3Side: el.getAttribute('data-b3-side'),
        dataB3Mirror: el.getAttribute('data-b3-mirror'),
        rect: {left: +r.left.toFixed(1), top: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1)},
        text: String(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)};
    };
    return {
      rule: '按 DOM 归属判定 side：node.closest([data-b3-side]) → [data-b3-self-card]/[data-b3-foe-card] '
        + '→ .b3-fighter--self/--foe → [data-b3-mirror]；不靠文本猜。'
        + '（实测：客户端把 `data-b3-side` 写在 `.b3-free.b3-spritebox` 上；`[data-b3-spritebox]` 这个属性不存在，'
        + '所以立绘画框那一格用 `.b3-free` 读，见下面 selfFree/foeFree。）',
      wrap: info(ROOT_SEL),
      selfCard: info('[data-b3-self-card]'),
      foeCard: info('[data-b3-foe-card]'),
      selfSpritebox: info('[data-b3-self-card] [data-b3-spritebox]'),
      foeSpritebox: info('[data-b3-foe-card] [data-b3-spritebox]'),
      selfFree: info('[data-b3-self-card] .b3-free'),
      foeFree: info('[data-b3-foe-card] .b3-free'),
    };
  };
  function attach() {
    const el = document.querySelector(ROOT_SEL);
    if (!el) return false;
    if (el === wrap && observer) return true;
    if (observer) { try { observer.disconnect(); } catch { /* 已经断了 */ } observer = null; }
    if (wrap && wrap !== el) state.rootSwaps += 1;
    wrap = el;
    state.rootSeen = true;
    observer = new MutationObserver(onMutations);
    observer.observe(el, {childList: true, subtree: true, attributes: true, characterData: true});
    primePulse();
    return true;
  }
  const report = () => {
    const floats = [...state.floats.values()].map((rec) => {
      const samples = rec.samples;
      return {...rec,
        sampleCount: samples.length,
        measurableSamples: samples.filter((s) => s.measurable).length,
        onTopSamples: samples.filter((s) => s.hitIsFloat).length,
        hitClasses: [...new Set(samples.map((s) => s.hitClass).filter(Boolean))],
        aliveMs: rec.goneT === null ? +(nowMs() - rec.bornT).toFixed(2) : +(rec.goneT - rec.bornT).toFixed(2),
        removed: rec.goneT !== null};
    });
    const root = document.querySelector(ROOT_SEL);
    return {
      timeline: state.timeline.slice(), floats, frames: state.frames.slice(),
      finalFloatCount: root ? root.querySelectorAll(FLOAT_SEL).length : null,
      globalFloatCount: document.querySelectorAll(FLOAT_SEL).length,
      started: state.started, startT: state.startT, clickT: state.clickT, endT: state.endT,
      elapsedMs: state.startT === null ? null : +(nowMs() - state.startT).toFixed(2),
      sinceClickMs: state.clickT === null ? null : +(nowMs() - state.clickT).toFixed(2),
      selfErrors: state.selfErrors.slice(), rootSeen: state.rootSeen, rootSwaps: state.rootSwaps,
      frameCount: state.frames.length, rafSamples: state.rafSamples, timerSamples: state.timerSamples,
      sideEvidence: sideEvidence(),
      clock: 'performance.now()（页面自己的时钟；客户端自述的时间戳字段一个都没读）',
    };
  };
  const clear = () => {
    state.timeline = []; state.floats = new Map(); state.frames = [];
    state.selfErrors = []; state.clickT = null; state.endT = null;
    state.lastFrameT = -Infinity; state.rafSamples = 0; state.timerSamples = 0;
    nodes.clear();
  };
  window.__b3fb = {
    start() {
      if (!state.started) {
        state.started = true;
        state.startT = nowMs();
        attach();
        rafId = requestAnimationFrame(loop);
        timerId = setInterval(() => {
          try { sampleFrame('timer'); } catch (error) {
            state.selfErrors.push(`timer: ${String(error && error.message || error)}`);
          }
        }, 60);
      }
      return {ok: true, rootSeen: state.rootSeen, startT: state.startT};
    },
    stop() {
      state.started = false;
      state.endT = nowMs();
      if (rafId) cancelAnimationFrame(rafId);
      if (timerId) clearInterval(timerId);
      rafId = 0; timerId = 0;
      try { observer?.disconnect(); } catch { /* 已经断了 */ }
      observer = null;
      return report();
    },
    markClick() { state.clickT = nowMs(); return state.clickT; },
    reset() {
      clear();
      attach();
      return true;
    },
    peek() {
      return {t: nowMs(), timeline: state.timeline.length, floats: state.floats.size,
        frames: state.frames.length,
        floatCount: (document.querySelector(ROOT_SEL)?.querySelectorAll(FLOAT_SEL).length) ?? null};
    },
    report,
    sideEvidence,
  };
  return {ok: true, rootSeen: Boolean(document.querySelector(ROOT_SEL)), clock: 'performance.now()'};
}

/** 注入用的同一段采样代码（真实战斗页与层叠复刻页共用**这一份**）。 */
const samplerSource = () => `(${battleFeedbackSampler.toString()})()`;

// ── 纯函数判据 ──────────────────────────────────────────────────────────────
const CRITERIA = [
  {id: 'J1', name: '数字存在'},
  {id: 'J2', name: '真的在最上层'},
  {id: 'J3', name: '有先后'},
  {id: 'J4', name: '不残留'},
  {id: 'J5', name: '前置'},
  {id: 'J6', name: '星不够的格子（灰置 + 红⭐ + 不可点）'},
  {id: 'J7', name: '背包屏数字可追溯（引擎实数 / 已登记证据）+ 该显示的必须显示'},
  {id: 'J8', name: '立绘框底边接缝（框底那一行跳变 ≤ 6 + 跨框底一步 |Δ亮度| ≤ 3）'},
  {id: 'J9', name: '自由动作不占行动（背包物品用掉后回合不变、技能仍可点、次数-1、冷却=登记值；再出技能才 +1）'},
  {id: 'J10', name: '生命心 ♥ 常显（= 魔力：实心数 == view.mana.{self,opponent}、总数 == view.mana.pool；'
    + '力竭掉心 -1 且与引擎逐位一致；拿不到 mana 必须 hidden）'},
];
const NAME_OF = Object.fromEntries(CRITERIA.map((c) => [c.id, c.name]));
const OTHER = {self: 'foe', foe: 'self'};

/**
 * 「出手拍」切分与配对（J3 与报告摘要**共用这一份**，免得两处口径漂移）。
 *
 * 主线程 2026-09-25 实测情报：速度高的那一方先行动，它**自己技能的效果浮字**（如
 * `防御 70%` 盾浮字，`side:foe`，实测 t=8.8ms）本来就会先出现，而伤害拍的出手线索在
 * t=458.6ms。所以「整条时间线里第一条浮字必须晚于第一条出手线索」是错的写法 ——
 * 必须按拍配对：同一侧、相距 ≤150ms 的出手线索（`.b3-attack` + `data-b3-variant=action`
 * + 动作立绘是同一拍的三条线索）合并成一拍，每一拍只跟**它这一拍窗口内、对面那一侧的
 * 受击线索**配对。
 *
 * 受击方线索 = 对面侧的 `.b3-hit` cue，或对面侧的**伤害浮字**
 * （class 里带 `b3-float--hit/--strong/--weak`，或文本形如 `-30`）。
 * 对面侧的治疗 / 防御 / 未击中 / 倒下浮字是那一只**自己的效果**，不算这一拍打出来的受击线索。
 */
const CYCLE_TOL = 20;       // 同一拍内的顺序容差（ms）
const CYCLE_PRE_TOL = 50;   // 拍窗口向前放宽：同一帧里稍稍早一点的反应也要能配上对
const CYCLE_JOIN_MS = 150;  // 同侧线索相距 ≤150ms 算同一拍

function isReactionFloat(e) {
  const cl = String(e?.detail?.classes ?? e?.classes ?? '');
  const text = String(e?.detail?.text ?? e?.text ?? '').trim();
  return /b3-float--(hit|strong|weak)/.test(cl) || /^[-−]?\s*\d/.test(text);
}
function isReactionEvent(e) {
  const role = e?.detail?.role ?? e?.role ?? null;
  if (e?.kind === 'cue') return role === 'hit';
  if (e?.kind === 'float') return isReactionFloat(e);
  return false;
}
function battleCycles(timeline) {
  const list = Array.isArray(timeline) ? timeline : [];
  const attackCues = list.filter((e) => e.kind === 'cue' && (e.detail?.role ?? e.role) === 'attack');
  const leads = [];
  for (const c of attackCues) {
    const last = leads[leads.length - 1];
    if (last && last.side === c.side && Number(c.t) - last.endT <= CYCLE_JOIN_MS) {
      last.endT = Number(c.t); last.cues.push(c); continue;
    }
    leads.push({side: c.side, t: Number(c.t), endT: Number(c.t), cues: [c]});
  }
  const pairs = [];
  const noReactionLeads = [];
  for (let i = 0; i < leads.length; i += 1) {
    const lead = leads[i];
    const next = leads[i + 1] ?? null;
    const winStart = lead.t - CYCLE_PRE_TOL;
    const winEnd = next ? next.t - CYCLE_PRE_TOL : Infinity;
    const reactions = list.filter((e) => e.side === OTHER[lead.side] && isReactionEvent(e)
      && Number(e.t) >= winStart && Number(e.t) < winEnd);
    if (!reactions.length) { noReactionLeads.push(lead); continue; }
    const firstHit = reactions.find((e) => e.kind === 'cue') ?? null;
    const firstFloat = reactions.find((e) => e.kind === 'float') ?? null;
    pairs.push({lead, first: reactions[0], reactions: reactions.length,
      delta: fx(Number(reactions[0].t) - lead.t),
      deltaHit: firstHit ? fx(Number(firstHit.t) - lead.t) : null,
      deltaFloat: firstFloat ? fx(Number(firstFloat.t) - lead.t) : null,
      floatText: firstFloat ? String(firstFloat.detail?.text ?? '') : null,
      hitWhat: firstHit ? String(firstHit.detail?.what ?? '') : null});
  }
  // 顺序反了：受击线索出现在**它的出手线索之前**（更早处也没有对面侧的出手线索）
  const inversions = [];
  for (const r of list.filter((e) => e.side === 'self' || e.side === 'foe').filter(isReactionEvent)) {
    const opp = attackCues.filter((a) => a.side === OTHER[r.side]);
    const prior = opp.filter((a) => Number(a.t) <= Number(r.t) + CYCLE_TOL);
    const later = opp.filter((a) => Number(a.t) > Number(r.t) + CYCLE_TOL);
    if (!prior.length && later.length) inversions.push({reaction: r, attacker: later[0]});
  }
  return {leads, pairs, inversions, noReactionLeads, attackCues};
}

/**
 * 判据本体：**纯函数**，输入 facts，输出逐条判据行。
 *
 * facts 契约（真实页面与合成夹具共用；缺字段一律当成「量不到」而不是「通过」）：
 *   {
 *     timeline: [{t, kind:'cue'|'float'|'float-gone', side:'self'|'foe'|null, detail:{role, text, ...}}],
 *     floats:   [{id, text, side, bornT, goneT, aliveMs, removed, samples:[{t,measurable,hitIsFloat,hitClass,hitTag,cx,cy,w,h}]}],
 *     frames:   [{t, live:[…同上…]}],
 *     battleStarted: bool, legalSkills: int, finalFloatCount: int,
 *     precondition: {pageReady, battlePanelVisible, clickableSlots, entryPath, slotClickable, clickAccepted, skill},
 *     errors: {pageExceptions:int, consoleErrors:int},
 *   }
 */
function feedbackFindings(facts) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const timeline = Array.isArray(f.timeline) ? f.timeline.filter((e) => e && Number.isFinite(Number(e.t))) : [];
  const floats = Array.isArray(f.floats) ? f.floats.filter(Boolean) : [];
  const frames = Array.isArray(f.frames) ? f.frames.filter(Boolean) : [];
  const pre = f.precondition ?? {};
  const errors = f.errors ?? {};
  const roleOf = (e) => e?.detail?.role ?? e?.role ?? null;
  const whatOf = (e) => e?.detail?.what ?? e?.what ?? '';
  const rows = [];
  const P = (text, actual, missing) => ({text, actual, missing});
  const mk = (id, problems, actual) => ({id, name: NAME_OF[id], problems, actual, ok: problems.length === 0, unreadable: false});

  const cues = timeline.filter((e) => e.kind === 'cue');
  const attackCues = cues.filter((e) => roleOf(e) === 'attack');
  const hitCues = cues.filter((e) => roleOf(e) === 'hit');
  const floatEvents = timeline.filter((e) => e.kind === 'float');

  // ── J5 前置：页面起得来 + 真进了战斗 + 点得到合法技能 + 没有未捕获异常 ──────
  const preProblems = [];
  if (pre.pageReady !== 'yes') {
    preProblems.push(P('页面没起来（`body[data-roco-ready]` 不是 yes）',
      `data-roco-ready=${JSON.stringify(pre.pageReady ?? null)}`, '页面能 boot'));
  }
  if (pre.battlePanelVisible !== true) {
    preProblems.push(P('战斗区没显示（`#battle-panel` 还是 hidden）',
      `battlePanelVisible=${JSON.stringify(pre.battlePanelVisible ?? null)}`, '战斗区真的渲染出来'));
  }
  if (f.battleStarted !== true) {
    preProblems.push(P('没有真的进战斗', `battleStarted=${JSON.stringify(f.battleStarted ?? null)}`,
      '真鼠标点开局按钮 → 引擎开局成功'));
  }
  if (!(Number(f.legalSkills) > 0)) {
    preProblems.push(P('这一手引擎没给合法技能', `legalSkills=${JSON.stringify(f.legalSkills ?? null)}`,
      '至少一个合法技能动作'));
  }
  if (!(Number(pre.clickableSlots) > 0)) {
    preProblems.push(P('页面上没有可点的技能格', `clickableSlots=${JSON.stringify(pre.clickableSlots ?? null)}`,
      '`.b3-wrap [data-b3-skill-slot]` 里至少一格可点'));
  }
  if (pre.clickAccepted !== true) {
    preProblems.push(P('真鼠标点下去页面没有接住（这一手没打出去）',
      `clickAccepted=${JSON.stringify(pre.clickAccepted ?? null)}；点了 ${JSON.stringify(pre.attempts ?? null)} 次`,
      '技能格点得动、点了真的推进'));
  }
  if (Number(errors.pageExceptions ?? 0) > 0) {
    preProblems.push(P('页面抛了未捕获异常（`Runtime.exceptionThrown`）',
      `${errors.pageExceptions} 条：${oneLine((errors.pageExceptionSamples ?? []).join(' | '), 200)}`,
      '零未捕获异常'));
  }
  if (Number(errors.consoleErrors ?? 0) > 0) {
    preProblems.push(P('页面打了 console.error',
      `${errors.consoleErrors} 条：${oneLine((errors.consoleErrorSamples ?? []).join(' | '), 200)}`,
      '零 console.error'));
  }
  const preActual = `ready=${JSON.stringify(pre.pageReady ?? null)} 战斗区=${JSON.stringify(pre.battlePanelVisible ?? null)} `
    + `开局=${JSON.stringify(f.battleStarted ?? null)} 合法技能=${JSON.stringify(f.legalSkills ?? null)} `
    + `可点格=${JSON.stringify(pre.clickableSlots ?? null)} 点击被接住=${JSON.stringify(pre.clickAccepted ?? null)} `
    + `未捕获异常=${errors.pageExceptions ?? 0} console.error=${errors.consoleErrors ?? 0} `
    + `入口=${JSON.stringify(pre.entryPath ?? null)} 技能=${JSON.stringify(pre.skill ?? null)}`;
  rows.push(mk('J5', preProblems, preActual));
  const preOk = preProblems.length === 0;

  if (!preOk) {
    // 前置不成立时，后面每一条的实际值都读不懂 —— 如实记「读不懂」，**不许假绿**。
    for (const id of ['J1', 'J2', 'J3', 'J4']) {
      rows.push({id, name: NAME_OF[id], problems: [], actual:
        `前置不成立（${preProblems.map((p) => p.text).join('；')}）→ 本条的实际值读不懂`, ok: null,
      unreadable: true});
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  // ── J1 数字存在：至少一个含阿拉伯数字的浮字 ──────────────────────────────
  {
    const digitFloats = floats.filter((x) => /\d/.test(String(x.text ?? '')));
    const problems = [];
    if (!floats.length) {
      problems.push(P('没有数字：这一次行动里一个 `.b3-float` 都没有（只有动作动画，没有伤害/治疗数字）',
        `浮字 0 个；时间线 ${timeline.length} 条（cue ${cues.length} 条 / float ${floatEvents.length} 条）`,
        '行动里至少 1 个带阿拉伯数字的浮字'));
    } else if (!digitFloats.length) {
      problems.push(P(`没有数字：出现了 ${floats.length} 个浮字，但文本全是纯文字（没有一个含阿拉伯数字）`,
        `浮字文本 ${JSON.stringify(floats.map((x) => x.text))}`, '浮字文本里要有阿拉伯数字（伤害/治疗/属性变化）'));
    }
    rows.push(mk('J1', problems, `浮字 ${floats.length} 个，其中含阿拉伯数字 ${digitFloats.length} 个：`
      + `${JSON.stringify(digitFloats.slice(0, 6).map((x) => `${x.text}@${x.side}`))}`));
  }

  // ── J2 真的在最上层：至少一帧 elementFromPoint 命中浮字自身 ────────────────
  {
    const problems = [];
    const detail = [];
    if (!floats.length) {
      problems.push(P('量不到任何浮字（「量不到不算量到」）', '浮字 0 个，没有任何一帧可核',
        '先有浮字，才谈得上它在不在最上层'));
    }
    for (const x of floats) {
      const samples = Array.isArray(x.samples) ? x.samples : [];
      const measurable = samples.filter((s) => s.measurable);
      const onTop = measurable.filter((s) => s.hitIsFloat);
      const hitClasses = [...new Set(samples.map((s) => s.hitClass).filter(Boolean))];
      if (!measurable.length) {
        problems.push(P(`量不到：浮字「${x.text}」没有任何一帧可量（rect 宽高为 0 或在视口外）`,
          `${samples.length} 帧采样，可量的 0 帧；rect=${JSON.stringify(x.rect ?? null)}`,
          '浮字必须真的渲染出来（宽高 > 0 且中心点在视口内）'));
      } else if (!onTop.length) {
        const probe = x.paintProbe ?? null;
        const probeText = probe
          ? `；补充探针（把该浮字临时设成 pointer-events:auto 再量一次）：命中 `
            + `${JSON.stringify(probe.hitClass)}（${JSON.stringify(probe.hitTag)}）`
            + (probe.hitIsFloat
              ? ' → 它其实画在最上层，plain 量不到只是整条链路的 pointer-events:none 让 hit-test 跳过了它'
              : ' → 真的被压在立绘下面（数字看不见）')
          : '；补充探针：没取到';
        problems.push(P(`被压住：浮字「${x.text}」的 ${measurable.length} 帧可量采样里，`
          + `elementFromPoint 命中的都不是它自己`,
        `实际命中 class：${JSON.stringify(hitClasses)}（如 ${JSON.stringify((measurable[0] ?? {}).hitTag)}）${probeText}`,
        '把飘字层抬到立绘之上（`.b3-fx` 的 z-index 要高过 `.b3-sprite`），并让 `.b3-float` 可被命中'));
      }
      detail.push(`「${x.text}」${onTop.length}/${measurable.length} 帧命中自身`
        + `${hitClasses.length ? `（命中 ${JSON.stringify(hitClasses)}）` : ''}`
        + `${x.paintProbe ? `／探针 ${JSON.stringify(x.paintProbe.hitClass)}` : ''}`);
    }
    rows.push(mk('J2', problems, `${floats.length} 个浮字逐帧 elementFromPoint：${detail.join('；') || '（没有浮字可核）'}`
      + `；总采样帧 ${frames.length}`));
  }

  // ── J3 有先后：**按「出手拍」配对**，出手方线索 → 受击方线索，Δ ≥ 100ms ────
  // （切分与配对见 `battleCycles()`；为什么不能拿「整条时间线第一条浮字」比，也写在那个函数上。）
  {
    const problems = [];
    const {leads, pairs, inversions, noReactionLeads} = battleCycles(timeline);
    let deltaText = '（没有可比的一对）';
    if (!attackCues.length) {
      problems.push(P('没有出手方线索：时间线里没有 `.b3-attack` / action 立绘 / data-b3-variant=action',
        `cue ${cues.length} 条，其中出手方 0 条；受击方 cue ${hitCues.length} 条、浮字 ${floatEvents.length} 条`,
        '出手方必须先有动作线索，才谈得上「出手 → 受击」的先后'));
    } else if (!leads.some((l) => l.side === 'self' || l.side === 'foe')) {
      problems.push(P('出手方线索读不出属于哪一侧（DOM 归属判定失败）',
        `出手方 cue ${attackCues.length} 条，side 全是 null`, '线索必须挂在某一侧的卡片/立绘上'));
    } else {
      if (!pairs.length) {
        problems.push(P('只有出手方线索，没有受击方的线索/浮字（配不出任何一对）',
          `${leads.length} 拍出手（首个 t=${fx(leads[0].t)}ms side=${leads[0].side}）在各自窗口里都配不到`
          + `对面侧的 \`.b3-hit\` 或伤害浮字；受击方 cue ${hitCues.length} 条、浮字 ${floatEvents.length} 条`,
          '受击方随后要出现 `.b3-hit` 或伤害浮字'));
      }
      if (inversions.length) {
        const inv = inversions[0];
        problems.push(P('顺序反了：受击方线索比出手方线索**更早**出现',
          `${inversions.length} 条受击线索早于它的出手线索；例：受击方 ${inv.reaction.side} `
          + `t=${fx(inv.reaction.t)}ms（${oneLine(whatOf(inv.reaction) || inv.reaction.detail?.text || 'hit', 30)}）`
          + ` 早于出手方 ${inv.attacker.side} t=${fx(inv.attacker.t)}ms`
          + `（差 ${fx(Number(inv.attacker.t) - Number(inv.reaction.t))}ms）`,
          '出手方线索必须先出现，受击方线索随后'));
      }
      const sameFrame = pairs.filter((p) => Math.abs(Number(p.delta)) < ORDER_GAP_MIN);
      if (sameFrame.length) {
        const worst = sameFrame.reduce((m, p) => (Math.abs(p.delta) < Math.abs(m.delta) ? p : m), sameFrame[0]);
        problems.push(P(`出手与受击**同时**发生（同一帧齐发，判据要求 ≥ ${ORDER_GAP_MIN}ms）`,
          `${sameFrame.length}/${pairs.length} 对线索 |Δ| < ${ORDER_GAP_MIN}ms；最小 |Δ|=${fmt(Math.abs(worst.delta))}ms`
          + `（出手方 ${worst.lead.side} t=${fx(worst.lead.t)}ms`
          + ` ↔ 受击方 ${worst.first.side} ${oneLine(whatOf(worst.first) || worst.first.detail?.text || 'hit', 30)}`
          + ` t=${fx(worst.first.t)}ms）`,
          `出手方线索先出现，受击方线索至少晚 ${ORDER_GAP_MIN}ms`));
      }
      if (pairs.length) {
        deltaText = pairs.map((p) => `出手→受击 +${fmt(p.delta)}ms`
          + `（其中 出手→.b3-hit ${p.deltaHit === null ? '—' : `+${fmt(p.deltaHit)}ms`}、`
          + `出手→伤害浮字 ${p.deltaFloat === null ? '—' : `+${fmt(p.deltaFloat)}ms「${p.floatText}」`}）`).join('；');
      } else if (noReactionLeads.length) {
        deltaText = `${noReactionLeads.length} 拍出手都没有配到受击线索`;
      }
    }
    rows.push(mk('J3', problems, `出手线索 ${attackCues.length} 条 → 合并成 ${leads.length} 拍`
      + `（首个 side=${leads[0]?.side ?? '—'} t=${fmt(leads[0]?.t)}ms）；受击方 cue ${hitCues.length} 条、`
      + `浮字 ${floatEvents.length} 条；配对 ${pairs.length} 对，判据要求 ≥ ${ORDER_GAP_MIN}ms：${deltaText}`));
  }

  // ── J4 不残留：结束时清空 + 存活 ≥ 300ms ─────────────────────────────────
  {
    const problems = [];
    const alive = floats.filter((x) => x.removed !== true);
    const finalCount = Number.isFinite(Number(f.finalFloatCount)) ? Number(f.finalFloatCount) : alive.length;
    if (finalCount > 0) {
      problems.push(P(`越攒越多：${WINDOW_MS}ms 采样结束时 \`.b3-wrap .b3-float\` 还剩 ${finalCount} 个（浮字必须被移除）`,
        `结束时计数 ${finalCount}；其中没被移除的：${JSON.stringify(alive.map((x) => x.text))}`,
        '每个浮字在动画结束后从 DOM 里删掉'));
    }
    const short = floats.filter((x) => !(Number(x.aliveMs) >= FLOAT_ALIVE_MIN));
    if (short.length) {
      problems.push(P(`看不清：${short.length} 个浮字存活 < ${FLOAT_ALIVE_MIN}ms（加进去就被删了）`,
        short.map((x) => `「${x.text}」${fmt(x.aliveMs)}ms`).join('、'),
        `每个浮字至少活 ${FLOAT_ALIVE_MIN}ms`));
    }
    rows.push(mk('J4', problems, `结束时剩 ${finalCount} 个浮字；${floats.length} 个浮字的存活时长：`
      + `${JSON.stringify(floats.map((x) => `${x.text}=${fmt(x.aliveMs)}ms`))}`));
  }

  // ── J6 「星不够」的格子：灰置 + 红⭐ + 不可点 ──────────────────────────────
  //
  // 采样在 `measureAction` 里做（那一层是 async、有真鼠标）：连出**最贵**的合法技能，
  // 能量 10 → 7 → 4 → 1（主线程 2026-09-25 实测），3 费那一格随即拿到
  // `data-b3-cost-short="yes"`。这里只判**不变量**：short=yes ⇒ 不可点 + 整格灰 + ⭐ 红。
  // 没触发到那一档时**如实写「本轮没触发」**（不判红、也不假装验过）。
  {
    const allSlots = Array.isArray(f.slotSamples) ? f.slotSamples : [];
    const reds = Array.isArray(f.slotReds) && f.slotReds.length ? f.slotReds : ['rgb(255, 154, 154)'];
    const shortSeen = allSlots.filter((x) => x && x.short === 'yes');
    const problems = slotShortProblems(allSlots, reds);
    const trace = Array.isArray(f.slotEnergyTrace) ? f.slotEnergyTrace : [];
    const hitTurn = f.slotHitTurn ?? null;
    const actual = allSlots.length === 0
      ? '本轮没采到技能格样本（页面没进到战斗或采样失败）—— 没有可判的东西'
      : (hitTurn === null
        ? `本轮**没触发**到「星不够」那一档（采样 ${trace.length} 手；能量轨迹 ${JSON.stringify(trace)}）`
        : `第 ${hitTurn} 回合触发：${shortSeen.length} 个 short=yes 格 `
          + `${JSON.stringify(shortSeen.map((x) => `${x.name}(费${x.cost}/色${x.color}/legal=${x.legal})`))}；`
          + `允许的红：${reds.join(' / ')}`);
    rows.push(mk('J6', problems, actual));
  }

  // ── J7 背包屏数字：每个数字可追溯（引擎实数 / 已登记证据）+ 该显示的必须显示 ──
  //
  // 采样在 `measureItemPanel` 里做（真鼠标点 `[data-b3-tab="item"]`、读面板文本 + 引擎 magic 事实）。
  // 没采到（没进战斗 / 点不到那一屏）时**如实写「本轮没采到」**（判据记红：读不到就不算验过，
  // 但原因写在 actual 里 —— 与 J6「没触发」同一套诚实口径）。
  {
    const panel = f.itemPanel ?? null;
    const problems = panel ? itemPanelNumberProblems(f) : [];
    // 「量不到 ≠ 量到了」：没采到背包屏就**判红**（读不到就不算验过），但原因如实写在 actual / 问题里
    if (!panel) {
      problems.push(P('没采到背包屏：真鼠标点 `[data-b3-tab="item"]` 之后没读到面板文本 / 引擎 magic 事实',
        `itemPanel=${JSON.stringify(panel)}`, '真鼠标进战斗 → 真鼠标点「物品」→ 读面板文本与 view.self.magic'));
    }
    const eng = panel?.engineFacts ?? {};
    const reg = panel?.registered ?? {};
    const actual = !panel
      ? '本轮没采到背包屏（`measureItemPanel` 没跑或页面没进到战斗）—— 没有可判的东西'
      : (!panel.count
        ? `背包屏在（panelFound=${JSON.stringify(panel.panelFound ?? null)}），但一个 \`data-b3-item-cell\` 都没有`
        : `面板原文「${oneLine(panel.text ?? '', 160)}」；引擎实数 uses_left=${JSON.stringify(eng.usesLeft ?? null)}`
          + `/cooldown=${JSON.stringify(eng.cooldown ?? null)}/swapped=${JSON.stringify(eng.swappedCount ?? null)}；`
          + `已登记 per_battle_uses=${JSON.stringify(reg.per_battle_uses ?? null)}`
          + `/cooldown_turns=${JSON.stringify(reg.cooldown_turns ?? null)}；问题 ${problems.length} 条`);
    rows.push(mk('J7', problems, actual));
  }

  // ── J8 立绘框底边接缝：框底那一行不许有硬横线 + 跨框底那一步要压平 ──────────────
  //
  // 采样在 `measureSeam` 里做（真鼠标进战斗之后立刻**整页**截图 + 量 `.b3-spritebox` 的 rect，
  // 像素直接来自那张落盘 PNG）。没截图 / rect 为 0 / rect 越出图外 → **判红**（读不到就不算验过），
  // 原因写在 problems 与 actual 里 —— 与 J6「本轮没触发」、J7「没采到背包屏」同一套诚实口径。
  {
    const seam = f.seam ?? null;
    const problems = seamProblems(f);
    const desc = (side, who) => {
      const fact = seam?.[side] ?? null;
      if (!fact) return `${who}=没采到（本轮页面上没有这一侧立绘框）`;
      const read = seamSideRead(fact);
      if (!read.ok) return `${who}=**量不到**（${oneLine(read.reason ?? '未知', 120)}）`;
      const m = read.metrics;
      return `${who} rect=${JSON.stringify(read.box)} → borderJump=${fmt(m.borderJump)}`
        + `（阈值 ≤ ${SEAM_BORDER_JUMP_MAX}，框底 y=${m.border} 均色 ${m.borderMean}）`
        + ` stepAcrossBottom=${fmt(m.stepAcrossBottom)}（阈值 ≤ ${SEAM_STEP_MAX}）`
        + ` 框内最大行跳变=${fmt(m.innerMaxJump)}`;
    };
    const actual = !seam
      ? '本轮没采到立绘框接缝事实（没截图 / 没量 rect）—— 没有可判的东西'
      : `${desc('self', '我方')}；${desc('foe', '对手')}；整页截图=${JSON.stringify(seam.shot ?? null)}`
        + `（deviceScaleFactor=1 ⇒ 客户区坐标 == 页面坐标，直接按 rect 取像素）；问题 ${problems.length} 条`;
    rows.push(mk('J8', problems, actual));
  }

  // ── J9 自由动作不占行动（人类 2026-09-25：「愿力强化不占行动、背包物品都不占行动；
  //    愿力冲击是个技能、照常占行动」）────────────────────────────────────────────
  //
  // 采样在 `measureFreeAction` 里做：真鼠标进战斗 → 点「物品」→ **真鼠标点愿力强化那一格**
  // → 读 `view` 前后（回合 / state_version / uses_left / cooldown / 可点技能格）
  // → 再真鼠标点一个合法技能格 → 读回合。
  // 没采到（没进战斗 / 找不到可用的那一格 / 点不到）时**判红**并把原因写进 actual
  //（与 J6「没触发」、J7「没采到」同一套「读不到就不算验过」的口径）。
  {
    const fa = f.freeAction ?? null;
    const problems = fa ? freeActionProblems(fa) : [];
    if (!fa) {
      problems.push(P('没采到「自由动作」事实：真鼠标点背包里的愿力强化那一格之后没读到 view 前后',
        `freeAction=${JSON.stringify(fa)}`,
        '真鼠标进战斗 → 真鼠标点「物品」→ 真鼠标点 `[data-b3-item-cell][data-b3-item-id="wish_power_up"]` → 读回合/次数/冷却/可点技能格'));
    }
    const before = fa?.before ?? {};
    const after = fa?.after ?? {};
    const actual = !fa
      ? '本轮没采到自由动作事实（`measureFreeAction` 没跑或没进战斗）—— 没有可判的东西'
      : (fa.failReason
        ? `**量不到**：${oneLine(fa.failReason, 200)}`
        : `用愿力强化前 turn=${fmt(before.turn)} state_version=${fmt(before.version)}`
          + ` uses_left=${fmt(before.usesLeft)} cooldown=${fmt(before.cooldown)}`
          + `；用掉之后 turn=${fmt(after.turn)} state_version=${fmt(after.version)}`
          + ` uses_left=${fmt(after.usesLeft)} cooldown=${fmt(after.cooldown)}`
          + ` 可点技能格=${fmt(after.clickableSkills)}`
          + `；再出一手技能后 turn=${fmt(fa.turnAfterSkill)}`
          + `（已登记 cooldown_turns=${fmt(fa.registered?.cooldown_turns)}）`
          + `；问题 ${problems.length} 条`);
    rows.push(mk('J9', problems, actual));
  }

  // ── J10 生命心 ♥ 常显（人类 2026-09-25：「战斗页顶部的生命心要一直看得见」）─────────
  //
  // 采样在 `measureHearts` 里做：真鼠标进战斗 → 读**开局后**那一份（DOM 原文 + 同一时刻的
  // `view.mana`）→ 真鼠标连出合法技能格把局面推到**引擎自己报出一次力竭**（`mana_loss` 事件）
  // → 再读一份 → 再把 `state.view.mana` 抽掉 `render()` 一次（合成「引擎没给」）读第三份。
  // 没采到（没进战斗 / 推不到力竭 / 读不到）时**判红**并把原因写进 actual
  //（与 J6「没触发」、J7「没采到」、J9「量不到」同一套「读不到就不算验过」的口径）。
  {
    const h = f.hearts ?? null;
    const problems = h ? heartsProblems(h) : [];
    if (!h) {
      problems.push(P('没采到「生命心常显」事实：真战斗页顶栏 `#b3-hearts-self`/`#b3-hearts-foe` 的 DOM 原文与同一时刻的 `view.mana`',
        `hearts=${JSON.stringify(h)}`,
        '真鼠标进战斗 → 读两侧心形计数 + `view.mana` → 推到一次力竭再读一次 → 抽掉 mana 再读一次'));
    }
    const one = (s) => (s ? `引擎 ${JSON.stringify(s.engine?.mana ?? null)} / DOM self=${JSON.stringify(s.dom?.self?.text ?? null)}`
      + `(${JSON.stringify(s.dom?.self?.full ?? null)}实心/${JSON.stringify(s.dom?.self?.total ?? null)}总，hidden=${JSON.stringify(s.dom?.self?.hidden ?? null)})`
      + ` foe=${JSON.stringify(s.dom?.foe?.text ?? null)}`
      + `(${JSON.stringify(s.dom?.foe?.full ?? null)}实心/${JSON.stringify(s.dom?.foe?.total ?? null)}总，hidden=${JSON.stringify(s.dom?.foe?.hidden ?? null)})` : '（没采到）');
    const actual = !h
      ? '本轮没采到生命心常显事实（`measureHearts` 没跑或没进战斗）—— 没有可判的东西'
      : (h.failReason
        ? `**量不到**：${oneLine(h.failReason, 220)}`
        : `开局后（turn=${fmt(h.initial?.engine?.turn)}）：${one(h.initial)}`
          + `；力竭掉心（${h.faint?.found ? `第 ${fmt(h.faint.steps)} 步 / turn ${fmt(h.faint.before?.engine?.turn)}→`
            + `${fmt(h.faint.after?.engine?.turn)}，引擎事件 ${JSON.stringify(oneLine(h.faint.event?.text ?? '', 80))}` : '**没推到位**'}）：`
          + `${one(h.faint?.after)}`
          + `；抽掉 mana 的探针（合成「引擎没给」）：${h.missingManaProbe?.taken
            ? `self.hidden=${JSON.stringify(h.missingManaProbe.after?.dom?.self?.hidden ?? null)} `
              + `foe.hidden=${JSON.stringify(h.missingManaProbe.after?.dom?.foe?.hidden ?? null)} `
              + `页面上心形字符=${JSON.stringify(h.missingManaProbe.after?.bodyHearts ?? null)}`
              + `（探针后已还原=${JSON.stringify(h.missingManaProbe.restored ?? null)}）` : '**没做**'}`
          + `；入口=${JSON.stringify(h.path ?? null)}；问题 ${problems.length} 条`);
    rows.push(mk('J10', problems, actual));
  }

  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * J6 的纯函数判据：**星不够**的格子必须同时满足四件事。
 *
 * v3h 设计稿（`battle-v3-default-1440x900.png` 第 4 格）的形态是**整格灰置 + ⭐ 变红 + 不可点**，
 * 客户端三条落点：`data-b3-cost-short="yes"`（`roco.js` 里 `me.energy < cost`）/
 * `data-b3-slot-legal="no"` + class `b3-slot--grey` / `.b3-slot[data-b3-cost-short="yes"] .b3-cost{color:var(--b3-red)}`。
 * 这里量的是**不变量**：出现 short=yes 就必须三条都成立。`reds` 由调用方从页面读出来传进来（纯函数不碰 DOM）。
 */
function slotShortProblems(slots, reds = []) {
  // `P(...)` 在 `feedbackFindings` 里是局部 helper，这里自带一份同样的形状
  // （纯函数要能被反证单独调用，不能依赖那个作用域）。
  const P = (text, actual, missing) => ({text, actual, missing});
  const out = [];
  for (const s of Array.isArray(slots) ? slots : []) {
    if (!s || s.short !== 'yes') continue;
    const who = s.name ? `「${s.name}」` : `第 ${Number(s.index ?? 0) + 1} 格`;
    if (s.legal !== 'no') {
      out.push(P(`星不够的格子${who}仍标成合法`, `data-b3-slot-legal=${JSON.stringify(s.legal)}`,
        '星不够（short=yes）必须同时 legal=no —— 否则玩家点了也打不出去'));
    }
    if (!String(s.cls || '').includes('b3-slot--grey')) {
      out.push(P(`星不够的格子${who}没有灰置`, `class=${JSON.stringify(s.cls)}`,
        '要带 class b3-slot--grey（设计稿是整格 0.6 透明）'));
    }
    if (s.action !== null && s.action !== undefined) {
      out.push(P(`星不够的格子${who}仍可点`, `data-b3-action=${JSON.stringify(s.action)}`,
        '不许带 data-b3-action（可点性由引擎合法动作决定）'));
    }
    if (reds.length && s.color && !reds.includes(s.color)) {
      out.push(P(`星不够的格子${who}的 ⭐ 没有标红`, `computed color=${JSON.stringify(s.color)}`,
        `要变成 ${reds.join(' 或 ')}（var(--b3-red)）`));
    }
  }
  return out;
}

/** 纯函数判据：facts → problems[]（每条是一行可打印文本，带判据 id 前缀）。 */
function feedbackProblems(facts) {
  return feedbackFindings(facts).flatMap((row) => row.problems.map((p) =>
    `[${row.id} ${row.name}] ${p.text}（实际值：${p.actual}；缺：${p.missing}）`));
}

// ── J7 背包屏数字（纯函数；人类 2026-09-25 决策 4「（甲）读法」）──────────────
/**
 * 前提取自人类原话：「『愿力强化物品』每局可用 2 次 · 冷却 3 回合 · 不占行动；
 * 首领化一样不占行动…这是我确认过的！！以我为准」 ⇒ **数字允许显示，但必须来自引擎或已登记证据；
 * 没登记才不许写数字。** 判据本体（逐字）：
 *
 *   ① 背包屏里出现的**每一个**数字，都必须能在「收据」里找到同值出处；
 *   ② 该显示的数字（剩余次数、每局次数、冷却回合）**必须真的显示出来**（删掉也要红）；
 *   ③ 声明成「引擎实数」的字段，必须与页面当下读到的引擎值**逐字相等**。
 *
 * 收据只认两种来源（其余一律算「没登记」）：
 *   · **引擎给的实数** —— `window.rocoDemo.state.view.self.magic.{uses_left,cooldown,swapped}`
 *     （字段名 2026-09-25 在本仓真页面上量出来的；`view.legal[]` 里那条 `kind=magic` 只有
 *     `{kind,label,magic_id,skill,item_id,target_index,...}`，**没有**次数/冷却字段）；
 *   · **已登记证据** —— `data/roco/derived/pvp-magic.json` 的 `magic.per_battle_uses:2` /
 *     `magic.cooldown_turns:3`（同一条目的 `wish_impact.energy/power` 也算，同一份产物同一条证据）。
 *
 * ⚠ 这里**不**读页面上的 `data-b3-src` / HTML 里的静态样例文案（那是样例，不是收据）。
 *
 * 输入契约（`facts.itemPanel`，与 `browser-battle-v3-acceptance.mjs` 的 `f.item` 同一套读法）：
 *   `{count, panelFound, text, cellCounts[], cellNotes[], engineFacts:{usesLeft,cooldown,swappedCount},
 *     registered:{ok,per_battle_uses,cooldown_turns}, fieldAudit}`
 */
function itemPanelNumberProblems(facts) {
  const P = (text, actual, missing) => ({text, actual, missing});
  const panel = (facts ?? {}).itemPanel ?? {};
  const text = String(panel.text ?? '');
  const eng = panel.engineFacts ?? {};
  const reg = panel.registered ?? {};
  const trace = [];
  if (!panel.count) {
    return [P('背包屏没有可检的文案（缺 `data-b3-item-cell`）',
      `panelFound=${JSON.stringify(panel.panelFound ?? null)}；count=${JSON.stringify(panel.count ?? null)}`,
      '背包格（`data-b3-item-cell`）+ 可读的格子文案')];
  }

  // 收据：每条 = {value, src}；src 写明出处，报告里原样给出
  const receipts = [];
  const add = (value, src) => { if (Number.isFinite(Number(value))) receipts.push({value: Number(value), src}); };
  if (reg.ok) {
    add(reg.per_battle_uses, `${reg.file ?? 'data/roco/derived/pvp-magic.json'}#magic.per_battle_uses（已登记证据）`);
    add(reg.cooldown_turns, `${reg.file ?? 'data/roco/derived/pvp-magic.json'}#magic.cooldown_turns（已登记证据）`);
    add(reg.wish_impact?.energy, `${reg.file ?? 'data/roco/derived/pvp-magic.json'}#magic.wish_impact.energy（已登记证据）`);
    add(reg.wish_impact?.power, `${reg.file ?? 'data/roco/derived/pvp-magic.json'}#magic.wish_impact.power（已登记证据）`);
  } else {
    trace.push(`已登记证据读不到（${reg.file ?? 'data/roco/derived/pvp-magic.json'}：${reg.error ?? '未知错误'}）`);
  }
  add(eng.usesLeft, 'view.self.magic.uses_left（引擎实数）');
  add(eng.cooldown, 'view.self.magic.cooldown（引擎实数）');
  add(eng.swappedCount, 'view.self.magic.swapped（引擎实数）');

  // 页面文案里的数字（阿拉伯数字）
  const nums = [...text.matchAll(/\d{1,4}/g)].map((m) => ({value: Number(m[0]), at: m.index ?? 0, raw: m[0]}));
  const pool = nums.slice();
  const take = (value) => {
    const i = pool.findIndex((n) => n.value === Number(value));
    if (i < 0) return false;
    pool.splice(i, 1);
    return true;
  };

  // ② 该显示的必须显示
  const declared = [
    {label: '剩余次数（引擎实数 view.self.magic.uses_left）', value: eng.usesLeft},
    {label: '每局次数（已登记 per_battle_uses）', value: reg.per_battle_uses},
    {label: '冷却回合（已登记 cooldown_turns）', value: reg.cooldown_turns},
  ].filter((d) => Number.isFinite(Number(d.value)))
    .map((d) => ({...d, matched: take(d.value)}));
  for (const r of receipts) take(r.value);
  const missing = declared.filter((d) => !d.matched).map((d) => `${d.label} = ${d.value}`);

  // ① 剩下的数字必须能在收据里找到同值出处
  const registeredValues = new Set(receipts.map((r) => r.value));
  const unregistered = pool.filter((n) => !registeredValues.has(n.value));

  // ③ 「引擎实数」不许与页面读到的数字打架：声明来源是引擎的字段，文案里配到的实例必须同值
  //    （上面 take() 已经按同值配对，这里给出人读的证据）
  const problems = [];
  if (unregistered.length) {
    problems.push(P(`背包屏出现**没有登记出处**的数字 ${unregistered.length} 处：`
      + `${unregistered.map((n) => `「${n.raw}」`).join('、')}`,
    `原文片段「${oneLine(text.slice(Math.max(0, (unregistered[0]?.at ?? 0) - 24), (unregistered[0]?.at ?? 0) + 24), 80)}」；`
      + `可追溯的数字只有 ${JSON.stringify([...registeredValues])}`,
    '每个数字都要有出处：`data/roco/derived/pvp-magic.json` 的 per_battle_uses/cooldown_turns，'
      + '或引擎实数 `view.self.magic.uses_left/cooldown`'));
  }
  if (missing.length) {
    problems.push(P(`该显示的数字没显示：${missing.join('、')}`,
      `原文「${oneLine(text, 160)}」；文案里的数字实例 ${JSON.stringify(nums.map((n) => n.raw))}`,
      '剩余次数与冷却必须显示（来自引擎实数 / 已登记证据），不许删掉当「没有数字」'));
  }
  trace.push(`收据 ${receipts.length} 条：${JSON.stringify(receipts.map((r) => `${r.value}←${String(r.src).split('（')[0]}`))}`);
  trace.push(`文案数字 ${nums.length} 个：${JSON.stringify(nums.map((n) => n.raw))}`);
  if (panel.fieldAudit) trace.push(`读点字段：${JSON.stringify(panel.fieldAudit)}`);
  return problems.map((p) => ({...p, actual: `${p.actual}；${trace.join('；')}`}));
}

// ── J9 自由动作不占行动（纯函数；人类 2026-09-25「愿力强化不占行动、背包物品都不占行动」）──
/**
 * 判据本体（五条，**全部必须成立，缺一即红**）。前提取自人类原话：
 * 「愿力强化不占行动，就是这样，背包物品都不占行动」「不占行动，自由动作，然后再返回背包
 *  使用一次能解除这个变招状态，不恢复消耗次数，进入「愿力强化」3 回合冷却」
 * 「『愿力冲击』就是个技能，**这个算行动**」。
 *
 *   ① 用掉之后 **`view.turn` 不变**（这正是「不占行动」的定义）；
 *   ② `view.state_version` **前进**（引擎真的结算了这一下，不是页面在装样子）；
 *   ③ 用掉之后**技能屏仍有可点技能格**（`[data-b3-slot-legal="yes"][data-b3-action]` ≥ 1）
 *      —— 玩家这一回合还能照常出招；
 *   ④ `view.self.magic.uses_left` **恰好 -1**；
 *   ⑤ `view.self.magic.cooldown` **等于已登记值**（`data/roco/derived/pvp-magic.json` 的
 *      `magic.cooldown_turns`，**不写字面量**；读不到登记值 ⇒ 判红，不许回落成 3）。
 *   ⑥（同一条判据的后半段）再真鼠标点一个合法技能格之后，`turn` **恰好 +1** —— 证明
 *      「愿力冲击 / 技能照常占行动」。
 *
 * ⚠ 「量不到 ≠ 量到了」：没进战斗 / 找不到可用的愿力强化那一格 / 点不动 / 读不到引擎事实 /
 * 登记值读不到，**一律判红**并把原因写进 problems 与 actual（与 J6/J7/J8 同一套口径）。
 *
 * 输入契约（`facts.freeAction`，真页面与合成夹具共用）：
 *   `{ok, failReason, before:{turn,version,usesLeft,cooldown,clickableSkills},
 *     after:{turn,version,usesLeft,cooldown,clickableSkills}, turnAfterSkill,
 *     registered:{ok, cooldown_turns, per_battle_uses}}`
 */
function freeActionProblems(fa) {
  const P = (text, actual, missing) => ({text, actual, missing});
  if (!fa || typeof fa !== 'object') {
    return [P('没采到「自由动作」事实', `freeAction=${JSON.stringify(fa)}`,
      '真鼠标点背包里的愿力强化那一格，并读 view 前后')];
  }
  if (fa.failReason) {
    return [P(`自由动作**量不到** —— 读不到就不算验过：${oneLine(fa.failReason, 200)}`,
      `failReason=${JSON.stringify(fa.failReason)}`, '要能真鼠标点到愿力强化那一格并读到 view 前后')];
  }
  const problems = [];
  const before = fa.before ?? null;
  const after = fa.after ?? null;
  if (!before || !after) {
    return [P('自由动作事实缺 `before` / `after` 读数', `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
      '前后各一次 view 读数（turn / state_version / uses_left / cooldown / 可点技能格）')];
  }
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const bTurn = num(before.turn); const aTurn = num(after.turn);
  const bVer = num(before.version); const aVer = num(after.version);
  const bUse = num(before.usesLeft); const aUse = num(after.usesLeft);
  const aCool = num(after.cooldown);
  const aClick = num(after.clickableSkills);
  const regCool = num(fa.registered?.cooldown_turns);
  const regUses = num(fa.registered?.per_battle_uses);
  const tail = `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
  // ① 回合不变
  if (bTurn === null || aTurn === null) {
    problems.push(P('读不到回合数（`view.turn` 不是有限数）', tail, '`view.turn` 必须是整数'));
  } else if (aTurn !== bTurn) {
    problems.push(P(`用掉背包物品之后回合变了：${bTurn} → ${aTurn}（人类口径：**不占行动** ⇒ 必须不变）`,
      tail, '`view.turn` 在自由动作前后必须相同'));
  }
  // ② state_version 前进
  if (bVer === null || aVer === null) {
    problems.push(P('读不到 `view.state_version`', tail, '`state_version` 必须是整数'));
  } else if (!(aVer > bVer)) {
    problems.push(P(`引擎没有真的结算这一下：state_version ${bVer} → ${aVer}（必须前进）`,
      tail, '自由动作要真的走引擎（state_version 前进），不是页面装样子'));
  }
  // ③ 仍可出招
  if (aClick === null) {
    problems.push(P('读不到「可点技能格」计数', tail, '要数 `[data-b3-slot-legal="yes"][data-b3-action]`'));
  } else if (aClick < 1) {
    problems.push(P('用掉背包物品之后一个可点技能格都没有（玩家这一回合被吃掉了）',
      `after.clickableSkills=${aClick}`, '不占行动 ⇒ 用完仍应能照常出一手技能（≥1 个可点技能格）'));
  }
  // ④ 次数恰好 -1
  if (bUse === null || aUse === null) {
    problems.push(P('读不到 `view.self.magic.uses_left`', tail, '引擎公开视图里应有 uses_left'));
  } else if (aUse !== bUse - 1) {
    problems.push(P(`剩余次数变化不对：${bUse} → ${aUse}（要恰好 -1）`, tail, '用一次扣一次'));
  }
  // ⑤ 冷却 == 已登记值（读不到登记值 ⇒ 判红，不回落成字面量）
  if (regCool === null) {
    problems.push(P('读不到**已登记**的冷却值（`data/roco/derived/pvp-magic.json#magic.cooldown_turns`）',
      `registered=${JSON.stringify(fa.registered ?? null)}`, '判据不许写死 3：登记值读不到就按「没有依据」判红'));
  } else if (aCool === null) {
    problems.push(P('读不到 `view.self.magic.cooldown`', tail, '引擎公开视图里应有 cooldown'));
  } else if (aCool !== regCool) {
    problems.push(P(`冷却不是登记值：实测 ${aCool}，登记 ${regCool}`, tail,
      `用掉之后 cooldown 必须等于已登记的 cooldown_turns（${regCool}）`));
  }
  if (regUses !== null && bUse !== null && bUse > regUses) {
    problems.push(P(`用之前剩余次数 ${bUse} 超过了登记的每局次数 ${regUses}`, tail, '次数上限来自登记值'));
  }
  // ⑥ 技能照常占行动（turn +1）
  const tSkill = num(fa.turnAfterSkill);
  if (tSkill === null) {
    problems.push(P('没读到「再出一手技能之后」的回合数', `turnAfterSkill=${JSON.stringify(fa.turnAfterSkill)}`,
      '自由动作之后要再真鼠标点一个合法技能格，并读 turn'));
  } else if (aTurn !== null && tSkill !== aTurn + 1) {
    problems.push(P(`技能没有照常占行动：自由动作后 turn=${aTurn}，出一手技能后 turn=${tSkill}（要 +1）`,
      tail, '人类口径：「愿力冲击」就是个技能，用它照常占一手'));
  }
  return problems;
}

// ── J10 生命心 ♥ 常显（纯函数；人类 2026-09-25「战斗页顶部的生命心要一直看得见」）──────
/**
 * 一条读数的判据（**纯函数**）：DOM 画出来的心 vs **同一时刻**引擎回执里的 `view.mana`。
 *
 * 口径（**心 = 魔力**，同一个量的两种叫法，字段是 `view.mana.{self,opponent,pool}`）：
 *   · 引擎给了（`self` / `opponent` / `pool` 都是有限数、`pool > 0`）⇒ 两侧心形计数**必须可见**，
 *     实心数**逐位等于** `view.mana.{self,opponent}`，心形总数**等于** `view.mana.pool`
 *     —— `pool` 从**回执**读，判据里**不写字面量 4**（写死 4 就等于判据自己也在编规则）；
 *   · 引擎没给（缺键 / null / 不是有限数 / `pool ≤ 0`）⇒ 两侧**必须 hidden**，且页面上**不许有心形字符**
 *     —— 拿不到还画 4 颗就是「硬写 4 颗」，这条必须红（fail closed）。
 *
 * 输入契约（`facts.hearts` 的每一份读数，真页面与合成夹具共用）：
 *   `{engine:{mana,turn,phase,stateVersion}, dom:{self:{found,hidden,visible,full,empty,total,text,html},
 *     foe:{…}}, bodyHearts, at}`
 */
function heartsReadProblems(label, sample) {
  const P = (text, actual, missing) => ({text, actual, missing});
  const bad = [];
  const dom = sample?.dom ?? {};
  const mana = sample?.engine?.mana ?? null;
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const m = {self: num(mana?.self), opponent: num(mana?.opponent), pool: num(mana?.pool)};
  const known = m.self !== null && m.opponent !== null && m.pool !== null && m.pool > 0;
  const tail = `${label}：引擎 view.mana=${JSON.stringify(mana)}；DOM self=${JSON.stringify(dom.self ?? null)}`
    + ` foe=${JSON.stringify(dom.foe ?? null)}`;
  for (const [side, who] of [['self', '我方'], ['foe', '对手']]) {
    const el = dom[side] ?? null;
    if (el?.found !== true) {
      bad.push(P(`${label}：${who}的心形计数元素在页面上不存在（\`#b3-hearts-${side}\`）`,
        tail, '顶栏两侧各有一个心形计数元素（`b3-hearts-self` / `b3-hearts-foe`）'));
      continue;
    }
    if (!known) {
      if (el.hidden !== true || el.visible === true) {
        bad.push(P(`${label}：引擎没给 mana（${JSON.stringify(mana)}），${who}的心形计数却显示着`
          + `（hidden=${JSON.stringify(el.hidden)} 可见=${JSON.stringify(el.visible)} `
          + `原文「${oneLine(el.text ?? '', 40)}」）—— **绝不硬写 4 颗**`,
        tail, '拿不到 mana ⇒ 必须 hidden（不编、不补 4）'));
      }
      continue;
    }
    const want = side === 'self' ? m.self : m.opponent;
    // 引擎那一侧的**真字段名**（页面这一侧叫 foe，引擎叫 opponent —— 报错原文里必须写引擎的名字）
    const field = side === 'self' ? 'self' : 'opponent';
    if (el.hidden === true || el.visible !== true) {
      bad.push(P(`${label}：引擎给了 mana=${JSON.stringify(mana)}，${who}的心形计数却是收起的`
        + `（hidden=${JSON.stringify(el.hidden)} 可见=${JSON.stringify(el.visible)}）`,
      tail, '心要**常显**：引擎给了 mana 就必须看得见'));
    }
    if (el.full !== want) {
      bad.push(P(`${label}：${who}的实心数 ${JSON.stringify(el.full)} ≠ 引擎 view.mana.${field} ${want}`,
        tail, '实心数必须逐位等于引擎给的当前心数（页面不许自己算）'));
    }
    if (el.total !== m.pool) {
      bad.push(P(`${label}：${who}的心形总数 ${JSON.stringify(el.total)} ≠ 引擎 view.mana.pool ${m.pool}`,
        tail, '心形总数必须等于引擎给的 pool（从回执读，判据不写字面量）'));
    }
  }
  if (!known && Number(sample?.bodyHearts ?? 0) > 0) {
    bad.push(P(`${label}：引擎没给 mana，页面上却还有 ${sample.bodyHearts} 个心形字符`
      + `（凭空画出来的心计数器）`, tail, '没有 mana 就不该有任何心形字符'));
  }
  return bad;
}

/**
 * J10 的聚合判据（**纯函数**）：三份读数各判一次，缺一份就判红。
 *
 *   ① `initial`   开局后（常显）：与 `view.mana` 逐位一致（== 判据 ①）；
 *   ② `faint`     力竭掉心后：与**那一步**的 `view.mana` 逐位一致，且相对掉心前**恰好 -1**（判据 ②）；
 *   ③ `missingManaProbe` 抽掉 `state.view.mana` 再 `render()`（合成「引擎没给」）：两侧必须 hidden、
 *      页面上不许有心形字符（判据 ③）。
 *
 * ⚠ 「量不到 ≠ 量到了」：没进战斗 / 推不到力竭 / 探针没做 / 读不到引擎事实，**一律判红**并把原因
 * 写进 problems 与 actual（与 J6/J7/J8/J9 同一套口径）。
 * ⚠ 走 legacy 回落路径（那一局的规则配置**本来就没声明 mana**）时：① 与 ② 如实判红并写清原因
 * —— 不是页面错，而是**这一轮没有可对照的引擎回执**，读不到就不算验过；③ 仍然照验。
 */
function heartsProblems(h) {
  const P = (text, actual, missing) => ({text, actual, missing});
  if (!h || typeof h !== 'object') {
    return [P('没采到「生命心常显」事实', `hearts=${JSON.stringify(h)}`,
      '真战斗页顶栏两侧心形计数的 DOM 原文 + 同一时刻的 `view.mana`')];
  }
  if (h.failReason) {
    return [P(`生命心常显**量不到** —— 读不到就不算验过：${oneLine(h.failReason, 200)}`,
      `failReason=${JSON.stringify(h.failReason)}`, '要能在真战斗页读到两侧心形计数与同一时刻的 `view.mana`')];
  }
  const problems = [];
  const initial = h.initial ?? null;
  const faint = h.faint ?? null;
  const probe = h.missingManaProbe ?? null;
  // ① 开局后常显
  if (!initial) {
    problems.push(P('没采到「开局后」那一份读数', `initial=${JSON.stringify(initial)}`,
      '真鼠标进战斗之后立刻读一次 DOM + `view.mana`'));
  } else {
    problems.push(...heartsReadProblems('开局后', initial));
  }
  // ② 力竭掉心 -1 且与引擎逐位一致
  if (!faint || faint.found !== true) {
    problems.push(P('没推到位：这一轮没有采到**引擎自己报出的一次力竭**（`events[].kind===\'mana_loss\'`）',
      `faint=${JSON.stringify(faint)}`,
      '真鼠标连出合法技能格把局面推到一次力竭（掉心），再读一次 DOM + `view.mana`'));
  } else {
    const before = faint.before ?? null;
    const after = faint.after ?? null;
    if (!after) {
      problems.push(P('力竭那一步之后没有读数', `faint=${JSON.stringify(faint)}`,
        '掉心之后要再读一份 DOM + `view.mana`'));
    } else {
      problems.push(...heartsReadProblems('力竭掉心后', after));
    }
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    // 引擎把 `side` 放在事件的 **`detail.side`** 里（`env.py::_bump(state, 'mana_loss', {'side': …, …})`），
    // 服务端只把顶层 `side` 搬出来（那一个键是 null）⇒ 两处都认，别只认顶层。
    const rawSide = faint.event?.side ?? faint.event?.detail?.side ?? null;
    const side = rawSide === 'player' ? 'self' : (rawSide === 'enemy' ? 'opponent' : null);
    const b = num(before?.engine?.mana?.[side ?? 'self']);
    const a = num(after?.engine?.mana?.[side ?? 'self']);
    const bDom = num(before?.dom?.[side === 'opponent' ? 'foe' : 'self']?.full);
    const aDom = num(after?.dom?.[side === 'opponent' ? 'foe' : 'self']?.full);
    if (side === null) {
      problems.push(P(`力竭事件没给出可对照的一方（\`side\` 实际 ${JSON.stringify(rawSide)}）`,
        `event=${JSON.stringify(faint.event ?? null)}`,
        '引擎的 `mana_loss` 事件应带 `side: player|enemy`（顶层或 `detail.side`）'));
    } else if (b === null || a === null || bDom === null || aDom === null) {
      problems.push(P('掉心前后的读数不完整（引擎 mana 或 DOM 实心数读不到）',
        `side=${side} 引擎 ${JSON.stringify(b)}→${JSON.stringify(a)}；DOM 实心 ${JSON.stringify(bDom)}→${JSON.stringify(aDom)}`,
        '掉心前后各一份 `view.mana` 与 DOM 实心数'));
    } else {
      if (a !== b - 1) {
        problems.push(P(`引擎那一侧的心数不是恰好 -1：${b} → ${a}（力竭扣心；判据要的就是 -1）`,
          `side=${side}；事件 ${JSON.stringify(faint.event ?? null)}`,
          '一次力竭扣一颗心（`mana.faint_cost=1`）⇒ 引擎回执应为 -1'));
      }
      if (aDom !== a) {
        problems.push(P(`掉心后 DOM 的实心数 ${aDom} ≠ 引擎同一时刻给的 ${a}（必须逐位一致）`,
          `side=${side}；引擎 ${JSON.stringify(after?.engine?.mana ?? null)}；DOM ${JSON.stringify(after?.dom?.[side === 'opponent' ? 'foe' : 'self'] ?? null)}`,
          '页面画的心必须就是引擎回执里的那个数'));
      }
      if (aDom - bDom !== -1) {
        problems.push(P(`掉心前后 DOM 的实心数不是 -1：${bDom} → ${aDom}`,
          `side=${side}；引擎 ${b} → ${a}`, '力竭一次，心形实心数少一颗（空心多一颗）'));
      }
    }
  }
  // ③ 拿不到 mana 时必须 hidden
  if (!probe || probe.taken !== true) {
    problems.push(P('没做「拿不到 mana」的探针：抽掉 `state.view.mana` 再 `render()` 之后没有读数',
      `missingManaProbe=${JSON.stringify(probe)}`,
      '把 `state.view.mana` 抽掉后 `render()` 一次 → 两侧心形计数必须 hidden（fail closed），随后还原'));
  } else {
    problems.push(...heartsReadProblems('抽掉 mana 后', probe.after));
  }
  return problems;
}

// ── J8 立绘框底边接缝（纯函数；人类 2026-09-25 决策 1「把接缝压掉」）─────────────
/**
 * 人类 2026-09-25 决策 1：「立绘框底边横线要处理（把接缝压掉）」。
 * 修法在 `src/client/battle-v3.css` 末尾：`.b3-spritebox{border-bottom-color:var(--b3-panel)}`
 * + `::after` 底衬 34px + `.b3-sprite` 底边 32px 渐隐（**零几何位移**：边框宽度/盒模型/三列不动）。
 *
 * 判据本体（两条，**都必须成立，缺一即红**），全部从**整页截图的像素**里量
 * （deviceScaleFactor=1 ⇒ 客户区坐标 == 页面坐标，可以直接按 rect 取像素）：
 *   ① 框底那一行（`y = rect.bottom - 1`，那 1px 画框底边）与**上一行**的平均跳变 ≤ 6；
 *   ② **跨框底那一步**的 |Δ亮度|（框底那一行的行均色 vs 它下一行的行均色）≤ 3。
 *
 * ⚠ 「量不到 ≠ 量到了」：没截图 / rect 为 0 / rect 越出图外 / 坐标映射不成立（dpr≠1 或图尺寸对不上
 * 客户区）时**一律判红**，并把原因写进 actual —— 与 J6「本轮没触发」、J7「没采到背包屏」同一套口径。
 *
 * 输入契约（`facts.seam.{self,foe}`，真页面与合成夹具共用；`img` 是 `readPng()` 解出来的解码图）：
 *   `{side:'self'|'foe', box:{x,y,w,h,bottom,right}|null, img:{w,h,rgba}|null,
 *     shot:'battle-feedback/xx.png'|null, viewport:{w,h,dpr}|null, reason}`
 * `foe` 可缺（本轮页面上没有对手立绘框就不量）；`self` 缺 = 判红。
 */
function seamSideRead(fact) {
  const f = fact && typeof fact === 'object' ? fact : {};
  const box = f.box ?? null;
  const img = f.img ?? null;
  const shot = f.shot ? String(f.shot) : null;
  const why = oneLine(f.reason ?? '未知', 200);
  const base = {box, shot, reason: null};
  if (!shot || !img) {
    return {...base, ok: false, metrics: null,
      reason: `没有可判的整页截图（shot=${JSON.stringify(shot)}；图=${img ? `${img.w}×${img.h}` : 'null'}；原因：${why}）`};
  }
  if (!box || !(Number(box.w) > 0) || !(Number(box.h) > 0) || !(Number(box.bottom) > 0)) {
    return {...base, ok: false, metrics: null,
      reason: `立绘框 rect 为 0 / 不存在（rect=${JSON.stringify(box)}；原因：${why}）`};
  }
  const vp = f.viewport ?? null;
  if (vp && (Number(vp.dpr) !== 1 || Number(vp.w) !== Number(img.w) || Number(vp.h) !== Number(img.h))) {
    return {...base, ok: false, metrics: null,
      reason: `坐标映射不成立：图 ${img.w}×${img.h} vs 客户区 ${vp.w}×${vp.h}（deviceScaleFactor=${vp.dpr}）`
        + '—— 只有 dpr=1 且图尺寸==客户区时，rect 才能直接当像素坐标用'};
  }
  // 取像素前先确认取样窗口真的落在图里（越界会读出 undefined → NaN，那种「量不到」不许当成「通过」）
  const x0 = box.x + 8, x1 = box.x + box.w - 8;
  const yTop = box.bottom - 26, yBot = box.bottom + 2;
  if (!(x0 >= 0 && x1 <= img.w && yTop >= 0 && yBot < img.h)) {
    return {...base, ok: false, metrics: null,
      reason: `rect 超出整页截图边界（rect=${JSON.stringify(box)}；图 ${img.w}×${img.h}；`
        + `取样 x∈[${x0},${x1})、y∈[${yTop},${yBot}]）`};
  }
  let metrics = null;
  try {
    metrics = seamMetrics(img, box);
  } catch (error) {
    return {...base, ok: false, metrics: null,
      reason: `读像素时出错（seamMetrics 抛出：${oneLine(error?.message ?? error, 140)}）`};
  }
  if (!Number.isFinite(metrics?.borderJump) || !Number.isFinite(metrics?.stepAcrossBottom)) {
    return {...base, ok: false, metrics: null,
      reason: `像素读出来不是有限数（borderJump=${metrics?.borderJump} stepAcrossBottom=${metrics?.stepAcrossBottom}）`};
  }
  return {...base, ok: true, metrics};
}

/** J8 的纯函数判据：一份事实（rect + 解码后的图）→ problems[]。 */
function seamSideProblems(fact) {
  const P = (text, actual, missing) => ({text, actual, missing});
  const f = fact && typeof fact === 'object' ? fact : {};
  const who = f.side === 'foe' ? '对手' : '我方';
  const tag = `${who}立绘框底边接缝`;
  const read = seamSideRead(fact);
  if (!read.ok) {
    return [P(`${tag}**量不到** —— 读不到就不算验过：${read.reason}`,
      `rect=${JSON.stringify(read.box ?? null)}；整页截图=${JSON.stringify(read.shot ?? null)}`,
      `整页 PNG（\`Page.captureScreenshot {format:'png'}\`，deviceScaleFactor=1）里 ${tag} 的像素：`
        + `① 框底那一行与上一行的平均跳变 ≤ ${SEAM_BORDER_JUMP_MAX}；`
        + `② 跨框底那一步的 |Δ亮度| ≤ ${SEAM_STEP_MAX}`)];
  }
  const m = read.metrics;
  const lines = `框底往上 26px 逐行跳变=${JSON.stringify(m.rows.map((r) => `${r.y}:${r.jump}`))}`;
  const problems = [];
  if (!(m.borderJump <= SEAM_BORDER_JUMP_MAX)) {
    problems.push(P(`${tag}：框底那一行（y=${m.border}）还有一条硬横线`,
      `borderJump=${fmt(m.borderJump)}（阈值 ≤ ${SEAM_BORDER_JUMP_MAX}）；框底那一行均色=${m.borderMean}；${lines}`,
      `框底那一行与上一行的平均跳变 ≤ ${SEAM_BORDER_JUMP_MAX}（把接缝压掉：`
        + '`.b3-spritebox{border-bottom-color:var(--b3-panel)}` + `::after` 底衬 + `.b3-sprite` 底边渐隐）'));
  }
  if (!(m.stepAcrossBottom <= SEAM_STEP_MAX)) {
    problems.push(P(`${tag}：跨框底那一步还没压平（框底比卡片底色亮/暗一档）`,
      `stepAcrossBottom=${fmt(m.stepAcrossBottom)}（阈值 ≤ ${SEAM_STEP_MAX}）；框底那一行均色=${m.borderMean}；`
        + `框内最大行跳变=${fmt(m.innerMaxJump)}`,
      `跨框底那一步的 |Δ亮度| ≤ ${SEAM_STEP_MAX}（框底那一行要落进卡片底色 \`var(--b3-panel)\`，`
        + '不是纯 transparent —— 透明会露出画框自己的深色渐变，仍是一条暗线）'));
  }
  return problems;
}

/** J8 的聚合判据：`facts.seam`（我方必有、对手有就量）→ problems[]。 */
function seamProblems(facts) {
  const P = (text, actual, missing) => ({text, actual, missing});
  const seam = (facts ?? {}).seam ?? null;
  if (!seam || typeof seam !== 'object') {
    return [P('立绘框底边接缝**量不到** —— 读不到就不算验过：这一跑根本没采到接缝事实（没截图 / 没量 rect）',
      `seam=${JSON.stringify(seam ?? null)}`,
      '真鼠标进战斗后立刻 `Page.captureScreenshot {format:"png"}`（整页）+ `[data-b3-self-card]` 里 '
        + '`[data-b3-spritebox]` 的 rect')];
  }
  const out = [];
  if (!seam.self) {
    out.push(P('我方立绘框底边接缝**量不到** —— 读不到就不算验过：没采到我方立绘框的事实',
      `self=${JSON.stringify(seam.self ?? null)}；原因=${oneLine(seam.selfReason ?? '未知', 200)}`,
      '`[data-b3-self-card]` 里的 `[data-b3-spritebox]`（回落 `.b3-free`）的 rect 非零'));
  } else {
    out.push(...seamSideProblems(seam.self));
  }
  // 对手侧**可选**：页面上有对手立绘框就一并量（量不到照样判红）；没有就不编。
  if (seam.foe) out.push(...seamSideProblems(seam.foe));
  return out;
}

/**
 * 合成一份「立绘框底边接缝」事实（**只给合成基线与反证用**，不读磁盘、不碰浏览器）。
 *
 * 三档：
 *   · `smooth`（健康）：框内最后 32px 从立绘灰**渐隐到卡片底色**（就是 CSS 修复干的事，
 *     改后实测 `borderJump=0.8 / stepAcrossBottom=0.0`）→ J8 两条都必须过；
 *   · `hard`（等价于把修复回退）：复刻改前那三行的实测色 —— `y=bottom-2` 立绘自己的地面
 *     `rgb(81,82,85)`、`y=bottom-1` 画框那条 **1px 实线底边 `rgb(36,52,68)`**、`y=bottom` 起
 *     卡片底色 `rgb(17,28,38)` → 跨框底一步算出来 |Δ亮度| = **23.4**，与主线程改前实测**逐位相同**；
 *   · `zero-rect`：rect 全 0（元素在但量不到）→ J8 必须报「量不到」。
 */
function seamSyntheticFact(mode, side = 'self') {
  const w = 160, h = 120;
  const zero = mode === 'zero-rect';
  const box = zero ? {x: 0, y: 0, w: 0, h: 0, bottom: 0, right: 0}
    : {x: 20, y: 20, w: 100, h: 70, bottom: 90, right: 120};
  const rgba = Buffer.alloc(w * h * 4);
  const panel = [17, 28, 38];    // --b3-panel（卡片底色，实测 rgb(17,28,38)）
  const ground = [81, 82, 85];   // 改前 y=714：立绘图里自己画的地面那块中灰（实测）
  const hardLine = [36, 52, 68]; // 改前 y=715：画框那条 1px 实线底边（实测）
  const put = (x, y, [r, g, b]) => { const i = (y * w + x) * 4; rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const inBox = !zero && y >= box.y && y < box.bottom && x >= box.x && x < box.x + box.w;
      if (!inBox) { put(x, y, panel); continue; }
      if (mode === 'hard') { put(x, y, y === box.bottom - 1 ? hardLine : ground); continue; }
      // smooth：框内最后 32px 线性渐隐到卡片底色（修法的 `.b3-sprite` 32px mask + `::after` 底衬）
      const fade = Math.min(1, Math.max(0, (y - (box.bottom - 32)) / 31));
      put(x, y, panel.map((p, i) => Math.round(ground[i] + (p - ground[i]) * fade)));
    }
  }
  return {side, box, img: {w, h, rgba}, shot: 'battle-feedback/synthetic-seam.png',
    viewport: {w, h, dpr: 1},
    reason: zero ? '合成反证：rect 全 0（元素在但量不到）' : `合成事实（mode=${mode}）`};
}

// ── 合成基线（判据的输入契约；也是「不把好状态判红」的证据）────────────────────
function baselineFacts() {
  const sample = (t, opts = {}) => ({id: 'f1', text: '-30', side: 'foe', t, cx: 1030, cy: 300, w: 46, h: 24,
    inViewport: true, measurable: true, hitClass: 'b3-float b3-float--hit', hitTag: 'span',
    hitIsFloat: true, source: 'raf', ...opts});
  const liveFrame = (t) => ({t, live: [sample(t)]});
  return {
    battleStarted: true,
    legalSkills: 4,
    finalFloatCount: 0,
    precondition: {pageReady: 'yes', battlePanelVisible: true, clickableSlots: 4, slotClickable: true,
      clickAccepted: true, attempts: 1,
      entryPath: '真鼠标点「开一局（标准 PVP · 六宠）」',
      skill: {label: '烈焰冲撞', category: 'attack', damage: 30, slot: 1}},
    errors: {pageExceptions: 0, consoleErrors: 0, pageExceptionSamples: [], consoleErrorSamples: []},
    timeline: [
      // 出手方（self）先在 t=100 给出动作线索：前冲 + 动作立绘 + variant=action
      {t: 100, kind: 'cue', side: 'self', detail: {role: 'attack', what: '.b3-attack'}},
      {t: 104, kind: 'cue', side: 'self', detail: {role: 'attack', what: 'data-b3-variant=action'}},
      {t: 106, kind: 'cue', side: 'self', detail: {role: 'attack', what: 'sprite src → action 立绘'}},
      // 受击方（foe）随后才出现：浮字 + 抖动（Δ=160ms ≥ 100ms）
      {t: 260, kind: 'float', side: 'foe', detail: {role: 'float', floatId: 'f1', text: '-30',
        classes: 'b3-float b3-float--hit'}},
      {t: 262, kind: 'cue', side: 'foe', detail: {role: 'hit', what: '.b3-hit'}},
      {t: 1160, kind: 'float-gone', side: 'foe', detail: {role: 'float-gone', floatId: 'f1', aliveMs: 900}},
    ],
    floats: [
      {id: 'f1', text: '-30', side: 'foe', bornT: 260, goneT: 1160, aliveMs: 900, removed: true,
        classes: 'b3-float b3-float--hit', rect: {w: 46, h: 24, cx: 1030, cy: 300},
        samples: [sample(280), sample(420), sample(560), sample(700), sample(840), sample(980)],
        sampleCount: 6, measurableSamples: 6, onTopSamples: 6, hitClasses: ['b3-float b3-float--hit']},
    ],
    frames: [liveFrame(280), liveFrame(420), liveFrame(560), liveFrame(700)],
    // J7 的输入契约（合成基线这一份的健康形状）：面板原文 + 引擎实数 + 已登记证据。
    // 原文用的是**真页面上量到的**那一串（2026-09-25）：标题「2 / 2」= 引擎 uses_left / 已登记 per_battle_uses，
    // 说明「每局 2 次 · 冷却 3 回合」= 已登记证据的 per_battle_uses / cooldown_turns。
    itemPanel: {
      count: 2, panelFound: true, cellCounts: ['2 / 2', '不可用'],
      cellNotes: ['每局 2 次 · 冷却 3 回合 · 占一次行动', '需要「首领血脉」，本版未做'],
      text: '愿力强化 2 / 2 候选 · 未核验：说明未登记。 每局 2 次 · 冷却 3 回合 · 占一次行动 '
        + '首领化 不可用 候选机制（未取证）：首领形态 / 血脉觉醒路径，与「首领对决」这一独立 PVP 主题绑定。 需要「首领血脉」，本版未做',
      engineFacts: {usesLeft: 2, cooldown: 0, swappedCount: 0},
      registered: {ok: true, file: 'data/roco/derived/pvp-magic.json', magic_id: 'wish_power_up', name: '愿力强化',
        per_battle_uses: 2, cooldown_turns: 3,
        wish_impact: {energy: 2, power: 80}, evidence_id: 'EV-PVP-WISH-POWER-UP'},
      fieldAudit: {text: '[data-b3-panel="item"] 的 textContent', count: 'data-b3-item-count × 2',
        engineMagic: 'view.self.magic{uses_left,cooldown,swapped,cooldown_set_turn}',
        legalMagic: 'view.legal[kind=magic] × 1', registered: 'data/roco/derived/pvp-magic.json'},
    },
    // J9 的输入契约（合成基线这一份的健康形状）：真页面那一份由 `measureFreeAction` 采
    // —— 用愿力强化前 turn=1/version=0/uses_left=2/cooldown=0；用掉之后 **turn 不变**、
    // version 前进、uses_left=1、cooldown=**登记值**、可点技能格仍 4 个；再出一手技能 turn=2。
    freeAction: {
      ok: true, failReason: null, entered: true, cellFound: true, cellAvailable: true,
      cellRect: {w: 210, h: 92}, tabAfterClick: 'item', clicked: true, versionAdvanced: true,
      before: {turn: 1, version: 0, usesLeft: 2, cooldown: 0, clickableSkills: 4, tab: 'item'},
      after: {turn: 1, version: 1, usesLeft: 1, cooldown: 3, clickableSkills: 4, tab: 'item'},
      turnAfterSkill: 2,
      registered: {ok: true, file: 'data/roco/derived/pvp-magic.json', magic_id: 'wish_power_up',
        per_battle_uses: 2, cooldown_turns: 3, evidence_id: 'EV-PVP-WISH-POWER-UP'},
    },
    sideEvidence: {
      rule: '按 DOM 归属判定 side（合成基线的形状与页面里一致）',
      selfCard: {selector: '[data-b3-self-card]', dataB3Mirror: 'self', rect: {left: 16, top: 60, w: 451, h: 800}},
      foeCard: {selector: '[data-b3-foe-card]', dataB3Mirror: 'foe', rect: {left: 973, top: 60, w: 451, h: 800}},
    },
    // J8 的输入契约（合成基线这一份的健康形状）：rect + 一份**手写的解码图**
    // （框内最后 32px 渐隐到卡片底色 = CSS 修复干的事）。真页面那一份是 `measureSeam` 量的
    // 「rect + 磁盘上那张整页 PNG 解码出来的像素」。
    seam: {self: seamSyntheticFact('smooth', 'self'), foe: seamSyntheticFact('smooth', 'foe')},
    // J10 的输入契约（合成基线这一份的健康形状）：三份读数，每一份都是「同一时刻的 DOM + view.mana」。
    // 真页面那一份由 `measureHearts` 采：开局后 4/4（pool 从回执读）、力竭后掉心那一侧 4→3、
    // 抽掉 `state.view.mana` 之后两侧 hidden。**pool 一律从回执读，基线也不写字面量 4 以外的口径**
    // （这里的 4 是引擎回执那一份 `view.mana.pool`，不是判据里的常量）。
    hearts: {
      ok: true, failReason: null, path: '真鼠标点「开一局（标准 PVP · 六宠）」',
      turnsDriven: 6, elapsedMs: 3994,
      initial: heartsSyntheticRead({mana: {self: 4, opponent: 4, pool: 4}, selfFull: 4, foeFull: 4,
        turn: 1, phase: 'battle'}),
      faint: {
        found: true, steps: 6, side: 'opponent',
        event: {turn: 7, kind: 'mana_loss', side: 'enemy',
          detail: {side: 'enemy', faint_cost: 1, mana: 3}, text: '对手的精灵力竭，对手失去 1 点魔力（剩余 3）。'},
        before: heartsSyntheticRead({mana: {self: 4, opponent: 4, pool: 4}, selfFull: 4, foeFull: 4,
          turn: 6, phase: 'battle'}),
        after: heartsSyntheticRead({mana: {self: 4, opponent: 3, pool: 4}, selfFull: 4, foeFull: 3,
          turn: 7, phase: 'battle'}),
      },
      missingManaProbe: {
        taken: true, restored: true, reason: '合成基线：把 state.view.mana 抽掉再 render()（等价于「引擎没给」）',
        before: heartsSyntheticRead({mana: {self: 4, opponent: 3, pool: 4}, selfFull: 4, foeFull: 3,
          turn: 7, phase: 'battle'}),
        after: heartsSyntheticRead({mana: null, selfFull: 0, foeFull: 0, hidden: true,
          turn: 7, phase: 'battle'}),
      },
      fieldAudit: {dom: '#b3-hearts-self / #b3-hearts-foe 的 textContent 与 <i>/<i class="lost"> 字数',
        engine: 'view.mana.{self,opponent,pool}（心 = 魔力；pool 是规则常量，从回执读）',
        faint: 'view.events[].kind===\'mana_loss\'（引擎自己报的力竭扣心事件）',
        probe: '抽掉 state.view.mana 后 window.rocoDemo.render() → 两侧必须 hidden'},
    },
  };
}

/**
 * J10 合成基线的一份读数（**只给测试用**）：DOM 的心形原文按 `pool` 与实心数拼出来
 * —— 与页面 `drawHeartCounters` 画的是同一个形状（`<i>实心</i><i class="lost">空心</i>`），
 * 但**不是**从页面里抠出来的：这一份是判据的输入契约，页面那一份由 `measureHearts` 真读。
 */
function heartsSyntheticRead({mana, selfFull, foeFull, hidden = false, turn = 1, phase = 'battle'}) {
  const FULL = String.fromCharCode(0x2665);
  const EMPTY = String.fromCharCode(0x2661);
  const pool = Number.isFinite(mana?.pool) ? mana.pool : 0;
  const one = (full) => (hidden
    ? {found: true, hidden: true, visible: false, full: 0, empty: 0, total: 0, text: '',
      html: '<span class="b3-hearts" id="b3-hearts-x" hidden></span>'}
    : {found: true, hidden: false, visible: true, full, empty: Math.max(0, pool - full), total: pool,
      text: FULL.repeat(full) + EMPTY.repeat(Math.max(0, pool - full)),
      html: `<span class="b3-hearts"><i>${FULL.repeat(full)}</i>`
        + `<i class="lost">${EMPTY.repeat(Math.max(0, pool - full))}</i></span>`});
  const dom = {self: one(selfFull), foe: one(foeFull)};
  return {engine: {mana: mana ?? null, turn, phase, stateVersion: turn}, dom,
    bodyHearts: hidden ? 0 : (dom.self.total + dom.foe.total), at: turn * 1000};
}


/** 把基线某一处弄坏的反证登记表（每条都**真的**跑一遍纯函数）。 */
const COUNTERPROOFS = [
  {
    id: 'R1', name: '出手方线索与受击方线索同一时间戳（Δ=0）→ 必须报「同时」',
    expect: '同时', criterion: 'J3',
    mutate: (f) => {
      f.timeline = [
        {t: 100, kind: 'cue', side: 'self', detail: {role: 'attack', what: '.b3-attack'}},
        {t: 100, kind: 'float', side: 'foe', detail: {role: 'float', floatId: 'f1', text: '-30'}},
        {t: 100, kind: 'cue', side: 'foe', detail: {role: 'hit', what: '.b3-hit'}},
        {t: 1000, kind: 'float-gone', side: 'foe', detail: {role: 'float-gone', floatId: 'f1'}},
      ];
      f.floats[0].bornT = 100; f.floats[0].goneT = 1000; f.floats[0].aliveMs = 900;
    },
  },
  {
    id: 'R2', name: '受击方线索早于出手方线索 → 必须报「顺序」反了',
    expect: '顺序', criterion: 'J3',
    mutate: (f) => {
      f.timeline = [
        {t: 60, kind: 'float', side: 'foe', detail: {role: 'float', floatId: 'f1', text: '-30'}},
        {t: 62, kind: 'cue', side: 'foe', detail: {role: 'hit', what: '.b3-hit'}},
        {t: 200, kind: 'cue', side: 'self', detail: {role: 'attack', what: '.b3-attack'}},
        {t: 204, kind: 'cue', side: 'self', detail: {role: 'attack', what: 'data-b3-variant=action'}},
        {t: 1060, kind: 'float-gone', side: 'foe', detail: {role: 'float-gone', floatId: 'f1'}},
      ];
      f.floats[0].bornT = 60; f.floats[0].goneT = 1060; f.floats[0].aliveMs = 1000;
      f.floats[0].samples = f.floats[0].samples.map((s) => ({...s, t: Number(s.t) + 0}));
    },
  },
  {
    id: 'R3', name: '浮字存在但每帧 elementFromPoint 都命中 .b3-sprite（复刻当前 bug）',
    expect: '被压住', criterion: 'J2',
    mutate: (f) => {
      const bad = (s) => ({...s, measurable: true, hitIsFloat: false, hitClass: 'b3-sprite', hitTag: 'img'});
      f.floats[0].samples = f.floats[0].samples.map(bad);
      f.floats[0].onTopSamples = 0;
      f.floats[0].hitClasses = ['b3-sprite'];
      f.frames = f.frames.map((fr) => ({t: fr.t, live: fr.live.map(bad)}));
    },
  },
  {
    id: 'R4', name: '浮字数为 0（只有动画没有数字）→ 必须报「没有数字」',
    expect: '没有数字', criterion: 'J1',
    mutate: (f) => {
      f.timeline = f.timeline.filter((e) => e.kind === 'cue');
      f.floats = [];
      f.frames = f.frames.map((fr) => ({t: fr.t, live: []}));
      f.finalFloatCount = 0;
    },
  },
  {
    id: 'R5', name: '浮字结束时没被移除（越攒越多）→ 必须报残留',
    expect: '越攒越多', criterion: 'J4',
    mutate: (f) => {
      f.timeline = f.timeline.filter((e) => e.kind !== 'float-gone');
      f.floats[0].goneT = null; f.floats[0].removed = false;
      f.floats[0].aliveMs = 3240;
      f.finalFloatCount = 1;
    },
  },
  {
    id: 'R6', name: '浮字加进去 10ms 就被删（人眼看不见）→ 必须报看不清',
    expect: '看不清', criterion: 'J4',
    mutate: (f) => {
      f.floats[0].goneT = 270; f.floats[0].aliveMs = 10;
      f.floats[0].samples = [f.floats[0].samples[0]];
      f.frames = [f.frames[0]];
    },
  },
  {
    id: 'R7', name: 'elementFromPoint 命中 .b3-spritebox（另一种被压住）→ 必须报被压住',
    expect: '被压住', criterion: 'J2',
    mutate: (f) => {
      const bad = (s) => ({...s, measurable: true, hitIsFloat: false, hitClass: 'b3-spritebox b3-free', hitTag: 'div'});
      f.floats[0].samples = f.floats[0].samples.map(bad);
      f.floats[0].onTopSamples = 0;
      f.floats[0].hitClasses = ['b3-spritebox b3-free'];
    },
  },
  {
    id: 'R8', name: '时间线里没有任何出手方线索 → 必须报没有出手方线索',
    expect: '没有出手方线索', criterion: 'J3',
    mutate: (f) => {
      f.timeline = f.timeline.filter((e) => e.detail?.role !== 'attack');
    },
  },
];

// ── CDP 小工具（照抄 `browser-roco-ux-acceptance.mjs` 的写法）─────────────────
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

async function startServer() {
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  return {
    server,
    base: `http://127.0.0.1:${PORT}/`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-bf-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  let chromeErr = '';
  chrome.stderr?.on('data', (chunk) => { chromeErr = (chromeErr + String(chunk)).slice(-800); });
  // 端口从 Chrome 自己写的 DevToolsActivePort 读（`--remote-debugging-port=0` 时
  // stderr 上那句 ws:// 是**浏览器级**端点，用它发页面命令会得到
  // 「'Runtime.evaluate' wasn't found」——那不是在连页面）。
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) {
    chrome.kill('SIGKILL');
    rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120});
    throw new Error(`Chrome 没起来：${chromeErr}`);
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('找不到可用的页面 target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return {
    chrome, profile, cdp: new Cdp(ws),
    close: async () => {
      try { ws.close(); } catch { /* 已经关了 */ }
      chrome.kill('SIGKILL');
      rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120});
    },
  };
}

// ── 层叠复刻反证（真浏览器，不是推演）───────────────────────────────────────
/**
 * 造一个**只含复刻结构**的最小页面（其它什么都没有），用**同一段采样代码**量它。
 *
 * 三档，全部照抄真实 CSS 的对应状态（不是我自己编的结构）：
 *   ① `now`   = 量真实页面时**磁盘上那一版**（HEAD 的 battle-v3.css）：
 *      `.b3-sprite` 是 flex item 且有 `z-index:1`，`.b3-fx` 没有 z-index、`pointer-events:none`，
 *      `.b3-float` 既没有自己的 z-index、也没开 pointer-events
 *      → `elementFromPoint` 必须命中 `.b3-sprite`（人类报的「数字看不见」）；
 *   ② `zOnly` = **只**把 `.b3-fx` 抬到 `z-index:3` → 画面顺序已经翻过来了，
 *      但 `pointer-events:none` 沿继承链把飘字也跳过，`elementFromPoint` **仍然**命中 `.b3-sprite`
 *      （这一档是给施工的人看的：光加 z-index 不够，「看得见」与「量得到」是两件事）；
 *   ③ `fixed` = `.b3-fx{z-index:3}` + `.b3-float{pointer-events:auto}`（客户端那一版修法的两行）
 *      → 必须命中 `.b3-float`。
 * 每一档都同时记 plain 与「临时 pointer-events:auto」两次实测结果，所以①/②的区别是量出来的、不是推的。
 */
async function runStackReplica({js, send}) {
  // ⚠ `#` 在 data URI 里会当成 fragment 起点，必须写成 `%23`，否则 <img> 加载失败、
  //   立绘根本不在画面上（实测第一版就是这样：命中 `.b3-spritebox` 而不是 `.b3-sprite`）。
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'>"
    + "<rect width='320' height='320' fill='%234a5a6a'/></svg>";
  const box = (side) => `
     <div class="b3-fighter b3-fighter--${side}" data-b3-${side}-card="yes" data-b3-mirror="${side}">
      <div class="b3-spritebox b3-free" data-b3-spritebox="yes" data-b3-side="${side}">
       <img class="b3-sprite" alt="" src="data:image/svg+xml;utf8,${svg}">
       <div class="b3-fx"></div>
      </div>
     </div>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>层叠复刻</title><style>
   body{margin:0;background:#0d141b;color:#c9d6e2;font:14px system-ui}
   /* 全部照抄人类报的那次（HEAD 的 battle-v3.css）里与层叠有关的那几行 */
   .b3-wrap{position:relative;padding:20px}
   .b3-spritebox{position:relative;overflow:hidden;display:flex;align-items:flex-end;justify-content:center;
     border-radius:14px;border:1px solid #243444;background:linear-gradient(180deg,#141d27,#0f161d);width:320px;height:320px}
   .b3-spritebox::after{content:"";position:absolute;inset:0;pointer-events:none;border-radius:14px;
     background:radial-gradient(120% 90% at 50% 30%, rgba(0,0,0,0) 45%, rgba(0,0,0,.45) 100%)}
   .b3-sprite{max-width:100%;max-height:100%;object-fit:contain;display:block;z-index:1}
   .b3-fx{position:absolute;inset:0;pointer-events:none;overflow:visible}
   .b3-float{position:absolute;left:50%;top:18%;transform:translateX(-50%);
     font-weight:800;font-size:20px;color:#ff8f8f}
   </style></head><body>
   <div class="b3-wrap" data-b3-root="yes">${box('self')}${box('foe')}</div>
   <style id="fix"></style>
  </body></html>`;
  const url = `data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`;
  await send('Page.navigate', {url});
  await sleep(400);
  const VARIANTS = [
    {key: 'now', label: '量真实页面时那一版 CSS（`.b3-fx` 没有 z-index、`.b3-float` 没开 pointer-events）',
      rule: ''},
    {key: 'zOnly', label: '只把 `.b3-fx` 抬到 z-index:3（不动 pointer-events）',
      rule: '.b3-wrap .b3-fx{z-index:3}'},
    {key: 'fixed', label: '`.b3-fx{z-index:3}` + `.b3-float{pointer-events:auto}`（客户端那一版修法的两行）',
      rule: '.b3-wrap .b3-fx{z-index:3}.b3-wrap .b3-float{pointer-events:auto}'},
  ];
  const probe = async (variant) => {
    await js(`(()=>{document.getElementById('fix').textContent=${JSON.stringify(variant.rule)};
      document.querySelectorAll('.b3-float').forEach((el)=>el.remove());return true;})()`);
    await js(samplerSource());
    await js('window.__b3fb.reset && window.__b3fb.reset()');
    await js('window.__b3fb.start()');
    const born = await js(`(()=>{const fx=document.querySelector('[data-b3-self-card] .b3-fx');
      if(!fx)return null;const span=document.createElement('span');
      span.className='b3-float b3-float--hit';span.textContent='-30';fx.appendChild(span);
      return window.__b3fb.markClick();})()`);
    // 轮询（上限 1.5s）：等采到至少 3 个「可量」的帧就收工，不再空等
    let measurable = 0;
    for (let i = 0; i < 15 && measurable < 3; i += 1) {
      await sleep(100);
      const snap = await js('window.__b3fb.report()');
      measurable = snap?.floats?.[0]?.measurableSamples ?? 0;
    }
    const snap = await js('window.__b3fb.stop()');
    const floatRec = (snap.floats ?? [])[0] ?? null;
    const firstMeasured = (floatRec?.samples ?? []).find((s) => s.measurable) ?? null;
    const css = await js(`(()=>{const fx=document.querySelector('[data-b3-self-card] .b3-fx');
      const sp=document.querySelector('[data-b3-self-card] .b3-sprite');
      const fl=document.querySelector('[data-b3-self-card] .b3-float');
      if(!fx||!sp)return null;
      const sr=sp.getBoundingClientRect(), fr=fl?fl.getBoundingClientRect():null;
      return {fxZIndex:getComputedStyle(fx).zIndex,spriteZIndex:getComputedStyle(sp).zIndex,
        spritePosition:getComputedStyle(sp).position,fxPointerEvents:getComputedStyle(fx).pointerEvents,
        floatPointerEvents:fl?getComputedStyle(fl).pointerEvents:null,
        floatZIndex:fl?getComputedStyle(fl).zIndex:null,
        // 立绘是否真的画出来、是否真的盖住浮字中心（否则「被压住」是假的）
        spriteComplete:sp.complete,spriteNaturalW:sp.naturalWidth,spriteRect:{w:Math.round(sr.width),h:Math.round(sr.height)},
        floatRect:fr?{w:Math.round(fr.width),h:Math.round(fr.height),
          cx:Math.round(fr.left+fr.width/2),cy:Math.round(fr.top+fr.height/2)}:null,
        spriteCoversFloatCenter:Boolean(fr)&&sr.left<=fr.left+fr.width/2&&fr.left+fr.width/2<=sr.right
          &&sr.top<=fr.top+fr.height/2&&fr.top+fr.height/2<=sr.bottom};})()`);
    return {key: variant.key, label: variant.label, appliedRule: variant.rule || '（不加任何规则）',
      bornT: born, css,
      float: floatRec ? {text: floatRec.text, side: floatRec.side, aliveMs: floatRec.aliveMs,
        samples: floatRec.sampleCount, measurableSamples: floatRec.measurableSamples,
        onTopSamples: floatRec.onTopSamples, hitClasses: floatRec.hitClasses,
        paintProbe: floatRec.paintProbe ?? null} : null,
      // ① plain elementFromPoint（判据用的那一次）
      measuredHitClass: firstMeasured?.hitClass ?? null,
      measuredHitTag: firstMeasured?.hitTag ?? null,
      measuredHitIsFloat: firstMeasured?.hitIsFloat ?? null,
      // ② 临时 pointer-events:auto 之后的 elementFromPoint（回答「画面顺序到底谁在上」）
      paintOrderHitClass: floatRec?.paintProbe?.hitClass ?? null,
      paintOrderHitIsFloat: floatRec?.paintProbe?.hitIsFloat ?? null,
      measuredFrames: (floatRec?.samples ?? []).slice(0, 4).map((s) => ({t: s.t, measurable: s.measurable,
        hitClass: s.hitClass, hitTag: s.hitTag, hitIsFloat: s.hitIsFloat})),
      timelineKinds: (snap.timeline ?? []).map((e) => `${e.kind}@${e.side ?? '—'}`)};
  };
  const runs = {};
  for (const v of VARIANTS) runs[v.key] = await probe(v);
  return {runs, now: runs.now, zOnly: runs.zOnly, fixed: runs.fixed,
    pageUrl: 'data:text/html（只含复刻结构：.b3-spritebox + .b3-sprite{z-index:1} + .b3-fx + .b3-float，'
      + '加同一段采样代码）',
    sampler: '同一份 battleFeedbackSampler（与真实页面那一跑是同一段代码）'};
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const results = {
  checks: [], counterproofs: [], problems: [], shots: [], steps: [],
  consoleErrors: [], pageErrors: [],
};

function recordFindings(findings, extra = {}) {
  for (const row of findings) {
    const out = {id: row.id, name: row.name, ok: row.ok, actual: oneLine(row.actual, 600),
      missing: [...new Set(row.problems.map((p) => p.missing))],
      problems: row.problems.map((p) => oneLine(p.text, 600)),
      problems_detail: row.problems.map((p) => ({text: oneLine(p.text, 600), actual: oneLine(p.actual, 600),
        missing: oneLine(p.missing, 300)})),
      unreadable: Boolean(row.unreadable), ...extra};
    results.checks.push(out);
    const mark = out.unreadable ? '○' : (out.ok ? '✔' : '✖');
    log(mark, `${out.id} ${out.name}`, `— ${oneLine(out.actual, 220)}`);
    for (const p of out.problems_detail) {
      log('    ✖', `${out.name} | 实际值：${oneLine(p.actual, 200)} | 缺：${oneLine(p.missing, 160)}`);
      log('       ·', oneLine(p.text, 240));
    }
  }
}

function runCounterproofs() {
  const baseline = baselineFacts();
  // ① 合成基线必须**全绿**：判据把好状态判红 = 判据写坏了
  const baselineProblems = feedbackProblems(baseline);
  results.counterproofs.push({id: 'baseline', name: '合成基线（健康）必须返回空数组', expect: '空数组',
    got: baselineProblems, hit: baselineProblems.length === 0, kind: 'baseline'});
  log(baselineProblems.length === 0 ? '✔' : '✖', '[基线] feedbackProblems(健康合成基线) =',
    JSON.stringify(baselineProblems));
  if (baselineProblems.length) log('    ✖ 基线竟然红了：', baselineProblems.join(' | '));
  // ② R1–R8：真的把基线弄坏一处，真的跑纯函数，真的打印判出来的问题
  for (const cp of COUNTERPROOFS) {
    const facts = baselineFacts();
    cp.mutate(facts);
    const problems = feedbackProblems(facts);
    const keywordHit = problems.some((p) => p.includes(cp.expect));
    const criterionHit = problems.some((p) => p.startsWith(`[${cp.criterion} `));
    const hit = problems.length > 0 && keywordHit && criterionHit;
    results.counterproofs.push({id: cp.id, name: cp.name, expect: cp.expect, criterion: cp.criterion,
      got: problems, hit, keyword_hit: keywordHit, criterion_hit: criterionHit, kind: 'mutation'});
    log(hit ? '✔' : '✖', `[反证 ${cp.id}] ${cp.name}`, `— 判出：${(problems.join(' | ') || '（没命中——判据是空的！）').slice(0, 260)}`);
    if (!hit) log('    ✖ 这条反证没命中：keyword_hit=', keywordHit, 'criterion_hit=', criterionHit);
  }
  // ③ R10：J6 的纯函数判据**真的能红**（喂一个「星不够却仍可点、没灰置、⭐ 还是金的」格）
  {
    const reds = ['rgb(255, 154, 154)'];
    const good = {index: 2, name: '翅刃', cost: 3, legal: 'no', short: 'yes', action: null,
      cls: 'b3-slot b3-slot--grey', color: 'rgb(255, 154, 154)'};
    const clean = slotShortProblems([good], reds);
    const poisoned = slotShortProblems([{...good, legal: 'yes', action: '2', cls: 'b3-slot',
      color: 'rgb(255, 212, 121)'}], reds);
    const hit = clean.length === 0 && poisoned.length >= 3;
    results.counterproofs.push({id: 'R10', name: '星不够的格子却「可点 / 没灰置 / ⭐ 仍是金色」→ 必须报',
      expect: '灰置 + 红⭐ + 不可点', criterion: 'J6', got: poisoned, hit, kind: 'pure-fn',
      clean_ok: clean.length === 0});
    log(hit ? '✔' : '✖', '[反证 R10] 星不够的格子却「可点 / 没灰置 / ⭐ 仍是金色」→ 必须报',
      `— 健康输入判空=${clean.length === 0}；坏输入判出：${(poisoned.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 240)}`);
  }
  // ③ R11：J7 的纯函数判据**真的能红**（喂一份「把样例数字写死」的背包屏输入）
  {
    const healthy = baselineFacts().itemPanel;
    const clean = itemPanelNumberProblems({itemPanel: healthy});
    // 反证 1：写死的样例数字（5 / 9 在引擎与已登记证据里都没有出处）
    const sampleNumbers = itemPanelNumberProblems({itemPanel:
      {...healthy, text: `${healthy.text} 每局 5 次，冷却 9 回合。`}});
    const hit1 = sampleNumbers.length > 0 && sampleNumbers.some((p) => p.text.includes('没有登记出处'));
    // 反证 2：把次数与冷却从文案里删掉（「什么都不写」也必须红）
    const removed = itemPanelNumberProblems({itemPanel:
      {...healthy, text: '愿力强化 候选 · 未核验：说明未登记。 首领化 不可用 候选机制（未取证）。'}});
    const hit2 = removed.length > 0 && removed.some((p) => p.text.includes('该显示的数字没显示'));
    const hit = clean.length === 0 && hit1 && hit2;
    results.counterproofs.push({id: 'R11', name: '背包屏把样例数字写死（每局 5 次 / 冷却 9 回合）→ 必须报「没有登记出处」；'
      + '把次数与冷却从文案里删掉 → 必须报「该显示的数字没显示」',
    expect: '没有登记出处 + 该显示的数字没显示', criterion: 'J7', got: [...sampleNumbers, ...removed],
    hit, kind: 'pure-fn', clean_ok: clean.length === 0, sample_hit: hit1, removed_hit: hit2});
    log(hit ? '✔' : '✖', '[反证 R11] 背包屏「写死样例数字 / 删掉该显示的数字」→ 必须报',
      `— 健康输入判空=${clean.length === 0}；写死样例判出：`
      + `${(sampleNumbers.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 200)}；`
      + `删掉数字判出：`
      + `${(removed.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 200)}`);
  }
  // ④ R12：J8 的纯函数判据**真的能红** —— 喂一份「把修复回退」的合成事实（底边写死 rgb(36,52,68)）
  //    与一份「rect 全 0」的（必须报「量不到」）。健康输入（合成基线那一份）必须判空。
  {
    const healthy = baselineFacts();
    const clean = seamProblems(healthy);
    const reverted = seamProblems({...healthy, seam: {self: seamSyntheticFact('hard', 'self')}});
    const hit1 = reverted.length > 0 && reverted.some((p) => p.text.includes('硬横线'));
    const zeroRect = seamProblems({...healthy, seam: {self: seamSyntheticFact('zero-rect', 'self')}});
    const hit2 = zeroRect.length > 0 && zeroRect.some((p) => p.text.includes('量不到'));
    const hit = clean.length === 0 && hit1 && hit2;
    results.counterproofs.push({id: 'R12', name: '立绘框底边写死成 `rgb(36,52,68)`（复刻改前那条 1px 实线底边，'
      + '等价于把 CSS 修复回退）→ J8 必须报「硬横线」；再喂一份「rect 全 0」的 → J8 必须报「量不到」',
    expect: '硬横线 + 量不到', criterion: 'J8', got: [...reverted, ...zeroRect], hit, kind: 'pure-fn',
    clean_ok: clean.length === 0, hard_hit: hit1, zero_rect_hit: hit2});
    log(hit ? '✔' : '✖', '[反证 R12] 立绘框底边写死 rgb(36,52,68) / rect 全 0 → J8 必须报',
      `— 健康输入判空=${clean.length === 0}；回退底边判出：`
      + `${(reverted.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 220)}；`
      + `rect 全 0 判出：`
      + `${(zeroRect.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 160)}`);
  }
  // ④ R13：J9 的纯函数判据**真的能红** —— 喂两组合成事实
  //   ①「自由动作之后回合前进了」（等价于把它当成占一手 ⇒ 人类口径被违反）
  //   ②「自由动作之后没有可点技能格」+「冷却不是登记值」
  {
    const healthyFa = baselineFacts().freeAction;
    const clean = freeActionProblems(healthyFa);
    // 反证 1：回合前进了（自由动作被当成占一手）
    const turned = freeActionProblems({...healthyFa,
      after: {...healthyFa.after, turn: healthyFa.before.turn + 1}, turnAfterSkill: healthyFa.before.turn + 2});
    const hit1 = turned.length > 0 && turned.some((p) => p.text.includes('回合变了'));
    // 反证 2：没有可点技能格 + 冷却不是登记值（两处都要报）
    const broken = freeActionProblems({...healthyFa,
      after: {...healthyFa.after, clickableSkills: 0, cooldown: 1}});
    const hit2 = broken.length > 0 && broken.some((p) => p.text.includes('可点技能格'))
      && broken.some((p) => p.text.includes('冷却不是登记值'));
    // 反证 3（附加）：「量不到」必须判红，而不是被当成通过
    const missing = freeActionProblems({...healthyFa, failReason: '合成：真鼠标点不到那一格'});
    const hit3 = missing.length === 1 && missing[0].text.includes('量不到');
    const hit = clean.length === 0 && hit1 && hit2 && hit3;
    results.counterproofs.push({id: 'R13', name: '自由动作「回合前进了 / 没有可点技能格 / 冷却不是登记值 / 量不到」→ J9 必须报',
      expect: '回合变了 + 可点技能格 + 冷却不是登记值 + 量不到', criterion: 'J9',
      got: [...turned, ...broken, ...missing], hit, kind: 'pure-fn',
      clean_ok: clean.length === 0, turned_hit: hit1, broken_hit: hit2, missing_hit: hit3});
    log(hit ? '✔' : '✖', '[反证 R13] 自由动作「占了一手 / 没技能可点 / 冷却不对 / 量不到」→ J9 必须报',
      `— 健康输入判空=${clean.length === 0}；回合前进判出：`
      + `${(turned.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 200)}；`
      + `坏形态判出：${(broken.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 200)}；`
      + `量不到判出：${(missing.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 120)}`);
  }
  // ④ R14：J10 的纯函数判据**真的能红**（人类 2026-09-25：「生命心常显」这一条的两条必红反证）
  //   ①「无 mana 状态却硬写 4 颗」：`view.mana` 缺失（引擎没给），DOM 却画着 4 实心 + 心形字符可见；
  //   ②「把心的值与引擎故意错开 1」：引擎 `opponent=3 / pool=4`，DOM 画成 4 实心。
  {
    const healthy = baselineFacts().hearts;
    const clean = heartsProblems(healthy);
    // 反证 1：拿不到 mana 却硬写 4 颗（正是「页面自己编一个状态量」那个坏形态）
    const fakeFour = heartsProblems({...healthy,
      missingManaProbe: {...healthy.missingManaProbe,
        after: heartsSyntheticRead({mana: null, selfFull: 4, foeFull: 4, hidden: false, turn: 7})}});
    const hit1 = fakeFour.length > 0
      && fakeFour.some((p) => p.text.includes('绝不硬写 4 颗') || p.text.includes('凭空画出来的心计数器'));
    // 反证 2：把心的值与引擎故意错开 1（引擎已经掉到 3，页面还画 4 颗）
    const offByOne = heartsProblems({...healthy,
      faint: {...healthy.faint,
        after: heartsSyntheticRead({mana: {self: 4, opponent: 3, pool: 4}, selfFull: 4, foeFull: 4,
          turn: 7, phase: 'battle'})}});
    const hit2 = offByOne.length > 0 && offByOne.some((p) => p.text.includes('实心数'));
    // 反证 3（附加）：「量不到」必须判红，而不是被当成通过
    const missing = heartsProblems({...healthy, failReason: '合成：真鼠标推不到一次力竭'});
    const hit3 = missing.length === 1 && missing[0].text.includes('量不到');
    const hit = clean.length === 0 && hit1 && hit2 && hit3;
    results.counterproofs.push({id: 'R14', name: '心的常显「无 mana 却硬写 4 颗 / 心的值与引擎错开 1 / 量不到」→ J10 必须报',
      expect: '绝不硬写 4 颗 + 实心数 + 量不到', criterion: 'J10',
      got: [...fakeFour, ...offByOne, ...missing], hit, kind: 'pure-fn',
      clean_ok: clean.length === 0, fake_four_hit: hit1, off_by_one_hit: hit2, missing_hit: hit3});
    log(hit ? '✔' : '✖', '[反证 R14] 生命心「无 mana 硬写 4 颗 / 与引擎错开 1 / 量不到」→ J10 必须报',
      `— 健康输入判空=${clean.length === 0}；硬写 4 颗判出：`
      + `${(fakeFour.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 200)}；`
      + `错开 1 判出：${(offByOne.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 200)}；`
      + `量不到判出：${(missing.map((x) => `[${x.text}]`).join(' | ') || '（没命中！）').slice(0, 120)}`);
  }
  return baselineProblems;
}

async function main() {
  mkdirSync(OUT_DIR, {recursive: true});
  if (SHOTS) mkdirSync(SHOT_DIR, {recursive: true});
  const clientBefore = ['src/client/roco.js', 'src/client/battle-v3.css', 'src/client/roco.html'].map(sha);

  const baselineProblems = runCounterproofs();
  const countersMissed = results.counterproofs.filter((c) => !c.hit);

  if (SELFTEST_ONLY) {
    finish({baselineProblems, clientBefore, clientAfter: clientBefore, stack: null, real: null,
      entry: null, itemPanel: null, seam: null, freeAction: null, hearts: null,
      note: '--selftest-only：没开浏览器，只验判据/反证'});
    return;
  }
  if (!CHROME) throw new Error('找不到 Chrome（设 CHROME_BIN 或装 Google Chrome）');

  const {base, close} = await startServer();
  const browser = await launchChrome();
  const {cdp} = browser;
  const send = (method, params = {}) => cdp.send(method, params);
  let stack = null;
  let real = null;
  let entry = null;
  let itemPanel = null;   // J7：背包屏实测（面板原文 + 引擎 magic 事实 + 已登记证据）
  let seam = null;        // J8：立绘框接缝实测（rect + 整页 PNG 路径 + 解码后的像素）
  let freeAction = null;  // J9：自由动作实测（真鼠标点愿力强化那一格；view 前后 + 再出一手技能）
  let hearts = null;      // J10：生命心 ♥ 常显实测（DOM 原文 + 同一时刻的 view.mana；力竭掉心前后 + 抽掉 mana 的探针）
  try {
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p?.type !== 'error') return;
      results.consoleErrors.push(oneLine((p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '), 300));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p?.exceptionDetails ?? {};
      const where = d.url ? ` @ ${String(d.url).replace(/^https?:\/\/[^/]+/, '')}:${(d.lineNumber ?? 0) + 1}` : '';
      results.pageErrors.push(oneLine(`${d.exception?.description ?? d.text ?? 'exception'}${where}`, 300));
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setFocusEmulationEnabled', {enabled: true});
    const js = async (expression) => {
      const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) {
        throw new Error(`页面求值失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      return result.result.value;
    };
    const waitFor = async (expr, tries = 80, ms = 200) => {
      for (let i = 0; i < tries; i += 1) {
        try { if (await js(expr)) return true; } catch { /* 页面还在导航 */ }
        await sleep(ms);
      }
      return false;
    };
    const rectOf = async (selector) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};})()`);
    const mouseClick = async (selector) => {
      await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
        if(el)el.scrollIntoView({block:'center'});return true;})()`);
      await sleep(140);
      const r = await rectOf(selector);
      if (!r) throw new Error(`找不到可点的元素：${selector}`);
      if (r.w === 0 || r.h === 0) throw new Error(`${selector} 尺寸为 0（${r.w}×${r.h}），真鼠标点不到`);
      if (r.y < 0 || r.y > await js('window.innerHeight')) {
        throw new Error(`${selector} 的中心点不在视口里（y=${r.y}），真鼠标点不到它`);
      }
      await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x, y: r.y});
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {type, x: r.x, y: r.y, button: 'left', clickCount: 1});
      }
      await sleep(160);
      return r;
    };
    const setViewport = async (width, height) => {
      await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
      await sleep(400);
    };
    const shoot = async (name) => {
      if (!SHOTS) return null;
      try {
        const {data} = await send('Page.captureScreenshot', {format: 'png'});
        const rel = `battle-feedback/${name}.png`;
        writeFileSync(join(OUT_DIR, rel), Buffer.from(data, 'base64'));
        results.shots.push(rel);
        return rel;
      } catch (error) { return `截图失败：${oneLine(error?.message, 120)}`; }
    };
    const serverGet = (path) => fetch(base.replace(/\/$/, '') + path).then((r) => r.json());

    // ── 层叠复刻反证（先跑：判据能不能抓住「被压住」的证据不依赖战斗页现状）──
    stack = await runStackReplica({js, send});
    {
      const nowHit = String(stack.now.measuredHitClass ?? '');
      const fixedHit = String(stack.fixed.measuredHitClass ?? '');
      const ok = nowHit.includes('b3-sprite') && stack.now.measuredHitIsFloat === false
        && fixedHit.includes('b3-float') && stack.fixed.measuredHitIsFloat === true;
      results.counterproofs.push({id: 'R9-层叠复刻', kind: 'browser-replica', hit: ok,
        name: '真浏览器里复刻「立绘压住飘字层」：按量真实页面时那一版 CSS → elementFromPoint 命中 .b3-sprite；'
          + '抬到 `.b3-fx{z-index:3}` + `.b3-float{pointer-events:auto}` → 命中 .b3-float',
        expect: '先 .b3-sprite、后 .b3-float',
        got: [`now → elementFromPoint 命中 ${JSON.stringify(stack.now.measuredHitClass)}`
            + `（探针 ${JSON.stringify(stack.now.paintOrderHitClass)}）`,
          `zOnly（只加 z-index:3）→ ${JSON.stringify(stack.zOnly.measuredHitClass)}`
            + `（探针 ${JSON.stringify(stack.zOnly.paintOrderHitClass)}）`,
          `fixed → elementFromPoint 命中 ${JSON.stringify(stack.fixed.measuredHitClass)}`]});
      log(ok ? '✔' : '✖', '[反证 R9-层叠复刻] 真浏览器实测：now →',
        `${JSON.stringify(stack.now.measuredHitClass)}（hitIsFloat=${stack.now.measuredHitIsFloat}，`
        + `paintOrderProbe=${JSON.stringify(stack.now.paintOrderHitClass)}）；`
        + `zOnly → ${JSON.stringify(stack.zOnly.measuredHitClass)}（探针 ${JSON.stringify(stack.zOnly.paintOrderHitClass)}）；`
        + `fixed → ${JSON.stringify(stack.fixed.measuredHitClass)}（hitIsFloat=${stack.fixed.measuredHitIsFloat}）`);
      if (!ok) log('    ✖ 层叠复刻没按预期：', JSON.stringify({now: stack.now.measuredHitClass,
        zOnly: stack.zOnly.measuredHitClass, fixed: stack.fixed.measuredHitClass}));
    }

    // ── 真实页面：自起自跑 → 真鼠标进战斗 → 量立绘框接缝（J8）→ 真鼠标点物品屏（J7）
    //    → 真鼠标点技能 → 3.5s 采样 ──────────────────────────────────────────────
    entry = await enterBattle({js, send, mouseClick, waitFor, base, serverGet, shoot});
    results.steps.push({at: 'enter-battle', entry});
    log(`进战斗：${entry.path}（开局=${entry.started}，合法技能=${entry.legalSkills}，`
      + `可点格=${entry.clickableSlots}，回合=${entry.turn}）`);

    // J8：进战斗之后立刻量立绘框接缝（整页截图 + rect；像素从落盘那张 PNG 里读）
    seam = await measureSeam({js, shoot});
    results.steps.push({at: 'measure-seam', seam: {ok: seam.ok, shot: seam.shot, viewport: seam.viewport,
      fieldAudit: seam.fieldAudit, self: seamSummary(seam.self), foe: seamSummary(seam.foe)}});
    log(seam.self?.box && !seamProblems({seam}).length ? '✔' : '○',
      `立绘框接缝实测：我方 rect=${JSON.stringify(seam.self?.box ?? null)}`
      + ` borderJump=${fmt(seamSummary(seam.self)?.metrics?.borderJump)}`
      + ` stepAcrossBottom=${fmt(seamSummary(seam.self)?.metrics?.stepAcrossBottom)}`
      + `；对手 rect=${JSON.stringify(seam.foe?.box ?? null)}`
      + ` borderJump=${fmt(seamSummary(seam.foe)?.metrics?.borderJump)}`
      + ` stepAcrossBottom=${fmt(seamSummary(seam.foe)?.metrics?.stepAcrossBottom)}`
      + `；截图=${JSON.stringify(seam.shot)}`);

    itemPanel = await measureItemPanel({js, mouseClick, shoot, entry});
    results.steps.push({at: 'measure-item-panel', itemPanel});
    if (itemPanel?.ok) {
      log('✔', `背包屏实测：原文「${oneLine(itemPanel.text, 120)}」；`
        + `引擎 view.self.magic={uses_left:${JSON.stringify(itemPanel.engineFacts?.usesLeft ?? null)},`
        + `cooldown:${JSON.stringify(itemPanel.engineFacts?.cooldown ?? null)},`
        + `swapped:${JSON.stringify(itemPanel.engineFacts?.swappedCount ?? null)}}；`
        + `已登记 per_battle_uses=${JSON.stringify(itemPanel.registered?.per_battle_uses ?? null)}`
        + `/cooldown_turns=${JSON.stringify(itemPanel.registered?.cooldown_turns ?? null)}`);
    } else {
      log('○', `背包屏没量到：${oneLine(itemPanel?.failReason ?? '未知', 200)}`);
    }

    // J9：自由动作（真鼠标点愿力强化那一格 → 回合不变 + 仍可出招 + 次数-1 + 冷却=登记值
    //     → 再真鼠标点一个合法技能格 → 回合 +1）
    freeAction = await measureFreeAction({js, mouseClick, entry});
    results.steps.push({at: 'measure-free-action', freeAction});
    if (freeAction?.ok) {
      log('✔', `自由动作实测：turn ${fmt(freeAction.before?.turn)} → ${fmt(freeAction.after?.turn)}`
        + `（state_version ${fmt(freeAction.before?.version)} → ${fmt(freeAction.after?.version)}）；`
        + `uses_left ${fmt(freeAction.before?.usesLeft)} → ${fmt(freeAction.after?.usesLeft)}、`
        + `cooldown=${fmt(freeAction.after?.cooldown)}（登记 ${fmt(freeAction.registered?.cooldown_turns)}）、`
        + `可点技能格=${fmt(freeAction.after?.clickableSkills)}；再出一手技能后 turn=${fmt(freeAction.turnAfterSkill)}`);
    } else {
      log('○', `自由动作没量到：${oneLine(freeAction?.failReason ?? '未知', 200)}`);
    }

    // J10：生命心 ♥ 常显（开局后 === view.mana；力竭掉心 -1 且与引擎逐位一致；拿不到 mana 必须 hidden）
    hearts = await measureHearts({js, mouseClick, entry, waitFor});
    results.steps.push({at: 'measure-hearts', hearts: {ok: hearts.ok, failReason: hearts.failReason,
      manaAvailable: hearts.manaAvailable, turnsDriven: hearts.turnsDriven, elapsedMs: hearts.elapsedMs,
      initial: hearts.initial, faint: hearts.faint ? {found: hearts.faint.found, steps: hearts.faint.steps,
        side: hearts.faint.side, event: hearts.faint.event, before: hearts.faint.before,
        after: hearts.faint.after, domSelf: hearts.faint.domSelf, domFoe: hearts.faint.domFoe} : null,
      missingManaProbe: hearts.missingManaProbe}});
    log(hearts.initial && heartsProblems(hearts).length === 0 ? '✔' : (hearts.manaAvailable ? '✖' : '○'),
      `生命心实测：入口=${JSON.stringify(hearts.path)}；开局后引擎 view.mana=${JSON.stringify(hearts.initial?.engine?.mana ?? null)}`
      + ` → DOM 我方「${hearts.initial?.dom?.self?.text ?? '—'}」（hidden=${JSON.stringify(hearts.initial?.dom?.self?.hidden ?? null)}）`
      + ` / 对手「${hearts.initial?.dom?.foe?.text ?? '—'}」（hidden=${JSON.stringify(hearts.initial?.dom?.foe?.hidden ?? null)}）；`
      + (hearts.faint?.found
        ? `力竭（第 ${hearts.faint.steps} 步，引擎事件「${oneLine(hearts.faint.event?.text ?? '', 60)}」）：`
          + `引擎 ${JSON.stringify(hearts.faint.before?.engine?.mana ?? null)} → ${JSON.stringify(hearts.faint.after?.engine?.mana ?? null)}；`
          + `DOM 我方「${hearts.faint.before?.dom?.self?.text ?? '—'}」→「${hearts.faint.after?.dom?.self?.text ?? '—'}」、`
          + `对手「${hearts.faint.before?.dom?.foe?.text ?? '—'}」→「${hearts.faint.after?.dom?.foe?.text ?? '—'}」`
        : `力竭**没推到位**：${oneLine(hearts.faint?.reason ?? '—', 160)}`)
      + `；抽掉 mana 的探针：self.hidden=${JSON.stringify(hearts.missingManaProbe?.after?.dom?.self?.hidden ?? null)}`
      + ` foe.hidden=${JSON.stringify(hearts.missingManaProbe?.after?.dom?.foe?.hidden ?? null)}`
      + ` 页面心形字符=${JSON.stringify(hearts.missingManaProbe?.after?.bodyHearts ?? null)}`
      + `（已还原=${JSON.stringify(hearts.missingManaProbe?.restored ?? null)}）`);

    real = await measureAction({js, send, mouseClick, waitFor, shoot, entry, itemPanel, seam, freeAction, hearts});
    results.steps.push({at: 'measure', attempts: real.attempts.map((a) => a.digest)});
    recordFindings(real.findings);
  } finally {
    try { await browser.close(); } catch { /* 已经关了 */ }
    try { await close(); } catch { /* 已经关了 */ }
  }
  finish({baselineProblems, clientBefore, clientAfter: ['src/client/roco.js', 'src/client/battle-v3.css',
    'src/client/roco.html'].map(sha), stack, real, entry, itemPanel, seam, freeAction, hearts});
}

// ── 真鼠标进战斗（六宠标准 PVP 优先；走不通才回落 legacy 3v3）─────────────────
async function enterBattle({js, send, mouseClick, waitFor, base, serverGet, shoot}) {
  const ready = async () => waitFor(`document.body.dataset.rocoReady==='yes'`, 120, 250);
  const inBattle = async () => waitFor(`document.body.dataset.rocoView==='ready'
    && !document.getElementById('battle-panel').hidden
    && document.querySelectorAll('.b3-wrap [data-b3-skill-slot]').length>0`, 120, 250);
  const snap = async () => js(`(()=>{const v=window.rocoDemo.state.view;
    const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')];
    const clickable=slots.filter((s)=>{const r=s.getBoundingClientRect();
      return s.dataset.b3ActionKind==='skill'&&s.dataset.b3Action!==undefined&&r.width>0&&r.height>0;});
    return {ready:document.body.dataset.rocoReady??null,route:document.body.dataset.rocoRoute??null,
      view:document.body.dataset.rocoView??null,panel:!document.getElementById('battle-panel').hidden,
      turn:v?v.turn:null,phase:v?v.phase:null,legalSkills:((v&&v.legal)||[]).filter((a)=>a.kind==='skill').length,
      slots:slots.length,clickableSlots:clickable.length,tab:document.body.dataset.b3Tab??null,
      legacyPanel:!document.getElementById('select-panel').hidden,
      standard:{found:Boolean(document.getElementById('start-standard-pvp')),
        disabled:document.getElementById('start-standard-pvp')?.disabled??null,
        team:document.getElementById('start-standard-pvp')?.dataset.rocoStandardTeam??null,
        text:(document.getElementById('start-standard-pvp')?.textContent||'').trim()}};})()`);
  const out = {path: null, started: false, trail: []};

  // 路径 A：盒子 → URL 交接六只 → 真鼠标点「开一局（标准 PVP · 六宠）」
  let teamIds = [];
  try {
    const mine = await serverGet('/api/roco/box?kind=mine&limit=60');
    // ⚠ 2026-09-28：必须按**物种**去重（一支队伍里同一物种只能占一个槽位）。
    // 人类批准那对同种演示个体之后，盒子前两张卡是同一物种（`pet_000012` ×2）——
    // 只按 id 去重会把它俩一起塞进队伍，服务端照规矩拒绝，页面退回**不声明 mana 的配置**，
    // 于是这一套里的 J7/J9/J10（愿力强化 / 魔力心）全部**量不到**（实测：门禁多出一条红）。
    const speciesSeen = new Set();
    for (const card of (mine?.player?.cards ?? [])) {
      const id = card?.select ?? card?.group;
      const species = card?.group ?? null;
      if (typeof id !== 'string' || !/^own-\d+$/.test(id)) continue;
      if (species && speciesSeen.has(species)) continue;
      if (species) speciesSeen.add(species);
      teamIds.push(id);
      if (teamIds.length === 6) break;
    }
  } catch (error) { out.trail.push({step: 'mine-box', error: oneLine(error?.message, 160)}); }
  if (teamIds.length === 6) {
    await send('Page.navigate', {url: `${base}roco.html?team=${teamIds.join(',')}`});
    await ready();
    await js(`localStorage.setItem('roco-coach-onboard-v1','1')`);
    await send('Page.reload');
    await ready();
    await js(`localStorage.setItem('roco-coach-onboard-v1','1')`);
    await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await sleep(500);
    const before = await snap();
    out.trail.push({step: 'A-before-click', before, teamIds});
    if (before.standard?.team === '6' && before.standard.disabled === false) {
      const r = await mouseClick('#start-standard-pvp');
      out.trail.push({step: 'A-click', rect: r, text: before.standard.text});
      if (await inBattle()) {
        out.path = `真鼠标点「${oneLine(before.standard.text, 40)}」（盒子六只 own 个体经 ?team= 交接；${teamIds.length} 只）`;
        out.started = true;
      } else {
        out.trail.push({step: 'A-no-battle', after: await snap()});
      }
    } else {
      out.trail.push({step: 'A-button-not-ready', standard: before.standard});
    }
  } else {
    out.trail.push({step: 'A-no-six-own-ids', teamIds});
  }

  // 路径 B（回落）：`?legacy3v3=1` + 真鼠标点满 3+3 + 真鼠标点「开一局（双方各 3 只）」
  if (!out.started) {
    await send('Page.navigate', {url: `${base}roco.html?legacy3v3=1`});
    await ready();
    await js(`localStorage.setItem('roco-coach-onboard-v1','1')`);
    await send('Page.reload');
    await ready();
    await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await sleep(500);
    const picked = [];
    for (let i = 0; i < 30; i += 1) {
      const counts = await js(`(()=>{const d=window.rocoDemo;return {player:d.state.pick.player.length,
        enemy:d.state.pick.enemy.length,side:d.state.pick.side};})()`);
      if (counts.player >= 3 && counts.enemy >= 3) break;
      const next = await js(`(()=>{const b=[...document.querySelectorAll('#roster button[data-pet]')]
        .find((x)=>!x.classList.contains('blocked')&&!x.classList.contains('chosen'));
        return b?b.dataset.pet:null;})()`);
      if (!next) break;
      await mouseClick(`#roster button[data-pet="${next}"]`);
      await sleep(180);
      picked.push(next);
    }
    const filled = await js(`(()=>{const d=window.rocoDemo;const b=document.getElementById('start-battle');
      return {player:d.state.pick.player.length,enemy:d.state.pick.enemy.length,disabled:b.disabled};})()`);
    out.trail.push({step: 'B-picked', picked, filled});
    if (filled.player === 3 && filled.enemy === 3 && filled.disabled === false) {
      const r = await mouseClick('#start-battle');
      out.trail.push({step: 'B-click', rect: r});
      if (await inBattle()) {
        out.path = `真鼠标在名单里点满 3+3（${picked.join('、')}）后点「开一局（双方各 3 只）」（legacy3v3=1 回落路径）`;
        out.started = true;
      } else {
        out.trail.push({step: 'B-no-battle', after: await snap()});
      }
    }
  }

  const after = await snap();
  await shoot('01-battle-entered');
  Object.assign(out, {after, legalSkills: after.legalSkills, clickableSlots: after.clickableSlots,
    turn: after.turn, route: after.route, url: await js('location.href'),
    ready: after.ready, panelVisible: after.panel});
  return out;
}

// ── J8：立绘框底边接缝（真页面采样：整页截图 + rect → 磁盘上那张 PNG 的像素）──────
/**
 * 在既有的「真鼠标进战斗 → 量各种事实」流程里补一份**立绘框接缝**事实：
 * 我方（页面上有对手立绘框就一并量）立绘框的 rect + 它所在那一跑的**整页 PNG 的磁盘路径**。
 *
 * 前提（已在真无头 Chrome 上实测确认）：`shoot()` 走的是 `Page.captureScreenshot {format:'png'}`
 * 且**没有 clip**，而本套件进战斗前设了 `Emulation.setDeviceMetricsOverride {width:1440,height:900,
 * deviceScaleFactor:1}` ⇒ 落盘的 PNG 就是 1440×900 整页，**客户区坐标 == 页面坐标**，
 * 可以直接按 rect 取像素。这一条也在判据里复核（图尺寸/dpr 对不上就报「量不到」，不硬算）。
 *
 * ⚠ `--no-shots` 不写盘 ⇒ 没有 PNG 可解码 ⇒ J8 **如实报「量不到」并判红**（门禁不带这个开关）。
 */
async function measureSeam({js, shoot}) {
  const out = {ok: false, failReason: null, shot: null, viewport: null, self: null, foe: null, fieldAudit: null};
  const probe = `(()=>{
    const pick=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
        bottom:Math.round(r.bottom),right:Math.round(r.right)};};
    const boxOf=(card)=>card?(card.querySelector('[data-b3-spritebox]')||card.querySelector('.b3-free')):null;
    const selfCard=document.querySelector('[data-b3-self-card]')||document.querySelector('.b3-card');
    const foeCard=document.querySelector('[data-b3-foe-card]');
    const sb=boxOf(selfCard), fb=boxOf(foeCard);
    const cs=(el)=>{if(!el)return null;const s=getComputedStyle(el);
      return {borderBottomWidth:s.borderBottomWidth,borderBottomColor:s.borderBottomColor,
        maskImage:(s.maskImage||s.webkitMaskImage||'none').slice(0,80)};};
    return {vw:window.innerWidth,vh:window.innerHeight,dpr:window.devicePixelRatio,
      scrollX:window.scrollX,scrollY:window.scrollY,
      tab:document.body.dataset.b3Tab??null,
      panelVisible:!document.getElementById('battle-panel').hidden,
      selfBox:pick(sb),foeBox:pick(fb),
      selfSprite:pick(sb?sb.querySelector('img.b3-sprite'):null),
      selfStyle:cs(sb),foeStyle:cs(fb),
      selfCardFound:Boolean(selfCard),foeCardFound:Boolean(foeCard)};})()`;
  try {
    // 先截图（整页、无 clip），再量 rect：落盘那一帧就是判据要解释的那一帧（回合制页面在同一手里是静止的）
    const shot = await shoot(SEAM_SHOT_NAME);
    out.shot = (typeof shot === 'string' && shot.endsWith('.png')) ? shot : null;
    const geom = await js(probe);
    out.viewport = {w: geom.vw, h: geom.vh, dpr: geom.dpr, scrollX: geom.scrollX, scrollY: geom.scrollY,
      tab: geom.tab, panelVisible: geom.panelVisible};
    let img = null;
    let decodeError = null;
    if (out.shot) {
      try { img = readPng(join(OUT_DIR, out.shot)); }
      catch (error) { decodeError = oneLine(error?.message ?? error, 160); }
    }
    const noShot = !out.shot
      ? `没拿到整页截图（shoot 返回 ${JSON.stringify(shot ?? null)}${SHOTS ? '' : '；本次带 --no-shots，不写盘'}）`
      : (decodeError ? `整页 PNG 解不开：${decodeError}` : null);
    out.fieldAudit = {
      shot: 'j8 用 `shoot()` 的整页截图（`Page.captureScreenshot {format:"png"}`，无 clip）',
      rect: '[data-b3-self-card]/[data-b3-foe-card] 里的 `[data-b3-spritebox]`（回落 `.b3-free`）的 getBoundingClientRect',
      pixels: '`measure-spritebox-seam.mjs` 的 readPng() + seamMetrics()（直接 import 复用，不重写解码器）',
      coordinate: `图 ${img ? `${img.w}×${img.h}` : '—'} vs 客户区 ${geom.vw}×${geom.vh}（deviceScaleFactor=${geom.dpr}）`
        + ' ⇒ 客户区坐标 == 页面坐标，rect 可直接当像素坐标',
      css: `计算样式 border-bottom：我方 ${JSON.stringify(geom.selfStyle)}；对手 ${JSON.stringify(geom.foeStyle)}`,
      note: `body[data-b3-tab]=${JSON.stringify(geom.tab)}，战斗区可见=${geom.panelVisible}，`
        + `页面上有对手卡=${geom.foeCardFound}`,
    };
    out.self = {side: 'self', box: geom.selfBox, img, shot: out.shot, viewport: out.viewport,
      reason: geom.selfBox ? noShot
        : `页面上没有我方立绘框（selfCardFound=${geom.selfCardFound}，`
          + '`[data-b3-self-card]`/`.b3-card` 里没有 `[data-b3-spritebox]`/`.b3-free`）'};
    // 对手侧**可选**：页面上真有对手立绘框才带上（没有就不编；有但量不到照样判红）
    out.foe = geom.foeBox ? {side: 'foe', box: geom.foeBox, img, shot: out.shot, viewport: out.viewport,
      reason: noShot} : null;
    out.ok = true;
    out.failReason = out.self.box ? noShot : out.self.reason;
    return out;
  } catch (error) {
    out.failReason = `量立绘框接缝时脚本自己出错：${oneLine(error?.message ?? error, 160)}`;
    if (!out.self) {
      out.self = {side: 'self', box: null, img: null, shot: out.shot, viewport: out.viewport,
        reason: out.failReason};
    }
    return out;
  }
}

/** 报告里给一份**不带像素缓冲**的接缝摘要（`img` 有 ~5MB，绝不进 JSON）。 */
function seamSummary(fact) {
  if (!fact || typeof fact !== 'object') return null;
  const read = seamSideRead(fact);
  return {side: fact.side ?? null, box: fact.box ?? null, shot: fact.shot ?? null,
    reason: fact.reason ?? null, ok: read.ok, read_reason: read.reason,
    metrics: read.metrics ? {border: read.metrics.border, borderJump: read.metrics.borderJump,
      borderMean: read.metrics.borderMean, stepAcrossBottom: read.metrics.stepAcrossBottom,
      innerMaxJump: read.metrics.innerMaxJump, rows: read.metrics.rows} : null,
    problems: seamSideProblems(fact).map((p) => oneLine(p.text, 300))};
}

// ── J7：真鼠标点「物品」进背包屏，读面板文本 + 引擎 magic 事实 + 已登记证据 ──────
/**
 * 已登记证据：`data/roco/derived/pvp-magic.json`（生成器 `scripts/roco/build-pvp-magic.mjs`；
 * 源头 `data/roco/battle-modes.json#modes[pvp-standard-six-pet].policies.magic_policy.registered`
 * 的「愿力强化」，证据 id `EV-PVP-WISH-POWER-UP`）。
 * **读不到就把 ok=false 交出去**（判据按「没有已登记证据」办），**不回落成编出来的 2 / 3**。
 */
function loadRegisteredItemFacts() {
  const rel = 'data/roco/derived/pvp-magic.json';
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  try {
    const abs = join(ROOT, rel);
    const text = readFileSync(abs, 'utf8');
    const doc = JSON.parse(text);
    const m = doc?.magic ?? {};
    return {ok: true, file: rel, sha256: createHash('sha256').update(text).digest('hex').slice(0, 16),
      magic_id: m.magic_id ?? null, name: m.name ?? null,
      per_battle_uses: num(m.per_battle_uses), cooldown_turns: num(m.cooldown_turns),
      occupies_action: typeof m.occupies_action === 'boolean' ? m.occupies_action : null,
      wish_impact: {energy: num(m?.wish_impact?.energy), power: num(m?.wish_impact?.power)},
      evidence_id: doc?.generated_from?.evidence_id ?? null, ruleset_id: doc?.ruleset_id ?? null};
  } catch (error) {
    return {ok: false, file: rel, error: oneLine(error?.message ?? error, 160),
      per_battle_uses: null, cooldown_turns: null, wish_impact: {energy: null, power: null}};
  }
}

/**
 * 真鼠标走到背包屏并把 J7 要的读数全量出来。**只读**：点完「物品」采完样再点回「技能」，
 * 免得后面 J1–J4 的 3.5s 采样落在一个不是技能屏的页面上（那会让「点技能格」点空）。
 *
 * 字段名是**在真页面上量出来的**（2026-09-25 探针，`/tmp/roco-item-judge/probe-out.json`）：
 *   · 面板原文：`.b3-wrap [data-b3-panel="item"]` 的 `textContent`
 *   · 引擎实数：`window.rocoDemo.state.view.self.magic = {uses_left, cooldown, swapped, cooldown_set_turn}`
 *   · `view.legal[]` 里那条 `kind=magic` 只有 `{kind,label,magic_id,skill,item_id,target_index,...}` ——
 *     **次数与冷却不在动作上**（所以「动作自带的次数/冷却」这条读法在本仓不成立）
 */
async function measureItemPanel({js, mouseClick, shoot, entry}) {
  const out = {ok: false, failReason: null, entered: Boolean(entry?.started), text: null, count: 0,
    panelFound: false, cellCounts: [], cellNotes: [], engineFacts: null, registered: null, fieldAudit: null,
    tabBefore: null, tabAfterClick: null, tabAfter: null, clickRect: null};
  try {
    out.registered = loadRegisteredItemFacts();
    out.tabBefore = await js(`document.body.dataset.b3Tab ?? null`);
    if (!entry?.started) {
      out.failReason = '没进战斗（J5 前置不成立）→ 背包屏没有可信的引擎事实可读';
      return out;
    }
    out.clickRect = await mouseClick('.b3-wrap [data-b3-tab="item"]');
    const ok = await (async () => {
      for (let i = 0; i < 20; i += 1) {
        if (await js(`document.body.dataset.b3Tab === 'item'`)) return true;
        await sleep(150);
      }
      return false;
    })();
    out.tabAfterClick = await js(`document.body.dataset.b3Tab ?? null`);
    if (!ok) out.failReason = `真鼠标点了 \`[data-b3-tab="item"]\`，但 body[data-b3-tab]=`
      + `${JSON.stringify(out.tabAfterClick)}（要 "item"）—— 切不到背包屏，这一条读不懂`;
    // 面板原文（只取背包那一块：`T(左列)` 会把隐藏的技能/更换面板的字也算进来）
    const probe = await js(`(()=>{const panel=document.querySelector('.b3-wrap [data-b3-panel="item"]');
      const cells=[...document.querySelectorAll('.b3-wrap [data-b3-item-cell]')];
      const T=(el)=>el?String(el.textContent||'').replace(/\\s+/g,' ').trim():null;
      const v=window.rocoDemo?.state?.view;
      const magic=(v&&v.self&&typeof v.self.magic==='object')?v.self.magic:null;
      const legalMagic=((v&&v.legal)||[]).filter((a)=>a&&a.kind==='magic');
      const num=(x)=>Number.isFinite(Number(x))?Number(x):null;
      const swapped=(m)=>m?(Array.isArray(m.swapped)?m.swapped.length
        :(m.swapped&&typeof m.swapped==='object'?Object.keys(m.swapped).length:null)):null;
      const counts=[...document.querySelectorAll('.b3-wrap [data-b3-item-count]')].map((el)=>T(el));
      const notes=[...document.querySelectorAll('.b3-wrap [data-b3-item-note]')].map((el)=>T(el));
      const r=panel?panel.getBoundingClientRect():null;
      return {panelFound:Boolean(panel),panelVisible:Boolean(r&&r.width>0&&r.height>0),
        text:(T(panel)||cells.map((c)=>T(c)).join(' ')||'').slice(0,900),
        count:cells.length, cellCounts:counts.slice(0,4), cellNotes:notes.slice(0,4),
        magicKeys:magic?Object.keys(magic):[],
        legalKeys:legalMagic.length?Object.keys(legalMagic[0]):[],
        legalHasUsesField:legalMagic.some((a)=>['uses_left','remaining','uses','per_battle','cooldown','cooldown_turns']
          .some((k)=>a&&a[k]!==undefined&&a[k]!==null)),
        engineFacts:{usesLeft:num(magic&&magic.uses_left),cooldown:num(magic&&magic.cooldown),
          swappedCount:num(swapped(magic))}};})()`);
    Object.assign(out, {panelFound: probe.panelFound, text: probe.text, count: probe.count,
      cellCounts: probe.cellCounts, cellNotes: probe.cellNotes, engineFacts: probe.engineFacts});
    out.fieldAudit = {
      text: probe.panelFound ? '[data-b3-panel="item"] 的 textContent' : '（缺钩子 data-b3-panel="item"）',
      count: `data-b3-item-count × ${probe.cellCounts.length}`,
      engineMagic: probe.magicKeys.length
        ? `window.rocoDemo.state.view.self.magic{${probe.magicKeys.join(',')}}`
        : 'view.self.magic 不存在（规则配置没声明 magic 这一类）',
      legalMagic: `view.legal[kind=magic] × ${probe.legalKeys.length}`
        + `（keys: ${probe.legalKeys.join(',') || '—'}；含次数/冷却字段=${probe.legalHasUsesField}）`,
      registered: out.registered?.ok
        ? `${out.registered.file}（sha256 ${out.registered.sha256}，证据 ${out.registered.evidence_id}）`
        : `${out.registered?.file} 读不到：${out.registered?.error}`,
    };
    out.count = probe.count;
    if (!probe.panelFound) out.failReason = '找不到 `[data-b3-panel="item"]`（背包那一块不在页面上）';
    else if (!probe.count) out.failReason = '背包屏在，但一个 `data-b3-item-cell` 都没有（没有可检的文案）';
    else if (!probe.panelVisible) out.failReason = '背包面板尺寸为 0（元素在但没渲染出来）';
    out.ok = !out.failReason;
    return out;
  } catch (error) {
    out.failReason = `量背包屏时脚本自己出错：${oneLine(error?.message ?? error, 160)}`;
    return out;
  } finally {
    // 只读：把页面放回技能屏，免得后面的采样点空
    try {
      if (out.tabAfterClick === 'item') {
        await mouseClick('.b3-wrap [data-b3-tab="skill"]');
        await sleep(300);
      }
      out.tabAfter = await js(`document.body.dataset.b3Tab ?? null`);
    } catch { /* 页面可能已经关了 */ }
    try { await shoot('02b-item-panel'); } catch { /* 截图失败不影响判据 */ }
  }
}

// ── J9 自由动作采样：真鼠标点背包里的愿力强化那一格，读 view 前后 + 再出一手技能 ──────
//
// 人类 2026-09-25 口径：「愿力强化不占行动、背包物品都不占行动；愿力冲击是个技能、照常占行动」。
// 采样**全程真鼠标**（`mouseClick` 派发 mouseMoved/mousePressed/mouseReleased），读的是
// `window.rocoDemo.state.view`（引擎公开视图），不读页面自述的任何结论。
// 「量不到」的每一种情形都写进 `failReason`，由 J9 判红（读不到就不算验过）。
async function measureFreeAction({js, mouseClick, entry}) {
  const out = {ok: false, failReason: null, entered: Boolean(entry?.started),
    cellFound: false, cellAvailable: false, cellRect: null, tabAfterClick: null,
    before: null, after: null, versionAdvanced: null, turnAfterSkill: null,
    registered: null, clicked: false};
  try {
    out.registered = loadRegisteredItemFacts();
    if (!entry?.started) {
      out.failReason = '没进战斗（J5 前置不成立）→ 自由动作没有可信的引擎事实可读';
      return out;
    }
    // ① 真鼠标进背包屏
    await mouseClick('.b3-wrap [data-b3-tab="item"]');
    let onItem = false;
    for (let i = 0; i < 20; i += 1) {
      if (await js(`document.body.dataset.b3Tab === 'item'`)) { onItem = true; break; }
      await sleep(150);
    }
    out.tabAfterClick = await js(`document.body.dataset.b3Tab ?? null`);
    if (!onItem) {
      out.failReason = `真鼠标点了 \`[data-b3-tab="item"]\`，但 body[data-b3-tab]=`
        + `${JSON.stringify(out.tabAfterClick)}（要 "item"）—— 切不到背包屏`;
      return out;
    }
    // ② 找到「愿力强化」那一格（`data-b3-item-id="wish_power_up"`）
    const cell = await js(`(()=>{const c=[...document.querySelectorAll('.b3-wrap [data-b3-item-cell]')]
        .find((el)=>el.dataset.b3ItemId==='wish_power_up');
      if(!c) return {found:false};
      const r=c.getBoundingClientRect();
      return {found:true,grey:c.dataset.b3ItemGrey??null,available:c.dataset.b3ItemAvailable??null,
        hasAction:c.dataset.b3Action!==undefined,actionKind:c.dataset.b3ActionKind??null,
        w:Math.round(r.width),h:Math.round(r.height)};})()`);
    out.cellFound = Boolean(cell?.found);
    out.cellAvailable = cell?.available === 'yes';
    out.cellRect = cell?.found ? {w: cell.w, h: cell.h} : null;
    if (!out.cellFound) {
      out.failReason = '页面上没有 `[data-b3-item-cell][data-b3-item-id="wish_power_up"]`（背包屏找不到那一格）';
      return out;
    }
    if (!(out.cellAvailable && cell.hasAction)) {
      out.failReason = `愿力强化那一格不可用：available=${JSON.stringify(cell.available)}`
        + ` grey=${JSON.stringify(cell.grey)} hasAction=${cell.hasAction}`
        + '（引擎这一步没给 magic 动作：次数用完 / 在冷却 / 规则配置没声明这一类）';
      return out;
    }
    // ③ 前后各读一次引擎公开视图（回合 / state_version / 次数 / 冷却 / 可点技能格）
    const read = () => js(`(()=>{const d=window.rocoDemo;const v=(d&&d.state&&d.state.view)||{};
      const m=(v.self&&typeof v.self.magic==='object')?v.self.magic:null;
      const n=(x)=>Number.isFinite(Number(x))?Number(x):null;
      const clickable=[...document.querySelectorAll('.b3-wrap [data-b3-slot-legal="yes"][data-b3-action]')]
        .filter((el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}).length;
      return {turn:n(v.turn),version:n(v.state_version),usesLeft:m?n(m.uses_left):null,
        cooldown:m?n(m.cooldown):null,clickableSkills:clickable,tab:document.body.dataset.b3Tab??null};})()`);
    out.before = await read();
    // ④ 真鼠标点它（自由动作）
    out.cellRect = await mouseClick('.b3-wrap [data-b3-item-cell][data-b3-item-id="wish_power_up"]');
    out.clicked = true;
    // ⑤ 等 state_version 前进（有界 3s，与解释预算同档）
    for (let i = 0; i < 20; i += 1) {
      const v = await js(`Number(((window.rocoDemo.state.view)||{}).state_version ?? -1)`);
      if (out.before?.version === null || v > out.before.version) { out.versionAdvanced = true; break; }
      await sleep(150);
    }
    if (out.versionAdvanced !== true) out.versionAdvanced = false;
    out.after = await read();
    // ⑥ 回技能屏 → 真鼠标点一个合法技能格 → 读回合（验证「技能照常占行动」）
    await mouseClick('.b3-wrap [data-b3-tab="skill"]');
    await sleep(250);
    const slotSel = '.b3-wrap [data-b3-slot-legal="yes"][data-b3-action]';
    const hasSlot = await js(`(()=>{const el=document.querySelector('${slotSel}');
      if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0;})()`);
    if (!hasSlot) {
      out.failReason = '自由动作之后技能屏没有可点技能格（无法验证「技能照常占行动」）';
      return out;
    }
    await mouseClick(slotSel);
    const want = out.after?.turn === null || out.after?.turn === undefined ? null : out.after.turn + 1;
    for (let i = 0; i < 20; i += 1) {
      const t = await js(`Number(((window.rocoDemo.state.view)||{}).turn ?? -1)`);
      if (want === null || t >= want) break;
      await sleep(150);
    }
    out.turnAfterSkill = await js(`Number(((window.rocoDemo.state.view)||{}).turn ?? -1)`);
    out.ok = true;
    return out;
  } catch (error) {
    out.failReason = `量自由动作时脚本自己出错：${oneLine(error?.message ?? error, 160)}`;
    return out;
  } finally {
    // 只读采样：把页面放回技能屏，免得后面的采样点空
    try { await js(`(()=>{const b=document.querySelector('.b3-wrap [data-b3-tab="skill"]');return Boolean(b);})()`); }
    catch { /* 页面可能已经关了 */ }
  }
}

// ── J10：生命心 ♥ 常显（真页面采样：DOM 原文 + 同一时刻的引擎回执）──────────────
/**
 * 人类 2026-09-25：「战斗页顶部的生命心 ♥ 要**一直看得见**」。判据要三份事实：
 *
 *   ① `initial` —— 真鼠标进战斗之后立刻读一次：两侧心形计数的 DOM 原文（`textContent` +
 *      `outerHTML` + `hidden` / `getClientRects()`）与**同一次求值里**读到的 `view.mana`
 *      （DOM 与引擎回执必须在同一帧读，否则比的不是同一时刻的东西）；
 *   ② `faint` —— 真鼠标连出**合法技能格**把局面推到**引擎自己报出一次力竭**
 *      （`state.matchEvents` 里出现 `kind==='mana_loss'`，那是引擎生成的事件，带中文 `text` 与
 *      `detail.{side,faint_cost,mana}`），掉心**前**那一份读数与掉心**后**那一份读数都记下来；
 *      我方精灵力竭（phase=replace 且 `needs_replacement` 含 player）时真鼠标切「更换」屏点一个替补，
 *      只有对手补位时页面自己会走（`autoAdvanceOpponentReplace`）；
 *   ③ `missingManaProbe` —— 把 `state.view.mana` 抽掉再 `render()`（**合成「引擎没给」这份输入**），
 *      在同一帧里读一次 DOM，再**原样塞回**并 `render()` 还原 —— 验「拿不到 ⇒ 必须 hidden」。
 *
 * ⚠ 引擎回执里**没有** `mana`（legacy / v2 的规则配置不声明这个量）时：①② 没有可对照的事实
 * ⇒ 如实记 `failReason`（**读不到就不算验过**）；这一轮只把③验掉。
 * ⚠ 本函数只**读**引擎与 DOM + 真鼠标点合法技能格；一个数字都不自己算。
 */
async function measureHearts({js, mouseClick, entry, waitFor}) {
  const out = {ok: false, failReason: null, path: entry?.path ?? null, manaAvailable: null,
    turnsDriven: 0, elapsedMs: null, initial: null, faint: null, missingManaProbe: null,
    fieldAudit: {
      dom: '#b3-hearts-self / #b3-hearts-foe：textContent 里两种心形的字数 + hidden + getClientRects()',
      engine: 'view.mana.{self,opponent,pool}（心 = 魔力；pool 是规则常量，从回执读，判据不写字面量）',
      faint: "state.matchEvents[].kind==='mana_loss'（引擎自己报的力竭扣心事件，带中文 text 与 detail.mana）",
      probe: '抽掉 state.view.mana → window.rocoDemo.render() → 同一帧读 DOM（必须 hidden）→ 原样塞回并 render() 还原',
    }};
  const t0 = Date.now();
  // 读一次「同一帧的 DOM + 引擎回执」。**整段自包含**（注入页面执行），心形用码点认，不写字面量。
  const readSrc = `(() => {
    const FULL = String.fromCharCode(0x2665), EMPTY = String.fromCharCode(0x2661);
    const st = window.rocoDemo && window.rocoDemo.state ? window.rocoDemo.state : {};
    const v = st.view || null;
    const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);
    const m = (v && v.mana && typeof v.mana === 'object') ? v.mana : null;
    const cnt = (t, ch) => [...String(t == null ? '' : t)].filter((c) => c === ch).length;
    const one = (el) => {
      if (!el) return {found: false};
      const fullEl = el.querySelector('i:not(.lost)'), emptyEl = el.querySelector('i.lost');
      return {found: true, hidden: el.hidden === true, visible: el.getClientRects().length > 0,
        full: cnt(fullEl ? fullEl.textContent : '', FULL),
        empty: cnt(emptyEl ? emptyEl.textContent : '', EMPTY),
        total: cnt(el.textContent, FULL) + cnt(el.textContent, EMPTY),
        text: String(el.textContent == null ? '' : el.textContent), html: String(el.outerHTML || '')};
    };
    return {engine: {mana: m ? {self: n(m.self), opponent: n(m.opponent), pool: n(m.pool)} : null,
        turn: n(v && v.turn), phase: (v && v.phase) || null, stateVersion: n(v && v.state_version)},
      dom: {self: one(document.getElementById('b3-hearts-self')),
        foe: one(document.getElementById('b3-hearts-foe'))},
      bodyHearts: cnt(document.body.innerText, FULL) + cnt(document.body.innerText, EMPTY),
      at: Math.round(performance.now())};
  })()`;
  const read = () => js(readSrc);
  try {
    if (!entry?.started) {
      out.failReason = '没进战斗（J5 前置不成立）→ 生命心没有可信的引擎事实可读';
      return out;
    }
    // 先回到技能屏（真鼠标点技能格要在技能屏上才点得到）
    try { await mouseClick('.b3-wrap [data-b3-tab="skill"]'); } catch { /* 找不到就照旧 */ }
    await sleep(240);
    out.initial = await read();
    const mana = out.initial?.engine?.mana ?? null;
    out.manaAvailable = Boolean(mana) && Number.isFinite(mana.self) && Number.isFinite(mana.opponent)
      && Number.isFinite(mana.pool);
    // ③ 「拿不到 mana ⇒ 必须 hidden」的探针（合成输入：抽掉 `state.view.mana`）。整段原子执行。
    const probe = await js(`(() => {
      const st = window.rocoDemo && window.rocoDemo.state ? window.rocoDemo.state : {};
      const view = st.view || null;
      const had = Boolean(view) && Object.prototype.hasOwnProperty.call(view, 'mana');
      const saved = had ? view.mana : null;
      if (had) { delete view.mana; }
      window.rocoDemo.render();
      const after = ${readSrc};
      if (had) { view.mana = saved; }
      window.rocoDemo.render();
      const restoredRead = ${readSrc};
      return {had: had, after: after, restoredRead: restoredRead};
    })()`);
    out.missingManaProbe = {taken: Boolean(probe?.after), restored: null, hadManaKey: Boolean(probe?.had),
      before: out.initial, after: probe?.after ?? null, restoredRead: probe?.restoredRead ?? null,
      reason: '合成「引擎没给」：抽掉 state.view.mana 再 window.rocoDemo.render()（同一帧读 DOM），随后原样塞回'};
    // 还原成功的判据：原来有 mana 键的，还原后两侧必须又可见；原来没有的（legacy），还原后仍 hidden。
    const rs = probe?.restoredRead ?? null;
    out.missingManaProbe.restored = Boolean(rs)
      && (probe?.had
        ? (rs.dom?.self?.visible === true && rs.dom?.foe?.visible === true)
        : (rs.dom?.self?.hidden === true && rs.dom?.foe?.hidden === true));
    if (!out.manaAvailable) {
      out.failReason = '这一局的引擎回执里**没有** `view.mana`（入口走的是不声明 mana 的规则配置，'
        + '例如 `?legacy3v3=1`）⇒ 判据①②（实心数 == view.mana.self / 总数 == view.mana.pool / 力竭 -1）'
        + '**没有可对照的引擎事实**，读不到就不算验过；③（拿不到必须 hidden）本轮已按实际状态验过';
      return out;
    }
    // ② 真鼠标连出合法技能格 → 推到一次力竭（引擎事件 mana_loss）→ 掉心前后各一份读数
    let last = out.initial;
    // 力竭事件是**累计**的（`state.matchEvents`）：先记下起点条数，只有**变多**才算「这一步报出了新的力竭」。
    let knownManaEvents = Number(await js(`((window.rocoDemo.state || {}).matchEvents || [])
      .filter((e) => e && e.kind === 'mana_loss').length`)) || 0;
    for (let step = 1; step <= 16; step += 1) {
      const snap = await js(`(() => {
        const st = window.rocoDemo.state || {};
        const v = st.view || {};
        const slots = [...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map((el) => ({action: el.dataset.b3Action == null ? null : String(el.dataset.b3Action),
            kind: el.dataset.b3ActionKind || null,
            cat: String((el.querySelector('[data-b3-skill-cat]') || {}).textContent || '').trim()}));
        const legal = slots.filter((s) => s.action !== null && s.kind === 'skill');
        const attack = legal.find((s) => s.cat.indexOf('攻击') >= 0) || legal[0] || null;
        const evs = (st.matchEvents || []).filter((e) => e && e.kind === 'mana_loss');
        return {turn: v.turn == null ? null : Number(v.turn), phase: v.phase || null,
          stateVersion: v.state_version == null ? null : Number(v.state_version),
          needsReplacement: Array.isArray(v.needs_replacement) ? v.needs_replacement.slice() : null,
          results: v.result || null, attack: attack, legalCount: legal.length, manaEvents: evs.length};
      })()`);
      if (snap.results) { out.stopReason = `对局已结束（result=${JSON.stringify(snap.results)}）`; break; }
      if (snap.phase === 'replace' && Array.isArray(snap.needsReplacement)
        && snap.needsReplacement.includes('player')) {
        // 我方精灵力竭：真鼠标切「更换」屏 → 点一个可点的替补（玩家自己的决定，页面不替玩家点）
        try { await mouseClick('.b3-wrap [data-b3-tab="switch"]'); } catch { /* 找不到就下一步 */ }
        await sleep(240);
        const pick = await js(`(() => { const rows = [...document.querySelectorAll('.b3-wrap [data-b3-switch-row]')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map((el) => ({action: el.dataset.b3Action == null ? null : String(el.dataset.b3Action)}));
          return rows.find((x) => x.action !== null) || null; })()`);
        if (!pick) { out.failReason = '补位局面：更换屏上没有可点的替补行（推不到下一次掉心）'; break; }
        await mouseClick(`.b3-wrap [data-b3-switch-row][data-b3-action="${pick.action}"]`);
      } else if (!snap.attack) {
        out.failReason = `第 ${step} 步技能屏上没有可点的合法技能格（legal=${JSON.stringify(snap.legalCount)}`
          + `，phase=${JSON.stringify(snap.phase)}）`;
        break;
      } else {
        await mouseClick(`.b3-wrap [data-b3-skill-slot][data-b3-action="${snap.attack.action}"]`);
      }
      out.turnsDriven = step;
      // 等这一手真的结算（回合 / state_version / phase 任一变化），有界 3s
      await waitFor(`(() => { const v = (window.rocoDemo.state || {}).view || {};
        return (v.turn !== ${JSON.stringify(snap.turn)}) || (v.state_version !== ${JSON.stringify(snap.stateVersion)})
          || (v.phase !== ${JSON.stringify(snap.phase)}); })()`, 20, 150);
      await sleep(120);
      const now = await read();
      const evRead = await js(`(() => { const evs = ((window.rocoDemo.state || {}).matchEvents || [])
        .filter((e) => e && e.kind === 'mana_loss');
        const e = evs.length ? evs[evs.length - 1] : null;
        return {count: evs.length, event: e ? {turn: e.turn == null ? null : Number(e.turn), kind: e.kind,
          side: e.side == null ? null : String(e.side), detail: e.detail || null,
          text: typeof e.text === 'string' ? e.text : null} : null}; })()`);
      const ev = evRead?.event ?? null;
      const engineChanged = JSON.stringify(now.engine.mana) !== JSON.stringify(last.engine.mana);
      if (ev && Number(evRead?.count ?? 0) > knownManaEvents) {
        // 引擎报了一次**新的**力竭 ⇒ 这就是掉心那一步
        knownManaEvents = Number(evRead.count);
        // 引擎的 `side` 在 `detail.side` 里（顶层那个键是 null）：两处都认，报告里两个都留着。
        const evSide = ev.side ?? ev.detail?.side ?? null;
        out.faint = {found: true, steps: step, eventSide: evSide,
          side: evSide === 'player' ? 'self' : (evSide === 'enemy' ? 'opponent' : null),
          engineChanged: engineChanged, event: ev, before: last, after: now,
          domSelf: `掉心前 ${last.dom.self.text} → 掉心后 ${now.dom.self.text}`,
          domFoe: `掉心前 ${last.dom.foe.text} → 掉心后 ${now.dom.foe.text}`};
        break;
      }
      last = now;
    }
    if (!out.faint) {
      out.faint = {found: false, steps: out.turnsDriven, before: last, after: null,
        reason: out.failReason ?? `连出 ${out.turnsDriven} 手合法技能都没推到一次力竭`
          + `（上限 16 步；stopReason=${out.stopReason ?? '—'}）`};
      if (!out.failReason) out.failReason = out.faint.reason;
      return out;
    }
    // 采样点：回技能屏（后面的 J1–J4 要在技能屏上点技能格）
    try { await mouseClick('.b3-wrap [data-b3-tab="skill"]'); } catch { /* 找不到就照旧 */ }
    out.ok = true;
    return out;
  } catch (error) {
    out.failReason = `量生命心时脚本自己出错：${oneLine(error?.message ?? error, 160)}`;
    return out;
  } finally {
    out.elapsedMs = Date.now() - t0;
  }
}

// ── 真鼠标点一个合法攻击技能格 + 3.5s 采样 ──────────────────────────────────
async function measureAction({js, send, mouseClick, waitFor, shoot, entry, itemPanel, seam = null, freeAction = null, hearts = null}) {
  const pageErrorsAtStart = results.pageErrors.length;
  const consoleErrorsAtStart = results.consoleErrors.length;
  const traces = [];

  /** 把页面上的浮层收起来（它们不是这一段要量的东西，但会盖住技能格让真鼠标点空）。 */
  const hideOverlays = () => js(`(()=>{for(const id of ['hint','pet-detail','lesson-card']){
      const el=document.getElementById(id);if(el)el.hidden=true;}
    const card=document.getElementById('companion-card');if(card)card.hidden=true;
    const drawer=document.getElementById('about-drawer');if(drawer)drawer.open=false;return true;})()`);

  const slotProbe = () => js(`(()=>{const v=window.rocoDemo.state.view;
    const legal=(v&&v.legal)||[];
    const samples=(v&&v.damage_preview&&v.damage_preview.samples)||[];
    const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')];
    const rows=slots.map((s,i)=>{const idx=s.dataset.b3Action===undefined?null:Number(s.dataset.b3Action);
      const act=idx===null?null:legal[idx];
      const r=s.getBoundingClientRect();
      const cat=((s.querySelector('[data-b3-skill-cat]')||{}).textContent||'').trim();
      const label=((s.querySelector('[data-b3-skill-name]')||{}).textContent||'').trim();
      const sample=samples.find((x)=>x&&x.label===label)||null;
      return {i,kind:s.dataset.b3ActionKind??null,skillId:s.dataset.b3SkillId??null,actionIndex:idx,
        label,cat,engineCat:(act&&act.skill&&act.skill.category)||(act&&act.category)||null,
        engineSkillId:(act&&act.skill_id)||(act&&act.skill&&act.skill.skill_id)||null,
        damage:(sample&&Number.isFinite(sample.damage))?sample.damage:null,
        legal:s.dataset.b3SlotLegal??null,pending:s.dataset.b3Pending??null,
        w:Math.round(r.width),h:Math.round(r.height),
        cx:Math.round(r.left+r.width/2),cy:Math.round(r.top+r.height/2)};});
    return {turn:v?v.turn:null,phase:v?v.phase:null,tab:document.body.dataset.b3Tab??null,
      legalSkills:legal.filter((a)=>a.kind==='skill').length,
      clickableRows:rows.filter((r)=>r.kind==='skill'&&r.actionIndex!==null&&r.w>0&&r.h>0).length,rows};})()`);

  /** 没有可点的技能格时：补位那一帧先真鼠标点一行「更换」，否则推进一手（上限内轮询，不空等）。 */
  const ensureActionable = async () => {
    const trace = [];
    for (let i = 0; i < 10; i += 1) {
      const probe = await slotProbe();
      trace.push({step: i, turn: probe.turn, phase: probe.phase, tab: probe.tab,
        legalSkills: probe.legalSkills, clickable: probe.clickableRows});
      if (probe.clickableRows > 0) return {ok: true, probe, trace};
      if (probe.phase === 'replace' || probe.tab === 'switch') {
        const row = await js(`(()=>{const el=document.querySelector('.b3-wrap [data-b3-switch-row][data-b3-action]');
          return el?true:false;})()`);
        if (row) { await mouseClick('.b3-wrap [data-b3-switch-row][data-b3-action]'); await sleep(900); continue; }
      }
      if (probe.tab !== 'skill') { await mouseClick('.b3-wrap [data-b3-tab="skill"]'); await sleep(400); continue; }
      await js('window.rocoDemo.autoTurn()');
      await sleep(900);
    }
    return {ok: false, probe: await slotProbe(), trace};
  };

  const attempts = [];
  let chosen = null;
  for (let attempt = 1; attempt <= CLICK_ATTEMPTS && !chosen; attempt += 1) {
    await hideOverlays();
    const ensured = await ensureActionable();
    traces.push({attempt, ensured});
    if (!ensured.ok) {
      attempts.push({attempt, ok: false, why: '没有可点的技能格', digest: {clickable: 0},
        facts: {timeline: [], floats: [], frames: [], battleStarted: entry.started,
          itemPanel: itemPanel ?? null,
          seam: seam ?? null,
          freeAction: freeAction ?? null,
          hearts: hearts ?? null,
          legalSkills: ensured.probe?.legalSkills ?? 0, finalFloatCount: null,
          precondition: {pageReady: entry.ready, battlePanelVisible: entry.panelVisible,
            clickableSlots: 0, clickAccepted: false, attempts: attempt, entryPath: entry.path, skill: null},
          errors: {pageExceptions: results.pageErrors.length, consoleErrors: results.consoleErrors.length}}});
      break;
    }
    const probe = ensured.probe;
    // 优先挑**攻击**招（并且引擎给过伤害样本）：只有攻击招才必然有「出手 → 受击」这一对。
    const clickable = probe.rows.filter((r) => r.kind === 'skill' && r.actionIndex !== null && r.w > 0 && r.h > 0);
    const attack = clickable.filter((r) => r.cat === '攻击' || r.engineCat === 'attack');
    const withDamage = attack.filter((r) => Number(r.damage) > 0);
    const ranked = [...withDamage, ...attack.filter((r) => !withDamage.includes(r)),
      ...clickable.filter((r) => !attack.includes(r))];
    const pick = ranked[Math.min(attempt - 1, ranked.length - 1)];
    if (!pick) break;
    await js(`(()=>{document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')
      .forEach((el)=>delete el.dataset.b3fbPick);
      const s=document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')[${pick.i}];
      if(s)s.dataset.b3fbPick='yes';return Boolean(s);})()`);
    const sel = '.b3-wrap [data-b3-skill-slot][data-b3fb-pick="yes"]';
    // 真鼠标点下去之前先确认「那个坐标上确实是这一格」（浮层盖住就地报出来）
    const hitBefore = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el)return null;const r=el.getBoundingClientRect();
      const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);
      const top=document.elementFromPoint(x,y);
      const c=(e)=>{if(!e)return null;const k=e.className;return String(k&&k.baseVal!==undefined?k.baseVal:(k??''));};
      return {x,y,hitClass:c(top),hitTag:top?top.tagName.toLowerCase():null,
        hitSelf:Boolean(top)&&(top===el||el.contains(top))};})()`);

    // ── 采样：用户点技能**之前**挂 MutationObserver（+逐帧 elementFromPoint 采样）──
    await js(samplerSource());
    await js('window.__b3fb.reset && window.__b3fb.reset()');
    await js('window.__b3fb.start()');
    await shoot(`02-before-click-attempt${attempt}`);
    await js('window.__b3fb.markClick()');
    const clickRect = await mouseClick(sel);
    const clickedAt = Date.now();
    // 轮询（上限 3.5s，不空等、不刷屏）
    let peek = null;
    for (let i = 0; i < 40 && Date.now() - clickedAt < WINDOW_MS; i += 1) {
      await sleep(120);
      peek = await js('window.__b3fb.peek()');
    }
    const snap = await js('window.__b3fb.stop()');
    await shoot(`03-after-fx-attempt${attempt}`);
    const after = await slotProbe();
    const view = await js(`(()=>{const v=window.rocoDemo.state.view;return {turn:v?v.turn:null,
      phase:v?v.phase:null,events:Array.isArray(v&&v.events)?v.events.length:null};})()`);
    const cues = snap.timeline.filter((e) => e.kind === 'cue');
    const floatEvents = snap.timeline.filter((e) => e.kind === 'float');
    const attackCues = cues.filter((e) => (e.detail?.role ?? null) === 'attack');
    const defenderSide = attackCues.length ? (attackCues[0].side === 'self' ? 'foe' : 'self') : null;
    const defenderEvents = defenderSide
      ? snap.timeline.filter((e) => e.side === defenderSide
        && (e.kind === 'float' || (e.kind === 'cue' && e.detail?.role === 'hit'))) : [];
    const digitFloats = snap.floats.filter((x) => /\d/.test(String(x.text ?? '')));
    const delta = (attackCues.length && defenderEvents.length)
      ? +(Number(defenderEvents[0].t) - Number(attackCues[0].t)).toFixed(2) : null;
    const clicked = Boolean(snap.clickT !== null && (snap.timeline.length > 0 || after.turn !== probe.turn));
    // J6 的采样：连出最贵的合法技能把「星不够」那一档逼出来（最多 6 手）。
    // 只在**能点**的情况下推进；出错一律吞掉并如实记进 facts（判据那边会写「没触发」）。
    const slotSamples = [];
    const slotEnergyTrace = [];
    const slotReds = [];
    let slotHitTurn = null;
    try {
      for (let i = 0; i < 6; i += 1) {
        const snap6 = JSON.parse(await js(`(()=>{const d=window.rocoDemo;const v=d.state.view;
          const me=(v&&v.self&&Array.isArray(v.self.pets))?v.self.pets[v.self.active??0]:null;
          const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')].map((el,idx)=>{
            const costEl=el.querySelector('[data-b3-cost]');
            const txt=costEl?costEl.textContent:'';
            const n=Number((txt.match(/(\\d+)/)||[0])[0]);
            return {index:idx, name:((el.querySelector('[data-b3-skill-name]')||{}).textContent||'').trim(),
              cost:n, legal:el.dataset.b3SlotLegal??null, short:el.dataset.b3CostShort??null,
              action:(el.dataset.b3Action===undefined?null:el.dataset.b3Action),
              cls:el.className, color:costEl?getComputedStyle(costEl).color:null};});
          const cand=slots.filter((x)=>x.legal==='yes'&&x.action!==null&&Number.isFinite(x.cost))
            .sort((a,b)=>b.cost-a.cost);
          return JSON.stringify({turn:v?v.turn:null, phase:v?v.phase:null, energy:me?me.energy:null,
            slots, priciestIndex:cand.length?cand[0].index:null,
            red:(getComputedStyle(document.documentElement).getPropertyValue('--b3-red')||'').trim()});})()`));
        slotSamples.push(...snap6.slots);
        slotEnergyTrace.push(snap6.energy);
        if (snap6.red) {
          slotReds.push(snap6.red);
          const m = /^#([0-9a-f]{6})$/i.exec(snap6.red);
          if (m) {
            const n = parseInt(m[1], 16);
            slotReds.push(`rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`);
          }
        }
        if (snap6.slots.some((x) => x.short === 'yes')) { slotHitTurn = snap6.turn; break; }
        if (snap6.phase !== 'battle' || snap6.priciestIndex === null) break;
        await mouseClick(`.b3-wrap [data-b3-skill-slot="${snap6.priciestIndex}"]`);
        await sleep(2500);
      }
    } catch (error) {
      slotSamples.push({error: String((error && error.message) || error)});
    }
    const facts = {
      slotSamples, slotReds, slotEnergyTrace, slotHitTurn,
      // J7 的读数：在 `measureItemPanel` 里用真鼠标点「物品」采的（这里只是带进 facts）
      itemPanel: itemPanel ?? null,
      // J8 的读数：在 `measureSeam` 里量的（rect + 整页 PNG 路径 + 解码后的像素）
      seam: seam ?? null,
      // J9 的读数：在 `measureFreeAction` 里用真鼠标点愿力强化那一格采的
      freeAction: freeAction ?? null,
      // J10 的读数：在 `measureHearts` 里读的（DOM 原文 + 同一时刻的 view.mana；力竭前后 + 抽掉 mana 的探针）
      hearts: hearts ?? null,
      timeline: snap.timeline,
      floats: snap.floats,
      frames: snap.frames,
      battleStarted: entry.started,
      legalSkills: probe.legalSkills,
      finalFloatCount: snap.finalFloatCount,
      precondition: {pageReady: entry.ready, battlePanelVisible: entry.panelVisible,
        clickableSlots: probe.clickableRows, slotClickable: hitBefore?.hitSelf === true,
        clickAccepted: clicked, attempts: attempt, entryPath: entry.path,
        skill: {slot: pick.i, label: pick.label, category: pick.cat, damage: pick.damage,
          engineCategory: pick.engineCat, choice_basis: '优先攻击招（页面类别「攻击」或引擎 category=attack），并且优先引擎给过伤害样本的那一格'}},
      errors: {pageExceptions: results.pageErrors.length, consoleErrors: results.consoleErrors.length,
        pageExceptionSamples: results.pageErrors.slice(-3), consoleErrorSamples: results.consoleErrors.slice(-3)},
      meta: {url: entry.url, attempt, windowMs: snap.sinceClickMs, clickT: snap.clickT,
        rootSeen: snap.rootSeen, frameCount: snap.frameCount, selfErrors: snap.selfErrors,
        sideEvidence: snap.sideEvidence, hitBefore, peekAtEnd: peek},
    };
    const digest = {attempt, turn: probe.turn, turnAfter: after.turn, phase: after.phase,
      eventsAfter: view.events, slot: pick.i, label: pick.label, category: pick.cat, damage: pick.damage,
      hitBefore, clickRect, windowMs: snap.sinceClickMs, timeline: snap.timeline.length,
      cues: cues.length, attackCues: attackCues.length, floatEvents: floatEvents.length,
      floats: snap.floats.length, digitFloats: digitFloats.length, defenderEvents: defenderEvents.length,
      deltaFirstPairMs: delta, finalFloatCount: snap.finalFloatCount,
      floatTexts: snap.floats.map((x) => `${x.text}@${x.side}`), frames: snap.frameCount,
      selfErrors: snap.selfErrors,
      // J8：这一跑的接缝读数（不带像素缓冲，只带 rect/路径/量出来的数）
      seam: seam ? {shot: seam.shot, viewport: seam.viewport,
        self: seamSummary(seam.self), foe: seamSummary(seam.foe)} : null};
    attempts.push({attempt, ok: true, digest, facts});
    // 判据口径与页面现状无关：「打出去了」就以这一次为准；没打出去才重试（重试只为把动作真的打出去）
    if (clicked) chosen = attempts[attempts.length - 1];
  }
  const used = chosen ?? attempts[attempts.length - 1];
  const findings = feedbackFindings(used.facts);
  return {findings, attempts, facts: used.facts, digest: used.digest, traces,
    errors: {pageExceptionsAtStart: pageErrorsAtStart, consoleErrorsAtStart,
      pageExceptions: results.pageErrors, consoleErrors: results.consoleErrors}};
}

// ── 汇总、打印、写报告 ──────────────────────────────────────────────────────
function finish({baselineProblems, clientBefore, clientAfter, stack, real, entry, note, itemPanel = null, seam = null, freeAction = null, hearts = null}) {
  const checks = results.checks;
  const failed = checks.filter((c) => c.ok === false);
  const unreadable = checks.filter((c) => c.unreadable === true);
  const passed = checks.filter((c) => c.ok === true);
  const counters = results.counterproofs;
  const countersMissed = counters.filter((c) => !c.hit);
  const openProblems = feedbackProblemsFromChecks(checks);

  log('');
  for (const row of failed) {
    log(`✖ ${row.id} ${row.name} | 实际值：${oneLine(row.actual, 300)} | 缺：`
      + `${oneLine(row.missing.join('；') || '—', 200)}`);
  }
  for (const row of unreadable) log(`○ ${row.id} ${row.name} | 读不懂：${oneLine(row.actual, 300)}`);
  log('');
  for (const c of countersMissed) log(`✖ [反证 ${c.id}] 没命中：${oneLine(c.name, 160)}`);
  log(`判据 ${passed.length}/${checks.length} 通过（红 ${failed.length}、读不懂 ${unreadable.length}）；`
    + `反证 ${counters.filter((c) => c.hit).length}/${counters.length} 命中`
    + (note ? `；${note}` : ''));

  const report = {
    schema: 'roco-battle-feedback/v1',
    // 保留资产元套件（revalidate-retained-assets.mjs）读的契约字段
    all_ok: checks.length > 0 && failed.length === 0 && unreadable.length === 0 && countersMissed.length === 0,
    generated_at: new Date().toISOString(),
    what: '战斗反馈验收：① 伤害/治疗数字真的看得见（不是被立绘压住）② 出手与受击有先后（不同一帧齐发）'
      + '③ 背包屏的数字可追溯（引擎实数 / 已登记证据）+ 该显示的必须显示（2026-09-25 决策 4「（甲）读法」）'
      + '④ 立绘框底边接缝（框底那一行跳变 ≤ 6 + 跨框底一步 |Δ亮度| ≤ 3；2026-09-25 决策 1「把接缝压掉」）',
    how: '自起 app server(8895) + 自拉 headless Chrome + 真鼠标进战斗 + 量立绘框接缝（J8：整页 PNG 的像素）'
      + ' + 真鼠标点「物品」读背包屏（J7）+ 真鼠标点技能；'
      + '页面里挂 MutationObserver(childList/subtree/attributes/characterData) 记 DOM 变化时间，'
      + '逐帧 elementFromPoint 记「数字在不在最上层」；**不读客户端自述的任何时间戳字段**',
    totals: {checks: checks.length, passed: passed.length, failed: failed.length,
      unreadable: unreadable.length, counterproofs: counters.length,
      counterproofs_hit: counters.filter((c) => c.hit).length,
      counterproofs_missed: countersMissed.length},
    checks,
    problems: openProblems,
    counterproofs: counters,
    baseline: {problems: baselineProblems, empty: baselineProblems.length === 0,
      facts_note: '合成基线：出手方线索 t=100、受击方浮字 t=260（Δ=160ms）、elementFromPoint 命中浮字自身、'
        + '存活 900ms、结束时已移除；背包屏（J7）用真页面量到的原文 + 引擎实数 uses_left=2/cooldown=0 '
        + '+ 已登记 per_battle_uses=2/cooldown_turns=3'},
    stack_replica: stack,
    item_panel: itemPanel,
    free_action: freeAction,
    // J10 的实测事实（**不带 DOM 之外的任何东西**：DOM 原文、同一时刻的引擎回执、力竭事件、探针）
    hearts: hearts,
    // J8 的实测事实（**不带像素缓冲**：img 有 ~5MB，绝不进 JSON）。判据与读数是同一份纯函数。
    seam: seam ? {ok: seam.ok, failReason: seam.failReason, shot: seam.shot, viewport: seam.viewport,
      fieldAudit: seam.fieldAudit,
      thresholds: {borderJumpMax: SEAM_BORDER_JUMP_MAX, stepAcrossBottomMax: SEAM_STEP_MAX,
        note: '阈值来自主线程真机实测：框底那一行跳变 改前 46.4 → 改后 0.8；跨框底一步 改前 23.4'
          + '（对手侧 24.5）→ 改后 0.0 / 1.1。两条都必须成立，缺一即红；量不到也判红'},
      self: seamSummary(seam.self), foe: seamSummary(seam.foe)} : null,
    real_page: real ? {
      entry, digest: real.digest, facts_summary: summarizeFacts(real.facts),
      item_panel: real.facts.itemPanel ?? null,
      hearts: real.facts.hearts ?? null,
      seam: real.digest?.seam ?? null,
      attempts: real.attempts.map((a) => ({attempt: a.attempt, ok: a.ok, why: a.why ?? null, digest: a.digest})),
      timeline: real.facts.timeline, floats: real.facts.floats,
      element_from_point: real.facts.floats.flatMap((x) => (x.samples ?? []).slice(0, 6).map((s) =>
        ({float: x.text, side: x.side, t: s.t, measurable: s.measurable, cx: s.cx, cy: s.cy,
          hitClass: s.hitClass, hitTag: s.hitTag, hitIsFloat: s.hitIsFloat}))),
      frames_count: real.facts.frames.length,
      side_evidence: real.facts.meta?.sideEvidence ?? null,
      traces: real.traces,
    } : null,
    client_revision: {before: clientBefore, after: clientAfter,
      note: 'src/client 由**别的代理并行修改**：这两个哈希说明这一跑量的是哪一版；两处不同 = 跑的过程中被改过'},
    screenshots: results.shots,
    console_errors: results.consoleErrors,
    page_errors: results.pageErrors,
    port: PORT,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 1)}\n`);
  log(`报告：reports/roco/battle-feedback.json`);
  log(`${passed.length}/${checks.length} 条通过`);

  if (failed.length || unreadable.length || countersMissed.length) process.exitCode = 1;
}

/** 从已记录的判据行里还原 problem 文本（报告里给一份人读的清单）。 */
function feedbackProblemsFromChecks(checks) {
  return checks.flatMap((c) => (c.problems_detail ?? []).map((p) =>
    `[${c.id} ${c.name}] ${p.text}（实际值：${p.actual}；缺：${p.missing}）`));
}

/** 报告里的「实测数字」摘要：时间线带 ms 差、elementFromPoint 实际 class、浮字存活时长。 */
function summarizeFacts(facts) {
  const timeline = facts.timeline ?? [];
  const cues = timeline.filter((e) => e.kind === 'cue');
  const attackCues = cues.filter((e) => (e.detail?.role ?? null) === 'attack');
  const hitCues = cues.filter((e) => (e.detail?.role ?? null) === 'hit');
  const floats = facts.floats ?? [];
  const base = attackCues.length ? Number(attackCues[0].t) : null;
  const rel = (t) => (base === null ? null : fx(Number(t) - base));
  return {
    timeline_entries: timeline.length,
    cues: cues.length, attack_cues: attackCues.length, hit_cues: hitCues.length,
    float_events: timeline.filter((e) => e.kind === 'float').length,
    float_gone_events: timeline.filter((e) => e.kind === 'float-gone').length,
    first_attack_cue: attackCues.length
      ? {t: fx(attackCues[0].t), side: attackCues[0].side, what: attackCues[0].detail?.what ?? null, relT: 0} : null,
    timeline_rel_ms: timeline.slice(0, 24).map((e) => ({t: fx(e.t), relT: rel(e.t), kind: e.kind, side: e.side,
      what: e.detail?.what ?? e.detail?.text ?? null})),
    floats: floats.map((x) => ({text: x.text, side: x.side, bornT: fx(x.bornT), goneT: fx(x.goneT),
      aliveMs: fx(x.aliveMs), removed: x.removed === true, rect: x.rect ?? null,
      samples: x.sampleCount, measurable: x.measurableSamples, onTop: x.onTopSamples,
      hitClasses: x.hitClasses, paint_probe: x.paintProbe ?? null,
      sample_detail: (x.samples ?? []).slice(0, 8).map((s) =>
        ({t: fx(s.t), measurable: s.measurable, cx: s.cx, cy: s.cy, w: s.w, h: s.h, hitClass: s.hitClass,
          hitTag: s.hitTag, hitIsFloat: s.hitIsFloat}))})),
    final_float_count: facts.finalFloatCount,
    // 按「出手拍」配对的实测差值（出手 → .b3-hit / 出手 → 伤害浮字），与 J3 同一份逻辑。
    cycles: (() => {
      const c = battleCycles(timeline);
      return {
        leads: c.leads.map((l) => ({t: fx(l.t), side: l.side, cues: l.cues.map((x) => x.detail?.what ?? null)})),
        pairs: c.pairs.map((p) => ({t: fx(p.lead.t), attacker: p.lead.side, deltaMs: p.delta,
          deltaHitMs: p.deltaHit, deltaFloatMs: p.deltaFloat, floatText: p.floatText,
          hitWhat: p.hitWhat, reactions: p.reactions})),
        no_reaction_leads: c.noReactionLeads.map((l) => ({t: fx(l.t), side: l.side})),
        inversions: c.inversions.map((i) => ({reaction_t: fx(i.reaction.t), reaction_side: i.reaction.side,
          attacker_t: fx(i.attacker.t), attacker_side: i.attacker.side})),
      };
    })(),
    deltas_ms: (() => {
      const out = {};
      const c = battleCycles(timeline);
      out.attack_to_first_defender = c.pairs.length ? c.pairs[0].delta : null;
      out.defender_side = c.pairs.length ? OTHER[c.pairs[0].lead.side] : null;
      const gaps = [];
      for (let i = 1; i < timeline.length; i += 1) gaps.push(fx(Number(timeline[i].t) - Number(timeline[i - 1].t)));
      out.consecutive_ms = gaps.slice(0, 20);
      return out;
    })(),
  };
}

// 2026-09-25（**同一形状第三次**）：跑完、报告写完，进程却一直不退 ⇒ 门禁那 30 分钟兜底才把它杀掉，
// 而那一套被判红。根因不是 CDP（C6.118 里我那样归因是错的：报告已经写完，说明 await 都回来了），
// 而是**只设了 `process.exitCode`、从不显式退出** —— 只要还有一个句柄没散（Chrome 死了、服务关了，
// 但 socket/计时器还在），事件循环就永远不空。所以收尾统一成：**先让 stdout 冲干净，再显式退出**。
const flushThenExit = (code) => new Promise((resolve) => {
  process.exitCode = code;
  process.stdout.write('', () => resolve());
}).then(() => process.exit(process.exitCode ?? code));

main().then(
  () => flushThenExit(process.exitCode ?? 0),
  (error) => {
  console.error('[battle-feedback] 验收脚本自身出错：', error);
  ;
    return flushThenExit(1);
  },
);
