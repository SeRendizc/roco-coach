// 面板与等级（2026-09-27）：**等级公式** + **性格突破阶梯** 的判据 + 必红反证。
//
// 由来：人类当天拍板「pvp 没有的话就默认都 60 级别吧，数值你可以再查查看 60 级相比初始的怎么增加的，
// 查到直接做就行」。查到的两条（互相印证）：
//   · 官方公众号《洛个明白》逐字「精灵最高能升到 **60 级** 哦~」；
//   · 游戏导出配置表 `ATTR_GLOBAL_CONFIG`：非生命 `(L+50)/100`、生命 `(L+25)/50`，括号内 `种族值 + 3×个体值`。
// L=60 时它**退化**成社区那两行 PVP 公式（`(60+50)/100 = 1.1`、`(60+25)/50 = 1.7`）—— 这也解释了
// 「公式里为什么是 1.1」。
//
// 这一组钉：
//   ① **用我们自己的抓包数据**复算 wiki「PVP 一速榜」公布的 9 个速度值（9/9）；
//   ② 取整顺序（先 round 内层再加常数再乘性格再 round）—— 噼啪鸟必须 294，换个顺序就是 293；
//   ③ L=60 与老公式（`PANEL_FORMULA`，个体值按 ×6 内部刻度）**逐项相等**；
//   ④ 等级成长：其他项每级 `(种族+3×个体)/100`、生命是其 2 倍；默认 60 级；>60 级不算；
//   ⑤ 性格：零突破 +10%、每突破 +2%、满突破 +20%，**减益恒 −10% 不随突破变**；
//   ⑥ 必红反证：生命括号系数写错（2/6 而不是 1/3）、取整顺序换掉、减益跟着突破涨 —— 都必须红。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {panelOf, pvpPanelOf, natureFactor, LEVEL_FORMULA, NATURE_BREAKTHROUGH, PANEL_FORMULA}
  from '../src/coach/talent.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CATALOG = `${ROOT}data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json`;
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const byName = new Map(catalog.pets.map((pet) => [pet.name, pet]));
const TALENT_10 = Object.fromEntries(['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map((k) => [k, 10]));
/** 满级 / 满突破 / 个体值 10 的那一档（PVP 归一化）。 */
const pvpSpeed = (name, nature = '开朗') => pvpPanelOf({race: byName.get(name).stats,
  talent: TALENT_10, nature}).panel.spe;

test('① 用抓包数据复算「PVP 一速榜」：9/9（公式对不对，不看别人的结论）', () => {
  const published = {火神: 273, 落陨星兔: 273, 圣羽翼王: 267, 彩蝶鲨: 267, 电企鹅: 267,
    神谕鲨: 267, 音速犬: 260, 黑羽夫人: 260, 噼啪鸟: 294};
  const rows = [];
  for (const [name, want] of Object.entries(published)) {
    const pet = byName.get(name);
    assert.ok(pet, `图鉴里没有「${name}」——这张表必须逐只在我们的数据里能查到`);
    const got = pvpSpeed(name);
    rows.push(`${name} ${got}/${want}`);
    assert.equal(got, want, `${name}：算出来 ${got}（速度种族值 ${pet.stats.spe}），公布值 ${want}`);
  }
  assert.equal(rows.length, 9);
});

test('② 取整顺序敏感：噼啪鸟必须 294（换个顺序会掉到 293）', () => {
  const pet = byName.get('噼啪鸟');
  const race = pet.stats.spe;
  const right = Math.round((Math.round((race + 30) * 1.1) + 10) * 1.2) + 50;
  const wrong = Math.round(((race + 30) * 1.1 + 10) * 1.2 + 50);
  assert.equal(right, 294);
  assert.notEqual(wrong, right, '这条判据的前提：两种顺序真的会算出不同的数（否则它没有牙）');
  assert.equal(pvpSpeed('噼啪鸟'), right, '实现必须走"先 round 内层"那条');
});

test('③ L=60 与老公式**最多差 1**（1.1 就是 60 级的指纹；差的来源是内层 round）', () => {
  // 老公式（社区那两行）**没写取整**，而实测（②：噼啪鸟 294 而不是 293）要求**先把括号内 round 掉**。
  // 所以正确的说法不是"逐项相等"，而是：**逐项最多差 1**，且差的来源只有一个（内层 round）。
  // 这里把全体 622 只 × 3 种性格 × 6 项都算一遍，把"最多差 1"这句话变成可复算的数字。
  const talent = TALENT_10;
  let worst = 0; let compared = 0; let differing = 0; let sample = null;
  for (const pet of catalog.pets) {
    for (const nature of ['固执', '开朗', '保守']) {
      const now = pvpPanelOf({race: pet.stats, talent, nature}).panel;
      for (const stat of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
        const shape = stat === 'hp' ? PANEL_FORMULA.hp : PANEL_FORMULA.other;
        const legacy = Math.round((shape.race * pet.stats[stat] + shape.talent * talent[stat] * 6
          + shape.base) * natureFactor(nature, stat, {breakthrough: NATURE_BREAKTHROUGH.max}).factor)
          + shape.add;
        const diff = Math.abs(now[stat] - legacy);
        compared += 1;
        if (diff) differing += 1;
        if (diff > worst) { worst = diff; sample = `${pet.name}/${nature}/${stat} 新 ${now[stat]} 老 ${legacy}`; }
      }
    }
  }
  assert.equal(compared, catalog.pets.length * 3 * 6);
  assert.ok(differing > 0, '前提：内层 round 真的会改变一些项（否则这条判据没有牙）');
  assert.ok(worst <= 1, `最大差必须 ≤1（实测 ${worst}：${sample}）`);
  // 指纹本身：非生命 (60+50)/100、生命 (60+25)/50 —— 这是"1.1/1.7 从哪来"的答案
  assert.equal((LEVEL_FORMULA.cap + LEVEL_FORMULA.other.level) / LEVEL_FORMULA.other.divisor, 1.1);
  assert.equal((LEVEL_FORMULA.cap + LEVEL_FORMULA.hp.level) / LEVEL_FORMULA.hp.divisor, 1.7);
});

test('④ 等级成长：其他项每级 +(种族+3×个体)/100，生命是其 2 倍；默认 60；>60 不算', () => {
  const race = {hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100};
  const talent = Object.fromEntries(['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map((k) => [k, 0]));
  const at = (level, stat) => panelOf({race, talent, nature: '固执', scope: 'pvp', level}).panel[stat];
  // 其他：每级 +(100+0)/100 = 1 ⇒ 60 级比 1 级正好多 59（同一性格、同一取整路径）
  assert.equal(at(60, 'spe') - at(1, 'spe'), 59, '其他项每级 +1（种族 100、个体 0）');
  // 生命：每级是别人的 2 倍 ⇒ 多 118
  assert.equal(at(60, 'hp') - at(1, 'hp'), 118, '生命每级 +2');
  // 默认等级 = 60（人类口径）
  assert.equal(LEVEL_FORMULA.default_level, 60);
  assert.equal(panelOf({race, talent, nature: '固执', scope: 'pvp'}).panel.spe, at(60, 'spe'),
    '不写等级时就是 60 级');
  // 超过上限：不给面板 + 如实说明（不裁到 60 悄悄算）
  const over = panelOf({race, talent, nature: '固执', scope: 'pvp', level: 61});
  assert.deepEqual(over.panel, {}, '超过 60 级不算面板');
  assert.ok(over.unknown.some((row) => /60/.test(row)), `要说明为什么：${JSON.stringify(over.unknown)}`);
});

test('⑤ 性格阶梯：零突破 +10% → 满突破 +20%，减益恒 −10%（不随突破变）', () => {
  const ladder = [0, 1, 2, 3, 4, 5].map((bt) => [bt, natureFactor('开朗', 'spe', {breakthrough: bt}).factor]);
  assert.deepEqual(ladder.map(([, f]) => Number(f.toFixed(2))), [1.1, 1.12, 1.14, 1.16, 1.18, 1.2],
    '每突破 +2%、封顶 +20%');
  for (const bt of [0, 3, 5]) {
    assert.equal(natureFactor('开朗', 'spa', {breakthrough: bt}).factor, 0.9,
      '减益固定 −10%（随成长上升的只有增益那一侧）');
    assert.equal(natureFactor('开朗', 'atk', {breakthrough: bt}).factor, 1, '不受影响的那一项恒 1');
  }
  assert.deepEqual(NATURE_BREAKTHROUGH.levels, [20, 30, 40, 50, 60], '突破节点＝20/30/40/50/60 级');
  // 必红反证：减益若跟着突破往上爬（写成 1 + (-0.1 + 0.02×bt)）必须与上面那条不符
  const wrongDown = 1 + (-0.1 + 0.02 * 5);
  assert.notEqual(wrongDown, 0.9, '前提：错误实现真的会算出别的数');
});

test('⑥ 必红反证：生命括号系数写成 2/6（把"每级两倍"错当"括号内两倍"）必须被这条判据抓住', () => {
  const race = {hp: 120, atk: 137, def: 104, spa: 50, spd: 81, spe: 60};
  const right = pvpPanelOf({race, talent: TALENT_10, nature: '固执'}).panel.hp;
  const buggy = Math.round((Math.round((2 * 120 + 6 * 10) * (60 + 25) / 50) + 70) * 1) + 100;
  assert.equal(right, 425, '正确的 60 级生命：120 种族值 + 10 资质 ⇒ 425');
  assert.notEqual(buggy, right, '前提：写错系数真的会算出不同的数');
  assert.equal(buggy, 680, '写错会得到 680（这一条把"错法"也钉住，免得下次又写成它）');
  // 括号系数必须是 1/3（两条公式共用），只有等级偏置与括号外的常数不同
  assert.deepEqual([LEVEL_FORMULA.hp.race, LEVEL_FORMULA.hp.talent], [1, 3]);
  assert.deepEqual([LEVEL_FORMULA.other.race, LEVEL_FORMULA.other.talent], [1, 3]);
  assert.equal(LEVEL_FORMULA.hp.level, 25);
  assert.equal(LEVEL_FORMULA.other.level, 50);
  assert.equal(LEVEL_FORMULA.hp.divisor, 50);
  assert.equal(LEVEL_FORMULA.other.divisor, 100);
});
