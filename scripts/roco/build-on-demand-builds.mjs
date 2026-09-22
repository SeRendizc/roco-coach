#!/usr/bin/env node
// RC-402 按需配招编译器的命令行（纯逻辑在 `on-demand-builds-lib.mjs`）。
//
//   node scripts/roco/build-on-demand-builds.mjs             # 写 data/roco/derived/on-demand-builds.json
//   node scripts/roco/build-on-demand-builds.mjs --check     # 只比对（逐字节必须相同）
//   node scripts/roco/build-on-demand-builds.mjs --json      # 摘要
//   node scripts/roco/build-on-demand-builds.mjs --selftest   # 自带必红反证

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildOnDemandBuilds, checkOnDemandBuilds, selftest, sha256} from './on-demand-builds-lib.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const CATALOG = 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json';
const SKILLS = 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json';
const OWNED = 'data/roco/owned/owned-pets.json';
const OUT = 'data/roco/derived/on-demand-builds.json';

const read = (rel) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`缺少输入文件：${rel}`);
  const text = readFileSync(abs, 'utf8');
  return {text, json: JSON.parse(text), hash: sha256(text)};
};

/** 冻结 learnset 覆盖的那批配招（`owned-pets.json#battle_builds`），用来标 FULL_VERIFIED 并对账。 */
function frozenBuildsFrom(ownedDoc) {
  const out = {__source: `${OWNED}#battle_builds`};
  const rows = Array.isArray(ownedDoc?.battle_builds) ? ownedDoc.battle_builds : [];
  for (const value of rows) {
    const speciesId = value?.species_id ?? null;
    // RC-203 的字段名是 `ordered_skills`（有序四技能）；这里只读它，不改它。
    const skills = Array.isArray(value?.ordered_skills) ? value.ordered_skills : null;
    if (!speciesId || !skills || skills.length === 0) continue;
    // 同一物种可能有多个个体；只要有一份冻结配招，就算这一物种已核验。
    if (!out[speciesId]) {
      out[speciesId] = skills.map((row) => (typeof row === 'string' ? row : row?.skill_id)).filter(Boolean);
    }
  }
  return out;
}

export function build() {
  const catalog = read(CATALOG);
  const skills = read(SKILLS);
  const owned = read(OWNED);
  const frozenBuilds = frozenBuildsFrom(owned.json);
  const doc = buildOnDemandBuilds({
    catalog: catalog.json, skills: skills.json, frozenBuilds,
    hashes: {catalog: catalog.hash, skills: skills.hash, frozen: owned.hash},
  });
  const checked = checkOnDemandBuilds(doc, {catalog: catalog.json, skills: skills.json, frozenBuilds,
    hashes: {catalog: catalog.hash, skills: skills.hash}});
  if (!checked.ok) {
    throw new Error(`自建产物没通过自己的检查：${JSON.stringify(checked.issues.slice(0, 3))}`);
  }
  return `${JSON.stringify(doc, null, 1)}\n`;
}

function main(argv) {
  if (argv.includes('--selftest')) {
    const result = selftest();
    for (const row of result.cases) {
      process.stdout.write(`${row.passed ? 'PASS' : 'FAIL'} ${row.name}\n      期望：${row.want}\n      实际：${row.got}\n`);
    }
    process.stdout.write(result.ok ? `自带用例全部通过（${result.cases.length} 条）\n` : `自带用例失败 ${result.failed} 条\n`);
    return result.ok ? 0 : 1;
  }
  const text = build();
  const abs = join(ROOT, OUT);
  if (argv.includes('--check')) {
    if (!existsSync(abs)) { process.stdout.write(`产物不存在：${OUT}\n`); return 1; }
    const disk = readFileSync(abs, 'utf8');
    if (disk !== text) { process.stdout.write(`产物与重建结果**不一致**：${OUT}\n`); return 1; }
    process.stdout.write(`产物逐字节相同：${OUT}（${Buffer.byteLength(text)} 字节）\n`);
    return 0;
  }
  mkdirSync(dirname(abs), {recursive: true});
  writeFileSync(abs, text);
  const doc = JSON.parse(text);
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify({path: OUT, bytes: Buffer.byteLength(text), summary: doc.summary, skipped: doc.skipped.slice(0, 5)}, null, 1)}\n`);
  else {
    const s = doc.summary;
    process.stdout.write(`写出 ${OUT}（${Buffer.byteLength(text)} 字节）\n`);
    process.stdout.write(`  物种 ${s.species}：冻结已核验 ${s.FULL_VERIFIED}，按需推算 ${s.SIMULATABLE_UNVERIFIED}，跳过 ${s.skipped}\n`);
    process.stdout.write(`  推算配招与冻结配招逐位相同的物种：${s.compiled_matches_frozen}\n`);
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('build-on-demand-builds.mjs')) process.exit(main(process.argv.slice(2)));
