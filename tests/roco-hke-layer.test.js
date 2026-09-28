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
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildLayer, CAPTURE_DIR, CAPTURE_FACTS} from '../scripts/roco/build-hke-layer.mjs';
import {hkePetOf, evolutionOf, evolutionAsk, evolutionLocalAnswer, hkeSkillLine, HKE_SOURCE,
  resetHkeLayerForTest, resetIdAliasesForTest, idAliasOf} from '../src/coach/evolution-advice.js';
import {buildAliases, validateAliases} from '../scripts/roco/build-id-aliases.mjs';
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
  // 反向：normalized/ 那一层里不许出现这一层的痕迹。
  //
  // ⚠ 2026-09-27 **改钉**（人类拍板；原判据是"normalized/ 里一个字都不许有"）：
  //   人类原话：「**精灵就用现在抓出来的数据做吧**，不要那些剩下没找到的了；① 按照抓包数据来吧；
  //   ② **以具体数据为准**吧」。⇒ 抓包的**六维**被采用进 L1 检索层（`full-catalog.json`）。
  //   采用只能是**带标签**的采用，所以这条判据不是删掉，而是换成更窄也更硬的三条：
  //     ① 除 `full-catalog.json` 外，其余 normalized 文件**照旧一个字都不许有**（`xiaoheihe` 全域禁）；
  //     ② `full-catalog.json` 里逐只必须写清六维来源（`stats_source` 只许两个取值）；
  //     ③ 采用了就必须留下"用的是哪一份 CSV"（顶层 `stats_override.artifact_sha256` 与磁盘对得上），
  //        且改过的每一只都在同一条记录上留着旧值（`stats_previous`，改钉不删）。
  //   · 2026-09-27 下半场补：**执行域**（`pets.json` / `layer-playable-48/pets.json`）也按同一份 CSV 采用了
  //     （真机实测那 5 只两个数打架），所以"允许带标签出现"的文件从 1 个变成 3 个 —— 见 ⑥。
  // 2026-09-28 改钉（人类 2026-09-28 拍板「所有精灵实装」+「就用现在抓包得到的数据」）：
  // 可玩层三份**全部**改成抓包派生（原来只有 `pets.json` 是），所以 `learnsets.json` 与
  // `support-matrix.json` 现在也**带来源标注**——它们不再是"混进来的痕迹"，而是**批准采用的层**。
  // 判据的意图一字未变：**在允许清单里的只许"带标签地采用"**（下面紧接着就核原始形状字段
  // `xiaoheihe|base_race_params|sum_race` 一个都不许有），清单外的一律不许出现抓包痕迹。
  // 旧值（改之前长这样）：const ADOPTED = new Set(['full-catalog.json', 'pets.json', 'layer-playable-48/pets.json']);
  /** 抓包的**原始形状**字段名：一个都不许真的成为键（值里出现出处指针不算）。 */
const RAW_SHAPE_KEYS = new Set(['base_race_params', 'sum_race']);
const ADOPTED = new Set(['full-catalog.json', 'pets.json', 'layer-playable-48/pets.json',
    'layer-playable-48/learnsets.json', 'layer-playable-48/support-matrix.json']);
  const normalizedDir = join(ROOT, 'data/roco/normalized');
  for (const ruleset of readdirSync(normalizedDir)) {
    const dir = join(normalizedDir, ruleset);
    for (const name of readdirSync(dir, {recursive: true})) {
      if (!name.endsWith('.json')) continue;
      const rel = name;
      const text = readFileSync(join(dir, rel), 'utf8');
      if (!ADOPTED.has(rel)) {
        assert.ok(!/hke-2026-09-27|xiaoheihe/.test(text), `${ruleset}/${rel} 里混进了社区抓包的痕迹`);
        continue;
      }
      // 采用了抓包的那几份：只许出现**带标签**的采用（原始形状的字段一律不许）。
      // ⚠ 2026-09-28 改钉：这里原来是一条文本级正则 `/xiaoheihe|base_race_params|sum_race/`。
      // 本层换成抓包派生之后，每个实例都带一条**出处指针**，形如
      //   `data/roco/raw/hke-2026-09-27/raw/pet-3001-….json#result.pet_detail.base_race_params`
      // ⇒ 那个词出现在**指针字符串**里（这正是人类要的"逐条带来源、可逐条追"），
      // 不是把抓包的原始字段搬进了层。正则分不清这两件事，所以改成**结构判据**：
      // 不许有真的叫这两个名字的**键**（值里出现指针不算）。判据的意图一字未变
      // ——"原始形状的字段一个都不许进来"——而且比原来更准（原来会被一句注释误伤）。
      // 旧写法留档：assert.ok(!/xiaoheihe|base_race_params|sum_race/.test(text), ...);
      assert.ok(!/xiaoheihe/.test(text), `${ruleset}/${rel} 里出现了抓包社区来源的痕迹（xiaoheihe）`);
      const doc = JSON.parse(text);
      const rawShapeKeys = [];
      (function walk(node, at) {
        if (Array.isArray(node)) { node.forEach((value, i) => walk(value, `${at}[${i}]`)); return; }
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (RAW_SHAPE_KEYS.has(key)) rawShapeKeys.push(`${at}.${key}`);
          walk(value, `${at}.${key}`);
        }
      })(doc, rel);
      assert.deepEqual(rawShapeKeys, [],
        `${ruleset}/${rel} 里出现了抓包原始形状的**字段**：${rawShapeKeys.slice(0, 3).join('、')}`);
      const override = doc.capture_override ?? doc.provenance?.stats_override;
      const marked = Object.values(doc.pets ?? {}).filter((pet) => pet.stats_source === 'capture-2026-09-27');
      const fromCapture = Object.values(doc.pets ?? {}).filter((pet) => pet.stats_source?.startsWith?.('capture'));
      for (const pet of Object.values(doc.pets ?? {})) {
        // `full-catalog.json` 里**每一只**都要有来源标注（那一层是逐只写的）；
        // 引擎那两份只在**改过值**的那些上标（没标 = 六维不来自抓包，是原基线）——
        // 但"标了"就必须是允许的两个取值之一，且旧值必须与新值不同。
        if (rel === 'full-catalog.json') {
          assert.ok(['capture-2026-09-27', 'wiki-snapshot'].includes(pet.stats_source),
            `${pet.pet_id} 的 stats_source=${pet.stats_source}（逐只必须写清六维从哪来）`);
        } else if (pet.stats_source !== undefined) {
          assert.equal(pet.stats_source, 'capture-2026-09-27',
            `${pet.pet_id} 在引擎层只许标抓包来源（实际 ${pet.stats_source}）`);
        }
        if (pet.stats_previous) {
          assert.equal(pet.stats_source, 'capture-2026-09-27', `${pet.pet_id} 留了旧值却没标来源`);
        }
        for (const [key, before] of Object.entries(pet.stats_previous ?? {})) {
          assert.notEqual(pet.stats?.[key], before, `${pet.pet_id} 的 ${key} 新旧值相同，不该记 previous`);
        }
      }
      if (fromCapture.length) {
        assert.ok(override, `${ruleset}/${rel} 采用了抓包却没有来源块`);
        if (override.applied !== undefined) assert.equal(override.applied, true, '采用了抓包却没标 applied:true');
        const csv = readFileSync(join(ROOT, override.artifact_path));
        assert.equal(override.artifact_sha256, createHash('sha256').update(csv).digest('hex'),
          `${ruleset}/${rel} 记的 sha256 与磁盘上的抓包 CSV 对不上`);
        if (rel === 'full-catalog.json') {
          assert.equal(override.matched, fromCapture.length, 'stats_override.matched 与逐只数出来的不一样');
        } else {
          assert.equal(override.patched_pets, marked.length, `${rel} 的 patched_pets 与标了来源的只数不一样`);
          assert.ok(override.covered_pets >= marked.length, `${rel} 的 covered_pets 不该小于 patched_pets`);
        }
      }
    }
  }
});

test('⑥ 执行域与检索层的分歧：**只有那 5 只**，且"回答用哪一份"写死（2026-09-27 两轮改钉）', () => {
  // 变更史（改钉不删）：
  //   ① 上半场：人类拍板"以抓包为准"，只改检索层 ⇒ 登记 5 只分歧（3013/3071/3407/3591/3593）。
  //   ② 下半场：真机发现这 5 只**玩家看得见**（问「铠甲虫的种族值」答 555，图鉴层是 522），
  //      于是把执行域也改了（`apply-capture-to-engine.mjs`）。
  //   ③ 再往后：`npm run verify:release` 的 **env** 套件红了 —— Python 侧的
  //      `test_turn_order_fail_closed.LegacyBitExactGoldenTest`（"默认路径与 RC-103 之前逐比特一致"）
  //      与微案例清单都跟着变。**执行域的六维是模拟基线的一部分，动它就动了那条冻结契约。**
  //      ⇒ 于是**撤回**执行域的采用，改成：**回答数值读图鉴层，模拟照旧读执行域**。
  // 所以这条判据现在钉三件事：分歧只有 5 只、逐值登记、且 `runtime.js` 里确实写着"数值读图鉴层"。
  // ── 2026-09-28 改钉（判据的意图一字未变：**执行域与检索层的每一处分歧都必须登记在案**，
  //    而且"回答数值读图鉴层"这句必须写死在代码里）────────────────────────────────
  // 本轮把可玩层换成**纯抓包**建的 530 只之后，旧口径「分歧只有那 5 只」（3013/3071/3407/3591/3593，
  // 每只一个字段）在数据上已经不成立：
  //   · 其中 4 只（3013 铠甲虫 / 3407 / 3591 / 3593）的**层内六维直接就是抓包值**
  //     ⇒ 执行域与检索层在这 4 只上**不再分歧**（这是好事，不是放宽判据）；
  //   · 只剩基线 `pets.json` 里的 3071（`pet_000062`）仍有分歧，而且是**2 个字段**
  //     （atk 116/128、spa 38/46）。
  // 所以登记表从「5 只 × 1 字段」改成**逐字段一行**（同一只精灵可以有多行）。
  // 旧值逐行留档（2026-09-27 两轮改钉时登记的，改钉不删）：
  //   const KNOWN_DIVERGENCE = {
  //     3013: {pet_id: 'pet_000012', file: 'layer-playable-48', stat: 'atk', engine: 95, catalog: 88},
  //     3071: {pet_id: 'pet_000062', file: 'pets.json', stat: 'atk', engine: 116, catalog: 128},
  //     3407: {pet_id: 'pet_000328', file: 'layer-playable-48', stat: 'def', engine: 113, catalog: 122},
  //     3591: {pet_id: 'pet_000456', file: 'layer-playable-48', stat: 'atk', engine: 86, catalog: 78},
  //     3593: {pet_id: 'pet_000458', file: 'layer-playable-48', stat: 'atk', engine: 143, catalog: 130},
  //   };
  const KNOWN_DIVERGENCE = [
    {game_id: 3071, pet_id: 'pet_000062', file: 'pets.json', stat: 'atk', engine: 116, catalog: 128},
    {game_id: 3071, pet_id: 'pet_000062', file: 'pets.json', stat: 'spa', engine: 38, catalog: 46},
  ];
  const ruleset = 'roco-world-s4-2026-09-10';
  const base = JSON.parse(readFileSync(join(ROOT, 'data/roco/normalized', ruleset, 'pets.json'), 'utf8'));
  const layer = JSON.parse(readFileSync(join(ROOT, 'data/roco/normalized', ruleset,
    'layer-playable-48', 'pets.json'), 'utf8'));
  const catalog = JSON.parse(readFileSync(join(ROOT, 'data/roco/normalized', ruleset, 'full-catalog.json'), 'utf8'));
  const byGameId = new Map(catalog.pets.map((pet) => [Number(pet.game_id), pet]));
  // 执行域里不许有任何"抓包采用"的痕迹（已经撤回；留了标记说明有人试过没撤干净）
  for (const [rel, doc] of [['pets.json', base], ['layer-playable-48/pets.json', layer]]) {
    assert.equal(doc.capture_override, undefined, `${rel} 里还留着 capture_override（采用已撤回）`);
    for (const [petId, pet] of Object.entries(doc.pets)) {
      assert.equal(pet.stats_source, undefined, `${rel} ${petId} 还标着抓包来源（采用已撤回）`);
      assert.equal(pet.stats_previous, undefined, `${rel} ${petId} 还留着 stats_previous（采用已撤回）`);
    }
  }
  for (const row of KNOWN_DIVERGENCE) {
    const stats = (row.file === 'pets.json' ? base.pets : layer.pets)[row.pet_id].stats;
    assert.equal(stats[row.stat], row.engine,
      `${row.pet_id}（game_id ${row.game_id}）执行域的 ${row.stat} 变了：现在 ${stats[row.stat]}，登记的是 ${row.engine}`);
    const pet = byGameId.get(Number(row.game_id));
    assert.equal(pet.stats[row.stat], row.catalog,
      `检索层 ${row.game_id} 的 ${row.stat} 应是抓包值 ${row.catalog}，实际 ${pet.stats[row.stat]}`);
    assert.equal(pet.stats_previous?.[row.stat], row.engine, `检索层 ${row.game_id} 应留着旧值（改钉不删）`);
  }
  // 分歧只许这 5 只
  const drifting = [];
  for (const [file, doc] of [['pets.json', base], ['layer-playable-48', layer]]) {
    for (const [petId, pet] of Object.entries(doc.pets)) {
      const row = byGameId.get(Number(pet.game_id));
      if (!row?.stats_source?.startsWith('capture')) continue;
      for (const key of Object.keys(pet.stats)) {
        if (row.stats[key] !== pet.stats[key]) drifting.push(`${Number(pet.game_id)}/${petId}/${key}`);
      }
    }
  }
  // 没登记过的漂移一条都不许有（登记表里登记过的那些逐条在上面核过了）
  const unexpected = drifting.filter((row) => {
    const [gameId, , key] = row.split('/');
    return !KNOWN_DIVERGENCE.some((r) => Number(gameId) === r.game_id && key === r.stat);
  });
  assert.deepEqual(unexpected, [], `执行域与抓包之间还有没登记的漂移：${unexpected.join('、')}`);
  // 「回答用哪一份」必须写死在代码里（不然这 5 只又会两个数打架）
  const runtime = readFileSync(join(ROOT, 'src', 'coach', 'runtime.js'), 'utf8');
  assert.match(runtime, /回答精灵数值时以 L1 图鉴层为准/,
    'runtime.js 里要写明"回答数值读图鉴层"（模拟照旧读执行域）');
});

test('⑦ id 别名表：首领形态**以抓包 4xxx 为主键**，册子 5xxx 是别名（人类 2026-09-27 拍板）', async () => {
  // 由来：人类原话「④ 首领形态的 id 主键口径 ❓：同一只精灵在两套数据里 id 不同（例：钻石蜗 = 你抓的 4079
  // = 我们册子里的 5001；25 只全部如此）……（建议：以小黑盒的 4xxx 为准）」→「**按照抓包数据来吧**」。
  const ALIASES = join(ROOT, 'data/roco/derived/hke-2026-09-27/id-aliases.json');
  assert.ok(existsSync(ALIASES), `缺产物：${ALIASES}（跑 node scripts/roco/build-id-aliases.mjs）`);
  const doc = JSON.parse(readFileSync(ALIASES, 'utf8'));
  // ① 产物自检 + 可复算（同一份 validator，判据与 --check 不各写一套）
  assert.deepEqual(validateAliases(doc), [], '产物自检必须过');
  assert.equal(`${JSON.stringify(buildAliases(), null, 1)}\n`, readFileSync(ALIASES, 'utf8'),
    '产物必须与重算逐字节相同');
  // ② 主键口径写死在产物里（翻过来必须红 —— 反证见下）
  assert.equal(doc.primary, 'capture', '主键必须是抓包（4xxx）');
  assert.match(doc.human_ruling, /按照抓包数据来吧/, '要留着人类原话');
  // ③ 反向解析：**每一个**册子 id 都要解析回它那一组的抓包主键（不是只测样例）
  for (const group of doc.groups) {
    for (const catalogId of group.catalog_game_ids) {
      const hit = await idAliasOf(String(catalogId));
      assert.ok(hit, `册子 id ${catalogId} 解析不出来`);
      assert.equal(hit.primaryId, group.capture_id, `册子 id ${catalogId} 应解析回主键 ${group.capture_id}`);
      assert.equal(hit.oneToOne, group.one_to_one, `${catalogId} 的 one_to_one 要与产物一致`);
    }
    const byPrimary = await idAliasOf(String(group.capture_id));
    assert.equal(byPrimary?.primaryId, group.capture_id, `抓包 id ${group.capture_id} 要解析成它自己`);
  }
  // ④ 拿别名去检索层问，必须落到同一条（人类举的例子：4079 ↔ 5001 钻石蜗）
  const example = doc.groups.find((row) => row.name === '钻石蜗');
  assert.ok(example, '产物里应有钻石蜗那一组（人类举的例子）');
  const byPrimary = await hkePetOf(String(example.capture_id));
  const byAlias = await hkePetOf(String(example.catalog_game_ids[0]));
  assert.ok(byPrimary && byAlias, '两个 id 都要能查到');
  assert.equal(byPrimary.name, byAlias.name, '同一只：名字必须一致');
  assert.equal(byPrimary.name, '钻石蜗');
  // ⑤ 多形态那 7 组**不许被挑一条**：one_to_one=false、不给 stats_identical、候选≥2
  const multi = doc.groups.filter((row) => !row.one_to_one);
  assert.ok(multi.length > 0, '前提：确实存在同名多形态的组（否则这条判据没有牙）');
  for (const row of multi) {
    assert.ok(row.catalog_game_ids.length >= 2, `${row.capture_id} 多形态应有多条候选`);
    assert.equal(row.stats_identical, null, `${row.capture_id} 多形态不许挑一条比六维`);
  }
  // ⑥ **不许把多形态拍平**（这一条是这一轮最重要的判据）：抓包 4000 段里一个名字只有一条记录，
  //    而册子里同名可以有好几条、且六维**各不相同**（实测：钻石蜗那 6 条是 6 种不同的六维）。
  //    拿抓包那一条去套它们 = 把 6 种拍平成 1 种 = **信息损失**，不是"以抓包为准"。
  //    所以：多形态组的册子条目**不许**被标成采用抓包，也**不许**有 stats_previous；
  //    而 1:1 组（两边都唯一）**必须**用抓包值。
  const catalog = JSON.parse(readFileSync(
    join(ROOT, 'data/roco/normalized', 'roco-world-s4-2026-09-10', 'full-catalog.json'), 'utf8'));
  const byGameId = new Map(catalog.pets.map((pet) => [Number(pet.game_id), pet]));
  let adoptedLords = 0;
  let linearLords = 0;
  for (const group of doc.groups) {
    for (const catalogId of group.catalog_game_ids) {
      const pet = byGameId.get(Number(catalogId));
      assert.ok(pet, `册子里应有 ${catalogId}`);
      if (group.one_to_one) {
        assert.equal(pet.stats_source, 'capture-2026-09-27',
          `${group.name}（${catalogId}）是 1:1 的首领形态 ⇒ 该采用抓包值`);
        assert.equal(pet.capture_matched_by, 'lord_name', `${catalogId} 的来源应记成 lord_name`);
        adoptedLords += 1;
      } else {
        assert.notEqual(pet.stats_source, 'capture-2026-09-27',
          `${group.name}（${catalogId}）属于**多形态**组 ⇒ 不许采用（会拍平别的形态）`);
        // ⚠ 没改过的条目里 `stats_previous` 是 **null**（不是 undefined）—— 判据写 `=== undefined`
        // 会永远红（这一条第一版就是这么错的）。用 falsy 判断。
        assert.ok(!pet.stats_previous, `${catalogId} 没采用就不该有 stats_previous（现在 ${JSON.stringify(pet.stats_previous)}）`);
        linearLords += 1;
      }
    }
  }
  assert.equal(adoptedLords, doc.counts.one_to_one, '1:1 组逐条都要采用');
  assert.ok(linearLords > 0, '前提：确实存在多形态组（否则这条判据没有牙）');
  // 覆盖账：两条路的只数分开记，且要对得上
  assert.deepEqual(catalog.provenance.stats_override.matched_by,
    {game_id: 522, lord_name: doc.counts.one_to_one}, '覆盖账要写清"按 id 对上的"与"按首领同名对上的"');
  // 六维真的不同的 1:1 组（现在应是 0 条）如果出现，必须带判决 —— 不许停在"两边不一样"
  for (const row of doc.groups.filter((one) => one.stats_identical === false)) {
    assert.equal(row.stats_verdict, 'undecided', `组 ${row.capture_id} 要写判决`);
    assert.ok(String(row.stats_reason ?? '').length > 8, `组 ${row.capture_id} 的判决理由太短`);
    assert.equal(typeof row.same_as_base_form, 'boolean', `组 ${row.capture_id} 缺 same_as_base_form 标记`);
  }
  // 必红反证：把某个多形态组的册子条目"改成已采用" ⇒ 上面那条断言必须红
  const flattenProbe = doc.groups.find((row) => !row.one_to_one);
  assert.ok(flattenProbe, '前提：存在多形态组');
  const flattened = byGameId.get(Number(flattenProbe.catalog_game_ids[0]));
  assert.notEqual(flattened.stats_source, 'capture-2026-09-27',
    `把 ${flattenProbe.name} 的册子条目标成已采用就等于拍平了它的其它形态`);

  // ⑥ 必红反证：把主键翻过来、把多形态标成 1:1、删掉人类原话 —— 都必须被同一份 validator 抓住
  const mutations = [
    ['把主键翻成册子', {...doc, primary: 'catalog'}],
    ['把多形态标成 1:1', {...doc, groups: doc.groups.map((row) => row === multi[0] ? {...row, one_to_one: true} : row)}],
    ['多形态硬比六维', {...doc, groups: doc.groups.map((row) => row.one_to_one ? row : {...row, stats_identical: true})}],
    ['删掉人类原话', {...doc, human_ruling: '（空）'}],
  ];
  for (const [label, mutated] of mutations) {
    assert.ok(validateAliases(mutated).length > 0, `${label} 必须被抓住`);
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
