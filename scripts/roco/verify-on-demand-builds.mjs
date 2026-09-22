#!/usr/bin/env node
// RC-402 按需配招产物的检查器：核对 `data/roco/derived/on-demand-builds.json` 到底写了什么。
//
//   node scripts/roco/verify-on-demand-builds.mjs
//   node scripts/roco/verify-on-demand-builds.mjs --json
//   node scripts/roco/verify-on-demand-builds.mjs --selftest
//   node scripts/roco/verify-on-demand-builds.mjs --file /tmp/tampered.json   # 取证用，不改真产物

import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {checkOnDemandBuilds, selftest, sha256} from './on-demand-builds-lib.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const CATALOG = 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json';
const SKILLS = 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json';
const TARGET = 'data/roco/derived/on-demand-builds.json';

const json = (rel) => {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  return {json: JSON.parse(text), hash: sha256(text)};
};

export function checkRepo({file} = {}) {
  const catalog = json(CATALOG);
  const skills = json(SKILLS);
  const target = file ? resolve(file) : join(ROOT, TARGET);
  if (!existsSync(target)) {
    return {ok: false, issues: [{rule: 'artifact_missing', species_id: '-', detail: `产物不存在：${file ?? TARGET}`}]};
  }
  const doc = JSON.parse(readFileSync(target, 'utf8'));
  const report = checkOnDemandBuilds(doc, {
    catalog: catalog.json, skills: skills.json, hashes: {catalog: catalog.hash, skills: skills.hash},
  });
  return {...report, path: file ?? TARGET};
}

function main(argv) {
  if (argv.includes('--selftest')) {
    const result = selftest();
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    else {
      for (const row of result.cases) {
        process.stdout.write(`${row.passed ? 'PASS' : 'FAIL'} ${row.name}\n      期望：${row.want}\n      实际：${row.got}\n`);
      }
      process.stdout.write(result.ok ? `自带用例全部通过（${result.cases.length} 条）\n` : `自带用例失败 ${result.failed} 条\n`);
    }
    return result.ok ? 0 : 1;
  }
  const flag = argv.indexOf('--file');
  const report = checkRepo({file: flag >= 0 && argv[flag + 1] ? argv[flag + 1] : undefined});
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  else {
    const s = report.summary ?? {};
    process.stdout.write(`按需配招：已核验 ${s.full_verified ?? '?'} 只，推算 ${s.simulatable_unverified ?? '?'} 只，与冻结配招逐位相同 ${s.matched_frozen ?? '?'} 只\n`);
    if (report.ok) process.stdout.write('每一个技能都能追溯到该物种的学招表与冻结 skills.json；覆盖账目自洽\n');
    else {
      process.stdout.write(`问题 ${report.issues.length} 条：\n`);
      for (const issue of report.issues.slice(0, 20)) process.stdout.write(`  [${issue.rule}] ${issue.species_id} — ${issue.detail}\n`);
      if (report.issues.length > 20) process.stdout.write(`  ……另有 ${report.issues.length - 20} 条\n`);
    }
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('verify-on-demand-builds.mjs')) process.exit(main(process.argv.slice(2)));
