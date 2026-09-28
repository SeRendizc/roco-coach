/**
 * 判据：天分（个体值）与性格这两个系统，规则必须**只从数据层来**，缺的必须如实标 unknown。
 *
 * 来源三条（每条都写进 `data/roco/systems/natures.json` 的 provenance）：
 *   ① 桌面图片「性格修正一览表」：30 条性格的 ↑/↓ 逐格抄录；
 *   ② 规则证据台账 EV-NATURE-BALANCE-PVP：长处 +20% / 短处 −10%；
 *   ③ 桌面笔记的小黑盒 pvp 公式：生命 =（1.7*种族值 + 个体值*0.85 + 70）*性格 + 100，
 *      其他 =（1.1*种族值 + 个体值*0.55 + 10）*性格 + 50。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  natures, natureOf, natureFactor, natureFloorFactor, NATURE_PVE_FLOOR, panelOf, pvpPanelOf,
  natureCandidates, validateNatures,
  STAT_KEYS, TALENT_PVP_STEP, PANEL_FORMULA, TALENT_RANGE,
} from '../src/coach/talent.js';

const raw = JSON.parse(readFileSync(new URL('../data/roco/systems/natures.json', import.meta.url), 'utf8'));
const RACE = {hp: 85, atk: 116, def: 101, spa: 38, spd: 82, spe: 120};   // 音速犬的种族值（归一化图鉴）

test('① 性格表 30 条、编号与名字唯一、每条恰好一个长处一个短处', () => {
  assert.equal(natures().length, 30, '图片上是 30 条');
  assert.deepEqual(validateNatures(natures()), [], '现表必须零问题');
  const ids = natures().map((row) => row.id).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({length: 30}, (_, i) => i + 1), '编号必须是 1–30');
  for (const row of natures()) {
    assert.notEqual(row.up, row.down, `${row.name}：长处和短处不能是同一项`);
  }
});

test('② 结构完备：6 个长处 × 5 个短处 = 30 组穷举（反证：改坏一条必红）', () => {
  const pairs = new Set(natures().map((row) => `${row.up}>${row.down}`));
  const all = [];
  for (const up of STAT_KEYS) for (const down of STAT_KEYS) if (up !== down) all.push(`${up}>${down}`);
  assert.equal(pairs.size, 30);
  for (const key of all) assert.ok(pairs.has(key), `缺 ${key}`);
  // 反证一：把「固执」（物攻↑魔攻↓）改成 魔攻↑物攻↓ ⇒ 必然出现"重复+缺失"
  const swapped = natures().map((row) => (row.name === '固执' ? {...row, up: 'spa', down: 'atk'} : row));
  const problems = validateNatures(swapped);
  assert.ok(problems.some((p) => p.includes('重复')), `改坏后必须报重复：${problems}`);
  assert.ok(problems.some((p) => p.includes('缺')), `改坏后必须报缺失：${problems}`);
  // 反证二：删掉一条 ⇒ 条数不对
  assert.ok(validateNatures(natures().slice(0, 29)).some((p) => p.includes('30 条')));
  // 反证三：把上项改成下项（同一项）⇒ 必红
  const same = natures().map((row) => (row.name === '沉默' ? {...row, down: 'hp'} : row));
  assert.ok(validateNatures(same).some((p) => p.includes('同一项')), '上下同项必须被抓');
});

test('③ 修正系数：长处 1.2、短处 0.9、不受影响 1.0；**未知性格记 1.0 但标 known:false**', () => {
  const {modifier} = raw;
  assert.equal(modifier.up, 0.2, '长处 +20% 来自台账 EV-NATURE-BALANCE-PVP');
  assert.equal(modifier.down, -0.1, '短处 −10% 同上');
  // ⚠ 2026-09-27 **改钉**（人类拍板 + 查证）：长处那一侧**随突破长**，缺省是**零突破**：
  //   初始 +10%、每突破 +2%、满突破 +20%；短处**恒 −10%**。
  //   人类原话：「一个加 10%，一个减 10%，可不变化幅度就是 20%？」——
  //   即"20%"说的是**幅度**（−10% 到 +10% 的跨度），不是"长处 +20%"。
  //   反编译注释逐字：「降低固定 −10%；提升初始 +10%，每突破一次再 +2%，满突破 +20%」。
  assert.equal(natureFactor('开朗', 'spe').factor, 1.1, '开朗的长处是速度（零突破 +10%）');
  assert.equal(natureFactor('开朗', 'spe', {breakthrough: 5}).factor, 1.2, '满突破才是 +20%');
  assert.equal(natureFactor('开朗', 'spa').factor, 0.9, '开朗的短处是魔攻（−10%，零突破）');
  assert.equal(natureFactor('开朗', 'spa', {breakthrough: 5}).factor, 0.9, '减益不随突破变化');
  assert.equal(natureFactor('开朗', 'hp').factor, 1.0, '生命不受开朗影响');
  assert.equal(natureFactor('胆小', 'spe').factor, 1.1, '胆小的长处也是速度（短处是物攻）');
  assert.equal(natureFactor('胆小', 'atk').factor, 0.9);
  // 反证：没填性格 ≠ 加成。它必须回到中性并且**明说不知道**。
  const blank = natureFactor('', 'spe');
  assert.equal(blank.factor, 1, '没填性格时按中性算，不许当成长处');
  assert.equal(blank.known, false, '但要如实标"不知道"');
  assert.equal(natureFactor('不存在的性格', 'spe').known, false);
  // 交叉核对：图片里 30 条的名字必须都在（防止抄漏/改名）
  for (const name of ['沉默', '平和', '忧郁', '粗心', '踏实', '逞强', '固执', '大胆', '调皮', '勇敢',
    '理性', '聪明', '专注', '偏执', '冷静', '坦率', '稳重', '天真', '懒散', '悠闲',
    '焦虑', '警惕', '害羞', '温顺', '慎重', '热情', '胆小', '开朗', '急躁', '莽撞']) {
    assert.ok(natureOf(name), `图片上有「${name}」`);
  }
});

test('④ 面板公式：等级公式的算例（手算，含性格与突破档）', () => {
  // ⚠ 2026-09-27 **改钉**：面板不再走"笔记那两行 + 天分每点 0.55/0.85"，
  // 而是走**等级公式**（`LEVEL_FORMULA`，配置表口径），L=60 时与老两行最多差 1（判据见
  // `tests/roco-panel-level.test.js` ③）。天分在括号内按 `+3×资质`（= 老式 0.55×资质×6）。
  const level60 = (race, talent, nature, breakthrough = 0) =>
    panelOf({race, talent, nature, scope: 'pvp', level: 60, breakthrough}).panel;
  const zero = {hp: 0, atk: 0, spa: 0, def: 0, spd: 0, spe: 0};
  const kai = level60(RACE, zero, '开朗');
  // 手算：速度 (120+0)*1.1 = 132 → +10 = 142 → ×1.1（零突破开朗）= 156.2 → round 156 → +50 = 206
  assert.equal(kai.spe, 206, `开朗零突破速度：${kai.spe}`);
  // 短处：魔攻 38 → 41.8 → round 42 → +10 = 52 → ×0.9 = 46.8 → 47 → +50 = 97
  assert.equal(kai.spa, 97, `开朗短处魔攻：${kai.spa}`);
  // 生命不受性格影响：(85+0)*1.7 = 144.5 → round 145 → +70 = 215 → +100 = 315
  assert.equal(kai.hp, 315, `生命：${kai.hp}`);
  // 满突破那一档：速度 142*1.2 = 170.4 → 170 → +50 = 220（PVP 归一化＝满突破，实测 9/9 那一档）
  assert.equal(level60(RACE, zero, '开朗', 5).spe, 220, '满突破 +20% 那一档');
  assert.equal(pvpPanelOf({race: RACE, talent: zero, nature: '开朗'}).panel.spe, 220,
    'pvpPanelOf 的定义就是满级 + 满突破');
  // 天分 10 点的净增：速度每点 3×1.1 = 3.3（零突破性格系数 1.1）⇒ 10 点 = 36.3 的取整结果
  const full = level60(RACE, {hp: 10, atk: 10, spa: 10, def: 10, spd: 10, spe: 10}, '开朗');
  const expectSpe = (iv) => Math.round((Math.round((120 + 3 * iv) * 1.1) + 10) * 1.1) + 50;
  assert.equal(full.spe, expectSpe(10), '速度按等级公式现算');
  assert.notEqual(full.spe - kai.spe, 60, '天分 10 点**不是** +60（那是"每点 +6"那条旧口径，已判定不参与面板）');
  const expectHp = (iv) => Math.round((Math.round((85 + 3 * iv) * 1.7) + 70) * 1) + 100;
  assert.equal(full.hp - kai.hp, expectHp(10) - expectHp(0), '生命按等级公式现算');
  // 性格换成正中和的（沉默）看速度不变（而不是把它当成长处）
  const silent = level60(RACE, zero, '沉默');
  assert.equal(silent.spe, Math.round((Math.round(132) + 10) * 1) + 50, '沉默不加速度 ⇒ 速度按中性算');
});

test('⑤ 缺输入不许拿 0 冒充：种族值缺 ⇒ 不算；天分缺 ⇒ 计入 0 但必须说出来', () => {
  const noRace = panelOf({race: null, talent: null, nature: '开朗'});
  assert.deepEqual(noRace.panel, {}, '没有种族值就一项都不算（不许给 0）');
  assert.ok(noRace.unknown.some((row) => row.includes('没有种族值')), `要说清缺什么：${noRace.unknown}`);
  const noTalent = panelOf({race: RACE, talent: null, nature: null});
  assert.ok(noTalent.unknown.some((row) => row.includes('还没填天分')), '天分没填要说出来');
  assert.ok(noTalent.unknown.some((row) => row.includes('还没填性格')), '性格没填也要说出来');
  const partial = panelOf({race: {...RACE, spa: null}, talent: null, nature: '开朗'});
  assert.ok(!('spa' in partial.panel), '种族值缺的那一项不许出现在结果里');
  assert.ok(partial.unknown.some((row) => row.includes('魔攻')), '缺哪一项要说出来');
});

test('⑥ 天分只许进面板**一次**（2026-09-27 查证：×6 是单位换算，"每点 +6"不再参与面板）', () => {
  // 改钉记录：这一天之前，本仓把两条口径**拼**在一起用（种族/性格走老公式 + 天分另加"每点 +6"），
  // 结果是天分被算了两遍。查证的结论是：
  //   · 配置表 `ATTR_GLOBAL_CONFIG` 的 `talent_constant` 是**括号内**的（生命 100→3×、其他 50→3×）；
  //   · 笔记里那句「个体值 pvp 中自动乘六倍」讲的是 **UI 0–10 → 内部 0–60 的单位换算**，
  //     不是"PVP 额外再加六倍"；
  //   · 「7-8-9-10 → +42/48/54/60」那条**解释不了**已实测的 9/9（见 `roco-panel-level` ①），
  //     所以它只作为**历史记录**保留（`TALENT_PVP_STEP`），**不再参与任何面板换算**。
  assert.equal(TALENT_PVP_STEP.table[10], 60, '历史记录照旧留着（改钉不删）');
  assert.ok(TALENT_PVP_STEP.external_support.includes('TapTap'), '外部查证出处照旧留着');
  assert.match(TALENT_PVP_STEP.decision, /不再参与.*面板|不参与.*面板/, '要写明它已退出面板换算');
  // 行为判据：面板只按等级公式算 —— 换成"每点 +6"那套必须对不上
  const race = {hp: 100, atk: 100, spa: 100, def: 100, spd: 100, spe: 100};
  const talent = {hp: 0, atk: 0, spa: 0, def: 0, spd: 0, spe: 10};
  const got = pvpPanelOf({race, talent}).panel.spe;
  const formulaOnly = Math.round((Math.round((100 + 30) * 1.1) + 10) * 1) + 50;
  assert.equal(got, formulaOnly, `天分 10 点只许进一次：${got}`);
  assert.notEqual(got, Math.round((Math.round(100 * 1.1) + 10) * 1) + 50 + 60,
    '旧口径（再加 +6/点）必须与现在的算法对不上');
  assert.equal(TALENT_RANGE.max, 10, '六项范围 0–10');
});

test('⑦ 性格候选只做"算出来排序"，不替玩家拍板（防止纯机器算：它给的是材料不是结论）', () => {
  const rows = natureCandidates({race: RACE, stats: ['spe'], limit: 30});
  const top = rows.filter((row) => row.panel.spe === rows[0].panel.spe).map((row) => row.nature);
  // 速度是长处的**恰好 5 种**（热情/胆小/开朗/急躁/莽撞 —— 分别牺牲生命/物攻/魔攻/物防/魔防），
  // 它们在这一指标上并列第一 ⇒「该用哪个」必须再结合短处，这正是答案层要讲的取舍
  // （本函数只给同一指标下的并列材料，不替玩家拍板）。
  assert.deepEqual(top.sort(), ['热情', '胆小', '开朗', '急躁', '莽撞'].sort(), `速度并列第一的应是这五个：${top}`);
  assert.equal(rows.length, 30, '默认把 30 条都算一遍（limit=30）');
  const slow = natureCandidates({race: RACE, stats: ['spe'], limit: 1})[0];
  // ⚠ 2026-09-27 改钉：候选表算的是**零突破下界**（我们不知道玩家的突破段数），
  // 所以最快的性格速度是 206；满突破那一档（PVP 归一化）才是 220。两个数都要说得出来。
  assert.equal(slow.panel.spe, 206, `零突破下界下最快的性格速度：${slow.panel.spe}`);
  assert.ok(slow.panel.spe >= 206, '同一指标下最快的性格不该低于任何中性口径');
  assert.equal(pvpPanelOf({race: RACE, talent: null, nature: slow.nature}).panel.spe, 220,
    '同一只换到满突破（PVP 归一化）那一档是 220');
});

test('⑧ 非 PVP 那一档只给**零突破下界**（人述 10%↔20% 的两句按台账引文可以同时为真）', () => {
  // 人类 2026-09-27 的两句看似矛盾（「幅度从 10% 提到 20%」vs「一项 +10%、一项 −10%」），
  // 台账 `EV-NATURE-BALANCE-PVP`（OFFICIAL_CURRENT）逐字给的是：
  //   PVP 平衡到 +20%/−10%；非 PVP 初始 +10%、每突破 +2%、满 +20%、降低固定 −10%。
  // ⇒ ±10% 是**非 PVP 零突破**那一档。我们没有突破次数 ⇒ 只能给下界，且必须标 `floor:true`。
  assert.equal(NATURE_PVE_FLOOR.up, 0.1, '零突破下界 = +10%');
  assert.equal(NATURE_PVE_FLOOR.down, -0.1, '降低固定 −10%');
  assert.equal(NATURE_PVE_FLOOR.cap, 0.2, '满突破 +20%（与 PVP 同顶）');
  assert.match(NATURE_PVE_FLOOR.note, /下界/, '常量自己要说清这是下界');
  const up = natureFloorFactor('开朗', 'spe');
  assert.equal(up.factor, 1.1, '速度是开朗的长处 ⇒ 下界 1.1');
  assert.equal(up.floor, true, '必须标成下界（调用方不许当实测用）');
  assert.match(up.reason, /每突破 \+2%|满突破 \+20%/, `要把成长那条说出来：${up.reason}`);
  assert.equal(natureFloorFactor('开朗', 'spa').factor, 0.9, '短处仍是 −10%');
  assert.equal(natureFloorFactor('开朗', 'hp').factor, 1, '不受影响');
  // 与 PVP 档的关系（2026-09-27 改钉）：`natureFactor` 的缺省**就是零突破**，
  // 所以下界函数与它在零突破下**相等**；两档的差别在**满突破**那一侧（PVP 归一化到 +20%）。
  assert.equal(natureFloorFactor('开朗', 'spe').factor, natureFactor('开朗', 'spe').factor,
    '零突破下两者相同（同一把尺子）');
  assert.ok(natureFactor('开朗', 'spe', {breakthrough: 5}).factor > natureFloorFactor('开朗', 'spe').factor,
    '满突破（PVP 归一化）必须高于零突破下界');
  assert.equal(natureFloorFactor('开朗', 'spa').factor, natureFactor('开朗', 'spa').factor,
    '短处在两档里都是 −10%');
  assert.equal(natureFloorFactor('不存在的性格', 'spe').known, false, '认不出就 known:false');
});
