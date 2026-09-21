#!/usr/bin/env node
// 48 只「可模拟核心池」的规范化落库（L3 → L4 的输入）。
//
// 为什么要有这一步：`reports/roco/coverage/roster-48.json` 是**审计产物**
// （选谁、为什么选、角色/速度档/机制覆盖），而服务端要的是**规范化数据**。
// 直接把审计产物塞给服务端是不对的：两份东西的生命周期不同（审计产物会随
// 选人规则变，规范化数据要版本化），而且审计产物里没有逐条的 support/边界声明。
//
// 这一层**只做搬运与登记**，不重新选人、不改技能：
//   · 每只原样带过来（含 trait / role / speed_tier / learnset_id / 技能池信息）；
//   · 补 `support`（这一层允许的**唯一**值）与 `unknown_fields` / `refused[]`；
//   · 补 provenance（审计产物的 sha256 + 选人规则 + 选择依据），便于对账。
//
// 用法：
//   node scripts/roco/build-roster-48-store.mjs            # 生成
//   node scripts/roco/build-roster-48-store.mjs --verify   # 只读校验
//   node scripts/roco/build-roster-48-store.mjs --selftest # 反证
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const RULESET = 'roco-world-s4-2026-09-10';
const INPUT = join(ROOT, 'reports', 'roco', 'coverage', 'roster-48.json');
const OUT = join(ROOT, 'data', 'roco', 'normalized', RULESET, 'roster-48.json');
export const ALLOWED_SUPPORT = Object.freeze(['simulable_core_pool']);
// 这一层的边界：能进战斗、能进规划，但**不**声称这些技能的效果全部已核验。
const CORE_POOL_REFUSED = Object.freeze({
  unverified_effects: 'R2/R3 快照与引擎里部分效果仍未核验或未实现：进战斗前必须过合法性与 fail-closed 登记',
  traits_partial: 'R4 特性只登记了名称与描述；效果是否被引擎实现要逐条核对（12 条已实现）',
});

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

function build(rawText) {
  const src = JSON.parse(rawText);
  if (!Array.isArray(src.pets) || !src.pets.length) throw new Error('审计产物里没有 pets[]');
  const pets = src.pets.map((pet) => {
    const unknown = [];
    if (!pet.types?.length) unknown.push('types');
    if (!pet.stats) unknown.push('stats');
    if (!pet.trait?.desc) unknown.push('trait_effect');       // 描述在，效果未必被实现
    unknown.push('effect_verification');                       // 逐技能的效果核验状态不在这一层
    return {...pet, support: ALLOWED_SUPPORT[0], unknown_fields: unknown,
      refused: Object.values(CORE_POOL_REFUSED)};
  });
  return {
    schema_version: 'roco-roster-store/v1',
    ruleset_id: RULESET,
    layer: 'L3-simulable-core-pool',
    generated_by: 'scripts/roco/build-roster-48-store.mjs',
    claims: {is: ['这 48 只能进 3v3、能进规划与复盘（配招与合法性由引擎校验）'],
      is_not: ['效果全部已核验', '全量 622 只都能模拟', '版本强势度']},
    provenance: {
      source_id: 'reports/roco/coverage/roster-48.json',
      source_sha256: sha256(rawText),
      selection_rules: src.selection_rules ?? null,
      source_summary: src.summary ?? null,
      upstream: src.sources ?? null,
    },
    refused_reasons: CORE_POOL_REFUSED,
    pets,
  };
}

function verify(doc) {
  const problems = [];
  if (doc?.layer !== 'L3-simulable-core-pool') problems.push(`layer 应为 L3-simulable-core-pool，实际 ${doc?.layer}`);
  if (!Array.isArray(doc?.pets) || doc.pets.length !== 48) problems.push(`应当正好 48 只，实际 ${doc?.pets?.length ?? 0}`);
  for (const pet of doc?.pets ?? []) {
    if (!pet.pet_id || !pet.name) problems.push(`条目缺 pet_id/name：${JSON.stringify(pet).slice(0, 60)}`);
    if (!ALLOWED_SUPPORT.includes(pet.support)) problems.push(`${pet.pet_id} 的 support=${pet.support} 不在允许集合里`);
    if (!Array.isArray(pet.unknown_fields) || !pet.unknown_fields.length) problems.push(`${pet.pet_id} 没有 unknown_fields`);
    if (!pet.refused?.length) problems.push(`${pet.pet_id} 没有 refused 原因`);
  }
  if (!doc?.provenance?.source_sha256) problems.push('缺 provenance.source_sha256');
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const raw = existsSync(INPUT) ? readFileSync(INPUT, 'utf8') : null;
  if (args.includes('--selftest')) {
    if (!raw) { console.error('缺输入，无法自检'); process.exit(1); }
    const good = build(raw);
    const cases = [
      ['layer 改成 L1', {...good, layer: 'L1-knowledge-only'}],
      ['删掉一只', {...good, pets: good.pets.slice(0, 47)}],
      ['某只的 support 改成 full', {...good, pets: good.pets.map((p, i) => (i === 0 ? {...p, support: 'full'} : p))}],
      ['删掉 provenance', {...good, provenance: {}}],
    ];
    let caught = 0;
    for (const [name, mutated] of cases) {
      const p = verify(mutated);
      if (p.length) { caught += 1; console.log(`[selftest] 抓住：${name} → ${p[0]}`); } else console.log(`[selftest] ✖ 没抓住：${name}`);
    }
    const real = verify(good);
    if (real.length) { console.log('[selftest] ✖ 正产物没过：', real.slice(0, 2)); process.exit(1); }
    console.log(`[selftest] ${caught}/${cases.length} 个破坏被抓到；正产物通过`);
    process.exit(caught === cases.length ? 0 : 1);
  }
  if (!raw) { console.error(`缺输入 ${INPUT}`); process.exit(1); }
  const doc = build(raw);
  const problems = verify(doc);
  if (problems.length) { console.error('内容没过自检：\n  ' + problems.slice(0, 6).join('\n  ')); process.exit(1); }
  if (args.includes('--verify')) { console.log(`OK roster-48 store：${doc.pets.length} 只（只读校验）`); return; }
  mkdirSync(dirname(OUT), {recursive: true});
  writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`OK roster-48 store → ${OUT.replace(`${ROOT}/`, '')}`);
  console.log(`   ${doc.pets.length} 只 | 来源 sha256 ${doc.provenance.source_sha256.slice(0, 16)}…`);
}
main();
