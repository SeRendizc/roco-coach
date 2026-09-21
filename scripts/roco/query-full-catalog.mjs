#!/usr/bin/env node
// L1 图鉴层的**检索入口**：按名字/属性/可学技能查。
//
// 为什么单独一个脚本而不是散在页面里：这一层是「622 只的知识库」，它必须能被
// **别的层**调用（L2 选阵容、L3 可模拟池、页面分页），而每一层都要能回答
// 「你凭什么说这只是可用的」——所以返回值里永远带 `support` 与 `unknown_fields`，
// 调用方拿到的是**带边界的答案**，不是一个名字。
//
// 用法：
//   node scripts/roco/query-full-catalog.mjs --name 喵
//   node scripts/roco/query-full-catalog.mjs --type 草系 --limit 5
//   node scripts/roco/query-full-catalog.mjs --skill skill_000272
//   node scripts/roco/query-full-catalog.mjs --selftest
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
export const CATALOG_PATH = join(ROOT, 'data', 'roco', 'normalized',
  'roco-world-s4-2026-09-10', 'full-catalog.json');

export function loadCatalog(path = CATALOG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 一审：这一层的**唯一**允许的 support 值。多一个值就等于悄悄扩大了声称范围。 */
export const ALLOWED_SUPPORT = Object.freeze(['knowledge_only']);

export function validateCatalog(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return ['产物读不出来'];
  if (doc.layer !== 'L1-knowledge-only') problems.push(`layer 应为 L1-knowledge-only，实际 ${doc.layer}`);
  if (!Array.isArray(doc.pets) || doc.pets.length < 600) problems.push(`pets 应 ≥600，实际 ${doc.pets?.length ?? 0}`);
  for (const pet of doc.pets ?? []) {
    if (!ALLOWED_SUPPORT.includes(pet.support)) problems.push(`${pet.pet_id} 的 support=${pet.support} 不在允许集合里`);
    if (!Array.isArray(pet.unknown_fields) || !pet.unknown_fields.length) problems.push(`${pet.pet_id} 没有 unknown_fields`);
    if (!pet.provenance?.snapshot_sha256) problems.push(`${pet.pet_id} 缺 provenance`);
  }
  return problems;
}

/** 按条件过滤；每个结果都保留 support/unknown_fields，调用方自己决定能不能用。 */
export function query(doc, {name = null, type = null, skill = null, limit = 20} = {}) {
  let rows = doc.pets ?? [];
  if (name) rows = rows.filter((p) => String(p.name ?? '').includes(name));
  if (type) rows = rows.filter((p) => Array.isArray(p.types) && p.types.includes(type));
  if (skill) rows = rows.filter((p) => Array.isArray(p.learnable_skills) && p.learnable_skills.includes(skill));
  return rows.slice(0, Math.max(0, limit));
}

function main() {
  const args = process.argv.slice(2);
  const arg = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
  if (args.includes('--selftest')) {
    const doc = loadCatalog();
    const checks = [];
    // ① 正向：真产物必须过校验
    checks.push(['真产物过校验', validateCatalog(doc).length === 0]);
    // ② 反证：把某只的 support 改成可模拟 → 必须被拒
    const bad = {...doc, pets: doc.pets.map((p, i) => (i === 0 ? {...p, support: 'simulable'} : p))};
    checks.push(['反证：support 改成 simulable 必须被拒', validateCatalog(bad).some((x) => x.includes('不在允许集合'))]);
    // ③ 反证：删掉 unknown_fields → 必须被拒
    const bad2 = {...doc, pets: doc.pets.map((p, i) => (i === 0 ? {...p, unknown_fields: []} : p))};
    checks.push(['反证：删掉 unknown_fields 必须被拒', validateCatalog(bad2).some((x) => x.includes('没有 unknown_fields'))]);
    // ④ 检索真的能用：按名字查得到、乱名字查不到
    const hit = query(doc, {name: doc.pets[0].name, limit: 3});
    checks.push(['按名字查得到', hit.length > 0 && hit[0].name === doc.pets[0].name]);
    checks.push(['反证：乱名字查不到', query(doc, {name: '不存在的伙伴名XYZ'}).length === 0]);
    // ⑤ 类型过滤不许漏：查到的每一只都必须真属于那个属性
    const grass = query(doc, {type: '草系', limit: 5});
    checks.push(['类型过滤正确', grass.length > 0 && grass.every((p) => p.types.includes('草系'))]);
    // ⑥ 技能检索：查到的每一只的学招表里真的有那个技能
    const anySkill = (doc.pets.find((p) => p.learnable_skills?.length) || {}).learnable_skills?.[0];
    const bySkill = query(doc, {skill: anySkill, limit: 5});
    checks.push(['技能检索正确', bySkill.length > 0 && bySkill.every((p) => p.learnable_skills.includes(anySkill))]);
    const failed = checks.filter(([, ok]) => !ok);
    for (const [name, ok] of checks) console.log(`[selftest] ${ok ? '通过' : '✖ 失败'}：${name}`);
    console.log(`[selftest] ${checks.length - failed.length}/${checks.length} 条通过`);
    process.exit(failed.length ? 1 : 0);
  }
  const doc = loadCatalog();
  const problems = validateCatalog(doc);
  if (problems.length) { console.error('图鉴层校验失败：\n  ' + problems.slice(0, 5).join('\n  ')); process.exit(1); }
  const rows = query(doc, {name: arg('name'), type: arg('type'), skill: arg('skill'),
    limit: Number(arg('limit') ?? 20)});
  console.log(`命中 ${rows.length} 只（本层只做检索：support=knowledge_only）`);
  for (const pet of rows) {
    console.log(` · ${pet.name}（${(pet.types ?? []).join('/')}）`
      + ` 可学 ${pet.learnable_count} 个技能 | unknown ${pet.unknown_fields.length} 个字段`
      + ` | 依据 ${pet.provenance?.source_id ?? '?'}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('query-full-catalog.mjs')) main();
