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
  // 2026-09-28 追加（人类口述的两件事）：四档天分 + 默认 5 星的资质换算
  STAT_NAMES, TALENT_TIERS, talentTierOf, STAR_BREAKTHROUGH, talentAtFiveStar, LEVEL_FORMULA,
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

// ── 2026-09-28 追加：天分档位（人类口述的四档）+ 默认 5 星（资质 ×6）──────────────────
//
// 人类当天的两句原话（逐字）：
//   「天分分为：一般般的天分（激活一条个体值），还不错的天分（激活两条个体值），相当好的天分（激活三条个体值），
//     了不起的天分（激活三条个体值，性格加成和天分三个加成正好有重合好像就是了不起）」
//   「另外升星系统虽然不做，但是还是默认做成5星，然后个体值都突破，比如原来是+10，五星是+60」
//
// 为什么单开这三条：档位只是一层**读法**（掷点分布一个字没动：`rollNatureAndTalent` 在 `individuals.js`），
// 5 星只是一层**单位换算**（0–10 → 内部 0–60）—— 两者都不许变成"再乘一遍"。

test('⑨ 天分四档：按人类口述的"激活几条"判；判不出来必须如实说（不猜）', () => {
  // 档名必须**逐字**是人类那四个（不许改写成"优秀/史诗"这类自造词），顺序也照他说的来
  assert.deepEqual(TALENT_TIERS.map((row) => row.label),
    ['一般般的天分', '还不错的天分', '相当好的天分', '了不起的天分']);
  assert.deepEqual(TALENT_TIERS.map((row) => row.activated), [1, 2, 3, 3], '激活条数：1 / 2 / 3 / 3');
  assert.deepEqual(TALENT_TIERS.map((row) => row.requires_nature_overlap), [false, false, false, true],
    '只有「了不起的天分」要求性格长处项与那三条重合');
  for (const row of TALENT_TIERS) {
    assert.match(row.source, /2026-09-28/, `${row.label} 的 source 要写清是哪一天的口述口径`);
    assert.match(row.source, /天分分为/, `${row.label} 的 source 要逐字带上人类那句话`);
    assert.ok(row.text && row.text.trim().length > 0, `${row.label} 要有一句玩家能读的话`);
  }
  const zero = Object.fromEntries(STAT_KEYS.map((stat) => [stat, 0]));
  const withTalent = (patch) => ({...zero, ...patch});
  // ① 一般般：恰好一条激活
  const plain = talentTierOf({talent: withTalent({spe: 10}), nature: '开朗'});
  assert.equal(plain.tier, '一般般的天分', plain.reason);
  assert.deepEqual(plain.activated, ['spe'], 'activated 给的是被激活那几项的键');
  // ② 还不错：恰好两条
  const good = talentTierOf({talent: withTalent({spe: 10, atk: 7}), nature: '开朗'});
  assert.equal(good.tier, '还不错的天分', good.reason);
  // ③ 相当好：三条，性格长处**不在**里面（开朗的长处是速度；这三条里没有速度）
  const great = talentTierOf({talent: withTalent({atk: 10, def: 7, spa: 3}), nature: '开朗'});
  assert.equal(great.tier, '相当好的天分', great.reason);
  assert.equal(great.nature_overlap, false);
  // ④ 了不起：三条，且性格长处**在**里面
  const amazing = talentTierOf({talent: withTalent({spe: 10, atk: 7, def: 3}), nature: '开朗'});
  assert.equal(amazing.tier, '了不起的天分', amazing.reason);
  assert.equal(amazing.nature_overlap, true);
  assert.equal(amazing.nature_up, 'spe', 'nature_overlap 用的是性格的**长处**项（natureOf().up），不是短处');
  // 同一份天分换个性格 ⇒ 档位翻转（"重合"那一条的意思就在这）
  assert.equal(talentTierOf({talent: withTalent({spe: 10, atk: 7, def: 3}), nature: '温顺'}).tier,
    '相当好的天分', '温顺的长处是魔防（spd）—— 不在那三条里 ⇒ 掉回「相当好的天分」');
  // 认不出（一）：六项全 0
  const none = talentTierOf({talent: zero, nature: '开朗'});
  assert.equal(none.tier, null, '一条都没激活 ⇒ 认不出档位');
  assert.match(none.reason, /一条都没被激活|都是 0/, none.reason);
  // 认不出（二）：恰好三条但性格没填 —— 这两档的唯一差别就是性格，缺它就**不许猜**
  const noNature = talentTierOf({talent: withTalent({spe: 10, atk: 7, def: 3}), nature: null});
  assert.equal(noNature.tier, null, '缺性格时分不出「相当好的天分」与「了不起的天分」');
  assert.match(noNature.reason, /性格/, noNature.reason);
  assert.match(noNature.reason, /相当好的天分/, '要说清分不出的是哪两档');
  assert.equal(talentTierOf({talent: withTalent({spe: 10, atk: 7, def: 3}), nature: '不存在的性格'}).tier,
    null, '性格认不出也一样：不许猜');
  // 认不出（三）：缺项（只给了三项）
  const partial = talentTierOf({talent: {spe: 10, atk: 7, def: 3}, nature: '开朗'});
  assert.equal(partial.tier, null, '缺项 ⇒ 不许把没给的那几项当成 0');
  assert.match(partial.reason, /缺项/, partial.reason);
  assert.match(partial.reason, /生命/, '要写清缺的是哪几项');
  // 认不出（四）：激活四条以上（那四档只覆盖 1/2/3）
  const four = talentTierOf({talent: withTalent({spe: 1, atk: 1, def: 1, spa: 1}), nature: '开朗'});
  assert.equal(four.tier, null, '四条激活不在那四档里');
  assert.match(four.reason, /1\/2\/3/, four.reason);
  // 认不出（五）：没填天分
  assert.equal(talentTierOf({talent: null, nature: '开朗'}).tier, null);
  assert.equal(talentTierOf({}).tier, null);
  // 必红反证：把"三条 + 重合"也当成「相当好的天分」（忽略重合一节）⇒ ④ 那条立刻红
  const ignoreOverlap = (row) => (row.activated === 3 ? '相当好的天分' : row.label);
  assert.notEqual(ignoreOverlap(TALENT_TIERS[3]), '了不起的天分', '前提：忽略重合真的会给出另一个档名');
});

test('⑩ 默认 5 星：资质 ×6 换成内部刻度 ⇒ 与 stars: 0 不同且更高（老数一个不动）', () => {
  const T10 = Object.fromEntries(STAT_KEYS.map((stat) => [stat, 10]));
  const five = pvpPanelOf({race: RACE, talent: T10, nature: '开朗'});
  const zeroStar = pvpPanelOf({race: RACE, talent: T10, nature: '开朗', stars: 0});
  assert.notEqual(five.panel.spe, zeroStar.panel.spe, '5 星与 0 星必须给出不同的数');
  assert.ok(five.panel.spe > zeroStar.panel.spe,
    `5 星必须更高（5 星 ${five.panel.spe} / 0 星 ${zeroStar.panel.spe}）`);
  // 缺省就是 5 星：不写 stars 与写 5 逐项相同
  assert.deepEqual(five, pvpPanelOf({race: RACE, talent: T10, nature: '开朗', stars: 5}));
  // ⭐ 而且与**改动前的老数**逐值相同：老口径 `3 × 资质(0–10)` 与新口径 `0.5 × 资质(0–60)` 是同一个数
  const legacy = Math.round((Math.round((RACE.spe + 3 * 10) * 1.1) + 10) * 1.2) + 50;
  assert.equal(five.panel.spe, legacy, '老口径 3×资质(0–10) 必须与新口径逐值相同（默认行为不许动）');
  assert.equal(five.panel.spe, 260, `开朗 / 资质 10 / 满突破：${five.panel.spe}`);
  assert.equal(zeroStar.panel.spe, 228, `0 星（零突破，内部刻度就是 0–10）：${zeroStar.panel.spe}`);
  // panelOf 也要认这个开关（不是只在 pvpPanelOf 里）：同一档（零突破下界）下 5 星必须高于 0 星
  const pv0 = panelOf({race: RACE, talent: T10, nature: '开朗', stars: 0}).panel.spe;
  const pv5 = panelOf({race: RACE, talent: T10, nature: '开朗', stars: 5}).panel.spe;
  assert.notEqual(pv5, pv0);
  assert.ok(pv5 > pv0, `panelOf 的 5 星也要更高（${pv5} / ${pv0}）`);
  assert.equal(panelOf({race: RACE, talent: T10, nature: '开朗', stars: 0, breakthrough: 5}).panel.spe,
    zeroStar.panel.spe, '同一档（满突破）下 panelOf 与 pvpPanelOf 必须一致');
  // 中间 1–4 星：资质上限本仓没有数据 ⇒ 不插值，如实说、不算面板
  const mid = pvpPanelOf({race: RACE, talent: T10, nature: '开朗', stars: 3});
  assert.deepEqual(mid.panel, {}, '1–4 星不算面板（我们没有那一档的资质上限）');
  assert.ok(mid.unknown.some((row) => /1–4 星/.test(row)), `要说明为什么：${JSON.stringify(mid.unknown)}`);
  // ⭐ 必红反证：`talentAtFiveStar` 若写成恒等（不乘 6），5 星分支拿到的就是 0–10 本身 ⇒
  //    算出来的数与 stars: 0 **必然相等**（228）⇒ 上面那两条 `notEqual` / `>` 立刻红。
  //    （恒等实现下 5 星分支 ≡ 下面这条 stars: 0 满突破的算法：0.5 × 资质(0–10)）
  const identityTalent = (talent) => ({...talent});
  const collapsed = pvpPanelOf({race: RACE, talent: identityTalent(T10), nature: '开朗', stars: 0}).panel.spe;
  assert.equal(collapsed, zeroStar.panel.spe, '恒等实现 ⇒ 5 星那条路退化成 0 星那一档');
  assert.notEqual(collapsed, five.panel.spe, '恒等实现与真实现必须不同 —— 这就是上面那条的"红"');
});

test('⑪ 5 星换算：×6、缺项保持缺项、不改入参；它与 LEVEL_FORMULA 的系数是同一个数（含双重放大反证）', () => {
  assert.equal(STAR_BREAKTHROUGH.stars, 5, '默认档就是 5 星（人类 2026-09-28）');
  assert.equal(STAR_BREAKTHROUGH.multiplier, 6, '「原来是 +10，五星是 +60」⇒ 倍率 6');
  assert.match(STAR_BREAKTHROUGH.source, /2026-09-28/, '要写清这是哪一天的口述口径');
  assert.match(STAR_BREAKTHROUGH.source, /原来是\+10，五星是\+60/, '出处要逐字带上人类那句话');
  assert.deepEqual([STAR_BREAKTHROUGH.entry_scale.max, STAR_BREAKTHROUGH.internal_scale.max], [10, 60],
    '换算的两端：玩家填的 0–10 → 公式吃的内部 0–60');
  const input = {hp: 0, atk: 10, def: 5, spa: null, spd: undefined, spe: ''};
  const out = talentAtFiveStar(input);
  assert.deepEqual(out, {hp: 0, atk: 60, def: 30, spa: null, spd: undefined, spe: ''},
    '六项各 ×6；缺项（null / undefined / 空串）保持缺项 —— 不许把 null 变成 0');
  assert.equal(input.atk, 10, '入参不许被改（返回的是新对象）');
  assert.notEqual(out, input);
  assert.equal(talentAtFiveStar(null), null, '没填天分就照旧返回 null（不编一份 0 出来）');
  // ×6 与公式的关系：括号里的 3 是"每个 0–10 点"，换成"每个内部点"就是 3 ÷ 6 = 0.5；
  // 社区老公式（`PANEL_FORMULA`）在 L=60 下的每点系数**正是**这个 0.5（0.55 ÷ 1.1、0.85 ÷ 1.7）
  const other60 = (LEVEL_FORMULA.cap + LEVEL_FORMULA.other.level) / LEVEL_FORMULA.other.divisor;
  const hp60 = (LEVEL_FORMULA.cap + LEVEL_FORMULA.hp.level) / LEVEL_FORMULA.hp.divisor;
  assert.equal(LEVEL_FORMULA.other.talent / STAR_BREAKTHROUGH.multiplier, PANEL_FORMULA.other.talent / other60);
  assert.equal(LEVEL_FORMULA.hp.talent / STAR_BREAKTHROUGH.multiplier, PANEL_FORMULA.hp.talent / hp60);
  assert.equal(LEVEL_FORMULA.other.talent / STAR_BREAKTHROUGH.multiplier, 0.5, '内部刻度下每点 0.5');
  // ⭐ 必红反证：`talentAtFiveStar` 写成恒等（不乘）
  const identity = (row) => ({...row});
  assert.equal(identity(input).atk, 10, '恒等实现给 10');
  assert.equal(out.atk, 60, '真实现给 60');
  assert.notEqual(identity(input).atk, out.atk);
  // ⭐ 必红反证：把 ×6 直接塞进 `3 × 资质`（系数不动 = 双重放大）—— 与已实测的噼啪鸟 294 必须对不上
  const pipa = {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 145};        // 噼啪鸟速度种族值 145
  const doubleCounted = Math.round((Math.round((145 + LEVEL_FORMULA.other.talent * 10 * 6) * 1.1) + 10) * 1.2) + 50;
  assert.equal(doubleCounted, 492, '双重放大会给出 492（资质那一项被算了 6 倍）');
  assert.equal(pvpPanelOf({race: pipa,
    talent: {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 10}, nature: '开朗'}).panel.spe, 294,
  '实现必须仍是实测那一档 294（见 tests/roco-panel-level.test.js ①）');
  assert.notEqual(doubleCounted, 294, '双重放大与实测 294 必须对不上 —— 这就是"算爆了"的样子');
});
