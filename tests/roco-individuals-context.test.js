// 判据：个体层要**接进教练上下文**（2026-09-27）。
//
// 由来：四层（种族值/个体值/性格/资质）都建好了，面板问句也接好了，但页面送的名单里没有天分与性格
// ⇒ 真机上问「我这只铠甲虫的面板」，拿到的永远是"天分按 0 / 性格按中性"那一版。
// 这一组钉住"补字段"这一层：**只补缺的、不改已有的、不猜、不丢行**，且**读不到数据就原样返回**。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {attachIndividuals, attachIndividualsToContext, loadIndividuals}
  from '../src/coach/individuals-context.js';
import {fileURLToPath} from 'node:url';

// 2026-09-30（task-26）：`.pathname` 在 Windows 上给出 `/E:/…`（带前导斜杠、没有盘符）⇒ 字符串拼接出 `E:\E:\…`；改用 fileURLToPath。旧写法留档（改钉不删）：new URL('..', import.meta.url).pathname
const ROOT_FOR_REAL = fileURLToPath(new URL('..', import.meta.url));

const DATASET = [
  {instance_id: 'own-0001', species_id: 'pet_000012', level: 60,
    nature: {value: '开朗', source: 'rolled'}, talent: {value: {hp: 10, atk: 9, def: 8, spa: 7, spd: 6, spe: 10}, source: 'rolled'}},
  {instance_id: 'own-0002', species_id: 'pet_000062', level: 60, nature: {value: null, source: null}, talent: {value: null, source: null}},
];
const profile = () => ({pets: [{id: 'own-0001', species_id: 'pet_000012', name: '铠甲虫', types: ['虫系'], level: 60},
  {id: 'own-0002', species_id: 'pet_000062', name: '音速犬', types: ['火系'], level: 60},
  {id: 'own-0003', species_id: 'pet_999999', name: '查不到的', types: [], level: 60}]});

test('① 补的是缺的那两项（天分/性格），并带上来源标记', () => {
  const next = attachIndividuals(profile(), DATASET);
  const first = next.pets[0];
  assert.deepEqual(first.talent, {hp: 10, atk: 9, def: 8, spa: 7, spd: 6, spe: 10});
  assert.equal(first.nature, '开朗');
  assert.equal(first.talent_source, 'rolled', '要写明这份天分是哪来的（掷点 vs 数据集）');
  assert.equal(first.nature_source, 'rolled');
  assert.equal(next.individuals_attached, 1, '只补了 1 行（另两行没有可用字段/查不到）');
  // 原有字段一个都不许动
  assert.equal(first.name, '铠甲虫');
  assert.equal(first.types[0], '虫系');
  assert.equal(first.level, 60);
});

test('② 名单行自己带了就以它为准（不许被数据集覆盖）；入参不许被改', () => {
  const input = profile();
  input.pets[0] = {...input.pets[0], talent: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}, nature: '固执'};
  const next = attachIndividuals(input, DATASET);
  assert.deepEqual(next.pets[0].talent, {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}, '页面带来的值优先');
  assert.equal(next.pets[0].nature, '固执', '页面带来的性格优先');
  assert.deepEqual(input.pets[0].talent, {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}, '入参不许被改');
  assert.equal(input.individuals_attached, undefined, '入参不许被加上记账字段');
});

test('③ 查不到的个体：原样留着（不猜、不丢行）；空/坏数据一律"什么都没补"', () => {
  const next = attachIndividuals(profile(), DATASET);
  assert.equal(next.pets.length, 3, '一行都不许丢');
  assert.equal(next.pets[2].talent, undefined, '查不到就不补');
  assert.equal(next.pets[2].nature, undefined);
  assert.equal(attachIndividuals({pets: []}, DATASET).pets.length, 0);
  assert.equal(attachIndividuals(profile(), []).individuals_attached, undefined, '没有个体数据 ⇒ 什么都不补');
  assert.equal(attachIndividuals(null, DATASET), null, '没有 profile ⇒ 原样返回');
});

test('④ 上下文那一层：只动 profile，其它键原样带过；读不到数据集就返回**原对象**', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roco-ind-'));
  const path = join(dir, 'owned-pets.json');
  writeFileSync(path, `${JSON.stringify({instances: DATASET})}\n`);
  const context = {mode: 'camp', profile: profile(), coachAllowed: true};
  const next = attachIndividualsToContext(context, {datasetPath: path});
  assert.equal(next.mode, 'camp');
  assert.equal(next.coachAllowed, true);
  assert.equal(next.profile.pets[0].nature, '开朗');
  // 读不到（路径不存在）⇒ **同一个对象**（判据用 === 钉住：不许偷偷换成空 profile）
  const same = attachIndividualsToContext(context, {datasetPath: join(dir, 'nope.json')});
  assert.equal(same, context, '读不到数据集时必须原样返回同一个对象');
  // 真产物也要读得动（不是只对夹具成立）
  const real = loadIndividuals();
  assert.ok(real.length >= 40, `真数据集里应有几十个个体（实际 ${real.length}）`);
  assert.ok(real.every((row) => row.level >= 1 && row.level <= 60), '个体等级必须在 1–60（上限 60）');
  // ⚠ 真数据集里的 `talent.value` / `nature.value` **是 null** —— 值由个体层掷出来。
  // 所以这一层必须走 `individualFromInstance`（同一个解析器），只认 `individual_id` 那个键：
  // 这两条都是实测踩过的坑（一个让整层静默失效、一个会贴错人）。
  const resolved = attachIndividualsToContext({profile: {pets: [{id: 'own-0001', name: '铠甲虫'}]}},
    {datasetPath: join(ROOT_FOR_REAL, 'data', 'roco', 'owned', 'owned-pets.json')});
  const first = resolved.profile.pets[0];
  assert.ok(first.talent && Object.values(first.talent).some((value) => value > 0),
    `真数据集也要补得出天分（实际 ${JSON.stringify(first.talent)}）`);
  assert.equal(typeof first.nature, 'string', '真数据集也要补得出性格');
  assert.match(String(first.talent_source), /rolled|dataset/, '要带来源标记');
  // 物种 id 冒充个体 id ⇒ **不许**贴别人家的天分性格
  const safe = attachIndividuals({pets: [{id: 'pet_000012', species_id: 'pet_000012', name: '铠甲虫'}]},
    loadIndividuals());
  assert.equal(safe.pets[0].talent, undefined, '物种 id 不是个体 id ⇒ 不匹配（防贴错人）');
});
