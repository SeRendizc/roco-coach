/**
 * 判据：个体层（一只精灵多个个体 + 刷新）。
 *
 * 人类 2026-09-26 的口径：默认 100 级；缺的数值归零并标注；性格刷新与天分刷新**分开**、各 3 次；
 * 刷新可复现并留历史；同种可重复拥有。掷点规则本仓没有官方概率 ⇒ 两条规则都必须标着"建模的、非实测"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  individualsFromDataset, individualFromInstance, groupBySpecies, panelOfIndividual,
  refresh, duplicateIndividual, seedOf, rngFrom, rollNature, rollTalentStat, boostedStatsOf,
  canUndo, undoLastRefresh, lastRefreshOf, rollbackAdvice, lastRefreshNote, undoUsed,
  REFRESH_LIMIT, ROLL_RULES, TALENT_STEP, TALENT_TIERS,
} from '../src/coach/individuals.js';
import {STAT_KEYS} from '../src/coach/talent.js';

const dataset = JSON.parse(readFileSync(new URL('../data/roco/owned/owned-pets.json', import.meta.url), 'utf8'));
const list = individualsFromDataset(dataset);
const one = list[0];

test('① 拥有精灵默认 100 级；天分/性格缺数值一律归零并标注（不许当实测）', () => {
  assert.equal(list.length, dataset.instances.length, '一条实例一个个体');
  assert.ok(list.every((row) => row.level === 100), '全部 100 级（人类口径）');
  assert.ok(list.every((row) => row.level_source.includes('default-100')), '级数来源要标注');
  // 改钉（2026-09-26，人类：「性格天分是随机的啊」）：原版抓到时**随机生成**性格与天分 ⇒
  // 数据集里没有这两项时，正确做法是**种子化掷一份**（不是留空、也不是记 0），并标明是掷出来的。
  assert.ok(list.every((row) => typeof row.nature === 'string' && row.nature.length >= 2), '每只都要有性格');
  assert.ok(list.every((row) => row.nature_source.includes('rolled')), '性格要标明是掷出来的');
  assert.ok(list.every((row) => row.talent_source.includes('rolled')), '天分要标明是掷出来的');
  assert.ok(list.every((row) => Object.values(row.talent).some((value) => value > 0)), '天分要有非零项');
  // 分布是**建模的**：随机三项 7–10、其余 0–6（与「了不起天分」的描述一致）——这一条要能被核对
  for (const row of list) {
    const high = STAT_KEYS.filter((stat) => row.talent[stat] >= 7);
    assert.equal(high.length, 3, `${row.individual_id} 应当恰好三项 ≥7：${JSON.stringify(row.talent)}`);
    assert.ok(high.every((stat) => row.talent[stat] <= 10), '天分单项不超过 10（一级口径）');
  }
  // 可复现：重新读一遍数据，同一只掷到的性格与天分必须一样
  const again = individualsFromDataset(dataset);
  assert.deepEqual(again.map((row) => [row.nature, row.talent]),
    list.map((row) => [row.nature, row.talent]), '掷点必须可复现（种子只来自 instance_id）');
  // 反证：数据集里确实没有这些值（判据不是空的）
  const raw = dataset.instances[0];
  assert.equal(raw.nature.value, null);
  assert.equal(raw.talent.value, null);
});

test('② 面板算得出来，但"天分按 0 计"这件事必须写在 unknown 里', () => {
  const race = {hp: 85, atk: 116, def: 101, spa: 38, spd: 82, spe: 120};
  const withRace = individualFromInstance({...dataset.instances[0]}, {level: 100});
  // 改钉（2026-09-26）：天分现在是**掷出来的**，所以这里给一份明确的天分来验"面板算得出来"。
  const result = panelOfIndividual({...withRace, talent: {hp: 0, atk: 0, spa: 0, def: 0, spd: 0, spe: 0}}, race);
  assert.equal(Object.keys(result.panel).length, 6, '六项都算得出来');
  assert.ok(Array.isArray(result.unknown), '要如实回一个 unknown 清单（可以有内容，也可以是空的）');
  // 掷出来的天分必须真的进面板：速度给 10 点 ⇒ 面板要涨
  const withTalent = panelOfIndividual({...withRace, talent: {hp: 0, atk: 0, spa: 0, def: 0, spd: 0, spe: 10}}, race);
  assert.ok(withTalent.panel.spe > result.panel.spe, '天分要真的进面板（每点 +6，PVP 口径）');
  // 给了性格之后，速度那一项必须真的变大（开朗是速度快处）
  const kai = panelOfIndividual({...withRace, talent: {hp: 0, atk: 0, spa: 0, def: 0, spd: 0, spe: 0}, nature: '开朗'}, race);
  assert.ok(kai.panel.spe > result.panel.spe, '开朗的速度要高于中性');
  assert.ok(kai.panel.spa < result.panel.spa, '开朗牺牲魔攻');
});

test('③ 两个刷新**分开计数**：各 3 次，用完就拒绝，刷一个不动另一个', () => {
  let row = one;
  assert.deepEqual(row.refreshes, {nature: REFRESH_LIMIT, talent: REFRESH_LIMIT});
  row = refresh(row, 'nature', {at: 'T1'});
  assert.deepEqual(row.refreshes, {nature: 2, talent: 3}, '刷性格不许动天分次数');
  row = refresh(row, 'talent', {at: 'T2'});
  assert.deepEqual(row.refreshes, {nature: 2, talent: 2}, '刷天分不许动性格次数');
  row = refresh(row, 'nature', {at: 'T3'});
  row = refresh(row, 'nature', {at: 'T4'});
  assert.equal(row.refreshes.nature, 0);
  assert.throws(() => refresh(row, 'nature'), (error) => error.code === 'no-refresh-left', '第 4 次必须拒绝');
  assert.equal(row.refreshes.talent, 2, '性格刷完了，天分那两次还在');
  assert.throws(() => refresh(row, 'unknown-kind'), /没有这种刷新/, '未知类型要拒绝');
});

test('④ 刷新**可复现**（同个体同第几次结果相同）；反证：不同个体不许总是同一个结果', () => {
  const a1 = refresh(one, 'nature', {at: 'T'});
  const a2 = refresh(one, 'nature', {at: 'T'});
  assert.equal(a1.nature, a2.nature, '同一个体同一次 ⇒ 同一个结果');
  assert.deepEqual(refresh(one, 'talent', {at: 'T'}).talent, refresh(one, 'talent', {at: 'T'}).talent, '天分同样可复现');
  // 重新从数据集读一遍也必须一样（跨进程一致：种子只来自 id/kind/第几次）
  const again = refresh(individualsFromDataset(dataset)[0], 'nature', {at: 'T'});
  assert.equal(again.nature, a1.nature, '重新读一遍数据也要掷出同一个结果');
  // 反证：48 个个体第一次刷性格，结果不许退化成常量
  const results = new Set(list.map((row) => refresh(row, 'nature', {at: 'T'}).nature));
  assert.ok(results.size >= 10, `48 次掷点至少要出现 10 种不同性格（实际 ${results.size} 种）`);
  // 改钉（2026-09-26，人类口述的新口径）：天分刷新**不是掷一个新值**，而是
  // 「一/二/三级各 +10、落到一个**还没被加过**的属性上」。
  const landing = new Set(list.map((row) => boostedStatsOf(refresh(row, 'talent', {at: 'T'}))[0]));
  assert.ok(landing.size >= 4, `第一级的落点要分散（实际落在 ${landing.size} 种属性上）`);
  assert.ok([...landing].every((stat) => typeof stat === 'string' && stat.length > 0), '落点必须是具体属性');
  // 第几次不同 ⇒ 结果可以不同（种子含"第几次"）
  const second = refresh(a1, 'nature', {at: 'T'});
  assert.notEqual(seedOf(one.individual_id, 'nature', 1, ''), seedOf(one.individual_id, 'nature', 2, ''));
});

test('⑤ 每次刷新都留历史：刷新前后的值 + 剩余次数 + 用的哪条规则', () => {
  const before = {...one.talent};
  const row = refresh(one, 'talent', {at: 'T7'});
  const last = row.history.at(-1);
  assert.equal(row.history.length, 1);
  assert.equal(last.kind, 'talent');
  assert.equal(last.used, 1, '记第几次');
  assert.deepEqual(last.before, before, 'before 必须是刷新前的那份');
  assert.deepEqual(last.after, row.talent, 'after 必须等于刷新后的那份');
  assert.equal(last.remaining, REFRESH_LIMIT - 1);
  assert.equal(last.rule, ROLL_RULES.talent.id, '记下用的是哪条掷点规则');
  assert.equal(last.at, 'T7', '时间由调用方给（便于复现）');
  // 指数增长的上限：历史只增不减
  const row2 = refresh(row, 'talent', {at: 'T8'});
  assert.equal(row2.history.length, 2);
  assert.deepEqual(row.history.length, 1, '旧对象不许被改（不可变）');
});

test('⑥ 刷新返回新对象，原个体一个字段都不许动', () => {
  const snapshot = JSON.stringify(one);
  refresh(one, 'nature', {at: 'T'});
  refresh(one, 'talent', {at: 'T'});
  duplicateIndividual(one, {individual_id: 'copy-x'});
  assert.equal(JSON.stringify(one), snapshot, '原个体必须逐字节不变');
});

test('⑦ 抽屉形状：同种多只归一组，count 对，best 稳定', () => {
  const twin = duplicateIndividual(one, {individual_id: `${one.individual_id}-b`});
  const groups = groupBySpecies([...list, twin]);
  assert.equal(groups.length, list.length, '同种多一只不会多出一组');
  const group = groups.find((row) => row.species_id === one.species_id);
  assert.equal(group.count, 2, '这一组里有两个个体');
  assert.deepEqual(group.individuals.map((row) => row.individual_id).sort(),
    [one.individual_id, twin.individual_id].sort());
  assert.equal(typeof group.best, 'string', '要给出默认展示哪一个（best）');
  // best 稳定：同样输入两次得到同一个 best
  assert.equal(groupBySpecies([...list, twin]).find((row) => row.species_id === one.species_id).best, group.best);
});

test('⑧ 可重复拥有：新个体 id 不同、刷新次数重置、两个体互不影响', () => {
  const twin = duplicateIndividual(one, {individual_id: `${one.individual_id}-b`, at: 'T'});
  assert.notEqual(twin.individual_id, one.individual_id);
  assert.deepEqual(twin.refreshes, {nature: REFRESH_LIMIT, talent: REFRESH_LIMIT});
  assert.equal(twin.nature, null, '新个体没有性格数据 ⇒ null');
  assert.ok(twin.talent_source.includes('zeroed'));
  assert.equal(twin.history[0].kind, 'duplicate', '留下"这是复制出来的"这条记录');
  const refreshed = refresh(twin, 'nature', {at: 'T'});
  assert.equal(one.refreshes.nature, REFRESH_LIMIT, '刷副本不许影响本体');
  assert.equal(refreshed.refreshes.nature, REFRESH_LIMIT - 1);
  assert.throws(() => duplicateIndividual(one, {individual_id: one.individual_id}), /不能和原来一样/);
  assert.throws(() => duplicateIndividual(one, {}), /需要一个新 individual_id/);
});

test('⑨ 掷点规则的诚实边界必须在：两条都标"建模的、非实测"', () => {
  // 改钉（2026-09-26）：性格掷点仍是**建模的均匀分布**（本仓没有官方概率）；
  // 天分刷新现在有**人类口述口径**（一/二/三级各 +10、落点不重复）⇒ 它从"建模"升到"实测口径"，
  // 但**幅度与次数是定死的、只有落点随机**这件事必须写在规则里。
  assert.equal(ROLL_RULES.nature.confidence, 'MODELLED_NOT_OBSERVED', '性格掷点仍是建模的');
  assert.ok(ROLL_RULES.nature.note.includes('不是实测') || ROLL_RULES.nature.note.includes('没有'));
  assert.equal(ROLL_RULES.talent.confidence, 'RECORDED_IN_GAME', '天分刷新有人类口述口径');
  assert.match(ROLL_RULES.talent.note, /不重复|没被加过/, '要说清"落点不重复"这个限制');
  // 改钉（2026-09-26）：**初始**天分/性格是掷出来的（原版随机）⇒ 标"建模的、非官方概率"
  const rolled = individualFromInstance({instance_id: 'own-9999', species_id: 'pet_x', species_name: 'X',
    level: 100, nature: {value: null}, talent: {value: null}}, {level: 100});
  assert.match(rolled.nature_source, /rolled/, '性格要标明是掷出来的');
  assert.match(rolled.talent_source, /建模的|非官方概率/, '天分分布要标明是建模的（不是官方概率）');
  assert.equal(TALENT_STEP, 10, '每级 +10（人类口径）');
  assert.equal(TALENT_TIERS, 3, '一/二/三级（人类口径）');
  assert.equal(REFRESH_LIMIT, 3, '次数上限与级数一致');
  // 反证：掷点确实用了这两条规则，而不是"随便返回一个"
  const nature = rollNature(seedOf('x', 'nature', 1, ''));
  assert.ok(typeof nature === 'string' && nature.length >= 2);
  // 改钉：天分只掷**落点**（幅度固定 +10）—— 落点必须是一个合法属性，且不在已加过的里面
  const stat = rollTalentStat(seedOf('x', 'talent', 1, ''), ['hp']);
  assert.ok(STAT_KEYS.includes(stat) && stat !== 'hp', `落点要合法且不重复：${stat}`);
  assert.equal(rollTalentStat(seedOf('x', 'talent', 1, ''), STAT_KEYS), null, '六项都加过 ⇒ 没有落点');
  // 三级加完之后：三项各 +10，且互不重复
  let one = individualsFromDataset(dataset)[0];
  // 改钉（2026-09-26）：初始天分现在是**掷出来的**（原版随机）⇒ 这里要比"加了多少"，
  // 不是比"加完等于 10"。判据的意图没变：每级 +10、三项不重复。
  const before = {...one.talent};
  for (let tier = 1; tier <= TALENT_TIERS; tier += 1) one = refresh(one, 'talent', {at: `T${tier}`});
  const boosted = boostedStatsOf(one);
  assert.equal(boosted.length, TALENT_TIERS, '三级共加三项');
  assert.equal(new Set(boosted).size, TALENT_TIERS, '三项互不重复（人类口径）');
  for (const stat2 of boosted) {
    assert.equal(one.talent[stat2] - before[stat2], TALENT_STEP, `${stat2} 应当正好 +${TALENT_STEP}`);
  }
  for (const stat2 of STAT_KEYS.filter((row) => !boosted.includes(row))) {
    assert.equal(one.talent[stat2], before[stat2], `没被加到的 ${stat2} 不许变`);
  }
  // PRNG 本身：同种子同序列、值域 [0,1)
  const a = rngFrom(12345); const b = rngFrom(12345);
  for (let i = 0; i < 5; i += 1) {
    const value = a();
    assert.equal(value, b(), '同种子必须同序列');
    assert.ok(value >= 0 && value < 1);
  }
});

// ── ⑩ 上一次刷新可回滚（人类 2026-09-26：让 coach 判断要不要回滚）──────────────────
// 2026-09-27 **改钉**（人类口述改口径，逐字）：「只能回上一个状态，不能回前两个状态；
// **不是回一次**；还是三次刷新次数，回滚的话**不消耗也不返还**次数。」
// 所以这一条从"只许回滚一次 + 次数归还"改成"只退一步 + 次数不退 + 中间刷过就能再退"。
test('⑩ 回滚只撤一步、次数**不退**、留痕；连着退被拒；"值不值"只给理由不拍板', () => {
  let one = individualsFromDataset(dataset)[0];
  assert.equal(canUndo(one), false, '还没刷过 ⇒ 没有可回滚的');
  assert.throws(() => undoLastRefresh(one), (error) => error.code === 'nothing-to-undo');
  const before = {...one.talent};
  const remainingBefore = one.refreshes.talent;

  one = refresh(one, 'talent', {at: 'T1'});
  assert.equal(canUndo(one), true);
  assert.equal(lastRefreshOf(one).kind, 'talent');

  // 值不值：给方向且落点不在方向上 ⇒ worth=true（只是材料，不是结论）
  const miss = rollbackAdvice(one, {priority: ['spe']});
  assert.equal(miss.worth, lastRefreshOf(one).stat === 'spe' ? false : true);
  assert.match(miss.text, /回滚/, '要说清回滚会发生什么');
  assert.doesNotMatch(miss.text, /就用它|必须回滚|一定要回/, '不许替玩家拍板');
  // 没说方向 ⇒ worth 是 null（不猜）
  assert.equal(rollbackAdvice(one, {}).worth, null);

  const rolled = undoLastRefresh(one, {at: 'T2'});
  assert.deepEqual(rolled.talent, before, '天分要回到刷新前');
  assert.deepEqual(rolled.talent_boosts, [], '那一级的加成账要删掉');
  assert.equal(rolled.refreshes.talent, remainingBefore - 1,
    '次数**不退**：退掉的那一次刷新不还给你（人类 2026-09-27 口述「不消耗也不返还」）');
  assert.equal(rolled.history.at(-1).kind, 'undo', '回滚本身要留痕');
  assert.equal(canUndo(rolled), false, '回滚之后没有可再撤的了（只撤一步）');
  assert.equal(JSON.stringify(one.talent_boosts).includes('tier'), true, '原对象不许被改（不可变）');

  // 性格那一路：回滚要换回原来那条
  let two = individualsFromDataset(dataset)[1];
  const natureBefore = two.nature;
  two = refresh(two, 'nature', {at: 'T1'});
  assert.notEqual(two.nature, natureBefore);
  const back = undoLastRefresh(two);
  assert.equal(back.nature, natureBefore, '性格要换回来');
  assert.equal(back.refreshes.nature, REFRESH_LIMIT - 1, '性格次数也不退（同一套规则）');
  // 「不能回前两个状态」：连着退第二步必须被拒（**同一只可以退多次，但中间必须真的刷过**）
  let three = individualsFromDataset(dataset)[2];
  for (const tier of [1, 2, 3]) three = refresh(three, 'talent', {at: `T${tier}`});
  assert.equal(lastRefreshOf(three).used, 3, '最近那一步是第 3 级');
  three = undoLastRefresh(three, {at: 'U3'});
  assert.equal(three.refreshes.talent, 0, '撤掉第 3 级，但那次刷新**不还**（还是 0 次）');
  assert.equal(canUndo(three), false, '刚退过一步 ⇒ 现在不能退（否则就是退回两步之前）');
  assert.throws(() => undoLastRefresh(three, {at: 'U2'}), (error) => error.code === 'already-undone',
    '第二次回滚必须明确拒绝，理由写清"一次只能退一步"');
  // 但**再刷一次之后又能退**（这就是"不是回一次"）。注意：次数不退 ⇒ 得留有余量才能再刷。
  let budget = individualsFromDataset(dataset)[3];
  budget = refresh(budget, 'talent', {at: 'B1'});
  assert.equal(budget.refreshes.talent, 2, '刷 1 次后剩 2');
  budget = undoLastRefresh(budget, {at: 'B2'});
  assert.equal(budget.refreshes.talent, 2, '退一步：次数不动（不还也不扣）');
  assert.equal(canUndo(budget), false, '刚退过 ⇒ 先不能再退');
  budget = refresh(budget, 'talent', {at: 'B3'});
  assert.equal(budget.refreshes.talent, 1, '再刷一次才扣 1 次（三次就是三次）');
  assert.equal(canUndo(budget), true, '中间真的刷过 ⇒ 可以再退一步');
  const twice = undoLastRefresh(budget, {at: 'B4'});
  assert.equal(twice.refreshes.talent, 1, '再退一次，次数同样不动');
  assert.equal(undoUsed(twice), 2, '同一只退过两次（中间刷过一次）—— 规则允许');
  // 余量用完后：退可以退，但**刷不回来了**（这就是"不返还"的实际后果）
  let spent = individualsFromDataset(dataset)[4];
  for (const tier of [1, 2, 3]) spent = refresh(spent, 'talent', {at: `S${tier}`});
  assert.equal(spent.refreshes.talent, 0, '三次用完');
  spent = undoLastRefresh(spent, {at: 'S4'});
  assert.equal(spent.refreshes.talent, 0, '退掉第 3 次也不还');
  assert.throws(() => refresh(spent, 'talent', {at: 'S5'}), (error) => error.code === 'no-refresh-left',
    '次数不退 ⇒ 退完之后这一只就定格了（想再要别的落点只能再养一只）');
});

// ── ⑪ 回滚与规则的四处矛盾（2026-09-27，审计 ④）────────────────────────────────────
test('⑪ 回滚之后重刷必须换落点（否则教练那句"换个落点可能更值"是假的）', () => {
  const one = individualsFromDataset(dataset)[0];
  const first = refresh(one, 'talent', {at: 'R1'});
  const land1 = boostedStatsOf(first).at(-1);
  const undone = undoLastRefresh(first, {at: 'R2'});
  assert.equal(undone.refreshes.talent, first.refreshes.talent, '退一步不动次数（人类口述）');
  const again = refresh(undone, 'talent', {at: 'R3'});
  const land2 = boostedStatsOf(again).at(-1);
  assert.notEqual(land1, land2, `回滚后重刷要落到另一项（第一次 ${land1}、重刷 ${land2}）`);
  // 但**没回滚过**时必须与从前逐字节一致（同个体同第几次 ⇒ 同落点）
  assert.equal(refresh(one, 'talent', {at: 'X'}).talent_boosts.at(-1).stat,
    refresh(one, 'talent', {at: 'X'}).talent_boosts.at(-1).stat, '同种子必须同落点');
  assert.equal(refresh(one, 'talent', {at: 'X'}).talent_boosts.at(-1).stat, land1,
    '没回滚过 ⇒ 与第一次落点相同（不能因为加了 undone 就把老行为改掉）');
  // 规则文字里不许再写"不可回退"
  assert.doesNotMatch(ROLL_RULES.talent.note, /不能回退|不可回退/, '规则文字要与实现一致');
  assert.match(ROLL_RULES.talent.note, /可以回滚/, '要写明可以回滚');
  assert.match(ROLL_RULES.talent.note, /另一个/, '要写明回滚后重刷换落点');
});


// ── ⑫ 刷新之后要说出"落在哪一项"（2026-09-27，§C6.313② 的收尾）─────────────────────
test('⑫ 刷新要报落点；回滚之后重刷要报"换掉了谁"（且不许用 `**`）', () => {
  const one = individualsFromDataset(dataset)[0];
  assert.equal(lastRefreshNote(one), null, '没刷过 ⇒ 没有这句话（不许编一句）');
  const first = refresh(one, 'talent', {at: 'N1'});
  const note1 = lastRefreshNote(first);
  assert.match(note1, /上一次刷天分（第 1 级）：\+10 加到「[^」]+」/, `要说出落在哪一项：${note1}`);
  assert.doesNotMatch(note1, /\*\*/, `这两处落点都是纯文本，不许出现 markdown 星号：${note1}`);
  assert.doesNotMatch(note1, /回滚之后重刷/, '没回滚过 ⇒ 不许说"回滚之后重刷"');
  const land1 = boostedStatsOf(first).at(-1);
  const undone = undoLastRefresh(first, {at: 'N2'});
  const again = refresh(undone, 'talent', {at: 'N3'});
  const note2 = lastRefreshNote(again);
  const land2 = boostedStatsOf(again).at(-1);
  assert.notEqual(land1, land2, '（前提）重刷要换落点');
  assert.match(note2, /回滚之后重刷/, `要说明这是回滚之后重刷的：${note2}`);
  assert.ok(note2.includes(`换掉了原来的「`) , `要说清换掉了原来的哪一项：${note2}`);
  assert.doesNotMatch(note2, /\*\*/, `不许出现 markdown 星号：${note2}`);
  // 性格那一侧同样要报（性格名就是落点本身）
  const two = refresh(individualsFromDataset(dataset)[1], 'nature', {at: 'N4'});
  assert.match(lastRefreshNote(two), /上一次刷性格：换成了「[^」]+」/, lastRefreshNote(two));
  const turned = refresh(undoLastRefresh(two, {at: 'N5'}), 'nature', {at: 'N6'});
  assert.match(lastRefreshNote(turned), /原来的「[^」]+」已经撤掉/, lastRefreshNote(turned));
  // 反证：把"没有 replaced 记录"的旧账喂进去 ⇒ 不许硬编一句"换掉了 X"
  const forged = {...again, history: again.history.map((row) => ({...row, replaced: undefined}))};
  assert.doesNotMatch(String(lastRefreshNote(forged)), /换掉了原来的/, '账上没有这一条就不许说');
});
