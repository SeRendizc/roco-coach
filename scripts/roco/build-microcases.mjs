// 生成 evals/roco/cases/microcases-v1.jsonl —— 下一轮「真实规则引擎」的 microcase 计划。
//
// 关键定位（必须诚实）：
//   本文件是**计划**，不是通过记录。所有 cases 的 `verification.level` 是
//   `planned` / `documented_text_only`，**没有**任何一条已经在代码里通过。
//
// 为什么不是空的：主快照自带 Terms.lua 术语表，里面有 54 条**机制文本定义**，
//   包括「回合结束时」这类明确时序词与「先手」「应对攻击」的完整定义。
//   因此本轮可以把「文本说了什么」与「文本没说什么」精确区分开，
//   并把「没说什么」变成必须由 microcase 回答的问题。
//
// 证据等级（evidence level）：
//   A_glossary_text  = 快照术语表有明确定义文本
//   B_description    = 技能描述里有说明
//   C_inference      = 只能从多处文本推断，**必须**用实测确认
//   D_unknown        = 完全没有证据

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const N = 'data/roco/normalized/roco-world-s4-2026-09-10/';
const skills = JSON.parse(readFileSync(N + 'skills.json', 'utf8')).skills;
const terms = JSON.parse(readFileSync(N + 'terms.json', 'utf8')).terms;
const pets = JSON.parse(readFileSync(N + 'pets.json', 'utf8')).pets;
const sm = JSON.parse(readFileSync(N + 'support-matrix.json', 'utf8')).pets;
const history = JSON.parse(readFileSync(N + 'history.json', 'utf8'));

const SRC = {
  primary: { source_id: 'wiki-rocom-snapshot', revision: 'aff808eb60003457fe8a260d1ac3c9bd95d53872', file: 'Terms.lua / Skills.lua / Catalog.lua' },
  note: '全部为一手社区归档的**文本**；没有任何游戏内实测、抓包或官方配置。',
};

function term(id) {
  const t = terms[String(id)];
  return t ? { term_id: String(id), note: t.note, desc: t.desc } : null;
}
function skillByName(name) {
  const hit = Object.entries(skills).find(([, s]) => s.name === name);
  return hit ? { skill_id: hit[0], ...hit[1] } : null;
}
function petByName(name) {
  const hit = Object.entries(pets).find(([, p]) => p.name === name && !p.title?.includes('（') || (p.name === name && p.title === name));
  const any = Object.entries(pets).find(([, p]) => p.name === name);
  const [id, p] = hit ?? any ?? [];
  return p ? { pet_id: id, ...p } : null;
}
function traitOf(petName) {
  const p = petByName(petName);
  if (!p) return null;
  const t = skills[p.feature_skill_id];
  return t ? { trait_skill_id: p.feature_skill_id, name: t.name, desc: t.desc } : null;
}

const cases = [];
const add = (o) => cases.push(o);

// ══════════════════════════════════════════════════════════════════════
// P0：必须先确定「谁先动」与「同一时刻发生什么」。这四条不成立，
//     后面所有伤害与状态的数字都无法解释。
// ══════════════════════════════════════════════════════════════════════

add({
  case_id: 'MC-001',
  title: '行动优先级：先手度是否完全压过速度',
  priority: 'P0',
  category: 'priority',
  why_it_matters: '决定所有后续 case 的行动顺序基准；顺序错了，伤害与状态的先后全部错。',
  initial_state: {
    note: '构造同回合双方都出招的最小局面。',
    side_a: { pet: '音速犬', position: 1, hp_pct: 100, energy: 6 },
    side_b: { pet: '寂灭骨龙', position: 1, hp_pct: 100, energy: 6 },
    environment: null,
  },
  public_observation: ['双方当前精灵、生命百分比、能量、已选技能（公开前不可见）'],
  legal_actions: {
    side_a: ['火苗(能耗0)', '先发制人(能耗2, 描述含「先手+1」)'],
    side_b: ['诡刺(能耗0)', '坟场搏击(能耗4)'],
    known: true,
    note: '技能能耗与描述来自 Skills.lua，属已解析字段。',
  },
  joint_actions: [
    { side_a: '先发制人(先手+1)', side_b: '坟场搏击(无先手)', question: '先发制人是否先动，即使音速犬速度更低？' },
    { side_a: '先发制人(先手+1)', side_b: '先发制人(先手+1)', question: '双方先手度相同时，比较速度还是随机？' },
  ],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1020', quote: term(1020)?.desc, settled: '先手度更高的技能忽略双方速度差异，优先释放；先手度可叠加。' },
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('先发制人')?.skill_id}`, quote: skillByName('先发制人')?.desc, settled: '「先发制人」描述写「先手+1」。' },
  ],
  unresolved_questions: [
    '先手度的**数值刻度**未知：是先手+1 就绝对优先，还是在某个共享序列里比较？',
    '先手度是否可与其他「先手」叠加到超过对手的先手度？（文本说可叠加，但没给上限）',
    '先手与「应对攻击」（术语 1016 说「本次行动必定先手」）哪个更强？',
    '双方先手度完全相同、速度也相同时如何裁决？（文本没说，不得假定为随机或固定顺序）',
  ],
  verification: { level: 'documented_text_only', passed: false, how_to_verify_next_round: '在 roco_env 中实现先手度字段与排序，用本 case 的 2 组联合动作断言事件顺序；再用两组交叉先手度验证「可叠加」。' },
});

add({
  case_id: 'MC-002',
  title: '同速裁决：速度完全相同时谁先动',
  priority: 'P0',
  category: 'speed_tie',
  why_it_matters: '旧 Demo 用 seed 随机裁决；手游是否有确定性规则（站位/入场顺序/随机）未知，直接影响可复现性。',
  initial_state: {
    side_a: { pet: '音速犬', hp_pct: 100, energy: 6, speed_stat: 120 },
    side_b: { pet: '待定（需同速精灵）', hp_pct: 100, energy: 6, note: '12 只目标里速度值分别为 60/70/90/92/100/105/115/130/130 —— 需构造同速或人为对齐' },
  },
  public_observation: ['双方速度面板'],
  legal_actions: { side_a: ['火苗(无先手)'], side_b: ['同威力的无先手技能'], known: true },
  joint_actions: [{ side_a: '无先手技能', side_b: '无先手技能', question: '同速且同先手度时的事件顺序由什么决定？' }],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1020', quote: term(1020)?.desc, settled: '文本只定义了「先手度更高者优先」，**没有**定义同先手度同速的裁决。' },
  ],
  unresolved_questions: [
    '同速是否真的存在确定性规则，还是内部随机？',
    '若随机：随机源是否可按 seed 复现？（决定 replay 是否可能）',
    '站位（1号位/2号位）是否参与裁决？',
    '文本中的「传动」会改变技能位置（术语 1033），位置是否也影响出手顺序？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '同一 seed 重复回放 1000 次，统计同速局的先手分布；若为随机则记录分布并确保 replay 可复现。' },
});

add({
  case_id: 'MC-003',
  title: '同时行动：双方行动是否基于同一事前状态',
  priority: 'P0',
  category: 'simultaneous_action',
  why_it_matters: '这是隐藏信息与公平性的根：如果后手能看到先手的结果再决定，教练就会算出虚假的因果。',
  initial_state: {
    side_a: { pet: '音速犬', hp_pct: 100, energy: 6 },
    side_b: { pet: '海豹船长', hp_pct: 100, energy: 6 },
  },
  public_observation: ['仅事前状态；双方本次选择在结算前互不可见'],
  legal_actions: { side_a: ['火苗', '防御'], side_b: ['气波', '水泡盾'], known: true },
  joint_actions: [
    { side_a: '火苗', side_b: '气波', question: '双方是否都基于「结算前」的状态决定？' },
    { side_a: '火苗', side_b: '水泡盾(应对攻击)', question: '水泡盾的「应对」是否在看见火苗后才成立？' },
  ],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1016', quote: term(1016)?.desc, settled: '「应对攻击」定义为「若敌方使用攻击技能，则本技能应对成功」——意味着**判定发生在双方选择之后**，但选择本身必须是事前独立做出的。' },
  ],
  unresolved_questions: [
    '双方向时选择是否在同一事前状态上判定？（推测是，但无文本明证）',
    '「应对」的判定是否在结算开始前统一进行？',
    '若一方在结算中先倒下，其「应对」是否仍生效？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '实现 step_joint(a, b) 强制同一事前状态；写一个泄漏测试：让后计算的策略无法读取对手已提交动作。' },
});

add({
  case_id: 'MC-004',
  title: '出手顺序的完整排序键与并列时的逐项降级',
  priority: 'P0',
  category: 'trigger_order',
  why_it_matters: '把 MC-001/002 的结果合成一个可实现的排序函数，是引擎的第一个真实组件。',
  initial_state: { note: '构造能同时触发多级排序键的局面。' },
  public_observation: ['双方精灵、速度、所选技能的先手度'],
  legal_actions: { known: true, note: '候选含：无先手攻击、先手+1 攻击、防御技能（「应对」时必定先手）、换宠' },
  joint_actions: [{ side_a: '（多组）', side_b: '（多组）', question: '排序键的完整层级是什么？' }],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1020', quote: term(1020)?.desc },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1015/1016/1017', quote: `${term(1015)?.desc} / ${term(1016)?.desc}`, settled: '三种「应对」都写「本次行动必定先手」。' },
  ],
  unresolved_questions: [
    '排序键候选：应对成功 > 先手度 > 速度 > ???。哪一层在上？',
    '「必定先手」是否压过一切先手度，还是等同一个大先手度值？',
    '主动换宠在排序里的位置？（术语 1005「迅捷」暗示主动换入有特殊待遇）',
    '道具/其他行动是否参与同一排序？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '写 orderActions(state, a, b) 返回有序数组；用 8—12 组联合动作覆盖每一层键的降级。' },
});

// ══════════════════════════════════════════════════════════════════════
// P1：换宠 / 补位 / 能量 —— 手游与旧 Demo 差异最大的地方
// ══════════════════════════════════════════════════════════════════════

add({
  case_id: 'MC-005',
  title: '主动换宠是否占整回合，以及「迅捷」的触发条件',
  priority: 'P1',
  category: 'voluntary_switch',
  why_it_matters: '旧 Demo 假设换宠占整回合。手游有一整套换入相关术语（迅捷/迸发/返场），说明这条规则与旧假设不同。',
  initial_state: {
    side_a: { pet: '音速犬', bench: ['海豹船长'] },
    side_b: { pet: '雪影娃娃' },
  },
  public_observation: ['双方场上与后备'],
  legal_actions: { side_a: ['技能', '换上后备', '道具'], side_b: ['技能'], known: true },
  joint_actions: [
    { side_a: '换上后备', side_b: '攻击', question: '换入的精灵是否当回合承伤？' },
    { side_a: '换上后备', side_b: '攻击', question: '换入后是否能再行动？' },
  ],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1005', quote: term(1005)?.desc, settled: '「迅捷」：**通过主动更换精灵的方式入场时**，使用第一个能量满足要求、并带有迅捷的技能。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1009', quote: term(1009)?.desc },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1010', quote: term(1010)?.desc, settled: '「迸发」：入场后的首次行动获得额外效果。' },
    { level: 'C_inference', ...SRC.primary, locator: 'Terms.lua#1005+1010 组合', settled: '既然主动换入能触发「迅捷」并在入场首发触发「迸发」，换宠**很可能不占整回合**，或换入后有独立行动窗口。这与旧 Demo「换宠占整回合」的假设冲突。' },
  ],
  unresolved_questions: [
    '主动换宠到底占不占整回合？',
    '「迅捷」只对第一个满足能量要求的迅捷技能生效 —— 若第一个不满足，是否顺延到下一个？',
    '换入当回合被动承伤的顺序？',
    '「本回合入场的精灵免疫此效果」（术语 1003/1024）中的「此效果」具体指哪些效果？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '为「主动换入」单独建 microcase 组，覆盖：无迅捷技能 / 第一个迅捷技能能量不足 / 换入后攻击 / 换入当回合被击倒。' },
});

add({
  case_id: 'MC-006',
  title: '力竭后补位是否免费，以及多只同时力竭的补位队列',
  priority: 'P1',
  category: 'knockout_replacement',
  why_it_matters: '旧 Demo 有「强制补位不消耗回合」的实现；手游术语把「离场」明确排除力竭（术语 3009），说明力竭下场与主动离场是两套逻辑。',
  initial_state: {
    side_a: { active_hp: 1, bench: ['海豹船长', '圆号鱼'] },
    side_b: { active_hp: 1, bench: ['黑猫巫师', '音速犬'] },
  },
  public_observation: ['双方场上生命、存活后备'],
  legal_actions: { known: true, note: '含攻击（可能同时击倒双方）' },
  joint_actions: [
    { side_a: '致死后手', side_b: '致死后手', question: '双方同时力竭时，补位顺序是什么？' },
    { side_a: '攻击', side_b: '攻击', question: '补位是否消耗回合？' },
  ],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#3009', quote: term(3009)?.desc, settled: '「离场」明确**不包括**精灵力竭后下场 —— 即力竭下场与主动离场是不同事件。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1003/1024/1026', quote: `${term(1003)?.desc} / ${term(1024)?.desc} / ${term(1026)?.desc}`, settled: '三种离场效果都写「本回合入场的精灵免疫此效果」。' },
  ],
  unresolved_questions: [
    '力竭补位是否免费（不消耗回合）？',
    '双方同回合都力竭时，补位顺序与「免疫此效果」如何交互？',
    '补位入场的精灵是否触发「迸发」？',
    '全部力竭与「同归于尽」的判定顺序？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '构造双方同回合致死的局面，断言补位队列与回合计数不变。' },
});

add({
  case_id: 'MC-007',
  title: '能量的回合内结算顺序：消耗、回复、上限与返还',
  priority: 'P1',
  category: 'energy',
  why_it_matters: '能量是所有技能的成本基准。旧 Demo 是「上限6、每回合+1」，手游上限可见为 6+（能耗最高 5），顺序未知。',
  initial_state: {
    side_a: { pet: '音速犬', energy: 1 },
    side_b: { pet: '寂灭骨龙', energy: 1 },
  },
  public_observation: ['双方能量'],
  legal_actions: { side_a: ['火苗(能耗0, 描述含「自己回复1能量」)', '火云车(能耗5)'], side_b: ['诡刺(能耗0)'], known: true },
  joint_actions: [{ side_a: '火苗(回1能量)', side_b: '诡刺', question: '技能自带的回能与回合末回能是否叠加？顺序如何？' }],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('火苗')?.skill_id}`, quote: skillByName('火苗')?.desc, settled: '「火苗」：造成物伤，自己回复1能量。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1006', quote: term(1006)?.desc, settled: '术语表出现「回复能量」相关条目（如雪替身「回复能量等于被应对技能能耗的2倍」、蜡质膜「回复3能量」）。' },
  ],
  unresolved_questions: [
    '能量上限是多少？（当前快照只给出每条技能的能耗，未给出上限字段）',
    '回合末是否自动回能？回多少？',
    '技能自带回能与回合末回能的先后顺序（影响是否会溢出浪费）？',
    '能量能否为负/是否会挡住不满足能耗的技能？（推测是，但需实测）',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '为能量建立独立 oracle：给定初始能量与行动序列，逐回合断言能量值，覆盖溢出与不足两种边界。' },
});

// ══════════════════════════════════════════════════════════════════════
// P2：状态 / 印记 / 伤害取整
// ══════════════════════════════════════════════════════════════════════

add({
  case_id: 'MC-008',
  title: '状态持续与衰减：灼烧「衰减一半层数」的取整方向',
  priority: 'P2',
  category: 'status_duration',
  why_it_matters: '文本给出的是「层数」与「百分比」，但层数减半在奇数值时必须确定取整方向，否则每回合伤害都会差一档。',
  initial_state: {
    side_a: { pet: '音速犬', note: '携带能施加灼烧的技能' },
    side_b: { pet: '雪影娃娃', hp_pct: 100, note: '冰系，非火系，不免疫灼烧' },
  },
  public_observation: ['双方生命百分比', '目标身上的灼烧层数（若公开）'],
  legal_actions: { known: true, note: '含施加灼烧的技能与不施加的技能' },
  joint_actions: [{ side_a: '施加 N 层灼烧', side_b: '任意', question: '回合末结算后层数变成多少？' }],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1002', quote: term(1002)?.desc, settled: '「灼烧」：回合结束时，造成 2% 生命的火系伤害，**并衰减一半层数**。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1001', quote: term(1001)?.desc, settled: '「中毒」：回合结束时，造成 3% 生命的毒系伤害。**注意：中毒没有写衰减**，与灼烧不同。' },
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('焚烧烙印')?.skill_id}`, quote: skillByName('焚烧烙印')?.desc, settled: '「焚烧烙印」：驱散双方所有印记，每驱散 1 层，敌方获得 5 层灼烧 —— 说明灼烧是**层数**制。' },
  ],
  unresolved_questions: [
    '「衰减一半」在奇数值时向上还是向下取整？（未定义）',
    '层数是否影响这次伤害的量，还是只影响剩余层数？（文本读起来只影响后续）',
    '「2% 生命」的分母是最大生命还是当前生命？',
    '2% 的取整方向？',
    '灼烧与中毒能否同时存在？层数是否分别独立？',
    '换宠下场后层数是否保留、是否暂停？（术语 3009 只说离场定义）',
  ],
  verification: { level: 'documented_text_only', passed: false, how_to_verify_next_round: '构造 1/2/3/4 层灼烧，断言每回合伤害与层数序列；同时构造中毒对照，验证「灼烧衰减、中毒不衰减」。' },
});

add({
  case_id: 'MC-009',
  title: '印记：同时只能各一个正负印记时的替换规则',
  priority: 'P2',
  category: 'marks',
  why_it_matters: '术语表给出了「最多 1 正 + 1 负」这一硬上限，但替换时旧印记是被移除还是被拒绝，直接决定局面状态空间。',
  initial_state: {
    side_a: { pet: '寂灭骨龙', note: '可施加降灵印记' },
    side_b: { pet: '雪影娃娃' },
  },
  public_observation: ['场上印记（术语 3010 说下场不消失，说明它是场地级状态）'],
  legal_actions: { known: true, note: '含多个施加印记的技能' },
  joint_actions: [{ side_a: '施加第二个正面印记', side_b: '任意', question: '已有 1 个正面印记时，新的正面印记如何处置？' }],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#3010', quote: term(3010)?.desc, settled: '「印记」：精灵下场后印记不会消失，新入场精灵继承；**精灵最多同时拥有 1 种正面印记和 1 种负面印记**。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1014/1018/1019/1021/1022/1023/1027/1028/1030/1031/1032/1035/3012/3020', settled: '术语表登记了至少 14 种印记，包括攻击/棘刺/光合/湿润/蓄电/风起/降灵/蓄势/龙噬/减速/星陨/萌芽/暗涌/中毒印记，全部写「印记效果」。' },
  ],
  unresolved_questions: [
    '施加第二种同类印记时：替换 / 叠加层数 / 拒绝？（三种都可能，必须实测）',
    '哪些印记算「正面」、哪些算「负面」？（只有 3010 给了分类概念，未给清单）',
    '印记归属：是「精灵拥有」还是「场地拥有」？术语 3010 同时说「精灵下场不消失」与「精灵最多拥有」，口径需澄清。',
    '星陨印记的「消耗全部层数」与其他印记的层数语义是否一致？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '为印记建独立状态机；用两个同类印记 + 一个异类印记覆盖替换与并存两类断言。' },
});

add({
  case_id: 'MC-010',
  title: '动态/条件威力的取值时机与取整',
  priority: 'P2',
  category: 'dynamic_damage',
  why_it_matters: '实施书硬性验收项之一：「动态威力不会被当 0 伤害」。本轮已量化该风险：A 组六个技能池中有 6—13 个技能属条件化威力。',
  initial_state: {
    side_a: { pet: '寂灭骨龙', energy: 6, note: '准备使用「坟场搏击」' },
    side_b: { pet: '海豹船长', energy: 0, note: '敌方能量为判定输入' },
  },
  public_observation: ['双方能量', '技能描述'],
  legal_actions: { side_a: ['坟场搏击(静态威力 180，描述：敌方每有1能量，本次技能威力-10%)'], side_b: ['任意'], known: true },
  joint_actions: [
    { side_a: '坟场搏击', side_b: '任意', question: '敌方能量=0 时威力为 180；敌方能量=6 时威力是多少？' },
    { side_a: '穿膛(若敌方能量≤2造成5倍伤害)', side_b: '能量=2 或 =3', question: '阈值边界是否包含等于？' },
  ],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('坟场搏击')?.skill_id}`, quote: skillByName('坟场搏击')?.desc, settled: '「坟场搏击」静态 power=180，描述附加「敌方每有1能量，本次技能威力-10%」。' },
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('穿膛')?.skill_id}`, quote: skillByName('穿膛')?.desc, settled: '「穿膛」静态 power=65，描述「若敌方能量小于等于2，造成5倍伤害」。' },
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('偷袭')?.skill_id}`, quote: skillByName('偷袭')?.desc, settled: '「偷袭」静态 power=85，描述「应对状态：本次技能威力变为3倍」。' },
    { level: 'C_inference', ...SRC.primary, locator: 'skills.json 统计', settled: 'A 组六只的技能池中，条件化/动态威力技能数为 8/7/3/1/3/8。静态 power 只是**基准值**，不是最终伤害。' },
  ],
  unresolved_questions: [
    '条件化威力是在**选择技能时**还是**结算时**计算？（对手能量可能在同回合变化）',
    '「-10%/能量」是加法叠加还是乘法叠加？',
    '威力计算后的取整方向与时机（先乘后加还是先加后乘）？',
    '「造成5倍伤害」是威力×5 还是最终伤害×5？（两者在防御/相性下结果不同）',
    '多个条件同时命中时（如既有应对又满足阈值）如何复合？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '为每个条件化技能建参数化 case，扫过阈值两侧各一个值；断言威力计算中间值而非只看最终伤害。' },
});

add({
  case_id: 'MC-011',
  title: '百分比伤害与回复的取整方向',
  priority: 'P2',
  category: 'rounding',
  why_it_matters: '状态伤害（2%/3%/5%）与回复都是百分比；取整方向不同会在多回合后累积成胜负差异。',
  initial_state: {
    side_a: { pet: '寂灭骨龙', max_hp: 120, hp: 120, note: '生命 120 便于构造非整除百分比' },
    side_b: { pet: '铁甲（待选）', max_hp: 377, note: '化蝶生命 377，2%=7.54、3%=11.31、5%=18.85，三种都非整数' },
  },
  public_observation: ['双方最大生命与当前生命'],
  legal_actions: { known: true },
  joint_actions: [{ side_a: '施加灼烧(2%)', side_b: '施加中毒(3%)', question: '各自每回合扣多少？' }],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1001/1002/1004', quote: `${term(1001)?.desc} | ${term(1002)?.desc} | ${term(1004)?.desc}`, settled: '中毒 3% 生命、灼烧 2% 生命、冻结 5% 生命 —— 三处都是百分比，且**都没有写取整方向**。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1019/1029/1035', quote: `${term(1019)?.desc} | ${term(1029)?.desc}`, settled: '棘刺印记「失去6%生命」、吸血「根据吸血比例和造成伤害值」、星陨「额外的幻系伤害」也都是百分比/比例，同样未写取整。' },
  ],
  unresolved_questions: [
    '百分比基数：最大生命 vs 当前生命？（术语 1004 写「若当前生命低于冻结比例」，暗示百分比按**最大生命**算而比较用当前生命）',
    '取整方向：floor / round / ceil？',
    '多个百分比效果同回合生效时，是各自独立取整还是先求和再取整？',
    '吸血回复量的取整方向是否与伤害一致？',
    '是否存在最小伤害为 1 的下限？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '用最大生命 120/377/599 构造非整除样本，对每种百分比断言实际扣血值，覆盖三种取整假设。' },
});

add({
  case_id: 'MC-012',
  title: '回合内的触发顺序：伤害、状态、印记、回能、离场的先后',
  priority: 'P2',
  category: 'trigger_order',
  why_it_matters: '这是「一个回合」的完整事件序。术语表只定义了「回合结束时」，没有定义组内顺序。',
  initial_state: {
    side_a: { pet: '寂灭骨龙', hp_pct: 20, note: '携带能触发回合末效果的技能' },
    side_b: { pet: '圆号鱼', hp_pct: 20, note: '特性「泛音列」与回合末效果相关' },
  },
  public_observation: ['双方生命、状态、印记、能量'],
  legal_actions: { known: true },
  joint_actions: [{ side_a: '同时命中多个回合末效果', side_b: '同时命中多个回合末效果', question: '回合末效果的处理顺序？' }],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1001/1002/1004/1021/1029', settled: '存在明确写「回合结束时」的效果：中毒、灼烧、冻结、光合印记（回合结束获得1能量）、以及多种特性（养分重吸收「回合结束时回复3能量」、生长「回合结束时回复12%生命」、警惕「回合结束时若能量为0则脱离」）。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1008', quote: term(1008)?.desc, settled: '「寄生」：回合结束时从寄生来源吸收2%生命 —— 涉及**跨精灵**的回血/扣血配对。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1033', quote: term(1033)?.desc, settled: '「传动」：**回合开始时**带有「传动X」的技能向下移动X个位置 —— 这是回合开始时的效果，与回合末效果分属两端。' },
  ],
  unresolved_questions: [
    '回合末多个效果（中毒/灼烧/寄生/光合印记/特性）的执行顺序？',
    '同一精灵的多个回合末效果，顺序是否固定？跨精灵是否按速度排序？',
    '若回合末伤害导致力竭，后续回合末效果是否仍触发？',
    '「回合开始时」的传动效果与「回合结束时」效果的边界在哪？',
    '回合末回能与能量消耗在时序上谁先？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '实现显式事件队列并输出有序事件流；用「一回合内同时挂满 5 种回合末效果」的局面断言序列。' },
});

// ══════════════════════════════════════════════════════════════════════
// P3：隐藏信息 —— 产品红线，必须单独验收
// ══════════════════════════════════════════════════════════════════════

add({
  case_id: 'MC-013',
  title: '隐藏信息：教练观察面不得包含对手待执行动作与真实随机种子',
  priority: 'P0',
  category: 'hidden_information',
  why_it_matters: '这是产品红线（「Demo 中不得读取电脑下一手」）也是 PVP 公平性的前提。属于**必须由测试强制**的不变量，不能靠约定。',
  initial_state: {
    note: '构造双方都已选但尚未结算的局面。',
    side_a: { submitted_action: '火苗（仅 A 可见）' },
    side_b: { submitted_action: '水泡盾（仅 B 可见）' },
  },
  public_observation: [
    '双方当前精灵与生命/能量面板',
    '已公开的历史事件',
    '双方存活后备数量',
  ],
  legal_actions: { known: true, note: '合法动作集合本身公开，但**选择结果**不公开' },
  joint_actions: [{ side_a: '（已提交）', side_b: '（已提交）', question: 'A 的观察里能否出现 B 的已提交动作？' }],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'C_inference', ...SRC.primary, locator: 'terms.json', settled: '术语 3024「木桶状态」与 3025「月陨星状态」都写「该状态下会**隐藏精灵的信息**，自己行动或被敌方攻击时解除」——说明游戏本身存在信息隐藏机制，因此观察面必须显式建模。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#3024/3025', quote: `${term(3024)?.desc} / ${term(3025)?.desc}` },
  ],
  unresolved_questions: [
    '「隐藏精灵的信息」隐藏到什么粒度？（仅技能？还是连面板也隐藏？）',
    '隐藏状态下教练应看到什么？（必须 fail closed，不能猜）',
    '对手的**已知历史**（如上一回合出招）是否属于公开信息？',
    '这些隐藏状态在 PVP 与 PVE 下是否一致？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '写 observe(player) 返回双方视角；断言 A 的观察序列化结果中不出现 B 的未公开字段（字符串与结构双重检查），并覆盖隐藏状态。' },
});

// ══════════════════════════════════════════════════════════════════════
// P4：A 组特性 —— 直接影响 6 只候选配招能否落地
// ══════════════════════════════════════════════════════════════════════

const A_TRAITS = [
  { pet: '寂灭骨龙', expect: '力竭4回合后复活', question: '复活后生命/能量/状态/印记如何初始化？「4回合」从哪一刻开始计？能被再次触发吗？', case_id: 'MC-014' },
  { pet: '海豹船长', expect: '己方精灵每应对1次，自己入场时水系和武系技能威力+20%', question: '「应对1次」的计数范围（整局/单场/离场清空？）；+20% 是加法叠加还是乘法；是否只影响自己入场当回合？', case_id: 'MC-015' },
  { pet: '黑猫巫师', expect: '若敌方技能足够击败自己，回合开始时自己获得速度+50', question: '「足够击败自己」的判定是否使用真实伤害公式（而我们没有公式）？「回合开始」在事件序的哪个位置？速度+50 是绝对加值还是百分比？', case_id: 'MC-016' },
  { pet: '圆号鱼', expect: '使用状态技能后，敌方获得「聒噪」技能的效果，持续3回合', question: '「聒噪」的效果已由数据解答为「敌方获得全攻击技能能耗+2，持续3回合」；仍待解的是：与湿润印记(-1)等能耗修改的复合顺序与上下限。', case_id: 'MC-017', resolved: '聒噪 = skill_000274：敌方获得全攻击技能能耗+2，持续3回合。与特性「泛音列」的描述一致。' },
  { pet: '雪影娃娃', expect: '使敌方获得冻结时，也会使其获得全技能能耗+1', question: '「全技能能耗+1」是永久还是与冻结同寿？与其他能耗修改（湿润印记-1）如何复合？', case_id: 'MC-018' },
  { pet: '音速犬', expect: '入场首回合，获得物攻+100%', question: '「首回合」的判定边界；+100% 与「迸发」是否叠加；换入是否算入场？', case_id: 'MC-019' },
];

for (const t of A_TRAITS) {
  const pet = petByName(t.pet);
  const trait = traitOf(t.pet);
  const smPet = sm.find((p) => p.name === t.pet);
  add({
    case_id: t.case_id,
    title: `A 组特性：${t.pet}「${trait?.name}」`,
    priority: 'P4',
    category: 'a_group_trait',
    why_it_matters: `A 组是第一条可玩垂直切片；该特性直接改变 ${t.pet} 的数值或行动顺序，不核验则候选配招无法落地。`,
    initial_state: {
      pet: t.pet,
      pet_id: pet?.pet_id,
      types: pet?.types,
      stats: pet?.stats,
      trait: trait ? { skill_id: trait.trait_skill_id, name: trait.name, desc: trait.desc } : null,
      note: '特性在本快照中 category=「特性」、energy=0、无 power 字段，属被动效果。',
    },
    public_observation: ['该精灵的面板与特性文本'],
    legal_actions: { known: false, note: '取决于特性是否产生额外合法动作（通常不产生）' },
    joint_actions: [{ side_a: '（构造触发条件）', side_b: '（构造对照）', question: t.question }],
    expected_event_sequence: null,
    expected_event_sequence_status: 'unknown',
    evidence: [
      { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${trait?.trait_skill_id}`, quote: trait?.desc, settled: `快照给出的特性描述：「${trait?.desc}」。这是**文本**，不是结算规则。` },
      { level: 'C_inference', ...SRC.primary, locator: 'support-matrix.json', settled: `该精灵技能池 ${smPet?.learnset.pool_size} 个技能、其中条件化威力 ${smPet?.learnset.dynamic_or_conditional_power} 个；特性效果未实现（effect_support=unsupported）。` },
    ],
    resolved_from_data: t.resolved
      ? [{ note: '本轮已能从快照数据直接解答的部分', detail: t.resolved }]
      : [],
    unresolved_questions: [t.question, '该特性的效果是否与描述文本完全一致（社区归档可能滞后于实际）？'],
    verification: {
      level: 'planned', passed: false,
      how_to_verify_next_round: `为「${t.pet}」单独写参数化 case：构造触发条件、对照条件、以及「特性与描述不符」的失败分支；特性效果必须 fail closed，不得给默认值。`,
    },
  });
}

// ══════════════════════════════════════════════════════════════════════
// P4：换入相关术语（迅捷/迸发/返场/紧急脱离）单独成组
// ══════════════════════════════════════════════════════════════════════

add({
  case_id: 'MC-020',
  title: '「应对攻击」的完整生命周期：必定先手、触发效果、防御技能冷却',
  priority: 'P1',
  category: 'respond_mechanics',
  why_it_matters: '术语 1016 同时规定了三件事（必定先手、触发应对效果、防御技能进 1 回合冷却），这是最复杂也最影响 A 组配招的一条（12 只中 10 只的候选配招含「应对型防御」）。',
  initial_state: {
    side_a: { pet: '寂灭骨龙', note: '候选配招含「龙血」（减伤70%，应对攻击：下次技能无需蓄力）' },
    side_b: { pet: '海豹船长', note: '候选配招含「水泡盾」（减伤80%，应对攻击：自己获得魔攻+70%）' },
  },
  public_observation: ['双方所选技能（结算前不可见）', '防御技能冷却状态'],
  legal_actions: {
    side_a: ['龙血(防御,能耗2)', '坟场搏击(攻击,能耗4)'],
    side_b: ['水泡盾(防御,能耗2)', '一拳(攻击,能耗5)'],
    known: true,
  },
  joint_actions: [
    { side_a: '龙血(防御)', side_b: '一拳(攻击)', question: 'A 的「应对攻击」是否成功并必定先手？触发「下次技能无需蓄力」？' },
    { side_a: '龙血(防御)', side_b: '水泡盾(防御)', question: '双方都是防御技能时，「应对攻击」是否失败（因为没有攻击技能）？' },
    { side_a: '龙血(防御)', side_b: '一拳(攻击)', question: '本回合用过的防御技能是否进入 1 回合冷却，下回合能否再用？' },
    { side_a: '龙血(防御)', side_b: '任意', question: '「应对攻击」失败时，减伤 70% 是否仍然生效？' },
  ],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1016', quote: term(1016)?.desc, settled: '「应对攻击」：若敌方使用攻击技能，则本技能应对成功，**本次行动必定先手**，且触发应对效果。**使用后，携带的防御技能进入 1 回合冷却**。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1015/1017', quote: `${term(1015)?.desc} / ${term(1017)?.desc}`, settled: '「应对状态」「应对防御」结构相同，但**只有 1016 写了「防御技能进入 1 回合冷却」**。' },
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('龙血')?.skill_id}`, quote: skillByName('龙血')?.desc, settled: '「龙血」：减伤70%，本技能可以在蓄力状态下使用，应对攻击：下次技能无需蓄力。' },
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('水泡盾')?.skill_id}`, quote: skillByName('水泡盾')?.desc },
  ],
  unresolved_questions: [
    '「应对成功」时，是先手到能压过对手的一切先手度，还是只提升到某个层级？',
    '「应对失败」时，技能的减伤部分是否仍然生效？（描述把减伤写在「应对」之前，暗示减伤无条件）',
    '「防御技能进入 1 回合冷却」：是**只有被应对成功的那个技能**，还是**所有携带的防御技能**？',
    '冷却对「下一个防御技能」是否也生效？',
    '「必定先手」与双方都应对成功时如何裁决？',
    '减伤 70% 与属性相性、其他减伤的复合顺序与取整？',
  ],
  verification: {
    level: 'planned', passed: false,
    how_to_verify_next_round: '这是 A 组最优先实现的机制组：覆盖「应对成功/失败 × 防御冷却 × 先手覆盖 × 双方同为防御」四类分支，共 8—10 个断言。',
  },
});

// ══════════════════════════════════════════════════════════════════════
// P4：蓄力
// ══════════════════════════════════════════════════════════════════════

add({
  case_id: 'MC-021',
  title: '蓄力：跨回合状态、「免疫所有离场效果」与「免蓄力」的消耗',
  priority: 'P1',
  category: 'charge',
  why_it_matters: 'A 组多个候选/池内技能含蓄力（如寂灭骨龙的「吹炎」「龙之利爪」），且术语表给出了一条很强的规则（蓄力期间免疫所有离场效果），会直接改变换宠博弈。',
  initial_state: {
    side_a: { pet: '寂灭骨龙', note: '池内含「吹炎」（蓄力，应对状态：威力翻倍）、「龙之利爪」（蓄力并吸血50%）' },
    side_b: { pet: '秩序鱿墨', note: '可施加离场类效果' },
  },
  public_observation: ['蓄力状态是否公开？'],
  legal_actions: { known: true },
  joint_actions: [
    { side_a: '吹炎(开始蓄力)', side_b: '任意', question: '蓄力当回合是否造成伤害？' },
    { side_a: '吹炎(蓄力中)', side_b: '施加离场效果', question: '「蓄力期间免疫所有离场效果」是否成立？' },
    { side_a: '龙血(应对成功→下次无需蓄力)', side_b: '攻击', question: '「下次技能无需蓄力」如何被消耗？' },
  ],
  expected_event_sequence: null,
  expected_event_sequence_status: 'unknown',
  evidence: [
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1007', quote: term(1007)?.desc, settled: '「蓄力」：该技能需要先蓄力 1 回合，下回合才能释放。**蓄力期间免疫所有离场效果。**' },
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('吹炎')?.skill_id}`, quote: skillByName('吹炎')?.desc, settled: '「吹炎」：蓄力，造成物伤，应对状态：本次技能威力翻倍。' },
    { level: 'B_description', ...SRC.primary, locator: `Skills.lua#${skillByName('龙血')?.skill_id}`, quote: skillByName('龙血')?.desc, settled: '「龙血」：……本技能可以在蓄力状态下使用，应对攻击：下次技能无需蓄力。' },
    { level: 'A_glossary_text', ...SRC.primary, locator: 'Terms.lua#1037（若存在）/技能特性「洄游」', settled: '特性「洄游」写「每次进入蓄力状态，获得全技能能耗永久-2」，说明蓄力状态可被多次进入且可被特性观测。' },
  ],
  unresolved_questions: [
    '蓄力期间是否公开可见（对手能否知道你在蓄力）？',
    '蓄力期间被打断/被击倒如何处理？',
    '「免疫所有离场效果」是否包括「脱离」「返场」「紧急脱离」以及被技能强制换下？',
    '「下次技能无需蓄力」的消耗时机：是下一次尝试蓄力时，还是下一次行动时？',
    '蓄力与「先手」如何交互？',
  ],
  verification: { level: 'planned', passed: false, how_to_verify_next_round: '实现跨回合状态机；断言蓄力当回合无伤害、次回合释放、离场免疫、免蓄力消耗四件事。' },
});

// ── 写文件 ────────────────────────────────────────────────────────────
const OUT = 'evals/roco/cases/microcases-v1.jsonl';
mkdirSync('evals/roco/cases', { recursive: true });

const header = {
  record_type: 'microcase_plan_header',
  plan_id: 'microcases-v1',
  status: 'PLAN_ONLY_NOT_EXECUTED',
  ruleset_id: 'roco-world-s4-2026-09-10',
  game: 'roco_world_mobile',
  created_at: new Date().toISOString(),
  important: [
    '本文件是**计划**：没有任何一条 microcase 已经通过。',
    '每条 case 的 verification.passed 均为 false；verification.level 表示证据等级，不表示已验证。',
    'expected_event_sequence 为 null 表示「我们不知道正确答案」——不得为了让测试通过而补齐。',
    '所有 unresolved_questions 都是下一轮必须先回答的问题；未回答前相关机制必须 fail closed。',
  ],
  evidence_levels: {
    A_glossary_text: '快照 Terms.lua 有明确定义文本（最强，但仍非游戏实测）',
    B_description: '技能描述里有说明',
    C_inference: '从多处文本推断，必须用实测确认',
    D_unknown: '完全没有证据',
  },
  counts_by_priority: cases.reduce((a, c) => { a[c.priority] = (a[c.priority] ?? 0) + 1; return a; }, {}),
  counts_by_category: cases.reduce((a, c) => { a[c.category] = (a[c.category] ?? 0) + 1; return a; }, {}),
  source: SRC,
  terms_glossary_available: Object.keys(terms).length,
  note_on_glossary: '主快照的 Terms.lua 提供了 54 条机制文本定义，这是本轮能把「文本说了什么」与「文本没说什么」分开的依据；但它仍然只是社区归档文本，不是游戏实测。',
};

const lines = [JSON.stringify(header)];
for (const c of cases) {
  lines.push(JSON.stringify({
    record_type: 'microcase',
    ruleset_id: 'roco-world-s4-2026-09-10',
    game: 'roco_world_mobile',
    status: 'PLAN_ONLY_NOT_EXECUTED',
    ...c,
  }));
}
writeFileSync(OUT, lines.join('\n') + '\n');

console.log(`[microcases] wrote ${OUT}`);
console.log(`  cases: ${cases.length}`);
console.log(`  by priority: ${JSON.stringify(header.counts_by_priority)}`);
console.log(`  by category: ${JSON.stringify(header.counts_by_category)}`);
const noExpected = cases.filter((c) => c.expected_event_sequence === null).length;
console.log(`  cases with unknown expected sequence (honest): ${noExpected}/${cases.length}`);
