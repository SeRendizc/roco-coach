// R02/R03：**有打法的推荐 + 阵容评估**的唯一判断层（纯函数，浏览器安全）。
//
// 为什么单独一层、而不是把结论写进页面文案里：
//   README 的原话是「**推荐有合法招式并不等于好用，评估文案变短不等于真能判断**」。
//   所以这一层的产出必须能**逐条追到真实事实**（属性倍率 / 静态威力 / 能耗 / 速度 / 规则配置），
//   而且必须区分「引擎真的会结算的能力」与「只是资料里写着的效果」。
//
// 与引擎真实能力对齐（Lead 2026-09-29 的硬约束，来源 `effects_registered_unsupported`）：
//   · `data/roco/normalized/.../skills.json` 里**全部 824 条**技能的 `effect_support` 都是
//     `unsupported`（support-matrix 的 caveat 逐字：「本轮只做静态数据导入，未验证触发条件与时序」）；
//   · 因此本层只把**静态威力伤害**（`power` 有限且 > 0）与**框架动作**（换人/防御/聚能）
//     当作可用能力；**只靠附加效果**（没有静态威力）的招 **不计入能力**，并单独列进
//     `unsupportedEffects`，逐字写明「本局不会按说明生效」。
//   · 这条纪律对 R03 同样成立：**不把「引擎不支持」记成「阵容短板」**，也不把它当优势。
//
// 依赖注入（不 import 任何客户端/服务端模块）：
//   · `typeMultiplier(defenderTypes, attackType) -> number|null`：由调用方（页面）传真实的
//     属性相性函数（来源 `data/roco/normalized/.../types.json`，页面侧是 `type-affinity.js`）。
//     传不进来就**不做**属性判断（fail closed），而不是拿一张抄来的表顶上。
//   · `energy`：规则配置里的能量事实（`max` / `initial` / `regen`），本文件一个数字都不写死。
//
// 措辞纪律：全文不许出现 `胜率 / 强度分 / 强度值 / 期望值 / 评分`（与 `team-gaps.js` 的
// `BANNED_CLAIM_WORDS` 同一张表）；对局计数只说「本机真引擎、固定对手、N 个种子里赢了 M 局」。

export const PLAN_VERSION = 'roco-team-plan/v1';

/** 与 `team-gaps.js` 的 `BANNED_CLAIM_WORDS` 同源（这里只做**自检**，不另立口径）。 */
export const BANNED_CLAIM_WORDS = Object.freeze(['胜率', '强度分', '强度值', '期望值', '评分']);

/**
 * **真实档位**（唯一权威分类器：`roco/src/roco_env/coverage.py:95 classify_skill()`）。
 *
 * ⚠ 2026-09-29 实测纠正（差点写错的一条）：`skills.json` 的 `effect_support` **全 824 条**
 * 都是 `unsupported`（`effect_note` 恒为「效果原语未实现；本轮只做静态数据导入」），
 * 而 `service.py:757-767` 自己注明了它是**一刀切旧标记**，拿它当判据会**一律误报**。
 * 真档位只有三档（本机实测全 860 条：PARTIAL 559 / SIMULATABLE_UNVERIFIED 277 /
 * KNOWLEDGE_ONLY 24；`FULL_VERIFIED` **0 条**）：
 *   · `SIMULATABLE_UNVERIFIED` —— 基础结算（伤害/能耗/防御）能跑，只是未核验 ⇒ **算能力，但要标未核验**；
 *   · `PARTIAL` —— 基础能跑，但有**没被结算的机制段** ⇒ 算能力，**那些段要明写"本局不会生效"**；
 *   · `KNOWLEDGE_ONLY` —— 只有资料、不结算 ⇒ **不算能力**。
 * 拿不到档位时**不猜**：只说"未核验"，并且不把它当优势也不当短板（fail closed）。
 */
export const TIER_OK = Object.freeze(['SIMULATABLE_UNVERIFIED', 'PARTIAL', 'FULL_VERIFIED']);
export const TIER_DENY = Object.freeze(['KNOWLEDGE_ONLY']);

/**
 * **框架结算**的技能类别：`防御`。
 *
 * 为什么单独一条：防御这一类招没有静态威力，但它不是"靠附加效果吃饭"的招 ——
 * 引擎自己有防御分支（减伤 + 回能 + `defense_cooldown`），结算的是**框架**而不是数据里的效果说明。
 * 不区分的话，判断层会把「防御」记成"价值全在未结算的效果上"，那是**假短板**（我第一版就错了）。
 * 状态/特性类**不在此列**：它们要的正是引擎未实现的那些效果原语。
 */
const FRAME_SETTLED_CATEGORIES = Object.freeze(['防御']);

const num = (v) => (Number.isFinite(v) ? Number(v) : null);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = (v) => (Array.isArray(v) ? v : []);

/** 一条技能 → 本层认得的字段。**缺失就留 null，不补 0、不猜**。 */
export function moveFacts(row = {}) {
  const energy = num(row.energy);
  const power = num(row.power);
  const support = text(row.effectSupport ?? row.effect_support);
  const tier = text(row.tier ?? row.mechanicsSupport ?? row.mechanics?.support)?.toUpperCase() ?? null;
  const unparsed = Array.isArray(row.unparsed ?? row.mechanics?.unparsed) ? (row.unparsed ?? row.mechanics.unparsed) : [];
  // 有真档位就按真档位；只有旧标记时才退回旧标记（且如实标注"用的是旧标记"）。
  const tierKnown = tier !== null;
  const capacityOk = tierKnown ? TIER_OK.includes(tier) : (support ? !/unsupported/i.test(support) : null);
  const denied = tierKnown && TIER_DENY.includes(tier);
  const settled = capacityOk === true;
  const hasStaticPower = power !== null && power > 0;
  const desc = text(row.desc);
  const category = text(row.category);
  const frameSettled = category !== null && FRAME_SETTLED_CATEGORIES.includes(category);
  return {
    skillId: text(row.skill_id ?? row.skillId),
    name: text(row.name) ?? '名字未登记',
    element: text(row.element),
    category,
    energy,
    power,
    hasStaticPower,
    effectSupport: support,
    tier, tierKnown, unparsed,
    effectNote: text(row.effectNote ?? row.effect_note),
    desc,
    frameSettled,
    // **能算作能力**：静态威力（引擎一定算伤害）、档位允许、或**框架结算**（防御）。
    // 档位未知时只有静态威力算能力（fail closed，不把"不知道"当优势）。
    countsAsCapability: hasStaticPower || settled || frameSettled,
    // **只靠未实现效果**：没静态威力、档位明确不允许（KNOWLEDGE_ONLY）、也不是框架招。
    effectOnly: !hasStaticPower && !frameSettled && Boolean(desc) && denied,
    // **档位未知**：没静态威力、也不是框架招，而且我们拿不到真档位 ⇒ 既不算能力也不算短板。
    tierUnknown: !hasStaticPower && !frameSettled && !tierKnown && Boolean(desc),
    settled,
  };
}

/** 队伍成员 → 本层认得的一只（技能逐条过 `moveFacts`）。 */
export function memberFacts(row = {}) {
  const types = list(row.types).filter((t) => typeof t === 'string' && t);
  const moves = list(row.moves ?? row.skills).map(moveFacts);
  return {
    instance: text(row.instance),
    species: text(row.species ?? row.species_id),
    name: text(row.name) ?? '未命名',
    types,
    spe: num(row.stats?.spe ?? row.spe),
    trait: row.trait ?? null,
    origin: text(row.origin),
    locked: row.locked === true,
    moves,
    capableMoves: moves.filter((m) => m.countsAsCapability),
    effectOnlyMoves: moves.filter((m) => m.effectOnly),
  };
}

/** 属性倍率：调用方给函数才算；拿不到就返回 null（不做判断，也不拿假表顶）。 */
function multiplierOf(typeMultiplier, defenderTypes, attackElement) {
  if (typeof typeMultiplier !== 'function' || !defenderTypes?.length || !attackElement) return null;
  try {
    const value = typeMultiplier(defenderTypes, attackElement);
    return num(value);
  } catch {
    return null;
  }
}

const RANK = {blocking: 3, high: 2, medium: 1, info: 0};

/**
 * 主要判断：先讲打法，再给结构结论，证据逐条可核。
 *
 * @param {object} input
 * @param {Array} input.team        六只（真实持有实例；`instance` 是身份，保留不变）
 * @param {Array} [input.pool]      还没进队的候选（真实持有），用于「一个优先调整」
 * @param {object|null} [input.opponent] 明确对手（`{name,types,spe}`）；null = 训练场/无指定对手
 * @param {Function} [input.typeMultiplier] `(defenderTypes, attackType) -> number|null`
 * @param {object} [input.energy]   规则配置的能量事实 `{cap, initial, regen}`
 */
export function buildTeamPlan({team = [], pool = [], opponent = null, typeMultiplier = null, energy = null} = {}) {
  const members = list(team).map(memberFacts);
  const six = members.slice(0, 6);
  const opp = opponent && typeof opponent === 'object'
    ? {name: text(opponent.name) ?? '对手', types: list(opponent.types).filter(Boolean), spe: num(opponent.spe)}
    : null;
  const energyFacts = energy && typeof energy === 'object'
    ? {cap: num(energy.cap), initial: num(energy.initial), regen: num(energy.regen)}
    : {cap: null, initial: null, regen: null};

  const limits = [];
  if (six.length !== 6) limits.push(`只有 ${six.length} 只成员：六只才做整套判断（少一只就不给"打法"这种结论）`);
  if (typeof typeMultiplier !== 'function') limits.push('没拿到属性相性表（页面没把它传进来）：本轮不做任何属性判断');
  if (!energyFacts.cap) limits.push('没拿到规则配置里的能量上限：能量循环只说"每一招要几点"，不说"能放几次"');
  if (!opp) limits.push('没有指定对手：强度判断只在本机训练场范围内成立，不声称对某个体系强或弱');

  // ── 事实①：进攻覆盖（哪些属性的招真的会结算）─────────────────────────────
  const attackRows = [];
  for (const m of six) for (const mv of m.capableMoves) {
    if (mv.category && mv.category !== '攻击') continue;   // 只有攻击招参与"能打什么"
    if (!mv.hasStaticPower || !mv.element) continue;
    // ⚠ 2026-09-29（人类实测：「把普通系当技能名」）：以前**只存 element，不存技能名**，
    //   于是下游那句「最便宜的攻击（喵喵 的 普通系）」把**属性**放在了**技能名**的位置上。
    //   旧代码留档（改钉不删）：attackRows.push({pet: m.name, element: mv.element, power: mv.power, energy: mv.energy});
    attackRows.push({pet: m.name, name: mv.name, element: mv.element, power: mv.power, energy: mv.energy});
  }
  const attackElements = [...new Set(attackRows.map((r) => r.element))];

  // ── 事实②：共同弱点（拿真实属性表逐只算「它怕什么」）──────────────────────
  const ALL_TYPES = ['普通系', '水系', '火系', '草系', '电系', '冰系', '武系', '毒系', '地系',
    '翼系', '萌系', '虫系', '幽系', '龙系', '恶系', '机械系', '光系', '幻系'];
  const weakMap = new Map();     // 属性 → [被它克到的成员]
  if (typeof typeMultiplier === 'function') {
    for (const t of ALL_TYPES) {
      const hit = six.filter((m) => {
        const v = multiplierOf(typeMultiplier, m.types, t);
        return v !== null && v > 1;
      });
      if (hit.length) weakMap.set(t, hit.map((m) => m.name));
    }
  }
  const sharedWeaknesses = [...weakMap.entries()]
    .map(([type, names]) => ({type, names, count: names.length}))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  // ── 事实③：针对明确对手的两件事：打得动吗 / 挨得住吗 ───────────────────────
  let matchup = null;
  if (opp && typeof typeMultiplier === 'function' && opp.types.length) {
    const ourBest = attackRows
      .map((row) => ({...row, mult: multiplierOf(typeMultiplier, opp.types, row.element)}))
      .filter((row) => row.mult !== null)
      .sort((a, b) => (b.mult * (b.power ?? 0)) - (a.mult * (a.power ?? 0)));
    const theirBest = six
      .map((m) => ({name: m.name, spe: m.spe,
        mult: Math.max(...opp.types.map((t) => multiplierOf(typeMultiplier, m.types, t) ?? 1))}))
      .sort((a, b) => b.mult - a.mult || (b.spe ?? -1) - (a.spe ?? -1));
    matchup = {
      superEffectiveMoves: ourBest.filter((r) => r.mult > 1).slice(0, 4),
      resistedOnly: ourBest.length > 0 && ourBest.every((r) => r.mult <= 1),
      ourFastest: Math.max(...six.map((m) => m.spe ?? -1)),
      theirSpeed: opp.spe,
      outsped: opp.spe !== null && six.every((m) => (m.spe ?? -1) < opp.spe),
      mostExposed: theirBest[0] ?? null,
    };
  }

  // ── 事实④：引擎没结算的效果（逐条列，明写"本局不会生效"）──────────────────
  const unsupportedEffects = [];
  for (const m of six) for (const mv of m.effectOnlyMoves) {
    unsupportedEffects.push({
      pet: m.name, move: mv.name, element: mv.element, desc: mv.desc,
      effectSupport: mv.effectSupport, tier: mv.tier, loadBearing: true,
      note: `本局不会按说明生效（档位 ${mv.tier ?? 'KNOWLEDGE_ONLY'}；这段机制引擎没结算）`,
    });
  }
  // 档位未知（只有一刀切旧标记）：**不判优势也不判短板**，只如实登记"这一条按未核验处理"。
  for (const m of six) for (const mv of m.moves) {
    if (!mv.tierUnknown) continue;
    unsupportedEffects.push({pet: m.name, move: mv.name, element: mv.element, desc: mv.desc,
      effectSupport: mv.effectSupport, tier: null, loadBearing: false,
      note: '拿不到真实档位（旧标记是一刀切 unsupported）⇒ 这一条按**未核验**处理：既不算能力，也不算短板'});
  }
  // PARTIAL：基础能跑，但有没结算的机制段 —— 逐段列出来（这是最该给玩家看的那种"半成品"）。
  for (const m of six) for (const mv of m.moves) {
    if (!mv.unparsed?.length) continue;
    unsupportedEffects.push({pet: m.name, move: mv.name, element: mv.element, desc: mv.desc,
      tier: mv.tier, loadBearing: false,
      note: `基础结算能跑，但这 ${mv.unparsed.length} 段机制**本局不会生效**：${mv.unparsed.join('、')}`});
  }
  for (const m of six) for (const mv of m.moves) {
    if (mv.effectOnly || !mv.desc || !mv.hasStaticPower) continue;
    if (mv.settled) continue;
    // 有静态威力的招：伤害照算，**附加说明那部分不结算** —— 也不计入能力。
    unsupportedEffects.push({
      pet: m.name, move: mv.name, element: mv.element, desc: mv.desc,
      effectSupport: mv.effectSupport, effectNote: mv.effectNote,
      loadBearing: false,
      note: `伤害会照算（静态威力 ${mv.power}），但说明里的附加效果本局不会生效（引擎未结算）`,
    });
  }

  // ── 判断①：强度（范围内，逐条给依据；不许出现禁用词）──────────────────────
  const strength = {scope: opp ? `针对「${opp.name}」（属性 ${opp.types.join('/') || '未给'}）` : '本机训练场（没有指定对手）',
    basis: [], verdict: null};
  const capableCount = six.filter((m) => m.capableMoves.length > 0).length;
  // ⚠ 2026-09-30（Lead 授权改这一处可见面泄漏）：`**会结算**` 在二级折叠里是**逐字渲染**的
  // （折叠区走 escapeHtml，不做 markdown 转换）⇒ 玩家会看到两个星号 ✗ ⇒ **去掉星号，语义一个字不改** ✓
  strength.basis.push(`六只里有 ${capableCount} 只至少有 1 条会结算的可用招（静态威力或已实现效果）`);
  if (attackElements.length) strength.basis.push(`会结算的攻击招覆盖 ${attackElements.length} 个属性：${attackElements.join('、')}`);
  if (matchup) {
    const best = matchup.superEffectiveMoves[0] ?? null;
    strength.basis.push(best
      // 技能名 + 「N属性」分开写（人类实测纠错：以前把属性放在技能名的位置 ⟹ 读者当成了招名）
      // 旧文案留档（改钉不删）：最划算的一手：${best.pet} 的 ${best.element}（倍率 ×…）
      ? `对「${opp.name}」最划算的一手：${best.pet} 的「${best.name}」（${best.element}属性，倍率 ×${best.mult}、静态威力 ${best.power}）`
      : `没有任何一条会结算的招对「${opp.name}」打出克制（倍率全部 ≤ 1）`);
    // ⚠ 2026-09-30（Lead 补钉）：页面**拿不到对手速度**（图鉴 panel.available=false）⇒ 这一条必须**明写"未知"**，
    //   不许"顺手"补个 0/默认值 ✗ ⇒ 判据两态都钉：没选对手⇒三块不出现；选了但无 spe⇒**速度这条写"未知"** ✓
    if (matchup.theirSpeed === null) strength.basis.push('对手速度未知（页面没有这一项）⇒ 不比速度，也不编一个数');
    if (matchup.theirSpeed !== null) {
      strength.basis.push(matchup.outsped
        ? `速度：我方最快 ${matchup.ourFastest}，对面 ${matchup.theirSpeed} —— 每一只都比它慢`   // 同上：折叠里不渲染 markdown ⇒ 去星号 ✓
        : `速度：我方最快 ${matchup.ourFastest}，对面 ${matchup.theirSpeed}`);
    }
  }
  const shared = sharedWeaknesses[0] ?? null;
  if (shared && shared.count >= 2) strength.basis.push(`共同弱点：${shared.names.join('、')} 都怕${shared.type}（真实的属性表）`);
  strength.verdict = !six.length || six.length !== 6 || capableCount === 0
    ? null
    : (opp
      ? (matchup?.superEffectiveMoves.length
        ? `在「${opp.name}」这一档对手上能用：有会结算的克制招，但${matchup.outsped ? '速度全线落后，先手不在我们这边' : '速度上不落后'}。`
        : `对「${opp.name}」缺少会结算的克制手段：能打，但只能靠中性伤害硬换。`)
      : '这是一支本机训练用的队伍：有会结算的攻击手段与换人/防御框架；对某个具体体系强不强，要指定对手才说。');
  // ⚠ 2026-09-30（Lead 补钉 · 与 :260 那条是同一事实的两处落点）：
  //   上面 :260 把「对手速度未知」push 进 `strength.basis` ⇒ 而 **basis 是"依据/证据"** ⇒ 它会落在二级折叠里 ✗
  //   ⇒ 玩家**点了对手却看不到"为什么不比速度"** ✗ ⇒ 可见面（`verdict` = 页面上那句「强度判断 …」）**必须也明写** ✓
  //   ⚠ 只加一句、**不改任何判断** ✗ · `basis` 那条**原样保留** ✓（改钉不删 ✓）
  //   ⚠⚠ 2026-09-30 二次补钉（`xiaoya-panel` 的读数）：**不能挂在 `matchup` 上** ✗ ——
  //     `:189` 那道门是 `opp.types.length` ⇒ **对手没有系别时 `matchup` 恒为 `null`**
  //     ⇒ 而**"速度能不能比"与有没有系别无关** ✓ ⇒ ⇒ **没系别的对手也必须说这句** ✓
  //     旧口径留档（改钉不删）：`if (strength.verdict && opp && matchup?.theirSpeed === null)`
  if (strength.verdict && opp
      && (matchup ? matchup.theirSpeed === null : !Number.isFinite(opp.spe))) {
    strength.verdict += '（对手速度未知：页面拿不到这一项 ⇒ 这一档不比速度，也不编一个数。）';
  }

  // ── 判断②：两条主要短板（只从**会结算**的事实里推）────────────────────────
  const candidates = [];
  if (shared && shared.count >= 3) {
    candidates.push({severity: 'high', title: `${shared.type}是共同弱点`,
      why: `${shared.count} 只都被${shared.type}克制：对面有一手会结算的${shared.type}招就能压住半支队。`,
      basis: [`属性表：${shared.type} 打 ${shared.names.join('、')} 的倍率 > 1`]});
  }
  if (opp && matchup && matchup.resistedOnly) {
    candidates.push({severity: 'high', title: `对「${opp.name}」没有会结算的克制招`,
      why: '手里会结算的攻击招对它的倍率全部 ≤ 1，只能靠中性伤害换血。',
      basis: ['逐招用真实属性表算过：没有一条倍率 > 1 的攻击招']});
  }
  if (matchup?.outsped) {
    candidates.push({severity: 'high', title: '速度线被压住',
      why: `对面 ${matchup.theirSpeed} 比我方最快的 ${matchup.ourFastest} 还快：同优先级下每一手都是它先动。`,
      basis: [`真实六维速度：我方最快 ${matchup.ourFastest} / 对手 ${matchup.theirSpeed}`]});
  }
  if (unsupportedEffects.some((e) => e.loadBearing)) {
    const first = unsupportedEffects.find((e) => e.loadBearing);
    candidates.push({severity: 'medium', title: `${first.pet}的「${first.move}」价值全在未结算的效果上`,
      why: `这条招没有静态威力，效果又是引擎未结算的那一类：本局它**不是**一项能力（不能算进攻/防御手段）。`,
      basis: [`${first.move}：effect_support=${first.effectSupport ?? '未给'}，desc=「${first.desc}」`]});
  }
  const shortfalls = candidates.sort((a, b) => RANK[b.severity] - RANK[a.severity]).slice(0, 2);
  // R03 要「**两条**主要短板」：事实只够一条时**如实说"只找到一条"**（不凑 ✓），
  // 但**必须把第二条的位置交代清楚**（否则玩家会以为只有一条短板，或者以为页面坏了）。
  if (shortfalls.length === 1) {
    shortfalls.push({severity: 'info', title: '第二条短板：没找到达到门槛的',
      why: opp ? '属性、威力、速度、能耗、换人都逐条过了，没有第二条结构性吃亏。'
        : '没有指定对手时只做结构自洽检查；指定对手或打完一局就能给第二条。',
      basis: ['已检查：进攻覆盖 / 共同弱点 / 速度线 / 能耗 / 未结算效果依赖']});
  } else if (!shortfalls.length) {
    shortfalls.push({severity: 'info', title: '现在挑不出"必须马上改"的结构短板',
      why: '按会结算的事实（属性倍率 / 静态威力 / 速度 / 能耗）逐条过了一遍，没有一条达到"结构性吃亏"的门槛。',
      basis: [opp ? `已按「${opp.name}」的属性算过进攻与挨打两面` : '没有指定对手，只做了结构自洽检查']});
  }

  // ── 判断③：一个优先调整（确定性：先处理共同弱点，再看速度，再看未结算依赖）──
  let priorityChange = null;
  const poolRows = list(pool).map(memberFacts);
  if (shared && shared.count >= 3 && typeof typeMultiplier === 'function') {
    const fix = poolRows.find((c) => c.types.length
      && multiplierOf(typeMultiplier, c.types, shared.type) !== null
      && multiplierOf(typeMultiplier, c.types, shared.type) <= 1);
    const victim = six.find((m) => shared.names.includes(m.name)) ?? null;
    priorityChange = {
      kind: 'replace-member',
      text: fix && victim
        ? `先把「${victim.name}」换成候选池里的「${fix.name}」：${victim.name} 怕${shared.type}，而 ${fix.name}（${fix.types.join('/')}）不怕。`
        : `先给 ${shared.names.join('、')} 里最薄的那只准备一条${shared.type}的应对（换一只不怕它的，或者留一只专门接这一手）。`,
      basis: fix ? [`候选池里 ${fix.name} 的属性是 ${fix.types.join('/')}，对${shared.type}的倍率 ≤ 1`] : ['候选池里没有属性上更合适的成员'],
    };
  } else if (matchup?.outsped) {
    priorityChange = {kind: 'fix-speed',
      // ⚠ 2026-09-29（人类实测：「防御实际减伤 70% 但 5→4 **无额外回 2**」）：
      //   手游引擎只结算**减伤**（`defense` 事件带 `reduction`），**不额外回能**；
      //   「额外回 2 能量」是本仓 **JS 练习引擎**（`src/game/rules.js:125`）的语义，**别串进手游**。
      //   旧文案留档（改钉不删）：…用「防御」把这一轮顶过去（它减伤并额外回能，但不能连续用）。
      text: `先解决"谁先动"：对面 ${matchup.theirSpeed} 快过我们全场，优先考虑带先手优先级的招，或者用「防御」把这一轮顶过去（手游引擎结算它的减伤）。`,
      basis: ['「先手 +1」与「防御」都是引擎结算的框架事实；严格出手总序在本仓仍是 ENGINE_HYPOTHESIS']};
  } else if (unsupportedEffects.some((e) => e.loadBearing)) {
    const first = unsupportedEffects.find((e) => e.loadBearing);
    priorityChange = {kind: 'drop-effect-only',
      text: `先把「${first.pet}」那条只靠未结算效果的招换掉：在换招里挑一条**有静态威力**的（能不能学得到由引擎在换招时核对）。`,
      basis: [`${first.move} 没有静态威力，效果也未结算`]};
  } else {
    priorityChange = {kind: 'none',
      text: '现在没有必须马上改的一处：先照这套打，打完再看要改哪一格。',
      basis: ['会结算的事实里没有达到门槛的短板']};
  }

  // ── 判断④：基本打法（流派/核心/首发/能量循环/什么时候防御聚能换人/如何赢/最怕什么/替补）
  const core = six
    .map((m) => ({m, score: m.capableMoves.reduce((s, mv) => s + (mv.power ?? 0), 0)}))
    .sort((a, b) => b.score - a.score)[0]?.m ?? null;
  const lead = (() => {
    if (!opp || typeof typeMultiplier !== 'function') {
      return [...six].sort((a, b) => (b.spe ?? -1) - (a.spe ?? -1))[0] ?? null;
    }
    return [...six].sort((a, b) => {
      const wa = multiplierOf(typeMultiplier, a.types, opp.types[0]) ?? 1;
      const wb = multiplierOf(typeMultiplier, b.types, opp.types[0]) ?? 1;
      return wa - wb || (b.spe ?? -1) - (a.spe ?? -1);
    })[0] ?? null;
  })();
  const cheapest = attackRows.filter((r) => r.energy !== null).sort((a, b) => a.energy - b.energy)[0] ?? null;
  const dearest = attackRows.filter((r) => r.energy !== null).sort((a, b) => b.energy - a.energy)[0] ?? null;
  const energyLine = [];
  if (energyFacts.cap !== null) energyLine.push(`能量上限 ${energyFacts.cap}`);
  if (energyFacts.regen !== null) energyLine.push(energyFacts.regen > 0 ? `每回合自然回 ${energyFacts.regen} 点` : '**没有自然回能**（规则配置写 0）');
  if (energyFacts.initial !== null) energyLine.push(`开局 ${energyFacts.initial} 点`);
  // 技能名用「」括起来、属性另标「属性」二字 —— 免得读者把「普通系」当成招名（人类实测纠错）。
  // 旧文案留档（改钉不删）：最便宜的攻击（${cheapest.pet} 的 ${cheapest.element}）要 ${cheapest.energy} 点
  if (cheapest) energyLine.push(`最便宜的攻击（${cheapest.pet} 的「${cheapest.name}」，${cheapest.element}属性）要 ${cheapest.energy} 点`);
  if (dearest) energyLine.push(`最贵的要 ${dearest.energy} 点`);
  const playstyle = {
    archetype: (() => {
      const counts = new Map();
      for (const m of six) for (const t of m.types) counts.set(t, (counts.get(t) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
      const core2 = top && top[1] >= 3 ? `${top[0]}铺场` : '混合面';
      return `${core2}（${top ? top[1] : 0}/${six.length} 只带${top ? top[0] : '—'}）`;
    })(),
    // 压字（2026-09-30 人类裁决）：默认块每项 ~14 字；**招式名与威力数字进二级折叠**（依据没删 ✓）
    core: core ? `${core.name}（威力合计最高）` : null,
    lead: lead ? `${lead.name}${lead.spe !== null ? `（速 ${lead.spe}）` : ''}` : null,
    // 能量循环：默认块只留三件事（上限/回能/射程）；逐条依据在 `evidence.energy` 里 ✓
    energyCycle: energyFacts.cap !== null || cheapest
      ? `${energyFacts.cap !== null ? `上限 ${energyFacts.cap}` : '上限未给'}；${energyFacts.regen ? `每回合回 ${energyFacts.regen}` : '没有自然回能'}；攻击 ${cheapest?.energy ?? '?'}–${dearest?.energy ?? '?'} 点`
      : null,
    // ⚠ 「防御」的减伤是**手游引擎**结算的（`coverage.classify_skill('防御')` =
    // SIMULATABLE_UNVERIFIED，效果段是 `defense_reduction`）；而「额外回 2 点能量」与
    // 「不能连续两回合用」只在**另一个引擎**（pet-coach 的 JS 引擎 `src/game/engine.js:13,144`）
    // 存在 —— 手游引擎里 grep 不到这两个口径，所以这里**不把它们写成手游规则**。
    // ⚠ 2026-09-30（Lead 逐字判的 ④）：这一屏**不许夹工程词与来源声明** ✗
    //（原来的 `defense_reduction` / `SIMULATABLE_UNVERIFIED` / 「本仓的 JS 练习引擎」都只许进二级折叠 ✓）
    defend: '这一轮会被秒时用；不能连用，也挡不住已挂上的中毒与灼烧。',
    charge: '要攒到某一招的能耗时才用；能出手时别白过一轮。',
    switch: '用掉这一回合，换上来的照样可能吃这一手；补位不占回合。',
    winCondition: opp
      // 同上：技能名用「」、属性另标（旧文案留档：`${…pet} 的 ${…element}`）
      ? `用会结算的克制招（${matchup?.superEffectiveMoves[0] ? `${matchup.superEffectiveMoves[0].pet} 的「${matchup.superEffectiveMoves[0].name}」${matchup.superEffectiveMoves[0].element}属性` : '当前没有——只能靠中性伤害与换人博弈'}）先手压住「${opp.name}」，不让它连续出手。`
      : '先手压血线，逼对面换人，用补位接住换上来的那只。',
    worstFear: opp
      ? `最怕「${opp.name}」这类${opp.types.join('/') || '未知属性'}重手${matchup?.outsped ? '（比我方全场快）' : ''}${shared && shared.count >= 2 ? `；${shared.count} 只怕${shared.type}` : ''}`
      : (shared && shared.count >= 2 ? `最怕${shared.type}：${shared.count} 只都吃克制` : '最怕比我们快、属性又克我方主力'),
    // 替补：默认块只列名字（属性/速度在二级折叠的六只明细里 ✓）
    bench: six.slice(3).map((m) => m.name).join('、') || null,
  };

  const unsupportedText = unsupportedEffects.map((e) => `${e.pet} 的「${e.move}」：${e.note}`);

  // 工程口径（引擎术语 / 支持档位 / 本地练习引擎 vs 手游引擎的差别）**只进二级折叠**，
  // 默认四块里一个字都不出现 ✓（R03「移除反复来源声明」）
  const playstyleEngineNotes = [
    // ⚠ 2026-09-30（Lead 裁决）：工程词**留**（这一段就叫「引擎说明与来源」✓），但**开头加一句人话引导** ✓
    //    —— 让玩家一眼知道"这不是结论"，内容一个字没动 ✓
    '以下是给好奇的玩家看的引擎说明 —— 不影响上面的判断。',
    '防御的减伤是手游引擎结算的（效果段 defense_reduction · 档位 SIMULATABLE_UNVERIFIED）。',
    '「额外回能」「不能连用」只在本仓的 JS 练习引擎里有登记，手游这边没有对应规则，别照搬。',
    '「聚能」是规则配置里声明的独立动作类（不是"能量不足时的兜底"）。',
  ];
  const plan = {
    version: PLAN_VERSION,
    useful: six.length === 6 && capableCount > 0,
    scope: strength.scope,
    strength,
    shortfalls,
    priorityChange,
    playstyle,
    sixByFour: six.map((m) => ({
      instance: m.instance, species: m.species, name: m.name, types: m.types, locked: m.locked, origin: m.origin,
      moves: m.moves.map((mv) => ({...mv})),
    })),
    unsupportedEffects,
    unsupportedText,
    playstyleEngineNotes,
    sameTeamAsEvaluation: true,     // R03 与 R02 复用同一支队伍、同一套判断（这里是唯一装配点）
    limits,
    evidence: {
      attackElements, sharedWeaknesses: sharedWeaknesses.slice(0, 6),
      matchup, energy: energyFacts,
      source: '属性倍率来自页面传入的相性函数（types.json）；能耗/威力/效果说明来自技能记录；能量上限与回能来自规则配置',
    },
  };
  // 自检：判据里不许出现禁用词（与 team-gaps 的 BANNED_CLAIM_WORDS 同一张表）。
  const flat = JSON.stringify({strength, shortfalls, priorityChange, playstyle, unsupportedText});
  const banned = BANNED_CLAIM_WORDS.filter((w) => flat.includes(w));
  if (banned.length) plan.claimViolations = banned;
  return plan;
}

/** 6×4 是否**每一格都齐**（页面拿它决定要不要说"整套配置已完整"）。 */
export function sixByFourComplete(plan) {
  const rows = list(plan?.sixByFour);
  return rows.length === 6 && rows.every((r) => list(r.moves).length === 4);
}

/** 一键摘出「本轮不计入能力」的效果说明（页面把它放进二级折叠）。 */
export function unsupportedLines(plan) {
  return list(plan?.unsupportedText);
}
