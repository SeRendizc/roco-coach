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
//   · 模块内 = 队伍六槽 + 候选池 + **阵容评估抽屉**（`#tw-eval-drawer`）。
//     2026-09-25（死代码清理）：这里原来还写着「选阵容阶段的 Coach 栏（`.tw-coach`）」——
//     人类 2026-09-23 的批注「右下角的小芽模块整体删除」把那块删了，`.tw-coach` 与
//     `#tw-coach-body` 在真无头 Chrome 的五个状态下都不存在，注释与实现不一致，一并改掉。
//     短结论这条口径没丢：正文在评估抽屉里，纯数据形态走 `coachSummary()`。
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
//: 定位的中文名。**这是工坊这一份的唯一真值源**（下拉框 `#tw-filter-role` 直接读它）。
//: 2026-09-25：这个常量导出，供 `tests/roco-role-label-consistency.test.js` 直接比三处词表
//: （`roco.js:271` 的 `ROLE_LABEL`、`roco-service.js:300` 的 `BOX_ROLE_LABELS`）。
//: 起因：这里曾经在 `fillSelect()` 里**又声明一份**、把 `recovery` 写成「恢复」，
//: 于是同一个下拉框与产品页出现两种译法（漂移）。别再写第二份。
export const ROLE_CN = {attacker: '输出', tank: '坦克', recovery: '回复', control: '控制', support: '辅助'};

/**
 * 候选池的**去重键**：**优先稳定键**（物种 id `group` / `species_id` / `pet_id`），**最后才回落显示名**。
 *
 * 2026-09-25（真缺陷，人类截图指出页头写「我的精灵 **47** 只（能出战）」而数据层是 48）：
 * 原来这一行写的是 `String(r?.species_id ?? r?.name ?? '')`，而 `/api/roco/box` 的卡**根本不带 `species_id`**
 * （卡上的键只有 `select`（实例 id）/ `group`（物种 id）/ `name` / `types` …）⇒ 去重键**永远回落到显示名**。
 * 而**「棋契陛下」这个名字被两个不同物种共用**：`own-0042`(`pet_000556`) 与 `own-0043`(`pet_000575`)
 * ⇒ 48 个个体被并成 47，页头跟着显示 47。**这两个是不同的物种，不该被合并**（它们连立绘都不同）。
 *
 * 判据在 `tests/roco-workshop.test.js`：同名不同物种**不许**被合并、同物种多只**必须**被合并。
 */
/**
 * 候选行/槽位上的小头像。
 *
 * 2026-09-29（Codex 计划 P1-03 资产管线 + 人类「列表/详情/配队/对战共用同一套映射」）：
 * 候选池走的就是 `/api/roco/box`，所以 `card.art` 和盒子页是**同一个字段、同一条判定**：
 *   · `art === true` ⇒ 画 `/api/roco/sprite?id=<物种id>&v=default`（服务端默认发 256px 缩略图）；
 *   · 否则画一个**明确的空占位**（虚线框 + 首字），**不偷偷借另一只精灵的图**。
 * `loading="lazy"`：候选池一页 24 行、每行一张图，不懒加载会一次性拉完整页。
 */
function twArtHtml(card, {size = 28} = {}) {
  // ⚠⚠ 2026-09-29（人类实测：「右边精灵名称旁边那个小虚线框，哪里不应该是 icon 吗？」）：
  //   上面那段注释说「候选池走的就是 `/api/roco/box`，所以 `card.art` 和盒子页是同一个字段」——
  //   **那句是错的**。真机对照两份回执（真 8765）：
  //     · 盒子卡：`{alias, **art:true**, …, **group:"pet_000001"**, **select**, …}`
  //     · **工坊候选行**：`{…, instance_id, **species_id**, species_name, types, …}` ⇒ **没有 `art`、没有 `group`、没有 `select`**
  //   ⇒ 旧代码取 `card.group ?? card.select` 恒得空串、`card.art === true` 恒假
  //   ⇒ **候选池每一行都画成虚线占位**（首字「喵」「水」「火」），而同一只精灵在左边队槽里是有图的。
  //   修法：①物种 id 多认一个 `species_id`（候选行给的就是它）；②`art` **没给**（undefined）时不拦，
  //   照 id 去要图 —— 那个 id 就是这一行自己的物种，**不是"借别的精灵的图"**（原注释担心的那件事）。
  //   ③`art === false`（盒子明确说没有立绘的）仍然画占位，口径不变。
  //   旧代码留档（改钉不删）：const petId = String(card?.group ?? card?.select ?? '');
  //                             if (card?.art === true && petId) {
  // ⚠ 第二版修正（实测：第一版取到的竟是 `own-0001`（实例 id），而 `/api/roco/sprite` 只认**物种 id**
  //   ⇒ 图 `0x0` 加载不出来，等于把虚线框换成了坏图，**比原来更糟**）：
  //   ⇒ **优先取 `pet_` 形状的那一个**，取不到才退到别的（宁可退回占位，也不发一个必然 404 的请求）。
  const _artCands = [card?.group, card?.select, card?.species_id, card?.species].map((x) => String(x ?? ''));
  const petId = _artCands.find((x) => /^pet_/.test(x)) ?? _artCands.find(Boolean) ?? '';
  // ⚠ 第三版（实测收口）：**只有拿到 `pet_` 形状的物种 id 才去要图**。
  //   我第二版试过"优先挑 pet_ 形状、挑不到就退到别的"，实测**仍然取到 `own-0001`**
  //   ⇒ 发出去必然 404、图 `0x0` —— **那等于把虚线框换成坏图，比原样更糟**。
  //   ⇒ 收口成：**不是 `pet_` 形状就画占位**（如实说"这只没有立绘"），**不发必然失败的请求**。
  //   真正的修法见档：这一行**需要把物种 id 带下来**（页面 `state.ownedByInstance` 里有
  //   `{speciesId}`，或让候选行带上 `species_id`）—— 那是下一步，**不在本版硬凑**。
  const artOk = card?.art === true ? true
    : (card?.art === undefined && /^pet_/.test(petId));
  if (artOk && petId) {
    return `<span class="tw-art" style="width:${size}px;height:${size}px">`
      + `<img src="/api/roco/sprite?id=${encodeURIComponent(petId)}&v=default" alt="" `
      + `aria-hidden="true" loading="lazy" decoding="async"></span>`;
  }
  const head = String(card?.name ?? '').trim().slice(0, 1) || '?';
  return `<span class="tw-art tw-art-none" style="width:${size}px;height:${size}px" `
    + `title="这只还没有立绘（不借用别的精灵的图）">${escapeHtml(head)}</span>`;
}

export const poolCardKey = (card) =>
  String(card?.species_id ?? card?.group ?? card?.pet_id ?? card?.name ?? '').trim();

/** 候选行的「同名不同种」区分文本（**纯函数，可测**）：等级 + 定位。
 *
 * 2026-09-25（人类投诉「这个什么陛下有啥区别？我根本看不出来啊」）：48 只里有一对**同名不同物种**
 * （`own-0042/pet_000556` 与 `own-0043/pet_000575` 都叫「棋契陛下」，属性也相同），
 * 候选行原来只画名字/属性/支持等级 ⇒ 两行看起来一模一样。接口回执里本来就有 `level` 与 `role_label`
 * （实测 50/输出 与 80/坦克），所以**零新接口**就能区分。 */
export const poolRowMetaText = (card) => {
  // ⚠ 2026-09-29 改（人类报的 A3：「pvp选精灵看不到等级？」；Codex P1-03 也点名 Team 要「explicit level normalization」）：
  // 原来缺等级时印的是 **`Lv—`** —— 那既不是等级、也不说清为什么没有，读起来像"这只没有等级"。
  // 现在分三种，**都不编**：
  //   · 有数（服务端给了这一物种在盒子里的等级，通常 60）⇒ `Lv.60`；
  //   · 没有数但**是你拥有的**（`data-tw-kind` 那一路拿不到时按 `select` 形状判）⇒ `等级未登记`；
  //   · 图鉴里你**没有**这一只 ⇒ `未持有`（本来就没有等级可言）。
  const raw = card?.level;
  const level = Number.isFinite(Number(raw)) && Number(raw) > 0 ? `Lv.${Number(raw)}` : null;
  const owned = /^own-\d+$/.test(String(card?.select ?? '')) || card?.held === true;
  const levelText = level ?? (owned ? '等级未登记' : '未持有');
  return `${levelText} · ${card?.role_label ?? '定位未登记'}`;
};

/**
 * 构建档 → **玩家第一眼读的那半句**（2026-09-29 U04）。
 *
 * 服务端 `build_tier_label` 原文是「有具体构建（算得出高低）」/「只有图鉴资料（算不出高低）」，
 * 括注那句是给核对用的工程话（玩家投诉里的「算得出高低 ×6」就是它）。首层只留前半句，
 * 括注的**原文一个字不删**，逐字留在每张卡的「诊断详情」里（`diagnosticsHtml` 的 `构建档：…`）。
 * 认不出的档位不猜意思：只把尾部括注摘下来（摘下来的东西仍然在诊断详情里可核）。
 */
export function buildTierPlain(label) {
  const raw = String(label ?? '').trim();
  if (!raw) return '';
  const known = {
    '有具体构建（算得出高低）': '有具体构建',
    '只有图鉴资料（算不出高低）': '只有图鉴资料',
  };
  if (known[raw]) return known[raw];
  const head = raw.replace(/（[^）]*）\s*$/u, '').trim();
  return head || raw;
}

/**
 * 按 `poolCardKey` 去重（保序）：**按物种去重、保留首次出现的那一只**。键为空的条目丢弃（原行为不变）。 */
export const dedupePoolCards = (cards) => {
  const seen = new Set();
  return (Array.isArray(cards) ? cards : []).filter((card) => {
    const key = poolCardKey(card);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * 「这一屏选出的六只 × 四技能」这套配置的**唯一本机记录**（task-8 / Codex 即时监工 B）。
 *
 * 为什么要有它：在这之前，阵容只有一条**临时**的传递路径 ——
 *   · 选人靠地址 `?team=own-…`（盒子带过来）或本屏内存；换招靠 `loadout-store.js` 那把键；
 *   · **没有**"应用这套配置"这个动作，也没有"撤销"，更没有"重新打开还是这一套"。
 * 于是「应用 / 撤销 / 再读取三者一致」这句话在当时**无对象可判**：屏幕上是临时状态，
 * 进战斗那一份由 `roco.js` 现拼，重新打开页面读回来的是另一回事。这一份记录把三者钉在同一串序列化上。
 *
 * 形状（只留一步可退，与个体"回滚只能退一步"同一口径）：
 *   `{current: Snapshot|null, previous: Snapshot|null, applied_count: n}`
 *   `Snapshot = {team: ['own-…'×6], locked: ['own-…'], loadouts: {pet_…: [四个技能 id]}, at: ISO}`
 *
 * ⚠ 这一层**只存"玩家选了什么"**，不存任何结论：不给强度排序、不给胜率、不替引擎判合法性
 * （合法性那一半由 `slotLegalityProblems` 拿**引擎的学习表**逐条判，见下）。
 */
export const TEAM_CONFIG_KEY = 'roco.workshop.teamconfig.v1';

/** 一份快照的**稳定序列化**：屏幕 / 应用 / 再读取三处比的都是这一串（顺序固定、可逐字核）。 */
export function teamConfigFingerprint(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';
  const team = Array.isArray(cfg.team) ? cfg.team.map(String) : [];
  const locked = Array.isArray(cfg.locked) ? [...new Set(cfg.locked.map(String))].sort() : [];
  // 技能那一侧按**队伍顺序**排（同一套六只、顺序不同 = 不同的配置），每个物种内部按玩家选定的顺序。
  const species = Array.isArray(cfg.species) ? cfg.species.map(String) : [];
  const loadouts = cfg.loadouts && typeof cfg.loadouts === 'object' ? cfg.loadouts : {};
  const skills = species.map((id) => `${id}:${(loadouts[id] ?? []).map(String).join('.')}`).join(';');
  return `team=${team.join(',')}|locked=${locked.join(',')}|loadouts=${skills}`;
}

/** 读配置记录。读不出来（没有 / JSON 坏 / 形状不对）一律当**没有**，不编一份。 */
export function readTeamConfig(storage = null) {
  let s = storage;
  if (!s) { try { s = globalThis.localStorage ?? null; } catch { s = null; } }
  const blank = {current: null, previous: null, applied_count: 0};
  if (!s) return blank;
  let all = null;
  try { all = JSON.parse(s.getItem(TEAM_CONFIG_KEY) ?? 'null'); } catch { return blank; }
  if (!all || typeof all !== 'object' || Array.isArray(all)) return blank;
  const clean = (snap) => {
    if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return null;
    const team = Array.isArray(snap.team) ? snap.team.filter((id) => typeof id === 'string' && id) : [];
    if (!team.length) return null;
    return {
      team,
      species: Array.isArray(snap.species) ? snap.species.filter((id) => typeof id === 'string' && id) : [],
      locked: Array.isArray(snap.locked) ? snap.locked.filter((id) => typeof id === 'string' && id) : [],
      loadouts: snap.loadouts && typeof snap.loadouts === 'object' && !Array.isArray(snap.loadouts)
        ? Object.fromEntries(Object.entries(snap.loadouts)
          .filter(([, ids]) => Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id))
          .map(([key, ids]) => [key, ids.slice()])) : {},
      at: typeof snap.at === 'string' ? snap.at : null,
      // 2026-09-29 U04：**撤销目标**额外要记两件事。旧记录里没有这两个键 ⇒ 一个都不补默认值
      // （形状对旧记录逐字不变；`teamConfigFingerprint` 也一个都不读）。
      //   · `explicit`：这一份里**玩家自己选过配招**的物种 —— 撤销要连「默认 / 你选的」一起退回去；
      //   · `applied_before`：这一份**本身是不是一次"已应用"的结果** —— 决定撤销之后状态行
      //     回到「已应用」还是「还没有应用过」。
      ...(Array.isArray(snap.explicit)
        ? {explicit: snap.explicit.filter((id) => typeof id === 'string' && id)} : {}),
      ...(typeof snap.applied_before === 'string' ? {applied_before: snap.applied_before} : {}),
    };
  };
  return {current: clean(all.current), previous: clean(all.previous),
    applied_count: Number.isInteger(all.applied_count) ? all.applied_count : 0};
}

/** 写配置记录。写不进去（隐私模式）返回 false —— 调用方要照实说，不许乐观 UI。 */
export function writeTeamConfig(storage, next) {
  let s = storage;
  if (!s) { try { s = globalThis.localStorage ?? null; } catch { s = null; } }
  if (!s) return false;
  try { s.setItem(TEAM_CONFIG_KEY, JSON.stringify(next)); return true; } catch { return false; }
}

/**
 * 「这套配置能不能应用」——**纯函数**，逐条给玩家读得懂的理由（哪一格、哪个技能、为什么）。
 *
 * 判据的来源都写在这里，一条都不含糊：
 *   · 六个槽位（`TEAM_SLOTS`）必须填满；
 *   · 每一格必须是你**拥有的个体**（`own-…`）——图鉴物种没有冻结配招，引擎不能凭空给一套招；
 *   · 锁定的那几只**必须还在队里**（服务端 RC-301 规则⑨：锁一个没入选的实例整条请求会被拒）；
 *   · 每一格恰好四个技能、互不重复（与 `loadout-store.js` / 引擎的 `battle/new` 同一口径）；
 *   · 四个技能必须都在**引擎给的学习表**里 —— 查不到（还没读过学习表）就如实报 `not-checked`，
 *     **不假装合法**（"查过才说合法"）。
 *
 * `slots` 由调用方给（页面才知道 实例 ↔ 物种 的映射）：
 *   `[{instance: 'own-0004', species: 'pet_000004', skills: ['skill_…'×4]}]`
 * `learnableOf(speciesId)` 返回 `null`（还没查过）或该物种的可学技能 id 数组。
 */
export function teamConfigProblems({slots = [], locked = [], learnableOf = () => null} = {}) {
  const problems = [];
  const list = Array.isArray(slots) ? slots.filter((slot) => slot && typeof slot === 'object') : [];
  if (list.length !== TEAM_SLOTS) {
    problems.push({slot: 0, kind: 'count',
      text: `正式队伍要 ${TEAM_SLOTS} 只持有个体，现在只有 ${list.length} 只。`,
      fix: `在候选池（默认那一档就是「我的精灵」）里再挑 ${TEAM_SLOTS - list.length} 只补满六格。`});
  }
  list.forEach((slot, index) => {
    const instance = String(slot.instance ?? '');
    const species = String(slot.species ?? '');
    const where = `第 ${index + 1} 格（${slot.name ?? instance}）`;
    if (!/^own-\d+$/.test(instance)) {
      problems.push({slot: index + 1, kind: 'not-owned',
        text: `${where}不是你盒子里的个体（图鉴物种不能正式上场）。`,
        fix: '在候选池里切回「我的精灵」再挑一只你拥有的；没有这一只就把它换掉。'});
      return;
    }
    const four = Array.isArray(slot.skills) ? slot.skills.filter((id) => typeof id === 'string' && id) : [];
    if (four.length !== SHARED_LOADOUT_SLOTS) {
      problems.push({slot: index + 1, kind: 'skills-count',
        text: `${where}现在不是四个技能（当前 ${four.length} 个）—— 点「换招」选满四个。`,
        fix: `点这一格的「换招」，在它的学习表里挑满 ${SHARED_LOADOUT_SLOTS} 个，再点「保存这四个」。`});
      return;
    }
    if (new Set(four).size !== four.length) {
      problems.push({slot: index + 1, kind: 'skills-duplicate',
        text: `${where}的四个技能里有重复的 —— 引擎按四个互不相同校验。`,
        fix: '点这一格的「换招」，把重复的那个去掉、换成学习表里另一个，再保存。'});
    }
    const pool = learnableOf(species);
    if (!Array.isArray(pool)) {
      problems.push({slot: index + 1, kind: 'not-checked',
        text: `${where}的四个技能还没核对过学习表。`,
        fix: '点一次「核对六只四技能」把学习表读回来（读不到会如实说，不会当成通过）。'});
      return;
    }
    four.forEach((skillId, at) => {
      if (!pool.includes(skillId)) {
        problems.push({slot: index + 1, kind: 'not-learnable',
          text: `${where}的第 ${at + 1} 个技能（${skillId}）学不到：引擎给这一只的学习表里没有它。`,
          fix: `点这一格的「换招」，把第 ${at + 1} 个换成学习表里有的技能，再保存。`});
      }
    });
  });
  const ids = list.map((slot) => String(slot.instance ?? ''));
  for (const id of (Array.isArray(locked) ? locked : [])) {
    if (!ids.includes(String(id))) {
      problems.push({slot: 0, kind: 'lock-missing',
        text: `锁定的那一只（${id}）不在队伍里：锁定的精灵必须留在队里，否则整条开局请求会被拒。`,
        fix: '把锁定那一只加回队伍，或者先取消它的锁定，再重来一次。'});
    }
  }
  return problems;
}

/** 一格（持有实例 + 它那四个技能）的合法性：纯函数，`learnable` 为 null 时如实回 `unknown`。 */
export function slotLegalityProblems({skills = [], learnable = null} = {}) {
  const four = Array.isArray(skills) ? skills.filter((id) => typeof id === 'string' && id) : [];
  if (four.length !== SHARED_LOADOUT_SLOTS) {
    return [{kind: 'count', text: `现在只有 ${four.length} 个技能（要四个）`}];
  }
  if (new Set(four).size !== four.length) return [{kind: 'duplicate', text: '四个技能里有重复的'}];
  if (!Array.isArray(learnable)) return [{kind: 'unknown', text: '还没核对过学习表'}];
  return four.map((id, at) => (learnable.includes(id) ? null : {id, at,
    kind: 'not-learnable', text: `第 ${at + 1} 个「${id}」学不到（引擎学习表里没有）`})).filter(Boolean);
}


export const AXIS_LABELS = Object.freeze(['环境价值', '最怕的体系', '对局离散度', '操作容错', '覆盖置信']);
export const AXIS_LEGEND = Object.freeze({
  环境价值: '这支队对「版本里常见的对手类型」的整体表现。要有对手分布才能算。',
  最怕的体系: '撞上哪一类体系最吃亏、那一类在环境里占多少。要有对手分布才能算。',
  对局离散度: '表现是不是严重依赖撞到特定阵容。要有对手分布才能算。',
  操作容错: '操作打折扣时会掉多少。要有可复跑的对局采样才能算。',
  覆盖置信: '这六只的配招与数据我们到底知道多少——它说的是「我们自己知道多少」，不是队伍有多强。',
});

import {markdown as renderMarkdown} from '../coach/experience.js';
// R02/R03（2026-09-29）：**判断层**只有一处 —— `src/coach/team-plan.js`。
// 它产出「强度判断 / 两条短板 / 一个优先调整 / 基本打法」，评估侧栏与 6×4 推荐都读它，
// 保证「评估」和「推荐」不会各算一份（task-11 的硬要求）。
import {buildTeamPlan, sixByFourComplete} from '../coach/team-plan.js';
// 属性相性用页面自己那一份（来源 `data/roco/normalized/.../types.json`，有生成与校验脚本）。
import {defenceMultiplier} from './type-affinity.js';
// ⚠ 2026-09-29 补（`art-finish` 报的实况故障，Lead 复核并实测）：
// 本轮 WIP 在 `slotLegalityProblems()` 等处引用了 6 次 `SHARED_LOADOUT_SLOTS`，
// 但这一行**只导入了另外两个**、漏了它 ⇒ `ReferenceError: SHARED_LOADOUT_SLOTS is not defined`，
// 抛在 `renderTeam → legalityRowHtml` 上 ⇒ **点候选项什么都不发生、六槽永远空**（真机实测）。
// 定义本来就在 `loadout-store.js:26`（`export const SHARED_LOADOUT_SLOTS = 4;`），补进导入即可。
import {SHARED_LOADOUT_SLOTS, clearIndividualLoadout, readSharedLoadouts, teamLoadouts, writeIndividualLoadout} from './loadout-store.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const escapeAttr = escapeHtml;
const NO_ITEM = '游戏数据里没有这一项';

const STYLE = `
:host{display:block;color:#e3eaf1;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
*{box-sizing:border-box}
/* 人类 2026-09-23：删掉工坊里的「✦ 小芽（阵容阶段）」后重排 ——
   第一排：**队伍 | 阵容评估**；第二排：**候选池通栏**（「筛选精灵直接拉到最后面」，往下探满）。 */
.tw-drawer{position:fixed;left:0;top:64px;bottom:78px;z-index:60;display:flex;align-items:flex-start;pointer-events:none}
.tw-drawer>*{pointer-events:auto}
.tw-drawer-btn{writing-mode:vertical-rl;text-orientation:upright;letter-spacing:3px;
 align-self:center;padding:16px 10px;border:1px solid #3d5570;border-right:0;border-radius:0 14px 14px 0;
 background:linear-gradient(90deg,#1b2836,#101a24);color:#eaf2f8;font-size:13px;font-weight:650;cursor:pointer;min-height:132px;
 box-shadow:0 6px 18px rgba(0,0,0,.35)}   /* 对齐小芽按钮的观感 */
/* 2026-09-23（接手复核）：把手原来和面板同色同边（#101a24 / #2b3d4e），贴在屏幕最左侧时
   看着像一条渲染残留。加一档更亮的描边与渐变，让人一眼看出这是**可以拉出来的抽屉**。
   （不在这里加箭头字形：垂直书写模式下 ::after 会另起一列，反而更容易看成错位。） */
.tw-drawer-btn:hover{border-color:#5d7d9e;background:linear-gradient(90deg,#223244,#131f2b)}
.tw-drawer[data-open="yes"] .tw-drawer-btn{display:none}   /* 人类：展开后按钮要**消失**，别压着面板 */
.tw-axis-bar{flex:1;min-width:72px;max-width:150px;height:7px;border-radius:6px;background:#101a24;
 border:1px solid #2b3d4e;overflow:hidden;display:inline-block;margin:0 6px}
.tw-axis-bar>i{display:block;height:100%;background:linear-gradient(90deg,#5f8e6c,#a8e5b0)}
.tw-axis-raw{margin:4px 0 0}
.tw-ai{margin:8px 0 10px;padding:10px;border:1px solid #33465b;border-radius:12px;background:#141f2b}
.tw-ai-btn{width:100%;min-height:38px;border-radius:10px;border:1px solid #4a6858;background:#1a2b28;
 color:#cfeeda;font-size:13px;font-weight:600;cursor:pointer}
.tw-ai-btn:hover:not(:disabled){background:#233a33;border-color:#6f9c7f}
.tw-ai-btn:disabled{opacity:.55;cursor:progress}
.tw-ai-answer{margin-top:8px;font-size:13px;line-height:1.65;color:#dbe7f1;white-space:pre-wrap}
.tw-ai-note{margin:6px 0 0}
.tw-drawer-close{display:block;width:auto;align-self:flex-end;margin:0 0 8px;padding:6px 10px;border:1px solid var(--line);
 border-radius:10px;background:#16222f;color:#dbe7f1;font-size:12px;cursor:pointer;text-align:left}
.tw-drawer-panel{display:none;width:min(300px,80vw);overflow:auto;max-height:100%;background:#101a24;
 border:1px solid var(--line);border-radius:0 14px 14px 0;padding:12px 14px;margin-left:0}
.tw-drawer[data-open="yes"] .tw-drawer-panel{display:block}
    /* R03（2026-09-30）：判断块**宽视口两栏** —— 四块要在 900px 内看得全（原来 playstyle bottom≈1297 ✗）。
       只作用于 #tw-teamplan 内部（工坊在 shadow root ⇒ 全局 style.css 够不着它 ✓） */
    .tw-teamplan{margin:2px 0 6px}
    .tw-teamplan .tw-teamplan-sec{min-width:0;margin:0 0 6px}
    .tw-teamplan .tw-teamplan-sec h4{margin:4px 0 3px;font-size:13px}
    .tw-teamplan .tw-teamplan-sec p{margin:2px 0}
    @media (min-width:1200px){
      #tw-teamplan{display:grid;grid-template-columns:1fr 1fr;column-gap:14px;align-items:start}
      #tw-teamplan [data-tw-plan="strength"]{grid-column:1 / -1}
      #tw-teamplan [data-tw-plan="playstyle"]{grid-column:1 / -1}
      /* ⚠ 试过在 playstyle 内部再分两栏（columns:2）：实测没用（抽屉只有 300px 宽 ⇒ 每栏约 135px，
         行反而折得更碎，高度 448 基本不变）⇒ 撤掉，别留一条看着像优化的无效规则 */
    }
/* 一屏装完：网格高度 = 可用高度，候选列表**内部滚动**，页面本身不上下滑。 */
/* 人类 2026-09-23（子代理 A/B 实测）：工坊 host 曾是 h=0 但 shadow 里的固定浮层溢出，
   把页面级控件（#select-panel 的切换/搜索）挡住了 —— elementFromPoint 命中 SECTION#team-workshop。
   这里让 host 与浮层容器默认不吃点击，只有真正需要交互的块恢复可点。 */
:host{pointer-events:none}
.tw-grid,.tw-panel,.tw-drawer-btn,.tw-drawer-panel,.tw-cand-list,.tw-slots{pointer-events:auto}
.tw-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:stretch;
 height:100%;min-height:0;grid-template-rows:minmax(0,1fr)}   /* 行吃满 → 两框纵向铺满 */
.tw-cand,.tw-team{display:flex;flex-direction:column;min-height:0;height:100%;align-self:stretch}
.tw-cand-list{flex:1 1 auto;min-height:0;overflow:auto;grid-auto-rows:44px;gap:4px;align-content:stretch}
/* 2026-09-29：候选行的小头像（Codex P1-03 资产管线）。有立绘画图、没有画一个明确的空占位。
   44px 的行高里放 28px 的图，圆角与盒子页的头像一致（7px vs 10px 是按尺寸缩过的比例）。 */
.tw-art{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;
 border:1px solid #2b3d4f;background:#101a26;overflow:hidden;font-size:12px;color:#7d8fa3;line-height:1}
.tw-art img{width:100%;height:100%;object-fit:contain;display:block}
.tw-art-none{border-style:dashed}
.tw-cand-list>*{height:44px;min-height:44px;max-height:44px;overflow:hidden}   /* 人类：两种档位行高**一致**、不许变高 */   /* 一屏下也要有可用高度（实测曾被挤到 60px） */
.tw-team{grid-column:1;grid-row:1;width:100%}

/* 两列**等高**（用户：小芽那栏不能拉长吗、非得这么丑？）：网格项拉伸，
   面板内部再让最后一栏吃满剩余高度。 */
.tw-grid{align-items:stretch}
.tw-cand{grid-column:2;grid-row:1;width:100%}
.tw-panel{display:flex;flex-direction:column}
.tw-panel{background:#1a2635;border:1px solid #314154;border-radius:12px;padding:6px 12px 10px;min-width:0}
.tw-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0 8px}
.tw-head h3{margin:0;font-size:15px}
.tw-head .tw-sub{color:#9caebe;font-size:12px;margin-left:auto}
/* 2026-09-25（死代码清理）：.tw-badges / .tw-badge / .tw-badge.warn / .tw-badge.muted
   四条规则删除 —— 模块里没有任何 class="tw-badge*" 的生成点，真无头 Chrome 在
   0 只 / 2 只 / 满六只 / 抽屉打开 / details 全展开五个状态下逐条 querySelectorAll 全 0 命中。
   （三个徽记现在印在**页头**那一处；.tw-badge.muted 是审计漏掉的一条，同一批一起清。） */
/* 六个槽位**等高**：grid-auto-rows:1fr 让同一行的槽位一样高，空槽与已选槽也一样高。
   2026-09-22 人类 P0 实测：选中之后往卡里塞了整段机制原文，卡片当场长高，
   空槽/已选槽高度参差、网格跳动 —— 选前选后必须是同一张版式。 */
/* 2026-09-26（玩家可见缺陷：六张卡文字互相压住 / 被卡片边缘截断 / 面板页脚压在第六张卡上）——
   行的下限从**写死的 232px** 换成 **min-content**：
     · 1536×684 实测槽位区只有 384～402px，两行 232px + 8px 间距 = 472px **装不下** ——
       原来的 minmax(232px,1fr) 把行钉在 232，而卡片内容实测 277～294px，
       于是卡片自己 overflow:hidden 把「详情」那行从中间裁掉（越界 38.3px），
       整排第二行还溢出到面板外面，压在页脚的「清空阵容」上（截图里那团糊字）。
     · 改成 min-content 之后：行高 = 内容高（修复后实测 295.3px/行、两行 598.6px），
       放不下时由 .tw-slots 自己**滚动**（与候选列表同一种做法，页面仍然一屏锁死）。
     · 有富余时 1fr 照旧把两行拉平铺满（实测有一轮可用 618.2px → 305.1px/行、不留空洞）；
       可用高度只差几 px 时（实测 594.7 vs 598.6）就让它滚 4px —— 宁可滚，也不为省那
       4px 去压字。2026-09-23「下半截不许是空洞」那条口径在富余时仍然成立。
   align-content:start：行按内容排，多余的空白留在**网格之后**，不再把行拉变形。 */
.tw-slots{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;grid-auto-rows:minmax(min-content,1fr);
 flex:1 1 auto;min-height:0;align-content:start;overflow-y:auto;overflow-x:hidden}   /* 人类：纵向拉伸铺平整个板块 */
/* 2026-09-23（接手复核）：槽位原本被钉死 height/min/max = 232px，而它所在的行是 1fr（1440 实测 327.6px）
   → 每一行下方留 95px 空档、六格加起来约 190px 的**空洞**（人类看到的「下半截是空的」）。
   另外满队时两格的内容比 232px 高 16px，被 overflow:hidden **裁掉**（实测 slotOverflow [0,0,0,16,0,16]）。
   改成 height:auto + 行 minmax(232px,1fr)：宽屏撑满行高（空洞与裁切一起消失），
   窄屏仍以 232px 起算（与改前逐位一致，390 实测行为不变）。选前选后同高不变（同一行同一个行高）。 */
.tw-slot{height:auto;min-height:232px;max-height:none;border:1px dashed #36495e;border-radius:10px;padding:8px 9px;
 display:flex;flex-direction:column;gap:4px;min-width:0;overflow:hidden}
/* 2026-09-26（同一条玩家可见缺陷的另一半）：卡里的行**不许被压扁**。
   卡片内容比行高时，flex 子项默认 flex-shrink:1 —— 实测名字行被从 51px 压到 42px，
   而里面的「移除」按钮是 44px（拇指尺寸是硬判据），按钮于是溢出自己那一行、
   压到下面「机制线索」的字上（截图里那团叠字）。改成不收缩：每一行保持自己的高度，
   整张卡由上面的 min-content 行高托住，宁可让面板滚，也不压字。 */
.tw-slot>*{flex:0 0 auto}
/* 空槽：内容**居中** + 一个淡加号，读起来像「投放位」而不是「渲染坏了的空盒子」 */
.tw-slot[data-tw-state="empty"]{align-items:center;justify-content:center;text-align:center;gap:6px}
.tw-slot[data-tw-state="empty"]::before{content:'+';font-size:24px;line-height:1;color:#47657f}
.tw-slot[data-tw-state="empty"]>.tw-meta:first-child{color:#c6d2de;font-size:12.5px}
/* （满槽卡的「详情」贴底**不用**在这里另写规则：下面已有 .tw-detail{margin-top:auto}，
   槽位撑高之后它自然吃掉多出来的行高。先前这里多写了一条同名声明，已删。） */
.tw-slot.on{border-style:solid;border-color:#8dd49c;background:#17242f}
.tw-slot .tw-who{font-weight:600;font-size:14px;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 2026-09-29（阶段三布局红根因，**实测定死**）：这一行原来会**折行** ——
   .tw-row 那条通用规则带 flex-wrap:wrap，而 .tw-slot .tw-row 没覆盖它。
   实测（判据自己那一队 own-0001..0006）：卡1–5 首行 = tw-art(32)+tw-who(20)+移除(44) = 60px；
   **卡6 多一个「锁定」标**（那一只是锁定态）⇒ 四个子元素放不下 ⇒ 折成两行 = 98px。
   而 .tw-slots 是 grid-auto-rows:minmax(min-content,1fr)（按行内最高定高）
   ⇒ 后三张那一行被撑到 383.9、前三张停在 345.9 ⇒ **两行差 38px**（判据两档视口实测、连跑三次一致）。
   这与人类 2026-09-26 报的「第 4～6 张比前三张矮」是同一个机制（只是方向反过来）。
   处置：首行 flex-wrap:nowrap（不折行）+ 名字 min-width:0 且超出省略号 ——
   与上面 .tw-mech-line 同一套已文档化的口径：「首层每样只留一行，不是把资料读完」。
   完整名字仍在详情抽屉与 title 可达，没有丢信息。 */
.tw-slot .tw-meta{color:#9caebe;font-size:11.5px;line-height:1.5;overflow-wrap:anywhere}
.tw-slot .tw-row{display:flex;gap:6px;align-items:center;min-width:0;flex-wrap:nowrap}
.tw-slot .tw-lock{margin-left:auto;color:#9caebe;font-size:11px;white-space:nowrap}
.tw-types{display:flex;flex-wrap:wrap;gap:3px}
/* 机制一行：首层**只留一行**（超出用省略号），完整原文与四个技能进槽位里的详情抽屉。
   为什么改：把整段机制原文塞进卡片会让选中后的卡比空卡高出一截（同一个网格里参差不齐），
   而卡片首层的任务是「认得出这只 + 有一个区分点」，不是把资料读完。 */
.tw-mech{display:flex;flex-direction:column;gap:2px;margin-top:2px;min-width:0}
.tw-mech-line{font-size:11.5px;line-height:1.5;color:#bcd0e0;overflow-wrap:anywhere;
 display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
/* 机制线索：**固定两行**的高度（min-height:3em = 2 行 × line-height 1.5）。
   2026-09-26（六张卡等高）：这一行原来随内容 1～2 行伸缩，实测有的卡 34.5px、有的 51px，
   同一网格的两行卡就差出 16px（截图里「前三张 / 后三张不一样高」的一个来源）。
   现在留够两行、超出部分省略号，**全文在「详情」里**（mechanismDetailHtml 逐字给）。 */
.tw-mech-tags{font-size:11px;line-height:1.5;color:#8fa4b6;overflow-wrap:anywhere;min-height:3em;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* 配招那一行：**一行定高**（44px 按钮 + 单行清单）。
   清单是四个技能名，长短差很大（实测会折成两三行）→ 卡片高矮不一。
   现在清单不换行、超出省略号；全文同时给在 title 与「详情」的四个技能里。
   2026-09-26（六张卡结构一致）：这一行**每张卡都在**，见 loadoutRowHtml()。 */
.tw-slot .tw-loadout{display:flex;align-items:center;gap:6px;min-width:0;min-height:44px}
/* 2026-09-29 U04：这一块改成**竖排**（四个技能小格 + 两个动作按钮），类名保留 .tw-loadout
   （判据与版式脚本按它找这一行），只是覆盖掉上面那条横排规则。 */
.tw-slot .tw-loadout.tw-loadout-stack{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-height:0}
.tw-slot .tw-loadout-btn{flex:0 0 auto}
.tw-slot .tw-loadout>span{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 抽屉候选卡里的机制行 = **点开看全文**（人类 2026-09-23 当面确认）。默认仍是**一行**
   （clamp 不动 → 卡片高度与排布跟以前逐位一样），点开后解除 clamp、原文在同一处展开。
   summary 自己钉 44px 高：shadow root 里 document 的 summary 规则进不来
   （工坊是 shadow DOM，判据「30-触控目标」在 shadow 里量）。 */
.tw-mech-fold>summary{min-height:44px;display:flex;align-items:center;gap:8px;
 cursor:pointer;list-style:none;margin:0}
.tw-mech-fold>summary::-webkit-details-marker{display:none}
.tw-mech-fold>summary::after{content:'全文';flex:0 0 auto;margin-left:auto;font-size:11px;
 color:#8dd49c;border:1px solid #3f6b52;border-radius:6px;padding:1px 7px;white-space:nowrap}
.tw-mech-fold[open]>summary::after{content:'收起';color:#9caebe;border-color:#3a4a5c}
.tw-mech-fold[open]>summary{align-items:center;padding-top:4px}   /* 2026-09-25：展开态不许再变高（人类投诉「收起头那么大」）；两态高度差判据 J-④a */
.tw-mech-fold[open]>summary .tw-mech-line{-webkit-line-clamp:unset;display:block;overflow:visible}
/* 这一行本来就放得下（JS 量过 scrollHeight）→ 不显示「全文」药丸，免得点开没有新内容 */
.tw-mech-fold--plain>summary{cursor:default}
.tw-mech-fold--plain>summary::after{display:none}
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
/* 2026-09-25（死代码清理）：.tw-state-info **保留**。它看上去零命中，但**有活的生成点**：
   本文件 renderAnalysis() 里 slot.status === 'held' ? 'tw-state-held' : (on_demand ? 'tw-state-trial'
   : 'tw-state-info') —— 第三档对应服务端 status='knowledge_only'（「图鉴 · 仅资料（暂不能出战）」）。
   实测（/tmp/roco-clean/probe6.mjs，纯 Node 打服务端）：全图鉴 622 个物种逐个塞进 analysis_species，
   状态只出现 held 48 / on_demand 574；不存在的物种 id 在 RC-301 校验就被 400 [UNKNOWN_SPECIES_ID]
   挡下 → 这一档目前**不可达**，属防御性分支（与 .boot-fallback 同类），不是死代码。 */
.tw-state-info{color:#9caebe;border-color:#3a4a5c;background:#18232f}
.tw-about{margin:6px 0 0;border:1px solid #2b3a4a;border-radius:9px;background:#131e2a}
.tw-about>summary{font-size:11.5px;color:#9caebe;cursor:pointer;min-height:44px;
 display:flex;align-items:center;gap:6px;padding:0 10px;list-style:none}
.tw-about>summary::-webkit-details-marker{display:none}
/* 2026-09-25（人类投诉「箭头还是反的」）：改成惯例 —— **收起 ▸ / 展开 ▾**（原来正好对调）。
   判据 J-④b 读 summary 的 ::after content，两个态各断言一次。 */
.tw-about>summary::after{content:'▸';margin-left:auto;color:#6b7f92}
.tw-about[open]>summary::after{content:'▾'}
.tw-about>*:not(summary){margin:0 10px 8px}
/* 通用（不再限定 .tw-slot）：槽位与**候选卡**都有 <details class="tw-detail">，
   候选卡那两个 summary 曾在 390×844 塌成 0×112（判据 30-触控目标 因此红）。 */
.tw-detail{width:100%;margin-top:auto}
.tw-detail>summary{width:100%;display:block;box-sizing:border-box;min-height:44px}
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
/* 2026-09-25（死代码清理）：.tw-fmenu / .tw-fmenu>summary / ::-webkit-details-marker /
   ::after / .tw-fmenu-body 五条规则与 .tw-coach-body{,.tw-who,p} 三条规则删除。
   两组的 class 在整个模块里**没有任何生成点**（grep -n "tw-fmenu|tw-coach-body" 只命中样式行），
   真无头 Chrome 五个状态下 querySelectorAll 全 0 命中：前者是「最多替换几只」折叠菜单的壳，
   后者是小芽 Coach 栏的正文（人类 2026-09-23 连 .tw-coach 一起删了）。
   注意 box.html 的 .fmenu 是**另一个类**（没有 tw- 前缀），不受影响。 */
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
}
@media(max-width:620px){
 .tw-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:none}
 /* 人类 2026-09-23（子代理实测 390 下 .tw-team 只有 26px）：宽屏那两条显式列位
    （.tw-team{grid-column:1} / .tw-cand{grid-column:2}）会盖掉单列规则 → 这里复位。 */
 .tw-team,.tw-cand{grid-column:1 / -1 !important;grid-row:auto !important;width:100% !important}
 .tw-slots{grid-template-columns:repeat(2,minmax(0,1fr))}
 .tw-cand-list{max-height:none}
 /* 2026-09-25（门禁 check 32 三次红，A/B 定位后确认**是玩家可见缺陷**）：390×844 下面板只有
    289px，头部 21 + 档位 44 + 筛选 92 + 翻页 44 ≈ 284 ⇒ 候选列表可见高度被挤到 5px、
    加第一只后变 **0**；而**零面积的滚动框不参与命中测试** ⇒ 真实鼠标/手指穿透到面板背景，
    玩家那一刻**点不到候选**（判据报的是"点击落空"，定位成本很高）。
    修法两条**必须成对**：给列表一个下限（一行 44px × 3），同时让面板自己可滚 ——
    只加下限、不给面板滚动，内容会顶破页面（实测点到开局条、selected 0→0）。
    宽屏中性：1440 下列表 470px，下限不生效、面板也不会出滚动条。 */
 #tw-cand-list{min-height:132px}
 .tw-panel.tw-cand{overflow-y:auto}
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
  /* 2026-09-25（死代码清理，审计 §附 4）：原来这条选择器表里还有 .tw-cand-prev / .tw-cand-next
     两个**类**选择器，但元素带的是 id（<button class="tw-btn" id="tw-cand-prev">，见本文件
     renderPool 上方的分页器模板）→ 那两个类选择器永远不命中。删掉冗余项，规则本身保留
     （#tw-cand-prev / #tw-cand-next 仍然命中，两个 id 也被 browser-roco-ux-acceptance.mjs:249/435 读）。 */
  .tw-scope-row button,#tw-cand-prev,#tw-cand-next{min-height:44px !important;font-size:12.5px}
  .tw-select{width:96px;max-width:96px}
  /* 子代理实测：左侧「阵容评估」抽屉按钮在 390×844 是 34×120（宽 <44）→ 补窄屏最小宽度 */
  .tw-drawer-btn{min-width:44px;width:44px;padding:14px 6px}
  /* 2026-09-25（人类纠偏②的**前提**）：窄屏下把**展开后的**面板高度压到 34dvh。
     为什么必须一起改：左贴边那条面板在 390px 宽的屏上原来高 702px（从 y=64 一直盖到 y=766），
     而候选池在 390×844 下位于 y≈460 以下 —— 也就是「面板盖住候选行」。人类这次的口径是
     「既然不遮挡，那就不要设置点别的地方自动消失」：**不遮挡**这件事得先成立，抽屉才敢不自动收起
     （工坊判据 32-窄屏候选区 量的正是「真鼠标点得到候选行」，它之前是靠「点别处自动收起」躲过去的）。
     面板自己 overflow:auto，压短只是要多滚两下，内容一个字都没少；宽屏（>560px）完全不变。 */
  .tw-drawer-panel{max-height:34dvh}
}


.tw-filter-row #tw-filter-reset{flex:0 0 auto}
.tw-filter-row input[type=search]{width:100%}
.tw-filter-row select.tw-btn{min-height:36px}
#tw-cand-result{font-size:11.5px}         /* 「N 条 · 本页 M」字号小一点 */
.tw-panel.tw-team .tw-slots .tw-slot[data-tw-state="empty"]{border-style:dashed}

/* ── 2026-09-29 U04：玩家层可扫读 + 诊断层默认收起 ─────────────────────────
   玩家投诉的是「配队全是 ID 和工程文字」。这一屏第一眼要能回答：这六只分别是谁、
   什么系、干什么（定位）、带哪四招、能不能换/换下来。工程字段（构建档原文、机制标签、
   学习表核对状态、技能号）**一个字都不删**，全部移进每张卡自己的「诊断详情」
   （details[data-tw-diag]，默认收起）。 */
.tw-slot .tw-role{font-size:11px;border:1px solid #3a4a5c;border-radius:999px;padding:1px 7px;
 color:#bcd0e0;white-space:nowrap}
.tw-skills{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px;margin-top:3px;min-width:0}
.tw-skill{font-size:11px;line-height:1.35;color:#d6e2ee;background:#1d2c3c;border:1px solid #2b3d4f;
 border-radius:6px;padding:3px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tw-skill[data-tw-skill-state="missing"]{border-style:dashed;color:#9caebe;background:transparent}
.tw-skills-head{display:flex;align-items:center;gap:6px;min-width:0;margin-top:3px}
.tw-skills-src{font-size:10.5px;color:#9caebe;border:1px solid #3a4a5c;border-radius:5px;padding:0 5px;
 white-space:nowrap;flex:0 0 auto}
/* 两个动作（换招 / 替换）各占一半，都保持 ≥44px 的拇指尺寸（390×844 的触控判据量的就是它们）。 */
.tw-slot-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;min-height:44px}
.tw-slot-actions .tw-btn{width:100%;min-width:0}
/* 被「替换」选中、等着玩家在候选池点一只的那一格：描边变色，一眼看得出要换谁。 */
.tw-slot[data-tw-replace-armed="yes"]{border-style:solid;border-color:#f0cb77;background:#221d14}
/* 诊断详情：默认收起（details 不带 open）。summary 保持 44px 的拇指尺寸。 */
.tw-diag{border-top:1px solid #24313f;margin-top:4px}
.tw-diag>summary{font-size:11.5px;color:#8fa4b6;cursor:pointer;min-height:44px;display:flex;align-items:center;
 list-style:none;gap:6px}
.tw-diag>summary::-webkit-details-marker{display:none}
.tw-diag>summary::after{content:'▸';margin-left:auto;color:#6b7f92}
.tw-diag[open]>summary::after{content:'▾'}
.tw-diag .tw-detail-body>div{margin:3px 0}
/* 候选池：**已拥有**与**图鉴（你没有）**必须一眼分得开（实心绿边 vs 虚线冷色）。 */
.tw-row--owned{border-color:#3f6b4c}
.tw-row--ref{background:#131d28;border-style:dashed;border-color:#3a4a5c}
.tw-row--ref .tw-name{color:#c6d2de;font-weight:500}
.tw-state-ref{color:#f0cb77;border-color:#6b5b3a;background:#2a2318}
.tw-scope-note{margin:0 0 6px;font-size:11.5px;color:#9caebe;line-height:1.5}
/* 队伍已满时点候选 → 「替换哪只」（不再让玩家自己猜先删谁） */
.tw-replace{border:1px solid #6b5b3a;background:#241f16;border-radius:10px;padding:8px 10px;margin:0 0 8px;
 flex:0 0 auto}   /* 面板是 flex 列：这一块与预览表**不许被压扁**（宁可让候选列表自己滚） */
.tw-replace h4{margin:0 0 4px;font-size:13px;color:#f0cb77}
.tw-replace-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:6px 0}
.tw-replace-list .tw-btn{width:100%;min-width:0}
/* 6×4 整套配置的预览表 */
/* 6×4 整套配置的预览表：**自己有上限、自己滚** —— 展开时不许把六张卡整块挤出视野
   （实测：不设上限时它在 1440×900 下把槽位区顶到只剩一条缝）。 */
.tw-plan{margin:6px 0 0;border:1px solid #3f6b52;border-radius:10px;background:#131f1a;padding:8px 10px;
 flex:0 0 auto;max-height:44%;overflow:auto}
.tw-plan table{width:100%;border-collapse:collapse;font-size:11.5px}
.tw-plan th{text-align:left;color:#9caebe;font-weight:500;padding:2px 4px;border-bottom:1px solid #2b3d4f}
.tw-plan td{padding:3px 4px;border-bottom:1px solid #1e2a36;vertical-align:top;color:#dbe7f1}
.tw-plan td.tw-plan-who{white-space:nowrap}
.tw-plan td.tw-plan-four{color:#bcd0e0}
.tw-plan .tw-plan-mark{font-size:10.5px;color:#9caebe}
/* 应用前的逐只问题 + 修法（一条一格，说清哪一格、什么问题、怎么改） */
.tw-problem{border:1px solid #6b5b3a;border-radius:8px;background:#241f16;padding:6px 8px;margin:6px 0 0;
 font-size:12px;line-height:1.6}
.tw-problem b{color:#f0cb77}
.tw-problem .tw-fix{color:#cfeeda}
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
function mechanismRow(mechanism, {expandable = false, tags = true} = {}) {
  const frozen = isFrozenMechanism(mechanism);
  const line = frozen ? mechanism.line.trim() : MECHANISM_PENDING;
  const tagList = mechanismTagsOf(mechanism);
  const lineHtml = `<span class="tw-mech-line">${escapeHtml(line)}</span>`;
  // 人类 2026-09-23（接手复核，已当面确认）：「阵容评估」抽屉里那句机制被 `-webkit-line-clamp:1`
  // 截成「…」，保持排布不变、只把它改成**点开看全文**。
  // 做法：全文本来就在 DOM 里（截断只是 CSS），所以直接让 summary **包住同一份文本**、
  // 展开时解除 clamp —— 不复制文本（否则读屏与判据读到的文本会变成两份）。
  // 只在**抽屉的候选卡**里这么做：槽位卡里的 `.tw-slot{overflow:hidden}` 会把展开的内容裁掉，
  // 它本来就有「详情」那条抽屉可以读全文。
  const lineBlock = (expandable && frozen)
    ? `<details class="tw-mech-fold"><summary>${lineHtml}</summary></details>`
    : lineHtml;
  return `<div class="tw-mech" data-tw-mechanism="${frozen ? 'frozen' : 'pending'}">
   ${lineBlock}
   ${tags ? `<span class="tw-mech-tags">${tagList.length
    ? `机制线索：${escapeHtml(tagList.join(' · '))}` : '机制线索：登记层没有这一只的标签'}</span>` : ''}
  </div>`;
}

function mechanismTagsLine(mechanism) {
  const list = mechanismTagsOf(mechanism);
  return list.length ? `机制线索：${list.join(' · ')}` : '机制线索：登记层没有这一只的标签';
}

/** 机制标签的纯文本形式：首层那行是**两行省略号**，全文由详情与它给出（同一份数据、两处用法）。 */
function mechanismTagsOf(mechanism) {
  return (Array.isArray(mechanism?.tags) ? mechanism.tags : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.tag))
    .filter((tag) => typeof tag === 'string' && tag.trim() !== '');
}

/**
 * 数值 → **人话档位**（人类 2026-09-25：「可读性一坨屎，不知道在说啥」）。
 *
 * 以前主行直接印 `0.75735 · 相对分（0～1 的序数标度）`：一是小数位比结论还长，
 * 二是「序数标度 / 相对分极差」是内部口径，玩家读不懂。现在主行只给档位词 + 一条进度条，
 * **精确值一个都不删**，收进同一行的「原始数值」折叠区（要看得出处的人点开就有）。
 * 档位分界是**展示口径**（不是新规则）：< 0.34 偏低 / < 0.67 中等 / 其余偏高。
 */
export const AXIS_LEVEL_BANDS = Object.freeze([[0.34, '偏低'], [0.67, '中等'], [1.01, '偏高']]);
export function axisLevelWord(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  for (const [edge, word] of AXIS_LEVEL_BANDS) if (value < edge) return word;
  return '偏高';
}
/**
 * 主行文案：只给**能读的一句话**。没有值就返回 null，不拿 0 顶上。
 *
 * 2026-09-29：**导出**是为了让 `tests/roco-workshop.test.js` 能直接钉住一件事 ——
 * 「假设的权重永远不许被说成观测频率」（Codex P0-04）。走页面渲染去测那句话成本太高，
 * 而这条判据要的正是这句话本身。
 */
export function axisValueText(axis) {
  if (!axis.available || axis.value === null || axis.value === undefined) return null;
  if (axis.value_kind === 'archetype') {
    // 2026-09-26（人类：面板不是人话）：主行以前直接印**机器 id**（`wing_king_force` 这种）
    // 与**裸小数**（`环境占比 0.142857`）。现在主行只说人话：有名字就用名字，没有就"某类体系"；
    // 占比换算成"大约每 N 局遇到 1 次"。**精确值一个都不删** —— 它们仍在折叠区（`axisRawText`）。
    // 2026-09-27（审计同族次要问题，实测）：服务端给的是 `value.label`，这里原来读
    // `value.archetype_label` ⇒ **体系名被丢掉**（那一栏只剩分数）。两个键都认（旧产物兼容），
    // 都拿不到就 null —— 不编。
    const raw = axis.value.label ?? axis.value.archetype_label;
    const label = typeof raw === 'string' && raw ? raw : null;
    const weight = Number.isFinite(axis.value.weight) && axis.value.weight > 0 ? axis.value.weight : null;
    // ⚠ 2026-09-29 改（Codex 体检报告 **P0-04**：环境权重与数值宣称）：
    // 这一句原来不分来源，一律说「这类在环境里**大约每 N 局遇到 1 次**」——
    // 而 N 是从一个**赛前假设的权重**（各体系等权）算出来的，**不是实测出场率**。
    // 服务端其实早就把来源放在 `axis.distribution_kind` 里了（`measured` / `assumption` / `null`），
    // 同一份回执的 `available_note` 也写着「先假设『对手会用什么体系』…不是实测数据」——
    // 也就是**同一屏上两句互相打架**。现在按来源分档说，**测过才敢说次数**：
    //   · `measured` ⇒ 说「实测对手分布里大约每 N 局遇到 1 次」；
    //   · 其余（假设 / 没标） ⇒ 只说这是**赛前假设的权重**，并明说不是实测出场率。
    // 判据的意图：**假设的权重永远不许被说成观测频率**（`tests/roco-workshop.test.js` 有一条钉它）。
    const measured = axis.distribution_kind === 'measured';
    const share = !weight ? '环境里占多少没有数据'
      : (measured
        ? `这类在实测的对手分布里大约每 ${Math.max(2, Math.round(1 / weight))} 局遇到 1 次`
        : `赛前假设这类占 ${Math.round(weight * 100)}%（各体系等权）——这是假设的权重，不是实测出场率`);
    return `${label ? `撞上「${label}」这类` : '撞上某类体系时'}最吃亏（${share}）`;
  }
  const word = axisLevelWord(axis.value);
  if (word) return word;
  return '有值但读不出档位';
}
/** 折叠区里的原始值与口径（**照实抄**引擎给的，不换算）。 */
function axisRawText(axis) {
  if (!axis.available || axis.value === null || axis.value === undefined) return null;
  if (axis.value_kind === 'archetype') return `archetype_id=${axis.value.archetype_id ?? NO_ITEM} · weight=${axis.value.weight ?? NO_ITEM}`
   + ` · distribution_kind=${axis.distribution_kind ?? NO_ITEM}`
   + ((axis.value.label ?? axis.value.archetype_label) ? ` · label=${axis.value.label ?? axis.value.archetype_label}` : '');
  const unit = axis.value_kind === 'spread' ? '相对分极差' : '相对分（0～1 的序数标度）';
  return `${axis.value} · ${unit}`;
}
/** 进度条宽度（只用于展示；值不合法就不画条）。 */
function axisBar(axis) {
  const value = typeof axis?.value === 'number' && Number.isFinite(axis.value) ? axis.value : null;
  if (value === null || axis.value_kind === 'archetype') return '';
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return `<span class="tw-axis-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>`;
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
  // 抽屉里「让小芽说人话」用**宿主页**的教练通道（同一条 /api/coach、同一份记忆）：
  // 这个模块是 shadow DOM 里的纯展示件，不该自己攒一套会话/CSRF。没给就如实说没接上。
  const askCoach = typeof opts.askCoach === 'function' ? opts.askCoach : null;
  let lastPlayer = null;   // 最近一次渲染用的评估结果（小芽按钮读它拼题面）

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
     <!-- R03/半成品施工（2026-09-30，Lead 批准 A）：**针对某个对手**的判断需要一个对手来源 ——
          页面上**原来一个都没有** ⇒ state.evalOpponent 恒 null ⇒ 对手支（克制招/最怕什么/按对手算的强度）
          **永远不出现** ✗。这里只补**来源**本身（纯新增 ✓ 不改「没选对手就如实说」那条支 ✓）。
          ⚠ 速度：页面拿不到（图鉴 「panel.available=false」）⇒ **只给 {name, types}**，速度留空、
           由 team-plan 明写「对手速度未知 ⇒ 不比速度」，**不编默认值** ✓ -->
     <div class="tw-opponent-row">
      <label for="tw-opponent">针对这个对手看：</label>
      <select id="tw-opponent"><option value="">不指定对手（只看结构）</option></select>
     </div>
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
     <!-- ⭐ 2026-09-29（task-8 / Codex 监工 B）：**应用 / 撤销 / 重新读取**这三个动作的落点。
          在这之前它们**没有对象**：阵容只是这一屏的临时状态（地址带过来 / 点出来的），
          "应用"无从谈起、"撤销"没有可退的东西、"重新读取"读回来的是另一回事。
          现在：应用 = 把这六个槽位 × 四个技能写进本机记录 roco.workshop.teamconfig.v1 并当众核对合法性；
          撤销 = 一步退回上一份（与个体的回滚一样：只能退一步）；重新读取 = 不带参数打开这一页时读回来。 -->
     <div class="tw-knobs tw-knobs--right" id="tw-config-knobs">
      <button class="tw-btn" id="tw-plan-build">小芽给一套 6×4</button>
       <button class="tw-btn" id="tw-config-check">核对六只四技能</button>
      <button class="tw-btn" id="tw-config-apply">应用这套配置</button>
      <button class="tw-btn" id="tw-config-undo">撤销上一次应用</button>
     </div>
     <p class="tw-note" id="tw-config-note" role="status" aria-live="polite"></p>
     <!-- 2026-09-29 U04：**6 只 × 4 招**整套配置的预览（默认收起，点「小芽给一套 6×4」才展开）：
          逐格给精灵名 + 四个技能名 + 这一行是哪来的（队里 / 小芽推荐 / 从盒子里补的）；
          紧挨着的「应用这套配置 / 撤销上一次应用」就是它的应用与撤销两个动作。 -->
     <div class="tw-plan" id="tw-plan-box" hidden></div>
     <p class="tw-error" id="tw-config-problems" hidden></p>
     <div class="tw-knobs tw-knobs--right">
      <button class="tw-btn" id="tw-reset">清空阵容</button>
     </div>
    </section>

    <section class="tw-panel tw-cand" aria-labelledby="tw-cand-title">
     <div class="tw-head"><h3 id="tw-cand-title">候选池</h3>
      <span class="tw-sub" id="tw-cand-sub">—</span></div>
     <p class="tw-note tw-scope-note" id="tw-cand-note"></p>
     <div class="tw-cand-tools tw-scope-row">
      <button class="tw-btn" id="tw-scope-mine" aria-pressed="true">我的精灵</button>
      <button class="tw-btn" id="tw-scope-all" aria-pressed="false">全图鉴</button>
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
     <!-- 2026-09-29 U04：队伍已满时点候选 → 这里出现「替换哪只」（不让玩家自己猜先删谁）。
          锁定的那一格在列表里是禁用的：锁定的一只必须留在队里（RC-301 规则⑨）。 -->
     <div class="tw-replace" id="tw-replace-box" hidden></div>
     <div class="tw-cand-list" id="tw-cand-list" role="group" aria-label="从候选池挑一只"></div>
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
    const fit = Math.max(6, Math.min(30, Math.floor(h / 46)));
    if (fit !== state.pool.pageSize) {
      // 人类：**每页条数按页面整体高度决定**（不是让条目高度变来变去）
      state.pool.pageSize = fit;
      state.pool.offset = 0;
      setTimeout(() => { loadPool(); }, 0);   // 布局稳定后再取一次数
    }
  };
  // ⭐ 2026-09-29（task-8 / Codex 监工 B）：**上一次"应用这套配置"留下的那一份**。
  // 优先级：地址显式带过来的（盒子交接）> 本机记录里的 `current` > 空。
  // 为什么地址优先：`?team=` 是玩家**刚刚**在盒子里点的那一下，它比上一次应用更"新"；
  // 而"重新读取"那条路（不带参数打开）走的就是记录里那一份（见 `data-tw-config-*`）。
  const storedConfig = readTeamConfig();
  const urlSelected = Array.isArray(opts.initialSelected)
    ? opts.initialSelected.filter((id) => typeof id === 'string' && /^own-\d+$/.test(id)).slice(0, TEAM_SLOTS)
    : [];
  // RC-801：从盒子带过来的初始选人（`?team=own-…`）。**只认形状对的 id**：
  // 认不出的直接丢掉（不猜、不静默塞一个别的）——多带一只或少带一只都要看得见。
  const initialSelected = urlSelected.length ? urlSelected : (storedConfig.current?.team ?? []).slice(0, TEAM_SLOTS);
  // 从 URL 带过来的**锁定**（`?lock=own-…`）：只认形状对的 id，且**必须在选人里**
  // （服务端会按 RC-301 规则⑨再校验一次：锁一个没入选的实例整条请求会被拒）。
  const urlLocked = Array.isArray(opts.initialLocked)
    ? opts.initialLocked.filter((id) => typeof id === 'string' && /^own-\d+$/.test(id)) : [];
  const initialLocked = (urlLocked.length ? urlLocked : (storedConfig.current?.locked ?? []))
    .filter((id) => initialSelected.includes(id));
  // 换招（2026-09-25）：species_id → 玩家选的四个技能 id。**只存玩家真的选过的**；
  // 没选过的走引擎的规范配招（服务端 `startBattle` 不带 loadouts 时就是这么跑的）。
  //
  // 2026-09-28（人类 ④ 逐字：「换技能还是没实装是吧？实装一下」）：这一份原来是**纯内存**的
  // ⇒ 换完招一刷新就没了（而盒子那一页配的四个又从来不进对局）。现在两边共用
  // `loadout-store.js` 那一把钥匙：开局时先把**上次存下的**读进来（盒子里配的也在里面），
  // 保存时再写回去。
  //
  // 2026-09-30（分计划 08 · S1 / G01）两处改动：
  //   ① **写**：改到**个体级**键（`own-…`，`writeIndividualLoadout`）—— 一个物种一条记录会让
  //      同种的另一只个体把这份配招继承过去（08 反例②）；旧物种级键**只读不删**。
  //   ② **读**：旧的物种级记录仍然读（兼容），但**队里每一只个体**自己的记录优先 ——
  //      由 `teamLoadouts()` 一处判定（个体级优先），本文件不自己判。
  const loadouts = new Map(readSharedLoadouts());
  // ⭐ 「应用这套配置」里的技能那一半也要能**重新读取**：记录里的 current 对**这一队的物种**是权威 ——
  //    有就盖过共用记录；没有就是"玩家没配过"，走引擎规范配招（所以先把这几个键删掉，
  //    免得共用记录里上一次应用写下的那一份在撤销之后又冒出来）。
  if (storedConfig.current) {
    for (const speciesId of storedConfig.current.species) {
      if (speciesId && !(speciesId in (storedConfig.current.loadouts ?? {}))) loadouts.delete(speciesId);
    }
    for (const [speciesId, ids] of Object.entries(storedConfig.current.loadouts ?? {})) {
      if (Array.isArray(ids) && ids.length === SHARED_LOADOUT_SLOTS) loadouts.set(speciesId, ids.slice());
    }
  }
  /** 技能 id → 名字：读过学习表就记下来。标签里要显示**名字**（显示 id 等于让玩家读内部串）。 */
  const skillNames = new Map();

  /**
   * 这个物种**在队里**的那一只实例（S1：个体级记录要用它当键）。
   *
   * 同一个物种在队里不可能有两只（RC-301 判 `DUPLICATE_SPECIES_IN_TEAM`）⇒ 这个解析唯一。
   * 找不到就回 `null` —— 那时**不写**任何记录（宁可不写，也不写一条物种级的去污染同种的另一只）。
   */
  function instanceForSpecies(speciesId) {
    if (!speciesId) return null;
    return state.selected.find((id) => (state.ownedByInstance.get(id)?.speciesId ?? null) === speciesId) ?? null;
  }

  /**
   * 把**队里每一只个体**的个体级记录叠到内存 Map 上（个体级优先于旧物种级）。
   *
   * 为什么要在 `load()` 之后再叠：`ownedByInstance`（实例 → 物种）是那一步才有的；
   * 在那之前叠等于把六只都解析成"没有物种"。这也正是"读侧兼容"的落点：
   * 旧物种级记录仍然在 Map 里（`readSharedLoadouts()` 读进来的），只有这一只**自己**
   * 有记录时才盖掉它。
   */
  function overlayIndividualLoadouts() {
    if (!state.ownedByInstance || !state.ownedByInstance.size) return;
    const members = state.selected.map((id) => ({
      instance: id, species: state.ownedByInstance.get(id)?.speciesId ?? null,
    }));
    const resolved = teamLoadouts(null, members);
    for (const [speciesId, ids] of Object.entries(resolved.loadouts)) {
      loadouts.set(speciesId, ids.slice());
    }
    state.loadoutSources = resolved.sources;
  }
  /** 引擎给每只的学习表：`species → 技能 id 数组`（读过才在；没读过是 undefined，**不假装查过**）。 */
  const learnableBySpecies = new Map();
  /** 正在编辑哪一只 + 它的可学池（`/api/roco/loadout/options` 的回执）+ 草稿。 */
  let editor = null;
  const state = {
    selected: initialSelected.slice(),
    locked: initialLocked.slice(),
    /** 「应用这套配置」那一步的状态：`none | unsaved | applied | invalid`（渲染与判据共用一份）。 */
    config: {state: storedConfig.current && !urlSelected.length ? 'applied' : 'unsaved',
      applied: storedConfig.current, previous: storedConfig.current ? storedConfig.previous : null,
      problems: [], checked: false, reason: ''},
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
    // ⚠ 2026-09-29 U04 改钉：默认档从 `catalog`（全图鉴）改成 **`mine`（我的精灵）**。
    // 用户投诉的原话是「配队全是 ID 和工程文字」，其中一半来自默认落在全图鉴那一档：
    // 一屏 600+ 物种里大半是**你没有的**，跟「能不能上场」混在一起分不清。
    // 现在默认只给**你拥有的**（能直接进正式队伍的那些），切「全图鉴」是玩家**显式**的一个动作；
    // 两档在视觉上分开（见 `.tw-row--owned` / `.tw-row--ref` 与范围说明那一行）。
    pool: {offset: 0, total: 0, pageSize: 12, q: '', kind: 'mine', type: '', role: '', rows: []},
    poolSeq: 0,
    /** 全图鉴的物种总数（候选宇宙）。**与「本档条数」分开记**：默认档是我的精灵（几十只），
     *  但「候选来自全图鉴」这句话里的那个数必须是候选宇宙的真实大小 —— 不拿本档条数冒充。 */
    poolUniverse: 0,
    /** 队伍已满时点候选的那只（先弹「替换哪只」，不让玩家自己猜先删谁）。 */
    replaceIncoming: null,
    /** 槽位卡上点了「替换」要换下来的那个个体（点候选池里的一只就换上它）。 */
    replaceArm: null,
    /** 6 只 × 4 招整套配置的预览（点「小芽给一套 6×4」才建）。 */
    plan: null,
    ownedBySpecies: new Map(),      // 物种 → [{select: 个体, name, ...}]
    ownedByInstance: new Map(),     // 个体 → {speciesId, name}
    ambiguousNames: new Set(),      // 持有名单里重名的名字（不猜是哪一只，但知道「你有」）
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
    // 2026-09-26：首层那行「机制线索」固定两行、超出省略号（卡与卡等高），
    // 所以**全文必须在这里逐字给一份** —— 详情是玩家读全文的那一处，不许有信息只存在被裁掉的那半行里。
    const tags = mechanismTagsOf(mechanism);
    const tagsRow = tags.length ? `<div>机制线索：${escapeHtml(tags.join(' · '))}</div>` : '';
    if (!line) return `<div>机制：机制资料待确认（登记层没有这一只的冻结原文）</div>${tagsRow}`;
    return `<div>机制原文：${escapeHtml(line)}</div>${tagsRow}`;
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

  /** 槽位 → 物种 id（公开层不带 id；按名字在持有名单里**唯一**匹配，重名不猜）。 */
  function speciesOfSlot(slot) {
    const direct = typeof slot?.species_id === 'string' && slot.species_id ? slot.species_id : null;
    if (direct) return direct;
    const name = typeof slot?.name === 'string' ? slot.name : '';
    return name ? (state.speciesByName?.get(name) ?? null) : null;
  }

  /** 只重画队伍与理论阵容两块 —— 换招那几处状态变化只影响它们。
   *  （本模块没有全局 `render()`；第 1393 行那处局部重画用的就是这两个调用。） */
  function refreshSlots() {
    renderTeam(state.payload?.player ?? {});
    renderAnalysis(state.payload?.player ?? {});
  }

  /** 一只精灵当前带着的四个技能（玩家选过就是玩家的，否则是引擎规范配招）。 */
  function loadoutOf(slot) {
    // 键必须是**解析出来的物种 id**（与保存时同一把钥匙）；用 `slot.species_id` 会永远读不回来。
    const chosen = loadouts.get(speciesOfSlot(slot) ?? '');
    const skills = Array.isArray(slot.skills) ? slot.skills : [];
    // ⚠ 2026-09-29 U04：技能**名字**必须从这一格自己的 `slot.skills` 里取（服务端发的是
    // `{skill_id,name}`，见 `workshopPlayerMembers`）；`skillNames` 只有玩家点过换招才会被填。
    // 原来这一行只查 `skillNames`，于是首屏四个技能印出来全是 `skill_000418` 这种内部串
    // （实测 6 格 × 4 = 24 处）——玩家投诉的「配队全是 ID」有一半来自这里。
    const byId = new Map(skills.filter((s) => s?.skill_id).map((s) => [s.skill_id, s]));
    const nameOf = (id) => byId.get(id)?.name ?? skillNames.get(id) ?? null;
    if (chosen && chosen.length === 4) {
      const names = chosen.map(nameOf);
      return {source: 'player', ids: chosen.slice(), names,
        label: names.filter(Boolean).join('、')};
    }
    const ids = skills.map((s) => s.skill_id).filter(Boolean);
    const names = skills.map((s) => s.name ?? null);
    return {source: 'engine', ids, names, label: names.filter(Boolean).join('、')};
  }

  /**
   * 槽位卡里那一行：配招入口 + 当前带的是哪四个。
   *
   * 2026-09-26（玩家可见缺陷：六张卡结构不一致）—— 这一行原来在「拿不到可核验学习表」时
   * **整行不渲染**（`return ''`），于是同一队里有的卡有这一行、有的没有，卡片高矮都不一样
   * （截图里第 4～6 张比前三张矮一截，缺的正是这一行）。两条成因都真实存在：
   *   · 图鉴 / 按需推算的物种本来就没有可核验的学习表；
   *   · 持有名单里**重名**的物种（实测「棋契陛下」= own-0042/pet_000556 与 own-0043/pet_000575）
   *     在 `speciesByName` 里被当作「不猜」删掉 → `speciesOfSlot()` 回 null，即使它是你拥有的。
   * 现在**六张卡这一行永远都在**：解析得出物种就给可点的按钮；解析不出就给一个**禁用**按钮 +
   * 一句为什么，玩家看到的始终是同一张版式 —— 「这一只不能换招」是信息，不该长得像「这张卡坏了」。
   * 为什么选「都带」而不是「都不带」：换招是这一页唯一能改配招的入口（人类 2026-09-25
   * 「配招这个你得修好」），六张卡里抽掉三张的入口，等于让玩家以为那三只不能换招。
   */
  function loadoutRowHtml(slot) {
    const species = speciesOfSlot(slot);
    const held = Boolean(species) && state.ownedBySpecies.has(species);
    const current = loadoutOf(slot);
    if (!held || !species) {
      // 说清「为什么不能换」：重名不猜 / 图鉴物种没有可核验的学习表 —— 两种都如实写出来。
      const why = species
        ? '图鉴物种没有可核验的学习表，换招只对盒子里的精灵开放'
        : '这个名字在你盒子里不唯一，页面不替你猜是哪一只';
      return `<div class="tw-meta tw-loadout" data-tw-loadout-state="unavailable">
        <button class="tw-btn tw-loadout-btn" type="button" disabled
          aria-label="换招：${escapeHtml(why)}">换招</button>
        <span class="tw-meta" title="${escapeHtml(why)}">${escapeHtml(why)}</span>
       </div>`;
    }
    const open = editor && editor.species === species;
    // ⚠ 2026-09-29 U04 改：首层**不再印「引擎规范配招：…」这种工程说法**，也不再印成一行省略号。
    // 四个技能各自一个小格（2×2），玩家第一眼就能扫到四个名字；「这四个是哪来的」缩成一个
    // 小标（默认 / 你选的）—— 事实一个字没少，只是不再用内部叫法。技能号留在
    // `data-tw-skill` 属性上（判据与小芽读它，页面上不显示）。
    const chips = Array.from({length: SHARED_LOADOUT_SLOTS}, (_, at) => {
      const id = current.ids[at] ?? null;
      const name = id ? (current.names[at] ?? skillNames.get(id) ?? null) : null;
      if (!id) return `<span class="tw-skill" data-tw-skill-state="missing">第 ${at + 1} 招未定</span>`;
      return `<span class="tw-skill" data-tw-skill="${escapeAttr(id)}"
        title="${escapeAttr(name ?? '名字未登记')}">${escapeHtml(name ?? '名字未登记')}</span>`;
    }).join('');
    const instance = instanceOfSlot(slot) ?? '';
    const locked = slotLocked(slot);
    const srcTitle = current.source === 'player'
      ? '这四个是你自己点「换招」选的'
      : '这四个是引擎给这一只的默认配招（你还没换过招）';
    return `<div class="tw-meta tw-loadout tw-loadout-stack" data-tw-loadout-row="yes">
      <div class="tw-skills-head">
       <span class="tw-meta">四个技能</span>
       <span class="tw-skills-src" title="${escapeAttr(srcTitle)}">${current.source === 'player' ? '你选的' : '默认'}</span>
      </div>
      <div class="tw-skills" data-tw-skills="${escapeAttr(current.ids.join(','))}">${chips}</div>
      <div class="tw-slot-actions">
       <button class="tw-btn tw-loadout-btn" data-tw-loadout="${escapeHtml(species)}"
         aria-expanded="${open ? 'true' : 'false'}">${open ? '收起换招' : '换招'}</button>
       <button class="tw-btn tw-slot-replace-btn" data-tw-replace-slot="${escapeHtml(species)}"
         ${locked ? 'disabled' : ''} aria-expanded="${state.replaceArm === instance && Boolean(instance) ? 'true' : 'false'}"
         title="${locked ? '这一只是锁定带过来的：锁定的一只必须留在队伍里，不能替换'
    : '把这一只换下来：点一下，再去右边候选池点一只换上'}">替换</button>
      </div>
     </div>${open ? loadoutEditorHtml(current) : ''}`;
  }

  /**
   * ⭐ 一行**合法性**（task-8：六只各四个技能都合法，不合法要说清哪一只哪一格为什么）。
   *
   * 判据的来源与优先级写清楚：
   *   · 四个技能 = `loadoutOf(slot).ids`（玩家选过就是玩家的，否则是引擎规范配招）——
   *     与 `emit()` 交给开局的 `loadouts` **同一处**，所以这一行说的就是"会进对局的那四个"；
   *   · 学习表 = `/api/roco/loadout/options?pet=<持有实例>` 的 `learnable`（`learnableBySpecies`）；
   *   · **没查过就不说合法**（`data-tw-slot-legality="unknown"`）——"查过才说合法"。
   * 玩家看的是技能**名字**；查不到名字才退回 id（不编一个名字出来）。
   */
  function legalityRowHtml(slot, species) {
    // ⚠ 按物种解析"这一格是哪个个体"（见 `instanceOfSlot` 的注释：服务端槽位顺序与 selected 无关）。
    const instance = instanceOfSlot(slot) ?? '';
    const skills = loadoutOf(slot).ids.slice(0, 4);
    const bad = slotLegalityProblems({skills, learnable: species ? learnableBySpecies.get(species) ?? null : null});
    const stateName = !skills.length ? 'none'
      : (bad.some((p) => p.kind === 'unknown') ? 'unknown' : (bad.length ? 'illegal' : 'ok'));
    const nameOf = (id) => {
      // 名字优先从**这一格自己的** `slot.skills` 取（服务端发 `{skill_id,name}`）；
      // `skillNames` 只是玩家点过换招之后的缓存。都拿不到才退回技能号 —— 不编一个名字出来。
      const own = (Array.isArray(slot.skills) ? slot.skills : []).find((s) => s?.skill_id === id);
      return own?.name ?? skillNames.get(id) ?? id;
    };
    const four = skills.map(nameOf).join('、') || '（引擎没给技能）';
    const line = stateName === 'ok'
      ? `四个技能都在引擎学习表里：${four}`
      : (stateName === 'unknown'
        ? `四个技能：${four} —— 还没核对学习表（点「核对六只四技能」）`
        : (stateName === 'none'
          ? '四个技能：引擎这一只还没给可学技能'
          : `四个技能有问题：${bad.map((p) => p.text.replace(/「[^」]*」/g, (m) => m)).join('；')}`));
    return `<div class="tw-meta tw-legality" data-tw-slot-legality="${stateName}"
      data-tw-slot-skills="${escapeHtml(skills.join(','))}" data-tw-slot-legal-instance="${escapeHtml(instance)}">
      ${escapeHtml(line)}</div>`;
  }

  /**
   * ⭐ 2026-09-29 U04：每张卡的**诊断详情**（默认收起）。
   *
   * 这一块就是「工程词搬家」的落点 —— 构建档原文（含「算得出高低」这种括注）、机制标签、
   * 学习表的核对状态、来源、机制原文、四个技能的逐条明细，**一个字都没删**，
   * 只是不再占着玩家第一眼的那一层（玩家投诉：「配队全是 ID 和工程文字」）。
   * 六张卡都有这一块（结构一致），`<details>` 不带 `open` ⇒ 默认收起。
   */
  function diagnosticsHtml(slot, species) {
    return `<details class="tw-detail tw-diag" data-tw-diag="slot">
     <summary>诊断详情（构建 / 机制 / 学习表核对）</summary>
     <div class="tw-detail-body">
      ${slot.build_tier_label ? `<div>构建档：${escapeHtml(slot.build_tier_label)}</div>` : ''}
      ${slot.source_note ? `<div>来源：${escapeHtml(slot.source_note)}</div>` : ''}
      ${legalityRowHtml(slot, species)}
      <!-- ⭐ 2026-09-29（task-8 的性格/资质那一条）：**界面写清引擎按什么算**。
           Lead 已查实（三条，我复核过同一条链）：战斗面板 = env.py 的 _data.panel_stats(pet.stats)，
           panel_stats(race_stats) 是只吃**种族值**的纯函数；引擎里没有 nature/talent 这两个概念；
           battle_new 的 team 是物种 id 数组，没有承载个体的字段。
           ⇒ 这一页上的性格/资质/天分**不进引擎**，也没有已登记的换算公式可接。
           所以这里如实写出来 —— 不为了好看把它标成"已贯通"。 -->
      <div>面板怎么算：引擎按<strong>种族值</strong>算（本局用它）。性格 / 资质（个体值）目前<strong>不进引擎</strong>：
       引擎里没有这两个概念，本仓也还没有已登记的换算公式 —— 所以这一页不把它们说成已生效。</div>
      ${mechanismDetailHtml(slot.mechanism)}
      ${skillsHtml(slot)}
     </div></details>`;
  }

  /** 换招编辑器：可学池（`/api/roco/loadout/options`）里选四个。 */
  function loadoutEditorHtml(current) {
    if (!editor) return '';
    if (editor.loading) return '<div class="tw-loadout-body tw-meta">正在读这一只的学习表…</div>';
    if (editor.error) {
      return `<div class="tw-loadout-body"><div class="tw-meta">换招读不到学习表：${escapeHtml(editor.error)}</div>
        <button class="tw-btn" data-tw-loadout-cancel="1">收起</button></div>`;
    }
    const pool = Array.isArray(editor.pool) ? editor.pool : [];
    if (!pool.length) return '<div class="tw-loadout-body tw-meta">这一只的学习表是空的（引擎没给可学技能）</div>';
    const picks = editor.draft;
    const chips = pool.map((skill) => {
      const on = picks.includes(skill.skill_id);
      const bits = [skill.element, Number.isFinite(skill.energy) ? `能耗 ${skill.energy}` : null,
        Number.isFinite(skill.power) ? `威力 ${skill.power}` : null].filter(Boolean).join(' · ');
      const sources = Array.isArray(skill.sources) ? skill.sources.join('/') : '';
      return `<button class="tw-btn tw-skill-chip" data-tw-pick="${escapeHtml(skill.skill_id)}"
        aria-pressed="${on ? 'true' : 'false'}" title="${escapeHtml(sources)}">
        ${escapeHtml(skill.name ?? skill.skill_id)}${bits ? `<span class="tw-meta"> ${escapeHtml(bits)}</span>` : ''}</button>`;
    }).join('');
    return `<div class="tw-loadout-body" data-tw-loadout-for="${escapeHtml(editor.petId ?? '')}"
      data-tw-loadout-via="${escapeHtml(editor.via ?? '')}">
      <div class="tw-meta">${escapeHtml(loadoutOwnerLabel())}，带 4 个（已选 ${picks.length}/4）。
来源：引擎学习表（原生 / 血脉 / 技能石），不排优先级 —— 游戏数据里没有梯次或胜率数据。</div>
      <div class="tw-skill-pool">${chips}</div>
      <div class="tw-meta">开局时交给引擎校验：学不到的组合会被拒（不是这一层说了算）。</div>
      <button class="tw-btn" data-tw-loadout-save="1" ${picks.length === 4 ? '' : 'disabled'}>保存这四个</button>
      <button class="tw-btn" data-tw-loadout-cancel="1">放弃</button>
     </div>`;
  }

  /**
   * 打开换招：读这一只的**可学池**（`/api/roco/loadout/options`，GET、只读、公开）。
   * 已有选择就用它当草稿；否则用当前带着的那四个（引擎规范配招）当草稿 —— 换招是"改"，
   * 起点必须是**它现在带的**，不能凭空给一套。
   */
  async function openLoadout(species, slot) {
    const current = loadoutOf(slot);
    // **拿不准就去查**（人类 2026-09-25 口径）：优先拿**持有实例 id** 去问服务端，
    // 由引擎把实例解析成物种（`resolveBattleTeamIds`），而不是靠页面按名字猜。
    // 名字只是页面手上的东西；引擎回执里的 `pet_id` 才是"这份学习表属于哪一只"的证据。
    const rows = state.ownedBySpecies?.get(species) ?? [];
    const instance = rows.find((row) => typeof row?.select === 'string' && row.select)?.select ?? null;
    editor = {species, petId: null, petName: slot?.name ?? null, pool: null,
      draft: current.ids.slice(0, 4), loading: true, error: null, via: instance ? 'instance' : 'species'};
    refreshSlots();
    try {
      const query = instance ? `pet=${encodeURIComponent(instance)}` : `pet=${encodeURIComponent(species)}`;
      const response = await fetch(`/api/roco/loadout/options?${query}`);
      const data = await response.json();
      if (!response.ok || data?.ok !== true) throw new Error(data?.error || `HTTP ${response.status}`);
      for (const skill of data.learnable ?? []) {
        if (skill?.skill_id && skill.name) skillNames.set(skill.skill_id, skill.name);
      }
      if (editor && editor.species === species) {
        // 引擎回的 `pet_id` 必须与页面解析出的物种一致 —— 不一致就**如实记下来**
        // （`data-tw-loadout-mismatch=yes`，判据会读它），并且**以引擎的为准**当键。
        const mismatch = typeof data.pet_id === 'string' && data.pet_id && data.pet_id !== species;
        rootEl.dataset.twLoadoutMismatch = mismatch ? 'yes' : 'no';
        editor = {...editor, loading: false, pool: data.learnable ?? [], petId: data.pet_id ?? null};
      }
    } catch (error) {
      if (editor && editor.species === species) {
        editor = {...editor, loading: false, error: String(error?.message || error)};
      }
    }
    refreshSlots();
  }

  /** 编辑器标题：**把这份学习表属于哪一只写在脸上**（玩家要能看出"对准了没有"）。 */
  function loadoutOwnerLabel() {
    const who = editor?.petName ? `${editor.petName}` : '这一只';
    const via = editor?.via === 'instance' ? '（按你盒子里的那只查的）' : '';
    return `${who} 学得到 ${(editor?.pool ?? []).length} 个技能${via}`;
  }

  /** 保存：只接受**恰好四个**（服务端也按四个校验，这里先挡住明显不对的）。 */
  function saveLoadout() {
    if (!editor || editor.draft.length !== 4) return;
    // 键必须是**引擎回执里的 pet_id**（"这份学习表属于哪一只"的唯一证据），
    // 页面按名字解析出的 species 只用来找入口 —— 两者不一致时以引擎为准。
    loadouts.set(editor.petId ?? editor.species, editor.draft.slice());
    // 写回共用记录（`loadout-store.js`）：不写回去的话，换完招一刷新就丢，
    // 盒子那一页也读不到（人类 ④：「换技能还是没实装是吧？实装一下」）。
    // S1（G01）：写的是**个体级**键（这一队的哪一只实例）—— 写物种级会让同种的另一只继承。
    // 找不到实例（理论上不该发生：编辑器是从槽位开的）就**不写**，只留在内存里当次生效。
    // 写失败不拦着这一步 —— 当次开局照样带着这四个（`emit()` 走的是上面那个 Map）。
    const target = instanceForSpecies(editor.petId ?? editor.species);
    if (target) writeIndividualLoadout(null, target, editor.draft.slice());
    editor = null;
    refreshSlots();
    // ⚠ 2026-09-29 U04（真机探针抓到）：换完招**必须重画配置那一行** —— 否则状态行还停在
    // 「已应用」，而屏幕上的这套已经和"应用过的那一份"不一样了（`data-tw-config-current` 也是旧值）。
    // 这一行本身就是"屏幕上的这一套 == 开局那一套"这句承诺的读数口，它不许滞后。
    renderConfig();
    emit();          // 队伍一变就派发：主线程当次开局就带着这四个
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
        // 六张卡等高（CSS 的 grid-auto-rows:minmax(min-content,1fr)，卡内每一行定高），选前选后不跳。
        // 2026-09-26（玩家可见缺陷）：这里原来用 `slot.species_id` 判「是不是我持有的」，
        // 而**公开层按架构约束不许带 species_id**（见 tests/roco-loadout-ui.test.js ①）——
        // 于是这一判**恒为假**：六只全是你盒子里的，卡片却全被标成「图鉴 · 按需推算（未核验）」。
        // 物种只能由页面按名字**唯一**匹配解析，与 loadoutRowHtml() 用同一个 `speciesOfSlot()`
        // （两处必须同源：一个说「持有」、另一个说「图鉴物种不能换招」就自相矛盾了）。
        const species = speciesOfSlot(slot);
        const held = Boolean(species) && state.ownedBySpecies.has(species);
        // 名字在持有名单里重名的（实测「棋契陛下」两只）：物种解析不出来，但它**是你盒子里的**。
        // 标成「图鉴 · 按需推算」会把玩家的东西说成图鉴条目 —— 给一档更短的说法，字号/行数不变。
        const sameNameHeld = !held && state.ambiguousNames?.has(String(slot.name ?? ''));
        // ⚠ 2026-09-29 U04 改钉：这个状态标原来写的是「持有 · 可正式上场」（玩家投诉里的
        // 「可正式上场 ×13」就是它）。**含义一个字没动**（这是你拥有的、能进正式队伍），
        // 只是换成玩家语：「持有 · 可出战」。判据读的是 `/持有|可正式上场/`（改钉不删）。
        const tag = held
          ? '<span class="tw-state-tag tw-state-held">持有 · 可出战</span>'
          : (sameNameHeld
            ? '<span class="tw-state-tag tw-state-held">持有 · 名字重复</span>'
            : '<span class="tw-state-tag tw-state-trial">图鉴 · 按需推算（未核验）</span>');
        // ⚠ 2026-09-29 新增 `data-tw-slot-instance`（队友 coach-context 报的**精确缺口**：
        // 「配队六槽接不进小芽 —— 槽位 DOM 上没有"这一格是哪个个体"的钩子，只有 `data-tw-slot` 序号 + 名字」）。
        // 为什么需要它：小芽要回答"我队伍里这一只的性格是什么"，就必须知道**装进这一格的那个个体 id**
        // （`own-XXXX`），而不是按名字去猜物种 —— 重名的时候猜不了（实测「棋契陛下」就有两只）。
        // ⚠⚠ 2026-09-29 **改钉**（task-8 真机实测 + art-finish D① 报的同一处）：
        // 原来这里是 `state.selected[slot.index - 1]`，注释还写着"顺序与移除按钮同一个来源"——
        // 那句话**是错的**：服务端回的槽位顺序与 `state.selected` 无关（实测两条不同的 selected 地址
        // 回同一份槽位顺序）⇒ 第 1 格写着「喵喵」而 `data-tw-slot-instance` 是 `own-0004`（迪莫），
        // 六格全错位；「移除第 N 格」也跟着移错人。现在两边都按**物种**解析：
        // 钩子给的是"这一格里那只的个体 id"，移除按钮带的是"这一格那只的物种"。
        const slotInstance = instanceOfSlot(slot);
        // 定位（角色）：与候选行**同一份数据** —— `/api/roco/box?kind=mine` 的卡上就有 `role_label`，
        // 在 `loadOwnedIndex()` 里随个体一起记下来。拿不到就**不写这一栏**，不编一个定位。
        const role = slotInstance ? (state.ownedByInstance.get(slotInstance)?.role_label ?? null) : null;
        const locked = slotLocked(slot);
        return `<article class="tw-slot on" role="listitem" data-tw-slot="${slot.index}"
          data-tw-slot-instance="${escapeAttr(slotInstance ?? '')}"
          data-tw-slot-species="${escapeAttr(species ?? '')}"
          data-tw-slot-name="${escapeAttr(slot.name ?? '')}"
          data-tw-slot-role="${escapeAttr(role ?? '')}"
          ${state.replaceArm && slotInstance && state.replaceArm === slotInstance
    ? 'data-tw-replace-armed="yes"' : ''}
          data-tw-state="filled" data-tw-fieldable="${held || sameNameHeld ? 'yes' : 'no'}">
         <div class="tw-row">${twArtHtml({group: species, art: state.artBySpecies?.get?.(String(species ?? '')) === true}, {size: 32})}<span class="tw-who">${escapeHtml(slot.name ?? NO_ITEM)}</span>
          ${locked ? '<span class="tw-lock">锁定</span>' : ''}
          <button class="tw-slot-remove" data-tw-remove-slot="${escapeAttr(species ?? '')}"
            ${locked ? 'disabled' : ''}
            aria-label="${locked ? '锁定的这一只不能移除：它必须留在队伍里'
    : '把这一只从队伍里移除'}">移除</button></div>
         <div class="tw-meta"><span class="tw-types">${teamSlugs(slot.types) || '系别未登记'}</span>
          ${role ? `<span class="tw-role">定位 · ${escapeHtml(role)}</span>` : ''}
          ${tag}</div>
         <div class="tw-meta">${escapeHtml(buildTierPlain(slot.build_tier_label))}</div>
         ${mechanismRow(slot.mechanism, {tags: false})}
         ${loadoutRowHtml(slot)}
         ${diagnosticsHtml(slot, species)}
        </article>`;
      }
      return `<article class="tw-slot" role="listitem" data-tw-slot="${slot.index}" data-tw-state="empty">
        <div class="tw-meta">第 ${slot.index} 槽位（空）</div>
        <div class="tw-meta">${escapeHtml(slot.empty_hint ?? '')}</div>
       </article>`;
    }).join('');
    const filled = slots.filter((slot) => slot.state === 'filled').length;
    $('tw-team-sub').textContent = filled >= TEAM_SLOTS ? '六个槽位都满了' : `还差 ${TEAM_SLOTS - filled} 只`;
    // 2026-09-25（死代码清理，实测口径见下）：这里原来有 4 处写向**从来没被渲染过**的 id ——
    // `#tw-team-note`、`#tw-team-constraints`（两处）、`#tw-badge-universe`。
    // 真无头 Chrome 里逐态枚举 shadow root 的真实 id 集合（0 只 / 2 只 / 满六只 / 评估抽屉打开 /
    // 所有 details 展开，共 29→32 个 id）**每一次都没有这四个**，所以它们只是 null 守卫空转：
    //   · `structure_note` 的真落点在评估区（本文件 `renderEval` 那一行 `<p class="tw-note">`），没有丢；
    //   · `constraints` 是服务端 `player.constraints`，本模块从来没有落点渲染过它；
    //   · 模式/候选规则/对手未知三个徽记由页头承担（`roco.html`），模块内不重复一份。
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

  // ── 替换流程（U04 第 3 条）与「6 只 × 4 招」整套配置（第 5 条）────────────────

  /** 个体 id → 玩家看得见的名字。拿不到就给一句人话，**绝不把 id 印到页面上**。 */
  function displayNameOf(instance) {
    return state.ownedByInstance.get(instance)?.name
      ?? (state.payload?.player?.slots ?? []).find((s) => instanceOfSlot(s) === instance)?.name
      ?? '这一只';
  }

  /**
   * 这一格现在**能不能动**（移除 / 替换）：两个来源合起来判，一处判完三处共用。
   *
   *   · `state.locked`（地址 `?lock=` 或上一次应用带下来的）—— 服务端 RC-301 规则⑨：
   *     锁定的实例必须留在队里，否则整条开局请求被拒；
   *   · `slot.locked`（**产物里自带的**个体属性：玩家在游戏里锁了它）—— 卡片上已经写着
   *     「锁定」，那这一格的两个动作就不能再给。
   * ⚠ 真机上抓到过不一致：卡上写着「锁定」而「替换」还是可点的（判据读到 replaceDisabled=false）。
   * 所以「锁定」只有一个判据，`移除` / `替换` / 替换列表三处都读它。
   */
  function slotLocked(slot) {
    if (slot?.locked === true) return true;
    const instance = instanceOfSlot(slot);
    return Boolean(instance) && state.locked.includes(instance);
  }

  /**
   * ⭐ 2026-09-29 U04 第 3 条：**队伍已满时点候选 → 先问「替换哪只」**。
   *
   * 改之前那一下是：`state.error = '持有队伍最多 6 只：先拿掉一只再加。'` + 一行红字 ——
   * 玩家得自己回去找哪一格可以不要、还要先点「移除」再回来点候选（两步，且没人告诉他该拿掉谁）。
   * 现在：六个槽位在这里逐个列出来（锁定那一格**禁用**并写明为什么），点一只就换上去。
   */
  function renderReplaceBox() {
    const box = $('tw-replace-box');
    if (!box) return;
    const inc = state.replaceIncoming;
    const arm = state.replaceArm;
    if (!inc && !arm) {
      box.hidden = true;
      box.innerHTML = '';
      rootEl.dataset.twReplaceState = 'none';
      delete rootEl.dataset.twReplaceIncoming;
      return;
    }
    // ⚠ 标记里写死了 `hidden`（默认不占位）⇒ 这里必须**显式取消它**，否则整块永远不显示
    // （第一版漏了这一行：DOM 里有内容、dataset 也对，但玩家一格都看不到 —— 真机探针抓到的）。
    box.hidden = false;
    const slots = (state.payload?.player?.slots ?? []).filter((s) => s.state === 'filled');
    if (inc) {
      box.innerHTML = `<h4>替换哪只？</h4>
       <p class="tw-note">要把「${escapeHtml(displayNameOf(inc.instance))}」换上去。点一只换下来的 ——
        锁定的那些不能换（锁定的一只必须留在队伍里）。</p>
       <div class="tw-replace-list">${slots.map((s) => {
    const inst = instanceOfSlot(s) ?? '';
    const isLocked = slotLocked(s);
    return `<button class="tw-btn" data-tw-replace-target="${escapeAttr(inst)}" ${isLocked ? 'disabled' : ''}
        aria-label="${escapeAttr(`${isLocked ? '锁定，不能换：' : '换下：'}${s.name ?? ''}`)}">
        ${escapeHtml(s.name ?? NO_ITEM)}<span class="tw-meta">${isLocked ? '锁定 · 不能换' : '换下这只'}</span></button>`;
  }).join('')}</div>
       <div class="tw-knobs tw-knobs--right"><button class="tw-btn" data-tw-replace-cancel="1">取消</button></div>`;
      rootEl.dataset.twReplaceState = 'choosing';
      rootEl.dataset.twReplaceIncoming = inc.instance;
      rootEl.dataset.twReplaceChoices = String(slots.length);
      return;
    }
    box.innerHTML = `<h4>要从队伍里换下「${escapeHtml(displayNameOf(arm))}」</h4>
     <p class="tw-note">现在到右边候选池点一只换上（再点一次那一格的「替换」就取消）。</p>
     <div class="tw-knobs tw-knobs--right"><button class="tw-btn" data-tw-replace-cancel="1">取消</button></div>`;
    rootEl.dataset.twReplaceState = 'armed';
    delete rootEl.dataset.twReplaceIncoming;
    rootEl.dataset.twReplaceChoices = '0';
  }

  /** 真正换人：把 target 换下、incoming 换上。锁定的那一格一律拒绝（服务端也会拒整条请求）。 */
  async function replaceSlot(targetInstance, incomingInstance) {
    if (!targetInstance || !incomingInstance) return false;
    const targetSlot = (state.payload?.player?.slots ?? [])
      .find((s) => instanceOfSlot(s) === targetInstance) ?? null;
    if (slotLocked(targetSlot) || state.locked.includes(targetInstance)) {
      setPickNote(`「${displayNameOf(targetInstance)}」是锁定带过来的：锁定的一只必须留在队伍里`
        + '（拿掉它整条开局请求都会被拒）。换一只吧。');
      return false;
    }
    if (!state.selected.includes(targetInstance)) {
      setPickNote('那一格现在已经不在队里了：重新点一次候选，再来一次。');
      return false;
    }
    if (state.selected.includes(incomingInstance)) {
      setPickNote(`「${displayNameOf(incomingInstance)}」已经在队里了：换一只吧。`);
      return false;
    }
    state.selected = state.selected.map((id) => (id === targetInstance ? incomingInstance : id));
    state.replaceIncoming = null;
    state.replaceArm = null;
    state.error = null;
    state.config.reason = '';
    setPickNote(`换上了「${displayNameOf(incomingInstance)}」，换下的是「${displayNameOf(targetInstance)}」。`);
    renderReplaceBox();
    await reload();
    return true;
  }

  /** 这一只（物种）带哪四个技能：**玩家选的 > 引擎给这一只的四个 > 盒子详情里它自己带着的四个**。
   *  三条路都是真实数据；一条都拿不到就如实回空（预览里写「还没有四个技能」，不编四个出来）。 */
  async function fourSkillsFor(species, instance) {
    const chosen = loadouts.get(species);
    if (Array.isArray(chosen) && chosen.length === SHARED_LOADOUT_SLOTS) {
      return {source: 'player',
        skills: chosen.map((id) => ({skill_id: id, name: skillNames.get(id) ?? null}))};
    }
    const slot = (state.payload?.player?.slots ?? []).find((s) => speciesOfSlot(s) === species);
    if (slot && Array.isArray(slot.skills) && slot.skills.length) {
      return {source: 'engine', skills: slot.skills.slice(0, SHARED_LOADOUT_SLOTS)
        .map((s) => ({skill_id: s.skill_id, name: s.name ?? null}))};
    }
    if (instance && /^own-\d+$/.test(instance)) {
      try {
        const one = await getJson(`${apiBase}/box?detail=${encodeURIComponent(instance)}`);
        const rows = Array.isArray(one?.player?.skills) ? one.player.skills : [];
        for (const row of rows) if (row?.skill_id && row.name) skillNames.set(row.skill_id, row.name);
        if (rows.length) {
          return {source: 'engine', skills: rows.slice(0, SHARED_LOADOUT_SLOTS)
            .map((s) => ({skill_id: s.skill_id, name: s.name ?? null}))};
        }
      } catch { /* 读不到就如实留空 */ }
    }
    // ⭐ R02（2026-09-29）：**按判断层选四招**。
    //
    // 为什么要有这一条：原来的兜底是「这一只自己带着的那四个」，而那是**引擎的规范配招**，
    // 不是为这套阵容选的。README 的原话是「推荐有合法招式并不等于好用」。
    // 这里改成：向 `/api/roco/loadout/options?pet=<实例>` 要**这一只真实学得到的招**
    // （回执带 `effect_support` / `has_static_power` / `energy`），再按三条**确定性**规则挑四招：
    //   ① 先要**静态威力**（`has_static_power === true`）——「引擎会结算」的那一类；
    //   ② 同系别只留最重的一招（属性面铺开，别四个同系）；
    //   ③ 只靠附加效果、没有静态威力的招**不当主选**（引擎未结算，见 team-plan.js 的同一口径）。
    if (instance) {
      const picked = await judgedLoadout(instance);
      if (picked) return picked;
    }
    return {source: 'none', skills: []};
  }

  /**
   * 用**真实学招表**挑四招（确定性；来源 `/api/roco/loadout/options?pet=`）。
   *
   * 不编合法性：候选就是引擎回执里的 `learnable`；回执里没有的招不会出现在结果里。
   * 拿不到回执就返回 null（调用方如实留空，不猜）。
   */
  async function judgedLoadout(instance) {
    let data = null;
    try {
      data = await getJson(`${apiBase}/loadout/options?pet=${encodeURIComponent(instance)}`);
    } catch { return null; }
    const rows = (Array.isArray(data?.learnable) ? data.learnable : [])
      .filter((row) => row && row.skill_id && row.is_trait !== true);
    if (!rows.length) return null;
    for (const row of rows) if (row.name) skillNames.set(row.skill_id, row.name);
    const damage = rows.filter((row) => row.has_static_power === true && Number.isFinite(row.power));
    const byElement = new Map();
    for (const row of damage.sort((x, y) => y.power - x.power)) {
      const key = String(row.element ?? '未登记');
      if (!byElement.has(key)) byElement.set(key, row);   // 同系别只留最重的一招
    }
    const chosen = [...byElement.values()].sort((x, y) => y.power - x.power).slice(0, SHARED_LOADOUT_SLOTS);
    // 会结算的攻击招不够四个：用「最高的剩余非特性招」补齐，并让判断层如实标注它们不结算。
    if (chosen.length < SHARED_LOADOUT_SLOTS) {
      const rest = rows.filter((row) => !chosen.includes(row))
        .sort((x, y) => (y.power ?? -1) - (x.power ?? -1));
      for (const row of rest) {
        if (chosen.length >= SHARED_LOADOUT_SLOTS) break;
        chosen.push(row);
      }
    }
    if (!chosen.length) return null;
    return {source: 'judged', skills: chosen.map((row) => ({
      skill_id: row.skill_id, name: row.name ?? null, element: row.element ?? null,
      category: row.category ?? null, energy: Number.isFinite(row.energy) ? row.energy : null,
      power: Number.isFinite(row.power) ? row.power : null,
      hasStaticPower: row.has_static_power === true,
      effectSupport: row.effect_support ?? null, effectNote: row.effect_note ?? null,
      desc: row.desc ?? null,
    }))};
  }

  const PLAN_ORIGIN = Object.freeze({team: '队里这一只', recommended: '小芽推荐的下一只', box: '从你的盒子里补的'});

  /**
   * ⭐ 2026-09-29 U04 第 5 条：**6 只 × 4 招整套配置的预览**。
   *
   * 六格从哪来（三档都说在表里，不混）：
   *   · `team`        = 屏幕上已经在队里的那几只（含锁定）；
   *   · `recommended` = 小芽这一屏给的「推荐下一只 / 入口候选」里、**你盒子里真有**的那些；
   *   · `box`         = 还不够六只时，按你盒子里的顺序补（同一物种只补一次）。
   * 四个技能：玩家选过的 > 引擎给这一只的 > 盒子详情里它自己带着的那四个（同一份引擎来源）。
   * **不用随机、不用模板**：一条真实数据都没有的那一格就明写「还没有四个技能」。
   */
  async function buildPlan({renderPreview = true} = {}) {
    const rows = [];
    const usedInstances = new Set();
    const usedSpecies = new Set();
    for (const one of configSlots()) {
      if (!one.instance) continue;
      rows.push({instance: one.instance, species: one.species ?? '', name: one.name ?? null,
        origin: 'team', locked: state.locked.includes(one.instance)});
      usedInstances.add(one.instance);
      if (one.species) usedSpecies.add(one.species);
    }
    const pushSpecies = (species, origin, name) => {
      if (rows.length >= TEAM_SLOTS || !species || usedSpecies.has(species)) return;
      const instance = (state.ownedBySpecies.get(species) ?? [])[0]?.select ?? null;
      if (!instance || usedInstances.has(instance)) return;
      rows.push({instance, species, name: name ?? state.ownedByInstance.get(instance)?.name ?? null,
        origin, locked: false});
      usedInstances.add(instance);
      usedSpecies.add(species);
    };
    const recommendNames = [
      ...(state.payload?.player?.next_candidates ?? []),
      ...(state.payload?.player?.entrance?.candidates ?? []),
    ].map((row) => String(row?.name ?? '')).filter(Boolean);
    for (const name of recommendNames) pushSpecies(state.speciesByName?.get(name) ?? null, 'recommended', name);
    for (const [species, list] of state.ownedBySpecies) pushSpecies(species, 'box', list?.[0]?.name ?? null);
    const out = [];
    for (const row of rows.slice(0, TEAM_SLOTS)) {
      const four = await fourSkillsFor(row.species, row.instance);
      // ⚠⚠ R03 根因（2026-09-29 Lead 在真 8765 上逐层量出来的）：`fourSkillsFor` 的**前几支**
      //   （玩家自选 / 引擎槽位 / payload）只回 `{skill_id, name}` —— **没有 `power`/`energy`/
      //   `element`/`effect_support`**。而判断层正是靠这几个字段判断"这一招会不会结算、够不够重"，
      //   缺了就返回 `useful:false` ⇒ `renderEval` 走 `hideEvalDrawer()` ⇒
      //   **评估抽屉被收起、玩家一个字都看不到**。
      //   实测证据（真 8765、满编六只、点过「小芽给一套 6×4」）：
      //     `twPlanSkills=24`（技能确实有）却 `#tw-eval-drawer.hidden=true / data-closed-reason=no-judgement`
      //   修法：**给判断层单独补一次真实回执**（同一只的 `learnable`，就是 R02 已经在用的那一份），
      //   屏幕上的四招**一个都不动**（`skills` 原样），只让判断拿到事实。
      const rich = row.instance ? await judgedLoadout(row.instance) : null;
      const richById = new Map((rich?.skills ?? []).map((s2) => [String(s2.skill_id), s2]));
      const movesForJudgement = (four.skills ?? []).map((s2) => {
        const extra = richById.get(String(s2.skill_id)) ?? {};
        return {...extra, ...s2,
          power: s2.power ?? extra.power ?? null,
          energy: s2.energy ?? extra.energy ?? null,
          element: s2.element ?? extra.element ?? null,
          category: s2.category ?? extra.category ?? null,
          effectSupport: s2.effectSupport ?? extra.effectSupport ?? null};
      });
      out.push({...row, skills: four.skills, skillSource: four.source, movesForJudgement});
    }
    state.plan = {rows: out, at: new Date().toISOString()};
    // ── R02/R03：把这一份**真实队伍 + 真实四招 + 真实学招表**交给判断层 ──────────────
    // 判断只算一次（`state.teamPlan`），评估侧栏（R03）与 6×4 推荐（R02）都读它。
    // 六只的类型从两处取：屏幕上那一队来自 `configSlots()`（payload 的 slot 带 types），
    // 候选/盒子行里没带类型的**就是 null** —— 判断层会把它记进 `limits`，不猜。
    try {
      // ⚠⚠ 2026-09-29（人类实测：六只「属性未知」+ 流派「6 只里 0 只带—」）**根因在这里**：
      //   旧写法**只按 `one.species` 作键**，而**服务端故意不给槽 `species_id`**
      //   （`src/server/roco-service.js:1364` 注释逐字：「2026-09-25：这里**不放** `species_id`。
      //    …页面要物种 id 就**按名字**在它自己的名单里解析（唯一匹配才算，重名不猜）」）。
      //   ⇒ `one.species` 恒 `undefined` ⇒ **来源①一条都进不来** ⇒ 六只 types 全空
      //   ⇒ 判断层输出「属性未知」、流派那行变成「6 只里 0 只带—」。
      //   修法照服务端注释：**同时按名字收一份**，查的时候先按 species、再按 name 兜底。
      //   旧代码留档（改钉不删）：if (one?.species && Array.isArray(one.types) && one.types.length) slotTypes.set(one.species, one.types);
      const slotTypes = new Map();
      const typesByName = new Map();
      for (const one of configSlots()) {
        const t = Array.isArray(one?.types) ? one.types.filter((x) => typeof x === 'string' && x) : [];
        if (!t.length) continue;
        if (one?.species) slotTypes.set(one.species, t);
        if (one?.name) typesByName.set(one.name, t);
      }
      // ⚠ 2026-09-29 修（人类实测：六只「属性未知」+ 流派「6 只里 0 只带—」）：
      //   **路径写错了** —— `next_candidates` 在回执的**顶层**（`payload.next_candidates`），
      //   **不在 `payload.player` 里**（真 8765 实测：`player` 的键里没有它，顶层才有）。
      //   旧写法 `payload?.player?.next_candidates` ⇒ 恒 `undefined` ⇒ 这个来源**一条都进不来**。
      //   旧代码留档（改钉不删）：for (const row of (state.payload?.player?.next_candidates ?? [])) {
      const candRows = [
        ...(state.payload?.next_candidates ?? []),
        ...(state.payload?.candidates ?? []),
        ...(state.payload?.player?.next_candidates ?? []),
      ];
      for (const row of candRows) {
        const t = Array.isArray(row?.types) ? row.types.filter((x) => typeof x === 'string' && x) : [];
        if (!t.length) continue;
        if (row?.species) slotTypes.set(row.species, t);
        if (row?.name) typesByName.set(row.name, t);
      }
      state.teamPlan = buildTeamPlan({
        team: out.map((row) => ({
          instance: row.instance, species: row.species, name: row.name, origin: row.origin, locked: row.locked,
          // 先按物种 id 查；查不到**按名字**兜底（槽没有 species_id，只有 name —— 见上面的注释）。
          types: slotTypes.get(row.species) ?? typesByName.get(row.name) ?? [],
          moves: row.movesForJudgement ?? (row.skills ?? []).map((s2) => ({...s2, effectSupport: s2.effectSupport ?? null})),
        })),
        pool: [],
        opponent: state.evalOpponent ?? null,
        typeMultiplier: defenceMultiplier,
        // 能量上限/回能是**规则配置**里的事实，工坊这一屏拿不到 ⇒ 传 null，
        // 判断层会如实写进 limits（不硬编一个 10）。
        energy: null,
      });
      // ── 2026-09-30（评审判据 32 的真 bug）：这份判断**属于哪支队伍**要记下来 ───────────
      // 根因：`renderEval()` 的第一支只问"判断层有没有结论"（`planned.useful === true`）就画
      // 「六只满编 · 判断与打法」，**不看当前选了几只**；而 `state.teamPlan` 建好之后**没人作废** ——
      // `#tw-reset` 只清 `state.selected`，清不掉这份判断 ⇒ 从此"选 0 只/选 2 只"都被画成那支
      // 已经不存在的队伍的判断（真 8765 实测：`selected=2` 而正文停在满编帧）。
      // 修法：把"属于哪支队伍"记在 `state.teamPlanFor` 上，`renderEval` 读出前先比对 ⇒
      // 选择一变（清空/加人/换人/替换）这份判断自动作废，不必去逐个改变更点。
      state.teamPlanFor = state.selected.join(',');
    } catch (error) {
      state.teamPlan = {useful: false, error: String(error?.message ?? error)};
      // 失败那一份同样要挂上归属（否则它会被当成"另一支队伍的判断"而被反复重算/误用）。
      state.teamPlanFor = state.selected.join(',');
    }
    if (renderPreview) renderPlan();
    renderEval(state.payload?.player ?? null, state.payload?.stage ?? null);
    return state.plan;
  }

  /** 预览表：逐格给名字 + 四个技能名 + 这一行是哪来的。六只 × 四个技能就是「6×4」。 */
  function renderPlan() {
    const box = $('tw-plan-box');
    if (!box) return;
    const plan = state.plan;
    if (!plan) {
      box.hidden = true;
      box.innerHTML = '';
      rootEl.dataset.twPlanState = 'none';
      rootEl.dataset.twPlanRows = '0';
      rootEl.dataset.twPlanSkills = '0';
      return;
    }
    const rows = plan.rows;
    const skillCount = rows.reduce((n, row) => n + (row.skills ?? []).length, 0);
    const complete = rows.length === TEAM_SLOTS
      && rows.every((row) => (row.skills ?? []).length === SHARED_LOADOUT_SLOTS);
    const lockedKept = (state.locked ?? []).every((id) => rows.some((row) => row.instance === id));
    const four = (row) => {
      const list = Array.isArray(row.skills) ? row.skills : [];
      const chips = list.map((s) => `<span class="tw-skill" data-tw-plan-skill="${escapeAttr(s.skill_id ?? '')}"
        title="${escapeAttr(s.name ?? '名字未登记')}">${escapeHtml(s.name ?? '名字未登记')}</span>`).join('');
      if (!list.length) return '<span class="tw-skill" data-tw-skill-state="missing">这一只还没有四个技能</span>';
      const short = SHARED_LOADOUT_SLOTS - list.length;
      return chips + (short > 0
        ? `<span class="tw-skill" data-tw-skill-state="missing">还差 ${short} 招（点它的「换招」选满）</span>` : '');
    };
    box.hidden = false;
    box.innerHTML = `<div class="tw-head"><h3>小芽给的整套配置（6 只 × 4 招）</h3>
      <span class="tw-sub">${rows.length} 只 · ${skillCount} 个技能</span></div>
     <table class="tw-plan"><thead><tr><th>#</th><th>精灵</th><th>四个技能</th></tr></thead><tbody>
      ${rows.map((row, at) => `<tr data-tw-plan-row="${escapeAttr(row.instance ?? '')}"
        data-tw-plan-species="${escapeAttr(row.species ?? '')}" data-tw-plan-origin="${escapeAttr(row.origin ?? '')}"
        data-tw-plan-skill-count="${(row.skills ?? []).length}">
        <td class="tw-plan-mark">${at + 1}</td>
        <td class="tw-plan-who">${escapeHtml(row.name ?? NO_ITEM)}${row.locked
    ? ' <span class="tw-plan-mark">锁定</span>' : ''}
         <div class="tw-plan-mark">${escapeHtml(PLAN_ORIGIN[row.origin] ?? '')}${
    row.skillSource === 'player' ? ' · 四个技能是你选的' : ''}</div></td>
        <td class="tw-plan-four">${four(row)}</td>
       </tr>`).join('')}
     </tbody></table>
     <div class="tw-knobs tw-knobs--right">
      <button class="tw-btn primary" data-tw-plan-adopt="1" ${rows.length === TEAM_SLOTS ? '' : 'disabled'}>一键换上这套</button>
      <button class="tw-btn" data-tw-plan-hide="1">收起预览</button>
     </div>
     <p class="tw-note">${complete
    ? '六只 × 四个技能都齐了：点「应用这套配置」会逐只查引擎的学习表，哪里不行会说到哪一格、怎么改。'
    : '这套还差一点：缺技能的那一格先点它的「换招」选满四个，或者把它换掉。'}</p>
     <p class="tw-note">${lockedKept
    ? `锁定的 ${state.locked.length} 只都留着，不会被换掉。`
    : '注意：你锁定的一只不在这套里 —— 换上之前先取消它的锁定。'}</p>`;
    rootEl.dataset.twPlanState = complete ? 'complete' : 'incomplete';
    rootEl.dataset.twPlanRows = String(rows.length);
    rootEl.dataset.twPlanSkills = String(skillCount);
    rootEl.dataset.twPlanLockedKept = lockedKept ? 'yes' : 'no';
    rootEl.dataset.twPlanTeam = rows.map((row) => row.instance ?? '').join(',');
    rootEl.dataset.twPlanLoadouts = rows.map((row) => `${row.instance}:`
      + (row.skills ?? []).map((s) => s.skill_id).filter(Boolean).join('.')).join(';');
  }

  /** 「一键换上这套」：把预览那一份装到屏幕上（锁定的一只必须还在；技能原样写进内存与共用记录）。 */
  async function adoptPlan() {
    const plan = state.plan;
    if (!plan || plan.rows.length !== TEAM_SLOTS) {
      setConfigNote('这套配置还没凑满六只：先让它补齐，再换上。');
      return false;
    }
    const instances = plan.rows.map((row) => row.instance).filter(Boolean);
    if (instances.length !== TEAM_SLOTS || new Set(instances).size !== TEAM_SLOTS) {
      setConfigNote('这套配置里有重复或缺席的精灵：先换一只再来。');
      return false;
    }
    if (!state.locked.every((id) => instances.includes(id))) {
      setConfigNote('你锁定的一只不在这套配置里 —— 锁定的一只必须留在队伍里，先取消它的锁定再换。');
      return false;
    }
    state.selected = instances;
    for (const row of plan.rows) {
      const ids = (row.skills ?? []).map((s) => s.skill_id).filter(Boolean).slice(0, SHARED_LOADOUT_SLOTS);
      if (!row.species || ids.length !== SHARED_LOADOUT_SLOTS) continue;
      loadouts.set(row.species, ids.slice());
      // S1（G01）：写**个体级**键（`row.instance` 就是这一只）—— 不再写物种级。
      if (row.instance) writeIndividualLoadout(null, row.instance, ids.slice());
    }
    state.error = null;
    state.replaceIncoming = null;
    state.replaceArm = null;
    renderReplaceBox();
    setConfigNote('已经按预览把六只与它们的四个技能装到屏幕上了：核对无误后点「应用这套配置」。');
    await reload();
    await buildPlan();
    return true;
  }
  // ── ⭐ 阵容配置：这一屏 / 应用过的那一份 / 记录里那一份，三处比的都是同一串（task-8）──────

  /**
   * ⭐ 2026-09-29（task-8 真机实测抓到的**错位**，也就是 art-finish D① 报的那一处）：
   * 服务端回的 `player.slots` **不是**按 `selected` 的顺序排的 —— 实测
   * `selected=own-0006,own-0005,own-0003,own-0002,own-0001,own-0004` 与
   * `selected=own-0001…own-0006` 两条地址回**同一份槽位顺序**（喵喵/水蓝蓝/火花/迪莫/水灵/火神）。
   * 于是原来那句 `state.selected[slot.index - 1]`（以及 `configSlots` 里的 `slots[index]`）拿的是
   * **别人的个体**：真机上第 1 格写着「喵喵」而 `data-tw-slot-instance` 是 `own-0004`（迪莫），六格全错位。
   * 所以槽位 ↔ 个体只能**按物种解析**：公开层不许带 id（架构约束），物种由名字唯一匹配
   *（`speciesOfSlot`）；同一物种在队里不可能有两只（服务端按 RC-301 拒重复）⇒ 这个解析唯一。
   */
  function instanceOfSlot(slot) {
    const species = speciesOfSlot(slot);
    if (!species) return null;
    return state.selected.find((id) => (state.ownedByInstance.get(id)?.speciesId ?? null) === species) ?? null;
  }

  /** 反过来：这个个体装在哪一格（按物种找；找不到回 null —— 不按下标猜）。 */
  function slotOfInstance(instance) {
    const species = state.ownedByInstance.get(instance)?.speciesId ?? null;
    if (!species) return null;
    const slots = Array.isArray(state.payload?.player?.slots) ? state.payload.player.slots : [];
    return slots.find((slot) => slot?.state === 'filled' && speciesOfSlot(slot) === species) ?? null;
  }

  /** 这一屏某个个体在界面上叫什么（它自己那一格的槽位名 → 持有索引 → 退回编号）。 */
  function slotNameOf(instance) {
    return slotOfInstance(instance)?.name ?? state.ownedByInstance.get(instance)?.name ?? instance;
  }

  /** 这一屏六个槽位各自的事实：装的是哪个个体、什么物种、会带哪四个技能（与 `emit()` 同一处口径）。 */
  function configSlots() {
    return state.selected.map((instance) => {
      const known = state.ownedByInstance.get(instance) ?? null;
      // ⚠ 用**它自己那一格**（按物种解析），不是 `slots[index]`（服务端顺序与 selected 不同，见上）。
      const slot = slotOfInstance(instance);
      const species = known?.speciesId ?? (slot ? speciesOfSlot(slot) : null);
      return {
        instance,
        species: species ?? '',
        // ⚠⚠ 2026-09-29（人类实测：六只「属性未知」+ 流派「6 只里 0 只带—」）**真正的根因在这里**：
        //   这个函数以前**不返回 `types`** ⇒ 调用方 `buildPlan()` 里那句
        //   `Array.isArray(one.types)` **恒假** ⇒ 六只 types 全空 ⇒ 判断层「属性未知」、
        //   流派那行退化成「6 只里 0 只带—」。**源头没带，下游再兜底也没用。**
        //   `types` 从槽里取（服务端填满时会给，见 `src/server/roco-service.js:1362`），
        //   槽没有就退到本机名单里的那一只（`ownedByInstance`）。
        //   旧代码留档（改钉不删）：这个对象以前只有 instance/species/name/skills 四个键。
        types: (Array.isArray(slot?.types) && slot.types.length ? slot.types : null)
          ?? (Array.isArray(known?.types) && known.types.length ? known.types : null)
          ?? [],
        name: slot?.name ?? known?.name ?? instance,
        // 四个技能 = `loadoutOf(slot).ids`（玩家选过就是玩家的，否则引擎规范配招）——
        // 与 `emit()` 交给开局的 `loadouts` 同一处，所以这一份就是"会进对局的那一份"。
        skills: slot ? loadoutOf(slot).ids.slice(0, SHARED_LOADOUT_SLOTS)
          : (loadouts.get(species ?? '')?.slice(0, SHARED_LOADOUT_SLOTS) ?? []),
      };
    });
  }

  /** 这一屏现在这套配置的快照（`teamConfigFingerprint` 吃的就是它）。 */
  function snapshotOfCurrent() {
    const list = configSlots();
    return {
      team: list.map((slot) => slot.instance),
      species: list.map((slot) => slot.species),
      locked: state.locked.slice(),
      loadouts: Object.fromEntries(list.filter((slot) => slot.species)
        .map((slot) => [slot.species, slot.skills.slice()])),
      at: new Date().toISOString(),
    };
  }

  /** 把一份快照装回屏幕（撤销与"重新读取"都走它，**逐值**，不重算、不猜）。 */
  function adoptSnapshot(snap) {
    if (!snap || !Array.isArray(snap.team) || !snap.team.length) return false;
    state.selected = snap.team.slice(0, TEAM_SLOTS);
    state.locked = (Array.isArray(snap.locked) ? snap.locked : []).filter((id) => state.selected.includes(id));
    // ⚠ 2026-09-29 U04：`explicit` 是「这一份里玩家**自己选过**配招的物种」。
    // 撤销时要连"默认 / 你选的"这个来源一起退回去：不在名单里的物种从内存 Map 里删掉
    // （不删的话，应用那一刻写进来的六个物种会让整排都显示成「你选的」，看着像没退回去）。
    if (Array.isArray(snap.explicit)) {
      for (const speciesId of [...loadouts.keys()]) {
        if (!snap.explicit.includes(speciesId)) loadouts.delete(speciesId);
      }
    }
    for (const speciesId of (Array.isArray(snap.species) ? snap.species : [])) {
      if (speciesId && !(speciesId in (snap.loadouts ?? {}))) loadouts.delete(speciesId);
    }
    // ⚠ 2026-09-29 U04（真机探针抓到的第二处）：**不在 `explicit` 名单里的物种不许写回内存 Map**。
    // 快照里的 `loadouts` 是"这一屏每一只带的四个技能"（六只都在），照单全收会把刚才被删掉的
    // 六个键又装回来 ⇒ 撤销之后整排显示成「你选的」，而撤销前明明是「默认」（来源没退回去）。
    // 值不变（payload 给的就是同样这四个技能），只是**来源**如实退回去。
    const explicit = Array.isArray(snap.explicit) ? snap.explicit : null;
    for (const [speciesId, ids] of Object.entries(snap.loadouts ?? {})) {
      if (Array.isArray(ids) && ids.length === SHARED_LOADOUT_SLOTS) {
        if (explicit && !explicit.includes(speciesId)) {
          // ⚠ 2026-09-29（U04 的**真实残留**，T4 报、Lead 落）：内存不装回来**还不够** ——
          // `loadout-store.js` 当初往共用记录里写过这六个键，而那个模块原来**只有读/写两个口**，
          // 删不掉。后果（T4 实测）：撤销之后**手动整页刷新 + 带 `?team=`** 时，
          // 这几只的来源又显示成「你选的」，而它们明明是「默认」（四个技能名不变，只是来源说错了）。
          // 这里补删：**同一个循环、同一个判据**，不多一套。
          // S1（G01）：删的是**个体级**键（这一队的这一只）；旧物种级键**不动**（它装着历史）。
          const target = instanceForSpecies(speciesId);
          if (target) clearIndividualLoadout(null, target);
          continue;
        }
        loadouts.set(speciesId, ids.slice());
        // 共用记录也写一份：这样**别的页**（盒子 / 下一次开局）读到的与这一份一致。
        // S1（G01）：写**个体级**键（这一队的这一只），不再写物种级。
        {
          const target = instanceForSpecies(speciesId);
          if (target) writeIndividualLoadout(null, target, ids.slice());
        }
      }
    }
    state.error = null;
    return true;
  }

  /** 逐只读引擎的学习表（查过才说合法）。查不到的那几只保持 `unknown`，**不假装查过**。 */
  async function checkLegality({announce = true} = {}) {
    const list = configSlots();
    for (const slot of list) {
      if (!slot.species || learnableBySpecies.has(slot.species)) continue;
      const via = (state.ownedBySpecies.get(slot.species) ?? []).find((row) => row?.select)?.select ?? slot.instance;
      try {
        const response = await fetch(`/api/roco/loadout/options?pet=${encodeURIComponent(via)}`);
        const data = await response.json();
        if (!response.ok || data?.ok !== true) continue;      // 查不到就保持 unknown
        for (const skill of data.learnable ?? []) {
          if (skill?.skill_id && skill.name) skillNames.set(skill.skill_id, skill.name);
        }
        learnableBySpecies.set(slot.species, (data.learnable ?? []).map((skill) => skill.skill_id).filter(Boolean));
      } catch { /* 同上：网络/回执异常一律保持 unknown */ }
    }
    state.config.checked = true;
    state.config.problems = teamConfigProblems({slots: list, locked: state.locked,
      learnableOf: (speciesId) => learnableBySpecies.get(speciesId) ?? null});
    // 这一份问题清单只对它被算出来的**那一套配置**有效（配置一变就当它没核过 —— 不许拿旧的结论顶）。
    state.config.problemsFor = teamConfigFingerprint(snapshotOfCurrent());
    state.config.reason = '';
    if (announce) {
      const unknown = state.config.problems.filter((p) => p.kind === 'not-checked').length;
      setConfigNote(state.config.problems.length
        ? (unknown === state.config.problems.length
          ? '有几只的学习表没读到（这一台机器读不到引擎的学习表）—— 没有核对过就不说它们合法。'
          : `这套配置现在还不能应用：${state.config.problems[0].text}`)
        : '核对完了：六只 × 四个技能都在引擎学习表里。');
    }
    renderConfig();
    // ⚠ 每一格那一行合法性也要跟着重画 —— 第一版漏了这一步：`renderConfig` 的总判据用的是刚读回来的
    // 学习表（显示 ok），而卡上那几行还是核对之前的「还没核对」（真机实测口径不一致，玩家会以为核对没生效）。
    refreshSlots();
    return state.config.problems;
  }

  /** 「应用这套配置」：核对 → 写记录（只留一步可退）→ 当众说清结果。 */
  async function applyConfig() {
    const problems = await checkLegality({announce: false});
    if (problems.length) {
      state.config.state = 'invalid';
      setConfigNote(`还不能应用：${problems[0].text}`
        + (problems.length > 1 ? `（一共 ${problems.length} 条，都列在下面）` : ''));
      renderConfig();
      return false;
    }
    const snap = snapshotOfCurrent();
    const before = readTeamConfig();
    // ⭐ 2026-09-29 U04 **改钉**（Lead 真机点出来的缺陷：应用之后「撤销」仍然 disabled）：
    //
    // 旧口径 `previous = state.config.applied ?? null` 有两个问题：
    //   ① **第一次应用之后 previous 还是 null** ⇒ 撤销按钮根本不可用（U04 验收里"撤销"这一半等于没有）；
    //   ② 它记的是"上一次应用的结果"，而不是"这一次应用之前的那一份" ⇒ 第一次应用丢掉了起点。
    //
    // 现在「撤销」退到哪一份，写死成两条，二选一：
    //   · 之前**已经应用过**一份 ⇒ 退到那一份（这就是玩家心里的"改动前"）；
    //   · 从没应用过 ⇒ 退到**应用前屏幕上的那一份**，并记住它"不是一次应用的结果"
    //     （`applied_before:'no'`）⇒ 撤销之后状态行如实回到「还没有应用过」。
    // `explicit` 记的是**应用前**玩家自己选过配招的物种：应用会把六个物种都写成显式的，
    // 撤销要连"默认 / 你选的"这个来源一起退回去（否则整排都变成"你选的"，看着像没退）。
    const explicitBefore = [...loadouts.keys()];
    const preApplied = state.config.applied ?? null;
    const previous = preApplied
      ? {...preApplied, applied_before: 'yes'}
      : {...snap, explicit: explicitBefore, applied_before: 'no'};
    const stored = writeTeamConfig(null, {current: snap, previous,
      applied_count: Number(before.applied_count ?? 0) + 1});
    // ⚠ 2026-09-29（真机抓到「进战斗那一份没有带 loadouts」）：只写本机记录**不够** ——
    // 开局那一份是 `emit()` 从**内存里这个 Map** 拼出来的（`roco.js` 的 `battleLoadouts` 再按队伍物种过滤）。
    // 玩家没换过招的格子，`loadouts` 里本来没有键（设计如此：走引擎规范配招）⇒ 开局请求就不带那一只的
    // 四个技能，"屏幕上的"与"进战斗的"只能靠"引擎的规范配招恰好一样"来对齐，**逐值不可核**。
    // 应用之后这一套是**显式的**：六个物种的四个技能都写进 Map 与共用记录 ⇒ 进战斗那一份带着它们、
    // 与屏幕上那一栏逐值可比。这正是"应用/撤销/再读取三者一致"要的东西。
    for (const [speciesId, ids] of Object.entries(snap.loadouts)) {
      if (!speciesId || !Array.isArray(ids) || ids.length !== SHARED_LOADOUT_SLOTS) continue;
      loadouts.set(speciesId, ids.slice());
      // S1（G01）：写**个体级**键（这一队的这一只），不再写物种级。
      const target = instanceForSpecies(speciesId);
      if (target) writeIndividualLoadout(null, target, ids.slice());
    }
    state.config.applied = snap;
    state.config.previous = previous;
    state.config.state = 'applied';
    state.config.reason = '';
    // ⚠ 2026-09-29 U04：应用之后六张卡的「四个技能」来源要**当场**跟着变（应用把它们写成了显式的）
    // —— 不重画的话，卡上还写着「默认」而记录里已经是显式的那一份，两处对不上（探针实测过）。
    refreshSlots();
    setConfigNote(stored
      ? '已应用：六个槽位 × 四个技能，都核对过引擎学习表。开局那一份就是它。'
      : '已应用（这一台浏览器写不进本机记录，刷新之后会丢 —— 本次开局仍然带着这一套）。');
    renderConfig();
    // 内存里的配招变了 ⇒ 也要重新派发一次（开局那一份读的就是 `emit()` 的 `loadouts`）。
    emit();
    return true;
  }

  /**
   * 「撤销上一次应用」：**只退一步**，逐值退回 `previous` 那一份。
   *
   * ⭐ 2026-09-29 U04：撤销之后的状态行由 `previous.applied_before` 决定，**不再一律写「已应用」**：
   *   · `'yes'`（退回到上一次应用的结果）⇒ 记录里的 current 换成它，状态行「已应用」；
   *   · `'no'`（从没应用过，退回到应用前的屏幕）⇒ 记录里的 current **清空**，
   *     状态行如实回到「还没有应用过」—— 这正是玩家要的那句话，也才有第二条可撤销的起点。
   */
  function undoConfig() {
    const prev = state.config.previous;
    if (!prev) {
      setConfigNote('还没有可以撤销的应用：应用一次之后才能退（一次只退一步）。');
      return false;
    }
    if (!adoptSnapshot(prev)) {
      setConfigNote('上一次应用之前的那一套读不出来，撤不了（不猜一个替代品）。');
      return false;
    }
    const before = readTeamConfig();
    const backToApplied = prev.applied_before === 'yes';
    writeTeamConfig(null, {current: backToApplied ? prev : null, previous: null,
      applied_count: Number(before.applied_count ?? 0)});
    state.config.applied = backToApplied ? prev : null;
    state.config.previous = null;
    state.config.state = backToApplied ? 'applied' : 'none';
    state.config.reason = '';
    setConfigNote(backToApplied
      ? '已经退回上一次应用之前的那一套（只退一步；想再退就先重新应用一次）。'
      : '已经撤销：这一屏回到还没应用过的状态（六只与它们的四个技能还在屏幕上）。');
    renderConfig();
    void reload();
    // 预览那一份也跟着屏幕重算（退回来的这一套就是现在的屏幕事实）。
    if (state.plan) void buildPlan();
    return true;
  }

  /** 配置那一行的状态：屏幕 / 应用过 / 记录里 三处的指纹都挂在 dataset 上（判据读它，玩家看不见）。 */
  function renderConfig() {
    const note = $('tw-config-note');
    const box = $('tw-config-problems');
    const cfg = state.config;
    const now = snapshotOfCurrent();
    const nowFingerprint = teamConfigFingerprint(now);
    // ⚠ 问题清单只对**它被算出来的那一套**有效：配置一变（换了人 / 换了招）就当它没核过，
    // 免得玩家看到"这套不能应用"却其实是上一套的原因（那是最难查的一种谎）。
    if ((cfg.problems ?? []).length && cfg.problemsFor && cfg.problemsFor !== nowFingerprint) {
      cfg.problems = [];
      cfg.checked = false;
      if (cfg.state === 'invalid') cfg.state = 'unsaved';
    }
    const applied = cfg.applied;
    const same = Boolean(applied) && teamConfigFingerprint(applied) === nowFingerprint;
    const stateName = cfg.state === 'invalid' ? 'invalid'
      : (!applied ? 'none' : (same ? 'applied' : 'unsaved'));
    state.config.state = stateName;
    rootEl.dataset.twConfigState = stateName;
    rootEl.dataset.twConfigApplied = applied ? teamConfigFingerprint(applied) : '';
    rootEl.dataset.twConfigCurrent = teamConfigFingerprint(now);
    rootEl.dataset.twConfigUndoable = cfg.previous ? 'yes' : 'no';
    // ⭐ 2026-09-29 U04 新增的机器可读钩子（Lead 的探针要按**钩子**验，不去正则匹配中文文案）：
    //   · `data-tw-config-undoable`   = yes|no（撤销按钮可不可用，与按钮 disabled 同源）
    //   · `data-tw-config-undo-target`= 撤销将退回的那一份的**指纹**（没得撤就是空串）
    //   · `data-tw-config-undo-kind`  = applied（退回到上一次应用的结果）| screen（退回到应用前的屏幕）| none
    rootEl.dataset.twConfigUndoTarget = cfg.previous ? teamConfigFingerprint(cfg.previous) : '';
    rootEl.dataset.twConfigUndoKind = cfg.previous
      ? (cfg.previous.applied_before === 'yes' ? 'applied' : 'screen') : 'none';
    rootEl.dataset.twConfigProblems = String((cfg.problems ?? []).length);
    rootEl.dataset.twConfigSlots = String(configSlots().filter((slot) => slot.instance).length);
    rootEl.dataset.twConfigSkillSlots = String(configSlots()
      .filter((slot) => slot.skills.length === SHARED_LOADOUT_SLOTS).length);
    // 槽位名 → 物种（判据要把屏幕上的名字对到 battle 请求体的 loadouts 键；公开层不许带 id ⇒ 挂属性上）
    rootEl.dataset.twSlotSpecies = (Array.isArray(state.payload?.player?.slots)
      ? state.payload.player.slots : [])
      .filter((slot) => slot?.state === 'filled')
      .map((slot) => `${slot.name}=${speciesOfSlot(slot) ?? ''}`).join('|');
    // 六只四技能的**总体**合法性（逐格的在每张卡上；这里给判据一个总数）。
    const pool = (speciesId) => learnableBySpecies.get(speciesId) ?? null;
    const perSlot = configSlots().map((slot) => slotLegalityProblems({skills: slot.skills, learnable: pool(slot.species)}));
    const bad = perSlot.filter((list) => list.length).length;
    rootEl.dataset.twLegalityAll = !perSlot.length ? 'none'
      : (perSlot.some((list) => list.some((p) => p.kind === 'unknown')) ? 'unknown'
        : (bad ? 'illegal' : 'ok'));
    rootEl.dataset.twLegalityBad = String(bad);
    if (note) {
      // ⚠ `cfg.reason`（被拦下的动作要说的话）优先：它比状态行更紧急，而且由玩家那一下触发。
      // 一旦玩家做了配置动作（核对/应用/撤销）或改了队伍，reason 就被清掉。
      note.textContent = cfg.reason ? cfg.reason : (cfg.state === 'invalid'
        ? '这套配置现在不能应用（原因见下面）。'
        : (stateName === 'applied'
          ? '已应用：屏幕上的这一套 == 开局会用的那一套 == 重新打开这一页读回来的那一套。'
          : (stateName === 'unsaved'
            ? '屏幕上的这一套和上一次应用的不一样：选好之后点「应用这套配置」。'
            : '还没有应用过：选满六只、每只四个技能，点「应用这套配置」。')));
    }
    if (box) {
      const problems = cfg.problems ?? [];
      box.hidden = !problems.length;
      // ⭐ 2026-09-29 U04 第 4 条：**逐只**给「什么问题 + 怎么改」。
      // 原来这里是一整行文本（`problems.map(p => p.text).join(' ')`）：六格都出问题时
      // 挤成一大段，玩家读不出哪一句属于哪一格、更看不出下一步做什么。
      // 现在一条一格（`data-tw-problem-slot` / `kind` 挂在 DOM 上，判据与探针读它），
      // 每一格先写「第 N 格（哪一只）」，再写问题，最后写修法（`fix` 由 teamConfigProblems 给）。
      box.innerHTML = problems.length
        ? `<div>不能应用的原因（${problems.length} 条）—— 逐条写了怎么改：</div>`
          + problems.map((p) => {
            const raw = String(p.text ?? '');
            // 标题写「第 N 格 · 哪一只」（名字从原句里取出来，正文不再重复一遍「第 N 格（名字）」）。
            const named = /^第 \d+ 格（([^）]*)）的?/u.exec(raw);
            const whose = p.slot
              ? `第 ${p.slot} 格${named?.[1] ? ` · ${named[1]}` : ''}`
              : '整队';
            return `<div class="tw-problem" data-tw-problem-slot="${p.slot}" data-tw-problem-kind="${escapeAttr(p.kind ?? '')}">
             <b>${escapeHtml(whose)}</b>：${escapeHtml(raw.replace(/^第 \d+ 格（[^）]*）的?/u, ''))}
             ${p.fix ? `<div class="tw-fix">怎么改：${escapeHtml(p.fix)}</div>` : ''}
            </div>`;
          }).join('')
        : '';
      // 逐只问题的**可复跑读数**：哪几格出问题、一共几条。
      rootEl.dataset.twConfigProblems = String(problems.length);
      rootEl.dataset.twConfigProblemSlots = [...new Set(problems.map((p) => p.slot).filter(Boolean))].join(',');
      rootEl.dataset.twConfigProblemFixes = String(problems.filter((p) => p.fix).length);
    }
    const undoBtn = $('tw-config-undo');
    if (undoBtn) undoBtn.disabled = !cfg.previous;
  }


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
      // ⚠ 2026-09-29 修（真机 `pageErrors` 抓到的**ReferenceError: species is not defined**）：
      // `f043719`（立绘那一批）给这一行加了 `twArtHtml({group: species, …})`，而这一段的循环变量只有
      // `slot` —— `renderTeam` 那一支前面**有** `const species = speciesOfSlot(slot)`，这一支没有
      // ⇒ 只要理论阵容里有一格是填的，整个 `renderAnalysis` 就抛，工作台那一屏跟着坏（验收 10–24/39/40 连红）。
      // 物种解析与 `renderTeam` **同一处口径**（公开层不许带 id，按名字唯一匹配）。
      const species = speciesOfSlot(slot);
      return `<article class="tw-slot on" role="listitem" data-tw-analysis-slot="${slot.index}"
        data-tw-state="filled" data-tw-status="${escapeAttr(slot.status ?? '')}"
        data-tw-can-battle="${slot.can_field === true ? 'field' : (slot.can_trial === true ? 'trial' : 'no')}">
       <div class="tw-row">${twArtHtml({group: species, art: state.artBySpecies?.get?.(String(species ?? '')) === true}, {size: 32})}<span class="tw-who">${escapeHtml(slot.name ?? NO_ITEM)}</span>
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
    // 2026-09-25（**玩家可见的缺陷**：这个框一直是隐藏的）：标记里写死 `hidden`，
    // 而这里原来只设 `.open = true` —— 给一个 `display:none` 的元素"展开"，
    // 结果是**玩家永远看不到理论阵容**（判据读的是 DOM 内容 `data-tw-analysis`，所以一直是绿的：
    // 「判据读取点 ≠ 玩家真正看的像素」）。现在有内容才显示、没内容整块收起。
    const analysisBox = $('tw-analysis-box');
    if (analysisBox) {
      const hasAnalysis = Number(analysis?.count ?? 0) > 0;
      analysisBox.hidden = !hasAnalysis;
      if (hasAnalysis) analysisBox.open = true;
    }
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
      // 2026-09-24（人类实测：「为啥只有 47 个可用精灵？」）：这里原来写死 `limit=60`，
      // 而 owned 有 **80 个个体**（48 物种）—— 只拉前 60 个 → `ownedBySpecies` 只认出 47 个物种，
      // 于是「我的精灵」永远少一只。现在**按 total 分页拉全**：
      // ⚠ 服务端的白名单是 `limit ∈ 1..60`（实测 limit=200 直接 400），所以每页取 60、靠 offset 翻页。
      const cards = [];
      let offset = 0;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await getJson(`${apiBase}/box?kind=mine&limit=60&offset=${offset}`);
        const rows = page?.player?.cards ?? [];
        const total = Number(page?.player?.total ?? rows.length);
        cards.push(...rows);
        offset += rows.length;
        if (!rows.length || cards.length >= total) break;
      }
      const data = {player: {cards, total: cards.length}};
      const bySpecies = new Map();
      const byInstance = new Map();
      for (const card of data?.player?.cards ?? []) {
        const instanceId = String(card.select ?? '');
        const speciesId = String(card.group ?? '');
        if (!/^own-\d+$/.test(instanceId) || !/^pet_\d{6}$/.test(speciesId)) continue;
        if (!bySpecies.has(speciesId)) bySpecies.set(speciesId, []);
        bySpecies.get(speciesId).push({select: instanceId, name: card.name ?? null,
          level: card.level ?? null, note: card.note ?? null, role_label: card.role_label ?? null,
          // ── 2026-09-30 真 bug 修：**系别照抄卡上的真数据** ──────────────────────────────
          // 现象（真 8765 实测）：选了对手之后，判断层那句 scope 写「针对「烈火战神」（属性 **未给**）」✗
          //   ⇒ 因为 `team-plan.js:188` 的 `matchup` 要求 `opp.types.length`，
          //     而页面选对手时给的 `types` 取的就是这一行 —— 这里没存 ⇒ 空数组 ⇒
          //     **整个"按对手算的行"（克制/最怕/最划算的一手）全建不起来** ✗（不是少一句文案，是半台功能）。
          // 来源：**同一趟 `/api/roco/box?kind=mine` 的卡上本来就有 `types`**（全量分页实测 542/542 都有 ✓
          //   例：pet_000550 烈火战神→["火系"]、pet_000001 喵喵→["草系"]）⇒ 零新接口、零新数据 ✓。
          // ⚠ 底线：**拿不到就是空数组**（`filter` 掉非字符串/空串）——**不猜、不硬编码、不补默认属性** ✓；
          //   空数组 ⇒ 判断层照旧说「属性 未给」✓（与"屏蔽接口 ⇒ 下拉只剩占位"那条同一族口径）。
          types: Array.isArray(card.types)
            ? card.types.filter((t) => typeof t === 'string' && t) : []});
        // 2026-09-29 U04：`role_label`（定位）也记下来 —— 六槽卡首层要写「这一只是干什么的」，
        // 而工坊载荷的槽位里没有这个字段；它本来就在这一趟 `/api/roco/box?kind=mine` 的卡上，
        // 顺手记下即可（**零新接口、零新数据**）。缺字段就是 null（首层不写这一栏，不编）。
        byInstance.set(instanceId, {speciesId, name: card.name ?? null,
          role_label: card.role_label ?? null, level: card.level ?? null});
      }
      state.ownedBySpecies = bySpecies;
      state.ownedByInstance = byInstance;
      // S1（G01）：实例 → 物种 的关系**到这里才有** ⇒ 个体级配招记录在这里叠一次
      // （个体级优先于上面那份旧物种级记录；判定在 `loadout-store.js` 的 `teamLoadouts()`）。
      overlayIndividualLoadouts();
      // ── 2026-09-30 真 bug 修：**数据到了就把「选对手」下拉补填一次** ────────────────────
      // 这条下拉挂载时（`:3457`）就绑好了，但那时 `ownedBySpecies` 还是空的（本行是 `/api/roco/box`
      // 异步回来之后才执行）⇒ 原来"只绑一次就 return"⇒ 选项永远只有占位那一个 ✗。
      // 这里补填一次（`fillOpponentOptions()` 幂等：占位项不动、已有的不重复、Map 空就一个不加）。
      fillOpponentOptions();
      // 2026-09-25：名字 → 物种 id，**只在唯一匹配时**给（图鉴有 62 个重名，名单自身也有
      // 「棋契陛下」重名）。换招要按物种把配招交给引擎，而 player 段不许带 id 形状的键
      // （`tests/roco-workshop.test.js` 的「两层分界」钉着），所以由页面自己按名字解析。
      const byName = new Map();
      const ambiguous = new Set();
      for (const [species, rows] of bySpecies) {
        for (const row of rows) {
          const name = typeof row?.name === 'string' ? row.name : '';
          if (!name) continue;
          if (byName.has(name) && byName.get(name) !== species) { ambiguous.add(name); continue; }
          byName.set(name, species);
        }
      }
      for (const name of ambiguous) byName.delete(name);
      state.speciesByName = byName;
      // 重名集合**留着**：卡片的持有标要能说「这是你有的，只是名字重复」，
      // 而不是把一只你拥有的精灵错标成「图鉴 · 按需推算（未核验）」（2026-09-26 玩家可见缺陷）。
      state.ambiguousNames = ambiguous;
      rootEl.dataset.twOwnedSpecies = String(bySpecies.size);
      rootEl.dataset.twOwnedInstances = String(byInstance.size);
    } catch {
      state.ownedBySpecies = new Map();
      state.ownedByInstance = new Map();
      state.ambiguousNames = new Set();
    }
  }

  /**
   * 候选宇宙有多大（全图鉴物种数）：**默认档是「我的精灵」，但这个数不能被它冒充**。
   *
   * 为什么单独问一次：`/api/roco/box?kind=catalog` 的 `player.total` 就是候选宇宙的物种数，
   * 而默认档（mine）的条数是几十 —— 「候选来自全图鉴 622 只」这句话要的是前者。
   * 取一次 `limit=1` 只要总量；**读不到就不写这个数**（不拿本档条数冒充，也不编一个）。
   */
  async function loadUniverseTotal() {
    try {
      const page = await getJson(`${apiBase}/box?kind=catalog&limit=1&offset=0`);
      const total = Number(page?.player?.total ?? 0);
      if (total > 0) {
        state.poolUniverse = total;
        rootEl.dataset.twPoolUniverse = String(total);
      }
    } catch { /* 读不到就留空：宁可不说这个数，也不拿候选条数冒充 */ }
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
      // 2026-09-25（人类：「这个什么陛下有啥区别？我根本看不出来啊」）：分组时**必须带上区分字段**
      // （等级 / 定位 / 徽章），否则同名不同物种的两行在页面上逐字相同。原实现只留 select+name。
      bySpecies.get(speciesId).variants.push({select: instanceId, name: card.name ?? null,
        level: card.level ?? null, role_label: card.role_label ?? null, badges: card.badges ?? []});
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
    // ⚠ 2026-09-29：诊断钩子（仓里 `data-tw-*` 本来就是这个惯例）——
    //   候选池的立绘一直画成占位，而"物种 id 对、灌表代码对、渲染时序对"三条都已排除，
    //   所以把**这张表本身**暴露出来给探针读（不改任何玩家可见的东西）。
    if (rootEl) {
      rootEl.dataset.twArtMapSize = String(state.artBySpecies?.size ?? -1);
      // 再暴露**前三个键 + 命中结果**：表有 542 条、图存在、物种 id 也对，却查不到 ⇒
      // 只剩"键的形状不是物种 id"这一种可能，直接把键打出来定案。
      const keys = [...(state.artBySpecies?.keys?.() ?? [])].slice(0, 3);
      rootEl.dataset.twArtMapKeys = keys.join(',');
      rootEl.dataset.twArtHitFirst = String(state.artBySpecies?.get?.('pet_000001') ?? '(undefined)');
    }
    // 人类 2026-09-23（后一条推翻前一条）：「不要显示去重啥的，不是显示 10 只吗」——
    // 列表**按服务端的实例行**照原样显示（不去重），也不再写「去重后」。
    const rows = state.pool.rows;
    if (!rows.length) {
      // 空态要**说出下一步**，不是留一片空白。
      $('tw-cand-list').innerHTML = `<p class="tw-note" data-tw-empty="yes">`
        + `没有符合条件的精灵：换个属性/定位，或者点「清除筛选」看全量。</p>`;
    } else $('tw-cand-list').innerHTML = (state.pool.kind === 'mine'
      ? mergeMineRows(rows).map((card) => {
        // mine 视角按**物种**合并：同一个物种的多个个体在配队时是同一个选择，
        // 铺成多行只会让人以为「重复了」（用户实测就是这么问的）。
        // 2026-09-29 U04 改钉：状态标从「持有 · 可正式上场」改成玩家语「持有 · 可出战」
        // （含义一字未动：这是你盒子里的，可以直接进正式队伍）。
        const status = '<span class="tw-state-tag tw-state-held">持有 · 可出战</span>';
        const count = card.variants.length > 1
          ? `<span class="tw-rowtag">×${card.variants.length}</span>` : '';
        return `<button class="tw-row tw-row--owned" data-tw-species="${escapeAttr(card.speciesId)}"
          data-tw-instance="${escapeAttr(card.variants[0].select)}"
          data-tw-owned="${escapeAttr(card.variants[0].select)}"
          data-tw-status="held" data-tw-kind="mine" data-tw-variants="${card.variants.length}">
         ${twArtHtml({group: card.speciesId, art: state.artBySpecies?.get?.(String(card.speciesId ?? '')) === true})}
         <span class="tw-name">${escapeHtml(card.name ?? NO_ITEM)}${count}</span>
         <span class="tw-types">${teamSlugs(card.types)}</span>
         <span class="tw-row-meta" data-tw-row-meta="yes">${escapeHtml(poolRowMetaText(card.variants[0]))}</span>
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
      // 2026-09-29 U04 改钉：两档的**用词与样式都要一眼分得开** ——
      //   · 你拥有的 ⇒ 「持有 · 可出战」（实心绿边 `tw-row--owned`）；
      //   · 图鉴里你没有 ⇒ 「图鉴 · 你没有这一只」（虚线冷色 `tw-row--ref`，不冒充可用实例）。
      // 判据读的是 `/持有|可正式上场/` 与 `/图鉴|按需推算|未核验/`（改钉不删：两颗牙都还在）。
      const status = held
        ? '<span class="tw-state-tag tw-state-held">持有 · 可出战</span>'
        : '<span class="tw-state-tag tw-state-ref">图鉴 · 你没有这一只</span>';
      // 同物种多个个体要能区分 —— 但**不印 `own-0031` 这种内部编号**（审计 2026-09-27 实测：
      // 玩家会以为那是精灵编号）。改成"这一种里的第几只"（按本机名单里的顺序），玩家看得懂。
      const sameSpecies = isMine
        ? [...byInstance.entries()].filter(([, row]) => row.speciesId === speciesId)
        : [];
      const ordinal = sameSpecies.findIndex(([id]) => id === instanceId) + 1;
      const who = isMine && sameSpecies.length > 1 && ordinal > 0
        ? `${escapeHtml(card.name ?? NO_ITEM)} <span class="tw-rowtag">第 ${ordinal} 只</span>`
        : escapeHtml(card.name ?? NO_ITEM);
      // ⚠ 2026-09-29 修（Lead 实测挖到的）：「全图鉴」页签（**默认页签**）里，
      // 玩家**已经拥有**的那些行 `data-tw-instance` / `data-tw-owned` 原来是**空串**。
      // 为什么会空：图鉴卡是**物种级**的（有两个 id 语义，`select` 在图鉴里是物种 id），
      // 所以原来把 `instanceId` 直接写成 `''` —— 这个区分本身是对的，**但拥有的那一行其实是知道个体的**
      // （`state.ownedBySpecies` 里有），只是没写进 DOM。
      // 影响（实测坐标）：`src/client/xiaoya.js:747` 的焦点 provider 就是读 `[data-tw-instance]`
      // ⇒ 在**默认页签**点一只候选，小芽**不知道你看的是哪一只**（切到「我的盒子」才有值）。
      // 现在：拥有的行补上那只个体的 id；**没有的仍然留空**（物种级就是物种级，不编一个个体出来）。
      // 组队行为不变：`addCandidate()` 拿到个体 id 就直接用，拿不到就按物种查 —— 两条路殊途同归。
      // ⚠ 形状以 `loadOwnedIndex` 为准：`ownedBySpecies` 的值是**数组**
      // （`bySpecies.get(speciesId).push({select, name, level, note})`），**不是** `{variants: [...]}`
      // —— 我第一版按 `mergeMineRows` 那个形状写了 `?.variants?.[0]`，于是取不到值、修复静默失效
      // （真机实测 `twInstance` 仍是空串才发现的）。`addCandidate()` 用的也是 `?.[0]?.select`，与这里一致。
      const ownedVariant = isMine ? null : (state.ownedBySpecies.get(speciesId)?.[0] ?? null);
      const domInstance = isMine ? instanceId : String(ownedVariant?.select ?? '');
      // ⚠ 2026-09-29 U04：**你没有的那些也要说清「为什么不能直接上场」**，而且不能长得像可用实例。
      // 判据读 `/图鉴|按需推算|未核验/`（那颗牙保留），所以「未核验」这四个字留在这一档的标里。
      // ⚠⚠ 2026-09-29（人类追问：「右边精灵名称旁边的小虚线框，不应该是 icon 吗？」）——
      //   这一行以前直接把**候选行原对象**丢给 twArtHtml，而那份行只有
      //   {instance_id, species_id, species_name, types, …}：**没有 art、没有 group/select**
      //   ⇒ 每一行都落到虚线占位（首字），而**同一只精灵在左边队槽里是有图的**。
      //   修法：照队槽那两处（:1423 / :2223）的写法，用本行自己的物种 id 去查页面已有的
      //   那张表 state.artBySpecies（:2554 从盒子卡片的 art 字段灌进来）——
      //   只用页面上本来就有的数据，不新增接口、不猜图标。
      //   ⚠ 教训记一笔：这些说明**不能写在模板字符串里面的 HTML 注释里** ——
      //   我在里面写了反引号，直接把模板字面量截断（`node --check` 当场 SyntaxError）。
      const refTag = held ? null
        : '<span class="tw-state-tag tw-state-ref" data-tw-ref="yes">图鉴 · 你没有这一只（未核验）</span>';
      return `<button class="tw-row ${held ? 'tw-row--owned' : 'tw-row--ref'}" data-tw-species="${escapeAttr(speciesId)}"
        data-tw-instance="${escapeAttr(domInstance)}"
        data-tw-owned="${escapeAttr(domInstance)}"
        data-tw-status="${held ? 'held' : 'on_demand'}"
        data-tw-kind="${isMine ? 'mine' : 'catalog'}">
       ${twArtHtml({group: speciesId, art: state.artBySpecies?.get?.(String(speciesId ?? '')) === true})}
       <span class="tw-name">${who}</span>
       <span class="tw-types">${teamSlugs(card.types)}</span>
       <span class="tw-row-meta" data-tw-row-meta="yes">${escapeHtml(poolRowMetaText(card))}</span>
       ${held ? status : refTag}
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
    // ⚠ 2026-09-29 U04：范围说明**常驻**（原来这两行被下一行无条件清空 ⇒ 玩家看不出自己在看哪一档）。
    // 默认档是「我的精灵」；「候选来自全图鉴」这句话必须在页面上真出现（判据 `badgeProblems` 读它，
    // 语义是「候选宇宙是全图鉴，不是只有你那几十只」）——这一档正是最容易把它弄丢的地方。
    const universeText = state.poolUniverse ? `全图鉴 ${state.poolUniverse} 只` : '全图鉴';
    if ($('tw-cand-note')) {
      $('tw-cand-note').textContent = state.pool.kind === 'mine'
        ? `这一档只显示「你拥有」的精灵：它们可以直接进正式队伍开局。要看其它物种就切「全图鉴」——`
          + `候选来自${universeText}，能不能上场看每一行右边那个标。`
        : `候选来自${universeText}（世界图鉴全量）：可以配队、比较与研究。`
          + `只有「你拥有」的那些才进得了正式队伍 —— 每一行右边写着是哪一种。`;
    }
    // ⚠ 两个数分开记（U04）：`twPoolTotal` 仍是**本档**的条数（换档要变，ownership 判据读它判断
    // 「作用域分档真的换了结果集」）；候选宇宙的大小另记在 `twPoolUniverse`。
    rootEl.dataset.twPoolTotal = String(state.pool.total);
    rootEl.dataset.twPoolScope = state.pool.kind;
    rootEl.dataset.twPoolScopeTotal = String(state.pool.total);
    rootEl.dataset.twPoolRows = String(rows.length);
  }

  /** 物种 id → 有没有立绘。池子每拉一趟就更新（见 loadPool 里的注释）。 */
  state.artBySpecies = state.artBySpecies instanceof Map ? state.artBySpecies : new Map();

  async function loadPool({reset = false} = {}) {
    if (reset) state.pool.offset = 0;
    const seq = (state.poolSeq += 1);
    const query = new URLSearchParams();
    query.set('kind', state.pool.kind === 'mine' ? 'mine' : 'catalog');
    // 人类 2026-09-23：「去重啊，但是要显示另外的 5 只」——
    // 同一物种可能有多只个体（铠甲虫×2…）。**分页拉全量 → 按 species 去重 → 本地分页**，
    // 每页仍是 pageSize 条、且全是不同物种（不会因为去重只剩 5 条）。
    // 注意：服务端 `limit` 上限是 **60**，所以要循环拉（我的精灵 80 → 2 次；全图鉴 622 → 11 次）。
    if (state.pool.q) query.set('q', state.pool.q);
    if (state.pool.type) query.set('type', state.pool.type);
    if (state.pool.role) query.set('role', state.pool.role);
    try {
      const PAGE = 60;
      const all = [];
      let total = 0;
      for (let round = 0; round < 12; round += 1) {
        const q2 = new URLSearchParams(query);
        q2.set('limit', String(PAGE));
        q2.set('offset', String(round * PAGE));
        const page = await getJson(`${apiBase}/box?${q2.toString()}`);
        if (seq !== state.poolSeq) return;
        if (!page.ok) throw new Error(page.error || '图鉴读取失败');
        total = Number(page.player.total) || 0;
        const cards = Array.isArray(page.player.cards) ? page.player.cards : [];
        // 2026-09-29：顺手记下「这一只有没有立绘」。候选池与六槽**共用同一套映射**
        // （Codex 计划 P1-03：列表/详情/候选池/六只队伍/对战同一套映射），
        // 而这份数据本来就在这一趟回执里（`/api/roco/box` 的 `art`），不再多发一次请求。
        for (const one of cards) {
          const key = String(one?.group ?? one?.select ?? '');
          if (key) state.artBySpecies.set(key, one.art === true);
        }
        all.push(...cards);
        if (cards.length < PAGE || all.length >= total) break;
      }
      const data = {player: {total, cards: all}};
      if (!all.length && total > 0) throw new Error('图鉴读取失败：分页没拿到任何条目');
      const unique = dedupePoolCards(all);
      state.pool.instanceTotal = data.player.total;   // 实例数（页头「80 只」用）
      state.pool.total = unique.length;               // 去重后物种数（分页用）
      // 全图鉴这一档量到的就是候选宇宙 —— 顺手记下（默认档是「我的精灵」，它量不到这个数）。
      // ⚠ 只在**没有筛选**时记：带搜索词/属性筛选的那一趟拿到的是筛选后的条数（实测踩过：
      // 搜一只就把「候选来自全图鉴 622 只」写成了 1 只）。
      const filtered = Boolean(state.pool.q || state.pool.type || state.pool.role);
      if (state.pool.kind === 'catalog' && unique.length && !filtered) {
        state.poolUniverse = unique.length;
        rootEl.dataset.twPoolUniverse = String(unique.length);
      }
      const start = Math.max(0, Math.min(state.pool.offset, Math.max(0, unique.length - 1)));
      state.pool.offset = start;
      state.pool.rows = unique.slice(start, start + state.pool.pageSize);
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
       ${mechanismRow(row.mechanism, {expandable: true})}
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
      ${mechanismRow(row.mechanism, {expandable: true})}
      ${row.tradeoff_note ? `<p class="dim">代价：${escapeHtml(row.tradeoff_note)}</p>` : ''}
      ${row.fallback_note ? `<p class="dim">${escapeHtml(row.fallback_note)}</p>` : ''}
      ${row.after_this_gap_note ? `<p class="dim">${escapeHtml(row.after_this_gap_note)}</p>` : ''}
      <p class="dim">${escapeHtml(row.build_note ?? '')}支持等级：${escapeHtml(row.support_label ?? '未核实')}</p>
     </div>`;
  }).join('')}</div>
     <p class="tw-note" style="margin-top:8px">这 ${list.length} 个候选来自「召回 → 补全六只 → 排序」，
      不是让模型凭空列举；三个标签代表三种取舍，不是强度排名。</p>`;
  }

  /** R03：判断不出来时**把这一格收起来**（并在配置行里如实说一句为什么）。 */
  function hideEvalDrawer(plan) {
    const drawer = $('tw-eval-drawer');
    if (drawer) { drawer.hidden = true; drawer.dataset.closedReason = 'no-judgement'; }
    const note = $('tw-config-note');
    if (note) {
      note.hidden = false;
      note.textContent = `阵容评估这一格先收起来：${(plan.limits ?? []).join('；') || '拿不到能给出有用结论的事实'}`;
    }
  }

  /** 判断能给出结论时把它放回来（换队伍之后仍要能用）。 */
  function showEvalDrawer() {
    const drawer = $('tw-eval-drawer');
    if (drawer && drawer.dataset.closedReason === 'no-judgement') {
      drawer.hidden = false;
      delete drawer.dataset.closedReason;
    }
  }

  /**
   * R03（2026-09-29）：**阵容评估默认只给四样** ——
   *   强度判断（在明确对手/本机训练范围内）、两条主要短板、一个优先调整、基本打法。
   *
   * 为什么这么改（README 的原话）：「**评估文案变短不等于真能判断**」。
   * 所以这一块不是把原来的墙删短，而是换成一个**有依据的判断**：每一句后面都能点到
   * 真实事实（属性倍率 / 静态威力 / 速度 / 能耗 / 规则）。等权假设的大段说明、
   * 11 属性枚举与反复的来源声明**不再默认出现**；原始数值与引擎五轴进二级折叠。
   *
   * 拿不到有用结论时（`plan.useful !== true`）**不硬凑**：返回空串，由调用方把侧栏收起。
   */
  /**
   * R03 的四块（**默认就该看见**）——紧凑版：一块一个小标题 + 每块 1–3 行，
   * 「依据」压成一行、工程口径进二级折叠 ⇒ 900px 视口里四块**一次装得下** ✓
   *（2026-09-30 实测：原版 1355px 高，900px 只装得下第一块半 ⇒ 玩家要滚动才看得到 ✗）
   */
  function renderTeamPlanBlock() {
    const plan = state.teamPlan ?? null;
    if (!plan || plan.useful !== true) return '';
    // `**加粗**` 不许把星号漏到可见文本里（Lead 逐字判的 ②）——先转义、再把成对的 ** → <b>
    const fmt = (value) => escapeHtml(String(value ?? ''))
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    // 默认块只留「标题 + 一句为什么」；**依据逐条进二级折叠** ✓（900px 才装得下四块 ✓）
    const row = (title, why) => `<div class="tw-planrow" data-tw-plan-row="${escapeAttr(title)}">
      <b>${escapeHtml(title)}</b>${why ? `<p>${fmt(why)}</p>` : ''}
    </div>`;
    const p = plan.playstyle ?? {};
    const lines = [
      ['流派', p.archetype], ['核心', p.core], ['首发', p.lead], ['能量循环', p.energyCycle],
      ['防御', p.defend], ['聚能', p.charge], ['换人', p.switch],
      ['如何赢', p.winCondition], ['最怕什么', p.worstFear], ['替补', p.bench],
    ].filter(([, v]) => typeof v === 'string' && v.trim());
    return `<div class="tw-teamplan" id="tw-teamplan">
     <div class="tw-teamplan-sec" data-tw-plan="strength"><h4>强度判断</h4>
      <p class="tw-lead">${fmt(plan.strength?.verdict ?? NO_ITEM)}</p>
      <p class="dim">范围：${fmt(plan.scope ?? '')}</p></div>
     <div class="tw-teamplan-sec" data-tw-plan="shortfalls"><h4>两条主要短板</h4>
      ${plan.shortfalls.map((r) => row(r.title, r.why)).join('')}</div>
     <div class="tw-teamplan-sec" data-tw-plan="priority"><h4>一个优先调整</h4>
      <p>${fmt(plan.priorityChange?.text ?? NO_ITEM)}</p></div>
     <div class="tw-teamplan-sec" data-tw-plan="playstyle"><h4>基本打法</h4>
      ${lines.map(([k, v]) => `<p><b>${escapeHtml(k)}</b>：${fmt(v)}</p>`).join('')}</div>
    </div>`;
  }

  /** R03：判断不出来时**把这一格收起来**（并在配置行里如实说一句为什么）。 */

  /** 判断能给出结论时把它放回来（换队伍之后仍要能用）。 */

  /**
   * R03（2026-09-29）：**阵容评估默认只给四样** ——
   *   强度判断（在明确对手/本机训练范围内）、两条主要短板、一个优先调整、基本打法。
   *
   * 为什么这么改（README 的原话）：「**评估文案变短不等于真能判断**」。
   * 所以这一块不是把原来的墙删短，而是换成一个**有依据的判断**：每一句后面都能点到
   * 真实事实（属性倍率 / 静态威力 / 速度 / 能耗 / 规则）。等权假设的大段说明、
   * 11 属性枚举与反复的来源声明**不再默认出现**；原始数值与引擎五轴进二级折叠。
   *
   * 拿不到有用结论时（`plan.useful !== true`）**不硬凑**：返回空串，由调用方把侧栏收起。
   */
  function renderPlanEvidence(inner) {
    const plan = state.teamPlan ?? null;
    const unsupported = Array.isArray(plan?.unsupportedText) ? plan.unsupportedText : [];
    const limits = Array.isArray(plan?.limits) ? plan.limits : [];
    const engineNotes = Array.isArray(plan?.playstyleEngineNotes) ? plan.playstyleEngineNotes : [];
    const basis = (plan?.shortfalls ?? []).flatMap((r) => (r.basis ?? []).map((b) => `${r.title}：${b}`))
      .concat((plan?.strength?.basis ?? []).map((b) => `强度判断：${b}`))
      .concat((plan?.priorityChange?.basis ?? []).map((b) => `优先调整：${b}`));
    const section = (title, rows) => (rows.length
      ? `<div class="tw-teamplan-sec"><h4>${escapeHtml(title)}</h4>
         <ul class="tw-basis">${rows.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '');
    return `<details class="tw-about tw-plan-evidence" id="tw-plan-evidence">
     <summary>依据与原始数值（逐条依据 / 引擎说明 / 未结算的效果 / 这一层不知道什么）</summary>
     ${section('逐条依据', basis)}
     ${section('引擎说明与来源', engineNotes)}
     ${section('本局不会生效的效果（引擎未结算，不计入能力）', unsupported)}
     ${section('这一层不知道什么', limits)}
     ${inner}
    </details>`;
  }

  function renderEngineEvidence(player) {
    const full = player?.full_team ?? null;
    // 引擎五轴还没回来：如实说一句，**不假装有五轴**，也不因此把判断块一起吞掉 ✓
    if (!full) {
      return `<p class="tw-note">引擎那一份（五个方面 / 最小替换）这次没有回来。下面的判断来自本机事实：真实学招表、属性相性、速度与能量规则。</p>`;
    }
    const axes = Array.isArray(full.axes) ? full.axes : [];
    const ordered = [...axes].sort((a, b) => AXIS_LABELS.indexOf(a.label) - AXIS_LABELS.indexOf(b.label));
    // 2026-09-25（人类投诉「五项全算不出来 / 大片大片没用的信息 / 显示不完」）：
    //   ① **能算的排最前、只画真值**（值只来自 `axisValueText`，页面不自己算、不补数）；
    //   ② 算不出来的**合并成一行**并说清「缺哪个输入」，明细默认收起 —— 诚实信息一条不删，只是不再把同一句话印四遍；
    //   ③ 合并那一行**不出现任何阿拉伯数字**（连数量都用中文写）：免得被读成"又给了一个数"。
    const okAxes = ordered.filter((axis) => axis.available);
    const missingAxes = ordered.filter((axis) => !axis.available);
    const CN = {1: '一', 2: '两', 3: '三', 4: '四', 5: '五', 6: '六'};
    const availableRow = (axis) => {
      const value = axisValueText(axis);
      const raw = axisRawText(axis);
      const level = axisLevelWord(axis.value);
      return `<li class="tw-axis" data-tw-axis="${escapeAttr(axis.label)}" data-tw-available="true"
        ${level ? `data-tw-level="${escapeAttr(level)}"` : ''}>
      <div class="tw-axis-head"><b>${escapeHtml(axis.label)}</b>
       ${axisBar(axis)}
       <span class="tw-axis-state on">现在能算</span></div>
      <p>${escapeHtml(value ?? NO_ITEM)}</p>
      ${axis.axis_means ? `<p class="dim">${escapeHtml(axis.axis_means)}</p>` : ''}
      ${axis.low_confidence_note ? `<p class="dim">${escapeHtml(axis.low_confidence_note)}</p>` : ''}
      ${raw ? `<details class="tw-about tw-axis-raw"><summary>原始数值与说明</summary>
        <p class="dim">${escapeHtml(raw)}</p>
        <p class="dim">${escapeHtml(AXIS_LEGEND[axis.label] ?? '')}</p></details>` : ''}
     </li>`;
    };
    const missingRow = missingAxes.length === 0 ? '' : `<li class="tw-axis tw-axis--missing"
      data-tw-axis="missing" data-tw-available="false">
      <div class="tw-axis-head"><b>还有${CN[missingAxes.length] ?? '几'}个方面现在算不出来</b></div>
      <p class="dim">它们都要「版本对手分布」这个输入 —— 也就是「现在大家在用什么」 —— 而我们没有它的可靠来源，
       所以这几个数我们不给：不补零，也不说「差不多」。</p>
      <details class="tw-about" id="tw-missing-axes-box"><summary>看是哪几个 / 为什么</summary>
        <ul>${missingAxes.map((axis) => `<li>${escapeHtml(axis.label)}</li>`).join('')}</ul>
      </details>
     </li>`;
    const replacement = full.replacement;
    // ── R03（2026-09-29）：默认只给判断；引擎五轴/假设说明/最小替换全部进**二级折叠** ────
    // 「让小芽说人话」那个二次翻译按钮**删掉**：判断本身就该在这一屏说清楚，
    // 再点一下让模型把同一件事说一遍，正是 R03 点名要移除的东西。
    const original = `<p class="tw-lead">${escapeHtml(full.headline ?? '')}</p>
     <ul class="tw-axes" id="tw-axes">${okAxes.map(availableRow).join('')}${missingRow}</ul>
     ${replacement ? `<div class="tw-replacement" id="tw-replacement">
       <h4>一个最小替换（引擎按结构给的）</h4>
       <p>把「${escapeHtml(replacement.out_name ?? NO_ITEM)}」换成「${escapeHtml(replacement.in_name ?? NO_ITEM)}」</p>
       <p class="dim">${escapeHtml([replacement.explanation, replacement.covers_note,
    replacement.build_note, replacement.confirmed_note].filter(Boolean).join(' '))}</p>
      </div>`
    : `<p class="tw-note" style="margin-top:9px">${escapeHtml(full.replacement_unavailable_note ?? '')}</p>`}
     ${renderUnknowns(player)}`;
    return original;
  }

  /**
   * R03 的整块：**判断块（默认可见）+ 引擎原文（二级折叠）**。
   * ⚠ 与 `player.full_team` **解耦**：判断只读 `state.teamPlan`（R02 与 R03 共用同一份 ✓）。
   */
  function renderFullTeam(player) {
    return `${renderTeamPlanBlock()}${renderPlanEvidence(renderEngineEvidence(player))}`;
  }

  /**
   * 小芽读这一页：把**已经渲染成人话**的五轴拼成一句题面交给宿主页
   * （`opts.askCoach`，与页面右上角那个小芽是同一条 `/api/coach`）。
   * 题面里**只放人话、不放原始小数**：模型不该拿它编更精确的结论，
   * 而且这一页的数字本来就是结构分（不是胜率），说出去容易读成胜率。
   */
  function aiPromptFor(player) {
    const full = player?.full_team ?? null;
    const axes = Array.isArray(full?.axes) ? full.axes : [];
    const lines = axes.filter((axis) => axis.available)
      .map((axis) => `${axis.label}：${axisValueText(axis) ?? NO_ITEM}`);
    const missing = axes.filter((axis) => !axis.available).map((axis) => axis.label);
    // 「几句话」而不是「三句话」：老代码里有把「三」读成「三只」的坑（2026-09-26 修的两处），
    // 题面不去踩它，双保险。
    return ['用几句话讲讲这套阵容（说人话，不要小数、不要胜率）：'
      + (full?.headline ? `${full.headline}；` : '') + lines.join('；')
      + (missing.length ? `；这些方面现在算不出来：${missing.join('、')}` : ''),
    '只说结构上的事：属性覆盖、速度线、能耗、角色分工。没有对局数据就不要给强度结论，'
      + '也不要把这个排序说成胜率。'].join('');
  }
  function wireAskAi() {
    const btn = shadow.getElementById('tw-ask-ai');
    if (!btn || btn.dataset.twBound === 'yes') return;
    btn.dataset.twBound = 'yes';
    btn.addEventListener('click', async () => {
      const box = shadow.getElementById('tw-ai');
      const player = lastPlayer;
      const ask = askCoach;
      if (!box) return;
      box.hidden = false;
      if (typeof ask !== 'function') {
        box.textContent = '这一页没有接上小芽（宿主页没给 askCoach）：数字就是全部，我不替它编解释。';
        return;
      }
      btn.disabled = true;
      box.textContent = '小芽正在读这一页…';
      try {
        const text = await ask(aiPromptFor(player));
        // 回答里的 `**加粗**` 要渲染出来（人类 2026-09-26：面板上看到字面星号）。
        // `markdown()` 先转义 HTML，安全。
        box.innerHTML = typeof text === 'string' && text.trim()
          ? renderMarkdown(text) : '小芽这一轮没有说话（模型可能没接上）。这一页的数字仍然有效。';
      } catch (error) {
        box.textContent = `小芽没读成：${error?.message || error}`;
      } finally {
        btn.disabled = false;
      }
    });
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
    // RC-801（2026-09-25）：**锁定也要看得见**。盒子带过来的 `?lock=` 会被下面按"必须在选人里"
    // 过滤一遍，所以这个钩子报的是**实际生效**的锁定数（不是 URL 里写了几个）——
    // 验收脚本按它核对"锁定真的跟着一起走了"，判据才不会把 URL 当事实。
    rootEl.dataset.twLocked = String(state.locked.length);
    if (!player) { $('tw-eval-body').innerHTML = ''; $('tw-eval-sub').textContent = '—'; return; }
    // 初判阶段（`stage='first'`）：证据段服务端根本没跑，`player.full_team` 是 null。
    // 这里**如实说「正在补依据」**，而不是显示「五轴算不出来」——后者会把
    // 「还没到」说成「算不出」，是两种不同的诚实。
    if (selected >= TEAM_SLOTS && !player.full_team) {
      $('tw-eval-sub').textContent = stage === 'first' ? '满编六只 · 正在补依据' : '满编六只 · 依据没回来';
      $('tw-eval-body').innerHTML = `<p class="tw-lead">六只都在了。缺口与候选已经在上面给出了。</p>
       <p class="tw-note">${stage === 'first'
    ? '五个方面与最小替换正在算（这一段最贵），回来之后原地补在这里。'
    : '五个方面与最小替换这次没有回来：只缺这一块，上面那些结论照旧。'}</p>
       ${renderUnknowns(player)}`;
      return;
    }
    // R03（2026-09-30）：六只齐了就**自动算一次判断**（不弹 6×4 预览 ✓）——
    // 这样「判断块」不再依赖先点「小芽给一套 6×4」那一下 ⇒ **玩家一个动作**（点「阵容评估」）就能看到四块 ✓
    // （实测根因：原来是两个动作才看得到 ✗；抽屉**默认收起**是 2026-09-25 人类自己的口径 ✓ 不改 ✓）
    if (selected >= TEAM_SLOTS && !state.teamPlan && !state.teamPlanBuilding) {
      state.teamPlanBuilding = true;
      void buildPlan({renderPreview: false}).finally(() => { state.teamPlanBuilding = false; });
    }
    // R03（2026-09-30 修「判断块没上屏」）：**只要判断层有结论就渲染它**，不看 `full_team` 到没到。
    // 根因（真 8765 实测 `#tw-teamplan` 缺失、而 `#tw-plan-evidence` 在）：判断块原来只长在
    // `selected>=6 && player.full_team` 那一支里，而 `buildPlan()` 重渲染那一刻引擎五轴还没回来 ✗。
    //
    // ⚠ 2026-09-30（评审判据 32 的真 bug「从满编退回后正文不跟着选中数重画」）：这一支原来
    //   **只看"判断层有没有结论"**，于是 `state.teamPlan` 一旦建好就永远截胡 —— 玩家点
    //   「清空阵容」再选 2 只（真 8765 实测 `dataset.twSelected=2`），评估正文仍印
    //   「六只满编 · 判断与打法」+ 那支**已经不存在的队伍**的判断 ✗。
    //   两道闸（缺一不可）：
    //     ① **归属**：这份判断必须属于**当前这支队伍**（`state.teamPlanFor` 由 `buildPlan()` 记）；
    //     ② **满编**：六只的判断不许在 0/2 只时上屏（`selected >= TEAM_SLOTS`）。
    //   ⇒ 选择一变（清空/加人/换人/替换）判断自动作废，落到下面 `selected>=2` 那一支 ✓。
    const planned = state.teamPlan && state.teamPlanFor === state.selected.join(',') ? state.teamPlan : null;
    if (planned?.useful === true && selected >= TEAM_SLOTS) {
      showEvalDrawer();
      $('tw-eval-sub').textContent = '六只满编 · 判断与打法';
      lastPlayer = player ?? null;
      $('tw-eval-body').innerHTML = renderFullTeam(player ?? {});
      return;
    }
    if (selected >= TEAM_SLOTS && player.full_team) {
      // R03：**判断层说没用就把这一格收起来**，不许用短文案冒充分析。
      // 判断来自 `state.teamPlan`（`buildPlan()` 里算的那一份），拿不到判断时保持原样。
      // ⚠ 2026-09-30：这里**也**要读"归属校验过"的那一份（`planned`）—— 否则换过队伍之后
      //   可能拿**上一支队伍**的判断去 `hideEvalDrawer()`（把这一格无缘无故收起来 ✗）。
      const plan = planned;
      if (plan && plan.useful === false) {
        hideEvalDrawer(plan);
        return;
      }
      showEvalDrawer();
      $('tw-eval-sub').textContent = plan?.useful === true ? '六只满编 · 判断与打法' : '六只满编 · 六个方面';
      lastPlayer = player;
      $('tw-eval-body').innerHTML = renderFullTeam(player);
      wireAskAi();
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

  /** 「全文」药丸只在**真的被截断**时才显示（量一次 scrollHeight，不靠字数猜）。
   *  面板收着时量不到（display:none → 全 0），那时什么都不改，等展开时再量一次。 */
  function syncMechFolds() {
    const panel = $('tw-eval-panel');
    if (!panel || !panel.getBoundingClientRect().height) return;
    for (const fold of panel.querySelectorAll('.tw-mech-fold')) {
      const line = fold.querySelector('.tw-mech-line');
      if (!line) continue;
      fold.classList.toggle('tw-mech-fold--plain', line.scrollHeight <= line.clientHeight + 1);
    }
  }

  // ── Coach 短提示：**同一份评估**的短结论（不重复评估区的缺口清单）─────────
  //
  // 三层级在这里写清楚，避免三块重复信息：
  //   · **阵容评估**（左/上）= 结构诊断：缺什么、候选依据、五轴与未知；
  //   · **小芽短结论**（2026-09-23 起只在**纯数据**形态）= 下一步做什么、为什么、代价是什么。
  //     它原来有一个 DOM 落点 `#tw-coach-body`（小芽 Coach 栏），人类 2026-09-23 把那块整体删除；
  //     2026-09-25 清理时把只剩空转的 `renderCoach()` 也删了 —— 正文口径仍在评估抽屉里，
  //     下面这个纯数据函数是主线程/聊天抽屉复用的唯一出口；
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
        headline: `六只都在了。现在能算的是：${axes.filter((axis) => axis.available).map((axis) => axis.label).join(' / ') || '（还没有能算的方面）'}。`,
        replacement: player.full_team.replacement
          ? {out_name: player.full_team.replacement.out_name, in_name: player.full_team.replacement.in_name,
            confirmed_by_distribution: player.full_team.replacement.confirmed_by_distribution === true}
          : null,
        next_candidates: [],
        note: '其余方面缺的是「本赛季对手分布」，所以不给胜率、也不给具体强度。'};
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

  // 2026-09-25（死代码清理）：这里原来有一个 `renderCoach(player, stage)`，唯一落点是
  // `$('tw-coach-body')` —— 而 `#tw-coach-body` 从来没被渲染过（真无头 Chrome 逐态枚举
  // shadow root 的 id 集合，5 个状态下都不存在；人类 2026-09-23 批注「右下角的小芽模块整体删除」
  // 时把那一块连同 `.tw-coach` 一起删了）。所以那个函数从删掉那天起就只剩一句
  // `if (!body) return;`，唯一作用是把 4 段玩家文案写进一个不存在的节点。
  // **短结论这条口径没有丢**：它由 `renderEval`（评估抽屉正文）承担，
  // 需要纯数据的那一路走导出的 `coachSummary()`（本文件末尾 api 与 `emit()` 都在用）。

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

  /** ⭐ 配置那一行的即时反馈（应用/撤销/核对的结果）。与 `setPickNote` 分开落点：
   *  候选区那一行说"这一点为什么没动作"，配置那一行说"这套配置现在是什么状态"。 */
  function setConfigNote(text) {
    const el = $('tw-config-note');
    if (el) el.textContent = String(text ?? '');
  }

  function emit() {
    const detail = {
      team: state.selected.slice(),
      // 本局成员的**物种 id**：由**持有实例**解析（`ownedByInstance` 是 个体→{speciesId}）。
      // 主线程拿它过滤配招 —— 不许再按名字解析：名单里「棋契陛下」有两只，名字不唯一，
      // 按名字会解析失败 ⇒ 那一只的配招被静默丢掉（玩家选了招却按规范配招开局）。
      teamSpecies: [...new Set(state.selected
        .map((id) => state.ownedByInstance?.get(id)?.speciesId ?? null)
        .filter(Boolean))],
      // 理论阵容与它能不能试玩：主线程靠这两项决定开局栏显示「正式」还是「试玩」。
      analysisTeam: state.analysis.slice(),
      analysisTrialReady: state.payload?.player?.analysis?.trial_ready === true,
      locks: state.locked.slice(),
      favourite: state.favourite,
      maxReplacements: state.maxReplacements,
      // 短结论的**纯数据**形态：主线程/聊天抽屉要用就直接读它，不要 import 本文件内部函数。
      coachSummary: buildCoachSummary(state.payload?.player ?? null),
      // 换招：{物种 id: [四个技能 id]}，只含玩家真的选过的那些。
      // 主线程开局时原样交给服务端（`battle/new` 的 `loadouts`），由引擎校验合法性。
      loadouts: Object.fromEntries([...loadouts.entries()].map(([k, v]) => [k, v.slice()])),
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
   *     缺口位置不变）。
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
    renderEval(player, stage);
    // 2026-09-27（审计实测）：`stripMarkdownInShadow` 原来跑在 `renderEval` **之前**，
    // 于是评估抽屉里那几段**没被清**（页面上印出字面 `**`）。渲染完再清一次。
    stripMarkdownInShadow();
    renderEval(player, stage);
    syncMechFolds();
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
    // ⭐ 配置那一行（应用状态 / 指纹 / 六只四技能合法性）跟着这一屏现算 —— 不许沿用上一次的数。
    renderConfig();
    // ⭐ 2026-09-29 U04：替换面板与 6×4 预览也要跟着这一屏现算（换人之后列表里的名字要是新的）。
    renderReplaceBox();
    renderPlan();
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
      syncMechFolds();
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
        // ⭐ 2026-09-29 U04 第 3 条：**满队时点候选不再只给一行红字**。
        //   · 槽位卡上先点过「替换」⇒ 直接换到那一格（一步完成，玩家已经选好要换谁了）；
        //   · 否则 ⇒ 弹「替换哪只」，逐格列出来让他点（锁定的那格禁用）。
        if (state.replaceArm) { await replaceSlot(state.replaceArm, owned.select); return; }
        state.error = null;
        state.replaceIncoming = {instance: owned.select,
          species: state.ownedByInstance.get(owned.select)?.speciesId ?? species ?? null};
        renderReplaceBox();
        setPickNote(`队伍已经满了：先在「替换哪只」里点一只换下来的，`
          + `「${state.ownedByInstance.get(owned.select)?.name ?? '这一只'}」就换上去（锁定的那格不能换）。`);
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
  // 换招：槽位卡里的按钮与编辑器（都在 shadow root 里，走同一个委托）。
  $('tw-slots').addEventListener('click', (event) => {
    const replaceBtn = event.target?.closest?.('[data-tw-replace-slot]');
    if (replaceBtn) {
      // ⭐ 2026-09-29 U04：槽位卡上的「替换」= **先选好要换下谁**，再去候选池点一只换上。
      // 再点一次同一格 = 取消（开关语义，与「移除」一致）。
      const species = String(replaceBtn.dataset.twReplaceSlot ?? '');
      const instance = state.selected.find((id) =>
        (state.ownedByInstance.get(id)?.speciesId ?? null) === species) ?? null;
      if (!instance) return;
      const slot = (state.payload?.player?.slots ?? []).find((s) => instanceOfSlot(s) === instance) ?? null;
      if (slotLocked(slot) || state.locked.includes(instance)) {
        state.config.reason = `「${displayNameOf(instance)}」是锁定带过来的：锁定的一只必须留在队伍里`
          + '（拿掉它整条开局请求都会被拒）。要换人请先取消它的锁定。';
        setPickNote(state.config.reason);
        renderConfig();
        return;
      }
      state.replaceIncoming = null;
      state.replaceArm = state.replaceArm === instance ? null : instance;
      state.config.reason = '';
      refreshSlots();
      renderReplaceBox();
      setPickNote(state.replaceArm
        ? `要换下的是「${displayNameOf(instance)}」：现在到右边候选池点一只换上（再点一次「替换」取消）。`
        : '取消替换。');
      renderConfig();
      return;
    }
    const target = event.target?.closest?.('[data-tw-loadout],[data-tw-pick],[data-tw-loadout-save],[data-tw-loadout-cancel]');
    if (!target) return;
    if (target.dataset.twLoadout) {
      const species = target.dataset.twLoadout;
      if (editor && editor.species === species) { editor = null; refreshSlots(); return; }
      const slot = (state.payload?.player?.slots ?? []).find((s) => speciesOfSlot(s) === species);
      void openLoadout(species, slot ?? {species_id: species, skills: []});
      return;
    }
    if (target.dataset.twPick) {
      if (!editor) return;
      const id = target.dataset.twPick;
      const at = editor.draft.indexOf(id);
      if (at >= 0) editor.draft = editor.draft.filter((x) => x !== id);
      else if (editor.draft.length < 4) editor.draft = [...editor.draft, id];
      else return;                       // 已经四个：多选不加（按钮同时被 aria-pressed 标出状态）
      refreshSlots();
      return;
    }
    if (target.dataset.twLoadoutSave) { saveLoadout(); return; }
    if (target.dataset.twLoadoutCancel) { editor = null; refreshSlots(); }
  });
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
    rootEl.dataset.twPoolScope = kind;
    void loadPool({reset: true});
  };
  /**
   * 「选对手」下拉（2026-09-30 A）：选项 = 名单里已有的物种（页面**只有这份带 types 的表** ✓）。
   * 选中 ⇒ state.evalOpponent = {name, types} ⇒ 重算判断（team-plan 的对手支才会亮 ✓）；
   * 清空 ⇒ 回到 `null` ⇒ 对手支**一个字都不出现** ✓（反证 ✓）。**速度不给**（页面拿不到 ⇒ 不编 ✓）。
   */
  function wireOpponentPicker() {
    const sel = $('tw-opponent');
    if (!sel) return;
    // ── 2026-09-30 真 bug 修：**绑定与填充拆开** ────────────────────────────────────
    // 现象（真 8765 实测）：这条下拉**永远只有占位那一个选项** ⇒ 「对手支」（克制招 / 最怕什么 /
    //   按对手算的强度）在产品上**根本点不到**（A 的三态读数第②态直接崩：
    //   `TypeError: Cannot read properties of undefined (reading 'value')`）。
    // 根因：本函数在**挂载时同步**跑（`:3457`），而选项来源 `state.ownedBySpecies` 是
    //   `/api/roco/box?kind=mine` **异步回来之后**才填的（`:2334`）；加上原来那句
    //   `if (sel.dataset.twBound === 'yes') return;` ⇒ **只绑一次就 return，之后再没补过** ✗。
    // 修法：**handler 仍然只绑一次**（否则一次选择会触发 n 次重算 ✗），
    //   而**选项填充做成幂等、可重复调用**（数据就绪时再调一次，见 `:2334` 之后那一行）。
    if (sel.dataset.twBound !== 'yes') {
      sel.dataset.twBound = 'yes';
      sel.addEventListener('change', () => {
        const species = sel.value;
        let picked = null;
        if (species) {
          const row = (state.ownedBySpecies?.get(species) ?? [])[0] ?? null;
          const types = Array.isArray(row?.types) ? row.types
            : (Array.isArray(state.payload?.player?.next_candidates?.find((c) => c?.species === species)?.types)
              ? state.payload.player.next_candidates.find((c) => c?.species === species).types : []);
          // 速度**不写**：页面拿不到（不编 ✓）⇒ `team-plan` 会明说"速度未知 ⇒ 不比速度"
          picked = {name: row?.name ?? species, types};
        }
        state.evalOpponent = picked;
        void buildPlan({renderPreview: false});
      });
    }
    fillOpponentOptions();
  }

  /**
   * **幂等**地把"名单里已有的物种"填进这条下拉。
   *
   * 为什么单独一个函数（2026-09-30 真 bug）：它要在**两个时刻**都能跑 ——
   *   ① 挂载时（`wireOpponentPicker()` 末尾）；② `state.ownedBySpecies` 异步填好之后（见 `:2334` 之后）。
   * 两条底线（与"当且仅当"是一体的）：
   *   · 占位项「不指定对手（只看结构）」是**静态 markup**（`:918`），这里**只 append**，不许动它 ✓；
   *   · `state.ownedBySpecies` 还是空 Map（数据没到）⇒ **一个都不加** ✓（**不预先塞假的** ✗）。
   * `seen` 从**现有 options** 播种（不是从 Map 播种）⇒ 重复调用不会产生重复项 ✓。
   */
  function fillOpponentOptions() {
    const sel = $('tw-opponent');
    if (!sel) return 0;
    const seen = new Set([...sel.options].map((o) => o.value));
    let added = 0;
    for (const [species, rows] of state.ownedBySpecies ?? []) {
      const one = rows?.[0];
      if (!one || !one.name || seen.has(species)) continue;
      seen.add(species);
      const opt = document.createElement('option');
      opt.value = species;
      opt.textContent = one.name;
      sel.append(opt);
      added += 1;
    }
    return added;
  }

  // 左侧「阵容评估」悬浮抽屉：点按钮展开/收回（与右边小芽对应）
  const evalToggle = $('tw-eval-toggle');
  const evalClose = $('tw-eval-close');
  if (evalClose) evalClose.addEventListener('click', () => {
    const d = $('tw-eval-drawer'); d.dataset.open = 'no';
    const t = $('tw-eval-toggle'); if (t) t.setAttribute('aria-expanded', 'false');
  });
  wireOpponentPicker();
  if (evalToggle) evalToggle.addEventListener('click', () => {
    const d = $('tw-eval-drawer');
    const open = d.dataset.open !== 'yes';
    d.dataset.open = open ? 'yes' : 'no';
    evalToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) syncMechFolds();   // 展开这一刻才量得到宽度：量「这行到底有没有被截断」
  });
  // 2026-09-23：抽屉展开后**点别处就收起**（浮层的标准行为）——**2026-09-25 按人类口径删掉**。
  //
  // 人类原话：「那个阵容评估既然不遮挡，那就不要设置点别的地方自动消失，仅在主动关闭的时候
  // 关闭，不过默认还是隐藏在侧边哈」。当初补「点别处收起」的理由（390×844 下抽屉会盖住候选池、
  // 唯一的关闭路径只剩面板里的「收起 ›」）**已经不成立**：现在面板自己带「收起 ›」，
  // 而「点别处就没了」在真人手里是净损失——他正想一边看评估一边点候选，抽屉一消失就得重新展开。
  // 所以现在**只有两条关闭路径**：面板里的「收起 ›」，或再点一次左侧的「阵容评估」把手；
  // 默认仍然是 `data-open="no"`（收在侧边），这一条没变。
  // 判据：`tests/roco-page-ux.test.js`（点页面其它地方后抽屉仍开、点关闭才关、默认收起）。
  //
  // 唯一一个**非点击**的收回路径（2026-09-25 工坊验收实测出来的）：**视口变成窄屏**时收回。
  // 为什么必须补：抽屉是 `position:fixed` 的贴边浮层，宽屏下只占左边 300px，窄屏下会压住
  // 候选池与 `#tw-reset`；而它一开，把手按钮就是 `display:none`（人类要求「展开后按钮消失」），
  // 于是窄屏下「先开着抽屉、再点候选」真的点不到（工坊判据 `32-窄屏候选区` 量的就是这个）。
  // 收回的时机是**尺寸变化**，不是「点了别处」——人类的诉求（别因为我点了别的地方就消失）不变。
  const narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 560px)') : null;
  const collapseOnNarrow = () => {
    if (!narrow?.matches) return;
    const d = $('tw-eval-drawer');
    if (!d || d.dataset.open !== 'yes') return;
    d.dataset.open = 'no';
    const t = $('tw-eval-toggle');
    if (t) t.setAttribute('aria-expanded', 'false');
  };
  if (narrow && !rootEl.dataset.twDrawerNarrowBound) {
    rootEl.dataset.twDrawerNarrowBound = 'yes';
    narrow.addEventListener('change', collapseOnNarrow);
    collapseOnNarrow();
  }
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
    // 2026-09-25（死代码清理 / 漂移修复）：这里原来**又声明了一份** `ROLE_CN`，而且把
    // `recovery` 写成「恢复」，与文件顶部那份（第 61 行，写「回复」）、`roco.js:271` 的
    // `ROLE_LABEL`、`roco-service.js:300` 的 `BOX_ROLE_LABELS` 都不一致 —— 同一个下拉框里
    // 会同时出现两种译法。现在**只有顶部那一份**是真值源，这里不再声明。
    // 回归断言：`tests/roco-role-label-consistency.test.js`（新增，必红方向见该文件注释）。
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
      // ⚠ 2026-09-29 改钉（与 `data-tw-slot-instance` 同一处错位）：按钮带的是**这一格的物种**，
      // 不再带 `state.selected` 的下标 —— 服务端槽位顺序与 selected 无关，按下标会移错人。
      const species = String(held.dataset.twRemoveSlot ?? '');
      const at = state.selected.findIndex((id) =>
        (state.ownedByInstance.get(id)?.speciesId ?? null) === species);
      if (species && at >= 0) {
        const instance = state.selected[at];
        // ⭐ 2026-09-29（task-8：**锁定的那一只不许被换掉/顶掉**）。
        // 在这之前「移除」对锁定的槽位照样生效 —— 而 `state.locked` 里还留着它 ⇒ 下一次请求变成
        // "锁了一只没入选的实例"，服务端按 RC-301 规则⑨把**整条请求**拒掉，玩家看到的是一屏错误，
        // 却不知道是自己刚把锁定的那只拿掉了。现在这一步就拦住，并说清为什么、怎么办。
        if (state.locked.includes(instance)) {
          state.config.reason = `「${slotNameOf(instance)}」是锁定带过来的：锁定的一只必须留在队伍里`
            + '（拿掉它整条开局请求都会被拒）。要换人请先换别的槽位。';
          setPickNote(state.config.reason);
          renderConfig();
          return;
        }
        state.selected = state.selected.filter((_, i) => i !== at);
        state.error = null;
        state.config.reason = '';
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
  // 2026-09-25（死代码清理）：这里原来有两块接线，落点都是**从来没渲染过的 id** ——
  //   · `if ($('tw-favourite')) …`（「只看收藏」开关）：`#tw-favourite` 已按人类 2026-09-23 删除，
  //     其职能由范围分档 `#tw-scope-mine` / `#tw-scope-all` 承担（`browser-workshop-acceptance.mjs:1054`
  //     把这件事登记为「已删」）。删掉的是**接线**，不是口径。
  //   · `if ($('tw-replace-body')) …`（「最多替换几只」菜单）：`#tw-replace-body` / `#tw-replace-label` /
  //     `#tw-replace-menu` 三个 id 在 5 个真实状态下逐个 `shadowRoot.getElementById` 实测 false。
  // 两个状态字段（`state.favourite` / `state.maxReplacements`）**保留**：它们是请求契约的一部分
  // （`favourites_only` / `max_replacements`，见 `workshopQuery()`）与 `onTeamChange` 的回执字段，
  // 只是现在没有任何 UI 能把它们置真 —— 这一点由下面的 reset 保持可预期（恒 false / null）。
  // ⭐ 2026-09-29（task-8）：**「清空阵容」不许把锁定的那一只也清掉**。
  // 原来它无条件把 `selected` 与 `locked` 一起清空；锁定的那一只是玩家从盒子带过来的**约束**
  // （RC-801 / 「保留锁定迪莫」），清掉它等于把玩家的约束悄悄丢了。现在：解锁定的不动，
  // 只清能动的，并把这件事写在反馈行上。
  $('tw-reset').addEventListener('click', () => {
    const kept = state.selected.filter((id) => state.locked.includes(id));
    const dropped = state.selected.length - kept.length;
    state.selected = kept;
    state.favourite = false;
    state.maxReplacements = null;
    // 这句话要落在**配置那一行**（`#tw-cand-result` 会被候选区重新取数覆盖掉 —— 真机实测抓到的）。
    state.config.reason = kept.length
      ? `清空了 ${dropped} 只；锁定的 ${kept.length} 只留着（锁定的一只必须留在队伍里）。`
      : '阵容已清空。';
    setConfigNote(state.config.reason);
    void reload();
  });

  // ⭐ 2026-09-29 U04：替换流程与 6×4 预览的接线。
  //   · 候选池上的「替换哪只」选择/取消（面板在候选区，用 shadow 级委托，重渲染不用重新绑）；
  //   · 「小芽给一套 6×4」建预览；「一键换上这套」把预览装到屏幕；「收起预览」收起来。
  shadow.addEventListener('click', (event) => {
    const pick = event.target?.closest?.('[data-tw-replace-target]');
    if (pick) {
      const incoming = state.replaceIncoming?.instance ?? null;
      const target = String(pick.dataset.twReplaceTarget ?? '');
      if (incoming) void replaceSlot(target, incoming);
      return;
    }
    if (event.target?.closest?.('[data-tw-replace-cancel]')) {
      state.replaceIncoming = null;
      state.replaceArm = null;
      renderReplaceBox();
      refreshSlots();
      setPickNote('取消替换。');
      return;
    }
    if (event.target?.closest?.('[data-tw-plan-adopt]')) { void adoptPlan(); return; }
    if (event.target?.closest?.('[data-tw-plan-hide]')) {
      state.plan = null;
      renderPlan();
      setConfigNote('预览收起来了：再点一次「小芽给一套 6×4」可以重新看。');
    }
  });
  $('tw-plan-build').addEventListener('click', () => {
    setConfigNote('正在按你的队伍与盒子拼这套 6×4（只用真实数据，不编配招）…');
    void buildPlan().then((plan) => {
      const rows = plan?.rows?.length ?? 0;
      setConfigNote(rows
        ? `预览好了：${rows} 只 × 每个四个技能（下面那张表，逐格可核）。`
        : '这套还拼不出来：你盒子里现在没有可用的个体。');
    });
  });

  $('tw-config-check').addEventListener('click', () => { void checkLegality(); });
  $('tw-config-apply').addEventListener('click', () => { void applyConfig(); });
  $('tw-config-undo').addEventListener('click', () => { undoConfig(); });

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
    // 候选宇宙的大小（全图鉴物种数）单独问一次：默认档是「我的精灵」，不能拿它的条数冒充。
    await loadUniverseTotal();
    await loadPool({reset: true});
    await reload();
    // 「两阶段都回来了」是一个**独立**的事实：验收脚本用它区分「初判已经画好了」
    // 与「完整载荷也到了」，所以不让 `twState` 兼职。
    rootEl.dataset.twReady = 'yes';
  })();
  return api;
}

export default mountTeamWorkshop;
