#!/usr/bin/env node
/**
 * 战斗页 **v3h 版式**验收：判据 + 截图（2026-09-23，供主线程接入后直接跑）。
 *
 * 目标版式
 * --------
 *   · 示意图：`docs/roco/mockups/battle-v3h.html`
 *   · 参考图：`docs/roco/mockups/v3h/battle-v3-default-1440x900.png`（1440×900）
 *   · 被量的页面：`http://127.0.0.1:8899/roco.html`（**只对着已经在跑的那个服务**，
 *     本脚本不启动任何服务 —— 这也是它不进 `verify:release` 的原因：门禁必须能自起自跑）
 *
 * 它要钉住的七条（每条都能反证：喂一个坏输入必须红）
 * --------------------------------------------------
 * 它要钉住的七条（每条都能反证：喂一个坏输入必须红）
 * --------------------------------------------------
 *   C1 三列几何      左右列等宽（±2px）且都 ≥200px；两卡轴心 == 页面中线（±2px）；无横向溢出
 *   C2 顶部信息栏    无边框/无底色；左右存活点组垂直中心相等且 == 该行中心（±2px）；中央回合文字与 view.turn 一致
 *   C3 左侧竖排四格  恰好 4 格；每格 ⭐消耗 + 属性(emoji+中文) + 克制标记；星不够的不可点，可点数 == 引擎合法技能数
 *   C4 更换态        左列一行一只**可换上的**精灵；每行 名字/属性/克制/血量；底边与技能态最后一格对齐（±4px）；不覆盖聚能区
 *   C5 背包态        出现「未核验/候选」边界说明；不得出现确定性数字
 *   C6 右列战报      与左列等宽；最新回合在最上；按回合分组
 *   C7 底部          聚能显示当前 ⭐（n == view.self.pets[active].energy）；四个按钮；恰好一个高亮
 *   C0 前置          页面必须启动 + 真的进了战斗 + 没有未捕获异常（不然下面每条的实际值都读不懂）
 *   CX 扩展          · 对手血条必须镜像（从右往左）—— 示意图 `.fighter.foe .hp .bar{direction:rtl}`；
 *                      题面点名的反证「把对手血条改成从左往右」需要它才抓得住
 *                    · v3h 根容器必须占满页面并居中 —— 容器被挤扁时「左右列等宽」会假绿，
 *                      而两卡的轴心一定对不上页面中线（三列几何的真正前置条件）
 *
 * 钩子缺失 / 量不到时的纪律
 * -------------------------
 * 主线程承诺的钩子：`data-b3-skill-slot` / `data-b3-cost` / `data-b3-cost-short` /
 * `data-b3-rel` / `data-b3-switch-row` / `data-b3-item-cell` / `data-b3-log-turn` /
 * `data-b3-turn` / `data-b3-dots-self` / `data-b3-dots-foe` / `body[data-b3-tab]`。
 * 钩子**一个都还没落地**时脚本也必须跑完并**逐条列出缺什么**，不许崩：
 *   · 量不到的元素一律记 `null`，判据把「量不到」当成 red，并把**缺哪个钩子**写进实际值；
 *   · 每个 check 自带 `missing`（它依赖的钩子/锚点），报告里直接给出施工清单；
 *   · **尺寸为 0 不算「量到了」**：面板 `hidden` 时 rect 全是 0，`±2px` 的判据会假绿 —— 一律记红；
 *   · 页面把状态镜像写在 `body` 上（`body[data-b3-tab]` / `body[data-b3-turn]` / `body[data-b3-charge]`），
 *     属性名与元素钩子**同名**，所以查钩子一律排掉 `html/body`（否则 `querySelector` 先命中 body，
 *     量到的是整页文本）。
 *
 * 实测到的落地契约（脚本按它写；主线程改口径时这里要跟着改）
 * ----------------------------------------------------------
 *   · `data-b3-turn` → 可见回合文字在 `#b3-round`；`body[data-b3-turn]` 是镜像
 *   · `data-b3-cost-short="yes|no"` 在格子上；可点性优先读 `data-b3-slot-legal="yes|no"`
 *   · `data-b3-charge` → `#b3-charge` 按钮；**显示值是活文本**，`data-b3-charge-value` 属性只是静态样例
 *   · `data-b3-{self,foe}-hp-fill`（不是 `data-b3-hp-fill`），槽是 `.b3-hp-bar`
 *   · 左列三屏是三个兄弟面板（`data-b3-panel="skill|switch|item|escape"`），靠 `body[data-b3-tab]` 三选一
 *   · 页面自己的「还没接上」标记：`data-b3-pending="yes"` —— 报告里单独记它的条数（最直接的施工清单）
 *
 * 两处口径说明（判据的解释权写在这里，免得读的人以为脚本量错了）
 * --------------------------------------------------------------
 *   · 「两卡轴心 == 页面中线」：两张并排的卡不可能各自居中，所以量的是**两张卡中心连线的中点**
 *     与 `documentElement` 中线之差。
 *   · 「更换态 5 行」：一行一只**可换上的**精灵 = 活着的队友**减去场上那一只**（示意图 6 宠队 → 5 行）。
 *
 * 为什么判据是**纯函数 + 合成基线**
 * --------------------------------
 * 「反证」不是写一句注释说「这样会红」，而是**真的喂坏输入**：判据写成 `(facts) => problems[]`
 * 的纯函数，先拿一份**已知全绿的合成基线**（`baselineFacts()`，它同时也是判据的输入契约）
 * 过一遍 —— 基线不全绿就说明判据本身写坏了（`selftest-baseline` 会红）；
 * 再对基线做**一处**变异，看目标判据是否变红。这样反证的结论与「页面当前是不是已经改好」无关。
 *
 * 反证用**合成基线**而不是页面现场：页面现在还是红的，拿它做反证的话「一改就红」是废话。
 *
 * 用法
 * ----
 *   node scripts/roco/browser-battle-v3-acceptance.mjs
 *   ROCO_BASE=http://127.0.0.1:8899 node scripts/roco/browser-battle-v3-acceptance.mjs
 *   node scripts/roco/browser-battle-v3-acceptance.mjs --url http://127.0.0.1:8899/roco.html
 *   node scripts/roco/browser-battle-v3-acceptance.mjs --no-shots
 *   node scripts/roco/browser-battle-v3-acceptance.mjs --selftest-only   # 不开浏览器，只验判据/反证
 *   node scripts/roco/browser-battle-v3-acceptance.mjs --width 390 --height 844
 * 产物
 * ----
 *   reports/roco/battle-v3/battle-v3-acceptance.json
 *   reports/roco/battle-v3/battle-v3-{skill,switch,item}-1440x900.png
 * stdout 末行固定格式：`判据 N/M 通过；反证 K/L 命中`
 */

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const BASE = String(process.env.ROCO_BASE ?? argOf('--base', 'http://127.0.0.1:8899')).replace(/\/$/, '');
const PAGE_URL = argOf('--url', `${BASE}/roco.html`);
const OUT = join(ROOT, argOf('--out', 'reports/roco/battle-v3'));
const SHOTS = !argv.includes('--no-shots');
const VIEWPORT = {w: Number(argOf('--width', 1440)), h: Number(argOf('--height', 900))};
const TAG = `${VIEWPORT.w}x${VIEWPORT.h}`;
const CHROME = [
  process.env.CHROME_BIN, process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean).find((p) => existsSync(p));
const WORKSHOP = '#team-workshop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[battle-v3]', ...a);
const fx = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(fx(n)) : '—');
/** 报告与 stdout 里的一行文本：把换行压平（页面报错的栈会把输出撕成好几行）。 */
const oneLine = (s, cap = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);

// ── 钩子契约 ────────────────────────────────────────────────────────────────
/** 主线程承诺要加的钩子（缺任何一个都要在报告里点名）。 */
const REQUIRED_HOOKS = [
  'data-b3-skill-slot', 'data-b3-cost', 'data-b3-cost-short', 'data-b3-rel',
  'data-b3-switch-row', 'data-b3-item-cell', 'data-b3-log-turn', 'data-b3-turn',
  'data-b3-dots-self', 'data-b3-dots-foe', 'body[data-b3-tab]',
];
/**
 * 可选锚点：**没有也能跑**（脚本按结构推导：左列 = 技能格的父容器，
 * 右列 = 战报格与左列的最近公共祖先的第 3 个子块，出战卡 = 中列的两个子块）。
 * 主线程如果顺手标了它们，几何判据就不必靠推导，误报会少很多 —— 报告里会列出「推导 vs 锚点」。
 */
const OPTIONAL_ANCHORS = [
  'data-b3-col-left', 'data-b3-col-right', 'data-b3-stage', 'data-b3-fighter',
  'data-b3-fighter-self', 'data-b3-fighter-foe', 'data-b3-topbar', 'data-b3-footer',
  'data-b3-charge', 'data-b3-tab-btn', 'data-b3-hp-bar', 'data-b3-hp-fill',
];

// ── 采集：整段在页面里跑（函数被 toString 后注入，不许引用外部作用域）────────
function collectInPage(state) {
  const REQUIRED = ['data-b3-skill-slot', 'data-b3-cost', 'data-b3-cost-short', 'data-b3-rel',
    'data-b3-switch-row', 'data-b3-item-cell', 'data-b3-log-turn', 'data-b3-turn',
    'data-b3-dots-self', 'data-b3-dots-foe'];
  const OPTIONAL = ['data-b3-col-left', 'data-b3-col-right', 'data-b3-stage', 'data-b3-fighter',
    'data-b3-fighter-self', 'data-b3-fighter-foe', 'data-b3-topbar', 'data-b3-footer',
    'data-b3-charge', 'data-b3-tab-btn'];
  const errors = [];
  const qa = (sel, root) => {
    try { return Array.from((root || document).querySelectorAll(sel)); } catch (e) { errors.push(`选择器坏：${sel}`); return []; }
  };
  const q = (sel, root) => qa(sel, root)[0] || null;
  /**
   * 页面把**状态镜像**写到了 `body` 上，属性名与元素钩子同名：
   *   `body[data-b3-tab]`、`body[data-b3-turn]`、`body[data-b3-charge]`。
   * 于是 `document.querySelector('[data-b3-turn]')` 会先命中 `body`（文档序在前），
   * 量到的是**整页文本**。所以查钩子一律排掉 html/body；body 上的镜像单独记。
   */
  const isRoot = (el) => el === document.body || el === document.documentElement;
  const qah = (sel, root) => qa(sel, root).filter((e) => !isRoot(e));
  const qh = (sel, root) => qah(sel, root)[0] || null;
  const R = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {left: +r.left.toFixed(2), top: +r.top.toFixed(2), right: +r.right.toFixed(2), bottom: +r.bottom.toFixed(2),
      w: +r.width.toFixed(2), h: +r.height.toFixed(2), cx: +(r.left + r.width / 2).toFixed(2), cy: +(r.top + r.height / 2).toFixed(2)};
  };
  const T = (el) => (el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const S = (el) => (el ? getComputedStyle(el) : null);
  const alpha0 = (color) => {
    const m = String(color || '').match(/^rgba?\(([^)]+)\)$/);
    if (!m) return color === 'transparent' || color === 'rgba(0, 0, 0, 0)';
    const parts = m[1].split(',').map((x) => x.trim());
    return parts.length < 4 ? true : Number(parts[3]) === 0;
  };
  const contains = (outer, inner) => Boolean(outer && inner && (outer === inner || outer.contains(inner)));
  const lca = (a, b) => {
    if (!a || !b) return null;
    const seen = new Set();
    for (let n = a; n; n = n.parentElement) seen.add(n);
    for (let n = b; n; n = n.parentElement) if (seen.has(n)) return n;
    return null;
  };
  /**
   * 子块（**不按 rect 过滤**）：面板 `hidden` 时子元素 rect 全是 0，但 DOM 还在 ——
   * 按 rect 过滤会把「DOM 里有 3 列 / 2 张卡，只是没渲染」误报成「一个都没有」。
   * 0 尺寸由判据里的 `EMPTY()` 单独报，那样信息更准。
   */
  const visibleKids = (el) => (el ? Array.from(el.children).filter((k) => {
    const st = getComputedStyle(k);
    return st.position !== 'absolute' && st.position !== 'fixed'
      && st.display !== 'none' && st.visibility !== 'hidden';
  }) : []);
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  const ELEMENT = /(光|冰|地|幻|幽|恶|普通|机械|武|毒|水|火|电|翼|草|萌|虫|龙)系/;
  const STAR = /[★☆⭐🌟]/;
  /** 可点性：**优先读显式钩子**，再退回 DOM 语义（disabled / aria-disabled / pointer-events / 透明度）。
   *  `data-b3-slot-legal` 是 v3h 片段里实际用的那个名字，一并认。 */
  const clickability = (el) => {
    for (const attr of ['data-b3-legal', 'data-b3-slot-legal']) {
      const own = el.getAttribute(attr);
      if (own === 'yes' || own === 'no') return {clickable: own === 'yes', signal: attr};
    }
    const btn = el.matches('button,[role="button"]') ? el : el.querySelector('button,[role="button"]');
    if (btn) {
      if (btn.disabled === true || btn.hasAttribute('disabled')) return {clickable: false, signal: 'disabled'};
      if (btn.getAttribute('aria-disabled') === 'true') return {clickable: false, signal: 'aria-disabled'};
      return {clickable: true, signal: 'enabled-button'};
    }
    if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) return {clickable: false, signal: 'aria-disabled'};
    const st = S(el) || {};
    if (st.pointerEvents === 'none') return {clickable: false, signal: 'pointer-events:none'};
    const op = parseFloat(st.opacity);
    if (Number.isFinite(op) && op < 0.8) return {clickable: false, signal: 'opacity<0.8'};
    return {clickable: true, signal: 'default'};
  };

  const out = {state, errors, requiredHooks: {}, optionalAnchors: {}, derivedFrom: {}, bodyTab: null,
    doc: null, engine: null, columns: {}, stage: {}, topbar: {}, dotsSelf: {}, dotsFoe: {}, turnText: {},
    skills: {}, switchRows: {}, item: {}, log: {}, footer: {}, hp: {}, tab: {}};

  try {
    out.bodyTab = document.body.dataset.b3Tab ?? null;
    out.tab[state] = out.bodyTab;
    for (const h of REQUIRED) out.requiredHooks[h] = qa(`[${h}]`).length;
    out.requiredHooks['data-b3-cost-short'] = qah('[data-b3-cost-short]').length;
    for (const a of OPTIONAL) out.optionalAnchors[a] = qa(`[${a}]`).length;

    const de = document.documentElement;
    out.doc = {scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, innerWidth: window.innerWidth,
      bodyScrollWidth: document.body.scrollWidth, bodyClientWidth: document.body.clientWidth,
      centerX: +(de.clientWidth / 2).toFixed(2), title: document.title, url: location.href};

    // ── 引擎事实（判据的对照面：页面不许自己算）────────────────────────────
    const view = window.rocoDemo?.state?.view ?? null;
    const pets = Array.isArray(view?.self?.pets) ? view.self.pets : [];
    const activeIdx = Number.isInteger(view?.self?.active) ? view.self.active : 0;
    const activePet = pets[activeIdx] ?? pets[0] ?? null;
    out.engine = {
      hasView: Boolean(view),
      turn: Number.isInteger(view?.turn) ? view.turn : null,
      activeIndex: activeIdx,
      activeName: activePet?.name ?? null,
      energy: Number.isFinite(activePet?.energy) ? activePet.energy : null,
      energyMax: Number.isFinite(view?.self?.energy_max) ? view.self.energy_max : null,
      aliveTeammates: pets.filter((p) => p?.fainted !== true).length,
      // 能换上的对象 = 活着的**别的**精灵（不含场上这只）。示意图里 6 宠队 → 5 行。
      aliveOthers: pets.filter((p, i) => p?.fainted !== true && i !== activeIdx).length,
      petCount: pets.length,
      legalSkills: (Array.isArray(view?.legal) ? view.legal : []).filter((a) => a?.kind === 'skill').length,
      legalKinds: [...new Set((Array.isArray(view?.legal) ? view.legal : []).map((a) => String(a?.kind)))].join(','),
      phase: view?.phase ?? null,
    };

    // ── 列：左列 = 技能格的父容器；主行 = 左列与战报格的最近公共祖先 ─────────
    const slotEls = qah('[data-b3-skill-slot],[data-b3-switch-row],[data-b3-item-cell]');
    const parents = Array.from(new Set(slotEls.map((e) => e.parentElement).filter(Boolean)));
    // 技能格/更换行/物品格可能**分住在几个兄弟面板**里（v3h 片段就是 skill/switch/item/escape 四块）——
    // 那就取这几个父容器的最近公共祖先，它才是「左列」。
    let leftCol = parents.length ? parents.reduce((acc, el) => (acc ? lca(acc, el) : el), null) : null;
    const logTurnEls = qah('[data-b3-log-turn]');
    const logTurnEl = logTurnEls[0] || null;
    const colLeftHook = qh('[data-b3-col-left]');
    const colRightHook = qh('[data-b3-col-right]');
    const mainRow = lca(colLeftHook || leftCol, logTurnEl)
      || lca(colLeftHook || leftCol, colRightHook) || null;
    const mainKids = visibleKids(mainRow);
    const colLeft = colLeftHook || (mainRow ? mainKids.find((k) => contains(k, leftCol) || k === leftCol) : null) || leftCol;
    const colRight = colRightHook || (mainRow ? mainKids.find((k) => contains(k, logTurnEl)) : null);
    const colMid = mainRow ? mainKids.find((k) => k !== colLeft && k !== colRight) : null;
    out.derivedFrom.columns = colLeftHook || colRightHook ? 'hook' : (mainRow ? 'structural' : 'none');
    out.columns = {
      resolved: Boolean(colLeft && colRight),
      mainTag: mainRow ? (mainRow.tagName + (mainRow.id ? `#${mainRow.id}` : '') + (mainRow.className && typeof mainRow.className === 'string' ? `.${mainRow.className.trim().split(/\s+/).join('.')}` : '')) : null,
      kidCount: mainKids.length,
      kidTags: mainKids.map((k) => k.tagName + (k.id ? `#${k.id}` : '')).join('>'),
      left: R(colLeft), right: R(colRight), mid: R(colMid),
      leftIsSkillParent: Boolean(leftCol && colLeft && (colLeft === leftCol || colLeft.contains(leftCol))),
      rightHasLog: Boolean(colRight && logTurnEl && colRight.contains(logTurnEl)),
      logOutsideRight: Boolean(logTurnEl && colRight && !colRight.contains(logTurnEl)),
    };

    // ── v3h 片段的根容器：它必须占满页面并居中，否则两侧的列不可能对得上页面中线 ──
    const rootEl = q('[data-b3-root]') || (topbarEl ? topbarEl.parentElement : null)
      || (mainRow ? mainRow.parentElement : null);
    out.root = {present: Boolean(rootEl), rect: R(rootEl), source: q('[data-b3-root]') ? 'hook' : 'structural',
      tag: rootEl ? rootEl.tagName + (rootEl.className && typeof rootEl.className === 'string' ? `.${rootEl.className.trim().split(/\s+/)[0]}` : '') : null,
      parentTag: rootEl?.parentElement ? rootEl.parentElement.tagName + (rootEl.parentElement.id ? `#${rootEl.parentElement.id}` : '') : null};

    // ── 中列出战卡 ────────────────────────────────────────────────────────
    const stageHook = qh('[data-b3-stage]');
    const stage = stageHook || colMid;
    const fSelfHook = qh('[data-b3-fighter-self]') || qh('[data-b3-self-card]');
    const fFoeHook = qh('[data-b3-fighter-foe]') || qh('[data-b3-foe-card]');
    let fighters = qah('[data-b3-fighter]');
    if (fSelfHook && fFoeHook) fighters = [fSelfHook, fFoeHook];
    else if (!fighters.length && stage) fighters = visibleKids(stage);
    out.derivedFrom.stage = stageHook ? 'hook' : (stage ? 'structural' : 'none');
    out.stage = {resolved: fighters.length === 2, source: stageHook || fSelfHook ? 'hook' : 'structural',
      stageRect: R(stage), fighters: fighters.map((f) => ({rect: R(f), tag: f.tagName + (f.id ? `#${f.id}` : '')}))};
    const foeCard = fighters[1] || null;

    // ── 顶部信息栏 ────────────────────────────────────────────────────────
    const dotsSelfEl = qh('[data-b3-dots-self]');
    const dotsFoeEl = qh('[data-b3-dots-foe]');
    /**
     * ⚠ `[data-b3-turn]` 会同时命中**两个**东西：页面把状态镜像写到 `body[data-b3-turn]`
     * （和 `body[data-b3-tab]` 同一套做法），可见的回合文字在更深处。`querySelector` 按文档序
     * 先返回 `body` —— 那样量到的是整页文本。所以这里显式排掉 html/body，并优先挑
     * **正文里真的写着「第 n 回合」**的那个。
     */
    const turnCands = qah('[data-b3-turn]');
    const turnEl = turnCands.find((el) => /第\s*\d+\s*回合/.test(T(el)))
      ?? turnCands.sort((a, b) => T(a).length - T(b).length)[0]
      ?? null;
    const turnMirror = document.body.getAttribute('data-b3-turn');
    const topbarHook = qh('[data-b3-topbar]');
    const topbarEl = topbarHook || lca(dotsSelfEl, dotsFoeEl) || lca(dotsSelfEl, turnEl) || lca(dotsFoeEl, turnEl);
    const ts = S(topbarEl);
    out.derivedFrom.topbar = topbarHook ? 'hook' : (topbarEl ? 'structural' : 'none');
    out.topbar = topbarEl ? {
      resolved: true, source: topbarHook ? 'hook' : 'structural', rect: R(topbarEl),
      tag: topbarEl.tagName + (topbarEl.id ? `#${topbarEl.id}` : ''),
      borderTopWidth: ts.borderTopWidth, borderRightWidth: ts.borderRightWidth,
      borderBottomWidth: ts.borderBottomWidth, borderLeftWidth: ts.borderLeftWidth,
      borderTopStyle: ts.borderTopStyle, bg: ts.backgroundColor, bgTransparent: alpha0(ts.backgroundColor),
      bgImage: ts.backgroundImage, boxShadow: ts.boxShadow,
    } : {resolved: false};
    out.dotsSelf = {present: Boolean(dotsSelfEl), rect: R(dotsSelfEl), text: T(dotsSelfEl)};
    out.dotsFoe = {present: Boolean(dotsFoeEl), rect: R(dotsFoeEl), text: T(dotsFoeEl)};
    out.turnText = {present: Boolean(turnEl), text: T(turnEl), rect: R(turnEl),
      candidates: qah('[data-b3-turn]').map((el) => `${el.tagName}${el.id ? `#${el.id}` : ''}="${T(el).slice(0, 16)}"`),
      bodyMirror: turnMirror};

    // ── 左侧技能格 ────────────────────────────────────────────────────────
    const cells = qah('[data-b3-skill-slot]').map((el, i) => {
      const costEl = q('[data-b3-cost]', el);
      const relEl = q('[data-b3-rel]', el);
      const shortEl = q('[data-b3-cost-short]', el);
      const text = T(el);
      const relValue = relEl?.getAttribute('data-b3-rel') ?? el.getAttribute('data-b3-rel') ?? null;
      const relHtml = relEl ? String(relEl.innerHTML || '') : '';
      const relGlyph = /<svg|<path|<circle/i.test(relHtml) || /[▲▼△▽○●]/.test(T(relEl)) || /克制|无影响/.test(T(relEl));
      const click = clickability(el);
      return {
        index: i, rect: R(el), text: text.slice(0, 90),
        costHook: Boolean(costEl), costText: T(costEl || el).slice(0, 24),
        costShortAttr: shortEl?.getAttribute('data-b3-cost-short') ?? el.getAttribute('data-b3-cost-short') ?? null,
        costShortHook: Boolean(shortEl) || el.hasAttribute('data-b3-cost-short'),
        relPresent: Boolean(relEl) || el.hasAttribute('data-b3-rel'), relValue, relGlyph,
        elementName: (text.match(ELEMENT) || [])[0] ?? null,
        hasEmoji: EMOJI.test(text),
        starChars: (text.match(new RegExp(STAR.source, 'gu')) || []).join(''),
        clickable: click.clickable, clickSignal: click.signal,
      };
    });
    out.skills = {count: cells.length, cells,
      clickableCount: cells.filter((c) => c.clickable).length,
      shortCount: cells.filter((c) => c.costShortAttr === 'yes').length,
      lastBottom: cells.length ? Math.max(...cells.map((c) => c.rect?.bottom ?? -1)) : null};

    // ── 更换态行 ──────────────────────────────────────────────────────────
    const rows = qah('[data-b3-switch-row]').map((el, i) => {
      const text = T(el);
      const relEl = q('[data-b3-rel]', el);
      return {
        index: i, rect: R(el), text: text.slice(0, 90),
        elementName: (text.match(ELEMENT) || [])[0] ?? null,
        hasEmoji: EMOJI.test(text),
        relPresent: Boolean(relEl) || el.hasAttribute('data-b3-rel'),
        relValue: relEl?.getAttribute('data-b3-rel') ?? el.getAttribute('data-b3-rel') ?? null,
        relGlyph: /<svg|<path|<circle/i.test(relEl ? String(relEl.innerHTML || '') : '') || /[▲▼△▽○●]/.test(T(relEl)),
        hpText: (text.match(/\d+\s*\/\s*\d+/) || [])[0] ?? null,
        name: text.split(' ').filter((x) => x && !ELEMENT.test(x) && !/^\d/.test(x) && !STAR.test(x) && !/[▲▼△▽○●]/.test(x))[0] ?? null,
      };
    });
    out.switchRows = {count: rows.length, rows,
      lastBottom: rows.length ? Math.max(...rows.map((r) => r.rect?.bottom ?? -1)) : null,
      skillTabLastBottom: null};

    // ── 背包态 ────────────────────────────────────────────────────────────
    const itemCells = qah('[data-b3-item-cell]').map((el, i) => ({index: i, rect: R(el), text: T(el).slice(0, 220)}));
    // 文案只取**背包那一块**：`T(左列)` 会把 4 个面板（含隐藏的）全算进来，
    // 那样「确定性数字」这条判据会读到技能面板的字，是假阳性。
    const itemPanel = qh('[data-b3-panel="item"]');
    const leftColText = T(itemPanel) || (itemCells.length ? itemCells.map((c) => c.text).join(' ') : T(colLeft || leftCol));
    out.item = {count: itemCells.length, cells: itemCells, text: leftColText.slice(0, 900),
      panelFound: Boolean(itemPanel)};

    // ── 右列战报 ──────────────────────────────────────────────────────────
    const turnSource = logTurnEls.some((el) => /^\d+$/.test(String(el.getAttribute('data-b3-log-turn') ?? '').trim()))
      ? 'attr' : (logTurnEls.length ? 'text' : 'none');
    const turns = logTurnEls.map((el) => {
      const attr = String(el.getAttribute('data-b3-log-turn') ?? '').trim();
      if (/^\d+$/.test(attr)) return Number(attr);
      const m = T(el).match(/第\s*(\d+)\s*回合/);
      return m ? Number(m[1]) : null;
    });
    const logScroll = logTurnEl ? logTurnEl.parentElement : null;
    const logColWidth = colRight ? colRight.getBoundingClientRect().width : null;
    out.log = {count: logTurnEls.length, turns, turnSource,
      firstTurn: turns.length ? turns[0] : null, maxTurn: turns.length ? Math.max(...turns.filter((n) => n !== null)) : null,
      colWidth: logColWidth, colRect: R(colRight),
      texts: logTurnEls.slice(0, 4).map((el) => T(el).slice(0, 70)),
      scrollTag: logScroll ? logScroll.tagName : null};

    // ── 底部：聚能 + 四个按钮 ─────────────────────────────────────────────
    const footerHook = qh('[data-b3-footer]');
    const root = footerHook || q('footer') || document.body;
    const chargeHook = qh('[data-b3-charge]');
    let chargeEl = chargeHook;
    let chargeSource = chargeHook ? 'hook' : 'none';
    if (!chargeEl) {
      const cands = qa('button,span,b,em,div,p', root).filter((el) => /[★☆⭐🌟]\s*\d+\s*\/\s*\d+/.test(T(el)));
      chargeEl = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)))[0] || null;
      chargeSource = chargeEl ? 'text-scan' : 'none';
      if (chargeEl && !chargeHook) chargeEl = chargeEl.closest('button') || chargeEl;
    }
    // 值优先读片段自己的 `data-b3-charge-value`（`"⭐ 2 / 10"`）：它挂在**值**那个 span 上，
    // 比整个按钮的 textContent 干净（按钮里还有「聚能」标签与未核验说明）。
    const chargeValueHook = qh('[data-b3-charge-value]');
    // ⚠ 显示值是**活的 textContent**（JS 会把它改成当前 ⭐）；`data-b3-charge-value` 属性
    // 是片段里的静态样例（"⭐ 2 / 10"），只在文本取不到时才当兜底 —— 先读属性会把静态值当真值。
    const chargeText = (chargeValueHook ? (T(chargeValueHook) || chargeValueHook.getAttribute('data-b3-charge-value') || '') : '')
      || T(chargeEl);
    const cm = chargeText.match(/[★☆⭐🌟]\s*(\d+)\s*\/\s*(\d+)/);
    const TAB_LABELS = ['技能', '更换', '物品', '逃跑'];
    const TAB_OF = {skill: '技能', switch: '更换', item: '物品', escape: '逃跑'};
    // ⚠ v3h 片段把**同一个** `data-b3-tab` 既写在 `body` 上（状态镜像）又写在四个按钮上（控件）。
    // 直接 `querySelectorAll('[data-b3-tab]')` 会把 body 也算成一个「按钮」。排掉 html/body。
    let tabEls = qah('[data-b3-tab-btn]');
    if (!tabEls.length) tabEls = qah('[data-b3-tab]');
    if (!tabEls.length) {
      const buttons = qa('button,[role="tab"],[role="button"]', footerHook || document.body);
      tabEls = buttons.filter((b) => TAB_LABELS.includes(T(b)));
      if (!tabEls.length) tabEls = buttons.filter((b) => TAB_LABELS.some((l) => T(b).startsWith(l) && T(b).length <= 8));
    }
    const tabs = tabEls.map((b) => {
      const st = S(b);
      const value = b.getAttribute('data-b3-tab');
      const text = T(b).slice(0, 8);
      return {label: TAB_LABELS.includes(text) ? text : (TAB_OF[value] ?? text), value,
        on: b.getAttribute('data-b3-tab-on') === 'yes',
        bg: st.backgroundColor, borderColor: st.borderTopColor, color: st.color,
        fontWeight: st.fontWeight, rect: R(b), tag: b.tagName, hidden: b.hidden};
    });
    out.footer = {
      resolved: Boolean(chargeEl), rect: R(footerHook || q('footer')),
      charge: {present: Boolean(chargeEl), source: chargeSource, text: chargeText.slice(0, 40),
        energy: cm ? Number(cm[1]) : null, cap: cm ? Number(cm[2]) : null, rect: R(chargeEl)},
      chargeRect: R(chargeEl), tabs: {count: tabs.length, buttons: tabs, bodyTab: out.bodyTab, labels: tabs.map((t) => t.label)},
    };

    // ── 血条：左右镜像（对手侧从右往左）────────────────────────────────────
    const findBar = (card, side) => {
      if (!card) return null;
      // 片段把钩子挂在**填充条**上（`data-b3-self-hp-fill` / `data-b3-foe-hp-fill`），
      // 槽是它外面的 `.b3-hp-bar`。先认这两条，认不到再退回「宽扁条 + 满高子块」扫描。
      const hookFill = q(`[data-b3-${side}-hp-fill]`, card) || q('[data-b3-hp-fill]', card);
      if (hookFill) {
        return {bar: hookFill.closest('.b3-hp-bar') || hookFill.parentElement || hookFill, fill: hookFill,
          source: `hook:data-b3-${side}-hp-fill`};
      }
      const hookBar = q('[data-b3-hp-bar]', card);
      if (hookBar) return {bar: hookBar, fill: hookBar.firstElementChild || hookBar, source: 'hook:data-b3-hp-bar'};
      const cardW = card.getBoundingClientRect().width;
      const cands = [];
      for (const p of qa('*', card)) {
        const pr = p.getBoundingClientRect();
        if (pr.height < 4 || pr.height > 22 || pr.width < Math.max(80, cardW * 0.4)) continue;
        for (const c of Array.from(p.children)) {
          const cr = c.getBoundingClientRect();
          if (cr.height < pr.height - 3) continue;
          if (cr.width < 4 || cr.width > pr.width + 1) continue;
          cands.push({bar: p, fill: c, area: pr.width * cr.width});
        }
      }
      if (!cands.length) return null;
      cands.sort((a, b) => b.area - a.area);
      return {bar: cands[0].bar, fill: cands[0].fill, source: 'scan'};
    };
    const barFacts = (card, side) => {
      const found = findBar(card, side);
      if (!found) return {found: false};
      const b = found.bar.getBoundingClientRect();
      const f = found.fill.getBoundingClientRect();
      const dir = (S(found.bar) || {}).direction;
      const fillRight = b.right - f.right;
      const fillLeft = f.left - b.left;
      const ratio = b.width > 0 ? +(f.width / b.width).toFixed(3) : null;
      return {found: true, source: found.source, bar: R(found.bar), fill: R(found.fill), direction: dir,
        fillLeft: +fillLeft.toFixed(2), fillRight: +fillRight.toFixed(2), ratio,
        align: ratio !== null && ratio >= 0.995 ? 'full' : (fillLeft <= 2 ? 'left' : (fillRight <= 2 ? 'right' : 'partial'))};
    };
    out.hp = {self: barFacts(fighters[0], 'self'), foe: barFacts(foeCard, 'foe')};
    // 页面自己的「还没接上」标记（v3h 片段用 `data-b3-pending="yes"` 标示例数据）。
    // 它不是判据，但它是**最直接的施工清单**：还剩几处是静态示例。
    const pendingEls = qah('[data-b3-pending]');
    out.pending = {count: pendingEls.length,
      kinds: [...new Set(pendingEls.map((e) => String(e.className || e.tagName).split(/\s+/).slice(0, 2).join('.')))]};
    out.errors = errors;
  } catch (error) {
    out.errors = [...(out.errors || []), `采集异常：${String(error && error.stack || error).slice(0, 300)}`];
  }
  return out;
}

// ── 判据（纯函数：输入是 facts，输出是 problems[]）──────────────────────────
const CONTAIN = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
/** 尺寸为 0 的矩形**不算「量到了」**：页面没渲染/被隐藏时 rect 全是 0，±2px 的判据会假绿。 */
const EMPTY = (r) => !r || !(r.w > 0) || !(r.h > 0);

const CHECKS = [
  // ── C0 前置：页面得先跑起来，否则下面每条的实际值都读不懂 ─────────────────
  {id: 'page-boots', criterion: 'C0 前置', state: 'skill',
    rule: '页面必须启动（body[data-rocoReady]="yes"）并且真的进了战斗（view 在、战斗区可见）',
    problems: (f) => {
      const bad = [];
      const b = f.boot ?? {};
      if (b.ready !== 'yes') bad.push(`body.dataset.rocoReady=${JSON.stringify(b.ready ?? null)}（没启动）`);
      if (b.hasView !== true) bad.push('window.rocoDemo.state.view 是空的（没进战斗）');
      if (b.battlePanelVisible !== true) bad.push('#battle-panel 不可见');
      if (b.entryOk !== true) bad.push('进入战斗的流程没走通（看报告 entry.steps）');
      return bad;
    },
    actual: (f) => `ready=${JSON.stringify(f.boot?.ready ?? null)}；战斗区可见=${f.boot?.battlePanelVisible ?? '—'}；view=${f.boot?.hasView ?? '—'}；entry=${f.boot?.entryOk ?? '—'}`},

  {id: 'console-clean', criterion: 'C0 前置', state: 'skill',
    rule: '整段流程没有 console.error / 未捕获异常（页面报错时下面的判据都不可信）',
    problems: (f) => ((f.boot?.consoleErrors ?? 0) > 0
      ? [`${f.boot.consoleErrors} 条报错，第一条：${String(f.boot.firstError ?? '').slice(0, 240)}`] : []),
    actual: (f) => `${f.boot?.consoleErrors ?? 0} 条报错${f.boot?.firstError ? `；第一条 ${String(f.boot.firstError).slice(0, 200)}` : ''}`},

  {id: 'hooks-required', criterion: 'C0 钩子契约', state: 'skill', missing: REQUIRED_HOOKS,
    rule: '主线程承诺的 data-b3-* 钩子必须都出现（缺的逐条点名；跨技能/更换/背包三态取并集）',
    problems: (f) => {
      const absent = REQUIRED_HOOKS.filter((h) => !(f.hooks?.present ?? []).includes(h));
      return absent.length ? [`缺 ${absent.length} 个钩子：${absent.join('、')}`] : [];
    },
    actual: (f) => `缺：${(f.hooks?.absent ?? []).join('、') || '（一个都不缺）'}；逐态计数 ${JSON.stringify(f.hooks?.counts ?? {})}`},

  // ── C1 三列几何 ─────────────────────────────────────────────────────────
  {id: 'geom-columns-equal', criterion: 'C1 三列几何', state: 'skill',
    missing: ['左列（技能格的列容器，或 data-b3-col-left）', '右列（战报格的列容器，或 data-b3-col-right）'],
    rule: '左列/右列宽度相等（±2px）且都 ≥200px',
    problems: (f) => {
      const bad = [];
      const L = f.columns?.left; const R = f.columns?.right;
      if (!L) bad.push('量不到左列（缺 data-b3-skill-slot / data-b3-col-left，或找不到它的列容器）');
      else if (EMPTY(L)) bad.push('左列尺寸是 0（元素在但没渲染出来：父级隐藏 / 页面没进战斗）');
      if (!R) bad.push('量不到右列（缺 data-b3-log-turn / data-b3-col-right，或找不到战报列容器）');
      else if (EMPTY(R)) bad.push('右列尺寸是 0（元素在但没渲染出来）');
      if (L && R && !EMPTY(L) && !EMPTY(R)) {
        if (Math.abs(L.w - R.w) > 2) bad.push(`左右列不等宽：左 ${fx(L.w)}px / 右 ${fx(R.w)}px，差 ${fx(Math.abs(L.w - R.w))}px > 2px`);
        if (L.w < 200) bad.push(`左列宽 ${fx(L.w)}px < 200px`);
        if (R.w < 200) bad.push(`右列宽 ${fx(R.w)}px < 200px`);
      }
      return bad;
    },
    actual: (f) => `左列 ${fmt(f.columns?.left?.w)}px / 右列 ${fmt(f.columns?.right?.w)}px；`
      + `主行 ${f.columns?.mainTag ?? '—'} 有 ${f.columns?.kidCount ?? '—'} 个子块（${f.columns?.kidTags ?? '—'}）；推导=${f.derivedFrom?.columns}`},

  {id: 'geom-stage-axis', criterion: 'C1 三列几何', state: 'skill',
    missing: ['中列两张出战卡（或 data-b3-fighter / data-b3-stage）'],
    rule: '两张出战卡的轴心（两卡中心的连线中点）== 页面中线（±2px）',
    problems: (f) => {
      const fs = f.stage?.fighters ?? [];
      if (fs.length !== 2) return [`中列量到 ${fs.length} 张出战卡（要 2 张）`];
      if (fs.some((x) => EMPTY(x.rect))) return [`出战卡尺寸是 0（${fs.map((x) => `${fmt(x.rect?.w)}×${fmt(x.rect?.h)}`).join(' / ')}）：页面没渲染出来`];
      const mid = (fs[0].rect.cx + fs[1].rect.cx) / 2;
      const center = f.doc?.centerX;
      if (!Number.isFinite(center)) return ['量不到页面中线'];
      if (Math.abs(mid - center) > 2) return [`两卡轴心 ${fx(mid)} ≠ 页面中线 ${fx(center)}（差 ${fx(Math.abs(mid - center))}px > 2px）`];
      return [];
    },
    actual: (f) => {
      const fs = f.stage?.fighters ?? [];
      return fs.length === 2
        ? `卡①②中心 x=${fmt(fs[0].rect.cx)} / ${fmt(fs[1].rect.cx)}；轴心=${fmt((fs[0].rect.cx + fs[1].rect.cx) / 2)}；页面中线=${fmt(f.doc?.centerX)}；推导=${f.derivedFrom?.stage}`
        : `出战卡 ${fs.length} 张`;
    }},

  {id: 'geom-no-hscroll', criterion: 'C1 三列几何', state: 'skill',
    rule: '无横向溢出（documentElement.scrollWidth == clientWidth）',
    problems: (f) => (f.doc && f.doc.scrollWidth !== f.doc.clientWidth
      ? [`横向溢出：scrollWidth ${f.doc.scrollWidth} > clientWidth ${f.doc.clientWidth}（多 ${f.doc.scrollWidth - f.doc.clientWidth}px）`] : []),
    actual: (f) => `documentElement ${f.doc?.scrollWidth}/${f.doc?.clientWidth}；body ${f.doc?.bodyScrollWidth}/${f.doc?.bodyClientWidth}；innerWidth ${f.doc?.innerWidth}`},

  // ── C2 顶部信息栏 ───────────────────────────────────────────────────────
  {id: 'topbar-plain', criterion: 'C2 顶部信息栏', state: 'skill',
    missing: ['data-b3-dots-self / data-b3-dots-foe（或 data-b3-topbar）'],
    rule: '顶部信息栏无边框（四边 border-width 全 0）且无底色（backgroundColor 透明、无 background-image）',
    problems: (f) => {
      const t = f.topbar;
      if (!t?.resolved) return ['量不到顶部信息栏（缺 data-b3-dots-self/dots-foe，或它们不在同一行）'];
      const bad = [];
      if (EMPTY(t.rect)) bad.push(`顶部信息栏尺寸是 0（${fmt(t.rect?.w)}×${fmt(t.rect?.h)}）：它没渲染出来（父级隐藏 / 页面没进战斗）`);
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (parseFloat(t[`border${side}Width`]) !== 0) bad.push(`有 ${side} 边框 border${side}Width=${t[`border${side}Width`]}`);
      }
      if (!t.bgTransparent) bad.push(`有底色 backgroundColor=${t.bg}`);
      if (t.bgImage && t.bgImage !== 'none') bad.push(`有背景图 backgroundImage=${t.bgImage}`);
      return bad;
    },
    actual: (f) => `四边 ${f.topbar?.borderTopWidth}/${f.topbar?.borderRightWidth}/${f.topbar?.borderBottomWidth}/${f.topbar?.borderLeftWidth}；`
      + `底色 ${f.topbar?.bg ?? '—'}（透明=${f.topbar?.bgTransparent}）；背景图 ${f.topbar?.bgImage ?? '—'}；来源=${f.derivedFrom?.topbar}`},

  {id: 'topbar-dots-center', criterion: 'C2 顶部信息栏', state: 'skill',
    missing: ['data-b3-dots-self', 'data-b3-dots-foe'],
    rule: '左右存活点组垂直中心相等，且都 == 该行中心（±2px）',
    problems: (f) => {
      const bad = [];
      const a = f.dotsSelf?.rect; const b = f.dotsFoe?.rect; const row = f.topbar?.rect;
      if (!f.dotsSelf?.present) bad.push('缺 data-b3-dots-self（左侧存活点组）');
      if (!f.dotsFoe?.present) bad.push('缺 data-b3-dots-foe（右侧存活点组）');
      if (EMPTY(a)) bad.push(`左点组尺寸是 0（${fmt(a?.w)}×${fmt(a?.h)}）：没渲染出来`);
      if (EMPTY(b)) bad.push(`右点组尺寸是 0（${fmt(b?.w)}×${fmt(b?.h)}）：没渲染出来`);
      if (EMPTY(row)) bad.push('信息栏行尺寸是 0：没渲染出来');
      if (!EMPTY(a) && !EMPTY(b) && Math.abs(a.cy - b.cy) > 2) bad.push(`左右点组垂直中心不等：${fx(a.cy)} vs ${fx(b.cy)}（差 ${fx(Math.abs(a.cy - b.cy))}px > 2px）`);
      if (!EMPTY(row) && !EMPTY(a) && Math.abs(a.cy - row.cy) > 2) bad.push(`左点组中心 ${fx(a.cy)} ≠ 行中心 ${fx(row.cy)}（差 ${fx(Math.abs(a.cy - row.cy))}px）`);
      if (!EMPTY(row) && !EMPTY(b) && Math.abs(b.cy - row.cy) > 2) bad.push(`右点组中心 ${fx(b.cy)} ≠ 行中心 ${fx(row.cy)}（差 ${fx(Math.abs(b.cy - row.cy))}px）`);
      return bad;
    },
    actual: (f) => `左点组心 y=${fmt(f.dotsSelf?.rect?.cy)}（"${f.dotsSelf?.text ?? ''}"）= 右点组心 y=${fmt(f.dotsFoe?.rect?.cy)}（"${f.dotsFoe?.text ?? ''}"）；行中心 y=${fmt(f.topbar?.rect?.cy)}`},

  {id: 'topbar-turn-text', criterion: 'C2 顶部信息栏', state: 'skill', missing: ['data-b3-turn'],
    rule: '中央有回合文字「第 <n> 回合」，且 n == view.turn',
    problems: (f) => {
      if (!f.turnText?.present) return ['缺 data-b3-turn（中央回合文字）'];
      const m = /第\s*(\d+)\s*回合/.exec(f.turnText.text || '');
      if (!m) return [`回合文字里没写「第 <n> 回合」："${f.turnText.text}"`];
      if (!f.engine?.hasView) return ['拿不到 view.turn（页面没进入战斗）'];
      if (f.engine.turn === null) return ['view.turn 不是整数'];
      if (Number(m[1]) !== f.engine.turn) return [`回合文字 ${m[1]} ≠ view.turn ${f.engine.turn}`];
      return [];
    },
    actual: (f) => `文字 "${(f.turnText?.text ?? '').slice(0, 40)}" → n=${/第\s*(\d+)\s*回合/.exec(f.turnText?.text || '')?.[1] ?? '—'}；view.turn=${f.engine?.turn ?? '—'}`},

  // ── C3 左侧竖排四格 ─────────────────────────────────────────────────────
  {id: 'skills-four-cells', criterion: 'C3 左侧竖排四格', state: 'skill', missing: ['data-b3-skill-slot'],
    rule: '技能态左列恰好 4 格',
    problems: (f) => (f.skills?.count === 4 ? [] : [`左列 ${f.skills?.count ?? 0} 格（要 4 格）`]),
    actual: (f) => `${f.skills?.count ?? 0} 格；底边 ${fmt(f.skills?.lastBottom)}；每格高 ${(f.skills?.cells ?? []).map((c) => fmt(c.rect?.h)).join('/')}`},

  {id: 'skills-cell-content', criterion: 'C3 左侧竖排四格', state: 'skill',
    missing: ['data-b3-cost', 'data-b3-rel', '属性（emoji+中文）'],
    rule: '每格有 ⭐ 消耗（data-b3-cost）、属性（emoji+中文）、克制标记（data-b3-rel ∈ up/down/none，或字形）',
    problems: (f) => {
      const bad = [];
      const cells = f.skills?.cells ?? [];
      if (!cells.length) return ['一格都没有（缺 data-b3-skill-slot）'];
      cells.forEach((c, i) => {
        const n = i + 1;
        if (!c.costHook) bad.push(`第 ${n} 格缺 data-b3-cost（消耗）`);
        else if (!/[★☆⭐🌟]/.test(c.costText) || !/\d/.test(c.costText)) bad.push(`第 ${n} 格消耗没写成「⭐ n」："${c.costText}"`);
        if (!c.elementName) bad.push(`第 ${n} 格没有属性名（要「某系」）："${c.text}"`);
        else if (!c.hasEmoji) bad.push(`第 ${n} 格属性只有"${c.elementName}"没有 emoji："${c.text}"`);
        if (!c.relPresent) bad.push(`第 ${n} 格缺 data-b3-rel（克制标记）`);
        else if (!['up', 'down', 'none'].includes(String(c.relValue)) && !c.relGlyph) {
          bad.push(`第 ${n} 格克制标记不可读：data-b3-rel="${c.relValue}"（只认 up/down/none），也没有字形`);
        }
      });
      return bad;
    },
    actual: (f) => (f.skills?.cells ?? []).map((c, i) => `#${i + 1} 耗"${c.costText}" 属性${c.elementName ?? '—'}${c.hasEmoji ? '(emoji)' : '(无emoji)'} 克制=${c.relValue ?? (c.relGlyph ? '字形' : '缺')}`).join('；') || '—'},

  {id: 'skills-cost-short', criterion: 'C3 左侧竖排四格', state: 'skill',
    missing: ['data-b3-cost-short'],
    rule: '星不够的格子 data-b3-cost-short="yes" 且不可点；可点格子数 == 引擎给的合法技能数；每格都要带该钩子',
    problems: (f) => {
      const bad = [];
      const cells = f.skills?.cells ?? [];
      if (!cells.length) return ['一格都没有（缺 data-b3-skill-slot）'];
      const missingHook = cells.filter((c) => !c.costShortHook).length;
      if (missingHook) bad.push(`${missingHook}/${cells.length} 格没带 data-b3-cost-short（每格都要写 yes/no）`);
      cells.filter((c) => c.costShortAttr === 'yes').forEach((c) => {
        if (c.clickable) bad.push(`第 ${c.index + 1} 格 data-b3-cost-short="yes" 却仍可点（信号 ${c.clickSignal}）`);
      });
      if (!f.engine?.hasView) bad.push('拿不到 view.legal（页面没进入战斗）');
      else if (cells.filter((c) => c.clickable).length !== f.engine.legalSkills) {
        bad.push(`可点格 ${cells.filter((c) => c.clickable).length} ≠ 引擎合法技能 ${f.engine.legalSkills}`);
      }
      return bad;
    },
    actual: (f) => `星不够 ${f.skills?.shortCount ?? '—'} 格；可点 ${f.skills?.clickableCount ?? '—'}；引擎合法技能 ${f.engine?.legalSkills ?? '—'}（kind=${f.engine?.legalKinds ?? '—'}）；`
      + `可点信号 ${(f.skills?.cells ?? []).map((c) => c.clickSignal).join('/')}`},

  // ── C4 更换态 ───────────────────────────────────────────────────────────
  {id: 'tab-hook-switch', criterion: 'C4 更换态', state: 'switch', missing: ['body[data-b3-tab]'],
    rule: '点「更换」之后 body[data-b3-tab] 必须是 switch',
    problems: (f) => (f.tab?.switch === 'switch' ? []
      : [`点「更换」按钮之后 body[data-b3-tab]=${JSON.stringify(f.tab?.switch ?? null)}（要 "switch"）——`
        + '按钮与状态之间没接上：CSS 只认 body[data-b3-tab]，得有人把点击写进去']),
    actual: (f) => `body[data-b3-tab]=${JSON.stringify(f.tab?.switch ?? null)}；按钮点击 ${JSON.stringify(f.tab?.switchClick ?? null)}`},

  {id: 'switch-five-rows', criterion: 'C4 更换态', state: 'switch', missing: ['data-b3-switch-row'],
    rule: '更换态左列一行一只可换上的精灵（活着的队友，不含场上那只；示意图 6 宠队 → 5 行）',
    problems: (f) => {
      const bad = [];
      const n = f.switchRows?.count ?? 0;
      if (!n) bad.push('更换态左列没有 data-b3-switch-row（一行都没有）');
      if (!f.engine?.hasView) bad.push('拿不到 view.self.pets（页面没进入战斗）');
      else if (n !== f.engine.aliveOthers) {
        bad.push(`左列 ${n} 行 ≠ 可换上的存活队友 ${f.engine.aliveOthers} 行`
          + `（活着 ${f.engine.aliveTeammates} 只，其中 1 只正在场上）`);
      }
      return bad;
    },
    actual: (f) => `${f.switchRows?.count ?? 0} 行；可换上的存活队友 ${f.engine?.aliveOthers ?? '—'}（活着 ${f.engine?.aliveTeammates ?? '—'}/${f.engine?.petCount ?? '—'}）；行高 ${(f.switchRows?.rows ?? []).map((r) => fmt(r.rect?.h)).join('/')}`},

  {id: 'switch-row-content', criterion: 'C4 更换态', state: 'switch', missing: ['data-b3-switch-row', 'data-b3-rel'],
    rule: '每行有 名字 / 属性（emoji+中文）/ 克制标记 / 血量',
    problems: (f) => {
      const bad = [];
      const rows = f.switchRows?.rows ?? [];
      if (!rows.length) return ['一行都没有（缺 data-b3-switch-row）'];
      rows.forEach((r) => {
        const n = r.index + 1;
        if (!r.name) bad.push(`第 ${n} 行找不到名字："${r.text}"`);
        if (!r.elementName) bad.push(`第 ${n} 行没有属性名："${r.text}"`);
        else if (!r.hasEmoji) bad.push(`第 ${n} 行属性只有"${r.elementName}"没有 emoji`);
        if (!r.relPresent && !r.relGlyph) bad.push(`第 ${n} 行缺克制标记（data-b3-rel）`);
        if (!r.hpText) bad.push(`第 ${n} 行没有血量（要写成 n / m）："${r.text}"`);
      });
      return bad;
    },
    actual: (f) => (f.switchRows?.rows ?? []).map((r) => `#${r.index + 1} ${r.name ?? '—'}/${r.elementName ?? '—'}${r.hasEmoji ? '' : '(无emoji)'}/克制${r.relValue ?? (r.relGlyph ? '字形' : '缺')}/${r.hpText ?? '缺'}`).join('；') || '—'},

  {id: 'switch-bottom-align', criterion: 'C4 更换态', state: 'switch', missing: ['data-b3-switch-row'],
    rule: '更换态左列底边与技能态最后一格的底边对齐（±4px）',
    skip: (f) => (f.tab?.switch !== 'switch'
      ? '切不到「更换」态（body[data-b3-tab] 没变成 switch）——换不到那一屏，版式几何这一次不可判' : null),
    problems: (f) => {
      const rows = f.switchRows?.rows ?? [];
      if (!rows.length) return ['更换态量不到行（缺 data-b3-switch-row）'];
      if (rows.some((r) => EMPTY(r.rect))) return ['更换态有行的尺寸是 0（页面没渲染出来）'];
      const bottom = f.switchRows?.lastBottom;
      const skillBottom = f.switchRows?.skillTabLastBottom;
      if (!Number.isFinite(skillBottom)) return ['没采到技能态最后一格的底边（技能态没有 data-b3-skill-slot）'];
      if (!Number.isFinite(bottom)) return ['量不到更换态行的底边'];
      if (Math.abs(bottom - skillBottom) > 4) {
        return [`更换态底边 ${fx(bottom)} ≠ 技能态最后一格底边 ${fx(skillBottom)}（差 ${fx(Math.abs(bottom - skillBottom))}px > 4px）`];
      }
      return [];
    },
    actual: (f) => `更换态底边 ${fmt(f.switchRows?.lastBottom)} / 技能态最后一格底边 ${fmt(f.switchRows?.skillTabLastBottom)}（差 ${fx(Math.abs((f.switchRows?.lastBottom ?? 0) - (f.switchRows?.skillTabLastBottom ?? 0)))}px）`},

  {id: 'switch-not-overlap-charge', criterion: 'C4 更换态', state: 'switch', missing: ['data-b3-switch-row'],
    rule: '更换态的行不得覆盖聚能区（两者矩形不相交）',
    skip: (f) => (f.tab?.switch !== 'switch'
      ? '切不到「更换」态（body[data-b3-tab] 没变成 switch）——换不到那一屏，覆盖关系这一次不可判' : null),
    problems: (f) => {
      const rows = f.switchRows?.rows ?? [];
      const charge = f.footer?.charge?.rect;
      if (!rows.length) return ['更换态量不到行（缺 data-b3-switch-row）'];
      if (rows.some((r) => EMPTY(r.rect))) return ['更换态有行的尺寸是 0（页面没渲染出来）'];
      if (!charge) return ['量不到聚能区（底部找不到「⭐ n / m」那个块）'];
      if (EMPTY(charge)) return ['聚能区尺寸是 0（没渲染出来）'];
      return rows.filter((r) => r.rect && CONTAIN(r.rect, charge))
        .map((r) => `第 ${r.index + 1} 行与聚能区相交：行 [${fx(r.rect.left)},${fx(r.rect.top)}→${fx(r.rect.right)},${fx(r.rect.bottom)}]；`
          + `聚能 [${fx(charge.left)},${fx(charge.top)}→${fx(charge.right)},${fx(charge.bottom)}]`);
    },
    actual: (f) => `行范围 y ${fmt(Math.min(...(f.switchRows?.rows ?? [{rect: {top: NaN}}]).map((r) => r.rect?.top ?? NaN)))}→${fmt(f.switchRows?.lastBottom)}；`
      + `聚能区 y ${fmt(f.footer?.charge?.rect?.top)}→${fmt(f.footer?.charge?.rect?.bottom)}`},

  // ── C5 背包态 ───────────────────────────────────────────────────────────
  {id: 'tab-hook-item', criterion: 'C5 背包态', state: 'item', missing: ['body[data-b3-tab]'],
    rule: '点「物品」之后 body[data-b3-tab] 必须是 item',
    problems: (f) => (f.tab?.item === 'item' ? []
      : [`点「物品」按钮之后 body[data-b3-tab]=${JSON.stringify(f.tab?.item ?? null)}（要 "item"）——`
        + '按钮与状态之间没接上：CSS 只认 body[data-b3-tab]，得有人把点击写进去']),
    actual: (f) => `body[data-b3-tab]=${JSON.stringify(f.tab?.item ?? null)}；按钮点击 ${JSON.stringify(f.tab?.itemClick ?? null)}`},

  {id: 'item-candidate-boundary', criterion: 'C5 背包态', state: 'item', missing: ['data-b3-item-cell'],
    rule: '背包态必须写出「候选 / 未核验」的边界说明',
    problems: (f) => {
      const text = f.item?.text ?? '';
      if (!f.item?.count) return ['背包态左列没有 data-b3-item-cell（一件物品都没有）'];
      if (!/未核验|候选|未取证|未登记/.test(text)) {
        return [`左列没有「未核验/候选」字样：左边一列原文「${text.slice(0, 120)}」`];
      }
      return [];
    },
    actual: (f) => `${f.item?.count ?? 0} 件；命中「${(f.item?.text ?? '').match(/未核验|候选|未取证|未登记/)?.[0] ?? '—'}」；原文 "${(f.item?.text ?? '').slice(0, 80)}"`},

  {id: 'item-no-definite-numbers', criterion: 'C5 背包态', state: 'item', missing: ['data-b3-item-cell'],
    rule: '背包态不得出现确定性数字（每场 n 次 / 冷却 n 回合 / +150% / 立即生效）',
    problems: (f) => {
      const text = f.item?.text ?? '';
      if (!f.item?.count) return ['背包态左列没有 data-b3-item-cell（没有可检的文案）'];
      const banned = [/每场\s*\d+\s*次/g, /冷却\s*\d+\s*回合/g, /\+?150%/g, /立即生效/g];
      const hits = [];
      for (const re of banned) for (const m of text.matchAll(re)) hits.push(m[0]);
      return hits.length ? [`确定性数字/时长 ${hits.length} 处：${[...new Set(hits)].join('、')}`] : [];
    },
    actual: (f) => {
      const text = f.item?.text ?? '';
      const banned = [/每场\s*\d+\s*次/g, /冷却\s*\d+\s*回合/g, /\+?150%/g, /立即生效/g];
      const hits = banned.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
      return `违规命中 ${hits.length} 处${hits.length ? `：${[...new Set(hits)].join('、')}` : '（无）'}`;
    }},

  // ── C6 右列战报 ─────────────────────────────────────────────────────────
  {id: 'log-width-equal', criterion: 'C6 右列战报', state: 'skill',
    missing: ['data-b3-log-turn', '左列（技能格列容器）'],
    rule: '右列战报与左列等宽（±2px）',
    problems: (f) => {
      const L = f.columns?.left?.w; const R = f.log?.colWidth;
      if (!Number.isFinite(L) || L <= 0) return ['量不到左列宽（缺 data-b3-skill-slot，或左列尺寸是 0）'];
      if (!Number.isFinite(R) || R <= 0) return ['量不到右列宽（缺 data-b3-log-turn，或战报列尺寸是 0）'];
      if (Math.abs(L - R) > 2) return [`战报列 ${fx(R)}px ≠ 左列 ${fx(L)}px（差 ${fx(Math.abs(L - R))}px > 2px）`];
      return [];
    },
    actual: (f) => `战报列 ${fmt(f.log?.colWidth)}px / 左列 ${fmt(f.columns?.left?.w)}px；战报列在右列内=${!(f.columns?.logOutsideRight ?? true)}`},

  {id: 'log-latest-first', criterion: 'C6 右列战报', state: 'skill', missing: ['data-b3-log-turn'],
    skip: (f) => ((f.log?.count ?? 0) < 2 ? `只有 ${f.log?.count ?? 0} 个回合分组 —— 「最新在最上」这一次不可判（不算通过）` : null),
    rule: '最新回合在最上（DOM 顺序按回合号降序）',
    problems: (f) => {
      const turns = (f.log?.turns ?? []).filter((n) => Number.isFinite(n));
      if (turns.length < 2) return [`可读的回合号只有 ${turns.length} 个：${JSON.stringify(f.log?.turns ?? [])}`];
      for (let i = 1; i < turns.length; i += 1) {
        if (turns[i] > turns[i - 1]) return [`顺序不对：DOM 里第 ${i} 个回合分组是「第 ${turns[i]} 回合」，上一个却是「第 ${turns[i - 1]} 回合」——最新在最上要求降序，实际 ${turns.join(' → ')}`];
      }
      return [];
    },
    actual: (f) => `DOM 顺序 ${JSON.stringify(f.log?.turns ?? [])}（来源 ${f.log?.turnSource ?? '—'}）；首组 ${f.log?.firstTurn ?? '—'}；最大 ${f.log?.maxTurn ?? '—'}`},

  {id: 'log-grouped-by-turn', criterion: 'C6 右列战报', state: 'skill', missing: ['data-b3-log-turn'],
    rule: '战报按回合分组：每组一个 data-b3-log-turn 且带可读的回合号（不重复）',
    problems: (f) => {
      const bad = [];
      const turns = f.log?.turns ?? [];
      if (!turns.length) return ['没有 data-b3-log-turn（战报没有按回合分组）'];
      const unreadable = turns.filter((n) => !Number.isFinite(n)).length;
      if (unreadable) bad.push(`${unreadable}/${turns.length} 个分组读不出回合号（属性与文字里都没有「第 n 回合」）`);
      const dups = turns.filter((n, i) => Number.isFinite(n) && turns.indexOf(n) !== i);
      if (dups.length) bad.push(`同回合号出现多次：${[...new Set(dups)].join('、')}（一个回合应当只有一个分组）`);
      return bad;
    },
    actual: (f) => `${f.log?.count ?? 0} 组 → ${JSON.stringify(f.log?.turns ?? [])}（回合号来源 ${f.log?.turnSource ?? '—'}）；文本 ${JSON.stringify((f.log?.texts ?? []).slice(0, 2))}`},

  // ── C7 底部 ─────────────────────────────────────────────────────────────
  {id: 'bottom-charge-current', criterion: 'C7 底部', state: 'skill',
    missing: ['底部「聚能 ⭐ n / 上限」（或 data-b3-charge）'],
    rule: '聚能显示当前 ⭐（⭐ n / 上限），n == view.self.pets[active].energy',
    problems: (f) => {
      const c = f.footer?.charge;
      if (!c?.present) return ['底部找不到聚能显示（没有「⭐ n / m」这样的块，也没有 data-b3-charge）'];
      const bad = [];
      if (EMPTY(c.rect)) bad.push(`聚能块尺寸是 0（${fmt(c.rect?.w)}×${fmt(c.rect?.h)}）：没渲染出来`);
      if (c.energy === null) bad.push(`聚能文字里没有「⭐ n / 上限」："${c.text}"`);
      if (!f.engine?.hasView) bad.push('拿不到 view（页面没进入战斗）');
      else if (c.energy !== null && c.energy !== f.engine.energy) {
        bad.push(`聚能显示 ⭐ ${c.energy} ≠ view.self.pets[${f.engine.activeIndex}].energy ${f.engine.energy}`);
      }
      if (c.cap !== null && f.engine?.energyMax !== null && c.cap !== f.engine.energyMax) {
        bad.push(`聚能上限 ${c.cap} ≠ view.self.energy_max ${f.engine.energyMax}`);
      }
      return bad;
    },
    actual: (f) => `"${f.footer?.charge?.text ?? '—'}" → n=${f.footer?.charge?.energy ?? '—'} 上限=${f.footer?.charge?.cap ?? '—'}；`
      + `view.self.pets[${f.engine?.activeIndex ?? '—'}].energy=${f.engine?.energy ?? '—'} energy_max=${f.engine?.energyMax ?? '—'}；来源=${f.footer?.charge?.source ?? '—'}`},

  {id: 'bottom-four-buttons', criterion: 'C7 底部', state: 'skill',
    missing: ['技能/更换/物品/逃跑 四个按钮（或 data-b3-tab-btn）'],
    rule: '底部有四个按钮：技能 / 更换 / 物品 / 逃跑',
    problems: (f) => {
      const labels = f.footer?.tabs?.labels ?? [];
      const want = ['技能', '更换', '物品', '逃跑'];
      const missing = want.filter((w) => !labels.includes(w));
      const bad = [];
      if (missing.length) bad.push(`缺按钮：${missing.join('、')}（量到 ${JSON.stringify(labels)}）`);
      if (labels.length !== 4) bad.push(`按钮 ${labels.length} 个（要 4 个）`);
      return bad;
    },
    actual: (f) => `${(f.footer?.tabs?.buttons ?? []).map((b) => `"${b.label}"<${b.tag}>`).join(' ')}（${f.footer?.tabs?.count ?? 0} 个）`},

  {id: 'bottom-exactly-one-highlight', criterion: 'C7 底部', state: 'skill',
    missing: ['技能/更换/物品/逃跑 四个按钮'],
    rule: '四个按钮里恰好一个高亮（底色与另外三个不同，且更亮）',
    problems: (f) => {
      const buttons = f.footer?.tabs?.buttons ?? [];
      if (buttons.length !== 4) return [`按钮 ${buttons.length} 个（要 4 个）`];
      const counts = new Map();
      for (const b of buttons) counts.set(b.bg, (counts.get(b.bg) ?? 0) + 1);
      const modal = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const hi = buttons.filter((b) => b.bg !== modal);
      if (hi.length !== 1) {
        return [`高亮 ${hi.length} 个（要 1 个）：高亮=${JSON.stringify(hi.map((b) => b.label))}；底色分布 ${JSON.stringify([...counts.entries()])}`];
      }
      const lum = (c) => {
        const m = String(c).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        return m ? Number(m[1]) * 0.299 + Number(m[2]) * 0.587 + Number(m[3]) * 0.114 : null;
      };
      const a = lum(hi[0].bg); const b = lum(modal);
      if (a !== null && b !== null && a <= b) return [`"${hi[0].label}" 的底色 ${hi[0].bg} 并不比其余三个 ${modal} 更亮`];
      return [];
    },
    actual: (f) => (f.footer?.tabs?.buttons ?? []).map((b) => `"${b.label}"=${b.bg}${b.on ? '(标了 on)' : ''}`).join(' ')
      + `；body[data-b3-tab]=${JSON.stringify(f.footer?.tabs?.bodyTab ?? null)}`},

  // ── CX 扩展：对手血条镜像 ───────────────────────────────────────────────
  {id: 'foe-hp-mirrored', criterion: 'CX 扩展（示意图 .fighter.foe .hp .bar{direction:rtl}）', state: 'skill',
    missing: ['对手卡的血条（或 data-b3-hp-bar / data-b3-hp-fill）'],
    rule: '对手血条必须从右往左（direction:rtl 或填充右对齐），我方血条从左侧开始',
    problems: (f) => {
      const bad = [];
      const me = f.hp?.self; const foe = f.hp?.foe;
      if (!me?.found) bad.push('量不到我方血条（卡里找不到「宽扁条 + 满高子块」；可加 data-b3-hp-bar/data-b3-hp-fill）');
      if (!foe?.found) bad.push('量不到对手血条（同上）');
      if (foe?.found) {
        const mirrored = foe.direction === 'rtl' || foe.align === 'right';
        if (!mirrored) bad.push(`对手血条从左往右了：direction=${foe.direction}，填充=${foe.align}（要求 rtl 或右对齐）`);
      }
      if (me?.found && me.direction === 'rtl') bad.push(`我方血条被镜像了：direction=${me.direction}（我方应从左往右）`);
      return bad;
    },
    actual: (f) => `我方 dir=${f.hp?.self?.direction ?? '—'} 对齐=${f.hp?.self?.align ?? '—'} 填充=${f.hp?.self?.ratio ?? '—'}（${f.hp?.self?.source ?? '缺'}）；`
      + `对手 dir=${f.hp?.foe?.direction ?? '—'} 对齐=${f.hp?.foe?.align ?? '—'} 填充=${f.hp?.foe?.ratio ?? '—'}（${f.hp?.foe?.source ?? '缺'}）`},

  {id: 'wrap-spans-page', criterion: 'CX 扩展（三列几何的容器条件）', state: 'skill',
    missing: ['data-b3-root（v3h 片段的根容器）'],
    rule: 'v3h 片段的根容器必须占满页面（宽 ≥ 视口 − 2×16px）且水平居中（±2px）——'
      + '容器被挤扁时，左右列即使等宽也「轴心对不上页面中线」，中间的卡会被压成 57px',
    problems: (f) => {
      const r = f.root;
      if (!r?.present) return ['找不到 v3h 片段的根容器（data-b3-root，或顶部信息栏的父块）'];
      if (EMPTY(r.rect)) return [`根容器尺寸是 0（${fmt(r.rect?.w)}×${fmt(r.rect?.h)}）：没渲染出来`];
      const bad = [];
      const viewport = f.doc?.clientWidth ?? 0;
      // 人类 2026-09-23：「左右留空不要完全顶满，上下也留一点点」→ 允许两侧各 24px 留白
      // 人类 2026-09-23：不要完全顶满 → 只要**居中**且宽度 ≥ 页面内容宽（1200）即算「占满内容区」；
      // 视口很宽时页面本就有 max-width，不该要求贴到视口边。
      const min = Math.min(viewport - 56, 1200);
      if (r.rect.w < min) bad.push(`根容器宽 ${fx(r.rect.w)}px < ${min}px（视口 ${viewport} − 2×16px 留白）——被别的块挤扁了`);
      if (Math.abs(r.rect.cx - (f.doc?.centerX ?? 0)) > 2) {
        bad.push(`根容器中心 x=${fx(r.rect.cx)} ≠ 页面中线 ${fx(f.doc?.centerX)}（差 ${fx(Math.abs(r.rect.cx - (f.doc?.centerX ?? 0)))}px）`);
      }
      return bad;
    },
    actual: (f) => `根容器 ${fmt(f.root?.rect?.w)}px（${fmt(f.root?.rect?.left)}→${fmt(f.root?.rect?.right)}），`
      + `中心 ${fmt(f.root?.rect?.cx)} / 页面中线 ${fmt(f.doc?.centerX)}；来源=${f.root?.source ?? '—'}；父块=${f.root?.parentTag ?? '—'}`},

  // ── 判据自检：合成基线必须全绿，否则判据本身是空的 ────────────────────────
  {id: 'selftest-baseline', criterion: 'C0 钩子契约', state: 'skill', meta: true,
    rule: '自身证据：判据对「已知全绿的合成基线」必须一条都不红（红＝判据写空了）',
    problems: () => [],
    baselineProbe: true,
    actual: () => '见反证段：对基线逐条求值，红的就是空判据'},
];

// ── 合成基线：判据的输入契约（不是页面的事实）────────────────────────────────
function baselineFacts() {
  const rect = (x, y, w, h) => ({left: x, top: y, right: x + w, bottom: y + h, w, h, cx: x + w / 2, cy: y + h / 2});
  const cell = (i, cost, short, clickable, rel) => ({
    index: i, rect: rect(16, 60 + i * 200, 232, 192), text: `${cost} 技能${i + 1} 火系 攻击 预期伤害 128`,
    costHook: true, costText: `⭐ ${cost}`, costShortAttr: short, costShortHook: true,
    relPresent: true, relValue: rel, relGlyph: true, elementName: '火系', hasEmoji: true,
    starChars: '⭐', clickable, clickSignal: clickable ? 'enabled-button' : 'disabled',
  });
  const rowOf = (i) => ({
    index: i, rect: rect(16, 60 + i * 160, 232, 152), text: `精灵${i + 1} 水系 克制 400 / 400`,
    elementName: '水系', hasEmoji: true, relPresent: true, relValue: 'up', relGlyph: true,
    hpText: '400 / 400', name: `精灵${i + 1}`,
  });
  const btn = (label, bg) => ({label, bg, borderColor: 'rgb(47,70,92)', color: 'rgb(201,214,226)', fontWeight: '650', rect: rect(0, 0, 98, 44), tag: 'BUTTON'});
  return {
    state: 'skill',
    boot: {ready: 'yes', battlePanelVisible: true, hasView: true, entryOk: true, consoleErrors: 0, firstError: null},
    doc: {scrollWidth: 1440, clientWidth: 1440, innerWidth: 1440, bodyScrollWidth: 1440, bodyClientWidth: 1440, centerX: 720},
      // energy-cap-scanner-allow: 这条是**反证夹具**，故意写死一个错值来验「页面读数 != 引擎值」必须红
    engine: {hasView: true, turn: 2, activeIndex: 0, activeName: '音速犬', energy: 2, energyMax: 10,
      aliveTeammates: 6, aliveOthers: 5, petCount: 6, legalSkills: 2, legalKinds: 'skill,switch', phase: 'battle'},
    hooks: {present: [...REQUIRED_HOOKS], absent: [], counts: {'data-b3-skill-slot': 4, 'data-b3-log-turn': 2}},
    root: {present: true, source: 'hook', rect: rect(0, 0, 1440, 900), tag: 'DIV.b3-wrap', parentTag: 'SECTION#battle-panel'},
    columns: {resolved: true, mainTag: 'MAIN', kidCount: 3, kidTags: 'DIV#skills>DIV#stage>DIV#logcol',
      left: rect(16, 60, 232, 800), right: rect(1192, 60, 232, 800), mid: rect(262, 60, 916, 800),
      leftIsSkillParent: true, rightHasLog: true, logOutsideRight: false},
    derivedFrom: {columns: 'hook', stage: 'hook', topbar: 'hook'},
    stage: {resolved: true, source: 'hook', stageRect: rect(262, 60, 916, 800),
      fighters: [{rect: rect(262, 60, 451, 800), tag: 'DIV#self-card'}, {rect: rect(727, 60, 451, 800), tag: 'DIV#foe-card'}]},
    topbar: {resolved: true, source: 'hook', rect: rect(16, 20, 1408, 34), tag: 'DIV#topbar',
      borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
      borderTopStyle: 'none', bg: 'rgba(0, 0, 0, 0)', bgTransparent: true, bgImage: 'none', boxShadow: 'none'},
    dotsSelf: {present: true, rect: rect(20, 24, 90, 26), text: '●●●●○○'},
    dotsFoe: {present: true, rect: rect(1330, 24, 90, 26), text: '○○○●●●'},
    turnText: {present: true, text: 'PVP · AI模拟 第 2 回合', rect: rect(660, 20, 120, 34)},
    skills: {count: 4, cells: [cell(0, 0, 'no', true, 'none'), cell(1, 1, 'no', true, 'up'),
      cell(2, 3, 'yes', false, 'down'), cell(3, 5, 'yes', false, 'none')],
    clickableCount: 2, shortCount: 2, lastBottom: 60 + 3 * 200 + 192},
    // `skillTabLastBottom` 必须等于 `skills.lastBottom`（60 + 3*200 + 192 = 852）：基线的每一格都要自洽
    switchRows: {count: 5, skillTabLastBottom: 60 + 3 * 200 + 192, lastBottom: 60 + 4 * 160 + 152,
      rows: [0, 1, 2, 3, 4].map(rowOf)},
    item: {count: 2, cells: [], text: '愿力强化 候选机制（未核验）：是否占行动未登记；次数与冷却均未登记 首领化 候选机制（未取证）'},
    log: {count: 2, turns: [2, 1], turnSource: 'attr', firstTurn: 2, maxTurn: 2,
      colWidth: 232, colRect: rect(1192, 60, 232, 800), texts: ['第 2 回合 你换上雪影娃娃', '第 1 回合 音速犬使用强制重启'], scrollTag: 'DIV'},
    footer: {resolved: true, rect: rect(16, 874, 1408, 44),
      // energy-cap-scanner-allow: 这条是**反证夹具**，故意写死一个错值来验「页面读数 != 引擎值」必须红
      charge: {present: true, source: 'hook', text: '聚能 ⭐ 2 / 10', energy: 2, cap: 10, rect: rect(16, 874, 120, 44)},
      chargeRect: rect(16, 874, 120, 44),
      tabs: {count: 4, bodyTab: 'skill', labels: ['技能', '更换', '物品', '逃跑'],
        buttons: [btn('技能', 'rgb(30,59,85)'), btn('更换', 'rgb(21,34,48)'), btn('物品', 'rgb(21,34,48)'), btn('逃跑', 'rgb(21,34,48)')]}},
    hp: {self: {found: true, source: 'hook', direction: 'ltr', align: 'partial', ratio: 1, fillLeft: 0, fillRight: 0,
      bar: rect(300, 110, 300, 8), fill: rect(300, 110, 300, 8)},
    foe: {found: true, source: 'hook', direction: 'rtl', align: 'right', ratio: 0.64, fillLeft: 108, fillRight: 0,
      bar: rect(800, 110, 300, 8), fill: rect(908, 110, 192, 8)}},
    tab: {skill: 'skill', switch: 'switch', item: 'item'},
  };
}

/** 反证登记表：每一条**真的**把基线弄坏一处，再看目标判据有没有红。 */
const COUNTERPROOFS = [
  {id: 'cp-columns-skew', check: 'geom-columns-equal', desc: '把右列宽度写歪（232 → 272px）',
    mutate: (f) => { f.columns.right = {...f.columns.right, w: 272, right: 1192 + 272}; }},
  {id: 'cp-hscroll', check: 'geom-no-hscroll', desc: '让页面横向溢出（scrollWidth 1460 > clientWidth 1440）',
    mutate: (f) => { f.doc.scrollWidth = 1460; }},
  {id: 'cp-axis-off', check: 'geom-stage-axis', desc: '把两张出战卡整体右移 20px（轴心离开页面中线）',
    mutate: (f) => { for (const x of f.stage.fighters) { x.rect.left += 20; x.rect.right += 20; x.rect.cx += 20; } }},
  {id: 'cp-topbar-border', check: 'topbar-plain', desc: '给顶部信息栏加 1px 上边框',
    mutate: (f) => { f.topbar.borderTopWidth = '1px'; f.topbar.borderTopStyle = 'solid'; }},
  {id: 'cp-topbar-bg', check: 'topbar-plain', desc: '给顶部信息栏加底色',
    mutate: (f) => { f.topbar.bg = 'rgb(17, 28, 38)'; f.topbar.bgTransparent = false; }},
  {id: 'cp-dots-misaligned', check: 'topbar-dots-center', desc: '把右侧存活点组下移 6px',
    mutate: (f) => { f.dotsFoe.rect.top += 6; f.dotsFoe.rect.bottom += 6; f.dotsFoe.rect.cy += 6; }},
  {id: 'cp-turn-mismatch', check: 'topbar-turn-text', desc: '回合文字写「第 3 回合」而 view.turn=2',
    mutate: (f) => { f.turnText.text = 'PVP · AI模拟 第 3 回合'; }},
  {id: 'cp-five-cells', check: 'skills-four-cells', desc: '左列只画 3 格',
    mutate: (f) => { f.skills.count = 3; f.skills.cells = f.skills.cells.slice(0, 3); }},
  {id: 'cp-cell-no-rel', check: 'skills-cell-content', desc: '第 1 格去掉克制标记',
    mutate: (f) => { f.skills.cells[0].relPresent = false; f.skills.cells[0].relValue = null; f.skills.cells[0].relGlyph = false; }},
  {id: 'cp-cell-cost-only-number', check: 'skills-cell-content', desc: '第 2 格消耗只写「3」不写 ⭐',
    mutate: (f) => { f.skills.cells[1].costText = '3'; }},
  {id: 'cp-cost-short-clickable', check: 'skills-cost-short', desc: '星不够的格子（cost-short=yes）仍然可点',
    mutate: (f) => { f.skills.cells[2].clickable = true; f.skills.cells[2].clickSignal = 'enabled-button'; f.skills.clickableCount = 3; }},
  {id: 'cp-legal-skills-mismatch', check: 'skills-cost-short', desc: '可点格 1 个，引擎却给了 2 个合法技能',
    mutate: (f) => { f.skills.cells[1].clickable = false; f.skills.cells[1].clickSignal = 'disabled'; f.skills.clickableCount = 1; }},
  {id: 'cp-switch-tab-hook', check: 'tab-hook-switch', desc: '点了「更换」但 body[data-b3-tab] 还停在 skill',
    mutate: (f) => { f.tab.switch = 'skill'; }},
  {id: 'cp-switch-four-rows', check: 'switch-five-rows', desc: '更换态只画 4 行（存活队友 5 只）',
    mutate: (f) => { f.switchRows.rows = f.switchRows.rows.slice(0, 4); f.switchRows.count = 4; }},
  {id: 'cp-switch-row-no-hp', check: 'switch-row-content', desc: '更换态第 3 行不写血量',
    mutate: (f) => { f.switchRows.rows[2].hpText = null; f.switchRows.rows[2].text = '化蝶 虫系 攻击'; }},
  {id: 'cp-switch-bottom-misalign', check: 'switch-bottom-align', desc: '更换态底边比技能态最后一格低 40px',
    mutate: (f) => { f.switchRows.skillTabLastBottom = 820; }},
  {id: 'cp-switch-overlap-charge', check: 'switch-not-overlap-charge', desc: '更换态第 5 行压到聚能区上',
    mutate: (f) => { const r = f.switchRows.rows[4].rect; r.top = 860; r.bottom = 1012; r.h = 152; }},
  {id: 'cp-item-forbidden-number', check: 'item-no-definite-numbers', desc: '把「每场 3 次」这种确定性数字塞进背包格',
    mutate: (f) => { f.item.text = `${f.item.text} 每场 3 次，冷却 2 回合，+150% 立即生效。`; }},
  {id: 'cp-item-no-candidate-note', check: 'item-candidate-boundary', desc: '背包格只写效果、不写「未核验/候选」边界',
    mutate: (f) => { f.item.text = '愿力强化：把当前精灵的第一个技能换成愿力冲击。'; }},
  {id: 'cp-log-order-flipped', check: 'log-latest-first', desc: '把战报顺序倒过来（最旧的回合在最上）',
    mutate: (f) => { f.log.turns = [1, 2]; }},
  {id: 'cp-log-ungrouped', check: 'log-grouped-by-turn', desc: '战报不按回合分组（回合号读不出）',
    mutate: (f) => { f.log.turns = [null, null]; f.log.turnSource = 'none'; }},
  {id: 'cp-log-wider', check: 'log-width-equal', desc: '把战报列拉宽到 300px（与左列不等宽）',
    mutate: (f) => { f.log.colWidth = 300; }},
  {id: 'cp-charge-stale', check: 'bottom-charge-current', desc: '聚能显示 ⭐ 3 而 view 里是 2',
    mutate: (f) => { f.footer.charge.energy = 3; f.footer.charge.text = '聚能 ⭐ 3 / 10'; }},
  {id: 'cp-two-highlights', check: 'bottom-exactly-one-highlight', desc: '两个按钮同时高亮',
    mutate: (f) => { f.footer.tabs.buttons[1].bg = f.footer.tabs.buttons[0].bg; }},
  {id: 'cp-foe-hp-ltr', check: 'foe-hp-mirrored', desc: '把对手血条改成从左往右（direction:ltr + 左对齐）',
    mutate: (f) => { f.hp.foe.direction = 'ltr'; f.hp.foe.align = 'left'; f.hp.foe.fill = {...f.hp.foe.bar, w: 192, right: f.hp.foe.bar.left + 192}; }},
  {id: 'cp-missing-hooks', check: 'hooks-required', desc: '主线程一个 data-b3-* 钩子都不加',
    mutate: (f) => { f.hooks.present = []; f.hooks.absent = [...REQUIRED_HOOKS]; }},
  {id: 'cp-not-booted', check: 'page-boots', desc: '页面没启动（render() 抛异常 → rocoReady 不是 yes、view 是空的）',
    mutate: (f) => { f.boot = {ready: undefined, battlePanelVisible: false, hasView: false, entryOk: false, consoleErrors: 1,
      firstError: 'ReferenceError: Cannot access \'size\' before initialization'}; }},
  {id: 'cp-console-error', check: 'console-clean', desc: '页面抛了一个未捕获异常但界面看起来还在',
    mutate: (f) => { f.boot.consoleErrors = 1; f.boot.firstError = 'TypeError: x is not a function'; }},
  {id: 'cp-wrap-squeezed', check: 'wrap-spans-page', desc: '把 v3h 根容器挤成 621px 并左偏（和页面上现在发生的一样）',
    mutate: (f) => { f.root.rect = {left: 154, top: 0, right: 775, bottom: 900, w: 621, h: 900, cx: 464.5, cy: 450}; }},
  {id: 'cp-empty-rects', check: 'geom-columns-equal', desc: '列容器量出来是 0 尺寸（元素在但没渲染）——不许当成「宽度相等」假绿',
    mutate: (f) => { f.columns.left = {left: 0, top: 0, right: 0, bottom: 0, w: 0, h: 0, cx: 0, cy: 0};
      f.columns.right = {left: 0, top: 0, right: 0, bottom: 0, w: 0, h: 0, cx: 0, cy: 0}; }},
];

// ── CDP 小工具 ──────────────────────────────────────────────────────────────
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

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-b3-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  let chromeErr = '';
  chrome.stderr?.on('data', (chunk) => { chromeErr = (chromeErr + String(chunk)).slice(-800); });
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) {
    chrome.kill('SIGKILL');
    rmSync(profile, {recursive: true, force: true});
    throw new Error(`Chrome 没起来：${chromeErr}`);
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return {
    cdp: new Cdp(ws),
    close: async () => {
      try { ws.close(); } catch { /* 已经关了 */ }
      chrome.kill('SIGKILL');
      rmSync(profile, {recursive: true, force: true});
    },
  };
}

// ── 跑一遍真实页面 ──────────────────────────────────────────────────────────
const results = {checks: [], counterproofs: [], shots: [], steps: [], consoleErrors: []};

function recordCheck(check, facts, extra = {}) {
  const skipped = typeof check.skip === 'function' ? check.skip(facts) : null;
  const problems = skipped ? [] : check.problems(facts);
  const row = {id: check.id, criterion: check.criterion, rule: check.rule,
    state: check.state, missing: check.missing ?? [], meta: Boolean(check.meta),
    ok: skipped ? null : problems.length === 0, skipped: Boolean(skipped),
    problems: problems.map((p) => oneLine(p, 400)), actual: oneLine(check.actual(facts), 400), ...extra};
  results.checks.push(row);
  const mark = row.skipped ? '○' : (row.ok ? '✔' : '✖');
  log(mark, `[${check.id}]`, `— ${String(row.actual).slice(0, 260)}`);
  if (!row.ok && !row.skipped) for (const p of problems) log('    ·', oneLine(p, 300));
  if (row.skipped) log('    ○', skipped);
  return row;
}

/**
 * ⓪ 判据自检 + 反证：**与页面无关**，所以放在最前面跑 —— 判据本身写坏了要先知道，
 * 否则「页面全红」到底是页面的问题还是判据的问题就分不清了。
 */
function runSelftest() {
  const baseline = baselineFacts();
  const real = CHECKS.filter((c) => !c.meta);
  const vacant = real.filter((c) => c.problems(baseline).length > 0);
  log(`判据自检：合成基线 ${real.length - vacant.length}/${real.length} 条绿`
    + (vacant.length ? `；**空判据/写坏**：${vacant.map((c) => c.id).join('、')}` : ''));
  for (const c of vacant) log('  ✖ 基线就红：', c.id, '→', c.problems(baseline).join(' | '));
  results.counterproofs.push({id: 'selftest-baseline', check: '(全部非 meta 判据)',
    desc: '判据对已知全绿的合成基线必须全绿（红＝判据是空的）',
    ok: vacant.length === 0, hit: vacant.map((c) => c.id).join('、') || '（全绿）'});
  log(vacant.length ? '✖' : '✔', '[反证 selftest-baseline]', '—', vacant.length ? vacant.map((c) => c.id).join('、') : '合成基线全绿');

  for (const cp of COUNTERPROOFS) {
    const check = CHECKS.find((c) => c.id === cp.check);
    const facts = baselineFacts();
    cp.mutate(facts);
    const problems = check ? check.problems(facts) : ['（没有这条判据！）'];
    const hit = problems.length > 0;
    results.counterproofs.push({id: cp.id, check: cp.check, desc: cp.desc, ok: hit,
      hit: hit ? problems.join(' | ') : '（没命中——判据是空的！）'});
    log(hit ? '✔' : '✖', `[反证 ${cp.id}]`, `— ${(hit ? problems.join(' | ') : '没命中').slice(0, 200)}`);
  }
  return {baseline, vacant};
}

async function main() {
  mkdirSync(OUT, {recursive: true});
  const {baseline, vacant} = runSelftest();
  if (argv.includes('--selftest-only')) {
    const hits = results.counterproofs.filter((c) => c.ok).length;
    console.log(`判据 0/0 通过；反证 ${hits}/${results.counterproofs.length} 命中（--selftest-only：没开浏览器）`);
    process.exitCode = hits === results.counterproofs.length ? 0 : 1;
    return;
  }
  if (!CHROME) throw new Error('找不到 Chrome（设 CHROME_BIN，或装 Google Chrome）');

  // ── ① 真实页面 ──────────────────────────────────────────────────────────
  const browser = await launchChrome();
  const {cdp} = browser;
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error') return;
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      const frame = (p.stackTrace?.callFrames ?? [])[0];
      const where = frame ? ` @ ${String(frame.url).replace(/^https?:\/\/[^/]+/, '')}:${frame.lineNumber + 1}` : '';
      results.consoleErrors.push(`${oneLine(text, 400)}${where}`);
    });
    // 未捕获异常**必须带位置**：只有一句 "SyntaxError: missing ) after argument list"
    // 对施工的人来说等于没说 —— 哪个文件、哪一行才是能动手的信息。
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p?.exceptionDetails ?? {};
      const where = d.url ? ` @ ${String(d.url).replace(/^https?:\/\/[^/]+/, '')}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}` : '';
      results.consoleErrors.push(`${oneLine(d.exception?.description ?? d.text ?? '', 400)}${where}`);
    });
    const js = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
      if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const waitFor = async (expr, tries = 60, step = 250) => {
      for (let i = 0; i < tries; i += 1) {
        try { if (await js(expr)) return true; } catch { /* 页面还在导航 */ }
        await sleep(step);
      }
      return false;
    };
    const splitSel = (sel) => {
      const [host, inner] = String(sel).split('>>>').map((p) => p.trim());
      return {host, inner: inner ?? null};
    };
    const rectOf = (selector) => {
      const {host, inner} = splitSel(selector);
      return js(`(()=>{const host=${JSON.stringify(host)}?document.querySelector(${JSON.stringify(host)}):null;
        const scope=${inner ? '(host&&host.shadowRoot)' : 'document'};
        const el=scope?(${JSON.stringify(inner)}?scope.querySelector(${JSON.stringify(inner)}):host):null;
        if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
        return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};})()`);
    };
    /** 真鼠标：Input.dispatchMouseEvent（不用 .click()）。 */
    const mouseAt = async (x, y, settle = 260) => {
      await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
      await sleep(40);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
      }
      await sleep(settle);
      return true;
    };
    const clickSelector = async (selector) => {
      const r = await rectOf(selector);
      if (!r) return false;
      await mouseAt(Math.round(r.x), Math.round(r.y));
      return true;
    };
    /** 按文字找按钮（页面上没有 tab 钩子时用它取坐标，**仍然走真鼠标**）。 */
    const clickByLabel = async (label) => {
      const r = await js(`(()=>{const want=${JSON.stringify(label)};
        const els=[...document.querySelectorAll('button,[role="tab"],[role="button"]')];
        const el=els.find((e)=>(e.textContent||'').replace(/\\s+/g,' ').trim()===want)
          ||els.find((e)=>(e.textContent||'').replace(/\\s+/g,' ').trim().startsWith(want));
        if(!el)return null;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();
        return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height,text:(el.textContent||'').trim()};})()`);
      if (!r) return false;
      await mouseAt(Math.round(r.x), Math.round(r.y));
      return r;
    };
    /**
     * 切到某一态：**优先点带 `data-b3-tab` 的那个控件**（v3h 片段的真钩子），
     * 点不到再退回按中文标签找。两条路都走**真鼠标** `Input.dispatchMouseEvent`。
     */
    const clickTab = async (tab, label) => {
      const r = await js(`(()=>{const want=${JSON.stringify(tab)};
        const el=[...document.querySelectorAll('[data-b3-tab]')]
          .find((e)=>e.getAttribute('data-b3-tab')===want&&e!==document.body&&e!==document.documentElement);
        if(!el)return null;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();
        return {x:b.left+b.width/2,y:b.top+b.height/2,w:b.width,h:b.height,tag:el.tagName,text:(el.textContent||'').trim()};})()`);
      if (r && r.w > 0 && r.h > 0) {
        await mouseAt(Math.round(r.x), Math.round(r.y));
        return {how: `click:[data-b3-tab="${tab}"]`, ...r};
      }
      const byLabel = await clickByLabel(label);
      return byLabel ? {how: `click:label "${label}"`, ...byLabel} : null;
    };
    const shoot = async (name) => {
      if (!SHOTS) return null;
      // 截图必须代表**页面在初始滚动位置**的样子：点按钮用的 `scrollIntoView` 会把页面滚下去。
      await js(`(()=>{window.scrollTo(0,0);return true;})()`);
      await sleep(220);
      const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
      const file = join(OUT, `${name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      results.shots.push(`${name}.png`);
      return file;
    };
    const collect = async (state) => {
      await js(`(()=>{window.scrollTo(0,0);return true;})()`);
      await sleep(160);
      return js(`(${collectInPage.toString()})(${JSON.stringify(state)})`);
    };

    await cdp.send('Emulation.setDeviceMetricsOverride',
      {width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1, mobile: false});
    await cdp.send('Page.navigate', {url: PAGE_URL});
    const ready = await waitFor(`document.body.dataset.rocoReady==='yes'`, 120, 250);
    if (!ready) {
      // 启动失败时**先看页面自己怎么说**：这里最值钱的信息是那条未捕获异常，不是「超时」。
      const diag = await js(`(()=>({ready:document.body.dataset.rocoReady??null,
        error:document.getElementById('boot-error')?.textContent?.slice(0,300)??null,
        fallback:!document.getElementById('boot-fallback')?.hidden}))()`).catch(() => null);
      results.steps.push({step: 'ready', ok: false, url: PAGE_URL, diag});
      log('✖', `页面启动失败（rocoReady=${JSON.stringify(diag?.ready ?? null)}）——`, oneLine(results.consoleErrors[0] ?? '没抓到异常', 200));
    } else {
      results.steps.push({step: 'ready', ok: true, url: PAGE_URL});
      log('✔', `页面启动 ${PAGE_URL}`);
    }

    // 进战斗：工坊选满六只 → #start-standard-pvp（与 capture-battle-evidence 同一条先例）
    let entry = {ok: false, steps: []};
    if (ready) {
      const hasMine = await js(`Boolean(document.querySelector(${JSON.stringify(WORKSHOP)})?.shadowRoot?.querySelector('#tw-scope-mine'))`);
      if (hasMine) await clickSelector(`${WORKSHOP} >>> #tw-scope-mine`);
      await sleep(500);
      for (let i = 0; i < 40; i += 1) {
        const cur = Number(await js(`document.querySelector(${JSON.stringify(WORKSHOP)})?.dataset.twSelected||'0'`));
        if (cur >= 6) break;
        const inst = await js(`(()=>{const sr=document.querySelector(${JSON.stringify(WORKSHOP)})?.shadowRoot;
          if(!sr)return null;const inTeam=new Set(window.rocoDemo?.state?.teamWorkshop?.team??[]);
          const row=[...sr.querySelectorAll('#tw-cand-list .tw-row')].find((r)=>(r.dataset.twStatus||'')==='held'&&!inTeam.has(r.dataset.twInstance));
          return row?row.dataset.twInstance:null;})()`);
        if (!inst) break;
        await clickSelector(`${WORKSHOP} >>> #tw-cand-list .tw-row[data-tw-instance="${inst}"]`);
        await sleep(300);
      }
      const teamN = Number(await js(`(window.rocoDemo?.state?.teamWorkshop?.team??[]).length`));
      entry.steps.push({step: 'workshop-six', ok: teamN === 6, team: teamN});
      const clicked = await clickSelector('#start-standard-pvp');
      entry.steps.push({step: 'click-start-standard-pvp', ok: clicked});
      const started = await waitFor(`(()=>{const p=document.getElementById('battle-panel');
        const v=window.rocoDemo?.state?.view;return Boolean(v)&&!!p&&!p.hidden&&p.getBoundingClientRect().height>0;})()`, 120, 250);
      entry.ok = Boolean(clicked && started);
      entry.steps.push({step: 'battle-visible', ok: started});
      // 战斗区没露出来时**分清是哪一种失败**：`render()` 抛异常、还是 render 跑了但面板仍旧 hidden。
      // 这一条是给施工的人看的：抛出点比「超时」有用一百倍。
      if (!started) {
        entry.diagnose = await js(`(()=>{const out={view:Boolean(window.rocoDemo?.state?.view),
          hiddenBefore:document.getElementById('battle-panel')?.hidden ?? null};
          try{window.rocoDemo.render();out.ok=true;out.hiddenAfter=document.getElementById('battle-panel')?.hidden ?? null;}
          catch(e){out.ok=false;out.error=String(e&&e.stack||e).slice(0,600);}
          const root=document.querySelector('[data-b3-root]');
          out.b3RootInPanel=Boolean(root&&root.closest('#battle-panel'));
          out.b3RootRect=root?Math.round(root.getBoundingClientRect().height):null;
          out.pendingMarkers=document.querySelectorAll('[data-b3-pending]').length;
          out.ready=document.body.dataset.rocoReady??null;
          return out;})()`).catch((e) => ({error: String(e.message)}));
        entry.steps.push({step: 'diagnose-not-visible', ok: false, ...entry.diagnose});
        log('  · 战斗区为什么没露出来：', oneLine(JSON.stringify(entry.diagnose), 320));
      }
      // 推进一回合：让战报至少有 2 个回合分组，「最新在最上」才可判
      if (started) {
        const before = Number(await js(`window.rocoDemo?.state?.view?.turn ?? 0`));
        // ① 真鼠标点 `#auto-turn`；② 点不到/没动就退回页面自己给的命名空间出口
        //    （`window.rocoDemo.autoTurn` 是页面为验收脚本显式挂出来的，不是我另写一套 DOM）。
        let how = 'click:#auto-turn';
        let advanced = await clickSelector('#auto-turn');
        let bumped = advanced ? await waitFor(`(window.rocoDemo?.state?.view?.turn ?? 0) > ${before}`, 24, 250) : false;
        if (!bumped && await js(`typeof window.rocoDemo?.autoTurn`) === 'function') {
          how = 'fallback:window.rocoDemo.autoTurn()';
          await js(`window.rocoDemo.autoTurn()`);
          bumped = await waitFor(`(window.rocoDemo?.state?.view?.turn ?? 0) > ${before}`, 40, 250);
        }
        entry.steps.push({step: 'advance-one-turn', ok: Boolean(bumped), how, from: before,
          to: Number(await js(`window.rocoDemo?.state?.view?.turn ?? 0`))});
        if (!bumped) log('○ 没能推进一回合（#auto-turn 点不到或回合没动）—— 战报可能只有 1 个回合分组');
      }
    }
    results.entry = entry;
    log(entry.ok ? '✔' : '✖', '进入战斗：', JSON.stringify(entry.steps));

    // 技能态
    const startState = await js(`document.body.dataset.b3Tab ?? null`);
    const skillFacts = await collect('skill');
    if (startState !== null) skillFacts.tab = {skill: startState};
    results.steps.push({step: 'collect-skill', ok: true, hooks: skillFacts.requiredHooks, tabs: skillFacts.tab});
    await shoot(`battle-v3-skill-${TAG}`);

    // 更换态（真鼠标点「更换」）
    const clickedSwitch = await clickTab('switch', '更换');
    const switchOk = await waitFor(`document.body.dataset.b3Tab === 'switch'`, 16, 250);
    results.steps.push({step: 'click-更换', ok: Boolean(clickedSwitch), how: clickedSwitch?.how ?? null,
      bodyTab: switchOk ? 'switch' : await js(`document.body.dataset.b3Tab ?? null`)});
    const switchClick = {how: clickedSwitch?.how ?? null, w: clickedSwitch?.w ?? null, h: clickedSwitch?.h ?? null,
      bodyTabAfter: await js(`document.body.dataset.b3Tab ?? null`)};
    const switchFacts = await collect('switch');
    switchFacts.switchRows.skillTabLastBottom = skillFacts.skills?.lastBottom ?? null;
    switchFacts.tab = {...(skillFacts.tab ?? {}), ...(switchFacts.tab ?? {})};
    if (switchFacts.tab.switch === undefined) switchFacts.tab.switch = null;
    switchFacts.tab.switchClick = switchClick;
    switchFacts.columns = switchFacts.columns?.left ? switchFacts.columns : skillFacts.columns;
    switchFacts.stage = switchFacts.stage?.resolved ? switchFacts.stage : skillFacts.stage;
    switchFacts.log = skillFacts.log;
    results.steps.push({step: 'collect-switch', ok: true});
    await shoot(`battle-v3-switch-${TAG}`);

    // 背包态（真鼠标点「物品」）
    const clickedItem = await clickTab('item', '物品');
    const itemOk = await waitFor(`document.body.dataset.b3Tab === 'item'`, 16, 250);
    results.steps.push({step: 'click-物品', ok: Boolean(clickedItem), how: clickedItem?.how ?? null,
      bodyTab: itemOk ? 'item' : await js(`document.body.dataset.b3Tab ?? null`)});
    const itemClick = {how: clickedItem?.how ?? null, w: clickedItem?.w ?? null, h: clickedItem?.h ?? null,
      bodyTabAfter: await js(`document.body.dataset.b3Tab ?? null`)};
    const itemFacts = await collect('item');
    itemFacts.tab = {...(skillFacts.tab ?? {}), ...(itemFacts.tab ?? {})};
    if (itemFacts.tab.item === undefined) itemFacts.tab.item = null;
    itemFacts.tab.itemClick = itemClick;
    itemFacts.columns = itemFacts.columns?.left ? itemFacts.columns : skillFacts.columns;
    itemFacts.stage = itemFacts.stage?.resolved ? itemFacts.stage : skillFacts.stage;
    itemFacts.log = skillFacts.log;
    results.steps.push({step: 'collect-item', ok: true});
    await shoot(`battle-v3-item-${TAG}`);

    // 回技能态（真鼠标点「技能」）
    await clickTab('skill', '技能');
    await sleep(400);

    // ── 把三态并成一份「钩子是否真的落地」的账 + 前置事实 ────────────────────
    const hookCounts = {};
    for (const h of REQUIRED_HOOKS) {
      if (h === 'body[data-b3-tab]') {
        hookCounts[h] = Object.values(skillFacts.tab ?? {}).filter((v) => v !== null && v !== undefined).length;
        continue;
      }
      hookCounts[h] = Math.max(skillFacts.requiredHooks?.[h] ?? 0, switchFacts.requiredHooks?.[h] ?? 0, itemFacts.requiredHooks?.[h] ?? 0);
    }
    const present = REQUIRED_HOOKS.filter((h) => (hookCounts[h] ?? 0) > 0);
    const absent = REQUIRED_HOOKS.filter((h) => !(hookCounts[h] > 0));
    const boot = {
      ready: await js(`document.body.dataset.rocoReady ?? null`),
      battlePanelVisible: await js(`(()=>{const p=document.getElementById('battle-panel');
        return Boolean(p)&&!p.hidden&&p.getBoundingClientRect().height>0;})()`),
      hasView: Boolean(skillFacts.engine?.hasView),
      entryOk: Boolean(entry.ok),
      consoleErrors: results.consoleErrors.length,
      firstError: results.consoleErrors[0] ?? null,
    };
    for (const facts of [skillFacts, switchFacts, itemFacts]) {
      facts.hooks = {present, absent, counts: hookCounts};
      facts.boot = boot;
    }
    results.facts = {skill: skillFacts, switch: switchFacts, item: itemFacts};
    results.steps.push({step: 'boot-facts', ok: boot.ready === 'yes', ...boot, hooks: hookCounts, absent});
    // 页面自己的「还没接上」标记（v3h 片段用 `data-b3-pending="yes"` 标静态示例数据）。
    // 它不是判据，但它是**最直接的施工清单**：还有几处是示例值、没被 JS 填。
    results.pending = skillFacts.pending ?? null;

    // ── 判据求值 ──────────────────────────────────────────────────────────
    const FACTS = {skill: skillFacts, switch: switchFacts, item: itemFacts};
    for (const check of CHECKS) {
      if (check.baselineProbe) {
        recordCheck(check, baseline, {actual: vacant.length
          ? `空判据/写坏 ${vacant.length} 条：${vacant.map((c) => c.id).join('、')}`
          : `合成基线全绿（${CHECKS.filter((c) => !c.meta).length} 条判据都在判事）`});
        continue;
      }
      recordCheck(check, FACTS[check.state] ?? skillFacts);
    }
  } finally {
    await browser.close();
  }

  // ── 报告 ────────────────────────────────────────────────────────────────
  const bootStep = results.steps.find((s) => s.step === 'boot-facts');
  const hookMatrix = bootStep?.hooks ?? {};
  const missingHooks = REQUIRED_HOOKS.filter((h) => !(hookMatrix[h] > 0));

  // 进战斗之前就挂了的话，把「为什么」写进 entry，免得只剩一个空的 steps
  if (!results.entry?.ok) {
    results.entry = {...(results.entry ?? {}),
      blocked_by: results.entry?.steps?.length ? '见 steps' : (
        results.steps.find((s) => s.step === 'ready')?.ok === false
          ? `页面没启动（body[data-rocoReady] 一直不是 "yes"）${results.consoleErrors[0] ? `；第一条报错：${oneLine(results.consoleErrors[0], 200)}` : ''}`
          : '进入战斗的流程没走通')};
  }
  const ran = results.checks.filter((c) => !c.skipped && !c.meta);
  const failed = ran.filter((c) => !c.ok);
  const skipped = results.checks.filter((c) => c.skipped);
  const hits = results.counterproofs.filter((c) => c.ok);
  const byCriterion = {};
  for (const c of results.checks) {
    const k = c.criterion;
    if (!byCriterion[k]) byCriterion[k] = {total: 0, passed: 0, failed: [], skipped: []};
    byCriterion[k].total += 1;
    if (c.skipped) byCriterion[k].skipped.push(c.id);
    else if (c.ok) byCriterion[k].passed += 1;
    else byCriterion[k].failed.push(c.id);
  }
  const report = {
    schema: 'roco-battle-v3-acceptance/v1',
    generated_by: 'scripts/roco/browser-battle-v3-acceptance.mjs',
    judged_at: new Date().toISOString(),
    page: PAGE_URL, base: BASE, viewport: TAG,
    mockup: 'docs/roco/mockups/battle-v3h.html',
    reference_image: 'docs/roco/mockups/v3h/battle-v3-default-1440x900.png',
    why: '战斗页 v3h 版式的判据 + 截图：三列几何 / 顶部信息栏 / 左竖排四格 / 更换态 / 背包态 / 右列战报 / 底部，'
      + '外加对手血条镜像。每条判据都配了**真的喂坏输入**的反证（对合成基线做单点变异）。',
    entry: results.entry,
    steps: results.steps,
    totals: {criteria: ran.length, passed: ran.length - failed.length, failed: failed.length,
      skipped: skipped.length, counterproofs: results.counterproofs.length, counterproofs_hit: hits.length},
    missing_hooks: missingHooks,
    pending_markers: results.pending,
    hook_matrix: hookMatrix,
    by_criterion: byCriterion,
    checks: results.checks,
    // 原始事实（每态一份）：判据的输入。留着是为了让「为什么红」能被自己复核，
    // 而不是只能相信一句 actual。
    facts: results.facts ?? null,
    counterproofs: results.counterproofs,
    screenshots: results.shots,
    // 切屏没生效时三张图会是**同一张**（都是技能态）—— 说出来，免得看图的人以为标错了名字。
    screenshots_note: (() => {
      const sw = results.facts?.switch?.tab?.switch; const it = results.facts?.item?.tab?.item;
      return (sw !== 'switch' || it !== 'item')
        ? `三张截图内容相同：切屏没生效（body[data-b3-tab] 在更换态=${JSON.stringify(sw)}、背包态=${JSON.stringify(it)}）`
          + '——技能/更换/物品三态拍到的都是技能态' : null;
    })(),
    console_errors: results.consoleErrors,
    build_list: failed.map((c) => ({id: c.id, criterion: c.criterion, rule: c.rule,
      actual: c.actual, problems: c.problems})),
    known_limits: [
      '**不启动服务**：它对着已经在跑的 ROCO_BASE（默认 8899）走一遍；服务没跑就整段红，所以它不进 verify:release',
      '进入战斗走的是工坊六宠 → #start-standard-pvp 这条既有主流程；这条流程若改名，entry.steps 会写清卡在哪一步',
      '「两卡轴心 == 页面中线」的量法 = 两张出战卡中心连线的中点与 documentElement 中线比较（两张并排卡不可能各自居中）',
      '可点性的信号优先级：data-b3-legal → disabled/aria-disabled → pointer-events:none → opacity<0.8；报告逐格记了用的是哪个信号',
      '「右边战报最新在上」需要 ≥2 个回合分组才可判：只有一个分组时判据记 skipped（不计入 N/M）',
      '几何锚点优先读可选钩子（data-b3-col-left/right、data-b3-stage、data-b3-fighter、data-b3-topbar、data-b3-charge、data-b3-hp-bar/fill），缺了就按结构推导，推导来源写在 derivedFrom 里',
    ],
    ok: failed.length === 0 && hits.length === results.counterproofs.length,
  };
  writeFileSync(join(OUT, 'battle-v3-acceptance.json'), `${JSON.stringify(report, null, 1)}\n`);

  log(`报告：reports/roco/battle-v3/battle-v3-acceptance.json` + (SHOTS ? `；截图 ${results.shots.length} 张` : ''));
  // 前置失败要**先说**：页面没启动/没进战斗时，下面每条判据的实际值都读不懂。
  const bootRow = results.checks.find((c) => c.id === 'page-boots');
  if (bootRow && !bootRow.ok) {
    log('✖ 前置没过（页面还没跑起来，下面的红都可能是它的后果）：');
    for (const p of bootRow.problems) log(`  · ${p}`);
    if (results.consoleErrors.length) {
      log(`  页面报错 ${results.consoleErrors.length} 条，第一条：`);
      log(`  · ${oneLine(results.consoleErrors[0], 300)}`);
    }
    if (results.entry?.blocked_by) log(`  进战斗：${results.entry.blocked_by}`);
  }
  if (results.pending?.count) {
    log(`页面自带的「未接上」标记 data-b3-pending：${results.pending.count} 处`
      + `（${(results.pending.kinds ?? []).join('、')}）—— 这些还是静态示例值，没被 view 填`);
  }
  if (missingHooks.length) {
    log(`缺钩子（${missingHooks.length}/${REQUIRED_HOOKS.length} 条）—— 施工清单：`);
    for (const h of missingHooks) log(`  · ${h}`);
  } else log(`钩子：${REQUIRED_HOOKS.length} 条全在`);
  if (failed.length) {
    log(`红的判据（${failed.length} 条，按判据分组）：`);
    for (const [k, v] of Object.entries(byCriterion)) if (v.failed.length) log(`  · ${k}：${v.failed.join('、')}`);
  }
  if (skipped.length) log(`跳过（不可判）：${skipped.map((c) => c.id).join('、')}`);
  console.log(`判据 ${report.totals.passed}/${report.totals.criteria} 通过；反证 ${report.totals.counterproofs_hit}/${report.totals.counterproofs} 命中`
    + `（另有 ${report.totals.skipped} 条不可判未计入）`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[battle-v3] 脚本自身出错：', error);
  process.exitCode = 2;
});
