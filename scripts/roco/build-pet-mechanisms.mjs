#!/usr/bin/env node
// 构建精灵「机制首层」：`data/roco/derived/pet-mechanisms.json`。
//
//   ① 出处只有三份冻结/已核对文件：`full-catalog.json`（622 只 + 各自 `feature_skill_id` + 学招表）、
//      `skills.json`（824 条技能/特性，全部带 `desc`）、`game-data-pack/v2/pack.json`（技能标签）。
//   ② **逐字**取 desc，不做任何润色；解析不到就写「机制资料待确认」。
//   ③ 纯函数在 `pet-mechanisms-lib.mjs`；本文件只负责读盘、写盘、`--check` 与摘要。
//
// 跑法：
//   node scripts/roco/build-pet-mechanisms.mjs            # 写盘
//   node scripts/roco/build-pet-mechanisms.mjs --check    # 只比对，不写（逐字节必须相同）
//   node scripts/roco/build-pet-mechanisms.mjs --json     # 机器可读摘要

import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildMechanisms, sha256} from './pet-mechanisms-lib.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const CATALOG = 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json';
const SKILLS = 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json';
const PACK = 'data/roco/game-data-pack/v2/pack.json';
const OUT = 'data/roco/derived/pet-mechanisms.json';

const read = (rel) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`缺少输入文件：${rel}`);
  const text = readFileSync(abs, 'utf8');
  return {text, json: JSON.parse(text), hash: sha256(text)};
};

export function build() {
  const catalog = read(CATALOG);
  const skills = read(SKILLS);
  const pack = read(PACK);
  const doc = buildMechanisms({
    catalog: catalog.json,
    skills: skills.json,
    pack: pack.json,
    hashes: {catalog: catalog.hash, skills: skills.hash, pack: pack.hash},
  });
  // 确定性：键序固定 + 末尾换行，保证 `--check` 能逐字节比对。
  return `${JSON.stringify(doc, null, 1)}\n`;
}

function main(argv) {
  const text = build();
  const abs = join(ROOT, OUT);
  const check = argv.includes('--check');
  if (check) {
    if (!existsSync(abs)) {
      process.stdout.write(`机制首层产物不存在：${OUT}（先跑一次不带 --check 的构建）\n`);
      return 1;
    }
    const disk = readFileSync(abs, 'utf8');
    if (disk !== text) {
      process.stdout.write(`机制首层产物与重新构建的结果**不一致**：${OUT}\n（先跑构建，再跑 --check）\n`);
      return 1;
    }
    process.stdout.write(`机制首层产物逐字节相同：${OUT}（${Buffer.byteLength(text)} 字节）\n`);
    return 0;
  }
  mkdirSync(dirname(abs), {recursive: true});
  writeFileSync(abs, text);
  const doc = JSON.parse(text);
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({path: OUT, bytes: Buffer.byteLength(text), summary: doc.summary, known_limits: doc.known_limits.length}, null, 1)}\n`);
  } else {
    const s = doc.summary;
    process.stdout.write(`写出 ${OUT}（${Buffer.byteLength(text)} 字节）\n`);
    process.stdout.write(`  精灵 ${s.pets} 只：解析到冻结 desc ${s.feature_resolved}，待确认 ${s.unconfirmed}；带机制标签 ${s.with_tags}；机制行截断 ${s.line_truncated}\n`);
    process.stdout.write(`  已知边界登记 ${doc.known_limits.length} 条（learnable_count 与列表长度不一致）\n`);
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('build-pet-mechanisms.mjs')) process.exit(main(process.argv.slice(2)));
