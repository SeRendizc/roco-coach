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
//   ① **用我们自己的抓包数据**复算 wiki「PVP 一速榜」公布的 9 个速度值（9/9）——
//      ⚠ **2026-09-28 改钉**：人类第二次拍板「面板数值也要跟着变大」之后，**默认那一档（5 星）
//      不再是这 9 个数**，这 9 个数落在 `stars: 0`（零突破/不放大）那一档。榜单原值**保留不删**。
//   ② 取整顺序（先 round 内层再加常数再乘性格再 round）—— 两种顺序必须算出不同的数，且实现走对的那条；
//   ③ L=60 的指纹：非生命 (60+50)/100、生命 (60+25)/50；
//   ④ 等级成长：其他项每级 `(种族+3×个体)/100`、生命是其 2 倍；默认 60 级；>60 级不算；
//   ⑤ 性格：零突破 +10%、每突破 +2%、满突破 +20%，**减益恒 −10% 不随突破变**；
//   ⑥ 必红反证：生命括号系数写错（2/6 而不是 1/3）、取整顺序换掉、减益跟着突破涨 —— 都必须红。
//   ⑦ **2026-09-28 新增**：5 星档的资质放大倍数（`STAR_BREAKTHROUGH.talent_factor` = 6）必须真的进面板 ——
//      把 6 换成 1 必须红（否则"面板变大"这件事就没有牙）。

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
/**
 * 满级 / 满突破 / 个体值 10，**现在那一档**（5 星，资质按 ×6 真放大）。
 * ⚠ 2026-09-28 改钉：这一档以前等于下面 `pvpSpeedUnscaled`（榜单值），人类第二次拍板后不再相等。
 */
const pvpSpeed = (name, nature = '开朗') => pvpPanelOf({race: byName.get(name).stats,
  talent: TALENT_10, nature}).panel.spe;
/** 同一只、同一参数，但**不放大**（`stars: 0`）—— 外部「PVP 一速榜」那 9 个数在这一档上复现。 */
const pvpSpeedUnscaled = (name, nature = '开朗') => pvpPanelOf({race: byName.get(name).stats,
  talent: TALENT_10, nature, stars: 0}).panel.spe;

test('① 用抓包数据复算「PVP 一速榜」：9/9（**stars:0 那一档**，2026-09-28 改钉）', () => {
  // 榜单原值：2026-09-27 从 wiki 的「PVP 一速榜」抄回来的 9 个数，**改钉时一个字都没改**。
  const published = {火神: 273, 落陨星兔: 273, 圣羽翼王: 267, 彩蝶鲨: 267, 电企鹅: 267,
    神谕鲨: 267, 音速犬: 260, 黑羽夫人: 260, 噼啪鸟: 294};
  const rows = [];
  for (const [name, want] of Object.entries(published)) {
    const pet = byName.get(name);
    assert.ok(pet, `图鉴里没有「${name}」——这张表必须逐只在我们的数据里能查到`);
    const got = pvpSpeedUnscaled(name);
    rows.push(`${name} ${got}/${want}`);
    assert.equal(got, want, `${name}：算出来 ${got}（速度种族值 ${pet.stats.spe}），公布值 ${want}`);
  }
  assert.equal(rows.length, 9);
});

// ── 2026-09-28 新档（人类第二次拍板：「面板数值也要跟着变大」）──────────────────
// 人类原话逐字：见 `src/coach/talent.js` 的 `STAR_BREAKTHROUGH.panel_scale_decision`。
// 这一档的公式 = `种族 + 3 × 6 × 资质(0–10)`（5 星，资质 ×6 真的放大进面板）。
// 下面这 9 个数是**用本仓自己的图鉴六维 + 本仓公式现算出来的**，不是抄来的。
const SCALED_20260928 = {火神: 471, 落陨星兔: 471, 圣羽翼王: 465, 彩蝶鲨: 465, 电企鹅: 465,
  神谕鲨: 465, 音速犬: 458, 黑羽夫人: 458, 噼啪鸟: 492};

test('①b 新档（5 星放大）逐只等于现算值，且与「旧榜那一档」不是同一个数', () => {
  for (const [name, want] of Object.entries(SCALED_20260928)) {
    assert.equal(pvpSpeed(name), want, `${name}：5 星档算出来 ${pvpSpeed(name)}，登记的是 ${want}`);
  }
  // 牙：这两档必须真的不同 —— 否则"面板变大"这件事没有发生
  assert.notEqual(pvpSpeed('噼啪鸟'), pvpSpeedUnscaled('噼啪鸟'));
  assert.equal(pvpSpeed('噼啪鸟') - pvpSpeedUnscaled('噼啪鸟'), 198);
});

test('② 取整顺序敏感：两种顺序必须算出不同的数，且实现走「先 round 内层」那条', () => {
  const pet = byName.get('噼啪鸟');
  const race = pet.stats.spe;
  const right = Math.round((Math.round((race + 180) * 1.1) + 10) * 1.2) + 50;
  const wrong = Math.round(((race + 180) * 1.1 + 10) * 1.2 + 50);
  assert.notEqual(wrong, right, '这条判据的前提：两种顺序真的会算出不同的数（否则它没有牙）');
  assert.equal(pvpSpeed('噼啪鸟'), right, '实现必须走"先 round 内层"那条');
  // 旧档（不放大）上也必须同样敏感：`race + 30` 那一档
  const rightOld = Math.round((Math.round((race + 30) * 1.1) + 10) * 1.2) + 50;
  assert.equal(rightOld, 294, '旧榜那一档必须仍是 294（榜单原值，改钉不删）');
  assert.equal(pvpSpeedUnscaled('噼啪鸟'), rightOld);
});

test('③ L=60 的指纹：非生命 (60+50)/100 = 1.1、生命 (60+25)/50 = 1.7', () => {
  assert.equal((LEVEL_FORMULA.cap + LEVEL_FORMULA.other.level) / LEVEL_FORMULA.other.divisor, 1.1);
  assert.equal((LEVEL_FORMULA.cap + LEVEL_FORMULA.hp.level) / LEVEL_FORMULA.hp.divisor, 1.7);
});

test('③b 5 星档的资质系数：`3 × talent_factor`，把 talent_factor 换成 1 就是旧档', () => {
  const race = {hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100};
  const talent = Object.fromEntries(['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map((k) => [k, 10]));
  const five = pvpPanelOf({race, talent, nature: '开朗'}).panel;
  const zero = pvpPanelOf({race, talent, nature: '开朗', stars: 0}).panel;
  // 非生命：`'开朗'` 增速 ⇒ ×1.2（满突破那一档）：((100 + 180) × 1.1) 先 round → +10 → ×1.2 → round → +50
  assert.equal(five.spe, Math.round((Math.round((100 + 180) * 1.1) + 10) * 1.2) + 50);
  // 旧档 = 3×10（资质不放大）
  assert.equal(zero.spe, Math.round((Math.round((100 + 30) * 1.1) + 10) * 1.2) + 50);
  // 生命不受开朗影响（开朗增减的是速度与物攻）：(100 + 180) × (60+25)/50 → round → +70 → ×1 → round → +100
  assert.equal(five.hp, Math.round((Math.round((100 + 180) * 1.7) + 70) * 1) + 100);
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
  const buggy = Math.round((Math.round((2 * 120 + 6 * 6 * 10) * (60 + 25) / 50) + 70) * 1) + 100;
  // ⚠ 2026-09-28 改钉：5 星档的资质项是 `3 × 6 = 18`（面板真放大）⇒ 正确值 680、错法 1190。
  // 旧口径（资质不放大）那两个数是 425 / 680 —— 数字变了，**这条判据的意图一个字没变**。
  assert.equal(right, 680, '正确的 60 级生命：120 种族值 + 10 资质（5 星档）⇒ 680');
  assert.notEqual(buggy, right, '前提：写错系数真的会算出不同的数');
  assert.equal(buggy, 1190, '写错会得到 1190（这一条把"错法"也钉住，免得下次又写成它）');
  // 括号系数必须是 1/3（两条公式共用），只有等级偏置与括号外的常数不同
  assert.deepEqual([LEVEL_FORMULA.hp.race, LEVEL_FORMULA.hp.talent], [1, 3]);
  assert.deepEqual([LEVEL_FORMULA.other.race, LEVEL_FORMULA.other.talent], [1, 3]);
  assert.equal(LEVEL_FORMULA.hp.level, 25);
  assert.equal(LEVEL_FORMULA.other.level, 50);
  assert.equal(LEVEL_FORMULA.hp.divisor, 50);
  assert.equal(LEVEL_FORMULA.other.divisor, 100);
});
