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
  natures, natureOf, natureFactor, panelOf, pvpPanelOf, natureCandidates, validateNatures,
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
  assert.equal(natureFactor('开朗', 'spe').factor, 1.2, '开朗的长处是速度');
  assert.equal(natureFactor('开朗', 'spa').factor, 0.9, '开朗的短处是魔攻');
  assert.equal(natureFactor('开朗', 'hp').factor, 1.0, '生命不受开朗影响');
  assert.equal(natureFactor('胆小', 'spe').factor, 1.2, '胆小的长处也是速度（短处是物攻）');
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

test('④ 面板公式：按笔记逐字实现的算例（手算三例，含性格加成）', () => {
  // 例一：开朗音速犬、天分全 0 ⇒ 速度 (1.1*120 + 0 + 10)*1.2 + 50 = 145.2 + ... 手算：142*1.2=170.4 → +50 = 220.4 → 220
  const kai = panelOf({race: RACE, talent: null, nature: '开朗'});
  assert.equal(kai.panel.spe, Math.round((1.1 * 120 + 10) * 1.2 + 50), '速度：长处 +20%');
  assert.equal(kai.panel.spa, Math.round((1.1 * 38 + 10) * 0.9 + 50), '魔攻：短处 −10%');
  assert.equal(kai.panel.hp, Math.round((1.7 * 85 + 70) * 1 + 100), '生命不受性格影响');
  // 例二：天分逐项加满 10 ⇒ 生命多 8.5、其他多 5.5（这是公式说的，不许替换成 TALENT_PVP_STEP 那套）
  const full = panelOf({race: RACE, talent: {hp: 10, atk: 10, spa: 10, def: 10, spd: 10, spe: 10}, nature: '开朗'});
  // 逐项按公式现算期望值（不写死魔数）：生命那一项每点 0.85、别项每点 0.55。
  // ⚠ 这里**必须**是公式那套，不许被 TALENT_PVP_STEP 的「每点 6」顶掉（判据 ⑥ 钉着这个冲突）。
  const expectHp = (iv) => Math.round((1.7 * 85 + 0.85 * iv + 70) * 1 + 100);
  assert.equal(full.panel.hp - kai.panel.hp, expectHp(10) - expectHp(0),
    `生命：个体值 10 点的净增（公式：0.85*10 = 8.5，不是 60）`);
  assert.equal(full.panel.spe - kai.panel.spe, Math.round((1.1 * 120 + 5.5 + 10) * 1.2 + 50) - kai.panel.spe);
  // 例三：性格换成正中和的（生命↑物攻↓ 的沉默）看速度不变
  const silent = panelOf({race: RACE, talent: null, nature: '沉默'});
  assert.equal(silent.panel.spe, kai.panel.spe - Math.round((1.1 * 120 + 10) * 1.2 + 50) + Math.round((1.1 * 120 + 10) * 1 + 50),
    '沉默不加速度 ⇒ 速度按中性算');
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

test('⑥ 未解决的口径冲突必须留着（不许悄悄合并两条来源）', () => {
  assert.equal(TALENT_PVP_STEP.table[10], 60, '笔记原文：个体值 10 ⇒ +60 面板');
  // 改钉（2026-09-26，人类：「你冲突自己查资料呀」）：查证之后**两条口径都留着**，
  // 但把"用哪条"写死成口径的一部分 —— 判据的意图没变：不许把两条来源悄悄合并成一条。
  assert.ok(TALENT_PVP_STEP.external_support.includes('TapTap'), '外部查证要写清出处');
  assert.match(TALENT_PVP_STEP.decision, /PVP 面板默认用/, '要写清哪条是 PVP 默认');
  assert.match(TALENT_PVP_STEP.decision, /保留|都留/, '另一条口径必须保留');
  // 把差别量化：公式给的是 8.5 / 5.5，那一套给的是 60 —— 差着一个数量级，所以不许混用
  const formulaStep = {hp: PANEL_FORMULA.hp.talent * 10, other: PANEL_FORMULA.other.talent * 10};
  assert.equal(formulaStep.hp, 8.5);
  assert.equal(formulaStep.other, 5.5);
  assert.notEqual(formulaStep.other, TALENT_PVP_STEP.table[10], '两条口径的结果必须仍然对不上');
  // 两条路都算得出来，且 PVP 那条**更大**（+6/点 vs 0.55/点）—— 这是我们选择它的理由，可核对
  const race = {hp: 100, atk: 100, spa: 100, def: 100, spd: 100, spe: 100};
  const talent = {hp: 0, atk: 0, spa: 0, def: 0, spd: 0, spe: 10};
  assert.ok(pvpPanelOf({race, talent}).panel.spe > panelOf({race, talent}).panel.spe,
    'PVP 口径（每点 +6）必须比成长口径（每点 0.55）把速度抬得更高');
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
  assert.ok(slow.panel.spe >= 220, `最快的性格速度不该低于中性：${slow.panel.spe}`);
});
