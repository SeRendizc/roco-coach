#!/usr/bin/env node
// 机制首层产物检查器：核对 `data/roco/derived/pet-mechanisms.json` 到底写了什么。
//
// 它**不**判断机制好不好玩，只判断四条不许越过的线：
//   · 622 只一只不少、pet_id 与冻结目录逐一对应；
//   · 每条 `feature.desc` 都是冻结 `skills.json` 那条 desc 的**原文子串**（润色即红）；
//   · 解析不到 desc 的必须是「机制资料待确认」+ desc=null（编句子即红）；
//   · 派生 sha256、summary 计数、known_limits 三者必须与内容一致。
//
// 跑法：
//   node scripts/roco/verify-pet-mechanisms.mjs
//   node scripts/roco/verify-pet-mechanisms.mjs --json
//   node scripts/roco/verify-pet-mechanisms.mjs --selftest
//   node scripts/roco/verify-pet-mechanisms.mjs --file /tmp/tampered.json   # 取证用，不改真产物

import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkMechanisms, selftest, sha256} from './pet-mechanisms-lib.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const CATALOG = 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json';
const SKILLS = 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json';
const TARGET = 'data/roco/derived/pet-mechanisms.json';

function json(rel) {
  const abs = join(ROOT, rel);
  const text = readFileSync(abs, 'utf8');
  return {json: JSON.parse(text), hash: sha256(text)};
}

export function checkRepo({file} = {}) {
  const catalog = json(CATALOG);
  const skills = json(SKILLS);
  const target = file ? resolve(file) : join(ROOT, TARGET);
  if (!existsSync(target)) {
    return {ok: false, issues: [{rule: 'artifact_missing', evidence_id: '-', detail: `产物不存在：${file ?? TARGET}`}]};
  }
  const doc = JSON.parse(readFileSync(target, 'utf8'));
  const report = checkMechanisms(doc, {catalog: catalog.json, skills: skills.json, hashes: {catalog: catalog.hash, skills: skills.hash}});
  return {...report, path: file ?? TARGET};
}

function main(argv) {
  if (argv.includes('--selftest')) {
    const result = selftest();
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    else {
      for (const row of result.cases) {
        process.stdout.write(`${row.passed ? 'PASS' : 'FAIL'} ${row.name}\n`);
        process.stdout.write(`      期望：${row.want}\n      实际：${row.got}\n`);
      }
      process.stdout.write(result.ok ? `自带用例全部通过（${result.cases.length} 条）\n` : `自带用例失败 ${result.failed} 条\n`);
    }
    return result.ok ? 0 : 1;
  }
  const fileFlag = argv.indexOf('--file');
  const file = fileFlag >= 0 && argv[fileFlag + 1] ? argv[fileFlag + 1] : undefined;
  const report = checkRepo({file});
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  else {
    const s = report.summary ?? {};
    process.stdout.write(`机制首层：精灵 ${s.pets ?? '?'} 只，冻结 desc ${s.frozen ?? '?'} 只，待确认 ${s.unconfirmed ?? '?'} 只，带标签 ${s.with_tags ?? '?'} 只\n`);
    if (report.ok) process.stdout.write('机制首层逐字、无编造、计数自洽\n');
    else {
      process.stdout.write(`问题 ${report.issues.length} 条：\n`);
      for (const issue of report.issues.slice(0, 20)) process.stdout.write(`  [${issue.rule}] ${issue.evidence_id} — ${issue.detail}\n`);
      if (report.issues.length > 20) process.stdout.write(`  ……另有 ${report.issues.length - 20} 条\n`);
    }
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('verify-pet-mechanisms.mjs')) process.exit(main(process.argv.slice(2)));
