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

//: 筛选词表是**闭集**（与登记层同一套）：属性取数据里真的出现过的 18 个系别，定位取 5 个。
//: 循环选项而不是让玩家打字 —— 打字会搜出一堆零结果，还会把拼错的词当成「没有这只」。
const TYPE_CYCLE = ['', '普通系', '火系', '水系', '武系', '翼系', '冰系', '龙系', '幽系', '萌系',
  '虫系', '幻系', '草系', '地系', '毒系', '光系', '恶系', '机械系', '电系'];
const ROLE_CYCLE = ['', 'attacker', 'tank', 'recovery', 'control', 'support'];
const ROLE_CN = {attacker: '输出', tank: '坦克', recovery: '回复', control: '控制', support: '辅助'};

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
/* 人类 2026-09-23：删掉工坊里的「✦ 小芽（阵容阶段）」后重排 ——
   第一排：**队伍 | 阵容评估**；第二排：**候选池通栏**（「筛选精灵直接拉到最后面」，往下探满）。 */
.tw-drawer{position:fixed;left:0;top:64px;bottom:78px;z-index:60;display:flex;align-items:flex-start;pointer-events:none}
.tw-drawer>*{pointer-events:auto}
.tw-drawer-btn{writing-mode:vertical-rl;text-orientation:upright;letter-spacing:2px;
 align-self:center;padding:16px 10px;border:1px solid #2b3d4e;border-right:0;border-radius:0 14px 14px 0;
 background:#101a24;color:#eaf2f8;font-size:13px;font-weight:600;cursor:pointer;min-height:132px;
 box-shadow:0 6px 18px rgba(0,0,0,.35)}   /* 对齐小芽按钮的观感 */
.tw-drawer[data-open="yes"] .tw-drawer-btn{display:none}   /* 人类：展开后按钮要**消失**，别压着面板 */
.tw-drawer-close{display:block;width:100%;margin:0 0 8px;padding:6px 10px;border:1px solid var(--line);
 border-radius:10px;background:#16222f;color:#dbe7f1;font-size:12px;cursor:pointer;text-align:left}
.tw-drawer-panel{display:none;width:min(380px,86vw);overflow:auto;background:#101a24;
 border:1px solid var(--line);border-radius:0 14px 14px 0;padding:12px 14px;margin-left:0}
.tw-drawer[data-open="yes"] .tw-drawer-panel{display:block}
/* 一屏装完：网格高度 = 可用高度，候选列表**内部滚动**，页面本身不上下滑。 */
.tw-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:stretch;
 height:100%;min-height:0;grid-template-rows:minmax(0,1fr)}
.tw-cand,.tw-team{display:flex;flex-direction:column;min-height:0;height:100%}
.tw-cand-list{flex:1 1 auto;min-height:0;overflow:auto}   /* 一屏下也要有可用高度（实测曾被挤到 60px） */
.tw-team{grid-column:1;grid-row:1}
.tw-eval{grid-column:2;grid-row:1}

/* 两列**等高**（用户：小芽那栏不能拉长吗、非得这么丑？）：网格项拉伸，
   面板内部再让最后一栏吃满剩余高度。 */
.tw-grid{align-items:stretch}
.tw-panel{display:flex;flex-direction:column}
.tw-panel.tw-coach,.tw-panel.tw-eval{height:100%}
.tw-panel{background:#1a2635;border:1px solid #314154;border-radius:12px;padding:6px 12px 10px;min-width:0}
.tw-team{grid-column:span 2}
.tw-coach{grid-column:span 2}
.tw-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0 8px}
.tw-head h3{margin:0;font-size:15px}
.tw-head .tw-sub{color:#9caebe;font-size:12px;margin-left:auto}
.tw-badges{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 9px}
.tw-badge{font-size:11.5px;border:1px solid #4a6858;color:#a8e5b0;border-radius:6px;padding:3px 8px}
.tw-badge.warn{border-color:#6b5a33;color:#f0cb77}
.tw-badge.muted{border-color:#3a4a5c;color:#9caebe}
/* 六个槽位**等高**：grid-auto-rows:1fr 让同一行的槽位一样高，空槽与已选槽也一样高。
   2026-09-22 人类 P0 实测：选中之后往卡里塞了整段机制原文，卡片当场长高，
   空槽/已选槽高度参差、网格跳动 —— 选前选后必须是同一张版式。 */
.tw-slots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;grid-auto-rows:1fr}
.tw-slot{min-height:92px;border:1px dashed #36495e;border-radius:10px;padding:8px 9px;
 display:flex;flex-direction:column;gap:4px;min-width:0;overflow:hidden}
.tw-slot.on{border-style:solid;border-color:#8dd49c;background:#17242f}
.tw-slot .tw-who{font-weight:600;font-size:14px;overflow-wrap:anywhere}
.tw-slot .tw-meta{color:#9caebe;font-size:11.5px;line-height:1.5;overflow-wrap:anywhere}
.tw-slot .tw-row{display:flex;gap:6px;align-items:center;min-width:0}
.tw-slot .tw-lock{margin-left:auto;color:#9caebe;font-size:11px;white-space:nowrap}
.tw-types{display:flex;flex-wrap:wrap;gap:3px}
/* 机制一行：首层**只留一行**（超出用省略号），完整原文与四个技能进槽位里的详情抽屉。
   为什么改：把整段机制原文塞进卡片会让选中后的卡比空卡高出一截（同一个网格里参差不齐），
   而卡片首层的任务是「认得出这只 + 有一个区分点」，不是把资料读完。 */
.tw-mech{display:flex;flex-direction:column;gap:2px;margin-top:2px;min-width:0}
.tw-mech-line{font-size:11.5px;line-height:1.5;color:#bcd0e0;overflow-wrap:anywhere;
 display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
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
.tw-cand-tools{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;align-items:stretch}
.tw-cand-tools input{grid-column:1/-1;min-width:0;min-height:44px;font-size:13.5px;background:#121e2c;
 color:#dbe5ef;border:1px solid #314154;border-radius:8px;padding:7px 10px}
.tw-cand-tools .tw-btn{min-height:44px;width:100%}
/* 翻页那一行：用 flex 让两个按钮**平分整行**、页码居中（grid 三列在实测里没生效，
   这里换成 flex：flex:1 1 0 一定平分，不给浏览器留下别的解释）。 */
/* 候选列表的分组说明条（人类实测 Q2：约一半候选是我不拥有的物种） */
.tw-group-note{margin:6px 0 2px;font-size:11.5px;color:#9caebe}
.tw-cand-tools.tw-pager{display:flex;gap:6px;align-items:center}
.tw-cand-tools.tw-pager .tw-btn{flex:1 1 0;width:auto;min-width:0}
.tw-cand-tools.tw-pager .tw-note{flex:0 0 auto;white-space:nowrap}
/* 候选区**不再内滚**（2026-09-22 人类 P1）：这一页原来同时有「页码」与「区域内滚动」，
   两套导航叠在一起，玩家既翻页又滚内层。现在只留**一套**：分页器翻页，列表整块摊开，
   这一页有多少条就全露出来；要看评估就整页向下滚（那是跨区浏览，不是区內导航）。 */
.tw-cand-list{display:grid;gap:6px}
.tw-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;text-align:left;min-height:44px;
 background:#16222f;border:1px solid #314154;border-radius:9px;padding:7px 10px;color:#dfe8ef;
 font:inherit;cursor:pointer}
.tw-row:hover{background:#1e3043;border-color:#7e9bb8}
.tw-row .tw-name{font-size:13.5px;font-weight:600;overflow-wrap:anywhere}
.tw-row .tw-rowtag{margin-left:auto;font-size:11px;color:#9caebe;white-space:nowrap}
/* 状态标：**点击之前**就要看得出这一只能不能上场（人类 P0：别等选到第六槽才弹内部错误）。 */
.tw-row .tw-state-tag{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid #3a4a5c;
 white-space:nowrap}
.tw-state-held{color:#8dd49c;border-color:#3f6b4c;background:#16281d}
.tw-state-trial{color:#f0cb77;border-color:#6b5b3a;background:#2a2318}
.tw-state-info{color:#9caebe;border-color:#3a4a5c;background:#18232f}
.tw-about{margin:6px 0 0;border:1px solid #2b3a4a;border-radius:9px;background:#131e2a}
.tw-about>summary{font-size:11.5px;color:#9caebe;cursor:pointer;min-height:44px;
 display:flex;align-items:center;gap:6px;padding:0 10px;list-style:none}
.tw-about>summary::-webkit-details-marker{display:none}
.tw-about>summary::after{content:'▾';margin-left:auto;color:#6b7f92}
.tw-about[open]>summary::after{content:'▴'}
.tw-about>*:not(summary){margin:0 10px 8px}
.tw-slot .tw-detail{margin-top:auto;width:100%}
.tw-slot .tw-detail>summary{width:100%;display:block;box-sizing:border-box}
/* 槽位里的「移除」是拇指要点的（390 实测 43×25 < 44）：给它 44×44。 */
.tw-slot-remove{margin-left:auto;min-width:44px;min-height:44px;font-size:11px;color:#9caebe;
 background:#121e2c;border:1px solid #314154;border-radius:8px;padding:0 8px;cursor:pointer}
.tw-slot .tw-detail>summary{font-size:11.5px;color:#9caebe;cursor:pointer;min-height:44px;
 display:flex;align-items:center;list-style:none}
.tw-slot .tw-detail>summary::-webkit-details-marker{display:none}
.tw-slot .tw-detail[open]>summary{color:#dfe8ef}
.tw-slot .tw-detail-body{font-size:11.5px;line-height:1.6;color:#bcd0e0;overflow-wrap:anywhere;margin-top:4px}
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

/* ── 人类 2026-09-23 批注（这些必须写在 shadow 内，写到 roco.css 是**不生效**的）── */
.tw-knobs--right{justify-content:flex-end}
.tw-scope-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}   /* 全图鉴 / 我的精灵 一左一右 */
.tw-filter-row{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:11px}
.tw-select{flex:0 0 auto;width:76px;max-width:76px;font-size:11px;min-height:30px;padding:2px 4px;
 border:1px solid var(--line);border-radius:8px;background:#16222f;color:#dbe7f1}
.tw-filter-row input[type=search]{flex:1 1 90px;min-width:60px;font-size:11px;min-height:30px;padding:2px 6px}
.tw-filter-row #tw-filter-reset{flex:0 0 auto;width:auto;font-size:11px;min-height:30px;padding:2px 10px}
.tw-filter-row select,.tw-filter-row input,.tw-filter-row button{font-size:11.5px;padding-left:6px;padding-right:6px}
/* 人类口径「做小」只在桌面；窄屏必须 ≥44px（判据 30-触控目标 量 390×844） */
@media (max-width:760px){
  .tw-select,.tw-filter-row input[type=search],.tw-filter-row #tw-filter-reset,
  .tw-scope-row button,.tw-cand-prev,.tw-cand-next,#tw-cand-prev,#tw-cand-next{min-height:44px !important;font-size:12.5px}
  .tw-select{width:96px;max-width:96px}
  /* 子代理实测：左侧「阵容评估」抽屉按钮在 390×844 是 34×120（宽 <44）→ 补窄屏最小宽度 */
  .tw-drawer-btn{min-width:44px;width:44px;padding:14px 6px}
}


.tw-filter-row #tw-filter-reset{flex:0 0 auto}
.tw-filter-row input[type=search]{width:100%}
.tw-filter-row select.tw-btn{min-height:36px}
#tw-cand-result{font-size:11.5px}         /* 「N 条 · 本页 M」字号小一点 */
.tw-panel.tw-team .tw-slots .tw-slot[data-tw-state="empty"]{border-style:dashed}
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
   <!-- 人类 2026-09-23：**阵容评估挪到左边做成隐藏式悬浮抽屉**（竖排按钮，点一下展开、可收回），
     与右边小芽对应；正文里不再占位。 -->
   <aside class="tw-drawer" id="tw-eval-drawer" data-open="no">
    <button class="tw-drawer-btn" id="tw-eval-toggle" type="button" aria-expanded="false">阵容评估</button>
    <div class="tw-drawer-panel" id="tw-eval-panel"><button class="tw-drawer-close" id="tw-eval-close" type="button">收起 ›</button>
     <div class="tw-head"><h3 id="tw-eval-title">阵容评估</h3>
      <span class="tw-sub" id="tw-eval-sub">—</span></div>
     <div id="tw-eval-body"></div>
    </div>
   </aside>
   <div class="tw-grid">
    <section class="tw-panel tw-team" aria-labelledby="tw-team-title">
     <div class="tw-head"><h3 id="tw-team-title">队伍</h3>
      <span class="tw-sub" id="tw-team-sub">还差 6 只</span></div>
     
     <div class="tw-slots" id="tw-slots" role="list"></div>
     <!-- 2026-09-22（人类 P0）：队伍面板里**不再**放第二排槽位。
          理论阵容只在候选人页签里出现（它是「分析用」的清单，不该和出战六槽并排抢首屏）。 -->
     <details class="tw-about" id="tw-analysis-box" hidden>
      <summary id="tw-analysis-head">理论阵容（放图鉴物种进来做搭配分析）</summary>
      <div class="tw-slots" id="tw-analysis-slots" role="list" data-tw-analysis></div>
     </details>
     
     <p class="tw-error" id="tw-team-error" hidden></p>
     <div class="tw-knobs tw-knobs--right">
      <button class="tw-btn" id="tw-reset">清空阵容</button>
     </div>
    </section>

    <section class="tw-panel tw-cand" aria-labelledby="tw-cand-title">
     <div class="tw-head"><h3 id="tw-cand-title">候选池</h3>
      <span class="tw-sub" id="tw-cand-sub">—</span></div>
     <p class="tw-note" id="tw-cand-note"></p>
     <div class="tw-cand-tools tw-scope-row">
      <button class="tw-btn" id="tw-scope-all" aria-pressed="true">全图鉴</button>
      <button class="tw-btn" id="tw-scope-mine" aria-pressed="false">我的精灵</button>
     </div>
     <div class="tw-cand-tools tw-filter-row">
      <select class="tw-select" id="tw-filter-type" aria-label="按属性筛选"></select>
      <select class="tw-select" id="tw-filter-role" aria-label="按定位筛选"></select>
      <input type="search" id="tw-search" placeholder="搜索精灵" aria-label="搜索候选" autocomplete="off">
      <button class="tw-btn" id="tw-filter-reset">重置</button>
     </div>
     <p class="tw-note" id="tw-cand-result" role="status" aria-live="polite"></p>
     <div class="tw-cand-tools tw-pager">
      <button class="tw-btn" id="tw-cand-prev">上一页</button>
      <span class="tw-note" id="tw-cand-page">1 / 1</span>
      <button class="tw-btn" id="tw-cand-next">下一页</button>
     </div>
     <div class="tw-cand-list" id="tw-cand-list" role="group" aria-label="从全图鉴挑一只"></div>
    </section>

    

    <!-- 人类 2026-09-23：「右下角的小芽模块整体删除，不只是内联小芽」——这里原来还有一份「✦ 小芽 · 阵容阶段」栏 -->
   </div>`;

  const $ = (id) => shadow.getElementById(id);

  /** 人类 2026-09-23：按候选列表的**实测可用高度**算每页数量（一行约 46px），夹在 6–24 之间。
   *  「全图鉴」与「我的精灵」共用同一个 pageSize，切档与搜索都不改变它。 */
  const fitPageSize = () => {
    const list = $('tw-cand-list');
    const h = list ? list.getBoundingClientRect().height : 0;
    if (!(h > 120)) return;
    const fit = Math.max(6, Math.min(24, Math.floor(h / 46)));
    if (fit !== state.pool.pageSize) { state.pool.pageSize = fit; }
  };
  // RC-801：从盒子带过来的初始选人（`?team=own-…`）。**只认形状对的 id**：
  // 认不出的直接丢掉（不猜、不静默塞一个别的）——多带一只或少带一只都要看得见。
  const initialSelected = Array.isArray(opts.initialSelected)
    ? opts.initialSelected.filter((id) => typeof id === 'string' && /^own-\d+$/.test(id)).slice(0, TEAM_SLOTS)
    : [];
  // 从 URL 带过来的**锁定**（`?lock=own-…`）：只认形状对的 id，且**必须在选人里**
  // （服务端会按 RC-301 规则⑨再校验一次：锁一个没入选的实例整条请求会被拒）。
  const initialLocked = Array.isArray(opts.initialLocked)
    ? opts.initialLocked.filter((id) => typeof id === 'string' && /^own-\d+$/.test(id))
      .filter((id) => initialSelected.includes(id))
    : [];
  const state = {
    selected: initialSelected.slice(),
    locked: initialLocked.slice(),
    // 理论阵容（2026-09-22 人类 P0）：**物种级**，用来做搭配分析；不要求拥有、不出战。
    // 与 `selected`（持有实例）分开，是因为这两件事的失败方向完全不同：
    // 持有清单满了才能开局，理论阵容满了才能比较与试玩。
    analysis: [],
    favourite: false,
    maxReplacements: null,
    payload: null,
    error: null,
    seq: 0,
    // 候选区**只有一套导航**：分页器（页码），列表整块摊开不内滚（人类 P1）。
    // 筛选走服务端（`/api/roco/box` 的 kind/q/type/role 白名单），换条件一律回第一页。
    // 人类 2026-09-23：每页数量**按可用页高**算（一屏装完、不上下滑）——初值 12，挂载后按实测高度重算。
    pool: {offset: 0, total: 0, pageSize: 12, q: '', kind: 'catalog', type: '', role: '', rows: []},
    poolSeq: 0,
    ownedBySpecies: new Map(),      // 物种 → [{select: 个体, name, ...}]
    ownedByInstance: new Map(),     // 个体 → {speciesId, name}
  };

  const getJson = async (path) => {
    const response = await fetch(path, {cache: 'no-store', signal: AbortSignal.timeout(30000)});
    let data = null;
    try { data = await response.json(); } catch { /* 统一按读取失败处理 */ }
    if (!data) throw new Error('阵容工坊读取失败：本机服务没有给出可用数据');
    return data;
  };

  /** 详情抽屉里的机制原文：**逐字**照印（首层只留一行，全文在这里）。 */
  function mechanismDetailHtml(mechanism) {
    const line = typeof mechanism?.line === 'string' && mechanism.line ? mechanism.line : null;
    if (!line) return '<div>机制：机制资料待确认（登记层没有这一只的冻结原文）</div>';
    return `<div>机制原文：${escapeHtml(line)}</div>`;
  }

  /** 详情抽屉里的四个技能（名字 + 系别/类别/能耗/威力；引擎没给威力就不写）。 */
  function skillsHtml(slot) {
    const skills = Array.isArray(slot.skills) ? slot.skills : [];
    if (!skills.length) return '';
    const rows = skills.map((s) => {
      const bits = [s.element, s.category, Number.isFinite(s.energy) ? `能耗 ${s.energy}` : null,
        Number.isFinite(s.power) ? `威力 ${s.power}` : null].filter(Boolean).join(' · ');
      return `<div>· ${escapeHtml(s.name ?? '（未登记）')}${bits ? `<span class="tw-meta"> ${escapeHtml(bits)}</span>` : ''}`
        + `${s.desc ? `<div class="tw-meta">${escapeHtml(s.desc)}</div>` : ''}</div>`;
    }).join('');
    return `<div>四个技能（${skills.length}）：</div>${rows}`;
  }

  /**
   * 服务端拒绝原因 → **玩家读法**。
   *
   * 服务端那一句是给排查用的（「selected 的每一项都必须是 own-0001 形状的个体的 id」），
   * 玩家要的是「哪一只不行 + 现在能做什么」。映射是**闭集**：认不出的原因一律给
   * 一句通用话 + 把原文留在 data-tw-error-raw（不许把内部 id 形状印到玩家层）。
   */
  function playerReasonOf(raw) {
    const text = String(raw ?? '');
    if (/own-\d{4}|selected 的每一项/.test(text)) {
      return '正式队伍只能放你拥有的个体（这一只不在你的盒子里）。'
        + '想让它出场，请在「候选池」里切到「我的精灵」，或者只把它放进理论搭配里比较。';
    }
    if (/最多\s*6|超过.*槽位|TEAM_SIZE/.test(text)) return '队伍最多六只：先拿掉一只再加。';
    if (/同一只.*重复|duplicate/i.test(text)) return '同一只精灵不能重复上场。';
    if (/不在.*owned|未知实例|UNKNOWN_INSTANCE/.test(text)) return '这一只不在你的盒子里，换个你拥有的个体。';
    return '这一只现在不能进队伍（具体原因在开发者抽屉里）。换一只，或者点「清空阵容」重来。';
  }

  // ── 队伍六个槽位 ───────────────────────────────────────────────────────
  function renderTeam(player) {
    const slots = Array.isArray(player?.slots) ? player.slots : [];
    $('tw-slots').innerHTML = slots.map((slot) => {
      if (slot.state === 'filled') {
        // 首层：名字 / 系别 / 构建档 / **一行**机制（超出省略，全文在「详情」里）。
        // 六张卡等高（CSS 的 grid-auto-rows:1fr），选前选后不跳。
        const held = state.ownedBySpecies.has(slot.species_id ?? '');
        const tag = held
          ? '<span class="tw-state-tag tw-state-held">持有 · 可正式上场</span>'
          : '<span class="tw-state-tag tw-state-trial">图鉴 · 按需推算（未核验）</span>';
        return `<article class="tw-slot on" role="listitem" data-tw-slot="${slot.index}"
          data-tw-state="filled" data-tw-fieldable="${held ? 'yes' : 'no'}">
         <div class="tw-row"><span class="tw-who">${escapeHtml(slot.name ?? NO_ITEM)}</span>
          ${slot.locked ? '<span class="tw-lock">锁定</span>' : ''}
          <button class="tw-slot-remove" data-tw-remove-slot="${slot.index - 1}"
            aria-label="把这一只从队伍里移除">移除</button></div>
         <div class="tw-meta"><span class="tw-types">${teamSlugs(slot.types) || '系别未登记'}</span>
          ${tag}</div>
         <div class="tw-meta">${escapeHtml(slot.build_tier_label ?? '')}</div>
         ${mechanismRow(slot.mechanism)}
         <details class="tw-detail"><summary>详情（技能 / 机制原文 / 来源）</summary>
          <div class="tw-detail-body">
           ${slot.source_note ? `<div>来源：${escapeHtml(slot.source_note)}</div>` : ''}
           ${mechanismDetailHtml(slot.mechanism)}
           ${skillsHtml(slot)}
          </div></details>
        </article>`;
      }
      return `<article class="tw-slot" role="listitem" data-tw-slot="${slot.index}" data-tw-state="empty">
        <div class="tw-meta">第 ${slot.index} 槽位（空）</div>
        <div class="tw-meta">${escapeHtml(slot.empty_hint ?? '')}</div>
       </article>`;
    }).join('');
    const filled = slots.filter((slot) => slot.state === 'filled').length;
    $('tw-team-sub').textContent = filled >= TEAM_SLOTS ? '六个槽位都满了' : `还差 ${TEAM_SLOTS - filled} 只`;
    if ($('tw-team-note')) $('tw-team-note').textContent = player?.structure_note ?? '';
    const constraints = Array.isArray(player?.constraints) ? player.constraints : [];
    if ($('tw-team-constraints')) $('tw-team-constraints').hidden = constraints.length === 0;
    if ($('tw-team-constraints')) $('tw-team-constraints').textContent = constraints.length ? `当前约束：${constraints.join('；')}` : '';
    // 模式/候选规则/对手未知的徽记已挪回页头那一处（同屏只出现一次）。
    if ($('tw-badge-universe')) $('tw-badge-universe').textContent = player?.candidates_universe?.pool_label ?? `${TEAM_WORKSHOP_BADGES.universe} 600+`;
    $('tw-team-error').hidden = !state.error;
    // 玩家那一行只说「这一只现在进不了队伍 + 能做什么」；服务端原文进 data-tw-error-raw，
    // 开发者抽屉与验收脚本读它（人类 P0：`selected` / `own-0001` / 「服务端原话」不许上玩家层）。
    if (state.error) {
      $('tw-team-error').textContent = `这一只现在进不了队伍：${playerReasonOf(state.error)}`;
      rootEl.dataset.twErrorRaw = state.error;
    } else {
      $('tw-team-error').textContent = '';
      delete rootEl.dataset.twErrorRaw;
    }
  }

  /** 理论阵容那六格：来源是服务端的 `player.analysis_slots`（每格带 held/on_demand/knowledge_only）。 */
  function renderAnalysis(player) {
    const slots = Array.isArray(player?.analysis_slots) ? player.analysis_slots : [];
    const box = $('tw-analysis-slots');
    if (!box) return;
    box.innerHTML = slots.map((slot) => {
      if (slot.state !== 'filled') {
        return `<article class="tw-slot" role="listitem" data-tw-analysis-slot="${slot.index}"
          data-tw-state="empty"><div class="tw-meta">第 ${slot.index} 格（空）</div>
          <div class="tw-meta">${escapeHtml(slot.empty_hint ?? '')}</div></article>`;
      }
      const cls = slot.status === 'held' ? 'tw-state-held'
        : (slot.status === 'on_demand' ? 'tw-state-trial' : 'tw-state-info');
      const canBattle = slot.can_field === true ? '可正式出战'
        : (slot.can_trial === true ? '仅试玩（未核验）' : '暂不能出战');
      return `<article class="tw-slot on" role="listitem" data-tw-analysis-slot="${slot.index}"
        data-tw-state="filled" data-tw-status="${escapeAttr(slot.status ?? '')}"
        data-tw-can-battle="${slot.can_field === true ? 'field' : (slot.can_trial === true ? 'trial' : 'no')}">
       <div class="tw-row"><span class="tw-who">${escapeHtml(slot.name ?? NO_ITEM)}</span>
        <span class="tw-lock">${canBattle}</span>
        <button class="tw-slot-remove" data-tw-remove-analysis="${slot.index - 1}"
          aria-label="把这一只从理论阵容里移除">移除</button></div>
       <div class="tw-meta"><span class="tw-types">${teamSlugs(slot.types) || '系别未登记'}</span>
        <span class="tw-state-tag ${cls}">${escapeHtml(slot.status_label ?? '')}</span></div>
       <details class="tw-detail"><summary>详情（为什么）</summary>
        <div class="tw-detail-body">${escapeHtml(slot.reason ?? '')}</div></details>
      </article>`;
    }).join('');
    const analysis = player?.analysis ?? null;
    // 有内容就自动展开：玩家放了图鉴物种进去，必须立刻看得到它落在哪一格。
    const analysisBox = $('tw-analysis-box');
    if (analysisBox && Number(analysis?.count ?? 0) > 0) analysisBox.open = true;
    const head = $('tw-analysis-head');
    if (head) {
      head.textContent = analysis
        ? `理论阵容 ${analysis.count} / ${TEAM_SLOTS}`
          + `（其中可正式出战 ${analysis.fieldable} 只；${analysis.trial_ready
            ? '六只都跑得起来 → 可以试玩一局' : '还差 ' + analysis.remaining_slots + ' 只'}）`
        : '理论阵容（全图鉴都能放进来做搭配分析；能不能出战看每格的状态）';
    }
    rootEl.dataset.twAnalysis = String(analysis?.count ?? 0);
    rootEl.dataset.twAnalysisTrialReady = analysis?.trial_ready === true ? 'yes' : 'no';
  }

  // ── 候选池（全量图鉴，可翻页 + 搜索）─────────────────────────────────
  /**
   * 「我拥有什么」的两张索引（2026-09-22 人类 P0 实测的真错）。
   *
   * 盒子接口两种列表的字段含义**不一样**，第一版把它们当成一样的，于是「我的精灵」整页失真：
   *   · `kind=mine`    → `select` = **个体** id（`own-0001`）、`group` = **物种** id（`pet_000012`）
   *   · `kind=catalog` → `select` = **物种** id（`pet_000012`）、没有 `group`
   * 第一版用 `ownedBySpecies.get(card.select)` 查表：mine 卡拿个体 id 去查物种键，**必然全落空** →
   * 每张卡都被标成「图鉴 · 按需推算 / 你还没有这一只」，`data-tw-species` 还被塞了个体 id，
   * `addCandidate()` 的 `pet_` 正则直接 return —— 点了没反应。
   *
   * 现在两张索引都建：物种 → 个体列表（同种多只**都能区分**），个体 → 物种。
   */
  async function loadOwnedIndex() {
    try {
      const data = await getJson(`${apiBase}/box?kind=mine&limit=60&offset=0`);
      const bySpecies = new Map();
      const byInstance = new Map();
      for (const card of data?.player?.cards ?? []) {
        const instanceId = String(card.select ?? '');
        const speciesId = String(card.group ?? '');
        if (!/^own-\d+$/.test(instanceId) || !/^pet_\d{6}$/.test(speciesId)) continue;
        if (!bySpecies.has(speciesId)) bySpecies.set(speciesId, []);
        bySpecies.get(speciesId).push({select: instanceId, name: card.name ?? null,
          level: card.level ?? null, note: card.note ?? null});
        byInstance.set(instanceId, {speciesId, name: card.name ?? null});
      }
      state.ownedBySpecies = bySpecies;
      state.ownedByInstance = byInstance;
      rootEl.dataset.twOwnedSpecies = String(bySpecies.size);
      rootEl.dataset.twOwnedInstances = String(byInstance.size);
    } catch {
      state.ownedBySpecies = new Map();
      state.ownedByInstance = new Map();
    }
  }

  /**
   * mine 列表按**物种**合并（2026-09-22 人类 P0：截图里同一只出现两次，用户问「为啥会有重复的精灵」）。
   *
   * 同物种的多个个体在**配队**这件事上是同一个选择（我们选的是物种/构建），
   * 铺成多行既占地方又像 bug。合并成一行并在名字后标 `×N`；
   * 默认用第一个个体，玩家想换具体个体可以之后再做「选个体」入口。
   */
  function mergeMineRows(rows) {
    const bySpecies = new Map();
    for (const card of rows) {
      const speciesId = String(card.group ?? '');
      const instanceId = String(card.select ?? '');
      if (!/^pet_\d{6}$/.test(speciesId) || !/^own-\d+$/.test(instanceId)) continue;
      if (!bySpecies.has(speciesId)) {
        bySpecies.set(speciesId, {speciesId, name: card.name ?? null, types: card.types ?? [],
          variants: []});
      }
      bySpecies.get(speciesId).variants.push({select: instanceId, name: card.name ?? null});
    }
    return [...bySpecies.values()];
  }

  /**
   * 给候选列表按**拥有与否**分组（人类实测 Q2）：在两组之间插一条说明行，并写清各几条。
   * 只动玩家看得见的呈现，不动服务端的召回口径（候选宇宙仍是 600+）。
   */
  function groupPoolRows() {
    const list = $('tw-cand-list');
    if (!list) return;
    list.querySelectorAll('[data-tw-group]').forEach((el) => el.remove());
    const rows = [...list.querySelectorAll('.tw-row')];
    if (!rows.length) return;
    const held = rows.filter((r) => (r.dataset.twStatus || '') === 'held');
    const ref = rows.filter((r) => (r.dataset.twStatus || '') !== 'held');
    if (!held.length || !ref.length) {
      // 只有一类时不加分组条，但把计数写在结果行上（玩家仍知道自己在看什么）
      rootEl.dataset.twPoolHeld = String(held.length);
      rootEl.dataset.twPoolRef = String(ref.length);
      return;
    }
    const note = (text) => `<p class="tw-group-note" data-tw-group="yes">${text}</p>`;
    const firstRef = ref[0];
    firstRef.insertAdjacentHTML('beforebegin',
      '');   // 人类 2026-09-23：这两行分段统计删掉（候选池大小由结果行自己说）
    rootEl.dataset.twPoolHeld = String(held.length);
    rootEl.dataset.twPoolRef = String(ref.length);
  }

  function renderPool() {
    const rows = state.pool.rows;
    if (!rows.length) {
      // 空态要**说出下一步**，不是留一片空白。
      $('tw-cand-list').innerHTML = `<p class="tw-note" data-tw-empty="yes">`
        + `没有符合条件的精灵：换个属性/定位，或者点「清除筛选」看全量。</p>`;
    } else $('tw-cand-list').innerHTML = (state.pool.kind === 'mine'
      ? mergeMineRows(rows).map((card) => {
        // mine 视角按**物种**合并：同一个物种的多个个体在配队时是同一个选择，
        // 铺成多行只会让人以为「重复了」（用户实测就是这么问的）。
        const status = '<span class="tw-state-tag tw-state-held">持有 · 可正式上场</span>';
        const count = card.variants.length > 1
          ? `<span class="tw-rowtag">×${card.variants.length}</span>` : '';
        return `<button class="tw-row" data-tw-species="${escapeAttr(card.speciesId)}"
          data-tw-instance="${escapeAttr(card.variants[0].select)}"
          data-tw-owned="${escapeAttr(card.variants[0].select)}"
          data-tw-status="held" data-tw-kind="mine" data-tw-variants="${card.variants.length}">
         <span class="tw-name">${escapeHtml(card.name ?? NO_ITEM)}${count}</span>
         <span class="tw-types">${teamSlugs(card.types)}</span>
         ${status}
         <span class="tw-rowtag">在你的盒子里</span>
        </button>`;
      }).join('')
      : rows.map((card) => {
      // 两种列表的 id 语义不同（见 loadOwnedIndex 的注释），这里按 `kind` 分支取，
      // **不再**拿一种卡的 id 去查另一种卡的键。
      const isMine = state.pool.kind === 'mine';
      const instanceId = isMine ? String(card.select ?? '') : '';
      const speciesId = isMine ? String(card.group ?? '') : String(card.select ?? '');
      const held = isMine ? /^own-\d+$/.test(instanceId) : state.ownedBySpecies.has(speciesId);
      const status = held
        ? '<span class="tw-state-tag tw-state-held">持有 · 可正式上场</span>'
        : '<span class="tw-state-tag tw-state-trial">图鉴 · 按需推算（未核验）</span>';
      // 同物种多个个体要能区分：mine 列表把**个体**写在名字旁（名字相同也要看得出是两只）。
      const who = isMine && instanceId
        ? `${escapeHtml(card.name ?? NO_ITEM)} <span class="tw-rowtag">${escapeHtml(instanceId)}</span>`
        : escapeHtml(card.name ?? NO_ITEM);
      return `<button class="tw-row" data-tw-species="${escapeAttr(speciesId)}"
        data-tw-instance="${escapeAttr(instanceId)}"
        data-tw-owned="${escapeAttr(instanceId)}"
        data-tw-status="${held ? 'held' : 'on_demand'}"
        data-tw-kind="${isMine ? 'mine' : 'catalog'}">
       <span class="tw-name">${who}</span>
       <span class="tw-types">${teamSlugs(card.types)}</span>
       ${status}
       <span class="tw-rowtag">${held ? '在你的盒子里' : '你还没有这一只'}</span>
      </button>`;
      }).join(''));
    // 2026-09-22（人类实测 Q2）：召回/候选里**约一半是我不拥有的物种**（实测 50 个候选里 25 个：
    // 喵喵 / 水蓝蓝 / 火花 / 迪莫…）。它们按 v3 口径是合法的**候选宇宙**，但页面原来把它们和
    // 「我拥有的」混在一列里，看起来像「不存在的精灵进了我的队伍」。这里按**拥有与否**分组显示并给计数，
    // 让玩家一眼看出哪些能正式出战、哪些只是图鉴参考（只能试玩）。
    groupPoolRows();
    fitPageSize();
    const pages = Math.max(1, Math.ceil(state.pool.total / state.pool.pageSize));
    const page = Math.min(pages, Math.floor(state.pool.offset / state.pool.pageSize) + 1);
    $('tw-cand-page').textContent = `${page} / ${pages}`;
    $('tw-cand-prev').disabled = state.pool.offset <= 0;
    $('tw-cand-next').disabled = state.pool.offset + state.pool.pageSize >= state.pool.total;
    if ($('tw-cand-sub')) $('tw-cand-sub').textContent = state.pool.kind === 'mine'
      ? `我的精灵 ${state.pool.total} 只（能出战）`
      : '';   // 人类：这一行删掉
    const filters = [state.pool.type, state.pool.role].filter(Boolean).join(' / ');
    $('tw-cand-result').textContent = state.pool.total
      ? `${state.pool.total} 条${filters ? `（${filters}）` : ''} · 本页 ${rows.length}`
      : '没有符合条件的精灵：换个属性/定位，或点「清除筛选」。';
    if ($('tw-cand-note')) $('tw-cand-note').textContent = state.pool.kind === 'mine'
      ? '这些是你**拥有**的个体：可以直接进正式队伍并开局。'
      : '全图鉴是**参考**：可以配队与比较；能不能出战要看每一只卡片上的状态标。';
    if ($('tw-cand-note')) $('tw-cand-note').textContent = '';   // 人类：这两行统计删掉
    rootEl.dataset.twPoolTotal = String(state.pool.total);
    rootEl.dataset.twPoolRows = String(rows.length);
  }

  async function loadPool({reset = false} = {}) {
    if (reset) state.pool.offset = 0;
    const seq = (state.poolSeq += 1);
    const query = new URLSearchParams();
    query.set('kind', state.pool.kind === 'mine' ? 'mine' : 'catalog');
    query.set('limit', String(state.pool.pageSize));
    query.set('offset', String(state.pool.offset));
    if (state.pool.q) query.set('q', state.pool.q);
    if (state.pool.type) query.set('type', state.pool.type);
    if (state.pool.role) query.set('role', state.pool.role);
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
     <ul class="tw-axes" id="tw-axes">${ordered.map((axis) => {
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
     <ul class="tw-unknowns" id="tw-unknowns">${list.map((row) => `<li class="tw-unknown">
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
  if (!body) return;   // 人类 2026-09-23：工坊里那块「✦ 小芽 · 阵容阶段」已删 → 没有落点就直接返回
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
    if (state.analysis.length) query.set('analysis_species', state.analysis.join(','));
    if (state.locked.length) query.set('locked', state.locked.join(','));
    if (state.favourite) query.set('favourites_only', 'true');
    if (Number.isInteger(state.maxReplacements)) query.set('max_replacements', String(state.maxReplacements));
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return query.toString();
  }

  /**
   * 把 shadow root 里所有**文本节点**的 markdown 记号剥掉。
   *
   * 为什么要出口统一处理：玩家可见文本有两个来源 —— 本模块模板 + 服务端给的
   * `note` / `honesty_note` / `structure_note` / `reason`。逐个字符串改一定会漏，
   * 以后新加的字段又会漏一次。这里是**唯一**的渲染出口，剥一次就够。
   * 只动文本节点，不碰属性（`data-*` 里的原文必须保持逐字可核对）。
   */
  function stripMarkdownInShadow() {
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        for (const node of el.childNodes) {
          if (node.nodeType === 3 && /[*`]/.test(node.nodeValue)) {
            node.nodeValue = node.nodeValue.split('**').join('').split('`').join('');
          }
        }
      }
    };
    walk(shadow);
  }

  /** 一行即时反馈（不抢正文）：说清「为什么这一下没动作」以及下一步怎么做。 */
  function setPickNote(text) {
    const el = $('tw-cand-result');
    if (el) el.textContent = text;
  }

  function emit() {
    const detail = {
      team: state.selected.slice(),
      // 理论阵容与它能不能试玩：主线程靠这两项决定开局栏显示「正式」还是「试玩」。
      analysisTeam: state.analysis.slice(),
      analysisTrialReady: state.payload?.player?.analysis?.trial_ready === true,
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
    renderAnalysis(player);
    // 2026-09-22（人类 P0）：**证据段**（五轴 / 最小替换 / 这一页还不知道什么）在没选满六只时收起 ——
    // 它那时只会印一排「现在算不出来」，是纯噪音。但 **「推荐下一只」必须留着**：
    // 目标口径第⑤条要求「第 2～5 只时渐进推荐下一只」，藏了它就等于把旗舰功能藏起来。
    const full = Number(player?.selected_count ?? 0) >= TEAM_SLOTS;
    for (const id of ['tw-axes', 'tw-replacement', 'tw-unknowns']) {
      const el = $(id);
      if (el) el.hidden = !full;
    }
    stripMarkdownInShadow();
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
      if (state.payload) { renderTeam(state.payload.player ?? {}); renderAnalysis(state.payload.player ?? {}); }
      else { renderTeam({}); renderAnalysis({}); }
      stripMarkdownInShadow();
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
    // `instance` 来自 **mine** 列表（个体 id），`species` 来自**任意**列表（物种 id）。
    // 你拥有的 → 进**持有队伍**（能正式开局）；你没有的 → 进**理论阵容**（分析/试玩）。
    // 这一条就是用户那次「从图鉴挑一只、选到第六槽才被告知不能开局」的修法：
    // 图鉴条目**本来就不该**往持有队伍里塞，它有自己的清单。
    // mine 卡点进来：`instance` 有值 → 直接进持有队伍（它就是你的个体）。
    // catalog 卡点进来：只有 `species` → 你拥有就换成你的那一只，否则进理论阵容。
    const ownedSelect = (instance && /^own-\d+$/.test(instance))
      ? instance
      : (state.ownedBySpecies.get(species)?.[0]?.select ?? null);
    const owned = ownedSelect ? {select: ownedSelect} : null;
    if (owned?.select) {
      // 点已经在队里的那一只 = **移除**（开关语义）。第一版把这里写成 `return`，
      // 于是「能加不能拿」——用户点第二下没反应。
      if (state.selected.includes(owned.select)) {
        state.error = null;
        setPickNote(`${state.ownedByInstance.get(owned.select)?.name ?? '这一只'}已经在队里了：`
          + '想拿掉就点它那一格右上角的「移除」。');
        return;
      }
      if (state.selected.length >= TEAM_SLOTS) {
        state.error = `持有队伍最多 ${TEAM_SLOTS} 只：先拿掉一只再加。`;
        renderTeam(state.payload?.player ?? {});
    renderAnalysis(state.payload?.player ?? {});
      renderAnalysis(state.payload?.player ?? {});
        return;
      }
      state.selected = [...state.selected, owned.select];
    } else {
      if (!species || !/^pet_\d{6}$/.test(species)) return;
      if (state.analysis.includes(species)) {
        state.error = null;
        setPickNote('这一只已经在理论阵容里了：想拿掉就点它那一格右上角的「移除」。');
        return;
      }
      if (state.analysis.length >= TEAM_SLOTS) {
        state.error = `理论阵容最多 ${TEAM_SLOTS} 只：先拿掉一只再加。`;
        renderTeam(state.payload?.player ?? {});
    renderAnalysis(state.payload?.player ?? {});
      renderAnalysis(state.payload?.player ?? {});
        return;
      }
      state.analysis = [...state.analysis, species];
    }
    state.error = null;
    await reload();
  }

  // ── 接线 ──────────────────────────────────────────────────────────────
  $('tw-cand-list').addEventListener('click', (event) => {
    const row = event.target.closest?.('.tw-row');
    if (!row) return;
    void addCandidate({instance: row.dataset.twInstance || row.dataset.twOwned || null,
      species: row.dataset.twSpecies});
  });
  $('tw-search').addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.pool.q = $('tw-search').value.trim();
      void loadPool({reset: true});
    }, 150);
  });
  // 范围与筛选（人类 P1：622 条候选必须有**真实可用**的搜索与筛选，换条件回第一页）
  const setScope = (kind) => {
    state.pool.kind = kind;
    if ($('tw-scope-all')) $('tw-scope-all').setAttribute('aria-pressed', kind === 'catalog' ? 'true' : 'false');
    if ($('tw-scope-mine')) $('tw-scope-mine').setAttribute('aria-pressed', kind === 'mine' ? 'true' : 'false');
    rootEl.dataset.twScope = kind;
    void loadPool({reset: true});
  };
  // 左侧「阵容评估」悬浮抽屉：点按钮展开/收回（与右边小芽对应）
  const evalToggle = $('tw-eval-toggle');
  const evalClose = $('tw-eval-close');
  if (evalClose) evalClose.addEventListener('click', () => {
    const d = $('tw-eval-drawer'); d.dataset.open = 'no';
    const t = $('tw-eval-toggle'); if (t) t.setAttribute('aria-expanded', 'false');
  });
  if (evalToggle) evalToggle.addEventListener('click', () => {
    const d = $('tw-eval-drawer');
    const open = d.dataset.open !== 'yes';
    d.dataset.open = open ? 'yes' : 'no';
    evalToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $('tw-scope-all').addEventListener('click', () => setScope('catalog'));
  $('tw-scope-mine').addEventListener('click', () => setScope('mine'));
  // 属性/定位：用**闭集文本**循环（选项来自数据里真实出现过的值，不编）
  const cycle = (key, labelEl, options) => {
    const current = state.pool[key] ?? '';
    const at = options.indexOf(current);
    state.pool[key] = options[(at + 1) % options.length];
    const label = state.pool[key] || '全部';
    labelEl.textContent = `${key === 'type' ? '属性' : '定位'}：${key === 'role' ? (ROLE_CN[label] ?? label) : label}`;
    void loadPool({reset: true});
  };
  // 人类 2026-09-23：属性 / 定位改成**下拉选择框**（原来是点击循环的按钮）
  const fillSelect = (el, values, label) => {
    if (!el) return;
    // ⚠ TYPE_CYCLE / ROLE_CYCLE 是**扁平字符串数组**（第一版按 [[value,label]] 写 → 选项变成单字）。
    const ROLE_CN = {attacker: '输出', tank: '坦克', recovery: '恢复', control: '控制', support: '辅助'};
    el.innerHTML = ['<option value="">' + label + '</option>']
      .concat(values.filter(Boolean).map((v) => {
        const val = Array.isArray(v) ? v[0] : v;
        const txt = Array.isArray(v) ? v[1] : (ROLE_CN[v] ?? v);
        return `<option value="${escapeHtml(val)}">${escapeHtml(txt)}</option>`;
      })).join('');
  };
  fillSelect($('tw-filter-type'), TYPE_CYCLE, '属性');
  fillSelect($('tw-filter-role'), ROLE_CYCLE, '定位');
  // ⚠ 第一版写的是 `state.filter.*` + 不存在的 `refreshPool()`（change 必然 ReferenceError）——
  //   真实字段是 `state.pool.type/role`，分页用 `offset`，刷新走 `loadPool()`。
  if ($('tw-filter-type')) $('tw-filter-type').addEventListener('change', (e) => {
    state.pool.type = e.target.value || ''; state.pool.offset = 0; loadPool();
  });
  if ($('tw-filter-role')) $('tw-filter-role').addEventListener('change', (e) => {
    state.pool.role = e.target.value || ''; state.pool.offset = 0; loadPool();
  });
  if ($('tw-filter-reset')) $('tw-filter-reset').addEventListener('click', () => {
    state.pool.q = ''; state.pool.type = ''; state.pool.role = '';
    if ($('tw-search')) $('tw-search').value = '';
    if ($('tw-filter-type')) $('tw-filter-type').value = '';
    if ($('tw-filter-role')) $('tw-filter-role').value = '';
    state.pool.offset = 0; loadPool();
    void loadPool({reset: true});
  });
  // 槽位里的「移除」：持有成员按实例 id 摘，理论阵容按物种 id 摘。
  shadow.addEventListener('click', (event) => {
    const held = event.target?.closest?.('[data-tw-remove-slot]');
    if (held) {
      const at = Number(held.dataset.twRemoveSlot);
      if (Number.isInteger(at) && at >= 0 && at < state.selected.length) {
        state.selected = state.selected.filter((_, i) => i !== at);
        state.error = null;
        void reload();
      }
      return;
    }
    const ana = event.target?.closest?.('[data-tw-remove-analysis]');
    if (ana) {
      const at = Number(ana.dataset.twRemoveAnalysis);
      if (Number.isInteger(at) && at >= 0 && at < state.analysis.length) {
        state.analysis = state.analysis.filter((_, i) => i !== at);
        state.error = null;
        void reload();
      }
    }
  });
  $('tw-cand-prev').addEventListener('click', () => {
    state.pool.offset = Math.max(0, state.pool.offset - state.pool.pageSize);
    void loadPool();
  });
  $('tw-cand-next').addEventListener('click', () => {
    state.pool.offset += state.pool.pageSize;
    void loadPool();
  });
  if ($('tw-favourite')) $('tw-favourite').addEventListener('click', () => {
    state.favourite = !state.favourite;
    if ($('tw-favourite')) $('tw-favourite').setAttribute('aria-pressed', state.favourite ? 'true' : 'false');
    void reload();
  });
  if ($('tw-replace-body')) $('tw-replace-body').innerHTML = [['', '不限'], ['0', '0 只'], ['1', '1 只'], ['2', '2 只'], ['3', '3 只']]
    .map(([value, label]) => `<button class="tw-btn" data-tw-replace="${value}"
      aria-pressed="${value === '' ? 'true' : 'false'}">${label}</button>`).join('');
  if ($('tw-replace-body')) $('tw-replace-body').addEventListener('click', (event) => {
    const chip = event.target.closest?.('[data-tw-replace]');
    if (!chip) return;
    const raw = chip.dataset.twReplace;
    state.maxReplacements = raw === '' ? null : Number(raw);
    if ($('tw-replace-label')) $('tw-replace-label').textContent = raw === '' ? '不限' : `${raw} 只`;
    for (const other of shadow.querySelectorAll('[data-tw-replace]')) {
      other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
    }
    if ($('tw-replace-menu')) $('tw-replace-menu').open = false;
    void reload();
  });
  $('tw-reset').addEventListener('click', () => {
    state.selected = [];
    state.locked = [];
    state.favourite = false;
    state.maxReplacements = null;
    if ($('tw-favourite')) $('tw-favourite').setAttribute('aria-pressed', 'false');
    if ($('tw-replace-label')) $('tw-replace-label').textContent = '不限';
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
