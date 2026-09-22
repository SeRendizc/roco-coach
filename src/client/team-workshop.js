// RC-305 六槽阵容工作台：**可挂载模块**（纯原生 ES module，无打包器、无 JSX/TS）。
//
// 产品页是 `src/client/roco.html`。这个模块不另起一套评价逻辑：它只消费
// `GET /api/roco/workshop` 的回执，而那条路由内部直接调 RC-301 请求合同 →
// RC-302 七维缺口诊断 → RC-303 候选生成 → RC-304 环境先验/五轴。
// **模块自己不写模板化的分数、不算第二套属性表、不产出任何胜率。**
//
// 挂载方式（主线程 `roco.js` 只需要两行）：
//
//   import {mountTeamWorkshop} from '/src/client/team-workshop.js';
//   const workshop = mountTeamWorkshop(document.getElementById('team-workshop'), {onTeamChange});
//
// 导出：
//   mountTeamWorkshop(rootEl, opts) → {
//     root, shadow, reload(), getTeam(), getPayload(), coachSummary(), destroy()
//   }
//   opts.onTeamChange({team, locks, favourite, maxReplacements, coachSummary, payload})
//   opts.apiBase   默认 '/api/roco'
//
// 占用范围（第 92 轮的**边界裁定**，主线程集成时按这个挂）：
//   · 容器：`#team-workshop`（产品页 `roco.html` 里的一个空 `<section>`）；
//     渲染全部发生在它的 **shadow root** 里，宿主页的 CSS/DOM 不被改写。
//   · 模块内 = **选阵容阶段的 Coach 栏**（`.tw-coach`）+ 队伍六槽 + 候选池 + 阵容评估。
//     这一层放：短结论、缺口口径、下一只候选、展开依据（依据在评估区，不重复一份），
//     并把「军师建议 / 阵容评估 / 小芽」三层分开写：评估=结构诊断，Coach=短结论，军师=局中浮条（不在本模块）。
//   · 模块外 = 页头「✦ 小芽」入口与**聊天/记忆抽屉**（陪练对话、偏好记忆、主动提示浮条）。
//     那是全局的，**不属于本模块**：这里没有输入框、没有记忆列表、页面底部也没有小芽表单。
//
// 三层数据同源：`coachSummary()` 与右侧 Coach 栏读的是同一次 `/api/roco/workshop` 回执，
// 所以「小芽说的」和「评估显示的」不可能互相矛盾。
//
// 布局（与主线程的栅格对齐：桌面端左右区域顶部/底部/卡片高度同一个栅格，移动端固定顺序）：
//   桌面：[队伍六个槽位 | 候选池] [当前评估 | Coach]
//   移动：队伍槽位 → 候选池 → 当前评估 → Coach 短提示（DOM 顺序即这个顺序）
//
// 两层分界：玩家可见文本里只有名字 / 系别 / 取舍标签 / 玩家可读的「未核实」说明；
// 工程字段（pet_id / instance_id / confidence / provenance / unknown_reason / ranker_status /
// ruleset）一个都不出现。模块把**完整回执**放在元素属性 `data-tw-payload` 上供本机测试读，
// 那一段不在可见文本里，页面上也永远不渲染它。

/** 三枚徽记的文本（页面渲染与验收判据共用一份；第三处手抄就会漂）。 */
export const TEAM_WORKSHOP_BADGES = Object.freeze({
  mode: '标准 PVP · 六宠',
  candidate: '候选规则（待实机核对）',
  unknown_prematch: '匹配前对手未知 · 按版本环境倾向评价',
  universe: '候选来自全图鉴',
});

/** 队伍六个槽位。**不是「已选 3 只固定栏」**：v3 已废止那个口径。 */
export const TEAM_SLOTS = 6;

/** 五个口径的显示顺序与玩家说明（与路由的 `axis_order` 同源，只是翻译成人话）。 */
export const AXIS_LABELS = Object.freeze(['环境价值', '最怕的体系', '对局离散度', '操作容错', '覆盖置信']);
export const AXIS_LEGEND = Object.freeze({
  环境价值: '这支队对「版本里常见的对手类型」的整体表现。要有对手分布才能算。',
  最怕的体系: '撞上哪一类体系最吃亏、那一类在环境里占多少。要有对手分布才能算。',
  对局离散度: '表现是不是严重依赖撞到特定阵容。要有对手分布才能算。',
  操作容错: '操作打折扣时会掉多少。要有可复跑的对局采样才能算。',
  覆盖置信: '这六只的配招与数据我们到底知道多少——它说的是**我们自己知道多少**，不是队伍有多强。',
});

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const escapeAttr = escapeHtml;
const NO_ITEM = '本仓库没有这一项';

const STYLE = `
:host{display:block;color:#e3eaf1;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
*{box-sizing:border-box}
.tw-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:start}
.tw-panel{background:#1a2635;border:1px solid #314154;border-radius:12px;padding:6px 12px 10px;min-width:0}
.tw-team{grid-column:span 2}
.tw-cand{grid-column:span 2}
.tw-eval{grid-column:span 2}
.tw-coach{grid-column:span 2}
.tw-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0 8px}
.tw-head h3{margin:0;font-size:15px}
.tw-head .tw-sub{color:#9caebe;font-size:12px;margin-left:auto}
.tw-badges{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px}
.tw-badge{font-size:11.5px;border:1px solid #4a6858;color:#a8e5b0;border-radius:6px;padding:3px 8px}
.tw-badge.warn{border-color:#6b5a33;color:#f0cb77}
.tw-badge.muted{border-color:#3a4a5c;color:#9caebe}
.tw-slots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.tw-slot{border:1px dashed #36495e;border-radius:10px;padding:8px 9px;min-height:84px;
 display:flex;flex-direction:column;gap:4px;min-width:0}
.tw-slot.on{border-style:solid;border-color:#8dd49c;background:#17242f}
.tw-slot .tw-who{font-weight:600;font-size:14px;overflow-wrap:anywhere}
.tw-slot .tw-meta{color:#9caebe;font-size:11.5px;line-height:1.5;overflow-wrap:anywhere}
.tw-slot .tw-row{display:flex;gap:6px;align-items:center;min-width:0}
.tw-slot .tw-lock{margin-left:auto;color:#9caebe;font-size:11px;white-space:nowrap}
.tw-types{display:flex;flex-wrap:wrap;gap:3px}
/* 机制一行：冻结原文逐字照印，**不截断**（宁可折行也不砍半句）；小字、和正文拉开层级。 */
.tw-mech{display:flex;flex-direction:column;gap:2px;margin-top:2px;min-width:0}
.tw-mech-line{font-size:11.5px;line-height:1.55;color:#bcd0e0;overflow-wrap:anywhere}
.tw-mech-tags{font-size:11px;line-height:1.5;color:#8fa4b6;overflow-wrap:anywhere}
[data-tw-mechanism="pending"] .tw-mech-line{color:#9caebe;font-style:normal}
.tw-type{font-size:11px;background:#26374a;border-radius:5px;padding:2px 7px;color:#c8d5e2}
.tw-note{margin:0;color:#9caebe;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.tw-lead{margin:0 0 7px;font-size:13.5px;line-height:1.7}
.tw-cards{display:grid;gap:8px}
.tw-card{border:1px solid #314154;border-radius:10px;padding:9px 11px;background:#16222f;min-width:0}
.tw-card.tw-next{cursor:default}
.tw-card-head{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:5px}
.tw-card-head b{color:#a8e5b0;font-size:14px;overflow-wrap:anywhere}
.tw-tag{font-size:11px;border:1px solid #4a6858;color:#a8e5b0;border-radius:5px;padding:2px 7px}
.tw-tag.stable{border-color:#4a6070;color:#bcd0e0}
.tw-tag.pref{border-color:#6b5a33;color:#f0cb77}
.tw-tag.muted{border-color:#3a4a5c;color:#9caebe}
.tw-card p{margin:4px 0 0;font-size:12.5px;line-height:1.6;color:#cfdae5;overflow-wrap:anywhere}
.tw-card p.dim{color:#9caebe}
.tw-gaps{display:grid;gap:6px;margin:6px 0 0}
.tw-gap{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;font-size:12.5px;min-width:0}
.tw-gap .tw-dim{font-weight:600}
.tw-gap .tw-state{font-size:11px;border:1px solid #3a4a5c;color:#9caebe;border-radius:5px;padding:1px 7px}
.tw-axes{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:7px}
.tw-axis{border:1px solid #314154;border-radius:9px;padding:8px 10px;background:#16222f;min-width:0}
.tw-axis-head{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
.tw-axis-head b{font-size:13.5px}
.tw-axis-state{font-size:11px;border-radius:5px;padding:2px 7px;border:1px solid transparent}
.tw-axis-state.on{border-color:#4a6858;color:#a8e5b0;background:#17242f}
.tw-axis-state.off{border-color:#6b5a33;color:#f0cb77;background:#241f16}
.tw-axis p{margin:5px 0 0;font-size:12.5px;line-height:1.6;overflow-wrap:anywhere}
.tw-cand-tools{display:flex;flex-wrap:wrap;gap:7px;align-items:center;margin-bottom:8px}
.tw-cand-tools input{flex:1 1 180px;min-width:0;min-height:44px;font-size:13.5px;background:#121e2c;
 color:#dbe5ef;border:1px solid #314154;border-radius:7px;padding:7px 9px}
.tw-cand-list{display:grid;gap:6px;max-height:290px;overflow:auto}
.tw-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;text-align:left;min-height:44px;
 background:#16222f;border:1px solid #314154;border-radius:9px;padding:7px 10px;color:#dfe8ef;
 font:inherit;cursor:pointer}
.tw-row:hover{background:#1e3043;border-color:#7e9bb8}
.tw-row .tw-name{font-size:13.5px;font-weight:600;overflow-wrap:anywhere}
.tw-row .tw-rowtag{margin-left:auto;font-size:11px;color:#9caebe;white-space:nowrap}
.tw-pager{display:flex;flex-wrap:wrap;gap:7px;align-items:center;justify-content:flex-end;margin-top:8px;font-size:12px;color:#9caebe}
.tw-knobs{display:flex;flex-wrap:wrap;gap:7px;align-items:center}
.tw-btn{font:inherit;cursor:pointer;color:#dfe8ef;background:#243345;border:1px solid #394a5e;
 border-radius:8px;padding:8px 12px;min-height:44px;min-width:44px}
.tw-btn:hover:not(:disabled){background:#324961;border-color:#7e9bb8}
.tw-btn:disabled{opacity:.4;cursor:not-allowed}
.tw-btn[aria-pressed="true"]{background:#a8e5b0;color:#152c24;border-color:#a8e5b0;font-weight:600}
.tw-btn.primary{background:#a8e5b0;color:#152c24;border-color:#a8e5b0;font-weight:600}
.tw-fmenu{position:relative}
.tw-fmenu>summary{cursor:pointer;list-style:none;background:#121e2c;border:1px solid #314154;
 border-radius:8px;padding:8px 11px;min-height:44px;display:inline-flex;align-items:center;gap:6px;font-size:13px}
.tw-fmenu>summary::-webkit-details-marker{display:none}
.tw-fmenu>summary::after{content:'▾';color:#9caebe;font-size:11px}
.tw-fmenu-body{position:absolute;right:0;top:calc(100% + 4px);z-index:20;width:max-content;
 max-width:min(260px,80vw);background:#16222f;border:1px solid #314154;border-radius:10px;padding:8px;
 display:flex;flex-wrap:wrap;gap:6px;box-shadow:0 12px 34px #0009}
.tw-coach-body{border:1px solid #4a6076;border-radius:10px;background:#17232f;padding:10px 12px;min-width:0}
.tw-coach-body .tw-who{color:#a8e5b0;font-weight:600}
.tw-coach-body p{margin:5px 0 0;font-size:12.5px;line-height:1.65;overflow-wrap:anywhere}
.tw-unknowns{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:6px}
.tw-unknown{display:flex;flex-wrap:wrap;gap:6px;align-items:baseline;font-size:12.5px;line-height:1.55}
.tw-unknown .tw-state{font-size:11px;border:1px solid #3a4a5c;color:#9caebe;border-radius:5px;padding:1px 7px}
.tw-unknown .tw-text{flex:1 1 200px;color:#c2ceda;min-width:0}
.tw-replacement{border:1px solid #4a6076;border-radius:10px;padding:9px 11px;margin-top:9px;background:#17232f}
.tw-replacement h4{margin:0 0 5px;font-size:13px;color:#a8e5b0}
.tw-replacement p{margin:4px 0 0;font-size:12.5px;line-height:1.65;overflow-wrap:anywhere}
.tw-error{margin:6px 0 0;color:#f0cb77;font-size:12.5px;line-height:1.6;overflow-wrap:anywhere}
@media(max-width:1000px){
 .tw-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
 .tw-coach{grid-column:span 2}
}
@media(max-width:620px){
 .tw-grid{grid-template-columns:minmax(0,1fr)}
 .tw-team,.tw-cand,.tw-eval,.tw-coach{grid-column:span 1}
 .tw-slots{grid-template-columns:repeat(2,minmax(0,1fr))}
 .tw-cand-list{max-height:none}
 .tw-pager{justify-content:space-between}
}
`;

/**
 * 机制资料待确认时的替代文案。
 *
 * 这份文本的**唯一事实源**是 `src/coach/pet-mechanisms.js` 的 `MECHANISM_FALLBACK`；
 * 服务端拿不到冻结 `desc` 时会把 `mechanism.line` 直接填成它，所以页面通常压根用不到
 * 这个常量——留一份只是兜底（字段缺失 / 形状不对时也要说人话）。
 * 浏览器侧**不** import 那个模块：它是给 Node 读产物用的，拉进页面只会白带一份解析逻辑。
 */
const MECHANISM_PENDING = '机制资料待确认';

/** 只有「冻结原文 + 真有一行」才首层显示原文；其余一律「机制资料待确认」。 */
const isFrozenMechanism = (mechanism) => Boolean(mechanism)
  && mechanism.status === 'FROZEN_DESC'
  && typeof mechanism.line === 'string' && mechanism.line.trim() !== '';

/**
 * 卡片首层的「机制」一行。
 *
 * 三条硬规则（第 92 轮追加）：
 *   ① 冻结原文（`FROZEN_DESC` + 非空 `line`）⇒ 首层显示**逐字**原文（小字、单行优先，
 *      但**不截断**：宁可折行也不要把一句话砍成半句）；
 *   ② 取不到 / `MECHANISM_UNCONFIRMED` / 字段形状不对 ⇒ 「机制资料待确认」（这一行仍然给，
 *      因为「没有资料」本身是信息）；空槽位**什么都不显示**（调用方不渲染这一行）；
 *   ③ 枚举原文（`FROZEN_DESC` 这类）**永远不印到页面上**——玩家看到的是人话。
 *
 * `tags` 是「体系线索」（这一只参与了哪些机制标签），**不是强度排序**，
 * 所以只印标签名、不印 skills 计数。
 */
function mechanismRow(mechanism) {
  const frozen = isFrozenMechanism(mechanism);
  const line = frozen ? mechanism.line.trim() : MECHANISM_PENDING;
  const tags = (Array.isArray(mechanism?.tags) ? mechanism.tags : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.tag))
    .filter((tag) => typeof tag === 'string' && tag.trim() !== '');
  return `<div class="tw-mech" data-tw-mechanism="${frozen ? 'frozen' : 'pending'}">
   <span class="tw-mech-line">${escapeHtml(line)}</span>
   ${tags.length ? `<span class="tw-mech-tags">机制线索：${escapeHtml(tags.join(' · '))}</span>` : ''}
  </div>`;
}

/** 引擎里那一轴的原始值怎么读成人话。**没有值就返回 null**，不拿 0 顶上。 */
function axisValueText(axis) {
  if (!axis.available || axis.value === null || axis.value === undefined) return null;
  if (axis.value_kind === 'archetype') {
    const weight = axis.value.weight === null || axis.value.weight === undefined
      ? '环境占比未登记' : `环境占比 ${axis.value.weight}`;
    return `${axis.value.archetype_id ?? NO_ITEM}（${weight}）`;
  }
  const unit = axis.value_kind === 'spread' ? '相对分极差' : '相对分（0～1 的序数标度）';
  return `${axis.value} · ${unit}`;
}

const teamSlugs = (types) => (Array.isArray(types) ? types : [])
  .map((type) => `<span class="tw-type">${escapeHtml(type)}</span>`).join('');

/**
 * 挂载六槽阵容工作台。
 *
 * @param {Element} rootEl  挂载点（会建一个开放的 shadow root，避免与宿主页样式互相踩）
 * @param {object}  [opts]
 * @param {string}  [opts.apiBase='/api/roco']
 * @param {function} [opts.onTeamChange]  队伍变化时的回调（主线程用它把同一份评估喂给小芽）
 */
export function mountTeamWorkshop(rootEl, opts = {}) {
  if (!rootEl) throw new Error('mountTeamWorkshop：需要一个挂载点元素');
  const apiBase = opts.apiBase ?? '/api/roco';
  const onTeamChange = typeof opts.onTeamChange === 'function' ? opts.onTeamChange : null;

  const shadow = rootEl.shadowRoot ?? rootEl.attachShadow({mode: 'open'});
  shadow.innerHTML = `
   <style>${STYLE}</style>
   <div class="tw-grid">
    <section class="tw-panel tw-team" aria-labelledby="tw-team-title">
     <div class="tw-head"><h3 id="tw-team-title">队伍（六个槽位）</h3>
      <span class="tw-sub" id="tw-team-sub">还差 6 只</span></div>
     <div class="tw-badges">
      <span class="tw-badge" id="tw-badge-mode">${escapeHtml(TEAM_WORKSHOP_BADGES.mode)}</span>
      <span class="tw-badge warn" id="tw-badge-rule">${escapeHtml(TEAM_WORKSHOP_BADGES.candidate)}</span>
      <span class="tw-badge muted" id="tw-badge-unknown">${escapeHtml(TEAM_WORKSHOP_BADGES.unknown_prematch)}</span>
      <span class="tw-badge muted" id="tw-badge-universe">${escapeHtml(TEAM_WORKSHOP_BADGES.universe)} 600+</span>
     </div>
     <div class="tw-slots" id="tw-slots" role="list"></div>
     <p class="tw-note" id="tw-team-note"></p>
     <p class="tw-note" id="tw-team-constraints" hidden></p>
     <p class="tw-error" id="tw-team-error" hidden></p>
     <div class="tw-knobs" style="margin-top:9px">
      <button class="tw-btn" id="tw-favourite" aria-pressed="false">只看收藏</button>
      <details class="tw-fmenu" id="tw-replace-menu">
       <summary>最多替换：<span id="tw-replace-label">不限</span></summary>
       <div class="tw-fmenu-body" id="tw-replace-body" role="group" aria-label="最多替换几只"></div>
      </details>
      <button class="tw-btn" id="tw-reset">清空阵容</button>
     </div>
    </section>

    <section class="tw-panel tw-cand" aria-labelledby="tw-cand-title">
     <div class="tw-head"><h3 id="tw-cand-title">候选池</h3>
      <span class="tw-sub" id="tw-cand-sub">—</span></div>
     <p class="tw-note" id="tw-cand-note"></p>
     <div class="tw-cand-tools">
      <input type="search" id="tw-search" placeholder="搜索全图鉴（名字）" aria-label="搜索全图鉴候选" autocomplete="off">
      <button class="tw-btn" id="tw-cand-prev">上一页</button>
      <span class="tw-note" id="tw-cand-page">1 / 1</span>
      <button class="tw-btn" id="tw-cand-next">下一页</button>
     </div>
     <div class="tw-cand-list" id="tw-cand-list" role="group" aria-label="从全图鉴挑一只"></div>
    </section>

    <section class="tw-panel tw-eval" aria-labelledby="tw-eval-title">
     <div class="tw-head"><h3 id="tw-eval-title">阵容评估</h3>
      <span class="tw-sub" id="tw-eval-sub">—</span></div>
     <div id="tw-eval-body"></div>
    </section>

    <aside class="tw-panel tw-coach" aria-labelledby="tw-coach-title">
     <div class="tw-head"><h3 id="tw-coach-title">✦ 小芽</h3>
      <span class="tw-sub" id="tw-coach-sub">阵容阶段</span></div>
     <div class="tw-coach-body" id="tw-coach-body"></div>
     <p class="tw-note">聊天与记忆是页头「✦ 小芽」那个抽屉（全局的，不在这里）；这里只放**与上面同一份评估**得出的短结论。展开的依据在「阵容评估」那一块，两处不重复。</p>
    </aside>
   </div>`;

  const $ = (id) => shadow.getElementById(id);
  // RC-801：从盒子带过来的初始选人（`?team=own-…`）。**只认形状对的 id**：
  // 认不出的直接丢掉（不猜、不静默塞一个别的）——多带一只或少带一只都要看得见。
  const initialSelected = Array.isArray(opts.initialSelected)
    ? opts.initialSelected.filter((id) => typeof id === 'string' && /^own-\d+$/.test(id)).slice(0, TEAM_SLOTS)
    : [];
  const state = {
    selected: initialSelected.slice(),
    locked: [],
    favourite: false,
    maxReplacements: null,
    payload: null,
    error: null,
    seq: 0,
    pool: {offset: 0, total: 0, pageSize: 12, q: '', rows: []},
    poolSeq: 0,
    ownedBySpecies: new Map(),
  };

  const getJson = async (path) => {
    const response = await fetch(path, {cache: 'no-store', signal: AbortSignal.timeout(30000)});
    let data = null;
    try { data = await response.json(); } catch { /* 统一按读取失败处理 */ }
    if (!data) throw new Error('阵容工坊读取失败：本机服务没有给出可用数据');
    return data;
  };

  // ── 队伍六个槽位 ───────────────────────────────────────────────────────
  function renderTeam(player) {
    const slots = Array.isArray(player?.slots) ? player.slots : [];
    $('tw-slots').innerHTML = slots.map((slot) => {
      if (slot.state === 'filled') {
        return `<article class="tw-slot on" role="listitem" data-tw-slot="${slot.index}" data-tw-state="filled">
         <div class="tw-row"><span class="tw-who">${escapeHtml(slot.name ?? NO_ITEM)}</span>
          ${slot.locked ? '<span class="tw-lock">🔒 锁定</span>' : ''}</div>
         <div class="tw-meta"><span class="tw-types">${teamSlugs(slot.types) || '系别未登记'}</span></div>
         <div class="tw-meta">${escapeHtml(slot.build_tier_label ?? '')}</div>
         ${mechanismRow(slot.mechanism)}
        </article>`;
      }
      return `<article class="tw-slot" role="listitem" data-tw-slot="${slot.index}" data-tw-state="empty">
        <div class="tw-meta">第 ${slot.index} 槽位（空）</div>
        <div class="tw-meta">${escapeHtml(slot.empty_hint ?? '')}</div>
       </article>`;
    }).join('');
    const filled = slots.filter((slot) => slot.state === 'filled').length;
    $('tw-team-sub').textContent = filled >= TEAM_SLOTS ? '六个槽位都满了' : `还差 ${TEAM_SLOTS - filled} 只`;
    $('tw-team-note').textContent = player?.structure_note ?? '';
    const constraints = Array.isArray(player?.constraints) ? player.constraints : [];
    $('tw-team-constraints').hidden = constraints.length === 0;
    $('tw-team-constraints').textContent = constraints.length ? `当前约束：${constraints.join('；')}` : '';
    $('tw-badge-mode').textContent = player?.mode_label ?? TEAM_WORKSHOP_BADGES.mode;
    $('tw-badge-rule').textContent = player?.candidate_rule_label ?? TEAM_WORKSHOP_BADGES.candidate;
    $('tw-badge-unknown').textContent = player?.unknown_prematch_note ?? TEAM_WORKSHOP_BADGES.unknown_prematch;
    $('tw-badge-universe').textContent = player?.candidates_universe?.pool_label ?? `${TEAM_WORKSHOP_BADGES.universe} 600+`;
    $('tw-team-error').hidden = !state.error;
    $('tw-team-error').textContent = state.error ? `服务端原话：${state.error}` : '';
  }

  // ── 候选池（全量图鉴，可翻页 + 搜索）─────────────────────────────────
  async function loadOwnedIndex() {
    // 两套键：图鉴卡的 `select` 是物种 id，盒子卡的 `group` 才是物种 id、`select` 是个体 id。
    try {
      const data = await getJson(`${apiBase}/box?kind=mine&limit=60&offset=0`);
      const map = new Map();
      for (const card of data?.player?.cards ?? []) {
        const species = card.group ?? card.select;
        if (!species || map.has(species)) continue;
        map.set(species, {select: card.select, name: card.name});
      }
      state.ownedBySpecies = map;
    } catch { state.ownedBySpecies = new Map(); }
  }

  function renderPool() {
    const rows = state.pool.rows;
    $('tw-cand-list').innerHTML = rows.map((card) => {
      const owned = state.ownedBySpecies.get(card.select) ?? null;
      return `<button class="tw-row" data-tw-species="${escapeAttr(card.select)}"
        data-tw-owned="${owned ? escapeAttr(owned.select) : ''}">
       <span class="tw-name">${escapeHtml(card.name ?? NO_ITEM)}</span>
       <span class="tw-types">${teamSlugs(card.types)}</span>
       <span class="tw-rowtag">${owned ? '已拥有' : '图鉴条目'}</span>
      </button>`;
    }).join('');
    const pages = Math.max(1, Math.ceil(state.pool.total / state.pool.pageSize));
    const page = Math.min(pages, Math.floor(state.pool.offset / state.pool.pageSize) + 1);
    $('tw-cand-page').textContent = `${page} / ${pages}`;
    $('tw-cand-prev').disabled = state.pool.offset <= 0;
    $('tw-cand-next').disabled = state.pool.offset + state.pool.pageSize >= state.pool.total;
    $('tw-cand-sub').textContent = `全图鉴 ${state.pool.total} 条`;
    $('tw-cand-note').textContent = state.payload?.player?.candidates_universe?.note
      ?? '候选池是整本图鉴（含你还没有的），不是那 48 只迁移样例。';
    rootEl.dataset.twPoolTotal = String(state.pool.total);
    rootEl.dataset.twPoolRows = String(rows.length);
  }

  async function loadPool({reset = false} = {}) {
    if (reset) state.pool.offset = 0;
    const seq = (state.poolSeq += 1);
    const query = new URLSearchParams();
    query.set('kind', 'catalog');
    query.set('limit', String(state.pool.pageSize));
    query.set('offset', String(state.pool.offset));
    if (state.pool.q) query.set('q', state.pool.q);
    try {
      const data = await getJson(`${apiBase}/box?${query.toString()}`);
      if (seq !== state.poolSeq) return;
      if (!data.ok) throw new Error(data.error || '图鉴读取失败');
      state.pool.total = data.player.total;
      state.pool.rows = data.player.cards;
      renderPool();
    } catch (error) {
      $('tw-cand-list').innerHTML = `<p class="tw-note">候选池读取失败：${escapeHtml(error.message)}</p>`;
    }
  }

  // ── 阵容评估（三种形态，全部来自同一份路由回执）─────────────────────
  function renderGaps(player) {
    const notes = Array.isArray(player?.gap_dimension_notes) ? player.gap_dimension_notes : [];
    const unknowns = Array.isArray(player?.unknown_dimension_notes) ? player.unknown_dimension_notes : [];
    if (notes.length === 0 && unknowns.length === 0) return '';
    return `<div class="tw-gaps">
     ${notes.map((label) => `<div class="tw-gap"><span class="tw-dim">${escapeHtml(label)}</span>
      <span class="tw-state">现在还没补上</span></div>`).join('')}
     ${unknowns.map((label) => `<div class="tw-gap"><span class="tw-dim">${escapeHtml(label)}</span>
      <span class="tw-state">台账里标未核实</span></div>`).join('')}
    </div>`;
  }

  function renderEntrance(player) {
    const entrance = player?.entrance ?? null;
    if (!entrance) return '';
    return `<p class="tw-lead">${escapeHtml(entrance.headline ?? '')}</p>
     <p class="tw-note">${escapeHtml(entrance.note ?? '')}</p>
     <div class="tw-cards" style="margin-top:8px">${(entrance.candidates ?? []).map((row) => `
      <div class="tw-card" data-tw-entrance="1">
       <div class="tw-card-head"><b>${escapeHtml(row.name ?? NO_ITEM)}</b>
        <span class="tw-types">${teamSlugs(row.types)}</span></div>
       <p class="dim">${escapeHtml(row.owned_note ?? '')} · ${escapeHtml(row.build_note ?? '')}</p>
       ${mechanismRow(row.mechanism)}
      </div>`).join('')}</div>
     <p class="tw-note" style="margin-top:8px">${escapeHtml(entrance.archetype_note ?? '')}</p>`;
  }

  function renderNext(player) {
    const list = Array.isArray(player?.next_candidates) ? player.next_candidates : [];
    if (list.length === 0) return '';
    const nextIndex = (player.selected_count ?? 0) + 1;
    return `<div class="tw-head" style="margin:2px 0 6px"><h3 style="font-size:13.5px">推荐下一只（第 ${nextIndex} 只）</h3>
      <span class="tw-sub">取舍不同，不是排名</span></div>
     <div class="tw-cards">${list.map((row) => {
    const tagClass = row.tradeoff_label === '强度' ? ''
      : (row.tradeoff_label === '稳定' ? 'stable' : 'pref');
    return `<div class="tw-card tw-next" data-tw-next="1" data-tw-tradeoff="${escapeAttr(row.tradeoff_label ?? '')}">
      <div class="tw-card-head"><b>${escapeHtml(row.name ?? NO_ITEM)}</b>
       <span class="tw-tag ${tagClass}">${escapeHtml(row.tradeoff_label ?? '取舍')}</span>
       <span class="tw-types">${teamSlugs(row.types)}</span></div>
      <p>${escapeHtml(row.tradeoff_intent ?? '')}</p>
      ${mechanismRow(row.mechanism)}
      ${row.tradeoff_note ? `<p class="dim">代价：${escapeHtml(row.tradeoff_note)}</p>` : ''}
      ${row.fallback_note ? `<p class="dim">${escapeHtml(row.fallback_note)}</p>` : ''}
      ${row.after_this_gap_note ? `<p class="dim">${escapeHtml(row.after_this_gap_note)}</p>` : ''}
      <p class="dim">${escapeHtml(row.build_note ?? '')}支持等级：${escapeHtml(row.support_label ?? '未核实')}</p>
     </div>`;
  }).join('')}</div>
     <p class="tw-note" style="margin-top:8px">这 ${list.length} 个候选来自「召回 → 补全六只 → 排序」，
      不是让模型凭空列举；三个标签代表三种取舍，不是强度排名。</p>`;
  }

  function renderFullTeam(player) {
    const full = player?.full_team ?? null;
    if (!full) return '';
    const axes = Array.isArray(full.axes) ? full.axes : [];
    const ordered = [...axes].sort((a, b) => AXIS_LABELS.indexOf(a.label) - AXIS_LABELS.indexOf(b.label));
    const replacement = full.replacement;
    return `<p class="tw-lead">${escapeHtml(full.headline ?? '')}</p>
     <ul class="tw-axes">${ordered.map((axis) => {
    const value = axisValueText(axis);
    return `<li class="tw-axis" data-tw-axis="${escapeAttr(axis.label)}" data-tw-available="${axis.available}">
      <div class="tw-axis-head"><b>${escapeHtml(axis.label)}</b>
       <span class="tw-axis-state ${axis.available ? 'on' : 'off'}">${axis.available ? '现在能算' : '现在算不出来'}</span></div>
      ${axis.available
    ? `<p>${escapeHtml(value ?? NO_ITEM)}</p>`
    : `<p class="dim">${escapeHtml(axis.unavailable_note ?? '这一轴现在无定义')}</p>`}
      ${axis.low_confidence_note ? `<p class="dim">${escapeHtml(axis.low_confidence_note)}</p>` : ''}
     </li>`;
  }).join('')}</ul>
     ${replacement ? `<div class="tw-replacement" id="tw-replacement">
       <h4>一个最小替换</h4>
       <p>把「${escapeHtml(replacement.out_name ?? NO_ITEM)}」换成「${escapeHtml(replacement.in_name ?? NO_ITEM)}」</p>
       <p class="dim">${escapeHtml([replacement.explanation, replacement.covers_note,
    replacement.build_note, replacement.confirmed_note].filter(Boolean).join(' '))}</p>
      </div>`
    : `<p class="tw-note" style="margin-top:9px">${escapeHtml(full.replacement_unavailable_note ?? '')}</p>`}
     ${renderUnknowns(player)}`;
  }

  function renderUnknowns(player) {
    const list = Array.isArray(player?.unknowns) ? player.unknowns : [];
    if (list.length === 0) return '';
    return `<div class="tw-head" style="margin:12px 0 4px"><h3 style="font-size:13.5px">这一页现在还不知道什么</h3>
      <span class="tw-sub">${list.length} 条</span></div>
     <ul class="tw-unknowns">${list.map((row) => `<li class="tw-unknown">
      <span>${escapeHtml(row.label ?? '')}</span>
      <span class="tw-state">${escapeHtml(row.state ?? '未核实')}</span>
      <span class="tw-text">${escapeHtml(row.note ?? '')}</span></li>`).join('')}</ul>
     <p class="tw-note" style="margin-top:8px">${escapeHtml(player?.honesty_note ?? '')}</p>`;
  }

  function renderEval(player, stage = 'full') {
    const selected = player?.selected_count ?? 0;
    // 从盒子带过来的，页面上要看得见（`data-tw-handoff`），验收脚本按它核对交接真的到位。
    if (initialSelected.length) rootEl.dataset.twHandoff = String(initialSelected.length);
    if (!player) { $('tw-eval-body').innerHTML = ''; $('tw-eval-sub').textContent = '—'; return; }
    // 初判阶段（`stage='first'`）：证据段服务端根本没跑，`player.full_team` 是 null。
    // 这里**如实说「正在补依据」**，而不是显示「五轴算不出来」——后者会把
    // 「还没到」说成「算不出」，是两种不同的诚实。
    if (selected >= TEAM_SLOTS && !player.full_team) {
      $('tw-eval-sub').textContent = stage === 'first' ? '满编六只 · 正在补依据' : '满编六只 · 依据没回来';
      $('tw-eval-body').innerHTML = `<p class="tw-lead">六只都在了。缺口与候选已经在上面给出了。</p>
       <p class="tw-note">${stage === 'first'
    ? '五个口径与最小替换正在算（这一段最贵），回来之后原地补在这里。'
    : '五个口径与最小替换这次没有回来：只缺这一块，上面那些结论照旧。'}</p>
       ${renderUnknowns(player)}`;
      return;
    }
    if (selected >= TEAM_SLOTS && player.full_team) {
      $('tw-eval-sub').textContent = `满编六只 · 六个口径`;
      $('tw-eval-body').innerHTML = renderFullTeam(player);
      return;
    }
    if (selected >= 2) {
      $('tw-eval-sub').textContent = `已选 ${selected} / ${TEAM_SLOTS} · 缺口与下一只`;
      $('tw-eval-body').innerHTML = `${renderGaps(player)}${renderNext(player)}
       <p class="tw-note" style="margin-top:8px">${escapeHtml(player.structure_note ?? '')}</p>`;
      return;
    }
    $('tw-eval-sub').textContent = `已选 ${selected} / ${TEAM_SLOTS} · 还没到能评估的程度`;
    $('tw-eval-body').innerHTML = `${renderEntrance(player)}
     <p class="tw-note" style="margin-top:8px">选满六只之后这里给完整评估：主要优势、最大短板、替换建议、置信度。</p>`;
  }

  // ── Coach 短提示：**同一份评估**的短结论（不重复评估区的缺口清单）─────────
  //
  // 三层级在这里写清楚，避免三块重复信息：
  //   · **阵容评估**（左/上）= 结构诊断：缺什么、候选依据、五轴与未知；
  //   · **小芽 Coach 栏**（这里）= 短结论：下一步做什么、为什么、代价是什么；
  //   · **军师**（局中两行浮条）= 不在本模块，属对战阶段。
  // 想复用这句短结论的那一路，通过 `coachSummary()`（引擎无关的纯数据）取，不要 import 本文件内部函数。

  /** 玩家可读的 Coach 短结论：**纯数据**，供主线程/其它模块复用（不含 DOM、不含 id）。 */
  function buildCoachSummary(player) {
    const selected = player?.selected_count ?? 0;
    const next = Array.isArray(player?.next_candidates) ? player.next_candidates : [];
    const base = {
      phase: selected >= TEAM_SLOTS ? 'full-team' : (selected >= 2 ? 'next-pick' : 'entrance'),
      slot_label: `${selected} / ${TEAM_SLOTS}`,
      selected_count: selected,
      team_size: TEAM_SLOTS,
      gaps: Array.isArray(player?.gap_dimension_notes) ? player.gap_dimension_notes.slice() : [],
      unknowns: Array.isArray(player?.unknown_dimension_notes) ? player.unknown_dimension_notes.slice() : [],
      has_win_rate: false,
    };
    if (selected >= TEAM_SLOTS && player?.full_team) {
      const axes = Array.isArray(player.full_team.axes) ? player.full_team.axes : [];
      return {...base,
        headline: `六只都在了。现在能算的是：${axes.filter((axis) => axis.available).map((axis) => axis.label).join(' / ') || '（还没有能算的口径）'}。`,
        replacement: player.full_team.replacement
          ? {out_name: player.full_team.replacement.out_name, in_name: player.full_team.replacement.in_name,
            confirmed_by_distribution: player.full_team.replacement.confirmed_by_distribution === true}
          : null,
        next_candidates: [],
        note: '其余口径缺的是「版本对手分布」，所以不给胜率、不给精确强度。'};
    }
    if (selected >= 2 && next.length) {
      const [first] = next;
      return {...base,
        headline: `下一步我倾向 ${first.name ?? NO_ITEM}（${first.tradeoff_label ?? '取舍'}）。`,
        reason: first.tradeoff_intent ?? null,
        tradeoff: first.tradeoff_note ?? null,
        gap_note: first.after_this_gap_note ?? null,
        next_candidates: next.map((row) => ({name: row.name, tradeoff_label: row.tradeoff_label,
          tradeoff_intent: row.tradeoff_intent, tradeoff_note: row.tradeoff_note})),
        note: '另外两个取舍、以及每个候选的依据与未知，在阵容评估里。'};
    }
    return {...base,
      headline: '先挑 1～2 只你信得过的：我一拿到队伍就会给出缺口和下一只候选。',
      next_candidates: [],
      note: '选满六只再给完整评估；现在信息太少，我不会假装有唯一答案。'};
  }

  function renderCoach(player, stage = 'full') {
    const body = $('tw-coach-body');
    if (!player) { body.innerHTML = '<p class="tw-note">正在读取…</p>'; return; }
    const selected = player.selected_count ?? 0;
    const next = Array.isArray(player.next_candidates) ? player.next_candidates : [];
    // 满编但证据段还没回来（初判阶段）：短结论照旧给，只说依据在补。
    if (selected >= TEAM_SLOTS && !player.full_team) {
      body.innerHTML = `<p>六只都在了。短结论已经成立：缺口与下一只候选在上面的评估区。</p>
       <p>${stage === 'first'
    ? '五个口径与最小替换还在算，回来之后补在左边；不用你再点一次。'
    : '这一次五个口径与最小替换没有回来；上面那些结论不受影响。'}</p>`;
      return;
    }
    if (selected >= TEAM_SLOTS && player.full_team) {
      const axes = Array.isArray(player.full_team.axes) ? player.full_team.axes : [];
      const can = axes.filter((axis) => axis.available).map((axis) => axis.label);
      body.innerHTML = `<p>六只都在了。${can.length
        ? `现在能算的是：<span class="tw-who">${escapeHtml(can.join(' / '))}</span>；`
        : ''}其余口径缺的是「版本对手分布」，所以不给胜率、不给精确强度。</p>
       ${player.full_team.replacement
    ? `<p>想动一个槽位的话：把「${escapeHtml(player.full_team.replacement.out_name ?? NO_ITEM)}」换成「${escapeHtml(player.full_team.replacement.in_name ?? NO_ITEM)}」——理由在左边评估里。</p>`
    : ''}`;
      return;
    }
    if (selected >= 2 && next.length) {
      const [first] = next;
      body.innerHTML = `<p>下一步我倾向 <span class="tw-who">${escapeHtml(first.name ?? NO_ITEM)}</span>
        （${escapeHtml(first.tradeoff_label ?? '取舍')}）。</p>
       <p>${escapeHtml(first.tradeoff_intent ?? '')}</p>
       ${first.after_this_gap_note ? `<p>${escapeHtml(first.after_this_gap_note)}</p>` : ''}
       <p>另外两个取舍、以及每个候选的依据与未知，在左边的评估里。</p>`;
      return;
    }
    body.innerHTML = `<p>先挑 1～2 只你信得过的：我一拿到队伍就会给出缺口和下一只候选；</p>
     <p>选满六只再给完整评估。现在信息太少，我不会假装有唯一答案。</p>`;
  }

  // ── 取数：**两阶段交付**（RC-306）───────────────────────────────────────
  //
  // 为什么分两次问同一份数据：完整载荷里最贵的是「证据与反事实」那一段（五轴 + 最小替换），
  // 而玩家点完一只精灵首先要知道的是「队伍状态 / 下一只候选 / 缺口 / 小芽的短结论」。
  // 所以：
  //   ① 先要 `stage=first`：服务端**不跑**证据段（`axes:null`、`axes_status:'not_requested'`、
  //      `serving.full_withheld:'NOT_REQUESTED'`——「调用方主动不要」与「超时降级」是两件事）；
  //   ② 紧接着无条件再要一次完整载荷，拿到后**原地升级**（补五轴 / 最小替换 / 完整依据），
  //      不整块重排：初判画出来的东西在升级时位置不变。
  //
  // 失败方向：第一次失败 ⇒ 进错误态（与以前一样）；**第二次失败只影响「依据」那一块**，
  // 已经渲染好的初判一个字都不清空（`data-tw-full-state` 记下 'failed' 供验收看）。
  function workshopQuery(extra = {}) {
    const query = new URLSearchParams();
    if (state.selected.length) query.set('selected', state.selected.join(','));
    if (state.locked.length) query.set('locked', state.locked.join(','));
    if (state.favourite) query.set('favourites_only', 'true');
    if (Number.isInteger(state.maxReplacements)) query.set('max_replacements', String(state.maxReplacements));
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return query.toString();
  }

  function emit() {
    const detail = {
      team: state.selected.slice(),
      locks: state.locked.slice(),
      favourite: state.favourite,
      maxReplacements: state.maxReplacements,
      // 短结论的**纯数据**形态：主线程/聊天抽屉要用就直接读它，不要 import 本文件内部函数。
      coachSummary: buildCoachSummary(state.payload?.player ?? null),
      payload: state.payload,
    };
    // 主线程用这个事件把**同一份**阵容评估喂给小芽（不重算、不另写模板）。
    rootEl.dispatchEvent(new CustomEvent('team-workshop:change', {detail, bubbles: true}));
    if (onTeamChange) onTeamChange(detail);
  }

  /**
   * 把一份回执画到页面上。
   *
   * `stage` 只有两个取值：
   *   · `'first'` = 初判（`axes:null`）：评估区画「正在补依据」，五轴 / 最小替换先不出现；
   *   · `'full'`  = 完整载荷：原地把依据那块补上（**不整块重排**：初判画出的槽位、候选、
   *     缺口、Coach 短结论位置不变）。
   * 两个阶段共用同一份渲染函数——所以「升级」不会换掉任何一条已经给玩家的结论。
   */
  function applyPayload(payload, stage = 'full') {
    state.payload = payload;
    state.error = null;
    const player = payload.player ?? {};
    rootEl.dataset.twStage = stage;
    renderTeam(player);
    renderEval(player, stage);
    renderCoach(player, stage);
    renderPool();
    // 完整回执挂在一个**属性**上：本机测试读它，页面上永远不渲染它。
    rootEl.dataset.twPayload = JSON.stringify(payload);
    rootEl.dataset.twSelected = String(player.selected_count ?? 0);
    rootEl.dataset.twRemaining = String(player.remaining_slots ?? '');
    rootEl.dataset.twSlots = String(Array.isArray(player.slots) ? player.slots.length : 0);
    rootEl.dataset.twFilled = String((player.slots ?? []).filter((slot) => slot.state === 'filled').length);
    rootEl.dataset.twNext = String((player.next_candidates ?? []).length);
    rootEl.dataset.twNextLabels = (player.next_candidates ?? []).map((row) => row.tradeoff_label ?? '').join('|');
    rootEl.dataset.twAxes = (player.full_team?.axes ?? []).map((axis) => axis.label).join('|');
    rootEl.dataset.twAxesAvailable = (player.full_team?.axes ?? []).filter((axis) => axis.available)
      .map((axis) => axis.label).join('|');
    // ── 分段交付的**可量测事实**（契约 `roco-serving/v1`）──────────────────
    // 工程字段（stages / elapsed / withheld）全在 dataset 属性上，可见文本里一个都不出现。
    const serving = payload.serving ?? null;
    if (serving) {
      rootEl.dataset.twServing = String(serving.contract ?? 'roco-serving/v1');
      rootEl.dataset.twDegraded = serving.degraded === true ? 'yes' : 'no';
      // 「调用方主动不要证据段」与「超时降级跳过」是两件事：这里分开记。
      rootEl.dataset.twWithheld = serving.full_withheld ?? '';
      rootEl.dataset.twElapsedMs = String(Math.round(serving.elapsed_ms ?? 0));
    }
    rootEl.dataset.twState = 'ok';
    rootEl.dataset.twSeq = String(state.seq);
    emit();
  }

  /**
   * 记一次「这个阶段画完了」。
   *
   * 除了 `stage` 与耗时，还留两样**可核对的事实**（验收要区分「两阶段」与「一次请求」）：
   *   · `twFetches`：这一轮按顺序发出去的请求里的 `stage` 值（`first|full`）——
   *     少一个 `first` 就说明初判那一次根本没发，判据当场红；
   *   · `twRenderedAfterFirst`：**初判之后、完整载荷之前**这一段里页面是不是真的
   *     已经把槽位（六个格子，空队伍也算）与候选画出来了——不是等两次都回来才画。
   */
  function markStage(stage, elapsedMs) {
    rootEl.dataset.twStage = stage;
    const rounded = Math.round(Math.max(0, elapsedMs));
    if (stage === 'first') {
      rootEl.dataset.twFirstMs = String(rounded);
      rootEl.dataset.twRenderedAfterFirst = Number(rootEl.dataset.twSlots || '0') > 0 ? 'yes' : 'no';
    } else {
      rootEl.dataset.twFullMs = String(rounded);
    }
  }

  async function reload() {
    const seq = (state.seq += 1);
    // 这一轮的取数顺序：两阶段就是 `first|full`（验收直接读这个属性）。
    const fetches = [];
    // ① 初判：服务端**不跑**证据段（`axes:null` / `axes_status:'not_requested'`）。
    const firstStarted = performance.now();
    let firstData = null;
    try {
      fetches.push('first');
      rootEl.dataset.twFetches = fetches.join('|');
      firstData = await getJson(`${apiBase}/workshop?${workshopQuery({stage: 'first'})}`);
    } catch (error) {
      firstData = {ok: false, error: error.message};
    }
    if (seq !== state.seq) return;
    if (!firstData || firstData.ok !== true) {
      // 第一次就失败：与以前一样进错误态（不做第二次请求，那时也没有可升级的东西）。
      state.error = firstData?.error ?? '服务端拒绝了这次请求';
      rootEl.dataset.twState = firstData === null ? 'failed' : 'bad-request';
      rootEl.dataset.twError = String(state.error);
      rootEl.dataset.twSeq = String(state.seq);
      if (state.payload) renderTeam(state.payload.player ?? {}); else renderTeam({});
      emit();
      return;
    }
    applyPayload(firstData, 'first');
    markStage('first', performance.now() - firstStarted);

    // ② 完整载荷：无条件再取一次；拿到就地升级，失败只影响「依据」那一块。
    const fullStarted = performance.now();
    rootEl.dataset.twFullState = 'loading';
    let fullData = null;
    try {
      fetches.push('full');
      rootEl.dataset.twFetches = fetches.join('|');
      fullData = await getJson(`${apiBase}/workshop?${workshopQuery()}`);
    } catch (error) {
      fullData = {ok: false, error: error.message};
    }
    if (seq !== state.seq) return;
    if (!fullData || fullData.ok !== true) {
      // **不清空初判**：只把「依据那一段没来」如实记下来。
      rootEl.dataset.twFullState = 'failed';
      state.fullError = fullData?.error ?? '完整载荷没有回来';
      renderEval(state.payload.player ?? {}, 'first');
      emit();
      return;
    }
    applyPayload(fullData, 'full');
    markStage('full', performance.now() - fullStarted);
    rootEl.dataset.twFullState = 'ok';
  }

  /** 加一只：优先用「你已经拥有的那一只」；没有就按图鉴条目加，路由会照实拒绝。 */
  async function addCandidate({instance, species}) {
    if (state.selected.length >= TEAM_SLOTS) {
      state.error = `最多 ${TEAM_SLOTS} 个槽位：先拿掉一只再加。`;
      renderTeam(state.payload?.player ?? {});
      return;
    }
    let select = instance;
    if (!select && species) select = state.ownedBySpecies.get(species)?.select ?? null;
    const value = select ?? species;
    if (!value || state.selected.includes(value)) return;
    // 上一次被拒的图鉴条目还留在队伍里：先摘掉，否则永远加不进新的一只。
    if (rootEl.dataset.twState === 'bad-request' && /^pet_\d{6}$/.test(state.selected.at(-1) ?? '')) {
      state.selected = state.selected.filter((item) => !/^pet_\d{6}$/.test(item));
      await reload();
    }
    state.selected = [...state.selected, value];
    await reload();
  }

  // ── 接线 ──────────────────────────────────────────────────────────────
  $('tw-cand-list').addEventListener('click', (event) => {
    const row = event.target.closest?.('.tw-row');
    if (!row) return;
    void addCandidate({instance: row.dataset.twOwned || null, species: row.dataset.twSpecies});
  });
  $('tw-search').addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.pool.q = $('tw-search').value.trim();
      void loadPool({reset: true});
    }, 150);
  });
  $('tw-cand-prev').addEventListener('click', () => {
    state.pool.offset = Math.max(0, state.pool.offset - state.pool.pageSize);
    void loadPool();
  });
  $('tw-cand-next').addEventListener('click', () => {
    state.pool.offset += state.pool.pageSize;
    void loadPool();
  });
  $('tw-favourite').addEventListener('click', () => {
    state.favourite = !state.favourite;
    $('tw-favourite').setAttribute('aria-pressed', state.favourite ? 'true' : 'false');
    void reload();
  });
  $('tw-replace-body').innerHTML = [['', '不限'], ['0', '0 只'], ['1', '1 只'], ['2', '2 只'], ['3', '3 只']]
    .map(([value, label]) => `<button class="tw-btn" data-tw-replace="${value}"
      aria-pressed="${value === '' ? 'true' : 'false'}">${label}</button>`).join('');
  $('tw-replace-body').addEventListener('click', (event) => {
    const chip = event.target.closest?.('[data-tw-replace]');
    if (!chip) return;
    const raw = chip.dataset.twReplace;
    state.maxReplacements = raw === '' ? null : Number(raw);
    $('tw-replace-label').textContent = raw === '' ? '不限' : `${raw} 只`;
    for (const other of shadow.querySelectorAll('[data-tw-replace]')) {
      other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
    }
    $('tw-replace-menu').open = false;
    void reload();
  });
  $('tw-reset').addEventListener('click', () => {
    state.selected = [];
    state.locked = [];
    state.favourite = false;
    state.maxReplacements = null;
    $('tw-favourite').setAttribute('aria-pressed', 'false');
    $('tw-replace-label').textContent = '不限';
    for (const chip of shadow.querySelectorAll('[data-tw-replace]')) {
      chip.setAttribute('aria-pressed', chip.dataset.twReplace === '' ? 'true' : 'false');
    }
    void reload();
  });

  const api = {
    root: rootEl,
    shadow,
    getTeam: () => state.selected.slice(),
    getPayload: () => state.payload,
    /** 选阵容阶段的 Coach 短结论（纯数据，同一份评估算出来的）。 */
    coachSummary: () => buildCoachSummary(state.payload?.player ?? null),
    addCandidate,
    reload,
    destroy: () => {
      if (state.searchTimer) clearTimeout(state.searchTimer);
      shadow.innerHTML = '';
      delete rootEl.dataset.twState;
    },
  };

  rootEl.dataset.twState = 'loading';
  void (async () => {
    await loadOwnedIndex();
    await loadPool({reset: true});
    await reload();
    // 「两阶段都回来了」是一个**独立**的事实：验收脚本用它区分「初判已经画好了」
    // 与「完整载荷也到了」，所以不让 `twState` 兼职。
    rootEl.dataset.twReady = 'yes';
  })();
  return api;
}

export default mountTeamWorkshop;
