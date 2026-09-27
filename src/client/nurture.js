// RC-306「培养」页（三级导航的二级；三级是**同一页内**的单只伙伴详情）。
//
// 这一页只回答两个问题，而且只用引擎给的数：
//
//   ① 「我这一点培养加下去，速度会不会超过对面？」
//      · 培养收益 = 培养引擎的常量（`src/game/engine.js` 的 `RULES.training`，
//        文案在 `src/game/progression.js` 的 `TRAINING`）；加的是同一个数，页面只做加法；
//      · 速度阈值 = 对局引擎名单里「对面」那一只的面板速度（`GET /api/roco/roster` 的 `stats.spe`）；
//      · **不写「加点后」**（2026-09-25 改）：面板值来自对局引擎，而引擎自述这份面板的**残差里含未记录的
//        培养加成**（`roco/src/roco_env/data.py:203`）；每点收益又是**营地**引擎的常量
//        （`src/game/engine.js:26` 的 `RULES.training`），两个引擎不同量纲（营地宠物速度 13–38，
//        名单里 40–130）；`docs/roadmap/CULTIVATION-PAGE-PLAN.md` §2 还写着这批伙伴的
//        `panel_stats`/`growth` **48/48 null ⇒ 不显示、不补 0**、「培养页的第一版不能靠数值成长立住」。
//        所以这一格一律 **fail closed**（写「引擎没给」）；要不要在引擎侧补培养模型由人类定。
//
//   ② 「我总共还剩多少培养格 / 训练点？」
//      · 训练点：读本机培养存档（与营地页**同一个 localStorage 键**），用引擎自己的
//        `loadProfile()` 解析 —— 有就写数，读不到就写「引擎没给」；
//      · 培养格：引擎规则是「等级 + 3」（见 `src/game/rules.js` 生成的规则文案），
//        需要**这一只**在存档里的等级。名单接口只给六维、没有等级，存档里也没有这些伙伴，
//        所以这里如实写「引擎没给」并说明原因 —— 不补 0、不用别的数顶替。
//
// 三条纪律（与仓库其它页面同一条）：
//   · 本文件**不写死任何引擎数值**：每个数字都来自上面的 import 或名单接口；
//   · 算不出来就写 MISSING（「引擎没给」）：不猜、不补 0、不省略成空白；
//   · 不写胜率/概率/百分数：本仓库没有这类数据，页面也不许暗示有。
//
// 判据（`tests/roco-nurture-page.test.js`）就是按这三条读这一页的：
//   · 每个 `[data-fact]` 元素的文本要么**正好是一个数**，要么**正好是「引擎没给」**；
//   · 名单接口拿不到时，`#nurture-data` 与整页可见文本里一个数字都不许有
//     （规则常量区 `#nurture-rules` 除外：它讲的是规则，不依赖名单）。

import {RULES} from '../game/engine.js';
import {TRAINING,loadProfile,trainingCapacity,PROFILE_STORAGE_KEY} from '../game/progression.js';
import {rulesSections} from '../game/rules.js';
import {TACTIC_CARDS} from '../game/content.js';
// 小芽（右上角入口 + 弹出式对话）：与营地页/训练场页/单独的小芽页面是同一份实现。
import {mountXiaoya} from './xiaoya.js';
import {mountStalePageBanner} from './stale-page.js';

/** 拿不到就写这一句。判据认的就是这四个字。 */
const MISSING = '引擎没给';
/** 本机培养存档的键：与营地页（`app.js` 的 storageKey）**同一个键**，读的是同一份账目。 */
// 键的**唯一一份字面量**在引擎里（`progression.js` 的 PROFILE_STORAGE_KEY）：
// 营地页/培养页/小芽页读的是同一份存档，四份字符串各写一遍必然漂。
const SAVE_KEY = PROFILE_STORAGE_KEY;
/** 名单六维的键与中文名（与 `roco.js` 的 `STAT_FIELDS` 同一套说法：速度 = `spe`）。 */
const STATS = [['hp', '生命'], ['atk', '物攻'], ['def', '物防'], ['spa', '魔攻'], ['spd', '魔防'], ['spe', '速度']];
/** 培养项 → 六维键。培养引擎的三个点是 hp/atk/speed，名单里速度的键名是 spe。 */
const TRAINING_STAT = {hp: 'hp', atk: 'atk', speed: 'spe'};
/** 名单接口：对局引擎侧的伙伴与六维。只读、公开数据，不需要 CSRF。 */
const ROSTER_URL = '/api/roco/roster';

const $ = (id) => document.getElementById(id);
const finite = (value) => (Number.isFinite(value) ? value : null);
/** 只有引擎给了有限数才写成数，否则写 MISSING。 */
const shown = (value) => (Number.isFinite(value) ? String(value) : MISSING);

const state = {
  engine: 'loading',   // loading | ok | missing
  engineError: null,   // 原始原因（只写进 data 属性，不进玩家文案：里面可能带数字）
  total: null,
  pets: [],
  petId: null,
  opponentId: null,
  training: 'speed',   // 默认「敏捷」：这一页的主问题就是速度
};

// ── 读数据 ───────────────────────────────────────────────────────────────

/** 引擎没起来时给玩家看的原因：**不带数字**，所以它是页面自己的一句，不是服务端原文。 */
function reasonText(status) {
  if (status === 503) return '规则服务没有就绪';
  if (status >= 500) return '规则服务报了错';
  if (status >= 400) return '名单接口拒绝了这次查询';
  return '本机服务没有回应';
}

/** 拉一次名单。任何一步不对都当「引擎没给」：不回退到旧数据、不猜一只出来。 */
async function fetchRoster() {
  let response;
  try {
    response = await fetch(ROSTER_URL, {headers: {accept: 'application/json'}});
  } catch {
    return {ok: false, status: 0, reason: reasonText(0)};
  }
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  if (!response.ok || !json || json.ok !== true || !Array.isArray(json.pets)) {
    // 名单这条路由**一律回 200**，真正的状态码在回执里（`json.status`）。
    // 所以原因要按回执里的那个码给，不能拿 HTTP 码去猜（否则 503 会被读成「没有回应」）。
    const code = Number.isInteger(json?.status) ? json.status : response.status;
    return {ok: false, status: code, reason: reasonText(code), detail: json?.error ?? null};
  }
  return {ok: true, total: Number.isInteger(json.total) ? json.total : (Number.isInteger(json.count) ? json.count : null),
    pets: json.pets.filter((pet) => pet && typeof pet.pet_id === 'string')};
}

/** 读本机培养存档：用引擎自己的解析与回退，不在页面里另写一份校验。 */
function readSave() {
  let raw = null;
  try { raw = localStorage.getItem(SAVE_KEY); } catch { return {ok: false}; }
  // `loadProfile(null)` 就是营地页对「这台机器还没有存档」的处理：回退到引擎的初始档案。
  return {ok: true, profile: loadProfile(raw), existing: raw !== null};
}

// ── 取数（全部从引擎对象上取，页面不派生新数值）──────────────────────────

const petOf = (id) => state.pets.find((pet) => pet.pet_id === id) ?? null;
const statOf = (pet, key) => finite(pet?.stats?.[key]);
/** 这一只在这份存档里的等级；不在存档里就是 null（→ 培养格写「引擎没给」）。 */
function levelOf(pet) {
  const save = readSave();
  const level = save.ok ? save.profile?.pets?.[pet?.pet_id]?.level : null;
  return Number.isInteger(level) ? level : null;
}

/**
 * 一个培养项落地后的三个数。
 *
 * 「每点收益」照实显示并**标清它是营地引擎的常量**；但**不做加法**（三条理由见文件头）。
 * 非速度项本来就不加速度，所以速度行与「加点前」相同 —— 这是如实写，不是把收益当成 0。
 */
function numbers() {
  const pet = petOf(state.petId), foe = petOf(state.opponentId);
  const key = state.training;
  const gain = finite(RULES.training[key]);
  const statKey = TRAINING_STAT[key];
  const trainedBefore = statOf(pet, statKey);
  const speedBefore = statOf(pet, 'spe');
  return {
    pet, foe, key, gain, statKey,
    trainedBefore,
    // 2026-09-25：**引擎没给就不许替它算**（对抗性复核 + 计划书 §2，理由见文件头）。
    // 「培养项加点后」任何一项都不做（收益是营地引擎常量，加到对局引擎的六维上没依据）；
    // 「速度加点后」只有**敏捷**这一项不做加法 —— 其他项「不加速度」是引擎规则本身
    // （`RULES.training` 里那一项没有 speed），所以照实写「速度不变」是有据的。
    trainedAfter: null,
    speedBefore,
    speedAfter: key === 'speed' ? null : speedBefore,
    threshold: statOf(foe, 'spe'),
  };
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

/** 每张卡：名字/系别/六维/入口按钮。没有的数写 MISSING，不省略成空白。 */
function cardHtml(pet) {
  const cells = STATS.map(([key, label]) => {
    const value = statOf(pet, key);
    return `<li><span>${label}</span><b${value === null ? ' class="miss"' : ''}>${shown(value)}</b></li>`;
  }).join('');
  const types = Array.isArray(pet.types) && pet.types.length ? pet.types.join(' · ') : MISSING;
  return `<article class="card" role="listitem">
   <h3>${pet.name ?? MISSING}</h3>
   <p class="types">${types}</p>
   <ul class="stats">${cells}</ul>
   <button type="button" data-open-pet="${pet.pet_id}">培养这一只</button>
  </article>`;
}

function renderRoster() {
  const ready = state.engine === 'ok';
  $('roster-count').textContent = ready && state.total !== null ? `名单里 ${state.total} 只` : '';
  $('roster-note').textContent = ready
    ? '六维来自对局引擎的名单接口；名单里没有的项写「引擎没给」，不补 0。'
    : `${MISSING}：伙伴名单要先连上对局引擎的规则服务，现在：${state.engineError ?? '原因不明'}。`
      + '下面的培养规则来自培养引擎的常量，不受影响。';
  $('retry-roster').hidden = ready;
  $('pet-grid').innerHTML = ready ? state.pets.map(cardHtml).join('') : '';
}

/** 面板六维：一份数据一个格子，缺的那一项如实标出来。 */
function renderPanel(pet) {
  $('panel-stats').innerHTML = STATS.map(([key, label]) => {
    const value = statOf(pet, key);
    return `<li${key === 'spe' ? ' class="hot"' : ''}><span>${label}</span><b${value === null ? ' class="miss"' : ''} data-stat="${key}">${shown(value)}</b></li>`;
  }).join('');
}

function renderPicker() {
  // 三个选项与它们的收益文案**整段来自引擎**：名字与 gain 都是 progression.TRAINING 的原文，
  // 页面不另写「+3 速度」这类字符串。
  $('training-picker').innerHTML = Object.entries(TRAINING).map(([key, item]) => `
   <button type="button" role="radio" data-training="${key}" aria-checked="${key === state.training}"
     class="${key === state.training ? 'selected' : ''}"><b>${item.name}</b><span data-gain="${key}">${item.gain}</span></button>`).join('');
}

function renderOpponentOptions() {
  const options = state.pets
    .filter((pet) => pet.pet_id !== state.petId)
    .map((pet) => {
      const speed = statOf(pet, 'spe');
      return `<option value="${pet.pet_id}">${pet.name ?? MISSING}（速度 ${shown(speed)}）</option>`;
    });
  $('opponent').innerHTML = options.join('');
  $('opponent').value = state.opponentId ?? '';
}

/** 只写引擎给的两个数与它们的差；算不出就整句写 MISSING。 */
function relationLine(label, mine, theirs) {
  if (mine === null || theirs === null) return `${label}：${MISSING}（面板速度或对面速度没拿到，比较算不出来）`;
  if (mine > theirs) return `${label}：速度 ${mine} 比对面 ${theirs} 快 ${mine - theirs}`;
  if (mine === theirs) return `${label}：速度 ${mine} 与对面 ${theirs} 相同（平速）`;
  return `${label}：速度 ${mine} 比对面 ${theirs} 慢 ${theirs - mine}`;
}

function renderDetail() {
  const pet = petOf(state.petId);
  if (!pet) { location.hash = '#/'; return; }
  const n = numbers();
  const item = TRAINING[n.key];
  $('pet-name').textContent = pet.name ?? MISSING;
  $('pet-types').textContent = Array.isArray(pet.types) && pet.types.length ? pet.types.join(' · ') : MISSING;
  renderPanel(pet);
  renderPicker();
  renderOpponentOptions();

  $('trained-label').textContent = `${item.name}（${item.gain}）`;
  for (const [fact, value] of [
    ['trained-before', n.trainedBefore], ['trained-after', n.trainedAfter],
    ['speed-before', n.speedBefore], ['speed-after', n.speedAfter], ['threshold-speed', n.threshold],
  ]) {
    const cell = document.querySelector(`[data-fact="${fact}"]`);
    cell.textContent = shown(value);
    cell.classList.toggle('miss', value === null);
  }

  // 结论：只陈述引擎给的数与引擎给的规则，不写胜率、不写概率，**也不替引擎做加法**。
  const speedGain = n.key === 'speed';
  $('verdict-before').textContent = relationLine('加点前', n.speedBefore, n.threshold);
  $('verdict-after').textContent = speedGain
    ? `加点后：${MISSING} —— 这一页不替引擎做加法。面板速度来自对局引擎的名单，`
      + '而引擎自述这份面板的残差里含它没记录的培养加成；每点收益是营地引擎的常量，两个引擎的数值不同量纲。'
      + '要不要在引擎侧补一个培养模型（补了才有「加点后」这个数），这个等规则定下来再算。'
    : `加点后：这一项（${item.name}）不加速度，速度还是 ${shown(n.speedBefore)}，与对面的先手关系不变。`;
  // 2026-09-26（审计点名）：这段曾经印出两个**源码路径**、字面 `**` 与「口径/量纲」。
  // 玩家只需要知道"这两个数不是一套、所以不能相加"，以及为什么。
  $('calc-note').textContent = '面板速度与「对面速度」都来自对局引擎的名单；「每点收益」是营地那边的固定规则值。'
    + '这两个数不是一套算法算出来的，所以不能相加：对局引擎的快照里没有培养这一档，'
    + '本机培养存档里的伙伴也不是名单里这 48 只。';
  $('crumb-nurture').textContent = '← 回到伙伴名单';

  // 培养资源：训练点是本机存档的账目（有就写数）；培养格要这一只的等级，拿不到就写「引擎没给」。
  const save = readSave();
  const tokensCell = document.querySelector('[data-fact="tokens"]');
  const capacityCell = document.querySelector('[data-fact="capacity"]');
  if (save.ok) {
    const tokens = finite(save.profile?.tokens);
    tokensCell.textContent = shown(tokens);
    tokensCell.classList.toggle('miss', tokens === null);
    $('tokens-source').textContent = save.existing
      ? '本机培养存档里还剩这些（与营地页同一份账目）。它属于营地的伙伴：名单接口没有给这些伙伴的培养点余额。'
      : '这台机器还没有培养存档，这是引擎初始档案里的数。';
  } else {
    tokensCell.textContent = MISSING;
    tokensCell.classList.add('miss');
    $('tokens-source').textContent = '浏览器存储读不到，训练点拿不出来。';
  }
  const level = levelOf(pet);
  if (level !== null) {
    const capacity = finite(trainingCapacity(level));
    capacityCell.textContent = shown(capacity);
    capacityCell.classList.toggle('miss', capacity === null);
    $('capacity-source').textContent = `这只伙伴在本机培养存档里是 ${level} 级，培养格按引擎规则从等级算出来。`;
  } else {
    capacityCell.textContent = MISSING;
    capacityCell.classList.add('miss');
    $('capacity-source').textContent = '培养格按引擎规则从等级算出来；这只伙伴不在本机培养存档里，'
      + '名单接口也只给六维、没有等级，所以引擎没给它的培养格。';
  }
}

function renderRules() {
  // 规则区整段来自引擎文案：数字与措辞都是 `rules.js` / `content.js` 的原文，
  // 页面一个字都不改写。这一区**不依赖名单**，所以引擎名单连不上时它照常显示。
  const section = rulesSections().find((item) => item.title.includes('培养'));
  const line = section?.lines.find((text) => text.startsWith('培养格数'));
  $('rule-training').textContent = line ?? MISSING;
  const card = TACTIC_CARDS.find((item) => item.id === 'tactic:training');
  $('rule-card').textContent = card ? `培养阈值（知识卡原文）：${card.principle} 反例：${card.counterexample}` : MISSING;
  // 2026-09-27（审计 ②：说人话判据没扫 nurture.js）：这里原来印出四个**源码路径**
  //（`src/game/rules.js`、`content.js`、`engine.js`、`progression.js`）—— 玩家读不懂，也不需要读。
  // 说清"这段话是谁说的、有没有被改写"就够了；具体出处留在 `docs/` 与引擎自述里。
  $('rule-sources').textContent = '这段规则与培养收益都是练习引擎自带的原文，'
    + '这一页一个字都不改写、也不做加法；数字与措辞照它给的显示。';
}

function render() {
  const open = Boolean(state.petId && petOf(state.petId));
  $('view-roster').hidden = open;
  $('view-pet').hidden = !open;
  document.body.dataset.nurtureView = open ? 'pet' : 'roster';
  document.body.dataset.nurtureEngine = state.engine;
  $('crumb-pet-name').textContent = open ? (petOf(state.petId).name ?? MISSING) : '选一只伙伴';
  if (open) renderDetail(); else renderRoster();
}

// ── 三级导航：二级与三级在**同一页内**切换 ────────────────────────────────

/** 从地址读三级：`#/pet/<id>` 是三级详情，其余都是二级名单（可以收藏、可以分享）。 */
function petFromHash() {
  const hit = /^#\/pet\/([^/]+)$/.exec(location.hash || '');
  if (!hit) return null;
  const id = decodeURIComponent(hit[1]);
  return petOf(id) ? id : null;
}

/** 三级默认比对面那一只：名单里速度最高的另一只（拿不到速度就退到第一只另一只）。 */
function defaultOpponent(petId) {
  const others = state.pets.filter((pet) => pet.pet_id !== petId);
  const ranked = others.filter((pet) => statOf(pet, 'spe') !== null)
    .sort((a, b) => statOf(b, 'spe') - statOf(a, 'spe'));
  return (ranked[0] ?? others[0])?.pet_id ?? null;
}

function openPet(id) {
  if (!petOf(id)) return false;
  state.opponentId = defaultOpponent(id);
  if (location.hash === `#/pet/${encodeURIComponent(id)}`) { state.petId = id; render(); }
  else location.hash = `#/pet/${encodeURIComponent(id)}`;   // hashchange 会再渲染一次
  return true;
}

function closePet() {
  if (location.hash && location.hash !== '#/') location.hash = '#/';
  else { state.petId = null; render(); }
}

function wire() {
  $('pet-grid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-pet]');
    if (button) openPet(button.dataset.openPet);
  });
  $('training-picker').addEventListener('click', (event) => {
    const button = event.target.closest('[data-training]');
    if (!button) return;
    state.training = button.dataset.training;
    renderDetail();
  });
  $('opponent').addEventListener('change', (event) => {
    state.opponentId = event.target.value;
    renderDetail();
  });
  $('crumb-nurture').addEventListener('click', closePet);
  // 别名（隐藏）不绑事件：它只是给「页面自己的钩子」留个落点，点了也没用。
  $('retry-roster').addEventListener('click', async (event) => {
    event.target.disabled = true;
    await loadRoster();
    event.target.disabled = false;
  });
  // 一二级之间的链接是真链接（左键照常跳转到 roco.html），不做拦截；
  // 二三级之间是同一页内的视图切换，所以左键拦下来、改成切视图，不重新加载。
  // `#crumb-nurture` 的点击在上面已经绑过（那是三级 → 二级的可见按钮）；
  // 这里只处理 `#crumb-pet`（地址跳转，深链）。
  $('crumb-pet')?.addEventListener('click', (event) => {
    event.preventDefault();
    if (state.petId) renderDetail();
    else $('roster-note').textContent = '先在名单里点一只伙伴，这里就有它的详情。';
  });
  addEventListener('hashchange', () => {
    const id = petFromHash();
    state.petId = id;
    if (id && (!state.opponentId || state.opponentId === id)) state.opponentId = defaultOpponent(id);
    render();
  });
}

// ── 启动 ─────────────────────────────────────────────────────────────────

async function boot() {
  $('boot-fallback')?.remove();   // 脚本真的跑起来了：撤掉兜底横幅
  // 右上角小芽 + 弹出式小芽（人类 2026-09-25 纠偏①）。按钮与浮层注入到 #nurture-actions，
  // 与营地页/训练场页共用 `xiaoya.js` 那**一份**对话实现（同一条 /api/coach、同一份记忆）。
  mountXiaoya({mode: 'popup'});
  renderRules();                  // 规则常量区不依赖名单，先画它（引擎连不上时页面也有内容）
  wire();
  await loadRoster();
  document.body.dataset.nurtureReady = 'yes';
}

/** 问一次名单，把状态落到 state 上，再整页重画。引擎连不上时**清空**伙伴，不留半份旧数据。 */
async function loadRoster() {
  const result = await fetchRoster();
  if (result.ok) {
    state.engine = 'ok';
    state.total = result.total;
    state.pets = result.pets;
    state.petId = petFromHash();
    state.opponentId = state.petId ? defaultOpponent(state.petId) : null;
  } else {
    // fail closed：引擎没给名单，就把「引擎没给」写出来，一个数字都不留。
    state.engine = 'missing';
    state.engineError = result.reason;
    state.pets = [];
    state.petId = null;
    state.opponentId = null;
    document.body.dataset.nurtureError = result.detail ? 'detail' : 'no-detail';
    if (result.detail) document.body.dataset.nurtureErrorDetail = String(result.detail).slice(0, 200);
  }
  render();
}

// 验收探针读这一份（页面**真正**用的状态与纯函数），比让脚本去点中文按钮稳。
window.nurturePage = {state, numbers, openPet, closePet, readSave, fetchRoster, MISSING,
  stats: STATS, trainingStat: TRAINING_STAT, rulesSections, tacticCard: TACTIC_CARDS.find((c) => c.id === 'tactic:training')};

void boot();

// 「这一页是重启前的旧代码」探测器（2026-09-25）：服务端重启过而这一页没刷新时摆一条横幅。
mountStalePageBanner();
