#!/usr/bin/env node
/**
 * task-9 · **C：旧 `#actions` 行动坞必须与 b3 实时配招一致**。
 *
 * 这条缺陷是 task-6 自己挖到的：旧行动坞 `#actions`（`skillSlots`）**按名册的冻结 `moveset`
 * 画四格**，不看引擎这一局的实时配招（`view.self.loadouts`）。把「硬门」换进配招后，
 * 那一坞画的是 `气波/防御/后发制人/复写`，**3 格 `legal=no`**，真正合法的四手一格都没有。
 *
 * 这个脚本一次做四件事：
 *   ① **先量**：那一坞在当前版式下到底画不画、什么条件下画（几何 + 计算样式 + `hidden` 链）；
 *   ② **判据**（导出的纯函数 `dockParityProblems`）：两套渲染器对「这四个技能是什么」
 *      必须给出同一个答案，且以**这一局的实时配招**为准；
 *   ③ **必红反证，响度实测**：在**真实 DOM** 上把行动坞按名册冻结配招重画一遍
 *      （= 修前那条路径），判据必须变红并报出具体哪四格；再恢复、确认回到绿；
 *   ④ **端到端**：改配招 → 开局 → 出手 → 打到结算，逐段截图。
 *
 * 服务：默认**自起进程内服务**（`createCoachServer`，独立端口），**不碰 8765**。
 * 用法（跑之前先按 tmp/BROWSER-LOCK.md 抢锁）：
 *   node scripts/roco/battle-smoke-dock-parity.mjs
 *   node scripts/roco/battle-smoke-dock-parity.mjs --base=http://127.0.0.1:8765   # 量在跑的那台
 */
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SMOKE = join(ROOT, 'reports', 'roco', 'battle-smoke');
const SHOTS = join(ROOT, 'docs', 'roco', 'review-2026-09-28', 'shots', 'battle');
const OWNED = join(ROOT, 'data', 'roco', 'owned', 'owned-pets.json');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const BASE_ARG = argOf('base');
const PORT = Number(process.env.CDP_PORT ?? 9393);
const GATE_PET_NAME = '板板壳';
const HARD_GATE = 'skill_000671';      // 「硬门」：换进配招的那一手
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 判据（纯函数，可单独 import）──────────────────────────────────────────
/**
 * 两套渲染器的口径判据。入参是**测量出来的事实**：
 *   dock  = 旧行动坞 `#actions` 画出来的四格（skill_id + 其中几格 legal）
 *   b3    = b3 技能屏那四格
 *   live  = 引擎这一局的实时配招（`view.self.loadouts[petId]`）
 *   frozen= 名册的冻结 `moveset` 四格（反证用；正常也带上，专门咬「又画回冻结配招」）
 *   legal = 本回合引擎给的合法技能 skill_id
 */
export function dockParityProblems(m) {
  const bad = [];
  const ids = (a) => (Array.isArray(a) ? a : []).map((x) => String(x ?? '')).join('、');
  const dock = m?.dock ?? {};
  const b3 = m?.b3 ?? {};
  const live = Array.isArray(m?.live) ? m.live : [];
  const frozen = Array.isArray(m?.frozen) ? m.frozen : [];
  const legal = Array.isArray(m?.legal) ? m.legal : [];
  if (ids(dock.ids) !== ids(b3.ids)) {
    bad.push(`两套渲染器对「这四个技能」的答案不一致：行动坞=[${ids(dock.ids)}] / b3=[${ids(b3.ids)}]`);
  }
  if (live.length && ids(dock.ids) !== ids(live)) {
    bad.push(`行动坞不是这一局的实时配招：它画的是 [${ids(dock.ids)}]，引擎这一局给的是 [${ids(live)}]`);
  }
  if (frozen.length && live.length && ids(frozen) !== ids(live) && ids(dock.ids) === ids(frozen)) {
    bad.push(`行动坞画的还是名册的**冻结配招** [${ids(frozen)}]（换招之后不该再出现这四格）`);
  }
  if (legal.length && Number(dock.legal) === 0) {
    bad.push(`行动坞四格里**一格都不合法**（legal=0），而这一局引擎给了 ${legal.length} 手合法技能 [${ids(legal)}]`);
  }
  const want = Math.min(4, legal.length);
  if (legal.length && live.length && Number(dock.legal) < want) {
    bad.push(`行动坞只有 ${dock.legal} 格合法 < 本回合合法技能数 ${want}（合法的是 [${ids(legal)}]）`);
  }
  return bad;
}

//: 必红反证：每一格都把「修前那条路径」塞回去，判据必须报错
export const COUNTERPROOFS = Object.freeze([
  {id: 'cp-frozen-dock', desc: '把行动坞按名册冻结配招重画（= 修前那条路径）⇒ 判据必须红',
    mutate: (m) => ({...m, dock: {ids: m.frozen.slice(), legal: 0}})},
  {id: 'cp-stale-dock', desc: '行动坞落后一局（画的是上一局的四格）⇒ 判据必须红',
    mutate: (m) => ({...m, dock: {ids: m.live.slice().reverse(), legal: m.dock.legal}})},
  {id: 'cp-b3-desync', desc: '两套渲染器不一致（b3 对、行动坞错）⇒ 判据必须红',
    mutate: (m) => ({...m, b3: {ids: m.b3.ids.slice(), legal: m.b3.legal},
      dock: {ids: m.frozen.slice(), legal: 0}})},
  {id: 'cp-no-legal', desc: '行动坞四格全不可点（legal=0）⇒ 判据必须红',
    mutate: (m) => ({...m, dock: {ids: m.dock.ids.slice(), legal: 0}})},
]);

const steps = [];
const mark = (id, ok, note, extra = {}) => {
  steps.push({id, ok, note, ...extra});
  console.log(`[dock-parity] ${ok ? 'OK  ' : 'FAIL'} ${id}：${note}`);
};

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome；设 CHROME_BIN 再跑');
    process.exit(2);
  }
  if (!BASE_ARG && !existsSync(join(ROOT, 'tmp', 'browser-lock'))) {
    console.error('没有抢到浏览器锁（tmp/browser-lock 不存在）——先按 tmp/BROWSER-LOCK.md 抢锁');
    process.exit(2);
  }
  mkdirSync(SMOKE, {recursive: true});
  mkdirSync(SHOTS, {recursive: true});
  const owned = JSON.parse(readFileSync(OWNED, 'utf8'));
  const buildById = new Map(owned.battle_builds.map((b) => [b.owned_pet_instance_id, b]));
  const gateInst = owned.instances.find((i) => i.species_name === GATE_PET_NAME
    && (buildById.get(i.instance_id)?.ordered_skills ?? []).length === 4) ?? null;
  if (!gateInst) throw new Error(`找不到「${GATE_PET_NAME}」的实例`);
  const frozenIds = (buildById.get(gateInst.instance_id)?.ordered_skills ?? []).slice();

  let server = null;
  let base = BASE_ARG ? BASE_ARG.replace(/\/$/, '') : null;
  if (!base) {
    const {createCoachServer} = await import('../../src/server/index.js');
    server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    base = `http://127.0.0.1:${server.address().port}`;
  }

  const profile = mkdtempSync(join(tmpdir(), 'dock-parity-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900', 'about:blank'], {stdio: 'ignore'});
  const cleanup = () => {
    try { chrome.kill(); } catch { /* 已经死了 */ }
    try { rmSync(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); }
    catch { /* 清了就好 */ }
    try { server?.close(); } catch { /* 已经关了 */ }
  };
  process.on('exit', cleanup);

  let list = null;
  for (let i = 0; i < 40 && !list; i += 1) {
    await sleep(500);
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* 还没起来 */ }
  }
  if (!list) throw new Error('Chrome 没有在预期时间内起来');
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(String(m.params?.exceptionDetails?.text ?? '').slice(0, 200));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    id += 1;
    pending.set(id, res);
    ws.send(JSON.stringify({id, method, params}));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.result?.exceptionDetails) return {error: String(r.result.exceptionDetails.text ?? '')};
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', {format: 'png'});
    const file = join(SHOTS, name);
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file.replace(`${ROOT}/`, '');
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', {url: `${base}/roco.html`});
  await sleep(2500);

  // ── ① 改配招：第一格选「板板壳」，在它的槽里把「硬门」换进四个技能 ──────
  const swapped = await evalJs(`(async () => {
    const sr = document.querySelector('#team-workshop').shadowRoot;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const scope = sr.querySelector('#tw-scope-mine');
    if (scope) { scope.click(); await wait(1500); }
    const search = sr.querySelector('#tw-search');
    if (search) { search.value = ${JSON.stringify(GATE_PET_NAME)};
      search.dispatchEvent(new Event('input', {bubbles: true})); await wait(1500); }
    const chosen = [];
    const first = sr.querySelector('#tw-cand-list .tw-row');
    if (!first) return {error: '搜不到那一只'};
    chosen.push(first.dataset.twInstance || first.dataset.twOwned || null);
    first.click(); await wait(700);
    if (search) { search.value = ''; search.dispatchEvent(new Event('input', {bubbles: true})); await wait(1500); }
    for (let round = 0; round < 24 && chosen.length < 6; round += 1) {
      const rows = [...sr.querySelectorAll('#tw-cand-list .tw-row')];
      let hit = false;
      for (const row of rows) {
        const inst = row.dataset.twInstance || row.dataset.twOwned || null;
        if (!inst || chosen.includes(inst)) continue;
        chosen.push(inst); row.click(); await wait(500); hit = true; break;
      }
      if (!hit) break;
    }
    const card = [...sr.querySelectorAll('[data-tw-slot]')]
      .find((el) => (el.textContent || '').includes(${JSON.stringify(GATE_PET_NAME)}));
    const lbtn = card?.querySelector('[data-tw-loadout]');
    if (!lbtn) return {error: '那一槽没有「换招」按钮', chosen};
    lbtn.click(); await wait(1800);
    const chipsNow = () => [...sr.querySelectorAll('[data-tw-pick]')];
    const pressedIds = () => [...sr.querySelectorAll('[data-tw-pick][aria-pressed="true"]')].map((c) => c.dataset.twPick);
    const clickChip = async (sid) => {
      const el = chipsNow().find((c) => c.dataset.twPick === sid);
      if (!el) return false;
      el.click(); await wait(220); return true;
    };
    for (let k = 0; k < 10; k += 1) { const cur = pressedIds(); if (!cur.length) break; await clickChip(cur[0]); }
    if (!(await clickChip(${JSON.stringify(HARD_GATE)}))) return {error: '学习表里没有硬门'};
    for (let k = 0; k < 16 && pressedIds().length < 4; k += 1) {
      const cur = new Set(pressedIds());
      const next = chipsNow().map((c) => c.dataset.twPick)
        .find((sid) => sid !== ${JSON.stringify(HARD_GATE)} && !cur.has(sid));
      if (!next) break;
      await clickChip(next);
    }
    const picks = pressedIds();
    const save = sr.querySelector('[data-tw-loadout-save]');
    if (!save || save.disabled) return {error: '保存不可用', picks};
    save.click(); await wait(900);
    const row = [...sr.querySelectorAll('.tw-loadout')]
      .map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()).find((t) => t.includes('你选的'));
    return {chosen, picks, row: row ?? null};
  })()`);
  mark('step1-swap-loadout', !swapped?.error && (swapped?.picks ?? []).includes(HARD_GATE),
    swapped?.error ?? `工作台显示「${swapped?.row ?? ''}」`, {loadout_picks: swapped?.picks});
  const shot1 = await shot('browser-05-dock-parity-loadout-swapped-1440x900.png');

  // ── ② 量「那一坞到底画不画」+ 两套渲染器的四格 ────────────────────────
  const MEASURE = `(() => {
    const short = (el) => el ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : null;
    const visible = (el) => {
      if (!el) return {exists: false};
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const chain = [];
      for (let n = el; n; n = n.parentElement) {
        if (n.hidden === true) chain.push((n.id || n.tagName).toString());
        const c = getComputedStyle(n);
        if (c.display === 'none' || c.visibility === 'hidden') chain.push((n.id || n.tagName).toString());
      }
      return {exists: true, display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        w: Math.round(rect.width), h: Math.round(rect.height),
        inViewport: rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0,
        offsetParent: el.offsetParent !== null, hiddenChain: [...new Set(chain)]};
    };
    const view = window.rocoDemo?.state?.view ?? null;
    const active = view?.self?.pets?.[view?.self?.active ?? 0] ?? null;
    const petId = active?.pet_id ?? null;
    const idsOf = (sel, attr) => [...document.querySelectorAll(sel)].map((el) => el.getAttribute(attr));
    const legalIds = (view?.legal ?? []).filter((a) => a.kind === 'skill').map((a) => a.skill_id);
    return {
      petId,
      live: Array.isArray(view?.self?.loadouts?.[petId]) ? view.self.loadouts[petId] : [],
      legal: legalIds,
      dock: {
        ids: idsOf('#actions [data-roco-skill-slot]', 'data-roco-skill-id'),
        legal: document.querySelectorAll('#actions [data-roco-skill-legal="yes"]').length,
        names: [...document.querySelectorAll('#actions [data-roco-skill-slot]')].map((el) => short(el.querySelector('strong'))),
      },
      b3: {
        ids: [...document.querySelectorAll('[data-b3-skill-slot][data-b3-skill-id]')].map((el) => el.dataset.b3SkillId),
        legal: document.querySelectorAll('[data-b3-skill-slot][data-b3-action-kind="skill"]').length,
        names: [...document.querySelectorAll('[data-b3-skill-slot]')].map((el) => short(el.querySelector('[data-b3-skill-name]'))),
      },
      visibility: {actionPanel: visible(document.querySelector('#action-panel')),
        actions: visible(document.querySelector('#actions')),
        b3Skills: visible(document.querySelector('[data-b3-skills]'))},
      dockText: short(document.querySelector('#actions')),
      turn: document.querySelector('#b3-round')?.textContent?.trim() ?? null,
    };
  })()`;

  const started = await evalJs(`(async () => {
    const btn = document.querySelector('#start-standard-pvp');
    if (!btn) return {error: '找不到 #start-standard-pvp'};
    btn.click();
    await new Promise((r) => setTimeout(r, 4000));
    return {ok: true};
  })()`);
  if (started?.error) throw new Error(started.error);
  const measured = await evalJs(MEASURE);
  const measure = {...measured, frozen: frozenIds};
  mark('step2-dock-drawn', (measure?.dock?.ids ?? []).length > 0,
    `行动坞画了 ${measure?.dock?.ids?.length ?? 0} 格 [${(measure?.dock?.names ?? []).join('/')}]，`
    + `其中合法 ${measure?.dock?.legal} 格`, {measure});

  const problems = dockParityProblems(measure);
  mark('step2-parity', problems.length === 0,
    problems.length ? problems.join('；') : `两套渲染器一致，且等于这一局的实时配招 [${measure.live.join('、')}]`,
    {problems});
  mark('step2-dock-visibility',
    true,
    `行动坞「画不画」：画了 ${measure.dock.ids.length} 格；`
    + `可见性 #action-panel display=${measure.visibility.actionPanel.display}`
    + `（父链命中 [${(measure.visibility.actionPanel.hiddenChain ?? []).join(',')}]）、`
    + `#actions rect=${measure.visibility.actions.w}x${measure.visibility.actions.h}、`
    + `在视口内=${measure.visibility.actions.inViewport}；b3 技能屏 display=${measure.visibility.b3Skills.display}`,
    {visibility: measure.visibility});
  const shot2 = await shot('browser-06-dock-parity-battle-opened-1440x900.png');

  // ── ③ 必红反证（**在真实 DOM 上**）：把行动坞按名册冻结配招重画一遍 ────
  const counter = await evalJs(`(async () => {
    const frozen = ${JSON.stringify(frozenIds)};
    const before = [...document.querySelectorAll('#actions [data-roco-skill-slot]')]
      .map((el) => el.getAttribute('data-roco-skill-id'));
    // 这一句就是修前那条路径的结果：四格 = 名册冻结配招、全部 legal=no
    document.querySelectorAll('#actions [data-roco-skill-slot]').forEach((el, i) => {
      el.setAttribute('data-roco-skill-id', frozen[i] ?? '');
      el.setAttribute('data-roco-skill-legal', 'no');
      el.setAttribute('data-roco-cost-short', 'yes');
    });
    const mutateMeasure = ${MEASURE};
    const mutated = {dock: mutateMeasure.dock, b3: mutateMeasure.b3, live: mutateMeasure.live,
      legal: mutateMeasure.legal};
    // 恢复：让页面按当前状态重画一次
    window.rocoDemo?.render?.();
    await new Promise((r) => setTimeout(r, 800));
    const restored = ${MEASURE};
    return {before, frozen, mutated, restored};
  })()`);
  const mutatedProblems = dockParityProblems({...counter.mutated, frozen: frozenIds});
  const restoredProblems = dockParityProblems({...counter.restored, frozen: frozenIds});
  mark('step3-counterproof-loud', mutatedProblems.length > 0,
    `把冻结配招塞回行动坞后，判据报了 ${mutatedProblems.length} 条：${mutatedProblems.join('；')}`,
    {mutated: counter.mutated, problems: mutatedProblems});
  mark('step3-restored-green', restoredProblems.length === 0,
    restoredProblems.length ? restoredProblems.join('；') : '恢复重画之后判据回到绿', {restored: counter.restored});

  // ── ④ 端到端：出手 → 打到结算 ─────────────────────────────────────────
  const firstMove = await evalJs(`(async () => {
    const cell = document.querySelector('[data-b3-skill-slot][data-b3-action-kind="skill"]');
    if (!cell) return {error: '没有可点的技能格'};
    const name = (cell.querySelector('[data-b3-skill-name]')?.textContent || '').trim();
    const skillId = cell.dataset.b3SkillId ?? null;
    cell.click();
    await new Promise((r) => setTimeout(r, 2500));
    return {name, skillId, turn: document.querySelector('#b3-round')?.textContent?.trim() ?? null};
  })()`);
  mark('step4-one-action', !firstMove?.error && firstMove?.turn === '第 2 回合',
    firstMove?.error ?? `点了「${firstMove?.name}」，回合 → ${firstMove?.turn}`, {firstMove});
  const shot3 = await shot('browser-07-dock-parity-after-action-1440x900.png');

  const settled = await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {clicks: 0, results: []};
    for (let i = 0; i < 260; i += 1) {
      const view = window.rocoDemo?.state?.view;
      if (view?.battle_result) break;
      // 有合法技能就点第一格；没有就点聚能/换人（引擎不给技能时那才是唯一出路）
      let cell = document.querySelector('[data-b3-skill-slot][data-b3-action-kind="skill"]');
      if (!cell) cell = document.querySelector('#b3-charge[data-b3-action], [data-b3-action-kind="switch"]');
      if (!cell) break;
      cell.click();
      out.clicks += 1;
      await wait(260);
    }
    const view = window.rocoDemo?.state?.view;
    return {clicks: out.clicks, result: view?.battle_result ?? null,
      turn: view?.turn ?? null,
      lesson: (document.querySelector('#lesson')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) || null,
      resultTurns: (document.querySelector('#result-turns')?.textContent || '').trim() || null};
  })()`);
  mark('step4-settled', !!settled?.result,
    `点了 ${settled?.clicks} 手 → 结算 ${settled?.result ?? '—'}（${settled?.turn ?? '—'} 回合）`
    + `；局末教学：${settled?.lesson ? '有' : '（无）'}`, {settled});
  const shot4 = await shot('browser-08-dock-parity-settlement-1440x900.png');
  mark('no-console-exception', consoleErrors.length === 0, `页面异常 ${consoleErrors.length} 条`, {consoleErrors});

  return finish({
    base, base_kind: BASE_ARG ? 'external' : 'in-process（`createCoachServer`，独立端口）',
    gate: {instance_id: gateInst.instance_id, species_id: gateInst.species_id, name: gateInst.species_name},
    frozen: frozenIds, loadout_picks: swapped?.picks ?? null,
    measured: measure, problems, counterproof: {mutated_problems: mutatedProblems,
      muted: mutatedProblems.length === 0, restored_problems: restoredProblems},
    end_to_end: {first_action: firstMove, settled},
    shots: {loadout: shot1, opened: shot2, after_action: shot3, settlement: shot4},
  });
}

function finish(extra) {
  const report = {
    schema_version: 1,
    artifact: 'battle-smoke-dock-parity',
    generated_at: new Date().toISOString(),
    why: ('旧行动坞 `#actions` 与 b3 技能屏必须对「这一局这四个技能是什么」给出同一个答案，'
      + '且以引擎的实时配招为准；换招之后不许再出现名册的冻结四格。'),
    steps,
    steps_ok: steps.filter((s) => s.ok).length,
    steps_total: steps.length,
    ok: steps.length > 0 && steps.every((s) => s.ok),
    extra,
  };
  mkdirSync(SMOKE, {recursive: true});
  writeFileSync(join(SMOKE, 'dock-parity.json'), JSON.stringify(report, null, 1));
  console.log(`\n[dock-parity] ${report.steps_ok}/${report.steps_total} 步过 → reports/roco/battle-smoke/dock-parity.json`);
  for (const s of steps.filter((x) => !x.ok)) console.log(`  FAIL ${s.id}：${s.note}`);
  process.exit(report.ok ? 0 : 1);
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) await main();
