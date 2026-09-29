// U05（2026-09-29）：客户端**承伤相性**这一层的判据。
//
// 为什么必须有一组（都是"看起来在检查"的陷阱）
// ------------------------------------------------
//   ① 产物说自己是多少就是多少 —— 拿 `type-affinity.data.js` 自证 = 空转。
//      这里**自己读冻结真值** `data/roco/normalized/<ruleset>/types.json` **逐格复算**
//      （120 组合 × 18 攻击系 = 2160 格），一条都不信产物自述。
//   ② 「拿不到就当中性」是这条链上最容易犯的错 —— 那会让页面替引擎宣称"无影响"。
//      所以单独钉：未登记组合必须 `known:false`，且**不是** `neutral`。
//   ③ 反向键（`水系|光系` vs 冻结表里的 `光系|水系`）如果只做正序查，会**大面积**落回未知；
//      这一条也要有正向读数 + 反证。
//   ④ 最省事的假修法是"干脆写一个固定三角形"（用户原话：不能通过恢复固定箭头骗过视觉验收）。
//      所以这里同时钉「同一个函数、换属性必须换结果」。
//
// 用法：`node --test tests/roco-client-type-affinity.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

import {
  COMBO_COUNT,
  ENTRY_COUNT,
  RULESET_ID,
  SCALE_NEUTRAL,
  SOURCE_SHA256,
  comboKey,
  defenceMultiplier,
  defenceScaleMap,
  formatMultiplier,
  hasCombo,
  incomingAffinity,
} from '../src/client/type-affinity.js';
import {REPO_ROOT, buildAffinityData, renderAffinityModule} from '../scripts/roco/build-client-type-affinity.mjs';

const TYPES_PATH = join(REPO_ROOT, 'data', 'roco', 'normalized', RULESET_ID, 'types.json');
const PRODUCT_PATH = join(REPO_ROOT, 'src', 'client', 'type-affinity.data.js');
const frozen = JSON.parse(readFileSync(TYPES_PATH, 'utf8'));
const singles = Object.keys(frozen.types).filter((k) => !k.includes('|'));

test('① 产物与冻结真值**逐字节**同源（重新生成一遍再比）', () => {
  const raw = readFileSync(TYPES_PATH, 'utf8');
  assert.equal(createHash('sha256').update(raw).digest('hex'), SOURCE_SHA256,
    '产物里记的 source_sha256 必须等于冻结真值当下的 sha256');
  const regenerated = renderAffinityModule(buildAffinityData());
  assert.equal(readFileSync(PRODUCT_PATH, 'utf8'), regenerated,
    '磁盘上的产物与"从冻结真值重新生成"的结果不一致 ⇒ 有人手改了产物');
  assert.equal(COMBO_COUNT, Object.keys(frozen.types).length);
  assert.equal(ENTRY_COUNT, 1023, '非中性格数是被量过的一个数（改口径就必须同时改这里）');
});

test('② 2160 格逐格复算：产物与冻结真值一格都不许差', () => {
  let cells = 0;
  assert.equal(singles.length, 18, '冻结表必须有 18 个单属性键');
  for (const [key, entry] of Object.entries(frozen.types)) {
    const types = key.split('|');
    for (const attackType of singles) {
      const expected = (entry.weak ?? []).find((r) => r.type === attackType)?.multiplier
        ?? (entry.resist ?? []).find((r) => r.type === attackType)?.multiplier
        ?? 1;
      assert.equal(defenceMultiplier(types, attackType), expected, `${key} 挨 ${attackType}`);
      cells += 1;
    }
  }
  assert.equal(cells, 120 * 18, `逐格对照的格数（实际 ${cells}）`);
});

test('②-反证 改掉冻结表里的一格，同一条复算必须红', () => {
  const key = '光系';
  const attackType = '草系';
  const before = defenceMultiplier([key], attackType);
  assert.equal(before, 2, '光系挨草系是 ×2（真值）');
  // 不让复算变成"读产物自己说自己"：把它喂给一个改过的真值副本，必须对不上。
  const tampered = JSON.parse(JSON.stringify(frozen));
  tampered.types[key].weak = tampered.types[key].weak.map((r) => (r.type === attackType ? {...r, multiplier: 0.5} : r));
  const expectedFromTampered = (tampered.types[key].weak.find((r) => r.type === attackType)).multiplier;
  assert.notEqual(expectedFromTampered, before, '被改过的真值算出来的期望必须与产物不同（否则这条反证是摆设）');
});

test('③ 未登记组合 ⇒ 未知，**不是**中性（不许替引擎宣称"无影响"）', () => {
  const unknownCombo = incomingAffinity(['不存在的系'], ['火系']);
  assert.equal(unknownCombo.known, false);
  assert.equal(unknownCombo.direction, 'unknown');
  assert.notEqual(unknownCombo.direction, 'neutral', '"没登记"与"无影响"是两件事');
  assert.equal(unknownCombo.worst, null);
  assert.match(unknownCombo.reason, /不在冻结相性表里/);

  assert.equal(incomingAffinity([], ['火系']).known, false, '本体没属性 ⇒ 未知');
  assert.equal(incomingAffinity(['光系'], []).known, false, '对手属性没读到 ⇒ 未知');
  assert.equal(defenceMultiplier(['不存在的系'], '火系'), null, '未登记组合的倍率必须是 null，不是 1');
  assert.equal(defenceScaleMap([]), null);
  assert.equal(comboKey([]), null);
});

test('④ 反向键按集合语义命中（冻结表每对只登记一个方向）', () => {
  assert.equal(hasCombo(['水系', '光系']), true, '反序也要命中');
  assert.equal(hasCombo(['光系', '水系']), true, '正序命中');
  assert.equal(defenceMultiplier(['水系', '光系'], '草系'), defenceMultiplier(['光系', '水系'], '草系'),
    '两种键序必须给同一个倍率（防御相性的主语是属性集合）');
  // 反证：真的反序查表时要能读到非中性值，否则"命中"是假的。
  assert.equal(defenceMultiplier(['水系', '光系'], '草系'), 3, '水系|光系 挨草系是 ×3（相乘口径）');
});

test('⑤ 方向与文案：同函数换属性必须换结果（防"固定箭头"假修）', () => {
  const foe = ['火系'];
  const water = incomingAffinity(['水系'], foe);
  const grass = incomingAffinity(['草系'], foe);
  assert.equal(water.direction, 'resist', '水系挨火系 = 抵抗（up）');
  assert.equal(grass.direction, 'threat', '草系挨火系 = 被克制（down）');
  assert.notEqual(water.direction, grass.direction, '同一函数换个属性必须换结果');

  // 文案里**必须**同时有"承伤"和系别名与倍率：不能只靠颜色（用户口径：颜色配箭头和文字）。
  for (const row of [water, grass]) {
    assert.match(row.label, /^承伤 /);
    assert.match(row.label, /×/);
    assert.ok(foe.some((t) => row.label.includes(t)), `文案要点名是哪个系：${row.label}`);
  }
  assert.equal(water.label, '承伤 火系 ×0.5（抵抗）');
  assert.equal(grass.label, '承伤 火系 ×2（被克制）');
  assert.match(water.detail, /按对手属性系推算/, '口径要写在玩家点得开的地方');

  // 多属性对手：取**最坏**那一格并点名，绝不相乘（相乘会造出数据里没有的数）。
  const mixed = incomingAffinity(['水系'], ['火系', '电系']);
  assert.equal(mixed.direction, 'threat');
  assert.equal(mixed.worst.attackType, '电系');
  assert.equal(mixed.worst.multiplier, 2);
  assert.equal(mixed.label, '承伤 电系 ×2（被克制）');
});

test('⑥ 中性只有"真的算过"才写；档位与真值表逐字对应', () => {
  const neutral = incomingAffinity(['普通系'], ['普通系']);
  assert.equal(neutral.known, true);
  assert.equal(neutral.direction, 'neutral');
  assert.equal(neutral.label, '承伤中性');
  assert.equal(formatMultiplier(0.25), '×0.25');
  assert.equal(formatMultiplier(0.5), '×0.5');
  assert.equal(formatMultiplier(3), '×3');
  assert.equal(SCALE_NEUTRAL, 4);
});
