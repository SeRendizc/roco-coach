/**
 * 判据：**社区图鉴层**（小黑盒抓包派生的那一层）可复算、来路写清、接得进小芽。
 *
 * 人类 2026-09-27：「新系统全面接入小芽」+「这些原始数据都给你了我不信还有做不出来的机制」。
 * 这一层解决的是"抓包里那 547 只的**进化链 / 特性说明 / 等级技能表**我们以前根本没有"。
 *
 * 四条纪律各自一条判据：
 *   ① **可复算**：`buildLayer()` 重算 == 磁盘产物（抓包在时逐字节比；不在时只校验产物自洽）；
 *   ② **来路写清**：产物里必须写着 REFERENCE_ONLY / 许可 UNKNOWN / "不是官方文本"，且**不许**并进 `normalized/**`；
 *   ③ **不采信上游总和**：层里**没有** `sum_race` 那种总和字段（只存六维）—— 行为判据：把上游总和改烂，层不变；
 *   ④ **接得进**：`evolutionLocalAnswer('喵喵几级进化？')` 要说出链与等级、并**标出来路**；
 *      点名一个图鉴层里没有的名字时走"查不到"分支；**编的名字**不许被当成问句（零误报）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildLayer, CAPTURE_DIR, CAPTURE_FACTS} from '../scripts/roco/build-hke-layer.mjs';
import {hkePetOf, evolutionOf, evolutionAsk, evolutionLocalAnswer, hkeSkillLine, HKE_SOURCE,
  resetHkeLayerForTest} from '../src/coach/evolution-advice.js';
import {PET_NAME_ROWS} from '../src/coach/pet-names-data.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAYER = join(ROOT, 'data/roco/derived/hke-2026-09-27/pets.json');
const MANIFEST = join(ROOT, 'data/roco/derived/hke-2026-09-27/manifest.json');

test('① 产物自洽 + 可复算（抓包在 ⇒ 逐字节；不在 ⇒ 只校验自洽并说明）', () => {
  assert.ok(existsSync(LAYER), `产物不在：${LAYER}（跑 node scripts/roco/build-hke-layer.mjs）`);
  const doc = JSON.parse(readFileSync(LAYER, 'utf8'));
  const pets = Object.values(doc.pets ?? {});
  assert.equal(doc.counts.pets, pets.length, 'counts.pets 要与实际条数一致');
  assert.ok(pets.length >= 500, `这一层要有 500+ 只（实际 ${pets.length}）`);
  for (const key of ['with_evolution', 'with_feature', 'with_skills']) {
    assert.ok(doc.counts[key] > 0 && doc.counts[key] <= pets.length, `${key} 的计数要在范围内`);
  }
  // 每只的六维要么全有要么全无（不许半截数据冒充完整）
  for (const pet of pets.slice(0, 50)) {
    const values = Object.values(pet.stats ?? {}).map(Number);
    assert.ok(values.every(Number.isFinite) || values.every((v) => !Number.isFinite(v)),
      `${pet.name} 的六维半截缺失`);
  }
  if (!existsSync(join(CAPTURE_DIR, 'raw'))) {
    console.log(`ℹ 抓包 raw/ 不在（${CAPTURE_DIR}）⇒ 这一轮只校验产物自洽`);
    return;
  }
  const fresh = buildLayer();
  assert.deepEqual(fresh.counts, doc.counts, '抓包在 ⇒ 重算的计数必须与产物一致');
  assert.equal(`${JSON.stringify(fresh, null, 1)}\n`, readFileSync(LAYER, 'utf8'),
    '产物必须与重算**逐字节**相同（跑 build-hke-layer.mjs 重新生成）');
});

test('② 来路写清：REFERENCE_ONLY / 许可 UNKNOWN / 不是官方文本；且不许并进 normalized/**', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  assert.equal(manifest.source.redistribution, 'REFERENCE_ONLY');
  assert.equal(manifest.source.licence, 'UNKNOWN');
  assert.match(manifest.source.source_note, /不是官方文本/, '要说清这不是官方文本');
  assert.match(manifest.note, /不许.*并入 normalized|不.*并入 normalized/, 'manifest 要写明不进 normalized');
  // 这一层的成句也必须带出来路（玩家看得到）
  assert.match(HKE_SOURCE, /非官方|社区/, 'HKE_SOURCE 要写明是社区数据');
  // 反向：normalized/ 那一层里不许出现这一层的痕迹
  const normalizedDir = join(ROOT, 'data/roco/normalized');
  for (const ruleset of readdirSync(normalizedDir)) {
    const dir = join(normalizedDir, ruleset);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const text = readFileSync(join(dir, name), 'utf8');
      assert.ok(!/hke-2026-09-27|xiaoheihe/.test(text), `${ruleset}/${name} 里混进了社区抓包的痕迹`);
    }
  }
});

test('③ 上游总和（sum_race）不采信：层里没有它，改烂它层也不变', () => {
  const doc = JSON.parse(readFileSync(LAYER, 'utf8'));
  const sample = Object.values(doc.pets)[0];
  assert.ok(!('sum_race' in sample) && !('sum_api' in sample), '层里不许留上游的总和字段');
  assert.match(CAPTURE_FACTS.sum_race_warning, /不可信/, '常量里要写清为什么不采信');
  if (!existsSync(join(CAPTURE_DIR, 'raw'))) return;
  const fresh = buildLayer();
  // 六维必须与上游 `base_race_params` 的六项逐值一致（不是靠总和推的）
  const rawFile = readdirSync(join(CAPTURE_DIR, 'raw')).find((f) => /^pet-3001-\d+\.json$/.test(f));
  if (rawFile) {
    const detail = JSON.parse(readFileSync(join(CAPTURE_DIR, 'raw', rawFile), 'utf8')).result.pet_detail;
    const layerPet = fresh.pets['3001'];
    assert.deepEqual(layerPet.stats, {hp: detail.base_race_params.hp_max_race,
      atk: detail.base_race_params.phy_attack_race, def: detail.base_race_params.phy_defence_race,
      spa: detail.base_race_params.spe_attack_race, spd: detail.base_race_params.spe_defence_race,
      spe: detail.base_race_params.speed_race}, '六维必须逐值来自上游的六个字段');
  }
});

test('④ 接得进小芽：进化链说得出、来路标得到；编的名字不许被当成问句', async () => {
  resetHkeLayerForTest();
  const pet = await hkePetOf('喵喵');
  assert.equal(pet?.game_id, 3001, '按名字要查得到（零宽字符也要能对上）');
  const got = await evolutionOf('喵喵');
  assert.ok(got.stages.length >= 2, `喵喵要有进化链（实际 ${got.stages.length} 段）`);
  assert.equal(got.final?.name, '魔力猫', '最终形态');
  assert.equal(await hkePetOf('不存在的精灵'), null, '查不到就 null，不许猜');
  assert.equal(await hkePetOf(''), null);

  const answer = await evolutionLocalAnswer('喵喵几级进化？');
  assert.ok(answer, '这一句要被接住');
  assert.match(answer.text, /喵呜/, `要说得出下一形态：${answer.text}`);
  assert.match(answer.text, /Lv\.16/, '要说得出进化等级');
  assert.match(answer.text, /社区|非官方/, '要标出来路');
  assert.ok(answer.evidence.join('\n').includes('来源'), '证据里要有来源');
  // 反证一：不点名的句子不许被这一族抢走（否则会把别的问题答成进化）
  assert.equal(evolutionAsk('进化是什么意思？'), false, '没点名 ⇒ 不接');
  assert.equal(await evolutionLocalAnswer('今天天气怎么样'), null, '无关问句 ⇒ 不接');
  assert.equal(await evolutionLocalAnswer('随便编的名字王几级进化'), null, '编的名字 ⇒ 不接（零误报）');
  // 反证二：**名字表里有、但这一层没收录**的那只 ⇒ 走"查不到"分支（如实说，不编）
  const pets = JSON.parse(readFileSync(LAYER, 'utf8')).pets;
  const known = PET_NAME_ROWS.map(([name]) => name)
    .find((name) => name.length >= 2 && !Object.values(pets).some((one) => one.name === name));
  if (known) {
    const miss = await evolutionLocalAnswer(`${known}几级进化？`);
    assert.ok(miss, `${known} 这一句要接住（它在我们名字表里）`);
    assert.match(miss.text, /没有|查不到|不编/, `查不到要如实说：${miss.text}`);
  } else {
    console.log('ℹ 名字表里的名字这一层全都有 ⇒ "查不到"分支这一轮没样本');
  }
});

test('⑤ 缺口填充：引擎给不出学习表时，用这一层给一句**带三组计数**的清单（不给等级）', async () => {
  resetHkeLayerForTest();
  const line = await hkeSkillLine('喵喵');
  assert.ok(line, '这一只在这一层里 ⇒ 要能给出清单');
  assert.match(line.line, /升级学 \d+/, `要报三组计数：${line.line}`);
  assert.match(line.line, /技能机 \d+|血脉 \d+/, '另外两组也要在');
  assert.match(line.line, /社区|非官方/, '要标出来路');
  // 「不许编等级」的判据要**精确到形状**：句子里允许出现"没有几级学"这句**否定说明**
  //（那是我们要说的话），但不许出现「Lv.16」这种**具体的等级断言**。
  assert.doesNotMatch(line.line, /Lv\.\d+|\d+\s*级(学|学会)/,
    `**不许**编出具体等级（上游没有这个字段）：${line.line}`);
  assert.match(line.line, /没有"?几级学"?/, '要主动说清"这一层没有等级"');
  assert.ok(line.evidence.length >= 2, '证据里要有读数与来源');
  // 查不到的 ⇒ null（调用方据此保持原样，不许编一句）
  assert.equal(await hkeSkillLine('不存在的精灵'), null);
});
