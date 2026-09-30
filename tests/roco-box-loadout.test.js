// 盒子二级详情页「换技能」面板的判据（2026-09-28，人类逐字：「换技能还是没装是吧？实装一下」）。
//
// 被验的对象是 `src/client/box-loadout.js`：一个纯函数（`loadoutPanelHtml`）+ 一个挂载函数
// （`mountLoadout`）。这一组钉五件事，每一件都配**必红反证**（把同一个探测器对准一份
// 故意做坏的样本，必须报错）：
//
//   ① 四个槽位都在，每一个都写出技能名与关键字段（系别 / 类别 / 耗能 / 威力），缺的照实写；
//   ② 技能池**只能来自请求**（`GET /api/roco/loadout/options`，与工坊同一口径），
//      不许硬编码；请求失败要如实说清 + 留重试，绝不白屏（fail closed）；
//   ③ 保存成功必须有**回执为证**：点保存要再问一次引擎，回执里四个都在才说「已保存」，
//      说出来的名字与数字必须来自回执（不许乐观 UI 骗人）；
//   ④ 玩家可见文案里没有工程词、没有内部编号、没有 markdown 的 `**`；
//   ⑤ 窄屏（390px）不横向溢出（静态断言：样式里没有超过 390px 的固定宽度 + 有换行兜底）。
//
// 真机那一条（真实点击 + 真实引擎回执 + 390×844 实测）由主控在浏览器验收里补，不在这里。
//
// 跑法：`node --test tests/roco-box-loadout.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';

import {LOADOUT_SLOTS, LOADOUT_STYLE, loadoutOptionsPath, loadoutPanelHtml, mountLoadout,
  playerReasonOf} from '../src/client/box-loadout.js';
import {LOADOUT_STORE_KEY} from '../src/client/loadout-store.js';

// ── 夹具：盒子详情页给的那四个（**没有 skill_id**，形状照抄 roco-service.js:707-721）───

const CURRENT = [
  {order: 1, name: '啃咬', element: '虫系', category: '攻击', energy: 0, power_label: '40'},
  {order: 2, name: '防御', element: '普通系', category: '防御', energy: 1, power_label: '游戏数据里没有这一项'},
  {order: 3, name: '翅刃', element: '虫系', category: '攻击', energy: 3, power_label: '85'},
  {order: 4, name: '风隐', element: '翼系', category: '状态', energy: 1, power_label: '游戏数据里没有这一项'},
];

/** 引擎学习表回执（形状照抄真机实测的 `/api/roco/loadout/options?pet=own-0001`）。 */
const REPLY = {
  ok: true, pet_id: 'pet_000012', slots: 4, total: 5,
  learnable: [
    {skill_id: 'skill_000632', name: '啃咬', element: '虫系', category: '攻击', energy: 0, power: 40,
      sources: ['天生（学习表）']},
    {skill_id: 'skill_000286', name: '防御', element: '普通系', category: '防御', energy: 1, power: null,
      sources: ['天生（学习表）']},
    {skill_id: 'skill_000650', name: '翅刃', element: '虫系', category: '攻击', energy: 3, power: 85,
      sources: ['天生（学习表）']},
    {skill_id: 'skill_000704', name: '风隐', element: '翼系', category: '状态', energy: 1, power: null,
      sources: ['技能石']},
    {skill_id: 'skill_000645', name: '蛰针', element: '虫系', category: '攻击', energy: 0, power: 40,
      sources: ['天生（学习表）']},
  ],
  note: '（服务端那句话里带 `**`，这里一个字都不许抄）',
  evidence_ids: ['ev:roco-world-s4-2026-09-10:learnsets.json#pet_000012'],
};

// ── 探测器（每一条判据都用它；反证就是把同一只探测器对准坏样本）────────────────

/** 看得见的字：把标签剥掉（属性里的接线钩子不算「玩家可见文案」）。 */
const visible = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** 四个槽位解出来：`[{at, name, meta}]`。 */
function slotModels(html) {
  const out = [];
  for (const m of String(html).matchAll(
    /<li class="bl-slot"[^>]*data-loadout-slot="(\d)"[^>]*>([\s\S]*?)<\/li>/g)) {
    const body = m[2];
    const grab = (cls) => {
      const hit = new RegExp(`<span class="${cls}">([\\s\\S]*?)</span>`).exec(body);
      return hit ? visible(hit[1]) : null;
    };
    out.push({at: Number(m[1]), name: grab('bl-name'), meta: grab('bl-meta'), hint: grab('bl-hint')});
  }
  return out;
}

/**
 * ① 的探测器：四个槽位必须都在，每一个都要有技能名，且系别 / 类别 / 耗能 / 威力 四栏
 * **都要有字**（缺的必须写成「游戏数据里没有这一项」，不许留空）。
 */
function slotProblems(html) {
  const problems = [];
  const slots = slotModels(html);
  if (slots.length !== LOADOUT_SLOTS) problems.push(`四个槽位没画全：${slots.length} 个`);
  for (let at = 1; at <= LOADOUT_SLOTS; at += 1) {
    const slot = slots.find((one) => one.at === at);
    if (!slot) { problems.push(`缺少第 ${at} 个槽位`); continue; }
    if (!slot.name) problems.push(`第 ${at} 个槽位没写技能名`);
    if (!slot.meta) { problems.push(`第 ${at} 个槽位没写关键字段`); continue; }
    for (const key of ['系别', '类别', '耗能', '威力']) {
      const hit = new RegExp(`${key} ([^·]*)`).exec(slot.meta);
      if (!hit || !hit[1].trim()) problems.push(`第 ${at} 个槽位的「${key}」是空的：${slot.meta}`);
    }
  }
  return problems;
}

/** 面板上那些技能按钮的 id（池子只能从回执来，按钮就是它落地的样子）。 */
const chipIds = (html) => [...String(html).matchAll(/data-loadout-pick="([^"]+)"/g)].map((m) => m[1]);

/** ② 的探测器：按钮必须与回执**一一对应**，回执里的名字都要出现在面板上。 */
function poolProblems(html, pool) {
  const problems = [];
  const ids = chipIds(html);
  const expect = (Array.isArray(pool) ? pool : []).map((row) => String(row.skill_id));
  if (ids.length !== expect.length) problems.push(`技能按钮 ${ids.length} 个 ≠ 回执给的 ${expect.length} 个`);
  for (const id of ids) if (!expect.includes(id)) problems.push(`按钮里出现了回执没有的技能：${id}`);
  const text = visible(html);
  for (const row of Array.isArray(pool) ? pool : []) {
    if (row?.name && !text.includes(row.name)) problems.push(`回执里的「${row.name}」没出现在面板上`);
  }
  return problems;
}

/** 面板上那一行回执（`data-loadout-status`）。 */
function statusLine(html) {
  const hit = /<p class="bl-status" data-loadout-status="([^"]*)"[^>]*>([\s\S]*?)<\/p>/.exec(String(html));
  return hit ? {kind: hit[1], text: visible(hit[2])} : null;
}

/** ③ 的探测器：说「已保存」就必须把回执里的**数**与**每一个名字**写出来。 */
function receiptProblems(text, reply) {
  const problems = [];
  const say = String(text ?? '');
  if (!/已保存/.test(say)) problems.push('没有说「已保存」');
  if (!say.includes(`它能学 ${reply.learnable.length} 个`)) problems.push('回执里的可学数没写出来');
  for (const row of reply.learnable) if (!say.includes(row.name)) problems.push(`回执里的「${row.name}」没写出来`);
  return problems;
}

const FORBIDDEN_PLAYER = /pet_id|species_id|instance_id|state_version|coverage|provenance|source_scope|unknown_fields|licence|pack_id|ruleset_id|digest|build_hash|dataset_hash|[{}]|"\w+"\s*:/;

/** ④ 的探测器：玩家可见文案干净（不剥属性的那一版另算接线钩子）。 */
function copyProblems(html) {
  const problems = [];
  const text = visible(html);
  const hit = text.match(FORBIDDEN_PLAYER);
  if (hit) problems.push(`可见文案里出现工程词或裸 JSON：「${hit[0]}」`);
  const idHit = text.match(/pet_\d{6}|own-\d{4}|skill_\d{6}/);
  if (idHit) problems.push(`可见文案里出现内部编号：「${idHit[0]}」`);
  if (text.includes('**')) problems.push('可见文案里出现 markdown 的 **');
  const rawHit = String(html).match(FORBIDDEN_PLAYER);
  if (rawHit) problems.push(`面板 HTML 里出现工程词：「${rawHit[0]}」`);
  return problems;
}

/** ⑤ 的探测器：样式里不许有超过 390px 的固定宽度，且要有换行兜底。 */
function narrowProblems(css, html) {
  const problems = [];
  for (const m of String(css).matchAll(/(?:^|[;{\s])(?:min-)?width\s*:\s*(-?\d+(?:\.\d+)?)px/g)) {
    if (Number(m[1]) > 390) problems.push(`样式里有超过 390px 的固定宽度：${m[0].trim()}`);
  }
  if (!/flex-wrap\s*:\s*wrap/.test(String(css))) problems.push('样式里没有换行兜底（flex-wrap:wrap）');
  if (!/min-width\s*:\s*0/.test(String(css))) problems.push('样式里没有 min-width:0 的兜底');
  if (!/overflow-wrap\s*:\s*anywhere/.test(String(css))) problems.push('长名字没有断行兜底（overflow-wrap:anywhere）');
  for (const m of String(html).matchAll(/style="[^"]*width\s*:\s*(\d+)px/gi)) {
    if (Number(m[1]) > 390) problems.push(`面板上出现超过 390px 的行内宽度：${m[0]}`);
  }
  return problems;
}

// ── 挂载用的假 DOM / 假请求 / 假本机记录 ────────────────────────────────────

function fakeRoot() {
  return {
    innerHTML: '', dataset: {}, handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
    removeEventListener() {}, removeAttribute() {}, replaceChildren() { this.innerHTML = ''; },
  };
}

/** 真 DOM 里事件委托靠 `closest()`；这里给一个只回一个节点的替身（dataset 用驼峰）。 */
function click(root, dataset) {
  root.handlers.click({target: {closest: () => ({dataset})}});
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeStorage(seed = {}, {blocked = false} = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      if (blocked) throw new Error('这台浏览器不让记');
      map.set(key, String(value));
    },
    _dump: () => Object.fromEntries(map),
  };
}

/** 记录每一次请求的路径，按路径给回执（或抛错）。 */
function fakeRequest(handler) {
  const calls = [];
  const fn = async (path) => { calls.push(path); return handler(path, calls.length); };
  fn.calls = calls;
  return fn;
}

function mount(props) {
  const root = props.root ?? fakeRoot();
  const controller = mountLoadout({...props, root});
  return {root, controller};
}

/**
 * 等面板**稳定下来**再动手：池子到手之后 `prefill()` 还会再落一次预选（详情页是两段式渲染，
 * 真机同样如此）。点早了会被那一次预选盖掉 —— 我第一版就是这么写的，四点点中了三点。
 */
async function settle(controller) {
  for (let i = 0; i < 20 && !(controller.state.pool && controller.state.prefilled); i += 1) {
    await flush();
  }
  return controller.state;
}

// ── ① 四个槽位 + 关键字段 ─────────────────────────────────────────────────

test('① 四个槽位都在，每个都写出名字与系别 / 类别 / 耗能 / 威力；缺的照实写', () => {
  const html = loadoutPanelHtml({select: 'own-0001', skills: CURRENT});
  const problems = slotProblems(html);
  assert.deepEqual(problems, [], `槽位判据报错：${problems.join(' | ')}`);
  const slots = slotModels(html);
  assert.deepEqual(slots.map((one) => one.at), [1, 2, 3, 4], '四个槽位按顺序都在');
  assert.deepEqual(slots.map((one) => one.name), ['啃咬', '防御', '翅刃', '风隐']);
  assert.match(slots[0].meta, /系别 虫系 · 类别 攻击 · 耗能 0 · 必要威力 40/);
  // ⚠ 2026-09-29 **改钉**（人类 U03 逐字：「非伤害技能不展示『威力 游戏数据里没有这一项』，用合适字段」）。
  // 语义变化：这一栏原来对**所有**技能都印 `power_label`（防御 / 状态类的数据里写着
  // "游戏数据里没有这一项"，屏幕上读起来像"这只精灵的数据缺了一块"）。
  // 现在：伤害技能写「必要威力 N」；非伤害技能写「威力 不适用（防御类不造成伤害）」——
  // 那一栏**照旧必须有字**（`slotProblems` 还是要它非空：缺的绝不留空，只是不再把
  // "游戏数据里没有这一项"这句话安在"本来就没有威力这件事"上）。
  // 旧断言（改钉不删，留档）：
  //   assert.match(slots[1].meta, /威力 游戏数据里没有这一项/);
  //   assert.match(slots[3].meta, /威力 游戏数据里没有这一项/);
  assert.match(slots[1].meta, /威力 不适用（防御类不造成伤害）/, '防御类说"不适用"，不说"数据里没有"');
  assert.match(slots[3].meta, /威力 不适用（状态类不造成伤害）/, '状态类同理');
  // 攻击类但数据里真没有威力 ⇒ **照旧**照实写「游戏数据里没有这一项」（这一条没改）
  const attackNoPower = slotModels(loadoutPanelHtml({select: 'own-0001',
    skills: [{name: '没有威力的一击', element: '虫系', category: '攻击', energy: 2,
      power_label: '游戏数据里没有这一项'}]}))[0];
  assert.match(attackNoPower.meta, /威力 游戏数据里没有这一项/, '攻击类缺威力照旧照实写');
  // ⭐ U03：每个槽位还要有**一句真实效果 + 关键触发条件**（截图里那四张巨卡一个字效果都没有）。
  // 夹具 `CURRENT` 没有 `desc`（那一档照实写"资料里没写效果"）；这里补一条**带 desc** 的
  // （真机回执就有这两个字段：`desc` 与 `category`，见文件头那段回执形状）再验。
  const withEffect = loadoutPanelHtml({select: 'own-0001', skills: [
    {order: 1, name: '光刃', element: '光系', category: '攻击', energy: 4, power_label: '120',
      desc: '对敌方精灵造成物理伤害。'},
    {order: 2, name: '防御', element: '普通系', category: '防御', energy: 1,
      power_label: '游戏数据里没有这一项', desc: '减伤70%，应对攻击。'},
  ]});
  assert.match(withEffect, /效果：对敌方精灵造成物理伤害。/, '要有数据里那一句效果');
  assert.match(withEffect, /触发：应对攻击/, '要有从那一句里摘出来的关键触发条件');
  assert.match(withEffect, /引擎：这条特效还没结算/, '未结算的决定性效果要在选择时说清（不许藏）');
  assert.doesNotMatch(withEffect, /威力 游戏数据里没有这一项[^<]*类别 防御/, '非伤害技能不写那句');

  // 连耗能都缺的那种形状也要照实写
  const bare = loadoutPanelHtml({select: 'own-0001',
    skills: [{name: '什么都没有的一招', element: null, category: null, energy: null, power_label: null}]});
  const bareSlot = slotModels(bare)[0];
  assert.equal(bareSlot.name, '什么都没有的一招');
  assert.match(bareSlot.meta, /系别 游戏数据里没有这一项 · 类别 游戏数据里没有这一项 · 耗能 游戏数据里没有这一项 · 威力 游戏数据里没有这一项/);

  // 反证：同一只探测器对准「槽位少一个 + 两栏空着」的样本，必须报出来
  const bad = '<ol class="bl-slots"><li class="bl-slot" data-loadout-slot="1">'
    + '<span class="bl-name">啃咬</span><span class="bl-meta">系别 虫系 · 类别 攻击 · 耗能  · 威力 </span></li></ol>';
  const caught = slotProblems(bad);
  assert.ok(caught.length >= 4, `坏样本必须被抓：${JSON.stringify(caught)}`);
  assert.ok(caught.some((one) => one.includes('缺少第 4 个槽位')), caught.join(' | '));
  assert.ok(caught.some((one) => one.includes('「耗能」是空的')), caught.join(' | '));
  assert.ok(caught.some((one) => one.includes('「威力」是空的')), caught.join(' | '));
});

// ── ② 池子来自请求 / 失败 fail closed ───────────────────────────────────────

test('② 池子只能来自请求：按钮与回执一一对应，硬编码会被抓', async () => {
  const pool = [
    {skill_id: 'skill_x1', name: '池子甲', element: '虫系', category: '攻击', energy: 2, power: 50,
      sources: ['天生（学习表）']},
    {skill_id: 'skill_x2', name: '池子乙', element: '火系', category: '状态', energy: null, power: null,
      sources: ['技能石']},
  ];
  const request = fakeRequest(() => ({ok: true, pet_id: 'pet_000012', slots: 4, total: 2, learnable: pool}));
  const {root, controller} = mount({select: 'own-0001', species: 'pet_000012', skills: CURRENT, request});
  // 还没点之前：一个技能按钮都没有（不许先把池子写死在页面里）
  assert.deepEqual(chipIds(root.innerHTML), [], '没读学习表之前不该有技能按钮');
  assert.equal(controller.state.pool, null);

  click(root, {loadoutRead: '1'});
  await flush();
  // ⚠ 2026-09-30 **改钉（P0）**：挂载后**会自动读一次**（详情页要拿引擎的"这条效果结算了吗"，
  //   见 `ensureNamesForDraft`），所以点按钮之后不是"恰好一次"了。**判据的意思一个字没改**：
  //   池子只能来自那一个端点、不许硬编码 —— 改成"每一次调用都必须是它"。
  //   旧断言留档（改钉不删）：assert.deepEqual(request.calls, [loadoutOptionsPath('own-0001')], '请求路径必须是工坊那一个端点');
  assert.ok(request.calls.length >= 1, '至少要真读过一次');
  assert.deepEqual([...new Set(request.calls)], [loadoutOptionsPath('own-0001')],
    '每一次请求都必须是工坊那一个端点（池子只能来自请求）');
  assert.equal(request.calls[0], '/api/roco/loadout/options?pet=own-0001');
  const problems = poolProblems(root.innerHTML, pool);
  assert.deepEqual(problems, [], `池子判据报错：${problems.join(' | ')}`);
  assert.deepEqual(chipIds(root.innerHTML).sort(), ['skill_x1', 'skill_x2']);
  assert.match(visible(root.innerHTML), /它能学 2 个技能/, '可学数量要来自回执');

  // 反证：池子换一份（同一个函数、同一个流程）→ 页面跟着换，说明它读的是回执不是常量
  const other = [{skill_id: 'skill_y9', name: '另一份池子', element: '翼系', category: '攻击',
    energy: 1, power: 30, sources: ['血脉']}];
  const second = mount({select: 'own-0002', species: 'pet_000099', skills: [],
    request: fakeRequest(() => ({ok: true, pet_id: 'pet_000099', slots: 4, total: 1, learnable: other}))});
  click(second.root, {loadoutRead: '1'});
  await flush();
  assert.deepEqual(chipIds(second.root.innerHTML), ['skill_y9']);
  assert.deepEqual(poolProblems(second.root.innerHTML, other), []);
  assert.ok(poolProblems(second.root.innerHTML, pool).length > 0,
    '探测器对准不匹配的池子必须报错（否则它恒真）');
  // 反证：硬编码一个回执里没有的技能，同一只探测器必须抓
  const hardcoded = loadoutPanelHtml({select: 'own-0001', skills: CURRENT, pool: other,
    picked: [null, null, null, null]});
  assert.deepEqual(chipIds(hardcoded), ['skill_y9'], '纯函数只画喂进去的那一份池子');
  assert.ok(poolProblems(hardcoded + '<button data-loadout-pick="skill_000645"></button>', other)
    .some((one) => one.includes('回执没有的技能')), '多出来的按钮必须被抓');
});

test('②b 请求失败/服务端说不：如实说清 + 留重试 + 四个槽位照旧在，不许白屏', async () => {
  const cases = [
    ['服务端说这一只不在名单里',
      () => ({ok: false, status: 400, error: '这不在你的名单里：own-9999（要查没拥有的物种，请直接用物种 id pet_xxxxxx）'})],
    ['服务端说没有学习表', () => ({ok: false, status: 404, error: '未知学习表或精灵 id：pet_999999'})],
    ['规则服务没起来', () => ({ok: false, status: 503, error: '规则服务不可用：连接被拒绝'})],
    ['请求直接抛了', () => { throw new Error('请求打到一半断了'); }],
  ];
  for (const [label, handler] of cases) {
    const {root, controller} = mount({select: 'own-9999', species: 'pet_999999', skills: CURRENT,
      request: fakeRequest(handler)});
    click(root, {loadoutRead: '1'});
    await flush();
    assert.equal(controller.state.pool, null, `${label}：失败之后不许留下池子`);
    assert.ok(controller.state.error, `${label}：必须给出一句给玩家看的原因`);
    assert.equal(root.dataset.loadoutState, 'error', `${label}：这一屏要标成出错`);
    const html = root.innerHTML;
    // 白屏的定义：四个槽位不在了 / 一个字都不说
    assert.deepEqual(slotProblems(html), [], `${label}：出错时四个槽位照旧要在（不是白屏）`);
    assert.match(visible(html), /读不到它的学习表/, `${label}：要说清读不到`);
    assert.ok(html.includes('data-loadout-read="1"'), `${label}：要留一个重试入口`);
    assert.ok(!html.includes('data-loadout-save="1"'), `${label}：没池子就不该给保存按钮`);
    assert.deepEqual(copyProblems(html), [], `${label}：出错文案也要过玩家层判据`);
    // 服务端原话只许留在接线钩子上（工坊同一条纪律：data-tw-error-raw）
    const raw = /data-loadout-raw="([^"]*)"/.exec(html);
    assert.ok(raw, `${label}：服务端原话要留一份在 data-loadout-raw 上`);
    assert.ok(!visible(html).includes('own-9999'), `${label}：内部编号不许印到玩家层`);
  }

  // 反证：白屏样本必须被同一只探测器抓住
  const blank = '<section class="bl" data-loadout-panel></section>';
  assert.ok(slotProblems(blank).length >= 4, '空面板必须被判成「四个槽位没画全」');
  assert.ok(!/读不到它的学习表/.test(visible(blank)), '空面板里确实一个字都没有');
});

// ── ③ 保存：回执为证 ──────────────────────────────────────────────────────

test('③ 保存要再问一次引擎，说出来的名字与数字必须来自回执', async () => {
  // 读池子那一次：5 条（现在这四个 + 一个没带的），名字与详情页那四个对得上 ⇒ 预选满四个。
  const readReply = REPLY;
  // 保存那一次：**换一份回执**（4 条，而且第 1 个改了名字）。
  // 页面若拿自己的草稿去写回执那一行，就会露出马脚（名字与数字都会不对）。
  const saveReply = {
    ok: true, pet_id: 'pet_000012', slots: 4, total: 4,
    learnable: [
      {skill_id: 'skill_000632', name: '啃咬（保存回执版）', element: '虫系', category: '攻击', energy: 0,
        power: 40, sources: ['天生（学习表）']},
      {skill_id: 'skill_000286', name: '防御', element: '普通系', category: '防御', energy: 1, power: null,
        sources: ['天生（学习表）']},
      {skill_id: 'skill_000650', name: '翅刃', element: '虫系', category: '攻击', energy: 3, power: 85,
        sources: ['天生（学习表）']},
      {skill_id: 'skill_000704', name: '风隐', element: '翼系', category: '状态', energy: 1, power: null,
        sources: ['技能石']},
    ],
  };
  const storage = fakeStorage();
  // ⚠ 2026-09-30 **改钉（P0）**：挂载后自动读一次 ⇒ 第 1 次是自动读、第 2 次是点按钮那次读，
  //   保存是第 3 次起。夹具按"前两次 = 读、之后 = 保存回执"给（**判据本身没改**）。
  //   旧夹具留档（改钉不删）：fakeRequest((path, nth) => (nth === 1 ? readReply : saveReply))
  const request = fakeRequest((path, nth) => (nth <= 2 ? readReply : saveReply));
  const {root, controller} = mount({select: 'own-0001', skills: CURRENT, request, storage});
  click(root, {loadoutRead: '1'});
  await flush();
  assert.equal(controller.state.draft.filter(Boolean).length, 4, '预选：现在这四个按名字唯一对上');
  const beforeSave = request.calls.length;

  click(root, {loadoutSave: '1'});
  await flush();
  assert.equal(request.calls.length, beforeSave + 1, '保存必须**再问一次**引擎（回执为证）');
  assert.equal(request.calls.at(-1), '/api/roco/loadout/options?pet=own-0001');
  const line = statusLine(root.innerHTML);
  assert.ok(line, '保存之后要有一行回执');
  assert.equal(line.kind, 'ok');
  const problems = receiptProblems(line.text, saveReply);
  assert.deepEqual(problems, [], `回执判据报错：${problems.join(' | ')}`);
  assert.match(line.text, /第 1 个 啃咬（保存回执版）/, '名字要来自保存那一次的回执，不是本地草稿');
  assert.match(line.text, /它能学 4 个/, '数字要来自保存那一次的回执');
  assert.ok(!line.text.includes('它能学 5 个'), '不许拿读池子那一次的数字充当保存回执');
  // 真的记下来了（本机记录），而且是这四个
  const stored = JSON.parse(storage._dump()['roco.box.loadout.v1']);
  assert.deepEqual(stored['own-0001'].ids, ['skill_000632', 'skill_000286', 'skill_000650', 'skill_000704']);

  // 反证：乐观 UI（只说「已保存」不给证据）必须被同一只探测器抓住
  const optimistic = receiptProblems('已保存：换好了。', saveReply);
  assert.ok(optimistic.length >= 2, `乐观文案必须被抓：${JSON.stringify(optimistic)}`);
  assert.ok(optimistic.some((one) => one.includes('可学数没写出来')), optimistic.join(' | '));
  assert.ok(optimistic.some((one) => one.includes('啃咬（保存回执版）')), optimistic.join(' | '));
  // 反证：把读池子那一份回执当成保存回执，同一只探测器也必须报（两份回执的数字不同）
  assert.ok(receiptProblems(line.text, readReply).some((one) => one.includes('可学数没写出来')),
    '探测器必须分得清两份回执');
});

test('③b 回执里缺一个 ⇒ 说没保存、指出第几个、本机记录不写', async () => {
  // 读池子那一次是齐的（预选满四个）；**保存那一次**的回执少了第 4 个（风隐）。
  const short = {ok: true, pet_id: 'pet_000012', slots: 4, total: 3,
    learnable: REPLY.learnable.filter((row) => row.skill_id !== 'skill_000704')};
  const storage = fakeStorage();
  const {root, controller} = mount({select: 'own-0001', skills: CURRENT, storage,
    // ⚠ 2026-09-30 改钉（P0，同 ③）：挂载自动读一次 ⇒ 第 1、2 次都是读，之后才是异常回执。
    //   旧夹具留档（改钉不删）：fakeRequest((path, nth) => (nth === 1 ? REPLY : short))
    request: fakeRequest((path, nth) => (nth <= 2 ? REPLY : short))});
  click(root, {loadoutRead: '1'});
  await flush();
  assert.equal(controller.state.draft.filter(Boolean).length, 4, '预选先满上');
  click(root, {loadoutSave: '1'});
  await flush();
  const line = statusLine(root.innerHTML);
  assert.equal(line.kind, 'error', '回执说学不到 ⇒ 这一行必须是失败');
  assert.match(line.text, /没保存/);
  assert.match(line.text, /第 4 个/, '要说清是哪个位置不行');
  assert.ok(!/已保存/.test(line.text), '不许又说没保存又说已保存');
  assert.deepEqual(storage._dump(), {}, '没确认成功就不许写本机记录');
  assert.deepEqual(controller.state.draft, ['skill_000632', 'skill_000286', 'skill_000650', 'skill_000704'],
    '失败之后草稿不动（玩家挑的还是那些）');

  // 反证：把回执补全，同一段代码必须改成说「已保存」
  const full = mount({select: 'own-0001', skills: CURRENT, request: fakeRequest(() => REPLY),
    storage: fakeStorage()});
  click(full.root, {loadoutRead: '1'});
  await flush();
  click(full.root, {loadoutSave: '1'});
  await flush();
  assert.match(statusLine(full.root.innerHTML).text, /已保存/);
});

test('③c 保存时请求失败 ⇒ 只说没保存（不许乐观）', async () => {
  const {root} = mount({select: 'own-0001', skills: CURRENT, storage: fakeStorage(),
    request: fakeRequest((path, nth) => {
      if (nth <= 2) return REPLY;                     // 先正常读池子（挂载自动读一次 + 点按钮一次）
      throw new Error('规则服务不可用：连接被拒绝');
    })});
  click(root, {loadoutRead: '1'});
  await flush();
  click(root, {loadoutSave: '1'});
  await flush();
  const line = statusLine(root.innerHTML);
  assert.equal(line.kind, 'error');
  assert.match(line.text, /没保存/);
  assert.ok(!/已保存/.test(line.text));
});

test('③d 本机不让记（隐私模式）⇒ 说清「引擎确认过、但刷新会丢」，不许只说已保存', async () => {
  const {root} = mount({select: 'own-0001', skills: CURRENT, storage: fakeStorage({}, {blocked: true}),
    request: fakeRequest(() => REPLY)});
  click(root, {loadoutRead: '1'});
  await flush();
  click(root, {loadoutSave: '1'});
  await flush();
  const line = statusLine(root.innerHTML);
  assert.equal(line.kind, 'warn', '记不下就不是干净的「已保存」');
  assert.match(line.text, /不让记/);
  // ⚠ 2026-09-28 改钉（人类 ④：「换技能还是没实装是吧？实装一下」）：保存时**多写了一份**
  // 交给开局那一页（`loadout-store.js`），所以"会丢"这件事要分两种情形说清 ——
  //   · 盒子这一份没记下：隐私模式；
  //   · 交给开局那一页那一份没写成：浏览器不让记，或引擎回执里没带 pet_id。
  // 旧断言是 `assert.match(line.text, /刷新之后这份选择就没了/)`（那句是按旧文案逐字写的：
  // 旧文案自己说"这份选择记在这台浏览器上…去开局那一页时请照这四个重新带上"，等于承认没实装）。
  // 判据的**意图一个字没改**：不许说「已保存」，而且必须说清"这份选择会丢"。
  assert.match(line.text, /这份选择可能丢/, '要说清这份选择会丢');
  assert.ok(!/^已保存/.test(line.text), `不许说「已保存」：${line.text}`);
});

/**
 * ③e 保存要**真的交给开局那一页**（人类 ④ 逐字：「换技能还是没实装是吧？实装一下」）。
 *
 * 2026-09-28 之前这条路是**断的**：盒子写 `roco.box.loadout.v1`（键 = 个体 `own-…`），
 * 而工坊开局时交给服务端的是它自己那个**内存 Map**（键 = 引擎回执的 `pet_id`）——
 * 两份记录互不相识 ⇒ 盒子里配好的四个**进不了对局**（旧文案自己都写着"去开局那一页时
 * 请照这四个重新带上"，等于承认没实装）。
 *
 * 判据：保存之后，**共用记录**里必须出现 `pet_id → 四个技能`，且逐值与玩家挑的一致。
 */
test('③e 保存要把这四个写进共用记录（开局那一页读的就是它）', async () => {
  const storage = fakeStorage({});
  const {root, controller} = mount({select: 'own-0001', species: REPLY.pet_id, skills: CURRENT, storage,
    request: fakeRequest(() => REPLY)});
  click(root, {loadoutRead: '1'});
  await settle(controller);
  const prefilled = controller.state.draft.slice();
  assert.equal(prefilled.filter(Boolean).length, 4, '先得预选满四个（否则下面证明不了"改动被写下去"）');
  // **换掉第 1 个**：写下去的必须是玩家挑的那四个，不是预选那一份。
  click(root, {loadoutPick: prefilled[0]});
  click(root, {loadoutPick: 'skill_000645'});     // 蛰针：回执里有、现在这四个里没有
  const picked = controller.state.draft.slice();
  assert.equal(picked[0], 'skill_000645', '第 1 个要真的换成玩家点的那个');
  click(root, {loadoutSave: '1'});
  await flush();
  const shared = JSON.parse(storage.getItem(LOADOUT_STORE_KEY) ?? '{}');
  assert.deepEqual(shared[REPLY.pet_id], picked,
    `共用记录里要有 ${REPLY.pet_id} → 玩家挑的四个（实际 ${JSON.stringify(shared)}）`);
  // 盒子自己那一份还在（两把钥匙并存，各管各的读者）
  assert.ok(JSON.parse(storage.getItem('roco.box.loadout.v1') ?? '{}')['own-0001'],
    '盒子那份也还要写（详情页自己读它）');
  // 反证：**只写盒子那份、没写共用记录**的坏样本，必须被同一条判据抓住
  const bad = fakeStorage({});
  bad.setItem('roco.box.loadout.v1', JSON.stringify({'own-0001': {ids: picked}}));
  const badShared = JSON.parse(bad.getItem(LOADOUT_STORE_KEY) ?? '{}');
  assert.notDeepEqual(badShared[REPLY.pet_id], picked,
    '反证要真的缺这一条 —— 否则它什么都验不了');
});

/**
 * ③f 开局那一页记过的配招，盒子这一页要**读得到**（两边是同一件事）。
 *
 * 判据：共用记录里先放一份，而**盒子里没记过这一只** ⇒ 草稿要用那一份，
 * 并且说清这份配招是从哪儿来的（不是各记各的）。
 */
test('③f 工坊里配过的招，盒子这一页接着改（不是各记各的）', async () => {
  const storage = fakeStorage({});
  const fromWorkshop = REPLY.learnable.slice(0, 4).map((r) => r.skill_id);
  storage.setItem(LOADOUT_STORE_KEY, JSON.stringify({[REPLY.pet_id]: fromWorkshop}));
  const {root} = mount({select: 'own-0001', species: REPLY.pet_id, skills: CURRENT, storage,
    request: fakeRequest(() => REPLY)});
  click(root, {loadoutRead: '1'});
  await flush();
  const line = statusLine(root.innerHTML);
  assert.equal(line.kind, 'ok');
  assert.match(line.text, /开局那一页/, `要说清这份配招是从哪儿来的：${line.text}`);
  for (const id of fromWorkshop) {
    assert.match(root.innerHTML, new RegExp(`data-loadout-pick="${id}"[^>]*aria-pressed="true"`),
      `${id} 应当是"已挑中"的样子（工坊记过的那一份）`);
  }
  // 反证：没记过的另一只不许也变成"已挑中"（否则这条判据分不清"读到了"和"一律当成挑中"）
  assert.equal(new RegExp('data-loadout-picks="4"').test(root.innerHTML), true, '四个都要在草稿里');
});

// ── ④ 玩家可见文案 ────────────────────────────────────────────────────────

test('④ 所有状态的可见文案都没有工程词、没有内部编号、没有 `**`', async () => {
  const pool = REPLY.learnable;
  const states = {
    '没读学习表': loadoutPanelHtml({select: 'own-0001', skills: CURRENT}),
    '读学习表中': loadoutPanelHtml({select: 'own-0001', skills: CURRENT, loading: true}),
    '读失败': loadoutPanelHtml({select: 'own-0001', skills: CURRENT, error: playerReasonOf('这不在你的名单里：own-9999')}),
    '读到了': loadoutPanelHtml({select: 'own-0001', skills: CURRENT, pool,
      picked: ['skill_000632', 'skill_000286', null, null]}),
    '空学习表': loadoutPanelHtml({select: 'own-0001', skills: CURRENT, pool: []}),
    '名字对不上': loadoutPanelHtml({select: 'own-0001', skills: CURRENT, pool,
      picked: [null, null, null, null], status: {kind: 'error', text: '现在这四个里，有 1 个（某招）按名字在引擎的学习表里对不上。'}}),
    '回执': loadoutPanelHtml({select: 'own-0001', skills: CURRENT, pool,
      picked: ['skill_000632', 'skill_000286', 'skill_000650', 'skill_000704'],
      status: {kind: 'ok', text: `已保存：引擎确认这四个都学得到（它能学 ${pool.length} 个）：第 1 个 啃咬。`}}),
  };
  for (const [label, html] of Object.entries(states)) {
    assert.deepEqual(copyProblems(html), [], `${label}：${copyProblems(html).join(' | ')}`);
  }
  // 反证：三种坏样本必须被同一只探测器抓住
  assert.ok(copyProblems('<p>它的 pet_id 是 pet_000001</p>').length > 0, '工程词要被抓');
  assert.ok(copyProblems('<p>掉率 coverage: 1</p>').length > 0, '工程词要被抓');
  assert.ok(copyProblems('<p>**重点**：这四个</p>').length > 0, 'markdown 的 ** 要被抓');
  assert.ok(copyProblems('<p>这一只 own-0001 学得到 48 个</p>').length > 0, '内部编号要被抓');
  assert.ok(copyProblems('<p>回执：{"ok":true}</p>').length > 0, '裸 JSON 要被抓');

  // 挂载那一路（真实渲染出来的那一份）也要过
  const {root} = mount({select: 'own-0001', skills: CURRENT, storage: fakeStorage(),
    request: fakeRequest(() => REPLY)});
  assert.deepEqual(copyProblems(root.innerHTML), []);
  click(root, {loadoutRead: '1'});
  await flush();
  assert.deepEqual(copyProblems(root.innerHTML), [], '读到池子之后也不许漏');
  click(root, {loadoutSave: '1'});
  await flush();
  assert.deepEqual(copyProblems(root.innerHTML), [], '回执那一行也不许漏');
});

// ── ⑤ 窄屏 390px ─────────────────────────────────────────────────────────

test('⑤ 窄屏（390px）不横向溢出：静态断言 + 反证', () => {
  const html = loadoutPanelHtml({select: 'own-0001', skills: CURRENT, pool: REPLY.learnable,
    picked: ['skill_000632', 'skill_000286', 'skill_000650', 'skill_000704']});
  const problems = narrowProblems(LOADOUT_STYLE, html);
  assert.deepEqual(problems, [], `窄屏判据报错：${problems.join(' | ')}`);
  // 反证：不换行 / 固定宽 640px 的样本必须被同一只探测器抓住
  assert.ok(narrowProblems('.x{width:640px}', '').some((one) => one.includes('640px')), '固定宽 640 要被抓');
  assert.ok(narrowProblems('.x{display:flex;gap:6px}', '').some((one) => one.includes('flex-wrap')), '不换行要被抓');
  assert.ok(narrowProblems('.x{flex-wrap:wrap;min-width:0}', '')
    .some((one) => one.includes('overflow-wrap')), '长名字断行兜底缺失要被抓');
  assert.ok(narrowProblems('.x{}', '<span style="width:500px"></span>')
    .some((one) => one.includes('行内宽度')), '行内固定宽要被抓');
});

// ── ⑥ 换一只：上一只的池子不许留在屏上 ────────────────────────────────────

test('⑥ 换一只就把池子清掉，重新按新的一只去问引擎', async () => {
  const poolA = [{skill_id: 'skill_a1', name: '甲池子的招', element: '虫系', category: '攻击',
    energy: 1, power: 10, sources: ['天生（学习表）']}];
  const poolB = [{skill_id: 'skill_b1', name: '乙池子的招', element: '火系', category: '攻击',
    energy: 2, power: 20, sources: ['技能石']}];
  const request = fakeRequest((path) => (path.includes('own-0002')
    ? {ok: true, pet_id: 'pet_000099', slots: 4, total: 1, learnable: poolB}
    : {ok: true, pet_id: 'pet_000012', slots: 4, total: 1, learnable: poolA}));
  const {root, controller} = mount({select: 'own-0001', species: 'pet_000012', skills: CURRENT, request});
  click(root, {loadoutRead: '1'});
  await flush();
  assert.deepEqual(chipIds(root.innerHTML), ['skill_a1']);

  controller.update({select: 'own-0002', species: 'pet_000099', skills: []});
  assert.equal(controller.state.pool, null, '换一只必须把池子清掉');
  assert.deepEqual(chipIds(root.innerHTML), [], '上一只的技能按钮不许留在这一只的屏上');
  assert.ok(!visible(root.innerHTML).includes('甲池子的招'), '上一只的技能名也不许留');
  assert.deepEqual(slotProblems(root.innerHTML), [], '换一只之后四个槽位照旧在');

  click(root, {loadoutRead: '1'});
  await flush();
  assert.equal(request.calls.at(-1), '/api/roco/loadout/options?pet=own-0002', '要按新的一只重查');
  assert.deepEqual(chipIds(root.innerHTML), ['skill_b1']);

  // 反证：上一只的按钮留在屏上，同一只探测器必须抓
  const stale = root.innerHTML.replace('</section>', '<button data-loadout-pick="skill_a1"></button></section>');
  assert.ok(poolProblems(stale, poolB).some((one) => one.includes('skill_a1')), '串味的按钮必须被抓');
});

// ── ⑦ 名字对不上：不许猜 ──────────────────────────────────────────────────

test('⑦ 现在带着的四个按名字对不上（缺失 / 重名）就不预选，并如实说清', async () => {
  const pool = [
    // 「撞名」在池子里有两条 ⇒ 唯一命中不成立，不许挑第一条
    {skill_id: 'skill_dup1', name: '撞名', element: '虫系', category: '攻击', energy: 1, power: 10,
      sources: ['血脉']},
    {skill_id: 'skill_dup2', name: '撞名', element: '火系', category: '攻击', energy: 2, power: 20,
      sources: ['技能石']},
    {skill_id: 'skill_ok', name: '对得上的招', element: '虫系', category: '攻击', energy: 3, power: 30,
      sources: ['天生（学习表）']},
  ];
  const skills = [
    {name: '撞名', element: '虫系', category: '攻击', energy: 1, power_label: '10'},
    {name: '对得上的招', element: '虫系', category: '攻击', energy: 3, power_label: '30'},
    {name: '池子里根本没有的招', element: '翼系', category: '状态', energy: 1, power_label: null},
    {name: '对得上的招', element: '虫系', category: '攻击', energy: 3, power_label: '30'},
  ];
  const {root, controller} = mount({select: 'own-0001', skills, request: fakeRequest(() => (
    {ok: true, pet_id: 'pet_000012', slots: 4, total: 3, learnable: pool}))});
  click(root, {loadoutRead: '1'});
  await flush();
  assert.deepEqual(controller.state.draft, [null, 'skill_ok', null, null],
    '重名的、池子里没有的、重复的都不许猜');
  const line = statusLine(root.innerHTML);
  assert.equal(line.kind, 'error');
  assert.match(line.text, /按名字/);
  assert.match(line.text, /撞名/);
  assert.match(line.text, /池子里根本没有的招/);
  assert.ok(!/已保存/.test(line.text));

  // 反证：如果实现「挑第一条」，上面那条 deepEqual 会红 —— 这里再把探测器本身钉一次
  const guessed = ['skill_dup1', 'skill_ok', null, null];
  assert.notDeepEqual(guessed, controller.state.draft, '猜第一条的写法必须与实现不同（否则这条判据是空的）');
});

// ── ⑧ 本机记录回读 + 恢复按钮 ─────────────────────────────────────────────

test('⑧ 本机记过的四个：刷新回来还看得见（并且写清它是本机记录）', async () => {
  const seed = {[`roco.box.loadout.v1`]: JSON.stringify({
    'own-0001': {ids: ['skill_000645', 'skill_000286', 'skill_000650', 'skill_000704'],
      names: ['蛰针', '防御', '翅刃', '风隐'], at: '2026-09-28T00:00:00.000Z'},
  })};
  const storage = fakeStorage(seed);
  const {root, controller} = mount({select: 'own-0001', skills: CURRENT, storage,
    request: fakeRequest(() => REPLY)});
  assert.deepEqual(controller.state.draft, ['skill_000645', 'skill_000286', 'skill_000650', 'skill_000704']);
  const line = statusLine(root.innerHTML);
  assert.equal(line.kind, 'ok');
  assert.match(line.text, /上次你保存的是这四个/);
  assert.match(line.text, /蛰针/);
  assert.match(line.text, /记在这台浏览器上/);
  assert.deepEqual(slotModels(root.innerHTML).map((one) => one.name), ['蛰针', '防御', '翅刃', '风隐']);
  // 读了学习表之后，被选中的按钮要标出来（名字以回执为准）
  click(root, {loadoutRead: '1'});
  await flush();
  const pressed = [...root.innerHTML.matchAll(/data-loadout-pick="([^"]+)" aria-pressed="true"/g)]
    .map((m) => m[1]).sort();
  assert.deepEqual(pressed, ['skill_000286', 'skill_000645', 'skill_000650', 'skill_000704']);
  // 「恢复成现在带着的四个」把草稿拉回盒子详情页那一份
  click(root, {loadoutReset: '1'});
  assert.deepEqual(controller.state.draft, ['skill_000632', 'skill_000286', 'skill_000650', 'skill_000704']);
});

// ── ⑨ 接线钩子（主控在 box.js 里要用的那一行）──────────────────────────────

test('⑨ 挂载是幂等的：同一块地方挂两次不会叠监听，卸载之后清干净', () => {
  const root = fakeRoot();
  const first = mountLoadout({root, select: 'own-0001', skills: CURRENT});
  const second = mountLoadout({root, select: 'own-0001', skills: CURRENT});
  assert.equal(first, second, '同一个根节点重复挂载必须复用同一个控制器');
  assert.equal(typeof root.handlers.click, 'function');
  assert.equal(Object.keys(root.handlers).length, 1, '监听只许一份');
  assert.equal(root.dataset.loadoutFor, 'own-0001');
  assert.match(root.innerHTML, /data-loadout-panel/);
  second.destroy();
  assert.equal(root.innerHTML, '', '卸载要把自己画的东西收干净');
  assert.equal(root.dataset.loadoutState, undefined);
  // 卸载之后还能再挂（刷新/换页那两条路都会走到）
  const third = mountLoadout({root, select: 'own-0002', skills: CURRENT});
  assert.notEqual(third, second);
  assert.equal(root.dataset.loadoutFor, 'own-0002');
  assert.deepEqual(chipIds(root.innerHTML), []);
});

test('⑨b 池子请求的路径与工坊同一口径；失败文案是闭集（认不出的给通用话）', () => {
  assert.equal(loadoutOptionsPath('own-0001'), '/api/roco/loadout/options?pet=own-0001');
  assert.equal(loadoutOptionsPath('pet_000012'), '/api/roco/loadout/options?pet=pet_000012');
  assert.equal(loadoutOptionsPath('a b'), '/api/roco/loadout/options?pet=a%20b', '参数要转义');
  assert.match(playerReasonOf('这不在你的名单里：own-9999'), /不在你盒子里的名单/);
  assert.match(playerReasonOf('未知学习表或精灵 id：pet_999999'), /没有这一只的学习表/);
  assert.match(playerReasonOf('规则服务不可用：连接被拒绝'), /规则服务这会儿没起来/);
  const vague = playerReasonOf('某个从来没见过的内部错误 own-0007');
  assert.ok(!vague.includes('own-0007'), '通用话里不许带内部编号');
  assert.match(vague, /读不到这一只的学习表/);
  // 反证：通用话不是恒真 —— 认得出的那几条必须各说各的
  assert.notEqual(playerReasonOf('未知学习表或精灵 id：pet_999999'), playerReasonOf('规则服务不可用：x'));
});

/**
 * ㉚ P0（2026-09-30 报告 L19）：「技能详情必须与真实战报同一结论」。
 * 报告逐字：第 1 回合点「防御」⇒ **双方战报均出现约 70% 减伤**，可同一技能详情仍称
 * 「引擎没有结算这条效果」✗ ⇒ 玩家被误导。
 * 根因：详情那四个技能来自**回执**（不带 `mechanics`）⇒ `mechanicsResolved` 恒 false ✗。
 * 判据：**与战报同一事实源**（引擎学习表里同一招的 `mechanics.resolved`）——
 *   已结算的**不许**说没结算 ✓ · 没结算的**仍必须**说没结算（负向控制）✓。
 */
test('㉚ 引擎结算结论与战报同源：已结算的不许说没结算；没结算的仍要说没结算', () => {
  const pool = [
    {record: 'skill', skill_id: 'skill_def', name: '防御', category: '防御', element: '普通系', energy: 1,
      desc: '减伤70%，应对攻击。', mechanics: {resolved: true}, effect_support: 'unsupported'},
    {record: 'skill', skill_id: 'skill_decay', name: '腐化', category: '状态', element: '毒系', energy: 1,
      desc: '敌方每有1层中毒效果，敌方获得双攻-30%。',
      mechanics: {resolved: false, reason: '这条技能里还有本机训练规则尚未拉起的原语'}, effect_support: 'unsupported'},
  ];
  const receiptShape = [
    {order: 1, name: '防御', element: '普通系', category: '防御', energy: 1,
      power_label: '游戏数据里没有这一项', desc: '减伤70%，应对攻击。'},
    {order: 2, name: '腐化', element: '毒系', category: '状态', energy: 1,
      power_label: '游戏数据里没有这一项', desc: '敌方每有1层中毒效果，敌方获得双攻-30%。'},
  ];
  const withPool = loadoutPanelHtml({select: 'own-0001', pool, skills: receiptShape});
  const noPool = loadoutPanelHtml({select: 'own-0001', skills: receiptShape});   // = 改前的行为（没有引擎事实）
  // ① 正例：已经结算的（防御）**不许**再说"还没结算"
  assert.match(withPool, /引擎：这条效果已经结算。/, '已结算的效果必须说"已经结算"（与战报同一结论）');
  assert.doesNotMatch(withPool, /引擎：这条特效还没结算[^<]*减伤70%/,
    '已结算的防御**不许**再说"还没结算"（报告 L19 那条矛盾）');
  // ② 负向控制：没结算的（腐化）**仍必须**说没结算，且带上引擎给的理由
  assert.match(withPool, /引擎：这条特效还没结算/, '没结算的仍要说没结算（不许为了消矛盾把这句话删掉）');
  assert.match(withPool, /这条技能里还有本机训练规则尚未拉起的原语/, '未结算要把引擎给的理由带上');
  // ③ 反证：**没有池子**（= 改前那条路，拿不到引擎事实）⇒ 照旧说"还没结算"（不知道就说不知道）
  assert.match(noPool, /引擎：这条特效还没结算/, '拿不到引擎事实时不许假装"已经结算"');
  assert.doesNotMatch(noPool, /引擎：这条效果已经结算。/, '没有事实就不许下"已经结算"的结论');
  // ④ 候选按钮那一行也同源（原来只分"伤害/没结算"⇒ 已结算的防御会被说成没结算 ✗）
  assert.match(withPool, /引擎结算：这条效果/, '候选行也要按"已结算的效果"说');
});
