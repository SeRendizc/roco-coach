// **这个文件现在是「活的验收」（live acceptance），不是「待修复的目标」。**
// 它写下时 P1 还没接，头注写的是「应当是红的」；那一版已经过期：
// 建议层（src/coach/coach-advice.js）已经接进 `rocoIntervention`（`detail.advice`），
// 所以它现在**守的是当前行为**——这 10 个局面必须各自得到「说得对路」的那种建议，
// 而且是 6 种以上不同的句子形状。哪天有人把建议层改回「只吃 plan」，
// 或者把某个局面检测器的优先级挪坏，这里会立刻变红。
//
// ── 动机（用户实测原话，文件存在的理由）────────────────────────────────────
//   玩家看到的主动气泡几乎永远是同一句：
//     「<技能名>」这一手不稳：对手换个选择就要亏约 <数字>，先看区间再定（最坏尾部 <a> ~ <b>）
//   换局面、换精灵、换技能，句子骨架一个字不变，只有名字和数字在动。
//   根因是结构：`rocoHintText(plan)` 只拿得到 planner 结果，看不到局面
//   （我方血量/能量、对手血条与能量、属性倍率、速度、异常、是否必须补位）。
// 本文件就是「修好之后长什么样」的验收证据。
//
// ── 这条测试做什么 ──────────────────────────────────────────────────────────
// 它用**真服务**（真 Python 规则引擎 + 真 HTTP 路由）造 10 个**互不相同**的对局局面，
// 每个局面都走真实提示链路：
//     /api/roco/battle/new → /api/roco/battle/advance → /api/roco/plan
//     → rocoIntervention({view, session, plan, host}) → rocoInterventionText(detail, plan)
//
// **每个 case 都绑定一个期望的检测器 kind**（`detail.advice.kind`），并且窗口是
// **隔离**过的：命名局面必须是那一刻**最优先**的局面事实，不能被更高优先级的检测器压住。
// 为什么必须隔离：一个叫「属性被抗」的 case，如果战况其实是我方只剩 8% 血，
// 那么建议层**根本没被问到属性问题**（它先看到的是「该换人了」）——那条 case 名不副实。
// 隔离依据只有**局面事实**（血量/能量/速度/倍率/合法动作/回执估算），
// 绝不看产出的文案，也绝不按形状挑窗口。
//
// ── 一条纪律：不捏 payload ─────────────────────────────────────────────────
// 每一个 position 都来自真实回执：`view` 只用 `/api/roco/battle/new` 或
// `/api/roco/battle/advance` 的 `view`，`plan` 只用 `/api/roco/plan` 的回执。
// 不做任何手工构造的假局面（第 39 轮的漏检根因就是守卫自己捏了一个服务端不发的形状）。
//
// ── 「形状」怎么算 ──────────────────────────────────────────────────────────
// 需求原话是「换技能名和数字不算不同」，所以形状归一化做三件事（见 `shapeOfWithNames`）：
//   ① 引号里的动作/技能/道具标签 → `「◆」`；
//   ② 任何数字（含小数点与负号）→ `#`；
//   ③ 裸露的精灵名 / 技能名 → `◆`（名字表从 data/roco/normalized 读，不写死在这里）。
//
// ── 第 44 轮：引擎修了两个缺陷，所有窗口都重挑过 ────────────────────────────
//   ① `SideState.to_dict()` 不序列化 `loadouts`（schema.py，已修 + test_state_roundtrip.py）：
//      私有域每次往返都把配招丢成 `{}`，规划器于是退回「全部可学技能」，
//      合法动作从 4 个虚涨到 3–43 个，`damage_preview` 恒不可用。
//   ② `RocoClient.planActions` 不转发 `damagePreview`（roco-client.js，已修）。
// 每个 case 的注释里写了它修复前落在哪里、为什么移动。
//
// ── 第 63 轮：引擎 fail-closed 修复之后重新定位（换阵容，不换种子）──────────────
//   `36832d1` 让两处 fail-closed 违规不再被静默丢弃（附带效果、防御分支的「应对成功」
//   子句），战斗走向因此改变：同一批写死的阵容/种子不再复现它们当初要隔离的事实。
//   实测结论（被停掉的子 agent 留下、已写进 C6.7）：**固定阵容下种子几乎不改变结果，
//   真正的杠杆是阵容 + 推进手数**。所以重新定位换的是阵容：
//     · 04-type-resisted：事实（上一手被抵抗 + 那一招这一轮还放得出来）仍成立，
//       被压住的是这一条的隔离判据「所有合法招倍率 < 1」——修复后「超级糖果」
//       变成合法且中性的一招。换 CFG_J（海豹船长 × 银月狼王，全部合法攻击招都被抗）。
//     · 06-ko-now-mid：**漂移**——原阵容在修复后档位内再没有收线成立的一手
//       （实测 t4/t5 无招够线，t6 起对面满血、我方掉到 8.6%）。换 CFG_K
//       （音速犬镜像，t4 双方 51.9%，火云车估 414 ≥ 190）。
//   两处期望 kind 一个字都没改；浏览器侧同步改的是
//   `scripts/roco/demo-acceptance.mjs` 的 `POSITION_MATRIX`（02 / 08 / 11）。
//
// python3 不可用时整条 skip（与 intervention-margin-chain.test.js 同一口径）。


import {test} from 'node:test';
import assert from 'node:assert/strict';

import {rocoIntervention, rocoInterventionText} from '../../../src/coach/roco-experience.js';
// ── 共享装置 ────────────────────────────────────────────────────────────────
// 「公开视图 → coachAdvice 入参」的构造只此一份：`scripts/roco/coach-position-harness.mjs`。
// 浏览器侧（`scripts/roco/demo-acceptance.mjs`）用**同一个模块**重算同一批可观测量，
// 两边各抄一份的后果不是报错，而是慢慢漂——到那时你分不清是页面错了还是重算错了。
import {
  SKIP,
  startServer,
  findPosition,
  describeConfig,
  freshSession,
  windowOf,
  hpRatio,
  foeRatio,
  previewOf,
  legalDamageSamples,
  finishAvailable,
  blockedDecisive,
  healthyBench,
  lastPlayerTypeHit,
  resistedHitPending,
  noPendingTypeMatchup,
  shapeOfWithNames,
  namesSomething,
  fabricatedClaims,
  FORBIDDEN,
} from '../../../scripts/roco/coach-position-harness.mjs';

const CFG_A = {seed: 20260921, strategy: 'greedy_damage'};
const CFG_C = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000062', 'pet_000112', 'pet_000417']};
const CFG_D = {seed: 20260921, strategy: 'conservative_switch',
  enemyTeam: ['pet_000112', 'pet_000611', 'pet_000190']};
const CFG_E = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000112', 'pet_000611', 'pet_000124']};
const CFG_G = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000190', 'pet_000608', 'pet_000611'],
  enemyTeam: ['pet_000062', 'pet_000445', 'pet_000417']};
const CFG_H = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000451', 'pet_000601', 'pet_000112'],
  enemyTeam: ['pet_000474', 'pet_000124', 'pet_000417']};
// 第 63 轮（`36832d1` 修好引擎两处 fail-closed 违规之后）重新定位用的两个阵容。
// 被停掉的子 agent 实测结论：对固定阵容来说**种子几乎不改变结果**，杠杆是阵容 + 推进手数；
// 所以下面这两条换的是阵容，不是种子。
const CFG_J = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000190', 'pet_000124', 'pet_000608'],
  enemyTeam: ['pet_000608', 'pet_000124', 'pet_000190']};
const CFG_K = {seed: 20260921, strategy: 'greedy_damage', team: ['pet_000062', 'pet_000601', 'pet_000608']};

/**
 * 取不到「隔离窗口」的局面检测器（每条一行，附具体原因）。
 * 这些**不是**断言失败，而是这条真实链路上的覆盖缺口，写在这里免得下次有人再找一遍。
 *
 * 第 63 轮的改动：`foe-low-hp` **从这个清单里移除**——它不再是缺口。引擎修复
 * （`36832d1`）之后抽样扫描（110 局）第一次真的显示出它（命中 16 / 开口 10；旧版
 * 命中 4 / 开口 0），浏览器矩阵第 9 条现在就是它（双方 38/442 的互残窗口，
 * 对面 ≤10% 血 + 这一轮没有一招稳收）。本文件这 10 格没有为它定位窗口，
 * 是因为 G 判据只要求 ≥6 种 kind，而 11 个 kind 不需要都进这 10 格。
 */
const NOT_ISOLATABLE = [
  'ko-maybe（估 X~Y 跨过血线）：引擎对**同一个技能**在三个分析种子下的估算是同一个数'
  + '（min === max），所以「下限 < 血 ≤ 上限」结构上不可能成立；damage_preview 的 min/max '
  + '只是「最弱那招 / 最狠那招」两个**不同**技能的包络。',
  'foe-status-ticking（对面中毒/灼烧/寄生掉血）：12 只精灵的规范配招没有一个直接施加这三种状态，'
  + '而 POST /api/roco/battle/new 不接受 loadouts；取念→复制引燃只在第 44 轮之前的配招序列化缺陷下成立'
  + '（修好后取念只复制对手真实带的 1–3 个技能）。冻结/萌化还会被 _apply_status_effects 直接跳过。',
  'type-favoured（我方上一手打出克制、这一轮还在用那一招）：45 局 / ~500 个窗口里只命中 1 次，'
  + '而且那一次我方满血（血量比 1.0）→ 主动提示门控直接沉默（risk 0.2 < 门槛）。'
  + '**压住它的是门控，不是检测器**；能开口的窗口里它总被更前面的检测器盖过。',
  'foe-energy-high（对面能量 ≥5）：优先级排在第 11 位，所有命中的窗口都先满足了 speed-decides '
  + '或属性检测器，所以它从来没有成为那句建议。',
];

// ── 10 个局面（每个都隔离到它命名的那种局面事实）────────────────────────────
//
// 每个 case 给若干候选参数（seed / team / enemy_team / strategy），按顺序试，
// 取第一个真的出现该局面、且**命名局面是最优先事实**的真实窗口。
// `expectedKind` 是 case 名字对应的检测器；跑出来不是它，就是 K 条判据不满足。
// 隔离注释写明：修复前落在哪、为什么移动、当时是哪个更高优先级的局面在抢。
const CASES = [
  {
    id: '01-ko-now-lethal',
    name: '对手场上残血、我方可以收掉（lethal available）',
    expectedKind: 'ko-now',
    // 修复前：默认队 t3，靠「下一次推进对手真的倒下」间接取证。
    // 现在直接读引擎的收线估算：合法那一招的估算下限 ≥ 对手当前血。
    // 隔离：ko-now 是最优先级里仅次于「必须补位」的一条，双方都残血，没有更高的局面在抢。
    configs: [CFG_A, {seed: 11, strategy: 'greedy_damage'}],
    canAskPlan: (w) => w.phase === 'battle' && w.foe && w.foe.hp > 0 && hpRatio(w) <= 0.6,
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && finishAvailable(w),
    evidence: (w) => {
      const best = legalDamageSamples(w).find((s) => s.min >= w.foe.hp);
      return `对手 ${w.foe.name} ${w.foe.hp}HP；合法招「${best.label}」估 ${best.min}，收得掉`;
    },
  },
  {
    id: '02-energy-short',
    name: '能量不足：关键技能能耗高于当前能量，而那一招正好能收掉',
    expectedKind: 'energy-short',
    // 修复前：默认队 t4（寂灭骨龙 1 能量）。现在还是默认队 t4（3 能量），
    // 判据改成引擎检测器真正看的两件事：更狠的那一招不在合法动作里、能耗 > 当前能量、
    // 而且估算盖得过对面血量（否则它「不值得打断玩家」）。
    // 隔离：我方血量 39% > 35%，所以 switch-low-hp 不会抢；对面也没到残血线。
    configs: [CFG_A, {seed: 11, strategy: 'greedy_damage'}],
    canAskPlan: (w) => w.phase === 'battle' && w.foe && w.foe.hp > 0 && hpRatio(w) <= 0.6,
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && !finishAvailable(w) && blockedDecisive(w),
    evidence: (w) => {
      const preview = previewOf(w);
      const legalNames = new Set(w.damaging.map((d) => d.name));
      const blocked = (preview.samples || []).filter((s) => !legalNames.has(s.label));
      return `${w.me.name} ${w.me.energy} 能量；放不出的「${blocked[0].label}」估 `
        + `${blocked[0].min}~${blocked[0].max} 盖得过对面 ${w.foe.hp} 血`;
    },
  },
  {
    id: '03-switch-low-hp',
    name: '我方场上残血、后备有健康精灵（换人是否值得）',
    expectedKind: 'switch-low-hp',
    // 修复前：默认队 t5。现在用 C 队（音速犬/雪影娃娃/圆号鱼）。
    // 隔离：C 队 t6 也能换人，但那一轮我方**能直接收掉对面**（火云车 414 ≥ 102），
    // ko-now 优先，建议层正确地让人先收——所以窗口推到 t7：这一轮收不掉、只能选换不换。
    configs: [CFG_C, {seed: 5, strategy: 'greedy_damage', team: CFG_C.team}],
    canAskPlan: (w) => w.phase === 'battle' && hpRatio(w) <= 0.35 && healthyBench(w),
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.35 && healthyBench(w)
      && foeRatio(w) > 0.1 && !finishAvailable(w),
    evidence: (w) => `我方 ${w.me.hp}/${w.me.max}；后备 `
      + w.bench.filter((b) => !b.isActive && !b.fainted).map((b) => `${b.name} ${b.hp}/${b.max}`).join('、'),
  },
  {
    id: '04-type-resisted',
    name: '属性被抗：上一手那一招被抵抗、这一轮还在用它',
    expectedKind: 'type-resisted',
    // 第 63 轮重新定位（引擎修复 36832d1 之后）。原阵容是「雪影娃娃镜像」：
    // 修复前 t4 的上一手是普通伤害（倍率 1），属性检测器没被"武装"，建议层那一轮沉默；
    // 修复后 t5/t6 事实仍成立（上一手风吹雪倍率 0.5、那一招这一轮还放得出来），
    // **实际开口也正是 type-resisted**——失败的不是命名事实，而是这一条的隔离判据：
    // 「所有合法招的倍率都 < 1」在修复后不再成立，因为「超级糖果」变成了这一手
    // **合法**且**中性**（倍率 1）的一招（附带效果不再被丢弃，能量与合法动作集合都变了）。
    // 这是矩阵自己的隔离失败（判据停在修复前那一版的合法动作集合上），所以换阵容：
    // 「海豹船长 × 银月狼王」的全部合法攻击招（气波 ×0.25、一拳 ×0.25）都被抵抗，
    // 隔离判据重新成立，期望 kind 不变。
    // 隔离（实测 t6）：我方 208/374 = 55.6%（> 35%，switch-low-hp 不抢）；
    // 对面 389/416 = 93.5%（不残，ko-now 不成立）；这一轮收不掉（finish=false）；
    // 也没有「更狠的那招放不出来」的能量局面（blocked=false）。
    configs: [CFG_J, {seed: 5, strategy: 'greedy_damage', team: CFG_J.team, enemyTeam: CFG_J.enemyTeam}],
    canAskPlan: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && w.damaging.length > 0 && w.damaging.every((d) => d.mult < 1),
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && w.damaging.length > 0 && w.damaging.every((d) => d.mult < 1)
      && resistedHitPending(w) && !finishAvailable(w) && !blockedDecisive(w),
    evidence: (w) => {
      const hit = lastPlayerTypeHit(w);
      return `上一手那一招被抵抗（倍率 ${hit.multiplier}）；这一轮合法招 `
        + w.damaging.map((d) => `${d.name}×${d.mult}`).join('、');
    },
  },
  {
    id: '05-replace-own-faint',
    name: '我方场上倒下、需要补位（phase == replace 且我方 fainted）',
    expectedKind: 'replace-required',
    // 修复前：默认队 t3 的 replace，但那时**倒下的是对手**（对手 0 血、我方 165 血）——
    // 那条 case 名不副实（队友指出）。现在用默认队 t8：我方寂灭骨龙 0/425 且
    // `fainted === true`，补位确实由我方倒下触发；下面还显式断言这个前提。
    configs: [CFG_A, {seed: 5, strategy: 'greedy_damage'}],
    canAskPlan: (w) => w.phase === 'replace' && w.me?.fainted === true,
    isMatch: (w) => w.phase === 'replace' && w.me?.fainted === true && w.switchCount > 0,
    // 装置判据：这个 case 只在「我方自己倒下」时才算数；前提漂了就红，而不是安静换个意思。
    assertWindow: (w) => {
      assert.equal(w.me?.fainted, true,
        'replace 必须由**我方**场上那只倒下触发（me.fainted === true）');
      assert.ok(w.switchCount > 0, '补位必须有可换的目标');
    },
    evidence: (w) => `phase=replace，我方 ${w.me.name} ${w.me.hp}/${w.me.max}（已倒下），`
      + `可选换人 ${w.switchCount} 个`,
  },
  {
    id: '06-ko-now-mid',
    name: '双方都还有余血（52%），但我方这一手刚好够收（收线成立）',
    expectedKind: 'ko-now',
    // 这一格顶替原来被判定为「取不到」的第 2/6/9 条（见 NOT_ISOLATABLE）。
    // 与 01 的区别是血量档位：01 是双方都只剩 8% 的互残局，这里是双方 51.9%、
    // 靠一招威力刚好够线收掉——同样是 ko-now，但局面不是同一个。
    // 第 63 轮重新定位：原阵容「雪影娃娃镜像」在修复后**这个事实再也不出现**——
    // 那一局 t4/t5/t6 我方 54.3% / 54.3% / 48.4% 血、对面同血（都在 35%–60% 档内），
    // 但这个血量下没有一招的估算够线（finish=false）；t7（adv=6）起双方一起掉到
    // 38/442 = 8.6%，滑出档位；到 t10 对面才换成满血的月使鹭纳（362/362），
    // 而我方 83/442 = 18.8%，仍在档外。所以这是**漂移**（事实本身不成立），
    // 实测数字登记在 docs/roco/BROWSER-POSITION-MATRIX.md §3.2，期望 kind 不变。
    // 换成「音速犬 + 圣凯布米龙 + 银月狼王」镜像：t4 双方 190/366 = 51.9%，
    // 火云车估 414 ≥ 190，收线成立。
    // 隔离：ko-now 优先级很高（仅次于补位），血量 51.9% > 35% 也避开了 switch-low-hp。
    configs: [CFG_K, {seed: 5, strategy: 'greedy_damage', team: CFG_K.team}],
    canAskPlan: (w) => w.phase === 'battle' && w.foe && w.foe.hp > 0 && hpRatio(w) <= 0.6,
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && finishAvailable(w),
    evidence: (w) => {
      const best = legalDamageSamples(w).find((s) => s.min >= w.foe.hp);
      return `对手 ${w.foe.name} ${w.foe.hp}HP（我方还有 ${Math.round(hpRatio(w) * 100)}%）；`
        + `合法招「${best.label}」估 ${best.min}，收得掉`;
    },
  },
  {
    id: '07-switch-low-hp-low',
    name: '我方被压到 15%、后备有厚的那只，该不该换',
    expectedKind: 'switch-low-hp',
    // 第二个体感不同的换人局面：G 队（海豹船长/银月狼王/月使鹭纳）对音速犬/黑猫巫师/圆号鱼。
    // 与 03 的区别：这里是 15% 血、对面还有 37%，换人是唯一动作；03 是 28% 血、对面满血。
    // 隔离：这一轮我方收不掉对面（气波 58 < 134），所以 ko-now 不抢。
    configs: [CFG_G, {seed: 5, strategy: 'greedy_damage', team: CFG_G.team, enemyTeam: CFG_G.enemyTeam}],
    canAskPlan: (w) => w.phase === 'battle' && hpRatio(w) <= 0.35 && healthyBench(w),
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) <= 0.35 && healthyBench(w)
      && foeRatio(w) > 0.1 && !finishAvailable(w),
    evidence: (w) => `我方 ${w.me.name} ${w.me.hp}/${w.me.max}；后备 `
      + w.bench.filter((b) => !b.isActive && !b.fainted).map((b) => `${b.name} ${b.hp}/${b.max}`).join('、'),
  },
  {
    id: '08-speed-slower',
    name: '对手比我方快：同一档对拼是它先出手',
    expectedKind: 'speed-decides',
    // 修复前：seed5 默认队 t8（黑猫巫师 70 vs 海豹船长 100）。现在用 conservative_switch t6：
    // 寂灭骨龙 60 vs 雪影娃娃 90。
    // 隔离：我方 51% 血（> 35%，switch-low-hp 不抢）、对面 56%（不残）、这一轮收不掉（诡刺 85 < 247）、
    // 上一手没有带属性倍率的一击（type 检测器不抢）——所以「谁先动」就是这个世界的主要问题。
    configs: [CFG_D, {seed: 5, strategy: 'conservative_switch', enemyTeam: CFG_D.enemyTeam}],
    canAskPlan: (w) => w.phase === 'battle' && w.me && w.foe && hpRatio(w) <= 0.6
      && w.me.spe < w.foe.spe,
    isMatch: (w) => w.phase === 'battle' && w.me && w.foe && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && w.me.spe < w.foe.spe && !finishAvailable(w)
      && noPendingTypeMatchup(w) && !blockedDecisive(w),
    evidence: (w) => `我方 ${w.me.name} 速度 ${w.me.spe}，对手 ${w.foe.name} 速度 ${w.foe.spe}（它更快）`,
  },
  {
    id: '09-speed-faster',
    name: '我方比对手快：这一轮可以先手压上去',
    expectedKind: 'speed-decides',
    // 速度局面的另一半：H 队（秩序鱿墨/圣凯布米龙/雪影娃娃）对画间沉铁兽/化蝶/圆号鱼，
    // 这一轮我方速度 130 vs 对手 92。同一个检测器、**相反的先手方向**，
    // 句子也是另一句（「你速度 X 快过它 Y」）——这是 A 条要求的第 7 种形状。
    configs: [CFG_H, {seed: 11, strategy: 'greedy_damage', team: CFG_H.team, enemyTeam: CFG_H.enemyTeam}],
    canAskPlan: (w) => w.phase === 'battle' && w.me && w.foe && hpRatio(w) <= 0.6
      && w.me.spe > w.foe.spe,
    isMatch: (w) => w.phase === 'battle' && w.me && w.foe && hpRatio(w) <= 0.6 && hpRatio(w) > 0.35
      && foeRatio(w) > 0.1 && w.me.spe > w.foe.spe && !finishAvailable(w)
      && noPendingTypeMatchup(w) && !blockedDecisive(w),
    evidence: (w) => `我方 ${w.me.name} 速度 ${w.me.spe}，对手 ${w.foe.name} 速度 ${w.foe.spe}（我更快）`,
  },
  {
    id: '10-peaceful',
    name: '双方都接近满血、局面平稳（没有值得说的局面事实，应当沉默）',
    expectedKind: null,
    // 没有移动（原来是默认队 t1）。但默认队 t1 其实**不是**「无话可说」：
    // 那一轮 energy-short 检测器是成立的（坟场搏击 e4 放不出、估算 469 盖得过对面 425 血），
    // 只是被主动提示门控按住了（满血 → risk 0.2 < 门槛）。拿它当「平稳」会名不副实。
    // 换成 E 队 t1（双方 442/442）：这一轮连检测器都不开口——超级糖果 e3 放不出，
    // 但它的估算 176 盖不过对面 442 血，所以 energy-short 也主动放弃。
    // 这才是「平稳 = 建议层自己没说」的那种窗口；E 条同时要求它确实是沉默的。
    configs: [CFG_E, {seed: 5, strategy: 'greedy_damage', team: CFG_E.team}],
    canAskPlan: (w) => w.phase === 'battle' && hpRatio(w) >= 0.9 && foeRatio(w) >= 0.9,
    isMatch: (w) => w.phase === 'battle' && hpRatio(w) >= 0.9 && foeRatio(w) >= 0.9,
    evidence: (w) => `我方 ${w.me.hp}/${w.me.max}，对手 ${w.foe.hp}/${w.foe.max}`,
  },
];

// ── 断言 F：不允许编造（hint 说的每个具体事实，同一个局面里必须真的有）──────
//
// 实现搬到了共享装置（`scripts/roco/coach-position-harness.mjs` 的
// `numericFactsOf` / `fabricatedClaims`）：浏览器侧矩阵要用**同一把尺子**核对
// 页面上的气泡，两边各写一份必然漂。判据本身没有放宽——事实来源仍然只有三处：
// 公开视图、`/api/roco/plan` 回执、以及这两份里字符串自带的数字。
test('P1 验收：10 个真实局面各自得到「对路」的建议，且句子在种类上不同',
  {skip: SKIP}, async () => {
    const {post, close} = await startServer();
    const rows = [];
    try {
      for (const c of CASES) {
        let found = null;
        const failures = [];
        for (const config of c.configs) {
          const attempt = await findPosition({post, config, canAskPlan: c.canAskPlan, isMatch: c.isMatch});
          if (attempt.window) { found = {...attempt, config}; break; }
          failures.push(`${describeConfig(config)} → ${attempt.error}`);
        }
        // 这一条是**装置**判据，不是 P1 判据：局面必须真的能从真引擎取到。
        assert.ok(found, `装置失败：${c.id}「${c.name}」在真引擎上取不到。\n  `
          + failures.join('\n  '));

        const {window: w, config, steps} = found;
        // 提示链路必须拿到真规划结果；拿不到就说明装置断了，不是 P1 的问题。
        assert.equal(w.plan?.ok, true, `装置失败：${c.id} 的 /api/roco/plan 没成功：`
          + `${w.plan?.error || '（没有回执）'}`);
        if (c.assertWindow) c.assertWindow(w);

        const detail = rocoIntervention({
          view: w.rawView,
          session: freshSession(),
          plan: w.plan,
          host: {focus: true, preference: 'gentle'},
          now: 1000,
        });
        const spoken = rocoInterventionText(detail, w.plan);
        rows.push({
          id: c.id,
          name: c.name,
          expectedKind: c.expectedKind,
          observedKind: detail.advice?.kind ?? null,
          config: describeConfig(config),
          steps,
          turn: w.turn,
          phase: w.phase,
          action: detail.action,
          gate: detail.gate,
          evidence: c.evidence(w),
          text: spoken ? spoken.text : null,
          shape: spoken ? shapeOfWithNames(spoken.text) : null,
          recommendation: w.plan?.recommendation ?? null,
          window: w,
        });
      }
    } finally {
      close();
    }

    // ── 给人看的表：局面 → 期望/实际 kind → 形状 → 原句 ──────────────────
    const spokenRows = rows.filter((r) => r.text != null);
    const shapeCounts = new Map();
    for (const r of spokenRows) shapeCounts.set(r.shape, (shapeCounts.get(r.shape) || 0) + 1);
    const kindCounts = new Map();
    for (const r of rows) {
      if (!r.observedKind) continue;
      kindCounts.set(r.observedKind, (kindCounts.get(r.observedKind) || 0) + 1);
    }
    const width = Math.max(...rows.map((r) => r.name.length)) + 2;
    const table = rows.map((r) => [
      r.id.padEnd(24),
      r.name.padEnd(width),
      `kind=${r.observedKind ?? '（无建议）'}`.padEnd(24),
      (r.shape || '（silent：没有文案）'),
      '|',
      (r.text || '').replace(/\n/g, ' '),
    ].join(' '));
    console.log('\n=== 10 个隔离过的真实局面上的真实建议 =====================================');
    console.log(`局面 → 实际 kind → 形状 → 原句（共 ${spokenRows.length}/${rows.length} 个局面开口）`);
    for (const line of table) console.log(line);
    console.log('\n--- 形状统计（引号内容/数字/精灵名/技能名 → 占位符）---------------------');
    for (const [shape, count] of [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(2)} × ${shape}`);
    }
    console.log(`  不同形状 ${shapeCounts.size} 种；开口局面 ${spokenRows.length} 个`);
    console.log('\n--- 检测器 kind 统计 ----------------------------------------------------');
    for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(2)} × ${kind}`);
    }
    console.log(`  不同 kind ${kindCounts.size} 种`);
    console.log('\n--- 每个局面的取证（真引擎参数）-----------------------------------------');
    for (const r of rows) {
      console.log(`  ${r.id} ${r.config} | 推进 ${r.steps} 步到 turn ${r.turn}（phase=${r.phase}）`);
      console.log(`      证据：${r.evidence}`);
      console.log(`      期望 kind=${r.expectedKind ?? '（应当沉默）'} → 实际 kind=${r.observedKind ?? '（无建议）'}`
        + `；判定 ${r.action}${r.gate ? `（硬门控 ${r.gate}）` : ''}；plan 推荐=${r.recommendation ?? '（无）'}`);
    }
    console.log('\n--- 取不到「隔离窗口」的检测器（覆盖缺口，不是断言失败）-----------------');
    for (const line of NOT_ISOLATABLE) console.log(`  · ${line}`);
    console.log('=========================================================================\n');

    // 局面之间必须真的不同（同一局面的复述不算十个局面）。
    const signatures = rows.map((r) => `${r.config}|turn ${r.turn}|${r.phase}|${r.evidence}`);
    assert.equal(new Set(signatures).size, rows.length,
      `有局面重复了，装置不对：\n${signatures.join('\n')}`);

    // ── 验收判据 A–G + K ────────────────────────────────────────────────
    // 全部跑完再一起报：一次运行就能看到「哪几条不满足」，而不是被第一条挡住。
    const problems = [];
    const listing = () => `\n形状统计：\n`
      + [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `  ${n} × ${s}`).join('\n')
      + `\n（每个局面 → kind → 形状 → 原句的完整表已打印在测试输出里）`;

    // ── K：每个 case 必须真的说出它命名的那种局面 ────────────────────────
    for (const r of rows) {
      if (r.observedKind !== r.expectedKind) {
        problems.push(`K：${r.id}「${r.name}」期望 kind=${r.expectedKind ?? '（应当沉默）'}，`
          + `实际 kind=${r.observedKind ?? '（无建议）'}`
          + `${r.text ? `；原句：${r.text}` : ''}。窗口隔离没做到，case 名与断言已经漂了`);
      }
    }

    // ── A：至少 6 种不同形状 ─────────────────────────────────────────────
    if (shapeCounts.size < 6) {
      problems.push(`A：只有 ${shapeCounts.size} 种句子形状（要求 ≥6）。${listing()}`);
    }

    // ── B：没有哪一种形状占到开口局面的 60% 以上 ─────────────────────────
    const worst = [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = worst && spokenRows.length ? worst[1] / spokenRows.length : 0;
    if (spokenRows.length === 0) {
      problems.push('B：没有任何局面开口，这条判据没有意义');
    } else if (share > 0.6) {
      problems.push(`B：形状「${worst[0]}」占了 ${worst[1]}/${spokenRows.length} = `
        + `${(share * 100).toFixed(0)}%（上限 60%）。这就是「同一模板换数字」：\n`
        + rows.filter((r) => r.shape === worst[0]).map((r) => `  ${r.id} ${r.text}`).join('\n')
        + listing());
    }

    // ── C：没有工程词汇，也不能有花括号 ──────────────────────────────────
    for (const r of spokenRows) {
      for (const word of FORBIDDEN) {
        if (r.text.includes(word)) {
          problems.push(`C：${r.id} 的提示里出现了工程词汇「${word}」：${r.text}`);
        }
      }
      if (/[{}]/.test(r.text)) problems.push(`C：${r.id} 的提示里有花括号：${r.text}`);
    }

    // ── D：开口就必须点出动作或一个具体观察 ─────────────────────────────
    for (const r of spokenRows) {
      if (!namesSomething(r.text)) {
        problems.push(`D：${r.id} 的提示既没有点名动作/技能/精灵，`
          + `也没有明确的「先观察」立场：${r.text}`);
      }
    }

    // ── E：平稳局面要么不说话，要么说的是有区分度的形状 ─────────────────
    const peaceful = rows.find((r) => r.id === '10-peaceful');
    if (!['silent', 'defer_to_review'].includes(peaceful.action)) {
      if (!peaceful.text) problems.push(`E：平稳局面开口了却没有文案：${JSON.stringify(peaceful)}`);
      else if (!shapeCounts.has(peaceful.shape)) {
        problems.push(`E：平稳局面说的形状不在本次统计里：${peaceful.shape}`);
      }
    }

    // ── F：不编造 —— 每个具体事实都要在同一个局面里找得到 ────────────────
    for (const r of spokenRows) {
      const claims = fabricatedClaims(r.text, r.window);
      for (const claim of claims) problems.push(`F：${r.id} 的提示${claim}：${r.text}`);
    }

    // ── G：至少 6 种不同的检测器 kind ────────────────────────────────────
    if (kindCounts.size < 6) {
      problems.push(`G：只有 ${kindCounts.size} 种检测器 kind（要求 ≥6）：\n`
        + [...kindCounts.entries()].map(([k, n]) => `  ${n} × ${k}`).join('\n'));
    }

    assert.ok(problems.length === 0,
      `P1 验收未通过，共 ${problems.length} 条判据不满足（A/B/C/D/E/F/G/K）：\n\n`
      + problems.join('\n\n'));
  });
