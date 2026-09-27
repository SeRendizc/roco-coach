// 工坊「队伍」六张卡的**版式判据**（真无头 Chrome，两档视口）。
//
// 起因（产品负责人给的截图，2026-09-26）：训练场 `roco.html` 左侧「队伍」六张已选精灵卡 ——
//   · 第 1～3 张里的字互相压住 / 被卡片边缘截断（「特性：『静电』」那一行叠在别的字上）；
//   · 第 4～6 张比前三张矮，少了「换招 / 引擎规范配招」那两行；
//   · 第 6 张右下角一坨糊字（其实是面板页脚的「清空阵容」压在卡片上）。
// 真机实测到四条**可量化的成因**（都在 `src/client/team-workshop.js`）：
//   ① `.tw-slots{grid-auto-rows:minmax(232px,1fr)}` 在 1536×684 下只拿到 402.2px 高，
//      两行 232px + 8px 间距 = 472px 装不下 → 第二行整排溢出到面板页脚（「清空阵容」被压住）；
//   ② 卡片自己 `overflow:hidden`：内容实测 277～294px > 卡高 232px → 「详情」那行从中间被裁掉
//      （越界 38.3px），配招按钮被裁 6.8px；
//   ③ 卡内是 flex 列，子项默认 `flex-shrink:1` → 名字行从 51px 被压到 42px，
//      而里面的「移除」按钮是 44px（拇指硬判据）→ 按钮溢出自己那一行，压到下面的字上；
//   ④ `loadoutRowHtml()` 在「物种解析不出来」时**整行 `return ''`** —— 图鉴/按需推算的物种、
//      以及持有名单里**重名**的物种（实测「棋契陛下」= own-0042/pet_000556 与 own-0043/pet_000575）
//      都解析不出 → 有的卡有这一行、有的没有，六张卡结构不一致。
//      （同一个 `speciesOfSlot()` 才是「是不是我持有的」的唯一判据：卡片上那枚状态标也必须用它，
//        公开层按架构约束**不带** `species_id`，用 `slot.species_id` 判会恒为假。）
//
// 所以这一份判据断言四件事，两档视口各来一遍：
//   ① 六张卡两两不相交；
//   ② 卡内每个**可见**文字节点的 rect 都在所属卡片的 rect 内（≤2px 误差），
//      且卡片自己没有被裁掉的内容（`scrollHeight/clientHeight` 也是 ≤2px）；
//   ③ 六张卡结构一致（都有配招那一行、首层子行类名逐位相同）且高度一致（差额 ≤2px）；
//   ④ 面板页脚「清空阵容」的中心点命中它自己（不被卡片盖住）；容器装不下时必须是**能滚**的
//      （`overflow-y:auto|scroll`），而不是把内容静默切掉。
//
// **必红反证**（同一份判据，喂坏样本）：
//   · 把修复前那两条 CSS 注回去（`minmax(232px,1fr)` + 子项可收缩）→ 必须报出裁字/压字/页脚被压；
//   · 抽掉后三张卡的配招行（复刻 `loadoutRowHtml()` 的老分支）→ 必须报出结构不一致 + 不等高。
//   反证不是「另写一段判据」，用的就是上面那个 `cardLayoutProblems()`。
//
// 用法：`node --test tests/roco-team-cards-layout.test.js`
// 产物（reports/roco/team-cards-layout/）：team-cards-1536x684.png / team-cards-1440x900.png

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../src/server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'reports/roco/team-cards-layout');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 两档视口：1536×684 是截图那一档（面板最挤），1440×900 是上一轮口径里的宽屏档。 */
export const CARD_VIEWPORTS = [{width: 1536, height: 684}, {width: 1440, height: 900}];
/** 判据允许的误差（px）：rect 取整 + 亚像素布局的小数尾巴。 */
export const CARD_TOLERANCE = 2;

// ── 判据（纯函数：真跑与必红反证共用同一份）──────────────────────────────

/**
 * 六张卡的版式判据。入参是页面里量出来的**原始几何**（见 `MEASURE_JS`），返回违规清单。
 * 返回数组而不是布尔：红了要能一眼看出是哪一张卡、哪一行、越界多少 px。
 */
export function cardLayoutProblems(facts) {
  const problems = [];
  const cards = Array.isArray(facts?.cards) ? facts.cards : [];
  const tol = CARD_TOLERANCE;
  if (cards.length !== 6) problems.push(`队伍必须是六张卡，实际 ${cards.length}`);

  // ① 两两不相交（六个矩形求交，正面积即违规）。
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i].rect; const b = cards[j].rect;
      const ox = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (ox > tol && oy > tol) {
        problems.push(`卡${cards[i].index} 与卡${cards[j].index} 相交 ${ox.toFixed(1)}×${oy.toFixed(1)}px`);
      }
    }
  }

  cards.forEach((card) => {
    // ② 卡内**可见**文字节点不许越出卡片（关闭的 <details> 内容由 checkVisibility 排除）。
    for (const t of card.texts ?? []) {
      const over = Math.max(t.outLeft, t.outRight, t.outTop, t.outBottom);
      if (over > tol) {
        problems.push(`卡${card.index} 的文字「${t.text}」越出卡片 ${over.toFixed(1)}px`
          + `（左 ${t.outLeft.toFixed(1)} / 右 ${t.outRight.toFixed(1)} / 上 ${t.outTop.toFixed(1)} / 下 ${t.outBottom.toFixed(1)}）`);
      }
    }
    // ②b 卡片自己不许把内容裁掉（裁掉 = 玩家看不全，正是截图里那半行「详情」）。
    if (card.scrollH > card.clientH + tol) {
      problems.push(`卡${card.index} 有内容被裁：scrollHeight ${card.scrollH} > clientHeight ${card.clientH}`);
    }
    if (card.scrollW > card.clientW + tol) {
      problems.push(`卡${card.index} 有内容被横向裁掉：scrollWidth ${card.scrollW} > clientWidth ${card.clientW}`);
    }
    // ③ 结构一致：配招那一行（换招 + 配招清单）六张卡都得在，首层子行类名逐位相同。
    if (card.hasLoadout !== true) problems.push(`卡${card.index} 少了配招那一行（换招 / 配招清单）`);
    if (cards[0] && card.rowSignature !== cards[0].rowSignature) {
      problems.push(`卡${card.index} 的首层结构与卡${cards[0].index} 不一致：`
        + `「${card.rowSignature}」≠「${cards[0].rowSignature}」`);
    }
  });

  // ③b 六张卡等高（差额 ≤2px）。行高是内容撑的，所以这一条同时钉住「结构一致」。
  const heights = cards.map((c) => c.rect.h);
  if (heights.length) {
    const min = Math.min(...heights); const max = Math.max(...heights);
    if (max - min > tol) {
      problems.push(`六张卡不等高：${heights.map((h) => h.toFixed(1)).join(' / ')}（差额 ${(max - min).toFixed(1)}px）`);
    }
  }

  // ④ 面板页脚的「清空阵容」不能被卡片压住（截图里那团糊字 = 页脚按钮压在第六张卡上）。
  const footer = facts?.footer;
  if (footer && (footer.under ?? []).length) {
    problems.push(`页脚「清空阵容」被卡${footer.under.map((x) => x.index).join('、')}压住：`
      + footer.under.map((x) => `卡${x.index} 重叠 ${x.ox}×${x.oy}px`).join('、'));
  }
  if (footer && footer.bySelf === false) {
    problems.push(`页脚「清空阵容」的中心点没命中自己（被 <${footer.tag} class="${footer.cls}"> 抢了点击）`);
  }
  // ④b 容器装不下时必须**能滚**：否则第二排是被静默切掉的，不是「要滚一下才看到」。
  const box = facts?.slotsBox;
  if (box && box.scrollH > box.clientH + tol && !/auto|scroll/.test(String(box.overflowY))) {
    problems.push(`槽位区内容 ${box.scrollH}px > 可视 ${box.clientH}px，但 overflow-y=${box.overflowY}（滚不动 = 静默裁掉）`);
  }
  return problems;
}

/** 页面内量测：六张卡的外框 / 卡内可见文字 / 页脚命中 / 容器滚动。 */
export const MEASURE_JS = `(() => {
  const host = document.querySelector('#team-workshop');
  const sr = host && host.shadowRoot;
  if (!sr) return JSON.stringify({error: '没有 shadow root'});
  const box = sr.getElementById('tw-slots');
  if (!box) return JSON.stringify({error: '没有 #tw-slots'});
  const round = (n) => Math.round(n * 10) / 10;
  const rectOf = (el) => { const r = el.getBoundingClientRect();
    return {x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height),
      right: round(r.right), bottom: round(r.bottom)}; };
  const isVisible = (el) => {
    if (typeof el.checkVisibility === 'function'
      && !el.checkVisibility({checkVisibilityCSS: true, checkOpacity: true})) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const cards = [...box.querySelectorAll('.tw-slot')].map((el, i) => {
    const b = el.getBoundingClientRect();
    const texts = [...el.querySelectorAll('*')].filter((n) => isVisible(n)
      && [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()))
      .map((n) => { const r = n.getBoundingClientRect();
        return {text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
          outLeft: round(Math.max(0, b.left - r.left)), outRight: round(Math.max(0, r.right - b.right)),
          outTop: round(Math.max(0, b.top - r.top)), outBottom: round(Math.max(0, r.bottom - b.bottom))}; });
    const loadoutRow = el.querySelector('.tw-loadout');
    return {index: i + 1, rect: rectOf(el), scrollH: el.scrollHeight, clientH: el.clientHeight,
      scrollW: el.scrollWidth, clientW: el.clientWidth,
      hasLoadout: Boolean(loadoutRow && isVisible(loadoutRow)),
      // 结构签名只算**看得见**的首层子行：被 display:none 抽掉的行不参与（玩家看不到就等于没有）。
      rowSignature: [...el.children].filter((c) => isVisible(c))
        .map((c) => String(c.className || c.tagName)).join('|'),
      texts};
  });
  const reset = sr.getElementById('tw-reset');
  let footer = null;
  if (reset) {
    const r = reset.getBoundingClientRect();
    const hit = typeof sr.elementFromPoint === 'function'
      ? sr.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    // 「被压住」= 页脚矩形与**玩家看得见的卡片区域**相交。卡片超出滚动容器的那部分不画出来，
    // 所以先按容器的裁剪框裁一刀；容器不是滚动容器（overflow:visible）时整张卡都算看得见。
    const boxR = box.getBoundingClientRect();
    const boxStyle = getComputedStyle(box);
    const clips = boxStyle.overflowX !== 'visible' || boxStyle.overflowY !== 'visible';
    const under = [...box.querySelectorAll('.tw-slot')].map((el, i) => {
      const c = el.getBoundingClientRect();
      const left = clips ? Math.max(c.left, boxR.left) : c.left;
      const right = clips ? Math.min(c.right, boxR.right) : c.right;
      const top = clips ? Math.max(c.top, boxR.top) : c.top;
      const bottom = clips ? Math.min(c.bottom, boxR.bottom) : c.bottom;
      const ox = Math.min(right, r.right) - Math.max(left, r.left);
      const oy = Math.min(bottom, r.bottom) - Math.max(top, r.top);
      return {index: i + 1, ox: round(Math.max(0, ox)), oy: round(Math.max(0, oy))};
    }).filter((x) => x.ox > 2 && x.oy > 2);
    footer = {bySelf: Boolean(hit && (hit === reset || reset.contains(hit))),
      rect: rectOf(reset), under,
      tag: hit ? hit.tagName : null, cls: hit ? String(hit.className || '').slice(0, 40) : null};
  }
  return JSON.stringify({
    ready: host.dataset.twReady ?? null,
    viewport: {w: window.innerWidth, h: window.innerHeight},
    slotsBox: {...rectOf(box), scrollH: box.scrollHeight, clientH: box.clientHeight,
      overflowY: getComputedStyle(box).overflowY},
    footer, cards});
})()`;

// ── CDP 脚手架（与 scripts/roco/browser-box-acceptance.mjs 同一套）────────

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
  const profile = mkdtempSync(join(tmpdir(), 'roco-team-cards-'));
  let chromeErr = '';
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1536,684', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  chrome.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-600); });
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch { /* 已经退出 */ }
    try { rmSync(profile, {recursive: true, force: true}); } catch { /* 临时目录可能已清理 */ }
  };
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写出来 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) { kill(); throw new Error(`Chrome 没起来：${chromeErr}`); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) { kill(); throw new Error('没有可用的 page target'); }
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

/** 六个**不同物种**的持有实例（`?team=` 用个体 id；同物种重复会被服务端按 RC-301 拒）。 */
function ownedTeam() {
  try {
    const doc = JSON.parse(readFileSync(join(ROOT, 'data/roco/owned/owned-pets.json'), 'utf8'));
    const seen = new Set(); const out = [];
    for (const row of [...(doc.instances ?? [])].sort((a, b) => String(a.instance_id).localeCompare(String(b.instance_id)))) {
      if (seen.has(row.species_id)) continue;
      seen.add(row.species_id); out.push(row.instance_id);
      if (out.length === 6) break;
    }
    if (out.length === 6) return out;
  } catch { /* 产物缺失就退回写死的那六个 */ }
  return ['own-0001', 'own-0002', 'own-0003', 'own-0004', 'own-0005', 'own-0006'];
}

// ── 真跑 ────────────────────────────────────────────────────────────────
test('工坊六张队伍卡：真无头 Chrome 版式判据（1536×684 / 1440×900）', {timeout: 300000}, async (t) => {
  if (!CHROME) {
    t.skip('本机没有 Chrome（设 CHROME_BIN 或装 Google Chrome / Chromium）');
    return;
  }
  mkdirSync(OUT, {recursive: true});
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('判据环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const team = ownedTeam();
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(
    p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'));

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  /** 打开页面 → 等两阶段载荷都回来、六个槽位都填满 → 需要时先注入坏样式 → 量一遍。 */
  const load = async (vp, faultCss = null) => {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      {width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false});
    await cdp.send('Page.navigate', {url: `${base}roco.html?team=${team.join(',')}`});
    let filled = 0;
    for (let i = 0; i < 160; i += 1) {
      const raw = await js(`(() => { const host = document.querySelector('#team-workshop');
        const sr = host && host.shadowRoot;
        return JSON.stringify({ready: host?.dataset.twReady ?? null,
          filled: sr ? [...sr.querySelectorAll('#tw-slots .tw-slot')].filter((el) => el.dataset.twState === 'filled').length : 0}); })()`);
      const state = JSON.parse(raw);
      filled = state.filled;
      if (state.ready === 'yes' && filled === 6) break;
      await sleep(200);
    }
    await sleep(400);
    if (faultCss) {
      await js(`(() => { const sr = document.querySelector('#team-workshop').shadowRoot;
        const s = document.createElement('style'); s.id = 'fault-injection';
        s.textContent = ${JSON.stringify(faultCss)}; sr.appendChild(s); })()`);
      await sleep(350);
    }
    const facts = JSON.parse(await js(MEASURE_JS));
    facts.filled = filled;
    return facts;
  };

  try {
    await cdp.send('Page.bringToFront');
    for (const vp of CARD_VIEWPORTS) {
      const label = `${vp.width}x${vp.height}`;
      // eslint-disable-next-line no-await-in-loop
      await t.test(`${label}：六张卡不重叠 / 不裁字 / 等高`, async () => {
        const facts = await load(vp);
        const report = facts.cards.map((c) => `卡${c.index} rect=${JSON.stringify(c.rect)}`
          + ` 内容 ${c.scrollH}/${c.clientH} 配招行=${c.hasLoadout ? '有' : '无'}`).join('\n  ');
        console.log(`[${label}] 已填槽位=${facts.filled} 槽位区=${JSON.stringify(facts.slotsBox)}`
          + ` 页脚命中自己=${facts.footer?.bySelf}\n  ${report}`);
        const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
        writeFileSync(join(OUT, `team-cards-${label}.png`), Buffer.from(data, 'base64'));
        const problems = cardLayoutProblems(facts);
        assert.deepEqual(problems, [], `[${label}] 版式判据报出 ${problems.length} 条：\n`
          + `${problems.map((p) => ` · ${p}`).join('\n')}\n原始几何：\n  ${report}`);
        assert.equal(facts.filled, 6, `[${label}] 六个槽位必须都填上，实际 ${facts.filled}`);
        assert.equal(facts.footer?.bySelf, true, `[${label}] 页脚「清空阵容」的中心点必须命中它自己`);
      });
    }

    // ── 必红反证：同一份判据喂坏样本 ──────────────────────────────────────
    await t.test('必红反证：把修复前那两条 CSS 注回去，同一条判据必须报出来', async () => {
      const fault = [
        '#tw-slots{grid-auto-rows:minmax(232px,1fr) !important;overflow:visible !important}',
        '#tw-slots .tw-slot>*{flex:1 1 auto !important}',
      ].join('\n');
      const facts = await load(CARD_VIEWPORTS[0], fault);
      const problems = cardLayoutProblems(facts);
      console.log(`[反证·旧 CSS] 命中 ${problems.length} 条：\n  ${problems.map((p) => ` · ${p}`).join('\n  ')}`);
      assert.ok(problems.length > 0,
        '把修复前的 CSS 注回去居然还是绿的 —— 判据是空的（截图里那些裁字/压字它都没抓到）');
      assert.ok(problems.some((p) => /有内容被裁/.test(p)), '旧 CSS 下「内容被裁」必须被报出来');
      assert.ok(problems.some((p) => /压住/.test(p)), '旧 CSS 下页脚被卡片压住必须被报出来');
    });

    await t.test('必红反证：抽掉后三张卡的配招行（复刻 loadoutRowHtml 老分支），必须报结构不一致', async () => {
      const fault = '#tw-slots .tw-slot:nth-child(n+4) .tw-loadout{display:none !important}';
      const facts = await load(CARD_VIEWPORTS[0], fault);
      const problems = cardLayoutProblems(facts);
      console.log(`[反证·抽掉后三张的配招行] 命中 ${problems.length} 条：\n  ${problems.map((p) => ` · ${p}`).join('\n  ')}`);
      assert.ok(problems.some((p) => /少了配招那一行/.test(p)),
        `抽掉配招行必须被抓到，实际：${problems.join(' | ') || '（一条都没报）'}`);
      assert.ok(problems.some((p) => /不等高/.test(p)),
        `抽掉配招行必须同时体现为不等高，实际：${problems.join(' | ') || '（一条都没报）'}`);
    });

    assert.deepEqual(pageErrors, [], `页面抛了异常：${pageErrors.join(' | ')}`);
  } finally {
    try { kill(); } catch { /* 已退出 */ }
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
