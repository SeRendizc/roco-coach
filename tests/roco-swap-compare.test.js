// 换人对比的判据（2026-09-25）。
//
// 由来：288 条任务集 `roster_constraint` 里 12 条「第三只换成圆号鱼好不好？」**一次都没调**
// `compare_team_change`（提示里写明了也没咬住，见 `reports/roco/roster-agent-2026-09-25/`）。
// 产品路径上更没有这一类政策，玩家问换谁更好拿到的是**没有引擎计算**的意见。
//
// **一条被实测纠正过的判断（写在这里免得下一个人再踩）**：我一度读 `service.py` 的
// 「等长 + 只差一只」就把本地校验从"3 只"放宽到 2..6，结果产品路径探针（六槽阵容）拿到的
// 引擎回执是 bad_request：**「训练场评估按 3 只队伍进行；完整 6 只阵容在第 5 周扩展」**。
// ⇒ 本地那道 3 只校验**原本就是对的**（它在出门前 fail closed），**已撤回放宽**；
// 六槽阵容改成**如实说边界**（见 ⑥），而不是让模型凭印象给建议。
//
// 判据钉六件事：
//   ① 该触发：玩家真会说的几种问法都要触发；三只阵容给出「换掉第 N 只」的参数，且参数能过本地校验；
//   ② 合同校验 = 引擎能力（**各 3 只**）：六只必须被拒（附引擎原文为凭）；
//   ③ **fail closed**：没序号 / 序号越界 / 名字不在名单 / 名字重名 / 换入的本来就在队里 / 六只阵容；
//   ④ **对局里不抢**：对局上下文里"换"是把场上那只换下去，那条路走战斗工具；
//   ⑤ 开关两态；
//   ⑥ **边界要玩家看得见**：六只阵容时喂给模型的是「按 3 只算」这句实话，三只时说清缺的是问句目标。
// 每条配必红反证。

import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOL_CONTRACTS, validToolArgs, projectCompareResult} from '../src/coach/toolbox.js';
import {absentArgsFor, defaultArgsFor, policyFor, swapAsk, swapTarget} from '../src/coach/runtime.js';

const THREE = [{id: 'pet_000225', name: '寂灭骨龙'}, {id: 'pet_000190', name: '海豹船长'},
  {id: 'pet_000445', name: '潮甲龟'}];
const SIX = [{id: 'pet_000012', name: '铠甲虫'}, {id: 'pet_000062', name: '音速犬'},
  {id: 'pet_000100', name: '仪式巨像'}, {id: 'pet_000112', name: '雪影娃娃'},
  {id: 'pet_000118', name: '皇家狮鹫'}, {id: 'pet_000124', name: '化蝶'}];
const POOL = [{id: 'pet_000417', name: '圆号鱼'}];
const CAMP3 = {mode: 'camp', profile: {lineup: THREE, pets: POOL}};
const CAMP6 = {mode: 'camp', profile: {lineup: SIX, pets: POOL}};

test('① 该触发：几种问法都要触发；三只阵容给出"换掉第 N 只"的参数', () => {
  const cases = [
    ['第三只换成圆号鱼好不好？', 2],
    ['把第3只换成圆号鱼', 2],
    ['第1只换成圆号鱼行不行', 0],
    ['第二只改成圆号鱼', 1],
  ];
  for (const [question, slot] of cases) {
    assert.equal(swapAsk(question), true, `该触发却没触发：${question}`);
    const policy = policyFor(question, CAMP3);
    assert.equal(policy.need, 'compare_team_change', `政策应给出对比工具：${question}`);
    assert.equal(policy.reason, 'swap-compare');
    const args = defaultArgsFor('compare_team_change', CAMP3, question);
    assert.ok(args, `参数应能构造出来：${question}`);
    assert.deepEqual(args.team_before, THREE.map((row) => row.id));
    assert.equal(args.team_after.length, 3);
    const changed = args.team_before.filter((id, index) => id !== args.team_after[index]);
    assert.deepEqual(changed, [THREE[slot].id], `第 ${slot + 1} 位应被换掉：${question}`);
    assert.equal(args.team_after[slot], 'pet_000417', '换入的应是名单里那只的 id');
    // 参数必须真的能过本地校验 —— 否则就是"看着对、出门被拒"
    assert.equal(validToolArgs('compare_team_change', {...args, state_version: 0}), true);
  }
});

test('② 合同校验 = 引擎能力：3 与 6 都收，规模在登记表外的本地就拒', () => {
  const three = THREE.map((row) => row.id);
  const threeAfter = [...three];
  threeAfter[2] = 'pet_000417';
  const six = SIX.map((row) => row.id);
  const sixAfter = [...six];
  sixAfter[2] = 'pet_000417';
  assert.equal(validToolArgs('compare_team_change', {team_before: three, team_after: threeAfter, state_version: 0}), true);
  // 2026-09-25 改口径：引擎改成**按登记表里各模式声明的规模**收队伍
  // （`team.py` 的 `declared_team_sizes()` = 2/3/6，`pvp-standard-six-pet` 就是 6）⇒
  // 六只现在必须**本地就通过**（旧断言「六只必拒」在那次改动后已经不成立，故改钉）。
  // 留痕：同一天早些时候我把它放宽到 2..6 是错的（当时引擎硬判 3）—— 那次撤回是对的；
  // 这次放宽有引擎侧判据 + 真机回执为凭。
  assert.equal(validToolArgs('compare_team_change', {team_before: six, team_after: sixAfter, state_version: 0}), true,
    '六只是引擎声明过的规模，本地必须放行');
  // 规模在登记表外的（4/5 只）仍然**本地就拒**：不发注定 400 的请求出门。
  for (const size of [4, 5]) {
    const team = SIX.slice(0, size).map((row) => row.id);
    const after = [...team];
    after[2] = 'pet_000417';
    assert.equal(validToolArgs('compare_team_change', {team_before: team, team_after: after, state_version: 0}), false,
      `${size} 只不是任何模式声明的规模 ⇒ 本地 must fail closed`);
  }
  const bad = {
    '差两只': [three, [three[0], 'pet_000417', 'pet_000999']],
    '长度不等': [three, six],
    '没换（两侧相同）': [three, three],
    '重复 id': [['pet_000225', 'pet_000225', 'pet_000445'], ['pet_000225', 'pet_000190', 'pet_000417']],
    '带路径的 id': [three, ['/etc/passwd', three[1], 'pet_000417']],
  };
  for (const [label, [before, after]] of Object.entries(bad)) {
    assert.equal(validToolArgs('compare_team_change', {team_before: before, team_after: after, state_version: 0}),
      false, `${label} 必须被拒`);
  }
  const desc = TOOL_CONTRACTS.compare_team_change.arguments;
  assert.ok(desc.team_before.includes('3 个'), `说明要写清是 3 只：${desc.team_before}`);
  assert.ok(desc.team_before.includes('六只') || desc.team_before.includes('尚未支持'),
    '说明里要如实写出六只阵容尚不支持（否则模型会以为能给六只做对比）');
});

test('③ fail closed：六类对不上就不构造参数（运行时据此写"没有记录"的回执）', () => {
  const noSlot = '换成圆号鱼好不好？';
  assert.equal(swapAsk(noSlot), false, '没有序号就不该触发');
  assert.equal(defaultArgsFor('compare_team_change', CAMP3, noSlot), null);
  assert.equal(swapTarget('第九只换成圆号鱼好不好？', CAMP3), null, '序号越界');
  assert.equal(swapTarget('第三只换成不认识的鱼好不好？', CAMP3), null, '名字不在名单');
  assert.equal(swapTarget('第三只换成同名兽好不好？', {profile: {lineup: THREE,
    pets: [{id: 'pet_000900', name: '同名兽'}, {id: 'pet_000901', name: '同名兽'}]}}), null,
  '重名（两个 id）不许猜 —— 与换招同一条纪律');
  assert.equal(swapTarget('第三只换成潮甲龟好不好？', CAMP3), null, '换入的本来就在队里');
  assert.equal(swapTarget('第三只换成圆号鱼好不好？',
    {profile: {lineup: [{name: '甲'}, {name: '乙'}, {name: '丙'}], pets: POOL}}), null, '槽位没解析出 id');
  // 2026-09-25 改口径：六只是**引擎声明过的规模**（`pvp-standard-six-pet`）⇒ 现在能构造参数了；
  // 「规模对不上」这一类改用 **4 只**（不在登记表里）来钉。
  assert.ok(swapTarget('第三只换成圆号鱼好不好？', CAMP6), '六只现在必须能构造参数');
  const CAMP4 = {mode: 'camp', profile: {lineup: THREE.concat([{id: 'pet_000112', name: '雪影娃娃'}]), pets: POOL}};
  assert.equal(swapTarget('第三只换成圆号鱼好不好？', CAMP4), null,
    '四只不是任何模式声明的规模 ⇒ 不构造（fail closed）');
  // 反证：正常那些必须能构造出来（判据不是恒假）
  assert.ok(swapTarget('第三只换成圆号鱼好不好？', CAMP3));
});

test('④ 对局里不抢：战斗上下文中的"换"是把场上那只换下去', () => {
  const question = '第三只换成圆号鱼好不好？';
  for (const battleKey of ['battle', 'roco_battle']) {
    const context = {mode: 'pve', profile: {lineup: THREE, pets: POOL}, [battleKey]: {turn: 1}};
    assert.notEqual(policyFor(question, context).reason, 'swap-compare',
      `${battleKey} 上下文里不该被换人对比政策抢走`);
  }
  assert.equal(policyFor(question, CAMP3).reason, 'swap-compare', '营地照旧要触发（否则④是恒真判据）');
});

test('⑤ 开关：显式 ROCO_SWAP_COMPARE=0 才关（默认开）', () => {
  const question = '第三只换成圆号鱼好不好？';
  const previous = process.env.ROCO_SWAP_COMPARE;
  try {
    delete process.env.ROCO_SWAP_COMPARE;
    assert.equal(policyFor(question, CAMP3).reason, 'swap-compare', '不设变量 = 开');
    assert.ok(defaultArgsFor('compare_team_change', CAMP3, question));
    process.env.ROCO_SWAP_COMPARE = '0';
    assert.notEqual(policyFor(question, CAMP3).reason, 'swap-compare', '显式 0 必须真的关掉');
    assert.equal(defaultArgsFor('compare_team_change', CAMP3, question), null, '关掉后不许再构造参数');
  } finally {
    if (previous === undefined) delete process.env.ROCO_SWAP_COMPARE; else process.env.ROCO_SWAP_COMPARE = previous;
  }
});

test('⑥ 边界要玩家看得见：规模不在登记表里时说清规模，三只时说清缺的是问句目标', () => {
  // 2026-09-25 改口径：六只（`pvp-standard-six-pet`）现在**支持**，所以"边界"这一类改用 4 只钉。
  const CAMP4 = {mode: 'camp', profile: {lineup: THREE.concat([{id: 'pet_000112', name: '雪影娃娃'}]), pets: POOL}};
  const fourReason = absentArgsFor('compare_team_change', CAMP4, '第三只换成圆号鱼好不好？').reason;
  assert.ok(fourReason.includes('3 或 6 只'), `要说清支持哪些规模：${fourReason}`);
  assert.ok(fourReason.includes('4 只'), `要说清玩家这套几只：${fourReason}`);
  // 2026-09-27（审计 ②，**改钉不删**）：原来要求**那一句**里出现 `battle-modes.json`。
  // 出的错在于落点 —— 那句是给玩家/模型读的。现在出处挪到 `source` 字段（照样可回查），
  // `reason` 说人话。判据的意思没变：**规模声明必须能追回登记表**，只是换了个字段查。
  const fourSource = absentArgsFor('compare_team_change', CAMP4, '第三只换成圆号鱼好不好？').source ?? '';
  assert.ok(fourSource.includes('battle-modes.json') && fourSource.includes('team_size'),
   `要给出规模声明的出处（可回查）：${fourSource}`);
  assert.ok(!fourReason.includes('battle-modes.json') && !fourReason.includes('team_size'),
   `那句人话里不许出现数据文件名：${fourReason}`);
  const threeReason = absentArgsFor('compare_team_change', CAMP3, '换成圆号鱼好不好？').reason;
  assert.ok(!threeReason.includes('不在登记表里'),
    `三只阵容缺参数是问句的问题，不许说成"规模不支持"：${threeReason}`);
  assert.ok(threeReason.includes('第几只'), `要说清缺的是问句里的目标：${threeReason}`);
  // 六只 + 缺序号：也要说清缺的是问句目标（不是"不支持"）
  const sixReason = absentArgsFor('compare_team_change', CAMP6, '换成圆号鱼好不好？').reason;
  assert.ok(sixReason.includes('第几只'), `六只阵容缺参数也只是问句的问题：${sixReason}`);
  assert.ok(!sixReason.includes('不在登记表里'), `六只是支持规模，不许说成不支持：${sixReason}`);
  // 反证：别的工具不许被这段边界话污染
  const other = absentArgsFor('read_match', CAMP6, '帮我看看整局统计').reason;
  assert.ok(!other.includes('3 或 6 只') && !other.includes('battle-modes.json'), `别的工具别串味：${other}`);
});

// 2026-09-25（六只阵容的问句被 `receipt-budget` 拦下的第二个真因）：引擎的对比回执里
// `before`/`after` 各带一整份特征（含 evidence/detail）—— **实测**：3 只 7165 字节、
// 6 只 **11019 字节**（>10 KB 预算），而语义部分（from/to/coverage_delta/improves/costs/note）
// 只占约 200 字节。所以这一层做投影：保留结论与每个特征的**值**，丢掉大块并记账。
test('⑦ 对比回执的投影：语义字段与特征值都在、大块被丢掉（含"不投影就超预算"的反证）', () => {
  const fat = (n) => ({
    team: ['pet_000012', 'pet_000062'],
    coverage: {types: 0.6, roles: 1.0},
    strengths: ['职责覆盖齐全'],
    weaknesses: ['被 9 种属性克制'],
    features: [{name: 'types', value: 0.6,
      detail: {weak_count: 9, offence_count: 5, big: 'x'.repeat(120)},
      evidence: Array.from({length: n}, (_, i) => `pets[pet_id=pet_0000${i}].types 与 type_chart 的逐条证据（真实回执里每份特征都带几十条）`)},
    {name: 'roles', value: 1.0, detail: {}, evidence: Array.from({length: n}, () => 'roles 的逐条证据（与真实回执同量级）')}],
  });
  const raw = {from: 'A', to: 'B', coverage_delta: {types: 0.1}, improves: ['types'],
    costs: ['energy'], before: fat(80), after: fat(80), note: '这是规则特征的变化', calibration: 'rule-baseline'};
  const rawBytes = JSON.stringify(raw).length;
  const projected = projectCompareResult(raw);
  const bytes = JSON.stringify(projected).length;
  // 反证：**不投影**的原始回执本来就超预算（这就是六只问句被拦下的机理）
  assert.ok(rawBytes > 10000, `夹具要先能复现"超预算"：${rawBytes}`);
  assert.ok(bytes < 10000, `投影后必须回到预算内：${bytes}`);
  // 语义字段一个不许丢
  assert.deepEqual(projected.improves, ['types']);
  assert.deepEqual(projected.costs, ['energy']);
  assert.deepEqual(projected.coverage_delta, {types: 0.1});
  assert.equal(projected.from, 'A');
  assert.equal(projected.note, '这是规则特征的变化');
  // 每个特征的**值**要留着（模型引用的数就是它），evidence 丢掉但**记账**
  assert.deepEqual(projected.before.features, [{name: 'types', value: 0.6}, {name: 'roles', value: 1.0}]);
  assert.equal(projected.before.evidence_trimmed, 160);
  assert.deepEqual(projected.after.strengths, ['职责覆盖齐全']);
  // 空/异常输入不许炸
  assert.equal(projectCompareResult(null), null);
});
