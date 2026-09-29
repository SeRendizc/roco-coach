#!/usr/bin/env node
// Lead 的产品验收台（2026-09-29 接续对话）。
//
// 它跟本仓别的脚本有什么不同
// --------------------------
// 这一程的硬要求是「实查真实 8765 页面 + 网络读到的版本」，所以本脚本：
//   ① **默认打真实的 http://127.0.0.1:8765**（不自己起实例）—— 因为 8765 服务的
//      `/src/client/**` 是**每次请求读盘**的静态文件（已实测：与工作区逐字节相同），
//      所以工作区改完就在用户那一页生效，**不需要重启**。脚本每次跑都重新对一次账，
//      把「屏幕上跑的是哪一版」写进读数，而不是靠 `started_at` 推断。
//   ② **只用自己那条会话**：固定持久 profile（`tmp/browser-profile-lead`），cookie 复用
//      ⇒ 不给 8765 的会话表添新条目（那张表的 LRU 修复**没有**部署到在跑的进程里）。
//   ③ 前置三条照做：`--disable-background-networking`、`--disable-component-update`、
//      异常/超时在 `finally` 里 `browser.close()`。
//
// 用法：
//   node scripts/roco/lead-product-acceptance.mjs                 # 全跑（默认 1440×900）
//   node scripts/roco/lead-product-acceptance.mjs --viewport 390x844
//   node scripts/roco/lead-product-acceptance.mjs --only=u05
//   node scripts/roco/lead-product-acceptance.mjs --shots=docs/roco/review-2026-09-28/shots/lead

import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {launchProbeChrome, PROBE_ROOT} from './lib/probe-session.mjs';
// **独立复算**用：Node 侧拿同一份冻结真值算一遍，再与屏幕上读到的比。
// 注意这不是"用被测代码验被测代码"——被测的是**DOM 上写出来的值**（`rel` / 文案 / 倍率），
// 这里算的是"按数据应该是多少"，两边对不上就是渲染层错了。
import {incomingAffinity} from '../../src/client/type-affinity.js';

const BASE = process.env.ROCO_BASE ?? 'http://127.0.0.1:8765';
const PROFILE = join(PROBE_ROOT, 'tmp', 'browser-profile-lead');
const OUT_DIR = join(PROBE_ROOT, 'reports', 'roco', 'lead-product');

const argOf = (name, fallback = null) => {
  for (let i = 0; i < process.argv.length; i += 1) {
    const a = process.argv[i];
    if (a === `--${name}`) {
      // `--name value` 与 `--name=value` 两种都认（第一版只认后者，`--viewport 390x844`
      // 会被读成 `true` ⇒ `NaN` 宽高 ⇒ CDP 报 Invalid parameters）。
      const next = process.argv[i + 1];
      return next && !next.startsWith('--') ? next : true;
    }
    if (a.startsWith(`--${name}=`)) return a.slice(a.indexOf('=') + 1);
  }
  return fallback;
};
const VIEWPORT = String(argOf('viewport', '1440x900'));
const ONLY = argOf('only', null);
const SHOT_DIR = String(argOf('shots', 'docs/roco/review-2026-09-28/shots/lead'));
const wants = (id) => !ONLY || String(ONLY).split(',').includes(id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIRECTION_TO_REL = {threat: 'down', resist: 'up', neutral: 'none', unknown: 'unknown'};

/**
 * Node 侧独立复算：按页面读到的**属性**算一遍期望，再与 DOM 上真的写着的值逐个比。
 * `known:false`（组合未登记）时文案应当是空的、三角应当是 `unknown`。
 */
function crossCheckAffinity(reading) {
  const foeTypes = reading?.foeTypes ?? [];
  const rows = (reading?.rows ?? []).map((row) => {
    const a = incomingAffinity(row.petTypes ?? [], foeTypes);
    const expectedRel = DIRECTION_TO_REL[a.direction];
    const expectedText = a.known ? a.label : '';
    return {
      name: row.name, petTypes: row.petTypes, expectedRel, onScreenRel: row.rel,
      expectedText, onScreenText: row.text, expectedMult: a.worst ? String(a.worst.multiplier) : '',
      onScreenMult: row.mult ?? '',
      match: expectedRel === row.rel && expectedText === row.text
        && (!a.worst || String(a.worst.multiplier) === String(row.mult ?? '')),
    };
  });
  const threat = (() => {
    const a = incomingAffinity(reading?.activeTypes ?? [], foeTypes);
    const expectedRel = DIRECTION_TO_REL[a.direction];
    return {activeTypes: reading?.activeTypes ?? [], expectedRel, expectedText: a.known ? a.label : '',
      onScreenRel: reading?.threat?.direction ?? null, onScreenText: reading?.threat?.text ?? '',
      hidden: reading?.threat?.hidden ?? null,
      match: (reading?.threat?.hidden === true) === !a.known};
  })();
  return {rows, threat, allRowsMatch: rows.every((r) => r.match), noUnknownLeak: rows.every((r) => r.petTypes?.length ? true : r.onScreenRel === 'unknown')};
}

/** 极简 CDP 客户端（本仓既有脚本都是这个写法，不引新依赖）。 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });
  ws.addEventListener('message', (event) => {
    let msg = null;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    if (!msg.id) return;
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? null)})`));
    else slot.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, {resolve, reject});
    ws.send(JSON.stringify({id: seq, method, params}));
    setTimeout(() => {
      if (pending.delete(seq)) reject(new Error(`CDP 超时：${method}`));
    }, 30000);
  });
  const js = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面内抛错：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result?.value;
  };
  return {ws, send, js, close: () => { try { ws.close(); } catch { /* 已关 */ } }};
}

/** 屏幕上的小芽入口：**可见**（有盒子、不在 hidden 祖先里）且文字里有「小芽」的按钮/链接。 */
const XIAOYA_ENTRY_EXPR = `
  const visible = (el) => {
    if (!el) return false;
    if (el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05;
  };
  const nodes = [...document.querySelectorAll('button,a,[role="button"]')].filter((el) => {
    const t = (el.textContent || '').replace(/\\s+/g, '');
    return t.includes('小芽') && visible(el);
  });
  return {
    count: nodes.length,
    rows: nodes.map((el) => ({id: el.id || null, cls: el.className || null,
      text: (el.textContent || '').trim().slice(0, 12),
      rect: (() => { const r = el.getBoundingClientRect(); return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; })()})),
  };
`;

/** 屏幕上的相性 + 它依据的**原始局面**（Node 侧要拿它独立复算，不信 DOM 自述）。 */
const AFFINITY_EXPR = `
  const demo = window.rocoDemo;
  const view = demo?.state?.view ?? null;
  const typesOf = (p) => Array.isArray(p?.types) ? p.types.filter(Boolean) : (p?.type ? [p.type] : []);
  const root = document.querySelector('[data-b3-root]');
  if (!root || !view) return {error: 'b3-root 或 rocoDemo.state.view 不在页面上'};
  const self = Array.isArray(view.self?.pets) ? view.self.pets : [];
  const active = Number.isInteger(view.self?.active) ? view.self.active : 0;
  const bench = self.map((p, idx) => ({p, idx})).filter(({idx}) => idx !== active);
  const rows = [...root.querySelectorAll('[data-b3-switch-row]')].map((cell, i) => {
    const item = bench[i] ?? null;
    const name = cell.querySelector('[data-b3-switch-name]')?.textContent?.trim() ?? null;
    const pet = item ? item.p : (self.find((p) => p.name === name) ?? null);
    return {
      row: i, name,
      petTypes: pet ? typesOf(pet) : null,
      rel: cell.querySelector('[data-b3-rel]')?.dataset?.b3Rel ?? null,
      mult: cell.querySelector('[data-b3-rel]')?.dataset?.b3AffinityMult ?? null,
      text: cell.querySelector('[data-b3-switch-rel-text]')?.textContent?.trim() ?? '',
      legal: cell.dataset.b3SwitchLegal ?? null,
    };
  });
  const threatEl = root.querySelector('[data-b3-self-threat]');
  return {
    turn: view.turn ?? null,
    stateVersion: view.state_version ?? null,
    battleResult: view.battle_result ?? null,
    activeName: self[active]?.name ?? null,
    activeTypes: self[active] ? typesOf(self[active]) : null,
    foeName: view.opponent?.field?.name ?? null,
    foeTypes: typesOf(view.opponent?.field),
    legalSwitchTargets: (view.legal ?? []).filter((a) => a.kind === 'switch').map((a) => a.target_index),
    threat: threatEl ? {hidden: threatEl.hidden, direction: threatEl.dataset.b3SelfThreat ?? null,
      text: threatEl.textContent.trim(), title: threatEl.title || ''} : null,
    rows,
  };
`;

/** 页面侧的动作：开局 / 走一手 / 走到底。都走页面自己的实现，不另写一套。 */
const START_BATTLE_EXPR = `
  const demo = window.rocoDemo;
  if (!demo) return {ok: false, why: 'rocoDemo 不在'};
  demo.state.seedOverride = 7;
  await demo.startBattle();
  return {ok: true, turn: demo.state.view?.turn ?? null, self: demo.state.view?.self?.pets?.length ?? null,
    battleId: demo.state.battleId ?? null, firstTurn: demo.state.view?.turn ?? null};
`;

const STEP_EXPR = `
  const demo = window.rocoDemo;
  const view = demo?.state?.view ?? null;
  if (!view) return {ok: false, why: '没有局面'};
  if (view.battle_result) return {ok: true, done: true, result: view.battle_result, turn: view.turn};
  if (Array.isArray(view.legal) && view.legal.length) await demo.playAction(view.legal[0]);
  else await demo.autoTurn();
  const after = demo.state.view ?? null;
  return {ok: true, done: Boolean(after?.battle_result), result: after?.battle_result ?? null, turn: after?.turn ?? null};
`;

/**
 * 六宠局（**用户实际在玩的那一档**）的准备：走产品页自己的「盒子→带上六只去配队」路径 ——
 * `?team=own-…,own-…`（`teamFromUrl()` 就是这么读的），然后点**真按钮** `#start-standard-pvp`。
 * 不走 `startBattle()`：那一条在 `state.pick.player.length !== 3` 时会退化成引擎默认队伍（实测 3 宠）。
 */
const SIX_PET_IDS_EXPR = `
  const w = await (await fetch('/api/roco/workshop', {cache: 'no-store'})).json();
  const found = new Set();
  const walk = (node, depth) => {
    if (depth > 7 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.slice(0, 80).forEach((v) => walk(v, depth + 1)); return; }
    for (const v of Object.values(node)) {
      if (typeof v === 'string' && /^own-\\d+$/.test(v)) found.add(v);
      else walk(v, depth + 1);
    }
  };
  walk(w, 0);
  return {ids: [...found].slice(0, 6), total: found.size};
`;

const CLICK_STANDARD_PVP_EXPR = `
  const demo = window.rocoDemo;
  const btn = document.getElementById('start-standard-pvp');
  if (!btn) return {ok: false, why: '没有 #start-standard-pvp'};
  const team = Array.isArray(demo.state.teamWorkshop?.team) ? demo.state.teamWorkshop.team : [];
  const fieldable = team.filter((id) => typeof id === 'string' && id.startsWith('own-')).length;
  const before = {disabled: btn.disabled, mode: btn.dataset.rocoStartMode ?? null, team: team.length, fieldable};
  if (btn.disabled) return {ok: false, why: '开局按钮禁用', before, label: btn.textContent};
  btn.click();
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const v = demo.state.view;
    if (v && Number.isInteger(v.turn) && Array.isArray(v.self?.pets) && v.self.pets.length >= 6) {
      return {ok: true, before, label: btn.textContent, pets: v.self.pets.length, turn: v.turn,
        battleId: demo.state.battleId};
    }
  }
  return {ok: false, why: '点了之后 15 秒里没进六宠局', before,
    now: {pets: demo.state.view?.self?.pets?.length ?? null, turn: demo.state.view?.turn ?? null},
    note: document.getElementById('standard-pvp-note')?.textContent ?? ''};
`;

/** U09：军师浮条此刻在屏幕上的全文（含那条「依据：」）。 */
const HINT_EXPR = `
  const box = document.getElementById('hint');
  if (!box) return {exists: false};
  const text = document.getElementById('hint-text')?.textContent?.trim() ?? '';
  const why = document.getElementById('hint-why')?.textContent?.trim() ?? '';
  // 门控层的**原始判定**：区分「安静是因为没价值」与「被我的门控改哑了」。
  // state.lastDetail 就是 refreshHint() 写下的那一份，不是脚本另算的。
  const detail = window.rocoDemo?.state?.lastDetail ?? null;
  const advice = detail?.advice ?? null;
  return {exists: true, hidden: box.hidden, text, why,
    body: document.getElementById('hint-body')?.textContent?.trim() ?? '',
    rocoHint: document.body.dataset.rocoHint ?? null,
    rocoGate: document.body.dataset.rocoGate ?? null,
    rocoAction: document.body.dataset.rocoAction ?? null,
    codeLeak: /^依据：[a-z][a-z0-9_-]*$/.test(why),
    // ⚠⚠ 2026-09-29 **读数口必须分开**：body.dataset.rocoAction / rocoGate 是
    //   **渲染层门控之后**的值（我自己的 gate 会把它改写成 silent/理由），而
    //   state.lastDetail 才是**门控层原样**的判定。第一版混用了这两个来源，
    //   于是把「客户端按规矩拦下一条没内容的建议」读成了「门控层判它沉默」——
    //   结论完全反了。下面这两个字段一律从 state.lastDetail 读。
    rawAction: detail?.action ?? null,
    rawGate: detail?.gate ?? null,
    rawReason: detail?.reason ?? null,
    adviceSource: detail?.advice_source ?? null,
    speakBlockedBy: detail?.speak_blocked_by ?? null,
    unavoidable: detail?.unavoidable ?? null,
    // 建议层到底开没开口（结构化那一份）
    adviceKind: advice?.kind ?? null,
    adviceText: typeof advice?.text === 'string' ? advice.text : null,
    adviceRisk: typeof advice?.risk === 'string' ? advice.risk : null,
    adviceReasonCode: detail?.reason ?? null,
    adviceScore: Number.isFinite(detail?.value) ? detail.value : null,
    adviceFloor: Number.isFinite(detail?.floor) ? detail.floor : null,
    adviceDecisive: detail?.decisive === true,
    docHeight: document.documentElement.scrollHeight,
  };
`;

/** U10：结算框与复盘卡的位置关系 + 页面是否被挤长。 */
const RESULT_EXPR = `
  const card = document.getElementById('battle-result-card');
  const lesson = document.getElementById('lesson-card');
  const box = card?.querySelector('.roco-result-box') ?? null;
  const docH = document.documentElement.scrollHeight;
  return {
    resultVisible: card ? !card.hidden : null,
    lessonExists: Boolean(lesson),
    lessonInsideResult: Boolean(card && lesson && card.contains(lesson)),
    lessonHidden: lesson ? lesson.hidden : null,
    lessonVisible: lesson ? (!lesson.hidden && lesson.getBoundingClientRect().height > 4) : null,
    docHeight: docH,
    boxRect: box ? (() => { const r = box.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top)}; })() : null,
    actionsSticky: Boolean(box?.querySelector('.roco-result-actions')),
    reviewText: {
      question: document.getElementById('lesson-question')?.textContent?.trim() ?? '',
      learning: document.getElementById('lesson-learning')?.textContent?.trim() ?? '',
      progress: document.getElementById('lesson-progress')?.textContent?.trim() ?? '',
      note: document.getElementById('lesson-note')?.textContent?.trim() ?? '',
    },
    verdict: document.getElementById('battle-result-verdict')?.textContent?.trim() ?? '',
  };
`;

/** U06：战报的可读性 —— 主句 / 降级说明的**文本完整性**（拆了但一个字都没丢）。 */
const LOG_EXPR = `
  const root = document.querySelector('[data-b3-root]');
  const scroll = root?.querySelector('[data-b3-log-scroll]');
  if (!scroll) return {error: 'b3-log-scroll 不在页面上'};
  const lines = [...scroll.querySelectorAll('[data-b3-log-line]')];
  const rows = lines.map((p) => {
    const caveat = p.querySelector('[data-b3-log-caveat]');
    return {
      full: p.textContent.trim(),
      hasCaveat: p.dataset.b3LogHasCaveat === 'yes',
      main: caveat ? p.textContent.replace(caveat.textContent, '').trim() : p.textContent.trim(),
      caveat: caveat ? caveat.textContent.trim() : null,
      // 小字必须真的比正文小（不是只加了个 class）
      fontSize: getComputedStyle(caveat ?? p).fontSize,
      mainFontSize: getComputedStyle(p).fontSize,
    };
  });
  return {
    total: rows.length,
    withCaveat: rows.filter((r) => r.hasCaveat).length,
    // 反例判据：拆过的那几行，正文+说明拼起来必须与整行逐字相同（不许丢字）
    lossless: rows.filter((r) => !r.hasCaveat
      || r.full === (r.main + (r.caveat ?? '')).trim()
      || r.full.replace(/\\s/g, '') === (r.main + (r.caveat ?? '')).replace(/\\s/g, '')),
    engineJargon: rows.filter((r) => /per_use_ramp|引擎事件|本页还没有它的中文说法/.test(r.full)).map((r) => r.full),
    samples: rows.slice(0, 6).map((r) => ({caveat: r.hasCaveat, main: r.main.slice(0, 60), note: (r.caveat ?? '').slice(0, 40),
      size: r.fontSize, mainSize: r.mainFontSize})),
  };
`;

/**
 * 下一局迁移（主线）：**旧局建议清掉、训练目标留下**。
 *
 * U10 验收原文：「正常开下一局清掉旧局建议，训练目标保留且可验证」。
 * 这一条读**真实状态**，不看文案：
 *   · 旧局残留：`#lesson-card.hidden` / `#hint.hidden` / `rocoDemo.state.hint`；
 *   · 训练目标：`state.memory` 里那条记录还在不在；
 *   · 新局确实开了：`state.view.turn === 1` 且 `battle_id` 换了。
 */
const MIGRATION_EXPR = `
  const demo = window.rocoDemo;
  const mem = demo.state.memory ?? {};
  const blob = JSON.stringify(mem);
  const lesson = document.getElementById('lesson-card');
  return {
    turn: demo.state.view?.turn ?? null,
    battleResult: demo.state.view?.battle_result ?? null,
    battleId: demo.state.battleId ?? null,
    lessonHidden: lesson?.hidden ?? null,
    lessonVisible: lesson ? (!lesson.hidden && lesson.getBoundingClientRect().height > 4) : null,
    hintHidden: document.getElementById('hint')?.hidden ?? null,
    stateHintIsNull: demo.state.hint === null || demo.state.hint === undefined,
    memoryKeys: Object.keys(mem),
    memoryBytes: blob.length,
    // 训练目标/复盘痕迹：这两样**必须活过换局**
    memoryHasTeacher: /teacher|lesson|goal/i.test(blob),
    teacherGoalHook: document.body.dataset.rocoTeacherGoal ?? null,
    teacherPointHook: document.body.dataset.rocoTeacherPoint ?? null,
  };
`;

/** 屏幕上跑的是哪一版：逐个静态资源算 sha256，与磁盘比。 */
async function reconcileVersion(cdp) {
  return cdp.js(`
    const files = ['src/client/roco.html','src/client/roco.js','src/client/xiaoya.js','src/client/roco.css',
      'src/client/battle-v3.css','src/client/type-affinity.js','src/client/type-affinity.data.js','src/client/box.js'];
    const out = {};
    for (const f of files) {
      try {
        const r = await fetch('/' + f, {cache: 'no-store'});
        const t = await r.text();
        out[f] = {status: r.status, bytes: t.length};
      } catch (e) { out[f] = {status: 0, error: String(e)}; }
    }
    out['/api/bootstrap'] = await (async () => {
      const r = await fetch('/api/bootstrap', {cache: 'no-store'});
      const j = await r.json();
      return {runtimeVersion: j.runtimeVersion, model: j.model, provider: j.provider,
        configured: j.configured, verified: j.verified, started_at: j.started_at};
    })();
    return out;
  `);
}

function sha256File(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; }
}

async function snapshot(cdp, name, {fullPage = false} = {}) {
  mkdirSync(join(PROBE_ROOT, SHOT_DIR), {recursive: true});
  const params = {format: 'png'};
  if (fullPage) params.captureBeyondViewport = true;
  const shot = await cdp.send('Page.captureScreenshot', params);
  const path = join(PROBE_ROOT, SHOT_DIR, `${name}.png`);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  return path;
}

async function gotoAndWait(cdp, url) {
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', {url});
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    const ready = await cdp.js('return document.readyState;').catch(() => null);
    if (ready === 'complete') break;
  }
  await sleep(600);
}

async function main() {
  const [winW, winH] = VIEWPORT.split('x').map(Number);
  const readings = {
    at: new Date().toISOString(),
    base: BASE,
    viewport: VIEWPORT,
    servedVersion: null,
    workspaceHeads: {},
    checks: {},
  };
  let cdp = null;
  let chrome = null;
  try {
    chrome = await launchProbeChrome({
      profileDir: PROFILE,
      windowSize: `${winW},${winH}`,
      extraArgs: ['--disable-background-networking', '--disable-component-update',
        '--disable-sync', '--no-default-browser-check'],
    });
    cdp = await connect(chrome.wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // ⚠⚠ 2026-09-29 **必须禁缓存**：持久 profile + HTTP 缓存会让页面执行**上一轮**的模块，
    //   而 `workspaceHeads` 那条比对量的是**服务端**发出来的是什么（`cache:'no-store'`），
    //   量不到"浏览器**执行**的是哪一份"。第一次跑 U09 复验时就被这个坑到过：
    //   服务端的 `experience.js` 早就是新版（含 `unavoidable`），而页面跑的是缓存的旧模块 ⇒
    //   读数与 T2 的临时实例结论矛盾。禁掉缓存之后两边才可比。
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', {cacheDisabled: true});
    await cdp.send('Emulation.setDeviceMetricsOverride',
      {width: winW, height: winH, deviceScaleFactor: 1, mobile: winW < 500});

    await gotoAndWait(cdp, `${BASE}/roco.html`);
    readings.servedVersion = await reconcileVersion(cdp);
    // 与磁盘逐个比：屏幕上那一份是不是工作区这一份（不是靠 started_at 推断）。
    for (const f of ['src/client/roco.html', 'src/client/roco.js', 'src/client/xiaoya.js',
      'src/client/roco.css', 'src/client/battle-v3.css', 'src/client/type-affinity.js',
      'src/client/type-affinity.data.js', 'src/client/box.js']) {
      const served = await cdp.js(`const r = await fetch('/${f}',{cache:'no-store'}); return await r.text();`);
      const disk = readFileSync(join(PROBE_ROOT, f), 'utf8');
      readings.workspaceHeads[f] = {servedEqualsDisk: served === disk, servedBytes: served.length,
        diskBytes: disk.length, diskSha256: sha256File(join(PROBE_ROOT, f))};
    }

    if (wants('u07')) {
      readings.checks.u07 = {beforeOpen: await cdp.js(XIAOYA_ENTRY_EXPR)};
      await snapshot(cdp, 'u07-before');
    }

    // ── U05 / U09 / U10：真打一局 ────────────────────────────────────────────
    if (wants('u05') || wants('u09') || wants('u10') || wants('u06') || wants('next')) {
      // `--six`：走**用户实际在玩的那一档**（六宠 · 从盒子带六只过来），而不是引擎默认队伍。
      let started = null;
      if (argOf('six', false) === true || argOf('six', false) === '1') {
        const pool = await cdp.js(SIX_PET_IDS_EXPR);
        readings.checks.sixPetPool = pool;
        if (!pool?.ids || pool.ids.length < 6) {
          readings.checks.start = {ok: false, why: `只找到 ${pool?.ids?.length ?? 0} 个 own- 个体`, pool};
        } else {
          await gotoAndWait(cdp, `${BASE}/roco.html?team=${pool.ids.join(',')}`);
          // 等工作台真的把六槽填上（它是异步读 /api/roco/workshop 的）
          let waited = 0;
          for (; waited < 40; waited += 1) {
            const n = await cdp.js('return window.rocoDemo?.state?.teamWorkshop?.team?.length ?? 0;');
            if (n === 6) break;
            await sleep(300);
          }
          readings.checks.sixPetWaitTicks = waited;
          started = await cdp.js(CLICK_STANDARD_PVP_EXPR);
          readings.checks.start = started;
          if (started?.ok) {
            // 切到「更换」页签，让换人面板**真的显示**（否则截图上是一片技能格）
            await cdp.js(`
              const tab = document.querySelector('[data-b3-tab="switch"]');
              if (tab) tab.click();
              return document.body.dataset.b3Tab ?? null;
            `);
            await sleep(400);
          }
        }
      } else {
        started = await cdp.js(START_BATTLE_EXPR);
        readings.checks.start = started;
      }
      if (wants('u05')) {
        readings.checks.u05 = {before: await cdp.js(AFFINITY_EXPR)};
        readings.checks.u05.beforeCrossCheck = crossCheckAffinity(readings.checks.u05.before);
        await snapshot(cdp, 'u05-before-switch');
        const switched = await cdp.js(`
          const demo = window.rocoDemo;
          const v = demo?.state?.view ?? null;
          const act = (v?.legal ?? []).find((a) => a.kind === 'switch');
          if (!act) return {ok: false, why: '这一手没有合法的换人动作'};
          await demo.playAction(act);
          return {ok: true, target: act.target_index, turn: demo.state.view?.turn ?? null,
            active: demo.state.view?.self?.active ?? null,
            activeName: demo.state.view?.self?.pets?.[demo.state.view.self.active]?.name ?? null};
        `);
        readings.checks.u05.switched = switched;
        readings.checks.u05.after = await cdp.js(AFFINITY_EXPR);
        readings.checks.u05.afterCrossCheck = crossCheckAffinity(readings.checks.u05.after);
        readings.checks.u05.affinityChangedAfterSwitch = JSON.stringify(readings.checks.u05.before.rows)
          !== JSON.stringify(readings.checks.u05.after.rows);
        readings.checks.u05.activeChangedAfterSwitch = readings.checks.u05.before.activeName
          !== readings.checks.u05.after.activeName;
        await snapshot(cdp, 'u05-after-switch');
      }
      if (wants('u06')) {
        // 走 12 手，让战报里出现足够多「带未核验说明」的句子。
        for (let i = 0; i < 12; i += 1) {
          const step = await cdp.js(STEP_EXPR);
          if (step?.done) break;
        }
        await sleep(400);
        readings.checks.u06 = await cdp.js(LOG_EXPR);
        await snapshot(cdp, 'u06-battle-log');
      }
      if (wants('next')) {
        // 主线：**下一局迁移** —— 旧局建议清掉、训练目标留下。
        let guard = 0;
        for (; guard < 90; guard += 1) { const step = await cdp.js(STEP_EXPR); if (step?.done) break; }
        await sleep(900);
        const before = await cdp.js(MIGRATION_EXPR);
        // 走**产品自己的出口**：局末弹框的「再来一局（配队）」→ returnHome()。
        const clicked = await cdp.js(`
          const btn = document.getElementById('battle-result-again');
          if (!btn) return {ok: false, why: '没有 #battle-result-again'};
          btn.click();
          await new Promise((r) => setTimeout(r, 500));
          return {ok: true, view: Boolean(window.rocoDemo.state.view), battleId: window.rocoDemo.state.battleId};
        `);
        await sleep(500);
        const afterHome = await cdp.js(MIGRATION_EXPR);
        // 再开一局：六宠优先（真按钮），否则走 startBattle()
        await cdp.js(SIX_PET_IDS_EXPR).then(async (pool) => {
          if (pool?.ids?.length >= 6 && argOf('six', false)) {
            await gotoAndWait(cdp, `${BASE}/roco.html?team=${pool.ids.join(',')}`);
            for (let i = 0; i < 40; i += 1) {
              const n = await cdp.js('return window.rocoDemo?.state?.teamWorkshop?.team?.length ?? 0;');
              if (n === 6) break;
              await sleep(300);
            }
            await cdp.js(CLICK_STANDARD_PVP_EXPR);
          } else {
            await cdp.js(START_BATTLE_EXPR);
          }
        });
        await sleep(1200);
        const afterNew = await cdp.js(MIGRATION_EXPR);
        readings.checks.nextMatch = {
          turnsToFinish: guard, clicked, before, afterReturnHome: afterHome, afterNew,
          // 判据：新局 turn=1、battle_id 换了、lesson 收起、hint 收起、训练目标内存还在
          verdict: {
            newTurnIsOne: afterNew?.turn === 1,
            battleIdChanged: Boolean(before?.battleId && afterNew?.battleId
              && before.battleId !== afterNew.battleId),
            lessonCleared: afterNew?.lessonVisible === false,
            hintCleared: afterNew?.hintHidden === true && afterNew?.stateHintIsNull === true,
            trainingGoalKept: afterNew?.memoryHasTeacher === true,
          },
        };
        await snapshot(cdp, 'next-match');
      }
      if (wants('u09')) {
        // ⚠ 无头 Chrome 的 `document.hasFocus()` 恒为 false ⇒ 门控层的**硬门控** `window-unfocused`
        //   会把每一条主动提醒都拦掉（实测 24/24）。那是探针环境的问题，不是产品行为：
        //   真人开着窗口时这一条不成立。所以这里**把焦点条件补上**（只覆盖这一个读法，
        //   不动门控逻辑），否则"气泡安不安静"根本量不到"该说话时它说了什么"。
        const focusPatch = await cdp.js(`
          const before = document.hasFocus();
          document.hasFocus = () => true;
          return {before, after: document.hasFocus()};
        `);
        const hints = [];
        for (let i = 0; i < 24; i += 1) {
          const step = await cdp.js(STEP_EXPR);
          const hint = await cdp.js(HINT_EXPR);
          hints.push({i, turn: step?.turn ?? null, done: Boolean(step?.done), ...hint});
          if (step?.done) break;
        }
        readings.checks.u09 = {
          focusPatch,
          turnsPlayed: hints.length,
          docHeightSeries: hints.map((h) => h.docHeight),
          docHeightStable: new Set(hints.map((h) => h.docHeight)).size === 1,
          // 「安静」的**可证伪**读法：逐手记门控层的原始判定 + 建议层有没有结构化开口。
          // 只有"建议层没开口 / 开口了但没有 kind"才算"没价值所以安静"；
          // 若 `adviceKind` 一直非空而气泡仍不显示，那就是**我的门控改哑了**（反例）。
          perTurn: hints.map((h) => ({turn: h.turn,
            action: h.rawAction, gate: h.rawGate, reason: h.rawReason,
            renderedGate: h.rocoGate, renderedAction: h.rocoAction,
            visible: h.hidden === false, adviceKind: h.adviceKind,
            adviceSource: h.adviceSource, speakBlockedBy: h.speakBlockedBy, unavoidable: h.unavoidable,
            value: h.adviceScore, floor: h.adviceFloor, decisive: h.adviceDecisive})),
          // 「该说话而没说」的判据：分数过线（或 decisive）却仍然不显示 ⇒ 要么被门控拦，
          // 要么被我们这一层拦。两者要能分开。
          aboveFloorTurns: hints.filter((h) => h.adviceDecisive === true
            || (Number.isFinite(h.adviceScore) && Number.isFinite(h.adviceFloor) && h.adviceScore >= h.adviceFloor))
            .map((h) => ({turn: h.turn, value: h.adviceScore, floor: h.adviceFloor, decisive: h.adviceDecisive,
              gate: h.rocoGate, action: h.rocoAction, visible: h.hidden === false})),
          gateHistogram: hints.reduce((acc, h) => { const k = `${h.rocoGate ?? 'null'}|${h.rocoAction ?? 'null'}`;
            acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
          adviceKindsSeen: [...new Set(hints.map((h) => h.adviceKind).filter(Boolean))],
          // 反例探针：建议层开口过、而屏幕上却一条都没有 ⇒ 我的门控把它拦掉了。
          gateSwallowedAdvice: hints.filter((h) => h.adviceKind && h.hidden !== false)
            .map((h) => ({turn: h.turn, adviceKind: h.adviceKind, gate: h.rocoGate})),
          bubbles: hints.filter((h) => h.hidden === false).map((h) => ({turn: h.turn, text: h.text, why: h.why, action: h.rocoAction, gate: h.rocoGate})),
          codeLeaks: hints.filter((h) => h.codeLeak).map((h) => ({turn: h.turn, why: h.why})),
          uselessSentence: hints.filter((h) => h.text.includes('值得留到局后')).map((h) => h.turn),
          lastTurn: hints.at(-1)?.turn ?? null,
          finished: hints.at(-1)?.done === true,
        };
        await snapshot(cdp, 'u09-end');
      }
      if (wants('u10')) {
        // 走到底（U09 那一段可能已经打完了；没有就继续）。
        let guard = 0;
        for (; guard < 80; guard += 1) {
          const step = await cdp.js(STEP_EXPR);
          if (step?.done) break;
        }
        await sleep(1200);
        readings.checks.u10 = {turnsToFinish: guard, ...(await cdp.js(RESULT_EXPR))};
        await snapshot(cdp, 'u10-result');
      }
    }

    writeFileSync(join(OUT_DIR, `readings-${VIEWPORT}.json`), JSON.stringify(readings, null, 2));
    process.stdout.write(`${JSON.stringify(readings, null, 2)}\n`);
    return 0;
  } finally {
    // 前置第三条：**异常也必须收尾**（不留专用 profile 的 Chrome）。
    try { cdp?.close(); } catch { /* 已关 */ }
    try { chrome?.close(); } catch { /* 已退 */ }
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`FAILED ${error?.stack ?? error}\n`);
  process.exit(1);
});
