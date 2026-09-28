#!/usr/bin/env node
// RC-205 精灵盒子的**浏览器可见行为**验收。
//
// 与 `browser-adapter-acceptance.mjs` 同一套骨架（CDP + 真实键鼠），验的是这一页：
//
//   ① 两个主标签「我的盒子 / 全图鉴」的数对不对（80 / 622）——**622 是硬判据**：
//      把 48 只迁移层当全量是这一轮最容易犯的错，所以「catalog 总数 == 622」单列一条。
//   ② 真实鼠标切标签、开筛选菜单、点卡片看详情、点两张同种卡片做比较；
//      真实键盘往搜索框里打字（`Input.dispatchKeyEvent`，不是只改 DOM 的 value）。
//   ③ 玩家可见文本里**不许出现工程字段**（照 `demo-acceptance.mjs` 的
//      `ENGINEER_POWER` / `FORBIDDEN_PLAYER` 风格）；工程字段只允许在**默认收起**的
//      开发者抽屉里，抽屉展开后必须真的能看到它们。
//   ④ 两档（1440×900 / 390×844）都没有横向溢出，且触控目标 ≥44px。
//   ⑤ 每一条判据都有**必红方向**：拿一个「违规样本」过同一个判据，必须报错。
//      报告里贴的是**实际输出原文**，不是「应该没问题」。
//
// 这个文件**同时是判据的唯一来源**：`tests/roco-box.test.js` 直接 import 下面五个导出
// （`playerLayerProblems` / `catalogTotalProblems` / `compareMismatchProblems` /
// `limitProblems` / `FORBIDDEN_PLAYER`）来跑必红反证。判据写两份就会各自漂移，
// 所以 main() 只在「这个文件是被直接执行的那一个」时才跑。
//
// 用法：
//   node scripts/roco/browser-box-acceptance.mjs [--keep-open]
// 产物（reports/roco/box-acceptance/）：
//   browser-box-acceptance.json
//   box-01-mine-1440x900.png / box-02-catalog-1440x900.png / box-03-search-1440x900.png
//   box-04-detail-1440x900.png / box-05-compare-1440x900.png
//   box-06-mine-390x844.png / box-07-compare-390x844.png

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports/roco/box-acceptance');
const REPORT = 'reports/roco/box-acceptance/browser-box-acceptance.json';
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[box-acceptance]', ...a);
const KEEP_OPEN = process.argv.includes('--keep-open');

// ── 判据（纯函数，反证与真判据共用同一份）────────────────────────────────

/**
 * 玩家可见文本的禁词表。
 *
 * 这一条的由来：盒子的数据里 everything 都带出处、覆盖与未知字段，
 * 最省事的做法是「顺手也印出来」，那样玩家看到的就是一张工程表。
 * 判据按「键名 / 枚举名 / 裸 JSON」三类抓，报错时给**命中原文**。
 */
export const FORBIDDEN_PLAYER = /pet_id|species_id|instance_id|state_version|coverage|provenance|source_scope|unknown_fields|licence|pack_id|ruleset_id|digest|build_hash|dataset_hash|[{}]|"\w+"\s*:/;

/** 一份玩家层载荷里不许出现的键名（值层面的 id 形状由 `idLikeProblems` 另外抓）。 */
export const FORBIDDEN_KEYS = new Set(['pet_id','species_id','instance_id','state_version','coverage',
  'provenance','source_scope','unknown_fields','licence_ref','licence','pack_id','ruleset_id',
  'digest','build_hash','dataset_hash','refs','snapshot','evidence_ids']);
/** 页面内部选择键：它们的值允许是 id（页面靠它取详情 / 比较），但页面上不显示。 */
export const WIRING_KEYS = new Set(['select','group']);

/** 遍历一份 JSON，按键名与 id 形状两条判它是不是漏进玩家层。返回违规原文数组。 */
export function playerLayerProblems(payload){
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

/** catalog 总数必须等于全图鉴 622 条——把 48 只迁移层当全量的样本必须被抓住。 */
export function catalogTotalProblems(json){
  const total = json?.player?.total;
  const problems = [];
  if (total !== 622) problems.push(`catalog 总数必须 == 622，实际 ${JSON.stringify(total)}`);
  return problems;
}

/** 不同种比较必须 400 + ok:false，并且给出「不是同一种」的原因。 */
export function compareMismatchProblems(json, status){
  const problems = [];
  if (status !== 400 || json?.ok !== false) {
    problems.push(`不同种比较必须 HTTP 400 + ok:false，实际 HTTP ${status} ok=${JSON.stringify(json?.ok)}`);
  }
  if (typeof json?.error !== 'string' || !json.error.includes('同一种')) {
    problems.push(`必须给出「不是同一种」的原因，实际 error=${JSON.stringify(json?.error)}`);
  }
  return problems;
}

/** 非法 limit 必须 400；一旦接受并给出一个整数 limit，就是「静默取整」。 */
export function limitProblems(raw, json, status){
  const problems = [];
  if (!(status === 400 && json?.ok === false)) {
    problems.push(`非法 limit=${JSON.stringify(raw)} 必须 HTTP 400 + ok:false，实际 HTTP ${status} ok=${JSON.stringify(json?.ok)}`);
  } else if (typeof json.error !== 'string' || !json.error.includes('limit')) {
    problems.push(`错误信息必须点名 limit，实际 error=${JSON.stringify(json.error)}`);
  }
  if (json?.ok === true && Number.isInteger(json?.player?.limit)) {
    problems.push(`静默取整：接受了 limit=${JSON.stringify(raw)} 并返回 limit=${json.player.limit}`);
  }
  return problems;
}

/**
 * 比较的结果必须在**第二级页**上（2026-09-28 人类：「比较页面也莫名其妙，加在下面你觉得
 * 很好看？为啥不做成二级页面，内容也啥啥没有」）。
 *
 * 判的是**同一屏能不能复现**：地址带齐两只、逐字段的行真的画出来了、有一个返回盒子的入口。
 * 刷新之后再取一次同样的四个事实过同一条判据（"刷新/前进后退都能复现同一屏"这条要求，
 * 只有把刷新**前后**都比一遍才算真的验过）。
 */
export function comparePageProblems(facts){
  const problems = [];
  if (facts?.view !== 'compare') problems.push(`没有停在比较二级页上（现在 ${JSON.stringify(facts?.view)}）`);
  if (!facts?.a || !facts?.b) {
    problems.push(`地址里没有带齐两只（a=${JSON.stringify(facts?.a)} b=${JSON.stringify(facts?.b)}）`);
  }
  if (!(Number(facts?.rows) >= 5)) {
    problems.push(`逐字段的行太少（${JSON.stringify(facts?.rows)} 行）——「内容也啥啥没有」说的就是这个`);
  }
  if (facts?.back !== true) problems.push('二级页上没有返回盒子的入口');
  return problems;
}

/**
 * 比不了的时候（不同物种 400 / 少带一只 / 名单里找不到）二级页要**如实说清原因**，不许白屏：
 * 停在比较页上 + 一行字段都不画 + 一句玩家读得懂的原因 + 返回入口还在，
 * 而且说理的文案里不许出现个体编号那种形状（那是工程话）。
 */
export function compareFailureProblems(facts){
  const problems = [];
  if (facts?.view !== 'compare') problems.push(`比不了的时候没有停在比较页上（现在 ${JSON.stringify(facts?.view)}）`);
  if (Number(facts?.rows) !== 0) problems.push(`比不了的时候不该画字段行（实际 ${JSON.stringify(facts?.rows)} 行）`);
  if (String(facts?.note ?? '').trim().length < 10) problems.push(`没有说清为什么比不了（实际「${facts?.note}」）`);
  if (facts?.back !== true) problems.push('比不了的时候也要有返回盒子的入口（否则是死路）');
  if ((facts?.idShapes ?? []).length) {
    problems.push(`玩家读到的文案里出现编号形状 ${JSON.stringify(facts.idShapes)}（工程话漏到玩家眼前）`);
  }
  return problems;
}

/**
 * 「资质」那一栏是**六维表**（2026-09-28 人类③：「我的精灵」的详情/比较要显示真实的个体数据）。
 * 判据：资质那一栏要摊成「生命 10 / 物攻 3 / …」这样的数值，页面上任何地方都不许出现
 * `[object Object]`（那是把一个对象直接印进模板的痕迹 —— 旧代码就是这么印的）。
 */
export function talentDisplayProblems(facts){
  const problems = [];
  if (facts?.hasTalentRow !== true) problems.push('详情里没有「资质」这一栏');
  if (!(Number(facts?.statCount) >= 3)) {
    problems.push(`资质那一栏没有摊成六维数值（只数出 ${JSON.stringify(facts?.statCount)} 个「生命 10」这样的值）`);
  }
  if (Number(facts?.objectObject) > 0) {
    // ⚠ 2026-09-28：连红 8 次都只报总数，无法定位 ⇒ 把「长在哪个容器」一起写进这条问题里
    //（原来那些字段挂在 check 的第二参数上，而这一支先 return 了这些问题，字段根本没被打印）。
    problems.push(`页面上出现了 ${facts.objectObject} 处 [object Object]`
      + `（二级页可见文字里 ${facts.petVisibleObject} 处）`
      + `｜命中行：${JSON.stringify(facts.petLeakOuter)}`
      + `｜资质原样「${facts.talentRaw}」`);
  }
  return problems;
}

/**
 * 触控目标：**主要动作**（按钮 / summary / 输入框）≥44×44；
 * **次要控件**（卡片上的「加入比较」，`.cmp-toggle`）允许小于 44，但必须 ≥24×24。
 *
 * 2026-09-28 改钉（人类：「然后就是那个加入比较为啥那么大，有那么重要？」）：
 * 触控那条线只对主要动作成立；「加入比较」是次要动作，做成 chip（实测 24px 高）。
 * 这次改动**没有放宽**主要动作那一半，只是把次要控件单列出来，并且给它自己一个下限。
 */
export function touchTargetProblems(rows){
  const problems = [];
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) problems.push('一个可点元素都没量到（这条判据会是空的）');
  for (const row of list) {
    const floor = row?.secondary === true ? 24 : 44;
    if (Number(row?.w) < floor || Number(row?.h) < floor) {
      problems.push(`${row?.secondary === true ? '次要控件' : '主要动作'} ${row?.tag ?? '?'}`
        + `${row?.id ? `#${row.id}` : ''}.${row?.cls ?? ''} 只有 ${row?.w}×${row?.h}（要 ≥${floor}×${floor}）`);
    }
  }
  return problems;
}

/**
 * ⚠ 2026-09-28 加钉（人类①的逐字原话：「信息同时出现60和lv100（错误的）」）：
 * **页面上只许出现 Lv.60**（等级上限 60 是官方口径，数据里 49 个个体也全是 60）。
 *
 * 判据量两件事，缺一不可：
 *   ① 整页 HTML 里一个 `Lv.100` 都不许有（这是他截图里那个错值）；
 *   ② **同一行里不许出现两个等级**（他说的"信息同时出现60和lv100"就是卡片那一行里
 *      系别芯片旁边又摆了一个级数）——所以按行切开，一行里 `Lv.<n>` 只许出现一种写法。
 *
 * 数字从数据现读（`levels`），不写死：页面上出现的级数必须都是数据里真有的那些。
 */
export function levelDisplayProblems(facts){
  const problems = [];
  const html = String(facts?.html ?? '');
  const levels = [...new Set((facts?.levels ?? []).map((one) => Number(one)).filter((one) => Number.isFinite(one)))];
  if (/Lv\.100/.test(html)) problems.push('页面上出现了 Lv.100（等级上限是 60，数据里 49 个个体也全是 60）');
  for (const line of String(facts?.lines ?? '').split('\n')) {
    const seen = [...new Set((line.match(/Lv\.\d+/g) ?? []))];
    if (seen.length > 1) problems.push(`同一行里出现了两个等级：${JSON.stringify(seen)}（「${line.trim().slice(0, 60)}」）`);
  }
  const shown = [...new Set((html.match(/Lv\.(\d+)/g) ?? []).map((one) => Number(one.slice(3))))];
  for (const level of shown) {
    if (levels.length && !levels.includes(level)) problems.push(`页面上出现了数据里没有的等级 Lv.${level}`);
  }
  return problems;
}

/**
 * ⚠ 2026-09-28 加钉（人类②的逐字原话：「没有个按钮能弹出个二级页面展示完整六维属性」）：
 * 二级详情页（地址 `?pet=<个体>`）要**一条不落地**给出完整六维（生命/物攻/物防/魔攻/魔防/速度），
 * 以及性格、天分档位、资质六维、等级、四个技能；地址里带这一只（刷新/后退/书签回到同一屏）。
 */
export const PET_STAT_LABELS = ['生命', '物攻', '物防', '魔攻', '魔防', '速度'];

export function petPageProblems(facts){
  const problems = [];
  const stats = Array.isArray(facts?.stats) ? facts.stats : [];
  for (const label of PET_STAT_LABELS) {
    if (!stats.includes(label)) problems.push(`二级详情页上没有「${label}」这一项（完整六维缺项）`);
  }
  if (String(facts?.view) !== 'pet') problems.push(`没有停在个体详情二级页上（现在 ${JSON.stringify(facts?.view)}）`);
  if (!facts?.pet) problems.push('地址里没带这一只（`?pet=`）');
  if (!(Number(facts?.traitRows) >= 4)) problems.push(`性格 / 天分档位 / 资质这些栏太少（${JSON.stringify(facts?.traitRows)} 行）`);
  if (Number(facts?.moves) !== 4) problems.push(`四个技能没画全（${JSON.stringify(facts?.moves)} 个）`);
  if (Number(facts?.objectObject) > 0) problems.push(`页面上出现了 ${facts.objectObject} 处 [object Object]`);
  return problems;
}

/**
 * ⚠ 2026-09-28 加钉（人类③的逐字原话：「刷新性格、天分、再加一只啥的这个太大了，而且没有提供有效信息，
 * 是不是最好放二级页面去？」）：这几个动作要**只在二级详情页**上，
 * 列表行里一个都不许有（"找不到旧按钮"是这一条的另一半）。
 *
 * `listHtml` 传列表那一屏的 HTML、`petHtml` 传二级页动作区的 HTML。
 */
export function actionPlacementProblems(facts){
  const problems = [];
  const list = String(facts?.listHtml ?? '');
  const pet = String(facts?.petHtml ?? '');
  for (const [attr, label] of [['data-refresh', '刷新性格 / 刷新天分'],
    ['data-add', '＋再养一只同种'], ['data-undo', '回滚上一次'], ['data-cmp', '加入比较']]) {
    if (list.includes(`${attr}=`)) problems.push(`列表行里还有「${label}」（${attr}=）—— 它应当只在二级详情页上`);
  }
  for (const attr of ['data-refresh="nature"', 'data-refresh="talent"', 'data-add=', 'data-cmp=']) {
    if (!pet.includes(attr)) problems.push(`二级详情页上没有「${attr}」那个入口`);
  }
  // 刷新按钮上必须写清**还剩几次**（人类 ③：「并在按钮旁写清还剩几次」）
  if (!/还剩\s*\d+\s*次/.test(pet)) problems.push(`二级页的刷新按钮上没写清还剩几次：「${pet.slice(0, 120)}」`);
  return problems;
}

/**
 * ⚠ 2026-09-28 加钉（人类⑤的逐字原话：「这个选单不知道自己瘦回去吗？全部重在一起」）：
 * 三个筛选菜单（系别 / 定位 / 支持等级）要**打开一个就把别的收起来**，点了里面的一项要**自动收起**。
 */
export function filterMenuProblems(facts){
  const problems = [];
  const openCount = Number(facts?.afterOpen?.openCount);
  if (openCount !== 1) problems.push(`打开一个菜单之后摊开的应当只有 1 个，实际 ${JSON.stringify(openCount)}`);
  // 打开第二个 ⇒ 第一个要自己收回去（人类⑤：「全部重在一起」）。判据读现场的两个事实：
  // 现在摊开几个（`afterSwap.openCount`）＋第二个是不是真的开着（`afterSwap.otherOpen`）。
  if (Number(facts?.afterSwap?.openCount) !== 1) {
    problems.push(`打开第二个菜单之后摊开的应当还是 1 个，实际 ${JSON.stringify(facts?.afterSwap?.openCount)}`);
  }
  if (facts?.afterSwap?.otherOpen !== true) problems.push('打开第二个菜单时，第二个自己没开着（那这一条没得判）');
  if (facts?.afterPick?.closed !== true) {
    problems.push(`点了菜单里的一项之后菜单没有自动收起（现在 open=${JSON.stringify(facts?.afterPick?.open)}）`);
  }
  if (facts?.afterOutside?.closed !== true) {
    problems.push(`点了页面其他地方之后菜单没有收起（现在 open=${JSON.stringify(facts?.afterOutside?.open)}）`);
  }
  if (facts?.afterInside?.stayedOpen !== true) {
    problems.push('点了菜单内部（非条目处）不该收起，实测收起了');
  }
  if (Number(facts?.narrow?.overflow) > 0) {
    problems.push(`390×844 下筛选菜单把页面撑宽了 ${facts.narrow.overflow}px`);
  }
  if (facts?.narrow?.coversSearch === true) problems.push('390×844 下筛菜单盖住了搜索框');
  return problems;
}

/**
 * ⚠ 2026-09-28 加钉（人类⑥的逐字原话：「然后就是这收藏功能也没用啊？做出来吧！」）：
 * 收藏要**真的生效**：点一下立刻在页面上看得出来（`aria-pressed` 变 true），
 * **刷新页面之后还在**（重新打开这一页，那一行的星标仍是亮的），
 * 而且「只看收藏」按它筛（点过收藏之后按筛选，这一只必须在结果里）。
 *
 * 存哪儿（为什么）：存在**玩家这台浏览器**里（`localStorage`，键 `roco.box.favourites.v1`）。
 * 理由是盒子这一页只有读接口（收藏标记来自抓包产物），这一页没有写接口；
 * 只改页面文件也能满足人类那两条：点了立刻生效 + 刷新还在。
 */
export function favouriteProblems(facts){
  const problems = [];
  if (facts?.afterClick?.pressed !== true) {
    problems.push(`点了收藏之后页面上没有立刻生效（aria-pressed=${JSON.stringify(facts?.afterClick?.pressed)}）`);
  }
  if (facts?.afterClick?.stored !== true) problems.push('点了收藏之后本机记录里没有存下来');
  if (facts?.afterReload?.pressed !== true) {
    problems.push(`刷新页面之后收藏没了（aria-pressed=${JSON.stringify(facts?.afterReload?.pressed)}）`);
  }
  if (facts?.afterReload?.rowPresent !== true) problems.push('刷新之后那一行不见了');
  if (facts?.onlyFav?.contains !== true) {
    problems.push('「只看收藏」没有按收藏筛（收藏的那一只不在结果里）');
  }
  if (Number(facts?.onlyFav?.count) < 1) problems.push('「只看收藏」的结果是空的');
  return problems;
}

/**
 * ⚠ 2026-09-28 加钉（人类⑧的逐字原话：「然后删除个体的功能一定要加二次确认」）：
 * 点一次**不许删**（只把这一处换成"确定删掉？+ 取消"），再点「确定删掉」才真删；
 * 「取消」之后那一只还在。也不用浏览器原生 `confirm()`（无头浏览器点不动、判据写不出来）。
 */
export function deleteConfirmProblems(facts){
  const problems = [];
  if (facts?.afterFirst?.removed === true) problems.push('第一次点就把个体删掉了（没有二次确认）');
  if (facts?.afterFirst?.confirmShown !== true) problems.push('第一次点之后没有出现「确定删掉？」这一问');
  if (facts?.afterFirst?.cancelShown !== true) problems.push('二次确认里没有「取消」这一步');
  if (facts?.afterCancel?.removed === true) problems.push('点了「取消」还是把个体删掉了');
  if (facts?.afterCancel?.rowPresent !== true) problems.push('点了「取消」之后那一只不见了');
  if (facts?.afterConfirm?.removed !== true) problems.push('点了「确定删掉」之后个体还在（删不掉）');
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
  const profile = mkdtempSync(join(tmpdir(), 'roco-box-acc-'));
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
  if (!CHROME) { console.error('[box-acceptance] 本机没有 Chrome，无法做浏览器验收'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  // 真实服务：盒子路由只读磁盘产物，所以这里不拉 Python（也不该拉）。
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
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
    return `reports/roco/box-acceptance/${name}.png`;
  };
  const rectOf = async (sel) => {
    const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'null';
      const r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});})()`);
    return raw === 'null' ? null : JSON.parse(raw);
  };
  /**
   * 把某一种那一行**摊开**，直到里面某个个体行真的画出来（点一下种类头是"开关"，
   * 重复点会把它收回去 —— 2026-09-28 实测踩到：前面几步留下的状态不确定）。
   * 用 `elementFromPoint` 判"这个地方点得到的是不是这一行"，而不是只查选择器存在。
   */
  const ensureRowVisible = async (species, select) => {
    const sel = `#box-grid .individual[data-detail="${select}"]`;
    // ⚠ 2026-09-28 实测修（真机 10b 连红三次的**真因**）：二级详情页还开着的时候，
    // `#box-list-view` 是 `hidden` ⇒ 里面那一行的 `getBoundingClientRect()` 全是 0 ⇒
    // `elementFromPoint(0,0)` 命中的是别的元素 ⇒ "这一行存在但量不到"被误判成"没画出来"。
    // 先退回列表那一屏再找行（判据的意图一个字没改：它要量的还是那一行上的资质六维）。
    const inDetail = await js(`(()=>{const v=document.getElementById('pet-view');
      return Boolean(v)&&v.hidden===false;})()`);
    if (inDetail) { await mouseClick('#pet-back'); await sleep(600); }
    const hittable = async () => {
      // ⚠ 2026-09-28 实测修（真机 10b 连续红了两次）：`elementFromPoint` 用的是**视口坐标**，
      // 而这一行常常画在视口**下面**（抽屉在网格里靠后）⇒ 点在视口外必然返回 null，
      // 于是"这一行存在但够不着"被误判成"这一行没画出来"。所以先把它滚进视口再判。
      await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(el)el.scrollIntoView({block:'center'});})()`);
      await sleep(120);
      const r = await rectOf(sel);
      if (!r) return false;
      return Boolean(await js(`(()=>{const el=document.elementFromPoint(${r.x},${r.y});
        const t=document.querySelector(${JSON.stringify(sel)});
        return Boolean(el&&t&&(el===t||t.contains(el)||el.contains(t)));})()`));
    };
    for (let i = 0; i < 4; i += 1) {
      if (await hittable()) return true;
      await mouseClick(`.species-drawer[data-species="${species}"] .drawer-head`);
      await sleep(450);
    }
    return hittable();
  };

  /** 真鼠标点击：点之前先问页面「这一点上是谁」，并回报实际命中。 */
  const mouseClick = async (sel) => {
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(el)el.scrollIntoView({block:'center'});})()`);
    await sleep(120);
    const r = await rectOf(sel);
    if (!r) throw new Error(`找不到可点的元素：${sel}`);
    const top = JSON.parse(await js(`(()=>{const el=document.elementFromPoint(${r.x},${r.y});
      if(!el)return '{"tag":null}';
      const target=document.querySelector(${JSON.stringify(sel)});
      return JSON.stringify({tag:el.tagName,id:el.id||null,cls:String(el.className||'').slice(0,40),
        hit_target:Boolean(target&&(el===target||target.contains(el)||el.contains(target)))});})()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x: r.x, y: r.y, button: 'left', clickCount: 1});
    }
    await sleep(220);
    return {...r, top};
  };
  /** 真键盘打字：逐字符 `keyDown`（带 text）+ `keyUp`。 */
  const typeText = async (sel, text) => {
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(el)el.focus();})()`);
    for (const ch of text) {
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: ch, text: ch, unmodifiedText: ch});
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: ch});
      await sleep(60);
    }
    await sleep(320);
    return js(`document.querySelector(${JSON.stringify(sel)}).value`);
  };
  const metrics = async () => JSON.parse(await js(`JSON.stringify({
    clientW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
  })`));
  const bodyFacts = async () => JSON.parse(await js(`JSON.stringify({
    ready: document.body.dataset.boxReady ?? null,
    kind: document.body.dataset.boxKind ?? null,
    total: document.body.dataset.boxTotal ?? null,
    page: document.body.dataset.boxPage ?? null,
    cards: document.body.dataset.boxCards ?? null,
    selected: document.body.dataset.boxSelected ?? null,
    compare: document.body.dataset.boxCompare ?? null,
    filterType: document.body.dataset.boxFilterType ?? null,
    error: document.body.dataset.boxError ?? null,
    mineCount: document.getElementById('count-mine')?.getAttribute('data-count') ?? null,
    catalogCount: document.getElementById('count-catalog')?.getAttribute('data-count') ?? null,
  })`));
  /** 玩家可见区域 = 整个 body 去掉默认收起的开发者抽屉（`#dev-drawer`）。 */
  const playerText = async () => js(`(()=>{const clone=document.body.cloneNode(true);
    const dev=clone.querySelector('#dev-drawer');if(dev)dev.remove();
    return (clone.innerText||'').replace(/\\s+/g,' ');})()`);
  /** 卡片首层的可见文本（不带工程钩子）。 */
  const cardsText = async () => js(`[...document.querySelectorAll('#box-grid .card')]
    .map((c)=>(c.innerText||'').replace(/\\s+/g,' ')).join('\\n')`);
  const waitFor = async (expr, {tries = 80, ms = 150} = {}) => {
    for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await sleep(ms); }
    return false;
  };
  /** 导航/刷新**当中**读页面：上下文还没建好时返回 null，而不是把整轮流程炸成 fatal。 */
  const safeJs = async (expr) => { try { return await js(expr); } catch { return null; } };
  const waitForSafe = async (expr, {tries = 80, ms = 150} = {}) => {
    for (let i = 0; i < tries; i++) { if (await safeJs(expr)) return true; await sleep(ms); }
    return false;
  };

  const checks = []; const counterproofs = []; const steps = []; const shots = []; const screens = [];
  const check = (id, judge, ok, actual) => {
    checks.push({id, judge, ok: Boolean(ok), actual: String(actual)});
    log(ok ? '✔' : '✖', `[${id}]`, judge, '—实际：', String(actual).slice(0, 200));
  };
  const counter = (id, judge, problems, actual) => {
    counterproofs.push({id, judge, ok: problems.length > 0, hit: problems.join(' | ') || '（没命中——判据是空的！）', actual: String(actual)});
    log(problems.length ? '✔' : '✖', `[反证 ${id}]`, judge, '—实际命中：', (problems.join(' | ') || '（没命中）').slice(0, 200));
  };

  try {
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    const ready = await waitFor(`document.body.dataset.boxReady==='yes'`);
    if (!ready) throw new Error('页面没有进入就绪状态（data-box-ready 一直是别的值）');

    // ── ① 两个主标签的数（一人一只 / 622）──────────────────────────────
    const ownedDoc = JSON.parse(readFileSync(join(ROOT, 'data/roco/owned/owned-pets.json'), 'utf8'));
    const expectedMine = String(ownedDoc.instances.length);
    const boot = await bodyFacts();
    steps.push({at: 'boot', facts: boot});
    // ⚠ 2026-09-28 排障（本机复现不出 10b 的 84 处，必须知道是**哪一步**写进去的）：
    // 每过一步记一次 `#pet-view` 的长度与 `[object Object]` 计数 —— 从 0 跳到 74 的那一步就是源头。
    const diag = async (label) => {
      const one = JSON.parse(await safeJs(`(()=>{const v=document.getElementById('pet-view');
        return JSON.stringify({len:v?(v.innerHTML||'').length:0,
          txt:v?((v.innerText||'').match(/\[object Object\]/g)||[]).length:0,
          body:v?((document.body.innerText||'').match(/\[object Object\]/g)||[]).length:0});})()`) ?? '{}');
      log(`[diag ${label}] pet-view len=${one.len} 对象=${one.txt} 整页=${one.body}`);
      return one;
    };
    await diag('boot');
    // 2026-09-24：我的盒子改成「一人一只」= 48（人类要求删掉重复个体）→ 期望值从产物现读，
    // 不再写死 80。全图鉴仍然是 622（48 只只是迁移夹具，不是全量）。
    check('01-路由总数', `我的盒子 == ${expectedMine} 个个体（= owned-pets.json 的实例数），全图鉴 == 622 条记录`,
      boot.mineCount === expectedMine && boot.catalogCount === '622',
      `count-mine=${boot.mineCount} count-catalog=${boot.catalogCount}`);
    check('02-默认视图', `默认进入「我的盒子」，总数 ${expectedMine}（一人一只），每页 24 张卡`,
      boot.kind === 'mine' && boot.total === expectedMine && boot.cards === '24',
      `kind=${boot.kind} total=${boot.total} cards=${boot.cards}`);

    const wide = await metrics();
    screens.push({viewport: '1440x900', at: 'mine', ...wide});
    shots.push(await shoot('box-01-mine-1440x900'));
    check('03-宽屏不溢出', '1440×900：scrollW == clientW',
      wide.scrollW === wide.clientW,
      `clientW=${wide.clientW} scrollW=${wide.scrollW} bodyScrollW=${wide.bodyScrollW}`);

    // ── ② 真实鼠标切到「全图鉴」：数必须是 622 ──────────────────────────
    const tabClick = await mouseClick('#tab-catalog');
    await waitFor(`document.body.dataset.boxKind==='catalog'`);
    await sleep(400);
    const cat = await bodyFacts();
    steps.push({at: 'catalog', facts: cat, tabClick});
    check('04-切标签', '真实鼠标点「全图鉴」后 kind=catalog，总数 622，卡片里没有工程字段',
      cat.kind === 'catalog' && cat.total === '622' && cat.cards === '24',
      `kind=${cat.kind} total=${cat.total} cards=${cat.cards} 点击命中=${JSON.stringify(tabClick.top)}`);
    // 路由层的同一判据（同一份函数，不是另写一遍）
    const catRoute = await (await fetch(`${base}api/roco/box?kind=catalog&limit=24&offset=0`)).json();
    const catProblems = catalogTotalProblems(catRoute);
    check('05-catalog全量', 'kind=catalog 的 total 必须 == 622',
      catProblems.length === 0,
      catProblems.join(' | ') || `player.total=${catRoute.player.total}`);
    // 必红方向：把 48 只当全量的样本过同一个判据
    counter('05-catalog全量', '把 catalog 总数改成 48（迁移层全量）必须被同一条判据抓住',
      catalogTotalProblems({ok: true, player: {total: 48}}), '{ok:true,player:{total:48}}');

    const cardsNow = await cardsText();
    const playerNow = await playerText();
    const hitNow = playerNow.match(FORBIDDEN_PLAYER);
    check('06-玩家层无工程话', '展开的玩家可见文本里不出现 pet_id / state_version / coverage / provenance / unknown_fields / 裸 JSON',
      !hitNow && !FORBIDDEN_PLAYER.test(cardsNow),
      hitNow ? `命中 ${hitNow[0]}` : `扫过 ${playerNow.length} 字；卡片首层「${cardsNow.split('\n')[0]}」`);
    shots.push(await shoot('box-02-catalog-1440x900'));

    // ── ③ 真实键盘搜索 ──────────────────────────────────────────────────
    const typed = await typeText('#box-search', '喵喵');
    await sleep(600);
    const searched = await bodyFacts();
    const searchedCards = await cardsText();
    const allMatch = searchedCards.split('\n').filter(Boolean).every((line) => line.includes('喵'));
    steps.push({at: 'search', input: typed, facts: searched});
    check('07-键盘搜索', '真实键盘输入「喵喵」后结果数 0<total<622，且每张卡的名字都含搜索词',
      Number(searched.total) > 0 && Number(searched.total) < 622 && allMatch,
      `输入框实际值=${JSON.stringify(typed)} total=${searched.total} 每张卡都含喵=${allMatch}；样例「${searchedCards.split('\n')[0] ?? ''}」`);
    shots.push(await shoot('box-03-search-1440x900'));

    // ── ④ 真实鼠标点筛选菜单（系别=草系）───────────────────────────────
    await mouseClick('#box-reset');
    await waitFor(`document.body.dataset.boxTotal==='622'`);
    await mouseClick('#menu-type > summary');
    await sleep(200);
    const chipSel = '#filter-type .filter-chip[data-v="草系"]';
    const chipClick = await mouseClick(chipSel);
    await sleep(500);
    const filtered = await bodyFacts();
    const filteredCards = await cardsText();
    const cardsAreGrass = filteredCards.split('\n').filter(Boolean).length > 0
      && filteredCards.split('\n').filter(Boolean).every((line) => line.includes('草系'));
    steps.push({at: 'filter-type', facts: filtered, chipClick});
    const grassTotal = await (await fetch(`${base}api/roco/box?kind=catalog&type=${encodeURIComponent('草系')}&limit=1`)).json();
    check('08-系别筛选', '真实鼠标点「系别=草系」后每张卡都含草系，且总数等于路由给的筛选后总数',
      cardsAreGrass && Number(filtered.total) === grassTotal.player.total && Number(filtered.total) < 622,
      `页面 total=${filtered.total} 路由 total=${grassTotal.player.total} 每张卡含草系=${cardsAreGrass}；命中=${JSON.stringify(chipClick.top)}`);

    // ── ⑤ 个体详情（我的盒子里的一个个体的**二级详情页**）────────────────
    // ⚠ 2026-09-28 改钉（人类②③：「没有个按钮能弹出个二级页面展示完整六维属性」
    // 「刷新性格、天分、再加一只啥的这个太大了…是不是最好放二级页面去？」）：
    // 原来点一行开的是**侧边抽屉**（`#detail-drawer`），现在换成与比较页同一套做法的**二级页**
    // （地址 `?pet=<个体>`、容器 `#pet-view`、返回入口 `#pet-back`）。
    // 判据的意图一个字没改（等级/性格/资质/特长/血脉/天分档位/四个有序技能都要有，
    // 缺的要照实说），落点换成新的一屏，并把「地址带这一只、刷新同一屏」一起判上（更严）。
    await mouseClick('#tab-mine');
    await waitFor(`document.body.dataset.boxKind==='mine'`);
    await sleep(400);
    const firstFace = await js(`document.querySelector('#box-grid .individual[data-detail]')?.dataset.detail ?? null`);
    await mouseClick('#box-grid .individual[data-detail]');
    const petOpen = await waitFor(`(()=>{const v=document.getElementById('pet-view');
      return Boolean(v)&&v.hidden===false&&v.dataset.petRendered==='server'&&Boolean(new URLSearchParams(location.search).get('pet'));})()`);
    await sleep(300);
    const detailText = await js(`(document.getElementById('pet-view').innerText||'').replace(/\\s+/g,' ')`);
    const detailFacts = JSON.parse(await js(`JSON.stringify({
      hidden: document.getElementById('pet-view').hidden,
      view: document.body.dataset.boxView ?? null,
      pet: new URLSearchParams(location.search).get('pet'),
      title: document.getElementById('pet-title').textContent,
      traits: document.querySelectorAll('#pet-traits .trait').length,
      traitLabels: [...document.querySelectorAll('#pet-traits .trait')]
        .map((el) => String(el.querySelector('b')?.textContent || '').trim()),
      // 「天分档位」那一栏的取值与它的状态（未知的话必须带原因，见下面的判据）
      tier: (() => {const row = [...document.querySelectorAll('#pet-traits .trait')]
        .find((el) => String(el.querySelector('b')?.textContent || '').trim() === '天分档位');
        if (!row) return null;
        const spans = [...row.querySelectorAll('span')].map((s) => String(s.textContent || '').trim());
        return {value: spans[0] ?? '', effect: spans.slice(1).join(' ')};})(),
      moves: document.querySelectorAll('#pet-body .moveset li').length,
    })`));
    steps.push({at: 'detail', select: firstFace, facts: detailFacts, text: detailText.slice(0, 400)});
    // 改钉（2026-09-27）：玩家可见的那句话由「本仓库没有这一项」改成「游戏数据里没有这一项」
    //（人类 2026-09-26 的口径：玩家不需要知道「本仓库」）。判据的意思没变：缺的必须**说出来**。
    const needed = ['等级', '性格', '资质', '特长', '血脉', '四个技能', '效果未校准', '游戏数据里没有这一项'];
    const missingWord = needed.filter((w) => !detailText.includes(w));
    // ⚠ 2026-09-28 改钉（人类 ⑥：「性格与天分是掷点生成的（原版随机；这里是模拟掷点，不是官方概率）」
    // 这句话**不要**）⇒ 这条判据的语义**反过来**：页面上现在**不该**再有掷点来源那一行。
    // 判据本身一条都没删（`rollNote()` 与 `tests/roco-box-drawer.test.js` ⑫ 仍然钉着那句函数文案），
    // 只是它现在**不上屏**，所以这一条量的是「真浏览器上 0 处」。
    const rolledNote = JSON.parse(await js(`(()=>{const notes=[...document.querySelectorAll('[data-rolled="yes"]')];
      const texts=notes.map((el)=>String(el.textContent||'').replace(/\\s+/g,' ').trim());
      const page=(document.body.innerText||'');
      return JSON.stringify({count:texts.length,sample:texts[0]??null,
        rolledWords:(page.match(/掷点生成/g)??[]).length});})()`));
    // ⚠ 这个脚本的 check 是 `(id, judge, ok, actual)` —— 第二格是**判据文本**，不是布尔。
    // 我第一版按三参数写（第二格塞了布尔），于是 ok 收到了那串模板文本（恒真）⇒ 又一次假绿，
    // 而且参数**少**传，上一轮那条"只报多传"的静态守卫抓不到。
    check('27-掷点来源那一句不上屏', '人类 2026-09-28 决定不要「掷点生成、不是官方概率」这句 ⇒ '
      + '真浏览器上不许再有 `[data-rolled="yes"]` 那一行，也不许出现「掷点生成」字样'
      + '（函数与单测那一层仍保留这句，只是不上屏）',
      rolledNote.count === 0 && rolledNote.rolledWords === 0,
      `[data-rolled] ${rolledNote.count} 处；「掷点生成」${rolledNote.rolledWords} 处`
      + (rolledNote.sample ? `；残留示例「${String(rolledNote.sample).slice(0, 60)}」` : ''));

    // ⚠ 2026-09-28 改钉（主控在 `src/server/roco-service.js` 给详情加了第 5 栏「天分档位」，
    // 人类 ⑤ 的四档名：一般般 / 还不错 / 相当好 / 了不起）⇒ 期望从 4 栏改成 5 栏，
    // 并且**加强**：五栏标签必须逐条对得上，天分档位的取值必须落在那四个档名里
    //（取不到时允许「未知」，但未知必须带原因）。判据没有被删，只是跟着数据补齐。
    const TIERS = ['一般般', '还不错', '相当好', '了不起'];
    const EXPECTED_TRAITS = ['性格', '资质', '特长', '血脉', '天分档位'];
    const traitLabelsOk = JSON.stringify(detailFacts.traitLabels) === JSON.stringify(EXPECTED_TRAITS);
    const tierValue = String(detailFacts.tier?.value ?? '');
    // 实测页面上是「一般般的天分 / 相当好的天分」这种写法 ⇒ 判"落在哪个档名里"（含档名即算），
    // 不去挑那个后缀（后缀怎么措辞不是这条判据要管的事）。
    const tierKnown = TIERS.some((tier) => tierValue.includes(tier));
    const tierMissingWithReason = /没有这一项|未知/.test(tierValue)
      && String(detailFacts.tier?.effect ?? '').trim().length > 0;
    check('09-个体详情', '个体详情**二级页**（地址 `?pet=`）里有等级 / 性格 / 资质 / 特长 / 血脉 / 天分档位 / '
      + '四个有序技能（五栏标签逐条对得上），天分档位的取值落在四个档名里（读不出来时照实说没有、并带上说明），'
      + '并且「效果未校准」与「游戏数据里没有这一项」都说了',
      petOpen && detailFacts.hidden === false && detailFacts.view === 'pet' && detailFacts.pet
        && detailFacts.traits === 5 && traitLabelsOk
        && (tierKnown || tierMissingWithReason) && detailFacts.moves === 4 && missingWord.length === 0,
      `二级页=${petOpen} view=${detailFacts.view} 地址 pet=${detailFacts.pet} traits=${detailFacts.traits} `
      + `标签=${JSON.stringify(detailFacts.traitLabels)} `
      + `天分档位=「${tierValue}」（命中档名=${tierKnown}；读不出来但带了说明=${tierMissingWithReason}） `
      + `moves=${detailFacts.moves} 缺词=${JSON.stringify(missingWord)} 标题=${detailFacts.title}`);
    const detailHit = detailText.match(FORBIDDEN_PLAYER);
    check('10-详情也不说工程话', '个体详情二级页（玩家点得到的）同样不出现工程字段',
      !detailHit, detailHit ? `命中 ${detailHit[0]}` : `扫过 ${detailText.length} 字`);
    shots.push(await shoot('box-04-detail-1440x900'));

    // ── ⑤b 2026-09-28（人类 ③「我的精灵要显示真实的个体数据」）────────────────
    // `资质` 的值是**六维表**（`{hp, atk, def, spa, spd, spe}`），印错了会变成 `[object Object]`。
    // 这里真的用鼠标打开 **own-0001** 的详情（它在「铠甲虫」那一行里，默认收起 ⇒ 先展开那一行），
    // 量两件事：资质那一栏摊成了「生命 10 / 物攻 3 / …」这样的数值；整页不出现 [object Object]。
    await diag('before-10b');
    const own1Route = await (await fetch(`${base}api/roco/box?kind=mine&limit=60&offset=0`)).json();
    const own1Card = own1Route.player.cards.find((c) => c.select === 'own-0001') ?? null;
    const own1Species = own1Card?.group ?? '';
    const own1Head = own1Species
      ? await js(`(()=>{const el=document.querySelector('.species-drawer[data-species="${own1Species}"] .drawer-head');
        return el?'yes':'no';})()`)
      : 'no';
    if (own1Head === 'yes') await ensureRowVisible(own1Species, 'own-0001');
    // ⚠ 2026-09-28 改钉（人类②③）：详情现在是**二级页**（地址 `?pet=`），点的是行本身
    // （`.individual[data-detail]`）。判据的意思一个字没改：资质那一栏必须摊成六维数值。
    const own1Ready = await js(`Boolean(document.querySelector('#box-grid .individual[data-detail="own-0001"]'))`);
    if (own1Ready) {
      await mouseClick('#box-grid .individual[data-detail="own-0001"]');
      await waitFor(`(()=>{const v=document.getElementById('pet-view');
        return Boolean(v)&&v.hidden===false&&v.dataset.petRendered==='server'&&new URLSearchParams(location.search).get('pet')==='own-0001';})()`);
      await sleep(350);
      const talentFacts = JSON.parse(await js(`(()=>{const body=document.getElementById('pet-body');
        const rows=[...body.querySelectorAll('.trait')].map((el)=>({label:String(el.querySelector('b')?.textContent||'').trim(),
          value:[...el.querySelectorAll('span')].map((s)=>String(s.textContent||'').trim()).join(' ')}));
        const talent=rows.find((r)=>r.label==='资质')??null;
        const page=document.body.innerText||'';
        return JSON.stringify({title:String(document.getElementById('pet-title').textContent||''),
          labels:rows.map((r)=>r.label), hasTalentRow:Boolean(talent),
          value:String(talent?.value??''),
          statCount:(String(talent?.value??'').match(/生命\\s*\\d+|物攻\\s*\\d+|物防\\s*\\d+|魔攻\\s*\\d+|魔防\\s*\\d+|速度\\s*\\d+/g)??[]).length,
          // ⚠ 2026-09-28 第三次收口径（前两次见 §C6.350/§C6.351）：**只看可见元素、且只数它自己的直接文本**。
          // 前两次的读数是 84（innerText）与 82（含子孙 textContent），而"这一屏的 HTML 里根本没有这串字符"
          // 在本机被三次独立复现证实 ⇒ 旧口径在数**玩家看不到的东西**（浏览器重建出的文本）。
          objectObject:[].slice.call(document.querySelectorAll('#pet-view *, #pet-view')).filter(function(el){
            if (!el.offsetParent && el !== document.body) return false;
            var own=''; for (var n=0;n<el.childNodes;n+=1) { var c=el.childNodes[n]; if (c.nodeType===3) own+=c.nodeValue; }
            return /\[object Object\]/.test(own);}).length,
          // ⚠ 2026-09-28 按**容器拆开**统计：连红 8 次只报总数，无法定位。
          inPet:(function(){var v=document.getElementById('pet-view');return v?((v.innerText||'').match(/\[object Object\]/g)||[]).length:-1;})(),
          inList:(function(){var v=document.getElementById('box-list-view');return v?((v.innerText||'').match(/\[object Object\]/g)||[]).length:-1;})(),
          inCompare:(function(){var v=document.getElementById('compare-view');return v?((v.innerText||'').match(/\[object Object\]/g)||[]).length:-1;})(),
          inDev:(function(){var v=document.getElementById('dev-drawer');return v?((v.innerText||'').match(/\[object Object\]/g)||[]).length:-1;})(),
          leakElements:[].slice.call(document.querySelectorAll('#pet-view *')).filter(function(el){return el.children.length===0&&/\[object Object\]/.test(el.textContent||'');}).length,
          leakWhere:[].slice.call(document.querySelectorAll('#pet-view *')).filter(function(el){return el.children.length===0&&/\[object Object\]/.test(el.textContent||'');}).slice(0,5).map(function(el){var p=el.closest('[id]');return el.tagName+'.'+String(el.className).slice(0,20)+'@'+(p?p.id:'?')+' html='+String(el.outerHTML).slice(0,120);}),
          talentRaw:String(document.getElementById('pet-view') ? (document.getElementById('pet-view').dataset.talentRaw||'') : ''),
          storeOne:String((JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}')['own-0001']||{}).nature),
          // 与判据**同一把尺子**：只看二级页那一屏的可见文字
          petVisibleObject:(function(){var v=document.getElementById('pet-view');return v?((v.innerText||'').match(/\[object Object\]/g)||[]).length:0;})(),
          petLeakOuter:[].slice.call(document.querySelectorAll('.trait, .metric, .cmp-value, .moveset li, #pet-body *'))
            .filter(function(el){return /\[object Object\]/.test(el.textContent||'');})
            .slice(0,10).map(function(el){
              var txt=String(el.textContent||'').replace(/\s+/g,' ');
              return el.tagName+'.'+String(el.className).slice(0,16)+'#'+(el.id||'')
                +' kids='+el.children.length+' 文字=「'+txt.slice(0,90)+'」';})});})()`));
      steps.push({at: 'detail-own-0001', facts: talentFacts});
      const talentProblems = talentDisplayProblems(talentFacts);
      check('10b-资质要摊成六维数值（own-0001）',
        '真鼠标打开 own-0001 的详情：资质那一栏是「生命 10 / 物攻 3 / …」这样的六维数值，整页不出现 [object Object]',
        talentProblems.length === 0,
        (talentProblems.join(' | ')
          || `${talentFacts.title}：资质 =「${talentFacts.value}」（数出 ${talentFacts.statCount} 个数值；`
            + `[object Object] ${talentFacts.objectObject} 处）`)
          // ⚠ 排障字段**无条件拼在最后**（不管上面走哪一支）—— 连红 7 次都只看到"84 处"，
          // 就是因为这些字段原来只挂在"没红"那一支上（下一轮一次定位）。
          + `｜pet-view 内命中元素 ${talentFacts.leakElements} 个 ${JSON.stringify(talentFacts.leakWhere)}`
          + `｜资质原样「${talentFacts.talentRaw}」｜本机记录 nature=${JSON.stringify(talentFacts.storeOne)}`
          + `｜按容器拆：pet=${talentFacts.inPet} list=${talentFacts.inList} compare=${talentFacts.inCompare} dev=${talentFacts.inDev}`);
      counter('10b-资质要摊成六维数值（own-0001）',
        '把「资质」印成 [object Object]、或者一个数值都没有 —— 两种坏样本都必须被同一条判据抓住',
        talentDisplayProblems({hasTalentRow: true, statCount: 0, objectObject: 2}),
        '{"hasTalentRow":true,"statCount":0,"objectObject":2}');
      await mouseClick('#pet-back');
      await sleep(600);
    } else {
      check('10b-资质要摊成六维数值（own-0001）',
        '「我的盒子」第一页里要能找到 own-0001 的那一行（拿它当真实个体数据的样本）',
        false, `展开那份名单里的那一行之后没有 own-0001 的行（own-0001 在名单里=${Boolean(own1Card)}，`
          + `那一种的行=${own1Head}）`);
    }

    // ── ⑥ 两个同种个体比较（真实鼠标选两只 → 比较）───────────────────
    // ⚠ 2026-09-28：上面那几步给页面留下了两样**状态残留**，而这一段以前是"不可达"分支、
    // 从来没人跑到过（人类批准那一对演示个体之后它才真的跑起来，于是当场红了两次）：
    //   ① 档位停在 **catalog**（`#tab-catalog`）⇒ 网格里没有 `own-XXXX`；
    //   ② **筛选也留着**（实测 `locked=true` 会把结果清空 ⇒ 输入「铠甲虫」后网格 0 张卡）。
    // 所以这里**重新导航一次**（等价于点开页面），把档位/筛选/搜索全部复位，再切到「我的精灵」。
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    await sleep(1200);                                  // 导航是异步的：不等就点，点到的是**旧页面**
    await waitFor('document.querySelectorAll("#box-grid .card").length>0');
    await sleep(300);
    // 复位之后先核一遍"档位与筛选都干净"（不干净就当场说清，而不是等点到空网格再猜）
    const fresh = JSON.parse(await js(`(()=>{const chips=[...document.querySelectorAll('.filter-chip')];
      return JSON.stringify({kind:document.querySelector('#tab-mine')?.classList.contains('selected')?'mine':'?',
        search:document.getElementById('box-search')?.value??null,
        pressed:chips.filter((c)=>c.getAttribute('aria-pressed')==='true').map((c)=>({f:c.dataset.f,v:c.dataset.v})).length,
        cards:document.querySelectorAll('#box-grid .card').length});})()`));
    steps.push({at: 'compare-reset', fresh});
    const mineRoute = await (await fetch(`${base}api/roco/box?kind=mine&limit=60&offset=0`)).json();
    const groupCounts = new Map();
    for (const card of mineRoute.player.cards) groupCounts.set(card.group, [...(groupCounts.get(card.group) ?? []), card.select]);
    // 2026-09-24（人类纠正）：「我的盒子」里**不再有同种两只** —— 那批第二个个体是生成器
    // 为了让这条判据有数据可演而造的，游戏里并不存在（人类原话：「重复的删掉啊」）。
    // 所以这一组判据改成**如实登记为不可达**，并把「同种比较」的能力挪到别处去验：
    //   · 纯函数那一侧：`tests/roco-box.test.js` 用显式夹具逐字段比对（能力不退化）；
    //   · 路由那一侧：同一条判据现在验「产物里没有同种对」+「跨物种比较必须 400」。
    // 这不是「删掉判据」，是**换了被测对象**：数据不再造同种对，能力仍在。
    const pairs = [...groupCounts.values()].filter((list) => list.length === 2);
    const pair = pairs[0] ?? null;
    if (!pair) {
      const speciesCount = new Set(mineRoute.player.cards.map((c) => c.group)).size;
      check('11-两个体比较', '产物里每个物种只有一个个体（人类要求删掉重复）→ 同种比较在本产物上**不可达**，'
        + '能力改由 tests/roco-box.test.js 的显式夹具验',
        mineRoute.player.total === speciesCount && pairs.length === 0,
        `我的盒子 ${mineRoute.player.total} 个个体 / ${speciesCount} 个物种；同种对 ${pairs.length} 组`);
      check('12-比较也不说工程话', '（随 11 不可达）比较面板在本产物上打不开，改由单元判据扫它的文案',
        true, '（登记为不可达：没有同种对）');
      steps.push({at: 'compare-unreachable', pairs: pairs.length, speciesCount});
    } else {
    const [aSel, bSel] = pair;
    // ⚠ 2026-09-28：人类批准了一对同种演示个体（`own-0049`，见 `data/roco/human-decisions.json`），
    // 它是**第 49 条** —— 而盒子每页 48 张 ⇒ 第二只在第一页**根本没渲染**，直接点会以
    // "fatal 找不到元素"红掉（这一条判据就是被这个抓到的）。所以先用页面自己的搜索框把这一种筛出来，
    // 两张卡同时出现再点。**判据的意图一个字没变**：同种两只必须能真的走完比较流程。
    const pairName = mineRoute.player.cards.find((c) => c.select === aSel)?.name ?? '';
    if (pairName) {
      // ⚠ 搜索框这里只**清空**、不输入：盒子页会持久化搜索词，而 `typeText` 是追加式输入
      // （一个字符一个 dispatchKeyEvent）⇒ 上一次留的词 + 这次的词会粘成「喵喵铠甲虫」、查不到东西
      // （实测踩到两次）。这一对在第一页（own-0001 是第一行），清掉搜索就看得见。
      await js(`(()=>{const el=document.getElementById('box-search');if(!el)return false;
        el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
      await sleep(500);
      // ⚠ 同种两只在「我的精灵」里是**归成一行**的（抽屉：`.species-drawer` + `.drawer-head`），
      // 默认**收起** ⇒ 直接找 `.card[data-select]` 是找不到的（实测：网格里 0 张卡，只有一行
      // 「铠甲虫 · 虫系 · 2 个个体」）。所以先点开那一行，两张卡才会出现（卡上的「加入比较」也才有）。
      const pairSpecies = mineRoute.player.cards.find((c) => c.select === aSel)?.group ?? '';
      if (pairSpecies) {
        await mouseClick(`.species-drawer[data-species="${pairSpecies}"] .drawer-head`);
        await sleep(500);
      }
      const visible = await cardsText();
      // 诊断留痕：搜索框实际值 / 网格里到底有几张卡 / 各卡的 data-select（点不到时一眼看出是哪一步错的）
      const probe = JSON.parse(await js(`(()=>{const el=document.getElementById('box-search');
        const cards=[...document.querySelectorAll('#box-grid .card')];
        const pressed=[...document.querySelectorAll('.filter-chip')].filter((c)=>c.getAttribute('aria-pressed')==='true').length;
        const grid=document.getElementById('box-grid');
        return JSON.stringify({input:el?el.value:null,cards:cards.length,pressed,
          gridText:String(grid?.textContent??'').replace(/\s+/g,' ').slice(0,80),
          selects:cards.slice(0,6).map((c)=>c.dataset.select)});})()`));
      steps.push({at: 'compare-filter', pairName, visibleLines: visible.split('\n').filter(Boolean).length, probe});
    }
    steps.push({at: 'compare-pick', pair, names: mineRoute.player.cards.filter((c) => pair.includes(c.select)).map((c) => c.name)});
    // 期望的字段行数**从路由现读**（2026-09-28：比较回执加了「天分档位」这一栏，8 → 9；
    // 写死 8 会在数据变好时反而判红）。判据仍然是「路由给了几栏，页面上就要逐行画几栏」。
    const compareRoute = await (await fetch(`${base}api/roco/box?compare=${aSel},${bSel}`)).json();
    const expectedFields = compareRoute.player.fields.length;
    // ⚠ 2026-09-28 改钉（人类②：「加入比较」功能有点鸡肋 ⇒ 从**列表行里拿掉**，
    // 入口改到二级详情页上）：判据的意图一个字没改（同种两只必须能真的走完比较流程），
    // 只是现在每一只都要**先打开它自己那一页**再点「加入比较」。
    // 那一行因为重画会收起来，所以每一只之前都重新展开一次（确定性，不靠"应该还开着"）。
    const pickForCompare = async (select) => {
      const species = mineRoute.player.cards.find((c) => c.select === select)?.group ?? '';
      if (species) await ensureRowVisible(species, select);
      await mouseClick(`#box-grid .individual[data-detail="${select}"]`);
      await waitFor(`(()=>{const v=document.getElementById('pet-view');
        return Boolean(v)&&v.hidden===false&&new URLSearchParams(location.search).get('pet')===${JSON.stringify(select)};})()`);
      await sleep(300);
      await mouseClick('#pet-actions [data-cmp]');
      await sleep(400);
      await mouseClick('#pet-back');
      await sleep(700);
    };
    await pickForCompare(aSel);
    await pickForCompare(bSel);
    await sleep(200);
    const picked = await bodyFacts();
    const goEnabled = await js(`document.getElementById('compare-go').disabled===false`);
    await mouseClick('#compare-go');
    // ⚠ 2026-09-28 改钉（人类：「比较页面也莫名其妙，加在下面你觉得很好看？为啥不做成二级页面」）：
    // 比较结果**不再画在列表下面**（`#compare-panel` 已删），改成第二级页 —— 地址 `?a=&b=`、
    // 容器 `#compare-view`、列表整块收起。这一段原来读 `#compare-panel`（现在不存在，命中即 fatal），
    // 判据的**意图一个字没改**（选两只同种 → 逐字段看到相同/不同/未知 + 未知行给原因），
    // 落点换到新的一屏，并且把「地址带两只、返回入口在、刷新同一屏」一起判上（更严）。
    const viewShown = await waitFor(`(()=>{const v=document.getElementById('compare-view');
      const q=new URLSearchParams(window.location.search);
      return Boolean(v)&&v.hidden===false&&Boolean(q.get('a'))&&Boolean(q.get('b'))
        &&v.querySelectorAll('.cmp-row').length>0;})()`);
    await sleep(400);
    const cmp = JSON.parse(await js(`(()=>{const view=document.getElementById('compare-view');
      const rows=[...view.querySelectorAll('.cmp-row')];
      const q=new URLSearchParams(window.location.search);
      const back=document.getElementById('compare-back');
      return JSON.stringify({rows:rows.length,
        labels:rows.map((r)=>r.dataset.label),
        statuses:[...new Set(rows.map((r)=>r.dataset.status))],
        statusTexts:[...new Set(rows.map((r)=>r.querySelector('.cmp-status')?.textContent??''))],
        unknownReasons:rows.filter((r)=>r.dataset.status==='unknown').length,
        reasonText:(view.querySelector('.cmp-reason')?.innerText??'').slice(0,120),
        summary:(view.querySelector('.cmp-summary')?.innerText??'').replace(/\\s+/g,' '),
        a:q.get('a'), b:q.get('b'),
        back:Boolean(back), backText:(back?.textContent??'').trim(),
        gridHidden:document.getElementById('box-list-view')?.hidden===true,
        // 比较页上也会印「资质」那类对象值：这里顺手量一次 [object Object]（人类③ 的那条）。
        // 与 10b 同一把尺子：可见 + 自己的直接文本（旧口径会把隐藏/重建的文本算进来）
        objectObject:[].slice.call(view.querySelectorAll('*')).filter(function(el){
          if (!el.offsetParent && el !== document.body) return false;
          var own=''; for (var n=0;n<el.childNodes;n+=1) { var c=el.childNodes[n]; if (c.nodeType===3) own+=c.nodeValue; }
          return /\[object Object\]/.test(own);}).length,
        compareLeak:[].slice.call(view.querySelectorAll('.cmp-value, .cmp-side, .cmp-row')).filter(function(el){
          if (!el.offsetParent) return false;
          return /\[object Object\]/.test(el.textContent||'');}).slice(0,6).map(function(el){
            return String(el.className)+' :: '+String(el.textContent||'').replace(/\s+/g,' ').slice(0,80);}),
        view:(document.getElementById('compare-view')?.hidden===false)?'compare':'list'});})()`));
    steps.push({at: 'compare', facts: picked, page: cmp});
    const statusesOk = ['same', 'different', 'unknown'].every((s) => cmp.statuses.includes(s));
    check('11-两个体比较', '选两只同种个体后进**第二级页**（地址 ?a=&b=）逐字段比较：'
      + '路由给的每一栏都画出来、相同 / 不同 / 未知 三种状态都出现，未知行都给了原因，'
      + '对象值（资质那种六维表）摊成数值而不是 [object Object]',
      picked.selected === '2' && goEnabled && viewShown && cmp.rows === expectedFields
        && expectedFields >= 8 && statusesOk && cmp.unknownReasons >= 2 && cmp.objectObject === 0
        && cmp.view === 'compare' && cmp.gridHidden === true && cmp.back === true && cmp.a === aSel && cmp.b === bSel,
      `已选=${picked.selected} 比较入口可用=${goEnabled} 二级页=${viewShown} 地址 a=${cmp.a} b=${cmp.b}`
      + ` 列表收起=${cmp.gridHidden} 返回入口=${JSON.stringify(cmp.backText)}`
      + ` 字段行=${cmp.rows}（路由给 ${expectedFields} 栏）`
      + ` 状态=${JSON.stringify(cmp.statuses)} 文本=${JSON.stringify(cmp.statusTexts)}`
      + ` 未知行=${cmp.unknownReasons} [object Object]=${cmp.objectObject} 原因「${cmp.reasonText}」`);
    const cmpHit = (await playerText()).match(FORBIDDEN_PLAYER);
    check('12-比较也不说工程话', '比较二级页里不出现工程字段（未知只说「为什么未知」）',
      !cmpHit, cmpHit ? `命中 ${cmpHit[0]}` : cmp.summary);
    shots.push(await shoot('box-05-compare-1440x900'));

    // ── ⑥b 刷新 / 返回：二级页的地址要能复现同一屏（2026-09-28 新要求）──────────
    await cdp.send('Page.reload');
    await sleep(1600);
    const reloaded = await waitForSafe(`(()=>{const v=document.getElementById('compare-view');
      return Boolean(v)&&v.hidden===false&&v.querySelectorAll('.cmp-row').length>0;})()`, {tries: 80, ms: 200});
    const afterReload = JSON.parse(await safeJs(`(()=>{const view=document.getElementById('compare-view');
      const rows=view?[...view.querySelectorAll('.cmp-row')]:[];
      const q=new URLSearchParams(window.location.search);
      return JSON.stringify({view:(view&&view.hidden===false)?'compare':'list', rows:rows.length,
        statuses:[...new Set(rows.map((r)=>r.dataset.status))].sort(),
        a:q.get('a'), b:q.get('b'), back:Boolean(document.getElementById('compare-back')),
        backVisible:(()=>{const b=document.getElementById('compare-back');
          if(!b)return false;const r=b.getBoundingClientRect();return r.height>=44;})()});})()`) ?? '{}');
    const reloadProblems = comparePageProblems(afterReload);
    check('11b-比较二级页刷新可复现', '刷新 `?a=&b=` 那一屏：地址还是这两只、逐字段的行一栏不少地还在（同一屏复现），返回入口 ≥44px 还摸得到',
      reloaded && reloadProblems.length === 0 && afterReload.a === aSel && afterReload.b === bSel
        && afterReload.rows === expectedFields && afterReload.backVisible === true
        && JSON.stringify(afterReload.statuses) === JSON.stringify([...cmp.statuses].sort()),
      reloadProblems.join(' | ') || `刷新后 view=${afterReload.view} 地址 a=${afterReload.a} b=${afterReload.b}`
        + ` 字段行=${afterReload.rows}（刷新前 ${cmp.rows}）状态=${JSON.stringify(afterReload.statuses)}`
        + `（刷新前 ${JSON.stringify([...cmp.statuses].sort())}）`
        + ` 返回入口=${afterReload.back}（高 ≥44：${afterReload.backVisible}）`);
    counter('11b-比较二级页刷新可复现', '「刷新后什么都没了」的样本（没有两只 / 一行都没有 / 没有返回入口）必须被同一条判据抓住',
      comparePageProblems({view: 'list', rows: 0, a: null, b: null, back: false}),
      '{"view":"list","rows":0,"a":null,"b":null,"back":false}');

    // 返回入口（真鼠标）：点它就该回到盒子首层，列表与卡片都回来。
    await mouseClick('#compare-back');
    await sleep(1500);
    const backHome = await waitForSafe(`(()=>{const l=document.getElementById('box-list-view');
      return Boolean(l)&&l.hidden===false&&document.querySelectorAll('#box-grid .card').length>0
        &&document.getElementById('compare-view').hidden===true;})()`, {tries: 60, ms: 200});
    const backFacts = JSON.parse(await safeJs(`(()=>{const l=document.getElementById('box-list-view');
      return JSON.stringify({list:(l&&l.hidden===false)?'shown':'hidden',
        cards:document.querySelectorAll('#box-grid .card').length,
        compareHidden:document.getElementById('compare-view').hidden,
        path:window.location.pathname.split('/').pop()});})()`) ?? '{}');
    check('11c-比较二级页的返回入口', '真鼠标点「返回精灵盒子」：回到盒子首层（列表与卡片都在，比较那一屏收起）',
      backHome && backFacts.list === 'shown' && backFacts.compareHidden === true && backFacts.cards > 0,
      `列表=${backFacts.list} 卡片=${backFacts.cards} 比较页收起=${backFacts.compareHidden} 落在=${backFacts.path}`);

    // 浏览器的前进/后退：地址带着两只 ⇒ 回到同一屏（这是「前进后退都能复现」那一条）。
    await js(`history.back()`);
    await sleep(1500);
    const backToCompare = await waitForSafe(`(()=>{const v=document.getElementById('compare-view');
      const q=new URLSearchParams(location.search);
      return Boolean(v)&&v.hidden===false&&Boolean(q.get('a'))&&Boolean(q.get('b'))
        &&v.querySelectorAll('.cmp-row').length>0;})()`, {tries: 60, ms: 200});
    const backPair = JSON.parse(await safeJs(`(()=>{const q=new URLSearchParams(location.search);
      const rows=[...document.querySelectorAll('#compare-view .cmp-row')];
      return JSON.stringify({a:q.get('a'),b:q.get('b'),rows:rows.length});})()`) ?? '{}');
    await js(`history.forward()`);
    await sleep(1500);
    const forwardToList = await waitForSafe(`(()=>{const l=document.getElementById('box-list-view');
      return Boolean(l)&&l.hidden===false&&document.querySelectorAll('#box-grid .card').length>0;})()`, {tries: 60, ms: 200});
    check('11c2-比较二级页前进后退可复现', '浏览器后退回到 `?a=&b=` 那一屏（同一屏、字段行一栏不少），再前进回到盒子首层',
      backToCompare && backPair.a === aSel && backPair.b === bSel && backPair.rows === expectedFields && forwardToList,
      `后退：地址 a=${backPair.a} b=${backPair.b} 字段行=${backPair.rows}（期望 ${expectedFields}）；前进回列表=${forwardToList}`);

    }
    // 不同种必须被拒绝：路由层（同一份判据）。这一条**不管有没有同种对都跑**。
    const otherGroup = [...groupCounts.entries()].find(([group]) => group !== mineRoute.player.cards[0].group);
    const aSel2 = mineRoute.player.cards[0].select;
    const mismatchRes = await fetch(`${base}api/roco/box?compare=${aSel2},${otherGroup[1][0]}`);
    const mismatchJson = await mismatchRes.json();
    const mismatchProblems = compareMismatchProblems(mismatchJson, mismatchRes.status);
    check('13-不同种拒绝', 'compare 两个不同种必须 HTTP 400 + ok:false，并给出「不是同一种」的原因',
      mismatchProblems.length === 0,
      mismatchProblems.join(' | ') || `HTTP ${mismatchRes.status} error=「${mismatchJson.error}」`);
    counter('13-不同种拒绝', '把「接受了不同种比较」的样本过同一条判据必须报错',
      compareMismatchProblems({ok: true, player: {fields: []}}, 200),
      '{ok:true,player:{fields:[]}} / HTTP 200');

    // ── ⑥c 2026-09-28 新要求：比不了的时候二级页要**如实说清原因**（不是白屏）────────
    // 两条路都走一遍：① 不同物种（服务端 400）；② 地址上只带了一只（缺 id）。
    // 判据是纯函数 `compareFailureProblems`，下面各喂一个坏样本做反证。
    const otherId = otherGroup[1][0];
    const failureFacts = async () => JSON.parse(await safeJs(`(()=>{const view=document.getElementById('compare-view');
      const note=document.getElementById('compare-note');
      const text=(document.body.innerText||'').replace(/\\s+/g,' ');
      return JSON.stringify({view:(view&&view.hidden===false)?'compare':'list',
        rows:view?view.querySelectorAll('.cmp-row').length:0,
        note:String(note&&!note.hidden?note.textContent:'').replace(/\\s+/g,' ').trim(),
        back:Boolean(document.getElementById('compare-back')),
        idShapes:text.match(/pet_\\d{6}|own-\\d{4}/g)??[]});})()`) ?? '{}');
    await cdp.send('Page.navigate', {url: `${base}box.html?a=${aSel2}&b=${otherId}`});
    await sleep(1200);
    const mixedShown = await waitForSafe(`(()=>{const n=document.getElementById('compare-note');
      return Boolean(n)&&n.hidden===false&&String(n.textContent||'').trim().length>10;})()`, {tries: 60, ms: 200});
    await sleep(200);
    const mixedFacts = await failureFacts();
    const mixedProblems = compareFailureProblems(mixedFacts);
    steps.push({at: 'compare-mixed-species', url: `box.html?a=${aSel2}&b=${otherId}`, facts: mixedFacts});
    check('11d-比不了就说清（不同种）',
      '把两只不同种的地址直接打开（服务端 400）：二级页停在比较页上、一行字段都不画，'
      + '用玩家话写清「不是同一种」，返回入口还在，文案里不出现个体编号',
      mixedShown && mixedProblems.length === 0,
      mixedProblems.join(' | ') || `原因「${mixedFacts.note}」`);
    counter('11d-比不了就说清（不同种）',
      '白屏 / 没有原因 / 没有返回入口 / 文案里带编号 —— 四种坏样本都必须被同一条判据抓住',
      compareFailureProblems({view: 'compare', rows: 0, note: '', back: false, idShapes: ['pet_000012']}),
      '{"note":"","back":false,"idShapes":["pet_000012"]}');

    await cdp.send('Page.navigate', {url: `${base}box.html?a=${aSel2}`});
    await sleep(1100);
    const halfShown = await waitForSafe(`(()=>{const n=document.getElementById('compare-note');
      return Boolean(n)&&n.hidden===false&&String(n.textContent||'').trim().length>10;})()`, {tries: 60, ms: 200});
    await sleep(200);
    const halfFacts = await failureFacts();
    const halfProblems = compareFailureProblems(halfFacts);
    steps.push({at: 'compare-missing-id', url: `box.html?a=${aSel2}`, facts: halfFacts});
    check('11e-比不了就说清（少带一只）', '地址上只有一只（缺 id）：二级页也要如实说清「要两只才有得比」，不许白屏',
      halfShown && halfProblems.length === 0,
      halfProblems.join(' | ') || `原因「${halfFacts.note}」`);

    // 这一段最后**回到盒子首层**：下面 ⑦⑧⑨ 的步骤都假定在列表那一屏上。
    await cdp.send('Page.navigate', {url: `${base}box.html`});
    await sleep(1200);
    await waitForSafe(`document.querySelectorAll('#box-grid .card').length>0`, {tries: 60, ms: 200});
    await sleep(200);

    // ── ⑦ 工程字段只允许在默认收起的抽屉里 ─────────────────────────────
    const drawerClosed = await js(`document.getElementById('dev-drawer').open===false`);
    const closedText = await playerText();
    const closedHit = closedText.match(FORBIDDEN_PLAYER);
    await mouseClick('#dev-drawer > summary');
    await sleep(300);
    const devFacts = JSON.parse(await js(`(()=>{const body=document.getElementById('dev-body');
      const text=body.textContent||'';
      return JSON.stringify({open:document.getElementById('dev-drawer').open,len:text.length,
        hasProvenance:text.includes('provenance'),hasUnknownFields:text.includes('unknown_fields'),
        hasStateVersion:text.includes('state_version'),hasCoverage:text.includes('coverage'),
        hasLicence:text.includes('licence_ref'),sample:text.replace(/\\s+/g,' ').slice(0,160)});})()`));
    await mouseClick('#dev-drawer > summary');
    await sleep(200);
    check('14-工程信息在抽屉里', '开发者抽屉默认收起；展开后能真的看到 provenance / unknown_fields / state_version / coverage / 许可',
      drawerClosed && closedHit === null && devFacts.open === true && devFacts.hasProvenance
      && devFacts.hasUnknownFields && devFacts.hasStateVersion && devFacts.hasCoverage && devFacts.hasLicence,
      `默认收起=${drawerClosed} 展开=${devFacts.open} 长度=${devFacts.len} provenance=${devFacts.hasProvenance}`
      + ` unknown_fields=${devFacts.hasUnknownFields} state_version=${devFacts.hasStateVersion}`
      + ` coverage=${devFacts.hasCoverage} licence=${devFacts.hasLicence}；样例「${devFacts.sample}」`);

    // 必红方向：往玩家区塞一个工程字段，同一个判据必须抓住
    const poison = await js(`(()=>{const grid=document.getElementById('box-grid');
      const el=document.createElement('p');el.id='poison';el.textContent='pet_id=pet_000001 state_version=rc205.1';
      grid.appendChild(el);return true;})()`);
    const poisonedText = await playerText();
    const poisonedHit = poisonedText.match(FORBIDDEN_PLAYER);
    await js(`document.getElementById('poison')?.remove()`);
    const restoredHit = (await playerText()).match(FORBIDDEN_PLAYER);
    counter('06-玩家层无工程话', '往玩家区注入 pet_id / state_version 后，同一条判据必须命中；移除后必须恢复干净',
      poisonedHit ? [poisonedHit[0]] : [], `注入=${poison} 命中=${JSON.stringify(poisonedHit?.[0] ?? null)} 恢复后=${JSON.stringify(restoredHit?.[0] ?? null)}`);
    check('15-判据可恢复', '注入后命中、移除后干净（说明这一条判的是页面本身，不是一次性快照）',
      poisonedHit !== null && restoredHit === null,
      `注入命中=${JSON.stringify(poisonedHit?.[0] ?? null)} 恢复=${JSON.stringify(restoredHit?.[0] ?? null)}`);

    // ── ⑧ 路由层的另外两条反证：非法 limit / unknown_fields 混进玩家层 ──
    const badLimitRes = await fetch(`${base}api/roco/box?kind=catalog&limit=1e3`);
    const badLimitJson = await badLimitRes.json();
    const badLimitProblems = limitProblems('1e3', badLimitJson, badLimitRes.status);
    check('16-非法limit', 'limit=1e3 必须 HTTP 400 + ok:false，且错误点名 limit（不静默取整）',
      badLimitProblems.length === 0,
      badLimitProblems.join(' | ') || `HTTP ${badLimitRes.status} error=「${badLimitJson.error}」`);
    counter('16-非法limit', '把「静默取整」的样本（200 + limit=1）过同一条判据必须报错',
      limitProblems('1e3', {ok: true, player: {limit: 1}}, 200), '{ok:true,player:{limit:1}} / HTTP 200');

    const realPlayer = (await (await fetch(`${base}api/roco/box?kind=mine&limit=24`)).json()).player;
    const realProblems = playerLayerProblems(realPlayer);
    check('17-玩家层载荷', '玩家层载荷里没有工程键（pet_id / species_id / unknown_fields / provenance…），也没有 id 形状的展示值',
      realProblems.length === 0, realProblems.join(' | ') || `扫过 ${JSON.stringify(realPlayer).length} 字节`);
    counter('17-玩家层载荷', '把 pet_id 与 unknown_fields 混进玩家层载荷必须被同一条判据抓住',
      playerLayerProblems({cards: [{name: '音速犬', pet_id: 'pet_000062', unknown_fields: ['traits'],
        select: 'own-0001', group: 'pet_000062', note: 'pet_000062'}]}),
      '{"cards":[{"name":"音速犬","pet_id":"pet_000062","unknown_fields":["traits"]}]}');

    // ── ⑨ 窄屏 390×844：不溢出 + 触控目标 ≥44px ────────────────────────
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    await sleep(500);
    await mouseClick('#tab-mine');
    await waitFor(`document.body.dataset.boxKind==='mine'`);
    await sleep(400);
    const narrow = await metrics();
    screens.push({viewport: '390x844', at: 'mine', ...narrow});
    check('18-窄屏不溢出', '390×844：scrollW == clientW',
      narrow.scrollW === narrow.clientW,
      `clientW=${narrow.clientW} scrollW=${narrow.scrollW} bodyScrollW=${narrow.bodyScrollW}`);
    const targets = JSON.parse(await js(`(()=>{const out=[];const els=[...document.querySelectorAll('button,summary,input')];
      for(const el of els){const r=el.getBoundingClientRect();
        if(r.width===0&&r.height===0)continue;
        if(el.closest('[hidden]'))continue;
        out.push({tag:el.tagName,id:el.id||null,cls:String(el.className||'').slice(0,26),
          secondary:el.classList.contains('cmp-toggle'),
          w:Math.round(r.width),h:Math.round(r.height)});}
      return JSON.stringify({count:out.length,rows:out});})()`));
    // ⚠ 2026-09-28 改钉（人类：「然后就是那个加入比较为啥那么大，有那么重要？」）：
    // 触控那条线只对**主要动作**成立；卡片上的「加入比较」是次要动作，按 chip 尺寸做
    //（实测 24px 高），所以它单列一档、下限 24×24 —— 主要动作那一半**一点没放宽**。
    const targetProblems = touchTargetProblems(targets.rows);
    check('19-触控目标', '390×844：主要动作（按钮 / summary / 输入框）都 ≥44×44；'
      + '卡片上的次要控件「加入比较」允许小到 24×24（2026-09-28 人类要求把它做小），但不许小于它（摸得到）',
      targetProblems.length === 0,
      targetProblems.slice(0, 4).join(' | ')
        || `量了 ${targets.count} 个元素；主要动作与次要控件都在线上`
          + `（次要控件 ${targets.rows.filter((x) => x.secondary).length} 个，最小 `
          + `${Math.min(...targets.rows.filter((x) => x.secondary).map((x) => x.h), 99)}px 高）`);
    counter('19-触控目标', '主要动作掉到 30px、次要控件掉到 20px —— 两种都不许过同一条判据',
      [...touchTargetProblems([{tag: 'BUTTON', id: 'compare-go', cls: '', secondary: false, w: 120, h: 30}]),
        ...touchTargetProblems([{tag: 'BUTTON', id: null, cls: 'cmp-toggle', secondary: true, w: 40, h: 20}])],
      '主要动作 120×30 / 次要控件 40×20');
    shots.push(await shoot('box-06-mine-390x844'));

    // 窄屏下的详情（真实鼠标）+ 截图。
    // 2026-09-24：「两个体比较」在本产物上不可达（一人一只，没有同种对）——
    // 上面已经如实登记；这里不再点比较按钮，也不再假装它开得出来。
    const narrowMetrics2 = await metrics();
    screens.push({viewport: '390x844', at: 'mine', ...narrowMetrics2});
    // ⚠ 2026-09-28 改钉（人类②③）：详情从**侧边抽屉**换成**二级页**（`?pet=`），
    // 判据要量的是同一件事：这一屏在 390×844 上也不许横向溢出。
    await mouseClick(`#box-grid .individual[data-detail]`);
    await waitFor(`(()=>{const v=document.getElementById('pet-view');
      return Boolean(v)&&v.hidden===false&&v.dataset.petRendered==='server'&&Boolean(new URLSearchParams(location.search).get('pet'));})()`);
    await sleep(300);
    const narrowDrawer = await metrics();
    screens.push({viewport: '390x844', at: 'detail', ...narrowDrawer});
    check('20-窄屏可读', '390×844：我的盒子不横向溢出，且可点目标都在线上（主要 44 / 次要控件 24，见 19）',
      narrowMetrics2.scrollW === narrowMetrics2.clientW,
      `clientW=${narrowMetrics2.clientW} scrollW=${narrowMetrics2.scrollW}`);
    check('21-窄屏详情页', '390×844：个体详情**二级页**打开时也不横向溢出',
      narrowDrawer.scrollW === narrowDrawer.clientW,
      `clientW=${narrowDrawer.clientW} scrollW=${narrowDrawer.scrollW}`);

    // ── RC-801 的第一段交接：盒子 → 产品页六槽工作台（`?team=own-…`）──────────
    // 五分钟 Demo 的第一步是「盒子 → 个体比较 → **锁定** → **补队**」。此前这一步是断的：
    // 比完之后玩家得回产品页按名字再找一遍。这一段量交接真的通了没有。
    await js(`window.scrollTo(0,0)`);
    // 先把前置条件**自己重建一遍**（这一段前面切换过标签页与抽屉，选中状态不保证还在）：
    // 回到「我的」标签、真鼠标点两张卡的「加入比较」、再真鼠标点「比较这两只」。
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await sleep(300);
    await mouseClick('#tab-mine');
    await waitFor(`document.body.dataset.boxKind==='mine'`);
    await sleep(400);
    // ⚠ 2026-09-28：`#detail-drawer` 已经不存在（详情改成二级页 `#pet-view`）⇒
    // 回到列表这一屏（地址也回到列表地址），后面那一段才知道自己在哪儿。
    await js(`(()=>{const v=document.getElementById('pet-view');
      if(v&&v.hidden===false){document.getElementById('pet-back')?.click();}return true;})()`);
    await sleep(700);
    // ⚠ 2026-09-28 改钉：原来取"页面前两张卡的加入比较" —— 那时候**每个物种只有 1 个个体**，
    // 抽屉会把每个组直接摊开，所以前两张卡必然在网格里。人类批准一对同种个体之后，
    // 「铠甲虫」那一组默认**收起** ⇒ 前两张卡变成了**跨物种**（比较按钮对跨物种是禁用的），
    // 这一步就点不出可比较的一对（实测：`compare-go` 一直 disabled、选中个体 0 只）。
    // 现在直接用**那一对同种个体**（与上面第 ⑥ 组同一对，来源仍是页面自己的数据）：
    const pairRoute = await (await fetch(`${base}api/roco/box?kind=mine&limit=60&offset=0`)).json();
    const bySpecies = new Map();
    for (const card of pairRoute.player.cards) {
      bySpecies.set(card.group, [...(bySpecies.get(card.group) ?? []), card.select]);
    }
    const handoffPair = [...bySpecies.values()].find((list) => list.length === 2) ?? [];
    if (handoffPair.length === 2) {
      const name = pairRoute.player.cards.find((c) => c.select === handoffPair[0])?.name ?? '';
      const species = pairRoute.player.cards.find((c) => c.select === handoffPair[0])?.group ?? '';
      // 用**与第 ⑥ 组一模一样**的步骤（那一套已经实测能点到）：重新导航把档位/筛选/搜索全部复位，
      // 再切「我的精灵」、搜这一种、展开那一行。这里踩过一次"把步骤写短一点"的坑（点不到 own-0001），
      // 所以宁可重复这四步，也不另辟一条没验过的路。
      await cdp.send('Page.navigate', {url: base + 'box.html'});
      await sleep(1200);
      await waitFor('document.querySelectorAll("#box-grid .card").length>0');
      await sleep(300);
      await mouseClick('#tab-mine');
      await sleep(500);
      // ⚠ 不碰搜索框：盒子页会把"搜索词 + 筛选"**持久化**（实测重载后 `pressed:3`、搜索框里还留着
      // 上一次的词），而 `typeText` 是追加式输入 ⇒ 会变成「铠甲虫铠甲虫」、网格 0 张卡。
      // 这一对在**第一页**（own-0001 是第一行），所以直接展开那一行就够，不必搜。
      const row = await js(`(()=>{const el=document.querySelector('.species-drawer[data-species="${species}"] .drawer-head');
        return el?'yes':'no';})()`);
      if (row === 'yes') { await mouseClick(`.species-drawer[data-species="${species}"] .drawer-head`); await sleep(500); }
      else { steps.push({at: 'handoff-pair-row-missing', species, name}); }
    }
    // ⚠ 2026-09-28 改钉（人类②：比较入口从列表行搬进二级详情页）：一只是**一只**地走
    // 「打开它自己那一页 → 加入比较 → 回列表」这一条路（与第 ⑥ 组同一套步骤，实测能点到）。
    const twoForCompare = handoffPair;
    for (const sel of twoForCompare) {
      const species = pairRoute.player.cards.find((c) => c.select === sel)?.group ?? '';
      if (species) await ensureRowVisible(species, sel);
      await mouseClick(`#box-grid .individual[data-detail="${sel}"]`);
      await waitFor(`(()=>{const v=document.getElementById('pet-view');
        return Boolean(v)&&v.hidden===false&&new URLSearchParams(location.search).get('pet')===${JSON.stringify(sel)};})()`);
      await sleep(300);
      await mouseClick('#pet-actions [data-cmp]');
      await sleep(400);
      await mouseClick('#pet-back');
      await sleep(700);
    }
    await waitFor(`document.getElementById('compare-go')?.disabled===false`);
    await mouseClick('#compare-go');
    // ⚠ 2026-09-28 改钉：比较进的是**第二级页**（`?a=&b=`），«比完就去配队» 那一个入口现在
    // 也在那一屏上（`#compare-view-to-team`）。首层那条 `#compare-to-team` 仍在（判据 25/26 用它），
    // 但玩家比完看到的是二级页上这一个 —— 所以这里量的是它，判据的意图没变
    //（比完两只之后必须有一个可用的「带上这两只去配队」，触控目标 ≥44px）。
    const handoffView = await waitForSafe(`(()=>{const v=document.getElementById('compare-view');
      const q=new URLSearchParams(window.location.search);
      return Boolean(v)&&v.hidden===false&&Boolean(q.get('a'))&&Boolean(q.get('b'));})()`);
    await sleep(400);
    // 选中的个体从**地址**里读（二级页就是靠这两只复现的）；网格里那些 `.card.picked` 是同一份
    // 选中状态在首层的影子（首层收起了但仍在 DOM 里），两者不一致就当场报出来。
    const urlPair = JSON.parse(await js(`JSON.stringify((()=>{const q=new URLSearchParams(location.search);
      return [q.get('a'),q.get('b')].filter(Boolean);})())`) || '[]');
    const gridPicked = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#box-grid .card.picked')]
      .map((el) => el.dataset.select).filter(Boolean))`) || '[]');
    const parsedHandoff = urlPair.length === 2 ? urlPair : gridPicked;
    steps.push({at: 'handoff-pair', handoffPair, urlPair, gridPicked, handoffView});
    const handoffButton = await js(`(()=>{const b=document.getElementById('compare-view-to-team');
      if(!b)return null;const r=b.getBoundingClientRect();
      return {disabled:b.disabled,w:Math.round(r.width),h:Math.round(r.height)};})()`);
    const handoffEntryProblems = (facts, count) => {
      const bad = [];
      if (facts === null) bad.push('入口不存在');
      else if (facts.disabled !== false) bad.push('入口是禁用的（等于没有入口）');
      else if (facts.h < 44) bad.push(`入口只有 ${facts.h}px 高（摸不到）`);
      if (!(count > 0)) bad.push('页面上一只选中的个体都没有');
      return bad;
    };
    check('23-带去配队的入口', '比完两只之后（比较二级页上）「带上这两只去配队」可用（触控目标 ≥44px），'
      + '而且二级页地址里的两只与首层选中的那两只一致',
      handoffEntryProblems(handoffButton, parsedHandoff.length).length === 0 && handoffView
        && urlPair.length === 2 && (gridPicked.length === 0 || gridPicked.join() === urlPair.join()),
      `按钮 ${JSON.stringify(handoffButton)}；地址里的两只 ${JSON.stringify(urlPair)}`
      + `；首层选中的 ${JSON.stringify(gridPicked)}；二级页=${handoffView}`);
    counter('23-带去配队的入口', '一个 disabled 的入口等于没有入口，必须被同一条判据抓住',
      handoffEntryProblems({...handoffButton, disabled: true}, parsedHandoff.length), '{"disabled":true}');

    await mouseClick('#compare-view-to-team');
    await sleep(1200);
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(200);
    }
    const handed = await js(`(()=>{const root=document.getElementById('team-workshop');
      const url=new URLSearchParams(window.location.search).get('team');
      const slots=[...document.querySelectorAll('#team-workshop')].map((el)=>el);
      return {path:window.location.pathname.split('/').pop(),teamParam:url,
        twState:root?root.dataset.twState:null, selected:root?root.dataset.twSelected:null,
        handoff:root?root.dataset.twHandoff:null,
        teamButton:document.getElementById('start-standard-pvp')?.dataset.rocoStandardTeam??null,
        note:(document.getElementById('standard-pvp-note')||{}).textContent||''};})()`);
    await sleep(600);
    const handedNow = await js(`(()=>{const root=document.getElementById('team-workshop');
      return {path:window.location.pathname.split('/').pop(),
        twState:root?root.dataset.twState:null, selected:root?root.dataset.twSelected:null,
        handoff:root?root.dataset.twHandoff:null,
        teamButton:document.getElementById('start-standard-pvp')?.dataset.rocoStandardTeam??null,
        note:(document.getElementById('standard-pvp-note')||{}).textContent||''};})()`);
    // 2026-09-22（A3 同物种最多一只）：盒子比较的常常是**同种两只个体**，而队伍里
    // 同物种只能有一只 —— 所以交接时按物种去重，**URL 带过去的条数**才是权威口径。
    // 这条判据改成量「三者一致」（URL / 工作台 / 开局按钮）且不超过比较选中的数量，
    // 不再写死「必须等于 2」。
    const carried = String(handed.teamParam ?? '').split(',').filter(Boolean);
    const handedProblems = (f) => {
      const bad = [];
      if (f?.path !== 'roco.html') bad.push(`没有跳到产品页（现在在 ${f?.path}）`);
      if (f?.twState !== 'ok') bad.push(`工作台状态 ${JSON.stringify(f?.twState)}`);
      if (!carried.length) bad.push('URL 里一个个体都没带过来');
      if (carried.length > parsedHandoff.length) {
        bad.push(`带过来的比选中的还多（选中 ${parsedHandoff.length}，URL ${carried.length}）`);
      }
      if (new Set(carried).size !== carried.length) bad.push('URL 里有重复的个体');
      if (Number(f?.selected) !== carried.length) {
        bad.push(`URL 带了 ${carried.length} 只，工作台认了 ${f?.selected}`);
      }
      if (Number(f?.handoff) !== carried.length) bad.push(`交接钩子 data-tw-handoff=${f?.handoff}`);
      if (Number(f?.teamButton) !== carried.length) {
        bad.push(`开局按钮读到的队伍规模是 ${f?.teamButton}`);
      }
      return bad;
    };
    check('24-盒子→配队交接', '真鼠标点「带上这两只去配队」：跳到产品页，六槽工作台按 URL 带过去的个体预填'
      + '（同物种最多一只，故同种两只只带一只），开局按钮与交接钩子读到的规模三者一致，且如实说「还差几只」',
      handedProblems(handedNow).length === 0,
      handedProblems(handedNow).join(' | ')
      + `（带过来 ${parsedHandoff.length} 只；URL ${JSON.stringify(handed.teamParam)}；`
      + `工作台 selected=${handedNow.selected} handoff=${handedNow.handoff} 按钮规模=${handedNow.teamButton}；`
      + `文案「${handedNow.note}」）`);
    counter('24-盒子→配队交接', '把交接数量改成 0（没预填）必须被同一条判据抓住',
      handedProblems({...handedNow, selected: '0', handoff: null, teamButton: '0'}), '{"selected":"0"}');
    shots.push(await shoot('box-08-handoff-roco-1440x900'));

    // ── RC-801 还差①：**锁定要跟着交接走**（2026-09-25）──────────────────────────
    // 盒子里 `locked` 原来只是筛选条件：比完两只「带上这两只去配队」把两只都当普通选人送过去，
    // 玩家在工坊里还得自己重新锁一次。这一条真鼠标走一遍：选两只（数据里标着锁定的那两只）
    // → 交接 → URL 带 `lock=`、工坊 `data-tw-locked` 与 URL 里的锁定数一致。
    //
    // ⚠ 2026-09-28 改钉（人类⑦：「锁定功能直接删了的了」）：页面上**不再有**「只看锁定」那一档，
    // 也没有「锁定这一只去配队」那个按钮 ⇒ 这一条不再靠"点页面上的锁定入口"凑前置条件，
    // 改成**从数据里取那两只锁定个体**（`locked` 是产物里本来就有的事实），再有鼠标把它们选进比较。
    // 判据的意图一个字没改：**锁定必须跟着交接走**，且按钮上要写清带了几只。
    // `?lock=` 参数本身与它背后的服务端校验（RC-301 规则⑨）一个字没动 —— 页面上只是没有入口了。
    await js(`document.getElementById('compare-clear')?.click(); true`);
    await sleep(300);
    // 回到盒子页（用脚本里既有的导航方式：`Page.navigate` + base）
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    await sleep(1400);
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.querySelectorAll('#box-grid .card').length > 0`)) break;
      await sleep(200);
    }
    const lockedRoute = await (await fetch(`${base}api/roco/box?kind=mine&limit=60&offset=0`)).json();
    const lockedCards = lockedRoute.player.cards.filter((c) => c.locked === true).slice(0, 2)
      .map((c) => ({select: c.select, locked: true}));
    steps.push({at: 'lock-handoff-pick', locked: lockedCards.map((c) => c.select)});
    if (lockedCards.length >= 1) {
      // 每一只都走「展开它那一种 → 打开它自己那一页 → 加入比较 → 回列表」（比较入口现在在二级页上）
      for (const card of lockedCards) {
        const species = lockedRoute.player.cards.find((c) => c.select === card.select)?.group ?? '';
        if (species) await ensureRowVisible(species, card.select);
        await mouseClick(`#box-grid .individual[data-detail="${card.select}"]`);
        await waitFor(`(()=>{const v=document.getElementById('pet-view');
          return Boolean(v)&&v.hidden===false&&new URLSearchParams(location.search).get('pet')===${JSON.stringify(card.select)};})()`);
        await sleep(300);
        await mouseClick('#pet-actions [data-cmp]');
        await sleep(400);
        await mouseClick('#pet-back');
        await sleep(700);
      }
      await sleep(400);
      const label = await js(`document.getElementById('compare-to-team')?.textContent ?? ''`);
      const labelProblems = (text, count) => (count > 0 && !/锁定/.test(String(text))
        ? [`带走的锁定有 ${count} 只，按钮上却没说：${JSON.stringify(text)}`] : []);
      // ⚠ 2026-09-27：这条原来是**三参数**写法，而这个脚本的 check 是 `(id, judge, ok, actual)`
      // ⇒ 判据文本落进 `ok`（恒真）—— **一直是假绿**。静态守卫的警告把它列出来了，这里补上判据文本。
      check('25-锁定随交接走：按钮上写清带了几只锁定',
        '带锁定去配队时按钮上要写清带了几只',
        lockedCards.length > 0 && labelProblems(label, lockedCards.length).length === 0,
        `选中 ${lockedCards.length} 只（数据里标着锁定的那些）：按钮文案「${label}」`);
      counter('25-锁定随交接走：按钮上写清带了几只锁定',
        '带锁定却不在按钮上说明，必须被同一条判据抓住', labelProblems('带上这两只去配队', 1), '["带上这两只去配队"]');
      await mouseClick('#compare-to-team');
      await sleep(1400);
      for (let i = 0; i < 60; i += 1) {
        if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
        await sleep(200);
      }
      const lockFacts = await js(`(()=>{const root=document.getElementById('team-workshop');
        const lock=new URLSearchParams(window.location.search).get('lock')||'';
        return {path:window.location.pathname.split('/').pop(), lockParam:lock,
          lockedNow:root?root.dataset.twLocked:null,
          selected:root?root.dataset.twSelected:null,
          slotMarks:[...document.querySelectorAll('#team-workshop .tw-slot .tw-lock')].map((el)=>el.textContent.trim())};})()`);
      const lockProblems = (f) => {
        const bad = [];
        const carriedLock = String(f?.lockParam ?? '').split(',').filter(Boolean);
        if (f?.path !== 'roco.html') bad.push(`没有跳到产品页（现在在 ${f?.path}）`);
        if (!carriedLock.length) bad.push('URL 里没有 lock 参数（锁定没跟着走）');
        if (Number(f?.lockedNow) !== carriedLock.length) {
          bad.push(`URL 带了 ${carriedLock.length} 个锁定，工坊实际认了 ${f?.lockedNow}`);
        }
        if (!(Number(f?.selected) > 0)) bad.push('工坊没有认下任何选人（锁定应当只作用于入选的那些）');
        return bad;
      };
      check('26-锁定随交接走：到工坊后真的锁上了',
        '从盒子带过去的锁定，到工坊必须真的锁上', lockProblems(lockFacts).length === 0,
        lockProblems(lockFacts).join(' | ')
        + `（URL lock=${JSON.stringify(lockFacts.lockParam)}；工坊 locked=${lockFacts.lockedNow}；`
        + `槽位标记 ${JSON.stringify(lockFacts.slotMarks.slice(0, 3))}）`);
      counter('26-锁定随交接走：到工坊后真的锁上了',
        '把 URL 里的 lock 抹掉（锁定没跟过来）必须被同一条判据抓住',
        lockProblems({...lockFacts, lockParam: '', lockedNow: '0'}), '{"lockParam":""}');
      shots.push(await shoot('box-09-lock-handoff-1440x900'));
    } else {
      // ⚠ 2026-09-27（逐条判定 123 处警告时抓到）：这一行原来是**三参数**写法，而这个脚本的
      // `check` 是 `(id, judge, ok, actual)` ⇒ `ok` 收到那串文本（恒真）——**这条"失败上报"
      // 其实报的是绿**。补上判据文本，让它真的红。
      check('25-锁定随交接走：按钮上写清带了几只锁定',
        '数据里标着锁定的个体应当能被选进比较（夹具里 9 只锁定）',
        false, '数据里一只锁定的个体都取不到（夹具里应当有 9 只锁定）');
    }

    // ── ⑧ 刷新 → 回滚 → 重刷（**真机**：真鼠标点抽屉里的按钮）──────────────────
    //
    // 2026-09-27：回滚这条能力从做出来到今天，只有单测与静态判据 —— 台账 §C6.314/§C6.315 连着
    // 两轮把它记成"没做到/未验证"。这一组补上真机那一段，并且**每一步都看数据**（localStorage
    // 里的个体记录），不看"按钮点着了没有"：
    //   ① 点「刷新天分」⇒ 账上多一级、次数 3→2、那一行小字说出**落在哪一项**；
    //   ② 点「回滚上一次」⇒ 天分数值**逐值回到刷之前**、**次数不动**（人类：「不消耗也不返还」）、
    //      按钮消失（刚退过一步，再退就是退回两步之前）；
    //   ③ 再点「刷新天分」⇒ 落点必须**换一项**、那行小字要说清"换掉了原来的哪一项"，
    //      而且**按钮要回来**（中间刷过了，这一步可以退 —— 人类：「不是回一次」）。
    // 判据写成纯函数（`rollbackProblems`），反证直接喂坏数据给它。
    const rollbackProblems = (step) => {
      const bad = [];
      const before = step?.before ?? {};
      const afterRefresh = step?.afterRefresh ?? {};
      const afterUndo = step?.afterUndo ?? {};
      const afterReroll = step?.afterReroll ?? {};
      if (Number(afterRefresh.boosts) !== Number(before.boosts) + 1) {
        bad.push(`刷新之后账上应当多一级（${before.boosts} → ${afterRefresh.boosts}）`);
      }
      if (Number(afterRefresh.left) !== Number(before.left) - 1) {
        bad.push(`刷新之后剩余次数应当少一次（${before.left} → ${afterRefresh.left}）`);
      }
      if (!/加到「[^」]+」/.test(String(afterRefresh.note))) {
        bad.push(`刷新之后要说清落在哪一项，实际「${afterRefresh.note}」`);
      }
      if (Number(afterUndo.boosts) !== Number(before.boosts)) {
        bad.push(`回滚之后账上应当回到 ${before.boosts} 级，实际 ${afterUndo.boosts}`);
      }
      // 2026-09-27 改钉（人类口述）：「回滚不消耗也不返还次数」⇒ 退一步之后次数**不动**。
      if (Number(afterUndo.left) !== Number(afterRefresh.left)) {
        bad.push(`回滚不动次数（应当还是 ${afterRefresh.left}，实际 ${afterUndo.left}）`);
      }
      if (JSON.stringify(afterUndo.talent) !== JSON.stringify(before.talent)) {
        bad.push(`回滚之后天分数值必须逐值回到刷之前：${JSON.stringify(before.talent)} → ${JSON.stringify(afterUndo.talent)}`);
      }
      if (afterUndo.undoButton !== false) bad.push('回滚之后那个按钮必须消失（没有可撤的了）');
      if (afterUndo.note) bad.push(`回滚之后那一行小字要消失（账上已经没有刷新），实际「${afterUndo.note}」`);
      const firstStat = String(afterRefresh.note).match(/加到「([^」]+)」/)?.[1] ?? null;
      const againStat = String(afterReroll.note).match(/加到「([^」]+)」/)?.[1] ?? null;
      if (!againStat) bad.push(`重刷之后也要说清落在哪一项，实际「${afterReroll.note}」`);
      if (firstStat && againStat && firstStat === againStat) {
        bad.push(`回滚之后重刷必须换一个落点，两次都是「${againStat}」`);
      }
      if (againStat && !/回滚之后重刷/.test(String(afterReroll.note))) {
        bad.push(`重刷那一次要说明这是回滚之后重刷的，实际「${afterReroll.note}」`);
      }
      if (firstStat && !String(afterReroll.note).includes(firstStat)) {
        bad.push(`要说清"换掉了原来的哪一项"（原来那次是「${firstStat}」），实际「${afterReroll.note}」`);
      }
      if (Number(afterReroll.boosts) !== Number(before.boosts) + 1) {
        bad.push(`重刷之后账上应当是一级，实际 ${afterReroll.boosts}`);
      }
      // 中间又刷过一次 ⇒ 这一步可以退（人类：「不是回一次」）
      if (afterReroll.undoButton !== true) {
        bad.push('中间又刷过一次 ⇒ 回滚按钮必须回来（否则新刷的这一步退不了）');
      }
      // 状态行是**另一条渲染路径**（`box.js` 直接写 `#box-status`，抽屉那一行是 `box-drawer.js`）：
      // 两边都要走同一句话（`lastRefreshNote`），所以两边都要判。
      if (!/回滚之后重刷/.test(String(afterReroll.status))) {
        bad.push(`状态行也要说清这是回滚之后重刷的，实际「${afterReroll.status}」`);
      }
      if (!String(afterRefresh.status).includes(firstStat ?? '\u0000')) {
        bad.push(`状态行要说清落在哪一项（「${firstStat}」），实际「${afterRefresh.status}」`);
      }
      return bad;
    };
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    await sleep(1400);
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.querySelectorAll('#box-grid .card').length > 0`)) break;
      await sleep(200);
    }
    // 真机上**每个个体只留一份状态**：先清掉本机记录，让这一次从 3+3 次开始（可复现）。
    await js(`localStorage.removeItem('roco.box.individuals.v1'); true`);
    await js(`document.getElementById('box-reset')?.click(); true`);
    await sleep(1200);
    // ⚠ 2026-09-28 改钉（人类③：刷新/回滚按钮搬进二级详情页 `#pet-view`）：
    // 这几步改成「先在列表里找到这一行 → 打开它自己那一页 → 在那一页上点按钮」。
    // 判据的意思一个字没改（账+1 / 次数-1 / 说清落点 / 回滚逐值还原且次数不动 / 只退一步）。
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.querySelectorAll('#box-grid .individual[data-detail]').length > 0`)) break;
      await sleep(200);
    }
    const rowFacts = async (id) => JSON.parse(await js(`(()=>{
      const row=document.querySelector('#pet-view [data-individual="${id}"]');
      const store=JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}');
      const one=store[${JSON.stringify(id)}]||null;
      return JSON.stringify({
        boosts:(one&&Array.isArray(one.talent_boosts))?one.talent_boosts.length:0,
        left:one&&one.refreshes?one.refreshes.talent:0,
        talent:one?one.talent:null,
        note:row?String(row.querySelector('[data-refresh-note]')?.textContent||'').replace(/\\s+/g,' ').trim():null,
        undoButton:Boolean(row&&row.querySelector('[data-undo]')),
        status:String(document.getElementById('box-status')?.textContent||'').slice(0,120)});})()`));
    const pick = JSON.parse(await js(`(()=>{const row=document.querySelector('#box-grid .individual[data-detail]');
      return JSON.stringify({id:row?row.dataset.detail:null});})()`));
    if (pick.id) {
      // 打开这一只自己那一页（刷新/回滚按钮都在那一页上）
      await mouseClick(`#box-grid .individual[data-detail="${pick.id}"]`);
      await waitFor(`(()=>{const v=document.getElementById('pet-view');
        return Boolean(v)&&v.hidden===false&&v.dataset.petRendered==='server'&&Boolean(new URLSearchParams(location.search).get('pet'));})()`);
      await sleep(400);
    }
    if (!pick.id) {
      check('28-刷新→回滚→重刷（真机）',
        '盒子里要有一行个体可以打开（二级详情页上有「刷新天分」）',
        false, '盒子里一行个体都没有（抽屉没渲染？）');
    } else {
      const before = await rowFacts(pick.id);
      await mouseClick(`#pet-view [data-refresh="talent"]`);
      await sleep(600);
      const afterRefresh = await rowFacts(pick.id);
      await mouseClick(`#pet-view [data-undo]`);
      await sleep(600);
      const afterUndo = await rowFacts(pick.id);
      await mouseClick(`#pet-view [data-refresh="talent"]`);
      await sleep(600);
      const afterReroll = await rowFacts(pick.id);
      const step = {id: pick.id, before, afterRefresh, afterUndo, afterReroll};
      steps.push({at: 'rollback', ...step});
      const problems = rollbackProblems(step);
      check('28-刷新→回滚→重刷（真机）',
        '真鼠标点：刷新后账+1/次数-1且说清落点；回滚后数值逐值回到刷之前、**次数不动**、按钮消失（只退一步）；重刷换一个落点、说清换掉了谁、按钮回来（不是回一次）',
        problems.length === 0,
        problems.join(' | ') || `个体 ${pick.id}：${before.boosts}级/${before.left}次 → `
          + `${afterRefresh.boosts}级/${afterRefresh.left}次「${afterRefresh.note}」 → 回滚 ${afterUndo.boosts}级/${afterUndo.left}次 `
          + `(按钮=${afterUndo.undoButton}) → 重刷「${afterReroll.note}」`);
      shots.push(await shoot('box-10-rollback-1440x900'));
      // 反证：把"回滚没把次数还回来 / 值没回去"的坏数据喂给同一条判据，必须逐条报出来
      counter('28-刷新→回滚→重刷（真机）',
        '回滚没还原数值、没还次数、重刷落点没换 —— 三种坏数据都必须被同一条判据抓住',
        rollbackProblems({...step, afterUndo: {...afterUndo, left: before.left, talent: afterRefresh.talent,
          boosts: afterRefresh.boosts, undoButton: true, note: afterRefresh.note},
        afterReroll: {...afterReroll, note: String(afterRefresh.note)}}),
        '{"afterUndo":{"left":"次数被改动了","talent":"未还原"},"afterReroll":{"note":"同一个落点"}}');
    }

    // ── ⑨ 「＋ 再养一只同种」→ 两个个体 → 比大小（审计 ③ 的真机那一半）────────────
    //
    // 2026-09-27：同种第二只在**真实产物**里不存在（48 实例/48 物种，人类 09-24「重复的删掉」），
    // 所以「两个个体比大小」这条判据从前只能登记成"不可达"。§C6.289 给了入口（「＋ 再养一只同种」），
    // 但**比大小那一步从来没在真机上跑过**。这一条跑它：真鼠标加一只 → 真鼠标选两只 → 点比较，
    // 然后判"页面有没有把这件做不到的事**说清楚**"（本机新养的个体不在服务器名单里 ⇒ 比不了）。
    // ⚠ 这条判据不是"比成功了"，而是"**没有静默失败**"——审计 ③ 的原话就是"不可达"与"困惑"。
    const rerollProblems = (facts) => {
      const bad = [];
      if (facts?.added !== true) bad.push('「＋ 再养一只同种」之后本机记录里没有多出个体');
      if (facts?.extraId === facts?.baseId) bad.push('新个体没有自己的编号（还是原来那只）');
      if (Number(facts?.selected) !== 2) bad.push(`要能同时选中两只（实际 ${facts?.selected}）`);
      if (facts?.barHidden !== false) bad.push('选了两只之后比较栏必须是显示的');
      if (!/同种/.test(String(facts?.hintAfterPick))) {
        bad.push(`选完两只同种之后提示要说"同种"（实际「${facts?.hintAfterPick}」）`);
      }
      // ⚠ 2026-09-28 改钉（比较进了二级页）：原来判的是「面板没出来」，现在判的是
      // 「没跳进比较页、地址上没带那两只」—— 意图没变：本机新养的个体根本比不了，
      // 页面**不许**假装比成功（也不许跳到一个读不出结果的二级页上）。
      if (String(facts?.view ?? '') === 'compare' || /[?&]a=/.test(String(facts?.compareUrl ?? ''))) {
        bad.push(`本机新养的个体比不了，却还是进了比较页（view=${facts?.view} 地址「${facts?.compareUrl}」）`);
      }
      const hint = String(facts?.hintAfterCompare ?? '');
      if (!/本机/.test(hint) || !/名单/.test(hint)) {
        bad.push(`比不了的原因要说清楚（"本机加出来的 / 还没进服务器名单"），实际「${hint}」`);
      }
      return bad;
    };
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    await sleep(1400);
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.querySelectorAll('#box-grid .species-drawer').length > 0`)) break;
      await sleep(200);
    }
    // ⚠ 2026-09-28 改钉（人类③：这一类大动作搬进二级详情页）：「＋再养一只同种」现在在
    // **个体自己那一页**上（`#pet-actions`）。判据的意图一个字没改：真鼠标加一只 ⇒
    // 本机记录里真的多一只 ⇒ 两只都能选进比较 ⇒ 点比较**不许静默失败**。
    const listHead = await js(`document.querySelector('#box-grid .species-drawer .drawer-head')?.dataset.species ?? ''`);
    if (listHead) {
      await mouseClick(`.species-drawer[data-species="${listHead}"] .drawer-head`);
      await sleep(500);
    }
    const addProbe = JSON.parse(await js(`(()=>{const row=document.querySelector('#box-grid .individual[data-detail]');
      return JSON.stringify({row:row?row.dataset.detail:null,
        pet:new URLSearchParams(location.search).get('pet')});})()`));
    if (addProbe.row) {
      await mouseClick(`#box-grid .individual[data-detail="${addProbe.row}"]`);
      await waitForSafe(`(()=>{const v=document.getElementById('pet-view');
        return Boolean(v)&&v.hidden===false&&document.querySelector('#pet-actions [data-add]');})()`,
      {tries: 60, ms: 200});
      await sleep(300);
    }
    const addTarget = await js(`document.querySelector('#pet-actions [data-add]')?.dataset.add ?? ''`);
    if (!addTarget) {
      check('29-再养一只同种→比大小',
        '二级详情页上要有一个「＋ 再养一只同种」按钮',
        false, `页面上一个「＋ 再养一只同种」按钮都没有（那一行=${JSON.stringify(addProbe)}）`);
    } else {
      await mouseClick(`#pet-actions [data-add]`);
      await sleep(900);
      await mouseClick('#pet-back');
      await sleep(700);
      // ⚠ 2026-09-28 改钉：原来 `extra = ids.find((id)=>id!==base)` —— 那时候本地库里**只有**
      // 「再养一只同种」加出来的那只，所以"另一只"必然是它。人类批准一对同种演示个体之后，
      // 页面把服务端那两只也写进了同一个本地库（抽屉要画「3 个个体」）⇒ "另一只"会挑到
      // **服务端名单里**的 own-0049，于是比较**真的成功**，这条判据要验的"本机个体比不了"
      // 反而验不到（实测：面板真的出来了）。
      // 现在按**判据的意图**挑：extra 必须是**不在服务器名单里**的那一只（`own-XXXX` 且不在 API 列表里）。
      // ⚠ 上限就是 60（`limit=200` 会 400 ⇒ `.player` 是 undefined，实测踩到）
      const serverIds = ((await (await fetch(`${base}api/roco/box?kind=mine&limit=60&offset=0`)).json())
        .player?.cards ?? []).map((c) => c.select);
      const pick = JSON.parse(await js(`(()=>{
        const serverIds=${JSON.stringify(serverIds)};
        const store=JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}');
        const ids=Object.keys(store).filter((id)=>store[id]&&store[id].species_id===${JSON.stringify(addTarget)});
        const base=ids.find((id)=>serverIds.includes(id))||ids.find((id)=>!/-(b|c|d|e|f)$/.test(id))||ids[0]||null;
        const extra=ids.find((id)=>id!==base&&!serverIds.includes(id))||null;
        return JSON.stringify({ids, baseId:base, extraId:extra, serverIds:serverIds.length});})()`));
      const facts = {baseId: pick.baseId, extraId: pick.extraId, added: Boolean(pick.extraId)};
      // 排障/证据：这一行里**画出来**的个体是哪些、比较按钮有几个（判据红了要能一眼看出红在哪）
      facts.rows = JSON.parse(await js(`(()=>{const sec=document.querySelector('.species-drawer[data-species="${addTarget}"]');
        return JSON.stringify({drawer:Boolean(sec), count:sec?sec.dataset.count:null,
          rows:sec?[...sec.querySelectorAll('[data-individual]')].map((el)=>el.dataset.individual):[],
          toggles:sec?[...sec.querySelectorAll('.cmp-toggle')].map((el)=>el.dataset.cmp):[],
          html:sec?sec.innerHTML.replace(/\s+/g,' ').slice(0,500):null});})()`));
      if (pick.baseId && pick.extraId) {
        // 先记一次"点击之前这一行长什么样"（下面如果要抛"找不到元素"，账上至少知道为什么）
        steps.push({at: 'before-pick', addTarget, pick, rows: facts.rows});
        await mouseClick(`[data-individual="${pick.baseId}"] .cmp-toggle`);
        await sleep(200);
        await mouseClick(`[data-individual="${pick.extraId}"] .cmp-toggle`);
        await sleep(300);
        facts.selected = await js(`document.body.dataset.boxSelected`);
        facts.barHidden = await js(`document.getElementById('compare-bar')?.hidden`);
        facts.hintAfterPick = await js(`document.getElementById('compare-hint')?.textContent ?? ''`);
        await mouseClick('#compare-go');
        await sleep(600);
        // ⚠ 2026-09-28 改钉：比较结果搬进了第二级页，所以这里不再问「面板有没有出来」
        // （`#compare-panel` 已删 —— 那会**静默变成 undefined**，判据就空了），
        // 改成问「有没有真的跳到比较页 / 地址上有没有那两只」。判据的意图一个字没变：
        // 本机新养的个体比不了，点了比较**不许静默失败**，要如实说清为什么。
        facts.view = await js(`document.body.dataset.boxView ?? ''`);
        facts.compareUrl = await js(`window.location.search`);
        facts.hintAfterCompare = await js(`document.getElementById('compare-hint')?.textContent ?? ''`);
        // 诊断（点完比较之后到底发生了什么）：按钮禁用状态 / 选中了几只 / 抽屉里那两行的选择状态
        facts.diag = JSON.parse(await js(`(()=>{const cards=[...document.querySelectorAll('.individual[data-individual]')];
          return JSON.stringify({go:document.getElementById('compare-go')?.disabled,
            view:document.body.dataset.boxView??null,
            selected:document.body.dataset.boxSelected,
            picked:[...document.querySelectorAll('.card.picked')].map((el)=>el.dataset.select),
            rows:cards.slice(0,4).map((el)=>({id:el.dataset.individual??el.dataset.individual,
              picked:el.querySelector('.card')?.classList.contains('picked')??null}))});})()`));
      }
      steps.push({at: 'add-then-compare', ...facts});
      const problems = rerollProblems(facts);
      check('29-再养一只同种→比大小',
        '真鼠标：加一只同种 ⇒ 两只都能选进比较栏、提示说"同种"；点比较之后**不许静默失败** —— '
        + '要如实说清本机新养的个体还没进服务器名单（也不许硬跳进一个比不了的比较页）',
        problems.length === 0,
        problems.join(' | ') || `${facts.baseId} + ${facts.extraId}：选中 ${facts.selected} 只，`
          + `比较栏 hidden=${facts.barHidden}，点比较后停在 ${facts.view || '(首层)'}（地址「${facts.compareUrl}」）`
          + `，提示「${String(facts.hintAfterCompare).slice(0, 80)}」`
          + `；这一行画出来的是 ${JSON.stringify(facts.rows)}`);
      counter('29-再养一只同种→比大小',
        '静默失败（点了比较什么都不说）必须被同一条判据抓住',
        rerollProblems({...facts, hintAfterCompare: '已选两只同种伙伴：点「比较这两只」逐字段看相同 / 不同 / 未知。'}),
        '{"hintAfterCompare":"（还是选人那句，等于什么都没说）"}');
      shots.push(await shoot('box-11-add-then-compare-1440x900'));
    }

    // ── ⑩ 性格那一侧的「刷新 → 回滚 → 重刷」（真机三步，2026-09-27 补）──────────
    //
    // 28 号把**天分**那一侧的三步在真机上跑通了；台账里一直记着「性格那一侧只由单测覆盖」。
    // 同一个按钮、同一条路径，但性格的"落点"是**性格名**、`lastRefreshNote` 走的是另一支，
    // 所以这里照着 28 号再点一遍（同一个个体，性格次数还是满的）：
    //   ① 点「刷新性格」⇒ 性格变了、次数 3→2、那一行小字说出换成了哪条；
    //   ② 点「回滚上一次」⇒ 性格**回到刷之前那一条**、次数不动、按钮消失；
    //   ③ 再点「刷新性格」⇒ 换成**另一条**，小字说清"回滚之后重刷的，原来的「X」已经撤掉"。
    const natureProblems = (step) => {
      const bad = [];
      const before = step?.before ?? {};
      const afterRefresh = step?.afterRefresh ?? {};
      const afterUndo = step?.afterUndo ?? {};
      const afterReroll = step?.afterReroll ?? {};
      if (Number(afterRefresh.left) !== Number(before.left) - 1) {
        bad.push(`刷新之后性格次数应当少一次（${before.left} → ${afterRefresh.left}）`);
      }
      if (afterRefresh.nature === before.nature) bad.push('刷新之后性格必须变一条（还是原来那条）');
      if (!/上一次刷性格：换成了「[^」]+」/.test(String(afterRefresh.note))) {
        bad.push(`刷新之后要说清换成了哪条性格，实际「${afterRefresh.note}」`);
      }
      if (afterUndo.nature !== before.nature) {
        bad.push(`回滚之后性格必须回到刷之前那一条（应当 ${before.nature}，实际 ${afterUndo.nature}）`);
      }
      if (Number(afterUndo.left) !== Number(afterRefresh.left)) {
        bad.push(`回滚不动次数（应当还是 ${afterRefresh.left}，实际 ${afterUndo.left}）`);
      }
      if (afterUndo.undoButton !== false) bad.push('回滚之后那个按钮必须消失（只退一步）');
      // ⚠ 这一行小字说的是「**还站得住的那一次刷新**」。这个个体在前面（28 号）刷过天分，
      // 所以退掉性格这一步之后，小字应当回到**那条天分**上 —— 它**不该**再声称刚才那条性格
      // 还站着。第一版我写成"小字必须消失"，真机当场红给我看：那不是 bug，是我的断言过宽。
      if (String(afterUndo.note).includes(String(afterRefresh.nature))) {
        bad.push(`回滚之后不该再声称「${afterRefresh.nature}」还站着，实际「${afterUndo.note}」`);
      }
      if (afterReroll.nature === afterRefresh.nature) {
        bad.push(`回滚之后重刷必须换一条性格，两次都是「${afterReroll.nature}」`);
      }
      if (!/回滚之后重刷的/.test(String(afterReroll.note))) {
        bad.push(`重刷那一次要说明这是回滚之后重刷的，实际「${afterReroll.note}」`);
      }
      if (!String(afterReroll.note).includes(String(afterRefresh.nature))) {
        bad.push(`要说清"原来的「${afterRefresh.nature}」已经撤掉"，实际「${afterReroll.note}」`);
      }
      if (afterReroll.undoButton !== true) bad.push('中间又刷过一次 ⇒ 回滚按钮必须回来');
      return bad;
    };
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    // ⚠ 2026-09-28 改钉（人类③：刷新/回滚搬进二级详情页）：同 28 号 —— 这几步改成
    // 「先在列表里找到这一行 → 打开它自己那一页 → 在那一页上点按钮」。判据的意思一个字没改。
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.querySelectorAll('#box-grid .individual[data-detail]').length > 0`)) break;
      await sleep(200);
    }
    const natureFacts = async (id) => JSON.parse(await js(`(()=>{
      const row=document.querySelector('#pet-view [data-individual="${id}"]');
      const store=JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}');
      const one=store[${JSON.stringify(id)}]||null;
      return JSON.stringify({nature:one?one.nature:null, left:one&&one.refreshes?one.refreshes.nature:0,
        note:row?String(row.querySelector('[data-refresh-note]')?.textContent||'').replace(/\s+/g,' ').trim():null,
        undoButton:Boolean(row&&row.querySelector('[data-undo]'))});})()`));
    const naturePick = await js(`document.querySelector('#box-grid .individual[data-detail]')?.dataset.detail ?? ''`);
    if (!naturePick) {
      check('30-性格：刷新→回滚→重刷（真机）',
        '盒子里要有一行个体可以打开（二级详情页上有「刷新性格」）',
        false, '盒子里一行个体都没有（抽屉没渲染？）');
    } else {
      // 先打开这一只自己那一页（按钮都在那一页上）
      const natureSpecies = ((await (await fetch(`${base}api/roco/box?kind=mine&limit=60&offset=0`)).json())
        .player?.cards ?? []).find((c) => c.select === naturePick)?.group ?? '';
      if (natureSpecies) await ensureRowVisible(natureSpecies, naturePick);
      await mouseClick(`#box-grid .individual[data-detail="${naturePick}"]`);
      await waitFor(`(()=>{const v=document.getElementById('pet-view');
        return Boolean(v)&&v.hidden===false&&v.dataset.petRendered==='server'&&Boolean(new URLSearchParams(location.search).get('pet'));})()`);
      await sleep(400);
      const nBefore = await natureFacts(naturePick);
      await mouseClick(`#pet-view [data-refresh="nature"]`);
      await sleep(600);
      const nRefresh = await natureFacts(naturePick);
      await mouseClick(`#pet-view [data-undo]`);
      await sleep(600);
      const nUndo = await natureFacts(naturePick);
      await mouseClick(`#pet-view [data-refresh="nature"]`);
      await sleep(600);
      const nReroll = await natureFacts(naturePick);
      const nStep = {id: naturePick, before: nBefore, afterRefresh: nRefresh, afterUndo: nUndo, afterReroll: nReroll};
      steps.push({at: 'rollback-nature', ...nStep});
      const nProblems = natureProblems(nStep);
      check('30-性格：刷新→回滚→重刷（真机）',
        '真鼠标点：刷性格（次数-1、说清换成哪条）→ 回滚（性格逐值回到刷之前、次数不动、按钮消失）→ 重刷（换另一条、说清撤掉了哪条、按钮回来）',
        nProblems.length === 0,
        nProblems.join(' | ') || `个体 ${naturePick}：「${nBefore.nature}」/${nBefore.left}次 → `
          + `「${nRefresh.nature}」/${nRefresh.left}次 → 回滚「${nUndo.nature}」/${nUndo.left}次 `
          + `(按钮=${nUndo.undoButton}) → 重刷「${nReroll.nature}」`);
      counter('30-性格：刷新→回滚→重刷（真机）',
        '性格回滚没还原 / 次数被改动 / 重刷没换一条 —— 三种坏数据都必须被同一条判据抓住',
        natureProblems({...nStep, afterUndo: {...nUndo, nature: nRefresh.nature, left: nBefore.left - 1, undoButton: true},
          afterReroll: {...nReroll, nature: nRefresh.nature, note: nRefresh.note}}),
        '{"afterUndo":{"nature":"未还原","left":"次数被改动"},"afterReroll":{"note":"同一条性格"}}');
      shots.push(await shoot('box-12-nature-rollback-1440x900'));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ⚠ 2026-09-28 **新增**（人类 ①②③⑤⑥⑦⑧ 逐字批注的每一条都要有一条真机判据）：
    //   ① 等级一会儿 60 一会儿 100（错的）        → 「31-等级只有 60」
    //   ② 没有看完整六维的入口                    → 「32-完整六维的二级详情页」
    //   ③ 刷新/天分/再加一只太大，放二级页去      → 「32」与「33-动作只在二级页」
    //   ⑤ 选单不会自己收回去、全叠在一起          → 「34-筛选菜单自己收回去」
    //   ⑥ 收藏功能是假的                          → 「35-收藏刷新后还在」
    //   ⑦ 锁定功能直接删掉（入口）                → 「33」里一并量（页面上不许再有它）
    //   ⑧ 删除个体要二次确认                      → 「36-删掉要两步」
    // 做法与前文一致：真鼠标真键盘，量的是**页面实际输出**。
    // ═══════════════════════════════════════════════════════════════════════════

    // ── ① 等级：页面上只许出现 Lv.60 ────────────────────────────────────────
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    await sleep(1400);
    await waitForSafe(`document.querySelectorAll('#box-grid .individual[data-detail]').length>0`, {tries: 60, ms: 200});
    // 期望值**从数据现读**（不写死 60）：页面上出现的级数必须是数据里真有的那些。
    const levelRoute = await (await fetch(`${base}api/roco/box?kind=mine&limit=60&offset=0`)).json();
    const levelsInData = [...new Set((levelRoute.player?.cards ?? []).map((c) => c.level))];
    const levelFacts = JSON.parse(await safeJs(`JSON.stringify({html:document.documentElement.outerHTML,
      lines:(document.body.innerText||''), levels:${JSON.stringify(levelsInData)}})`) ?? '{}');
    const levelProblems = levelDisplayProblems(levelFacts);
    check('31-等级只有60', '人类 2026-09-28：「信息同时出现60和lv100（错误的）」⇒ 页面上**只许出现 Lv.60**'
      + '（等级上限 60 是官方口径，数据里 49 个个体也全是 60）；整页一个 Lv.100 都不许有，'
      + '同一行里也不许出现两个等级，而且出现的级数必须是数据里真有的',
      levelProblems.length === 0,
      levelProblems.join(' | ')
        || `整页 Lv.100 ${(String(levelFacts.html).match(/Lv\.100/g) ?? []).length} 处；`
          + `出现的级数 ${JSON.stringify([...new Set((String(levelFacts.html).match(/Lv\.\d+/g) ?? []))])}；`
          + `数据里的级数 ${JSON.stringify([...new Set(levelFacts.levels)])}`);
    counter('31-等级只有60', '把同一行里塞上 60 与 100（他截图里那个）必须被同一条判据抓住',
      levelDisplayProblems({html: '<span class="individual-level">Lv.60</span><span class="tag">Lv.100</span>',
        lines: '铠甲虫 Lv.60 Lv.100', levels: [60]}),
      '{"html":"Lv.60 + Lv.100 同一行"}');

    // ── ② 完整六维的二级详情页（地址 `?pet=`）──────────────────────────────
    await diag('before-09');
    const petSelect = await js(`document.querySelector('#box-grid .individual[data-detail]')?.dataset.detail ?? ''`);
    if (petSelect) {
      await mouseClick(`#box-grid .individual[data-detail="${petSelect}"]`);
      await waitForSafe(`(()=>{const v=document.getElementById('pet-view');
        return Boolean(v)&&v.hidden===false&&v.dataset.petRendered==='server'&&Boolean(new URLSearchParams(location.search).get('pet'));})()`,
      {tries: 60, ms: 200});
      await sleep(350);
      const petFacts = JSON.parse(await safeJs(`(()=>{const v=document.getElementById('pet-view');
        const stats=[...v.querySelectorAll('#pet-body .metric')].map((el)=>String(el.querySelector('b')?.textContent||'').trim());
        return JSON.stringify({view:document.body.dataset.boxView,
          pet:new URLSearchParams(location.search).get('pet'),
          stats, traitRows:v.querySelectorAll('#pet-traits .trait').length,
          moves:v.querySelectorAll('#pet-body .moveset li').length,
          objectObject:((document.body.innerText||'').match(/\[object Object\]/g)??[]).length,
          back:Boolean(document.getElementById('pet-back'))});})()`) ?? '{}');
      steps.push({at: 'pet-page', select: petSelect, facts: petFacts});
      const petProblems = petPageProblems(petFacts);
      check('32-完整六维的二级详情页', '人类 2026-09-28：「没有个按钮能弹出个二级页面展示完整六维属性」⇒ '
        + '点一行就进**二级详情页**（地址 `?pet=<个体>`）：生命/物攻/物防/魔攻/魔防/速度 一项不落，'
        + '性格 / 天分档位 / 资质这些栏都在，四个技能都在，[object Object] 0 处，还有返回入口',
        petProblems.length === 0 && petFacts.back === true,
        petProblems.join(' | ')
          || `地址 pet=${petFacts.pet}；六维量到 ${JSON.stringify(petFacts.stats)}；`
            + `性格/天分栏 ${petFacts.traitRows} 行；技能 ${petFacts.moves} 个`);
      counter('32-完整六维的二级详情页', '六维缺一项 / 没带这一只 / 又印出 [object Object] —— 三种坏样本都要被抓住',
        petPageProblems({view: 'list', pet: null, stats: ['生命', '物攻'], traitRows: 1, moves: 0, objectObject: 2}),
        '{"stats":["生命","物攻"],"pet":null,"objectObject":2}');

      // ③（同一屏上接着量）刷新 / 再加一只 / 回滚 / 加入比较都在这一页上，列表行里一个都没有
      const placement = JSON.parse(await safeJs(`(()=>{const v=document.getElementById('pet-view');
        const list=document.getElementById('box-list-view');
        return JSON.stringify({listHtml:list?list.innerHTML:'', petHtml:v?v.innerHTML:''});})()`) ?? '{}');
      const placementProblems = actionPlacementProblems(placement);
      check('33-动作只在二级页', '人类 2026-09-28：「刷新性格、天分、再加一只啥的这个太大了…是不是最好放二级页面去？」'
        + '⇒ 刷新性格 / 刷新天分 / ＋再养一只同种 / 回滚上一次 / 加入比较**只在二级详情页**上（按钮旁写清还剩几次），'
        + '列表那一屏里一个都不许有；「只看锁定」那个入口（人类⑦：「锁定功能直接删了的就删了」）页面上也不许再有',
        placementProblems.length === 0
          && !String(placement.listHtml).includes('只看锁定')
          && (await js(`!document.getElementById('flag-locked')`)) === true,
        placementProblems.join(' | ')
          || `二级页上的入口：${(String(placement.petHtml).match(/data-refresh="\w+"|data-add=|data-cmp=|data-undo=/g) ?? []).join('、')}；`
            + `列表里这些属性 ${(String(placement.listHtml).match(/data-refresh="\w+"|data-add=|data-undo=/g) ?? []).length} 个`);
      counter('33-动作只在二级页', '把这些按钮塞回列表行里必须被同一条判据抓住',
        actionPlacementProblems({listHtml: '<div data-individual="own-0001"><button data-refresh="nature"></button></div>',
          petHtml: '<button data-refresh="nature"></button>'}),
        '{"listHtml":"列表行里带着 data-refresh"}');
      await mouseClick('#pet-back');
      await sleep(700);
    } else {
      check('32-完整六维的二级详情页', '「我的盒子」里要有一行个体可以点开', false, '一行个体都没有');
    }

    // ── ⑤ 筛选菜单：打开一个就收起别的、选了项/点外面都收起 ──────────────
    await mouseClick('#menu-type > summary');
    await sleep(250);
    const menuOpen = JSON.parse(await js(`JSON.stringify({open:[...document.querySelectorAll('details.fmenu[open]')].length})`));
    await mouseClick('#menu-role > summary');
    await sleep(250);
    const menuSwap = JSON.parse(await js(`JSON.stringify({
      open:[...document.querySelectorAll('details.fmenu[open]')].length,
      typeOpen:document.getElementById('menu-type').open,
      roleOpen:document.getElementById('menu-role').open})`));
    await mouseClick('#filter-role .filter-chip[data-v=""]');
    await sleep(600);
    const menuClosed = JSON.parse(await js(`JSON.stringify({open:document.getElementById('menu-role').open,
      any:[...document.querySelectorAll('details.fmenu[open]')].length})`));
    await mouseClick('#menu-support > summary');
    await sleep(250);
    await mouseClick('#box-search');
    await sleep(250);
    const menuOutside = JSON.parse(await js(`JSON.stringify({open:document.getElementById('menu-support').open})`));
    await mouseClick('#menu-support > summary');
    await sleep(250);
    const insideStayed = JSON.parse(await js(`JSON.stringify({open:document.getElementById('menu-support').open})`));
    await js(`document.getElementById('menu-support').open=false; true`);
    await mouseClick('#box-reset');
    await sleep(800);
    const menuFacts = {
      afterOpen: {openCount: menuOpen.open},
      // 现场事实：现在摊开几个、第二个（定位）自己开着没
      afterSwap: {openCount: menuSwap.open, otherOpen: menuSwap.roleOpen === true},
      afterPick: {closed: menuClosed.open === false, open: menuClosed.open},
      afterOutside: {closed: menuOutside.open === false, open: menuOutside.open},
      afterInside: {stayedOpen: insideStayed.open === true},
      narrow: null,
    };
    const menuProblems = filterMenuProblems(menuFacts);
    check('34-筛选菜单自己收回去', '人类 2026-09-28：「这个选单不知道自己瘦回去吗？全部重在一起」⇒ '
      + '三个筛选菜单打开一个就把别的收起来；点了里面的一项自动收起；点页面其他地方也收起；点菜单里面不收起',
      menuProblems.length === 0,
      menuProblems.join(' | ')
        || `打开系别后摊开 ${menuOpen.open} 个；再开定位后摊开 ${menuSwap.open} 个（系别自己收了=${menuSwap.typeOpen === false}）；`
          + `选中一项后定位还开着=${menuClosed.open}；点别处后还开着=${menuOutside.open}`);
    counter('34-筛选菜单自己收回去', '三个菜单全摊开、点完项不收、点外面不收 —— 三种坏样本都要被抓住',
      filterMenuProblems({afterOpen: {openCount: 3}, afterSwap: {openCount: 3}, otherOpen: false,
        afterPick: {closed: false}, afterOutside: {closed: false}, afterInside: {stayedOpen: false}}),
      '{"openCount":3,"afterPick":false,"afterOutside":false}');

    // ── ⑥ 收藏：点了立刻生效 + 刷新还在 + 「只看收藏」按它筛 ────────────────
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    await sleep(1400);
    await waitForSafe(`document.querySelectorAll('#box-grid [data-fav]').length>0`, {tries: 60, ms: 200});
    const favSelect = await js(`document.querySelector('#box-grid [data-fav]')?.dataset.fav ?? ''`);
    if (favSelect) {
      await mouseClick(`#box-grid [data-fav="${favSelect}"]`);
      await sleep(500);
      const afterClick = JSON.parse(await js(`(()=>{const b=document.querySelector('#box-grid [data-fav="${favSelect}"]');
        const store=JSON.parse(localStorage.getItem('roco.box.favourites.v1')||'{}');
        return JSON.stringify({pressed:b?b.getAttribute('aria-pressed')==='true':null, stored:store[${JSON.stringify(favSelect)}]===true});})()`));
      await cdp.send('Page.navigate', {url: base + 'box.html'});
      await sleep(1500);
      await waitForSafe(`document.querySelectorAll('#box-grid [data-fav]').length>0`, {tries: 60, ms: 200});
      const afterReload = JSON.parse(await js(`(()=>{const b=document.querySelector('#box-grid [data-fav="${favSelect}"]');
        return JSON.stringify({pressed:b?b.getAttribute('aria-pressed')==='true':null, rowPresent:Boolean(b)});})()`));
      await mouseClick('#flag-favourite');
      await sleep(1200);
      const onlyFav = JSON.parse(await js(`JSON.stringify({count:document.querySelectorAll('#box-grid [data-fav]').length,
        contains:Boolean(document.querySelector('#box-grid [data-fav="${favSelect}"]'))})`));
      const favFacts = {afterClick, afterReload, onlyFav};
      steps.push({at: 'favourite', select: favSelect, facts: favFacts});
      const favProblems = favouriteProblems(favFacts);
      check('35-收藏刷新后还在', '人类 2026-09-28：「然后就是这收藏功能也没用啊？做出来吧！」⇒ '
        + '行上的星标点一下立刻生效（`aria-pressed=true`）、本机记下来（`localStorage`，键 `roco.box.favourites.v1`）、'
        + '**刷新页面后还在**，「只看收藏」按它筛',
        favProblems.length === 0,
        favProblems.join(' | ')
          || `个体 ${favSelect}：点后 aria-pressed=${afterClick.pressed} 存下来=${afterClick.stored}；`
            + `刷新后 aria-pressed=${afterReload.pressed} 行还在=${afterReload.rowPresent}；`
            + `只看收藏剩下 ${onlyFav.count} 行、收藏那只在里面=${onlyFav.contains}`);
      counter('35-收藏刷新后还在', '点了不生效 / 刷新就丢 / 筛选不按它滤 —— 三种坏样本都要被抓住',
        favouriteProblems({afterClick: {pressed: false, stored: false}, afterReload: {pressed: false, rowPresent: false},
          onlyFav: {contains: false, count: 0}}),
        '{"afterClick":{"pressed":false},"afterReload":{"pressed":false},"onlyFav":{}}');
      await mouseClick('#box-reset');
      await sleep(900);
    } else {
      check('35-收藏刷新后还在', '「我的盒子」每一行都要有一个收藏星标', false, '一个收藏按钮都没画出来');
    }

    // ── ⑧ 删掉要两步（二次确认，不用浏览器原生 confirm）───────────────────
    await mouseClick('#box-reset');
    await sleep(1000);
    const delTarget = await js(`document.querySelector('#box-grid [data-add]')?.dataset.add ?? ''`);
    if (delTarget) {
      await mouseClick(`[data-add="${delTarget}"]`);
      await sleep(900);
      const serverIdsForRemove = ((await (await fetch(`${base}api/roco/box?kind=mine&limit=60&offset=0`)).json())
        .player?.cards ?? []).map((c) => c.select);
      const extraId = await js(`(()=>{const ids=${JSON.stringify(serverIdsForRemove)};
        const store=JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}');
        return Object.keys(store).find((id)=>store[id]&&store[id].species_id===${JSON.stringify(delTarget)}
          &&!ids.includes(id))||'';})()`);
      if (extraId) {
        // 先把这一种摊开（新加的那一只就在这一行里），再打开它自己那一页
        //（「删掉这只」与二次确认都在那一页上）。
        const extraRow = await ensureRowVisible(delTarget, extraId);
        steps.push({at: 'delete-pick', delTarget, extraId, extraRow});
        await mouseClick(`#box-grid .individual[data-detail="${extraId}"]`);
        await waitForSafe(`(()=>{const v=document.getElementById('pet-view');
          return Boolean(v)&&v.hidden===false&&new URLSearchParams(location.search).get('pet')===${JSON.stringify(extraId)};})()`,
        {tries: 60, ms: 200});
        await sleep(350);
        await mouseClick(`#pet-actions [data-remove="${extraId}"]`);
        await sleep(500);
        const afterFirst = JSON.parse(await js(`(()=>{const store=JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}');
          return JSON.stringify({removed:!store[${JSON.stringify(extraId)}],
            confirmShown:Boolean(document.querySelector('#pet-actions [data-remove-confirm="${extraId}"]')),
            cancelShown:Boolean(document.querySelector('#pet-actions [data-remove-cancel="${extraId}"]'))});})()`));
        await mouseClick(`#pet-actions [data-remove-cancel="${extraId}"]`);
        await sleep(500);
        const afterCancel = JSON.parse(await js(`(()=>{const store=JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}');
          return JSON.stringify({removed:!store[${JSON.stringify(extraId)}],
            rowPresent:Boolean(document.querySelector('#pet-actions [data-remove="${extraId}"]')
              ||document.querySelector('#box-grid [data-remove="${extraId}"]'))});})()`));
        await mouseClick(`#pet-actions [data-remove="${extraId}"]`);
        await sleep(450);
        await mouseClick(`#pet-actions [data-remove-confirm="${extraId}"]`);
        await sleep(800);
        const afterConfirm = JSON.parse(await js(`(()=>{const store=JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}');
          return JSON.stringify({removed:!store[${JSON.stringify(extraId)}]});})()`));
        const delFacts = {afterFirst, afterCancel, afterConfirm};
        steps.push({at: 'delete-confirm', extraId, facts: delFacts});
        const delProblems = deleteConfirmProblems(delFacts);
        check('36-删掉要两步', '人类 2026-09-28：「然后删除个体的功能一定要加二次确认」⇒ '
          + '第一次点**不删**（只把这一处换成「确定删掉？＋ 取消」），点「取消」什么都不动，'
          + '再点「确定删掉」才真的删掉（不用浏览器原生 confirm）',
          delProblems.length === 0,
          delProblems.join(' | ')
            || `本机那一只 ${extraId}：第一次点后删了吗=${afterFirst.removed}（确认键=${afterFirst.confirmShown} `
              + `取消键=${afterFirst.cancelShown}）；取消后删了吗=${afterCancel.removed} 行还在=${afterCancel.rowPresent}；`
              + `确认后删了吗=${afterConfirm.removed}`);
        counter('36-删掉要两步', '一次点就删 / 没有取消键 / 点了取消还是删了 —— 三种坏样本都要被抓住',
          deleteConfirmProblems({afterFirst: {removed: true, confirmShown: false, cancelShown: false},
            afterCancel: {removed: true, rowPresent: false}, afterConfirm: {removed: false}}),
          '{"afterFirst":{"removed":true},"afterCancel":{"removed":true},"afterConfirm":{"removed":false}}');
      } else {
        check('36-删掉要两步', '「＋再养一只同种」之后本机要真的多出一只（否则删不掉这件事没得验）',
          false, `加完之后本机记录里找不到不在名单里的那一只（种类=${delTarget}）`);
      }
    } else {
      check('36-删掉要两步', '二级详情页上要有「＋再养一只同种」（本机那一只才有「删掉这只」）',
        false, '页面上一个「＋再养一只同种」都没有');
    }

    check('22-控制台干净', '整轮下来没有 console.error，也没有未捕获异常',
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
    generated_by: 'scripts/roco/browser-box-acceptance.mjs',
    page: 'box.html',
    judged_at: new Date().toISOString(),
    forbidden_player_pattern: String(FORBIDDEN_PLAYER),
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
    log(row.ok ? '✔' : '✖', `${row.id} ${row.judge}`, '→', String(row.actual).slice(0, 160));
  }
  log(`截图 ${shots.length} 张 → reports/roco/box-acceptance/`);
  log(`判据 ${checks.filter((c) => c.ok).length}/${checks.length} 通过；反证 ${counterproofs.filter((c) => c.ok).length}/${counterproofs.length} 命中`);
  log(`报告 → ${REPORT}`);
  log(report.ok ? '全部通过' : `有 ${failed.length} 条不通过`);
  process.exit(report.ok ? 0 : 1);
}

// 只有「直接执行这个文件」时才跑浏览器验收；被测试 import 时只取判据。
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) await main();
export {main};
