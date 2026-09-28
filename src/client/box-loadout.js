/**
 * 盒子二级详情页的「换技能」面板（人类 2026-09-28 逐字：「换技能还是没装是吧？实装一下」）。
 *
 * 二级页原来只把四个技能画成**只读**清单（`src/client/box.js` 的 `petBodyHtml()`），
 * 没有换的入口。工坊那一页（`src/client/team-workshop.js`）早就有一整套配招，
 * 这个文件**复用同一条引擎口径**，不另造第二份：
 *
 *   · 池子只从 `GET /api/roco/loadout/options?pet=<个体 own-XXXX 或物种 pet_XXXXXX>` 来
 *     （工坊那一处：team-workshop.js:807；路由：src/server/index.js:705-708；
 *      服务方法：src/server/roco-service.js:2433-2465；再往下是引擎的
 *      `query_rules{kind:'learnset', include_records:true}`，实现在
 *      roco/src/roco_env/service.py:1034 的 `_answer_learnset`）。
 *   · 回执形状（真机实测 `?pet=own-0001`，2026-09-28 20:22）：
 *     `{ok:true, pet_id:'pet_000012', slots:4, total:47,
 *       learnable:[{record:'skill', skill_id:'skill_000645', name:'蛰针', category:'攻击',
 *         element:'虫系', energy:0, damage_class:'物攻', power:40, power_status:'static_value_present',
 *         sources:['天生（学习表）'], …}, …], note:'…', evidence_ids:[…]}`
 *     —— 条数**跟着数据走**（同一只在当天 20:19 之前量到的是 48 条：另一条线正在改
 *     `layer-playable-48/learnsets.json`），所以面板上的数一律读回执，一个都不写死。
 *     —— 失败时是 `{ok:false, status:400|404|503, error:'…'}`（服务端原话，见下面的映射）。
 *   · 「学不学得到」由**引擎**判：`loadoutOptions()` 的注释与 `normalizeLoadouts()`
 *     （roco-service.js:506-536）都写着「技能池由引擎判」。所以这一层只挡明显不对的形状
 *     （没挑满四个、同一个技能挑两次），不自己发明技能池、不自己判合法性。
 *
 * 为什么要注入 `<style>` 而不写进 `box.css`：
 *   ① 本轮只允许新建/修改 `box-loadout.js` 与它的判据（`box.css` 由另一条线同时在改，改它会冲突）；
 *   ② 面板要能整块拿掉、整块复用，样式跟着模块走最省事。
 * 注入目标是 **`<head>`，不是 body**：盒子真机验收把 body 克隆下来读 `innerText`
 * （`scripts/roco/browser-box-acceptance.mjs:511-513`；脱离文档的节点上 innerText 退化成
 * textContent），而 `FORBIDDEN_PLAYER`（同文件 :56）把 `{}` 当成「玩家层出现裸 JSON」——
 * 样式表落进 body 的文本里就会被判红。
 *
 * 诚实边界（一句话）：盒子这一页**没有**「保存配招到服务器」的接口 —— 全仓只有开局那一条
 * 请求会带 `loadouts`（`src/server/roco-service.js:2170`，`POST /api/roco/battle/new`）。
 * 所以这里的「保存」= ①**再问一次引擎**、拿回执逐条确认这四个学得到；②把这四个记在
 * 这台浏览器上。回执没到、或回执里缺任何一个，都**不报成功**（fail closed）。
 */

/** 与引擎、工坊同格数（`LOADOUT_SLOTS`，src/server/roco-service.js 的配招格数）。 */
export const LOADOUT_SLOTS = 4;

/** 缺项的统一说法（与 `src/server/roco-service.js:556`、`team-workshop.js:118` 同一句）。 */
const NO_ITEM = '游戏数据里没有这一项';

/** 本机记录：键名跟着盒子的另外两份本机记录（`roco.box.favourites.v1` / `roco.box.individuals.v1`）。 */
const STORE_KEY = 'roco.box.loadout.v1';
const STYLE_ID = 'box-loadout-style';

/** 池子请求：与工坊**同一个端点、同一套查询参数**，不另造口径。 */
export function loadoutOptionsPath(pet) {
  return `/api/roco/loadout/options?pet=${encodeURIComponent(String(pet ?? ''))}`;
}

/** 样式（见文件头「为什么要注入 <style>」）。窄屏口径：没有任何超过 390px 的固定宽度。 */
export const LOADOUT_STYLE = [
  '.bl{display:flex;flex-direction:column;gap:8px;min-width:0;max-width:100%;margin:10px 0 0}',
  '.bl>h4{margin:0;font-size:15px}',
  '.bl-note,.bl-hint,.bl-status{margin:0;font-size:12px;line-height:1.6;color:var(--muted);'
    + 'overflow-wrap:anywhere;word-break:break-word;min-width:0}',
  '.bl-status[data-loadout-status="ok"]{color:var(--accent)}',
  '.bl-status[data-loadout-status="warn"]{color:#f0cb77}',
  '.bl-status[data-loadout-status="error"]{color:#f0b79a}',
  '.bl-slots{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr;gap:6px;min-width:0}',
  '.bl-slot{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 8px;min-width:0;'
    + 'background:#131f2c;border:1px solid #2c3d50;border-radius:8px;padding:7px 10px}',
  '.bl-no{flex:0 0 auto;font-size:11px;color:#c8d5e2}',
  '.bl-name{flex:0 1 auto;min-width:0;font-size:13px;overflow-wrap:anywhere;word-break:break-word}',
  '.bl-tag{flex:0 0 auto;font-size:11px;border:1px solid var(--line);border-radius:999px;'
    + 'padding:1px 7px;color:var(--muted)}',
  '.bl-slot[data-loadout-slot-state="picked"]{border-color:#4a6858}',
  '.bl-meta{flex:1 1 100%;min-width:0;font-size:12px;color:var(--muted);'
    + 'overflow-wrap:anywhere;word-break:break-word}',
  '.bl-pool{display:flex;flex-wrap:wrap;gap:6px;min-width:0;max-height:330px;overflow:auto}',
  '.bl-chip{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:5px;max-width:100%;'
    + 'min-height:44px;padding:6px 10px;border-radius:8px;border:1px solid var(--line);'
    + 'background:#16222f;color:#dfe8ef;font-size:13px;text-align:left;white-space:normal;'
    + 'overflow-wrap:anywhere;word-break:break-word}',
  '.bl-chip[aria-pressed="true"]{border-color:var(--accent);color:var(--accent);font-weight:600}',
  '.bl-chip-meta{font-size:11px;color:var(--muted)}',
  '.bl-actions{display:flex;flex-wrap:wrap;gap:8px;min-width:0}',
  '.bl-actions>button{max-width:100%;white-space:normal}',
].join('\n');

// ── 小工具（纯字符串处理，Node 里可直接跑）──────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function textOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 数字 → 显示串。`null`/`''`/非数字一律回 null（**不补 0**）。 */
function numberText(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : null;
}

/**
 * 一条技能记录 → 玩家要看的四个字段。
 * 认两种形状：盒子详情页的四个技能（`{name,element,category,energy,power_label}`）
 * 与引擎学习表的记录（`{name,element,category,energy,power}`）—— 缺什么就回 null，
 * 由渲染那一层写成「游戏数据里没有这一项」，**不留空、不补 0**。
 */
function skillFields(skill) {
  const row = skill && typeof skill === 'object' ? skill : {};
  return {
    name: textOf(row.name),
    element: textOf(row.element),
    category: textOf(row.category),
    energy: numberText(row.energy),
    power: textOf(row.power_label) ?? numberText(row.power),
  };
}

/** 槽位那一行：系别 / 类别 / 耗能 / 威力，缺的照实写。 */
function metaLine(fields) {
  return `系别 ${fields.element ?? NO_ITEM} · 类别 ${fields.category ?? NO_ITEM}`
    + ` · 耗能 ${fields.energy ?? NO_ITEM} · 威力 ${fields.power ?? NO_ITEM}`;
}

/** 技能按钮上那半行：只写有值的（与工坊的 chip 同一套读法，缺项不占地方）。 */
function chipLine(fields) {
  return [
    fields.element,
    fields.energy === null ? '耗能 ' + NO_ITEM : `耗能 ${fields.energy}`,
    fields.power === null ? '威力 ' + NO_ITEM : `威力 ${fields.power}`,
  ].filter(Boolean).join(' · ');
}

/** 学习表回执里的 `sources`（服务端已经给的是玩家话：天生（学习表）/ 血脉 / 技能石）。 */
function sourcesText(entry) {
  const list = Array.isArray(entry?.sources) ? entry.sources.filter((x) => typeof x === 'string' && x) : [];
  return list.length ? list.join(' / ') : null;
}

/**
 * 服务端原话 → 玩家读法。
 *
 * 服务端的错误句里会带内部 id 形状（实测：「这不在你的名单里：own-9999（…）」），
 * 不许印到玩家层。映射是**闭集**，认不出的一律给一句通用话 + 把原文留在
 * `data-loadout-raw` 上（与工坊 `playerReasonOf()` / `data-tw-error-raw` 同一条纪律，
 * team-workshop.js:846-863）。
 */
export function playerReasonOf(raw) {
  const text = String(raw ?? '');
  if (!text) return '没读到引擎的学习表（没有回执），所以没有保存。';
  if (/不在你的名单里/.test(text)) return '这一只不在你盒子里的名单上，引擎那边没有它的学习表。';
  if (/未知学习表|未知精灵名/.test(text)) return '引擎里没有这一只的学习表（游戏数据里没登记）。';
  if (/规则服务不可用|不可用/.test(text)) return '规则服务这会儿没起来，读不到学习表：过一会儿再点一次。';
  if (/学习表是空的/.test(text)) return '引擎说这一只的学习表是空的。';
  return '读不到这一只的学习表。过一会儿再点一次；要是还不行，就是这台机器的规则服务没起来。';
}

// ── 纯函数：面板 HTML ──────────────────────────────────────────────────────

/**
 * 画「换技能」面板（纯函数，Node 里可测）。
 *
 * @param {object}   props
 * @param {string}   props.select  页面上这一只的编号（`own-XXXX` 或 `pet_XXXXXX`）——只当接线钩子用
 * @param {?string}  props.species 物种编号：**这一层不显示它**（工程键不上屏），
 *                                  它是给 `mountLoadout()` 按个体查不到时兜底再查一次用的；
 *                                  两个函数收同一份 props，接线的那个对象可以直接递进来
 * @param {object[]} props.skills  现在带着的四个（盒子详情页那一份：名字/系别/类别/耗能/威力）
 * @param {?object[]} props.pool  引擎给的学习表（`learnable`）。null = 还没读
 * @param {?string}  props.error  读学习表失败时给玩家的那一句
 * @param {?Array}   props.picked 换的位置：长度 4 的数组，元素是技能 id / {skill_id,name} / null。
 *                                 不传（null）= 只读展示「现在带着的四个」
 * @param {?object}  props.status 回执那一行 `{kind,text}`
 * @param {?string}  props.via    这份学习表是**按什么**查的：'instance' | 'species'
 * @param {boolean}  props.loading 正在读学习表
 * @param {boolean}  props.saving  正在保存（这一趟按钮全部禁用，免得点两下发两次）
 * @param {?string}  props.raw    服务端原话（只进 data-loadout-raw，不上屏）
 */
export function loadoutPanelHtml({
  select = '', species = null, skills = [], pool = null, error = null,
  picked = null, status = null, via = null, loading = false, saving = false, raw = null,
} = {}) {
  const current = (Array.isArray(skills) ? skills : []).slice(0, LOADOUT_SLOTS);
  const drafted = Array.isArray(picked);
  const poolList = Array.isArray(pool) ? pool.filter((row) => row && typeof row === 'object' && row.skill_id) : null;
  const byId = new Map((poolList ?? []).map((row) => [String(row.skill_id), row]));
  const draft = drafted
    ? Array.from({ length: LOADOUT_SLOTS }, (_, i) => {
      const entry = picked[i];
      if (entry === null || entry === undefined) return null;
      if (typeof entry === 'string') return {id: entry, name: null, sources: null};
      return {id: String(entry.skill_id ?? ''), name: textOf(entry.name), sources: sourcesText(entry)};
    })
    : null;
  const filled = draft ? draft.filter((one) => one && one.id).length : 0;

  // ── 四个槽位 ──────────────────────────────────────────────────────────
  const slots = [];
  for (let i = 0; i < LOADOUT_SLOTS; i += 1) {
    const at = i + 1;
    const cur = current[i] ?? null;
    const pick = draft ? draft[i] : null;
    if (pick && pick.id && byId.has(pick.id)) {
      const fields = skillFields(byId.get(pick.id));
      const from = sourcesText(byId.get(pick.id));
      slots.push({at, state: 'picked', tag: '你挑的', name: fields.name ?? pick.name ?? NO_ITEM,
        meta: metaLine(fields), hint: from ? `来源：${from}` : null});
      continue;
    }
    if (pick && pick.id) {
      // 挑过、但这次的学习表里没有它（或还没读学习表）：名字以外照实说「还不知道」。
      slots.push({at, state: 'picked', tag: '你挑的', name: pick.name ?? '你挑的那一个',
        meta: poolList ? '引擎这次的学习表里没有它（系别 / 耗能 / 威力都不知道）'
          : '还没读学习表：系别 / 耗能 / 威力要读了才知道',
        hint: poolList ? '先点掉它，再从下面挑一个。' : null});
      continue;
    }
    if (draft && cur) {
      slots.push({at, state: 'empty', tag: '这个位置还空着', name: '（还没挑）',
        meta: '要带四个才能保存：从下面挑一个补上。',
        hint: `不变的话还是它：${textOf(cur.name) ?? NO_ITEM}`});
      continue;
    }
    const fields = skillFields(cur);
    slots.push({at, state: 'current', tag: '现在带着的', name: fields.name ?? NO_ITEM,
      meta: metaLine(fields), hint: null});
  }

  const slotHtml = slots.map((slot) => `      <li class="bl-slot" data-loadout-slot="${slot.at}"`
    + ` data-loadout-slot-state="${slot.state}">`
    + `<span class="bl-no">第 ${slot.at} 个</span>`
    + `<span class="bl-name">${escapeHtml(slot.name)}</span>`
    + `<span class="bl-tag">${escapeHtml(slot.tag)}</span>`
    + `<span class="bl-meta">${escapeHtml(slot.meta)}</span>`
    + `${slot.hint ? `<span class="bl-hint">${escapeHtml(slot.hint)}</span>` : ''}</li>`).join('\n');

  // ── 池子（只在回执到手之后才画）────────────────────────────────────────
  const chips = (poolList ?? []).map((row) => {
    const fields = skillFields(row);
    const on = Boolean(draft && draft.some((one) => one && one.id === String(row.skill_id)));
    const from = sourcesText(row);
    const title = [fields.category ? `类别 ${fields.category}` : null, from ? `来源：${from}` : null]
      .filter(Boolean).join(' · ');
    return `      <button type="button" class="bl-chip" data-loadout-pick="${escapeHtml(row.skill_id)}"`
      + ` aria-pressed="${on ? 'true' : 'false'}"${title ? ` title="${escapeHtml(title)}"` : ''}>`
      + `${escapeHtml(fields.name ?? NO_ITEM)}<span class="bl-chip-meta">${escapeHtml(chipLine(fields))}</span>`
      + '</button>';
  }).join('\n');

  // ── 说明那一句（只写回执里真有的数字）──────────────────────────────────
  let note;
  if (loading) note = '正在读它的学习表…';
  else if (error) note = `读不到它的学习表：${error}`;
  else if (poolList && !poolList.length) note = '引擎这次没给可学技能（这一只的学习表是空的）。';
  else if (poolList) {
    note = `它能学 ${poolList.length} 个技能（原生 / 血脉 / 技能石），不排优先级：游戏数据里没有强度排序。`
      + ` 带哪 ${LOADOUT_SLOTS} 个由你决定`
      + (draft ? `（现在挑满 ${filled}/${LOADOUT_SLOTS} 个）。` : '，点下面的按钮就能挑。')
      + (via === 'species' ? ' 这份学习表是按它的种类查的。' : '');
  } else note = '这是它现在带着的四个。点「看它能学什么」读一下引擎的学习表，就能换。';

  const actions = [];
  const busy = saving ? ' disabled' : '';
  if (!poolList) {
    actions.push(`<button type="button" class="bl-btn" data-loadout-read="1"`
      + `${loading || saving ? ' disabled' : ''}>`
      + `${loading ? '正在读学习表…' : (error ? '再读一次' : '看它能学什么')}</button>`);
  }
  if (poolList) {
    actions.push(`<button type="button" class="bl-btn" data-loadout-save="1"`
      + `${filled === LOADOUT_SLOTS && !saving ? '' : ' disabled'}>${saving ? '正在确认…' : '保存这四个'}</button>`);
    actions.push(`<button type="button" class="bl-btn" data-loadout-reset="1"${busy}>恢复成现在带着的四个</button>`);
  } else if (draft && filled === LOADOUT_SLOTS) {
    // 本机记录里有四个（上次保存过），但这次还没读学习表：允许直接再确认一次。
    actions.push(`<button type="button" class="bl-btn" data-loadout-save="1"${busy}>`
      + `${saving ? '正在确认…' : '保存这四个'}</button>`);
  }

  const statusText = textOf(status?.text);
  const panelState = loading ? 'loading'
    : (saving ? 'saving' : (error ? 'error' : (poolList ? 'ready' : 'idle')));
  const statusKind = textOf(status?.kind) ?? (error ? 'error' : (poolList ? 'ok' : 'idle'));

  return `<section class="bl" data-loadout-panel data-loadout-for="${escapeHtml(select)}"`
    + ` data-loadout-state="${panelState}" data-loadout-picks="${filled}"`
    + `${via ? ` data-loadout-via="${escapeHtml(via)}"` : ''}`
    + `${raw ? ` data-loadout-raw="${escapeHtml(String(raw).slice(0, 300))}"` : ''}>`
    + '\n      <h4>换技能</h4>'
    + `\n      <p class="bl-note">${escapeHtml(note)}</p>`
    + `\n      <ol class="bl-slots">\n${slotHtml}\n      </ol>`
    + (chips ? `\n      <div class="bl-pool">\n${chips}\n      </div>` : '')
    + `\n      <div class="bl-actions">\n        ${actions.join('\n        ')}\n      </div>`
    + (statusText ? `\n      <p class="bl-status" data-loadout-status="${escapeHtml(statusKind)}">`
      + `${escapeHtml(statusText)}</p>` : '')
    + '\n    </section>';
}

// ── 本机记录（只在浏览器里用得上；Node 里靠注入的 storage 走同一条路）──────────

function readStored(storage, select) {
  try {
    const all = JSON.parse(storage?.getItem(STORE_KEY) ?? '{}');
    const row = all && typeof all === 'object' ? all[String(select)] : null;
    if (!row || !Array.isArray(row.ids) || row.ids.length !== LOADOUT_SLOTS) return null;
    if (!row.ids.every((id) => typeof id === 'string' && id)) return null;
    const names = Array.isArray(row.names) ? row.names : [];
    return {ids: row.ids.slice(), names: Array.from({length: LOADOUT_SLOTS}, (_, i) => textOf(names[i]))};
  } catch { return null; }
}

function writeStored(storage, select, ids, names) {
  try {
    const all = JSON.parse(storage?.getItem(STORE_KEY) ?? '{}');
    const next = all && typeof all === 'object' ? all : {};
    next[String(select)] = {ids: ids.slice(), names: names.slice(), at: new Date().toISOString()};
    storage.setItem(STORE_KEY, JSON.stringify(next));
    return true;
  } catch { return false; }
}

// ── 挂载（只有它碰 DOM）────────────────────────────────────────────────────

/** 一个宿主元素一个控制器：`renderPetPage()` 每次重画都调挂载，不能越挂越多监听。 */
const MOUNTED = new WeakMap();

/** 样式只注入一次（`<head>`，见文件头）。 */
function injectStyle() {
  const doc = globalThis.document;
  if (!doc?.head || doc.getElementById?.(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = LOADOUT_STYLE;
  doc.head.appendChild(style);
}

/**
 * 面板自己造宿主：接在 `#pet-actions` **后面**（与它同级）。
 * 为什么要同级：`box.js` 的 `renderPetPage()` 每次都用 `innerHTML` 重画 `#pet-actions`，
 * 挂在它**里面**会被下一次重画抹掉；同级的兄弟节点不受影响（box.html:137-138 的结构）。
 */
function hostFallback() {
  const doc = globalThis.document;
  if (!doc?.getElementById) return null;
  const actions = doc.getElementById('pet-actions');
  if (!actions?.parentNode) return null;
  let host = doc.getElementById('pet-loadout');
  if (!host) {
    host = doc.createElement('div');
    host.id = 'pet-loadout';
  }
  if (host.parentNode !== actions.parentNode || host.previousSibling !== actions) {
    actions.parentNode.insertBefore(host, actions.nextSibling);
  }
  return host;
}

function defaultRequest(path) {
  const init = {cache: 'no-store'};
  if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(30000);
  return fetch(path, init).then((response) => response.json());
}

/**
 * 把面板挂到 `#pet-actions` 右边/下面，并接线（只有它碰 DOM）。
 *
 * @param {object}   props
 * @param {?Element} props.root     挂到哪儿。不给就自己造 `#pet-loadout`（接在 `#pet-actions` 后面）
 * @param {string}   props.select   这一只的编号（`own-XXXX` / `pet_XXXXXX`）
 * @param {?string}  props.species  物种编号（按个体查不到时兜底）
 * @param {object[]} props.skills   现在带着的四个（盒子详情页那一份）
 * @param {Function} props.request  取数：`(path) => Promise<data>`。不给就用 `fetch`
 * @param {?object}  props.storage  本机记录。不给就用 `localStorage`
 * @returns {?{update:Function,destroy:Function,state:object}}
 */
export function mountLoadout(props = {}) {
  const {root = null, request = null} = props;
  injectStyle();
  const host = root ?? hostFallback();
  if (!host) return null;
  const existing = MOUNTED.get(host);
  if (existing) {
    existing.update(props);
    return existing;
  }
  return createController(host, props, request);
}

function createController(host, props, request) {
  const state = {
    select: '', species: null, skills: [], pool: null, petId: null, error: null,
    loading: false, saving: false, status: null, raw: null, via: null, seq: 0,
    draft: [null, null, null, null], names: new Map(), request, storage: null,
    prefilled: false,
  };

  const controller = {update, destroy, state};
  MOUNTED.set(host, controller);
  host.addEventListener('click', onClick);
  update(props);
  return controller;

  function requestOf() {
    return state.request ?? defaultRequest;
  }

  function storageOf() {
    if (state.storage) return state.storage;
    try { return globalThis.localStorage ?? null; } catch { return null; }
  }

  function render() {
    host.innerHTML = loadoutPanelHtml({
      select: state.select,
      species: state.species,
      skills: state.skills,
      pool: state.pool,
      error: state.error,
      // 名字：池子里有就以池子为准，没有就用本机记下来的那一个（两个都没有就照实说「你挑的那一个」）。
      picked: (state.pool || state.draft.some(Boolean))
        ? state.draft.map((id) => (id ? {skill_id: id, name: state.names.get(id) ?? null} : null))
        : null,
      status: state.status,
      via: state.via,
      loading: state.loading,
      saving: state.saving,
      raw: state.raw,
    });
    host.dataset.loadoutState = state.loading ? 'loading'
      : (state.saving ? 'saving' : (state.error ? 'error' : (state.pool ? 'ready' : 'idle')));
    host.dataset.loadoutFor = state.select;
  }

  /** 换了一只就**整块清掉**（上一只的池子绝不能留在这一只的屏上）。 */
  function update(next = {}) {
    if (typeof next.request === 'function') state.request = next.request;
    if (next.storage !== undefined) state.storage = next.storage;
    const select = String(next.select ?? '');
    if (select !== state.select) {
      state.seq += 1;
      state.select = select;
      state.species = null;
      state.pool = null;
      state.petId = null;
      state.error = null;
      state.raw = null;
      state.via = null;
      state.loading = false;
      state.saving = false;
      state.status = null;
      state.prefilled = false;
      state.names = new Map();
      const stored = readStored(storageOf(), select);
      state.draft = stored ? stored.ids.slice() : [null, null, null, null];
      // 本机记过就以本机那份为草稿 —— 不许被「现在带着的四个」再预选一次盖掉。
      if (stored) state.prefilled = true;
      if (stored) {
        stored.names.forEach((name, i) => { if (name) state.names.set(stored.ids[i], name); });
        state.status = {kind: 'ok', text: `上次你保存的是这四个：`
          + `${stored.ids.map((id) => state.names.get(id) ?? '一个技能').join('、')}`
          + '（记在这台浏览器上）。要改就点「看它能学什么」。'};
      }
    }
    if (next.species !== undefined) state.species = textOf(next.species);
    if (Array.isArray(next.skills)) state.skills = next.skills.slice(0, LOADOUT_SLOTS);
    // 池子已经读过了、这一只的四个又刚拿到（详情页是两段式渲染）：这时候才补预选。
    if (prefill()) {
      const missed = unmatchedNote();
      state.status = missed ? {kind: 'error', text: missed} : state.status;
    }
    render();
  }

  function destroy() {
    host.removeEventListener?.('click', onClick);
    MOUNTED.delete(host);
    if (host.replaceChildren) host.replaceChildren();
    else host.innerHTML = '';
    // 接线钩子也要收干净（dataset 的键删掉 = 真实 DOM 里属性跟着没了）。
    delete host.dataset?.loadoutState;
    delete host.dataset?.loadoutFor;
  }

  /** 点一个技能：已经在草稿里就点掉它，否则放进**第一个空位**。 */
  function toggle(id) {
    const at = state.draft.findIndex((one) => one === id);
    if (at >= 0) {
      state.draft = state.draft.map((one, i) => (i === at ? null : one));
      state.status = null;
      render();
      return;
    }
    const empty = state.draft.findIndex((one) => !one);
    if (empty < 0) {
      state.status = {kind: 'error', text: `${LOADOUT_SLOTS} 个位置都挑满了：先点掉一个，再挑新的。`};
      render();
      return;
    }
    state.draft = state.draft.map((one, i) => (i === empty ? id : one));
    state.status = null;
    render();
  }

  function resetDraft() {
    state.draft = resolvedCurrentIds();
    state.prefilled = true;
    state.status = unmatchedNote() ? {kind: 'error', text: unmatchedNote()} : null;
    state.raw = null;
    state.error = null;
    render();
  }

  /**
   * 「现在带着的四个」→ 技能 id。
   *
   * 盒子详情页那一份**没有 id**（`boxSkillsPlayer()` 只给名字，见 roco-service.js:707-721），
   * 所以只能拿名字去学习表里对 —— 而且**只认唯一命中**：对不上、或对上不止一条（全库确有
   * 重名技能，例如「腾挪」对应 skill_000134 与 skill_000164），一律不猜、留空让玩家自己挑。
   */
  function resolvedCurrentIds() {
    const pool = state.pool ?? [];
    const used = new Set();
    return Array.from({length: LOADOUT_SLOTS}, (_, i) => {
      const name = textOf(state.skills[i]?.name);
      if (!name) return null;
      const hits = pool.filter((row) => textOf(row.name) === name);
      if (hits.length !== 1) return null;
      const id = String(hits[0].skill_id);
      if (used.has(id)) return null;
      used.add(id);
      state.names.set(id, name);
      return id;
    });
  }

  /** 预选一次就够（玩家自己点掉之后不许再被塞回来）。 */
  function prefill() {
    if (state.prefilled || !state.pool) return false;
    const ids = resolvedCurrentIds();
    if (!ids.some(Boolean)) return false;
    state.draft = ids;
    state.prefilled = true;
    return true;
  }

  /** 换了名字对不上的，如实说出来（不静默凑四个）。 */
  function unmatchedNote() {
    const missed = state.skills.slice(0, LOADOUT_SLOTS)
      .filter((row, i) => textOf(row?.name) && !state.draft[i]);
    if (!missed.length) return null;
    const names = missed.map((row) => textOf(row?.name)).join('、');
    return `现在这四个里，有 ${missed.length} 个（${names}）按名字在引擎的学习表里对不上，`
      + '所以没有替你预选：请自己从下面挑。';
  }

  /**
   * 问一次引擎的学习表。按**个体**问不到（本机新养的、或不在名单上的那一只）就按**种类**
   * 再问一次 —— 这是服务端自己在错误句里给的路（roco-service.js:2442）。两次都失败返回第二次的回执。
   * 读池子与「保存前的确认」走的是同一段，不存在两套口径。
   */
  async function fetchPool() {
    const wanted = state.select;
    let via = 'instance';
    let reply = await ask(wanted);
    if (reply?.ok !== true && state.species && state.species !== wanted
      && /不在你的名单里/.test(String(reply?.error ?? ''))) {
      via = 'species';
      reply = await ask(state.species);
    }
    return {reply, via};
  }

  /** 读池子。失败一律 fail closed（照实说清 + 留重试按钮），绝不白屏。 */
  async function loadPool() {
    if (!state.select) {
      // 没告诉我们是哪一只就别去问引擎（问了也是白问），如实说清为什么会没反应。
      state.status = {kind: 'error', text: '还没选中哪一只：先回列表点一行，再回来换技能。'};
      render();
      return;
    }
    const seq = state.seq + 1;
    state.seq = seq;
    state.loading = true;
    state.error = null;
    state.raw = null;
    render();
    try {
      const {reply, via} = await fetchPool();
      if (seq !== state.seq) return;                    // 已经切到别的了：这一次结果丢掉
      if (reply?.ok !== true) throw new Error(String(reply?.error ?? ''));
      const rows = (Array.isArray(reply.learnable) ? reply.learnable : [])
        .filter((row) => row && typeof row === 'object' && row.skill_id);
      state.pool = rows;
      state.petId = textOf(reply.pet_id);
      state.via = via;
      state.error = null;
      state.raw = null;
      for (const row of rows) {
        const name = textOf(row.name);
        if (name) state.names.set(String(row.skill_id), name);
      }
      // 草稿：本机记录 > 现在这四个（按名字唯一对上）。两边都没有就留空让玩家自己挑。
      prefill();
      const missed = unmatchedNote();
      state.status = missed ? {kind: 'error', text: missed} : null;
    } catch (error) {
      if (seq !== state.seq) return;
      state.pool = null;
      state.error = playerReasonOf(error?.message ?? error);
      state.raw = String(error?.message ?? error ?? '').slice(0, 300);
    } finally {
      if (seq === state.seq) {
        state.loading = false;
        render();
      }
    }
  }

  /**
   * 保存。
   *
   * **回执为证**：点保存时再问一次引擎（同一个端点），拿回执里的 `learnable` 逐条对照；
   * 四个都在才说「已保存」，并且把回执里那四个的**名字**原样写出来。任何一个不在、
   * 或者请求根本没回来，都只说失败 —— 不许乐观 UI。
   */
  async function save() {
    const ids = state.draft.filter(Boolean);
    if (ids.length !== LOADOUT_SLOTS) {
      state.status = {kind: 'error', text: `要挑满 ${LOADOUT_SLOTS} 个才能保存（现在 ${ids.length} 个）。`};
      render();
      return;
    }
    if (new Set(ids).size !== ids.length) {
      state.status = {kind: 'error', text: '同一个技能只能带一次：先点掉重复的那个。'};
      render();
      return;
    }
    state.saving = true;
    state.status = null;
    render();
    try {
      const {reply, via} = await fetchPool();
      if (reply?.ok !== true) throw new Error(String(reply?.error ?? ''));
      const rows = (Array.isArray(reply.learnable) ? reply.learnable : [])
        .filter((row) => row && typeof row === 'object' && row.skill_id);
      const byId = new Map(rows.map((row) => [String(row.skill_id), row]));
      const missingAt = ids.map((id, i) => (byId.has(id) ? null : i + 1)).filter(Boolean);
      if (missingAt.length) {
        // 回执说学不到 ⇒ 不保存、不更新草稿，把是哪几个位置说清楚。
        state.status = {kind: 'error',
          text: `没保存：引擎这次给的学习表里没有你挑的第 ${missingAt.join('、')} 个。先点掉它再挑一个。`};
        state.pool = rows;
        for (const row of rows) {
          const name = textOf(row.name);
          if (name) state.names.set(String(row.skill_id), name);
        }
        return;
      }
      const names = ids.map((id) => textOf(byId.get(id)?.name) ?? state.names.get(id) ?? NO_ITEM);
      state.pool = rows;
      state.petId = textOf(reply.pet_id);
      state.via = via;
      state.error = null;
      state.raw = null;
      ids.forEach((id, i) => state.names.set(id, names[i]));
      const stored = writeStored(storageOf(), state.select, ids, names);
      const receipt = `引擎确认这四个都学得到（它能学 ${rows.length} 个）：`
        + names.map((name, i) => `第 ${i + 1} 个 ${name}`).join('、') + '。';
      state.status = stored
        ? {kind: 'ok', text: `已保存：${receipt}这份选择记在这台浏览器上；盒子这一页不开局，`
          + '去开局那一页时请照这四个重新带上。'}
        : {kind: 'warn', text: `引擎确认过这四个都学得到，但这台浏览器不让记（可能是隐私模式）：`
          + '刷新之后这份选择就没了。'};
    } catch (error) {
      state.status = {kind: 'error', text: `没保存：${playerReasonOf(error?.message ?? error)}`};
      state.raw = String(error?.message ?? error ?? '').slice(0, 300);
    } finally {
      state.saving = false;
      render();
    }
  }

  async function ask(pet) {
    const data = await requestOf()(loadoutOptionsPath(pet));
    return data && typeof data === 'object' ? data : null;
  }

  function onClick(event) {
    const node = event?.target?.closest?.(
      '[data-loadout-read],[data-loadout-pick],[data-loadout-save],[data-loadout-reset]');
    if (!node?.dataset) return;
    if (node.dataset.loadoutRead !== undefined) { void loadPool(); return; }
    if (node.dataset.loadoutSave !== undefined) { void save(); return; }
    if (node.dataset.loadoutReset !== undefined) { resetDraft(); return; }
    if (node.dataset.loadoutPick !== undefined && state.pool) toggle(String(node.dataset.loadoutPick));
  }
}
