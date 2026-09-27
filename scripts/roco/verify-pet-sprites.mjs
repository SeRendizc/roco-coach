#!/usr/bin/env node
// 立绘身份闸门：`data/roco/derived/pet-sprite-audit.json` 里记的 96 张立绘身份，不能悄悄漂。
//
// 它守的是 2026-09-23 那次事故：素材集从第 25 张起整体错位一格，槽 25–48 全部显示成
// 下一只的立绘——CSS/JS/规则层全部看不见。审计产物（build-pet-sprite-audit.mjs）把
// 「哪个文件是哪只精灵的立绘」逐像素钉在素材板上；这条闸门保证那份结论**与仓库现状一致**：
//
//   · 每个槽位 × 每个状态都有记录，且状态只能是「逐像素相同 / 按记录变换重切 / 已知缺图」；
//   · 每个文件今天的 sha256 与审计里写的一致（换图必须重跑审计，等于强制重新核对身份）；
//   · 已知缺图的槽位**不允许**偷偷补上一张来路不明的图（不发明、不猜）；
//   · 48 张默认立绘两两不同（防止「两张槽位指向同一张画」这类静默错误）。
//
// 跑法::
//
//     node scripts/roco/verify-pet-sprites.mjs
//     node scripts/roco/verify-pet-sprites.mjs --json

import {readFileSync, existsSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const PETS = join(ROOT, 'data', 'roco', 'assets', 'pets');
const AUDIT = join(ROOT, 'data', 'roco', 'derived', 'pet-sprite-audit.json');
//: `human-supplied` = 不在素材板里、由人类生成后给过来的立绘（出处登记在 pets-sources.json）。
const ALLOWED = new Set(['bit-exact', 'regenerated-from-cell', 'missing-known', 'human-supplied']);

export function verify() {
  const problems = [];
  if (!existsSync(AUDIT)) return {problems: ['审计产物缺失：先跑 node scripts/roco/build-pet-sprite-audit.mjs'], counts: {}};
  const doc = JSON.parse(readFileSync(AUDIT, 'utf8'));
  const manifest = JSON.parse(readFileSync(join(PETS, 'manifest.json'), 'utf8'));
  if (doc.schema !== 'roco-pet-sprite-audit/v1') problems.push(`审计产物 schema 不认识：${doc.schema}`);
  if (doc.verification_status !== 'verified') problems.push(`审计产物自己的结论不是 verified 而是 ${doc.verification_status}`);
  if (doc.problems?.length) problems.push(`审计产物里记着 ${doc.problems.length} 条未解决的对齐问题`);

  const byKey = new Map();
  for (const e of doc.entries) byKey.set(`${e.slot}|${e.state}`, e);
  const digests = new Map();
  let ok = 0, missing = 0, supplied = 0, missingSlots = [];
  for (const row of manifest) {
    for (const state of ['default', 'action']) {
      const key = `${row.slot}|${state}`;
      const e = byKey.get(key);
      if (!e) { problems.push(`审计产物缺槽 ${row.slot} ${state} 的记录`); continue; }
      if (!ALLOWED.has(e.status)) { problems.push(`槽 ${row.slot} ${state} 的记录状态是 ${e.status}`); continue; }
      const file = e.file ?? `${row.asset_key}-${state}.png`;
      const path = join(PETS, file);
      if (e.status === 'missing-known') {
        missing++;
        if (existsSync(path)) problems.push(`槽 ${row.slot} ${state} 记为已知缺图，但文件 ${file} 存在了——补图必须重跑审计并说明出处`);
        missingSlots.push(row.slot);
        continue;
      }
      if (e.asset_key !== row.asset_key) problems.push(`槽 ${row.slot} ${state} 的 asset_key 与清单不一致：${e.asset_key} ≠ ${row.asset_key}`);
      if (e.status === 'human-supplied' && !e.source?.sha256) {
        problems.push(`槽 ${row.slot} ${state} 记成人类供图，却没有记来源 sha256 —— 供图必须留出处`);
      }
      if (!existsSync(path)) { problems.push(`槽 ${row.slot} ${state} 的文件不存在：${file}`); continue; }
      const buf = readFileSync(path);
      const sha = createHash('sha256').update(buf).digest('hex');
      if (sha !== e.sha256) { problems.push(`槽 ${row.slot} ${state} 的立绘变了（${file}）：sha256 ${sha.slice(0, 12)} ≠ 审计里的 ${String(e.sha256).slice(0, 12)}`); continue; }
      digests.set(`${row.slot}|${state}`, sha);
      if (e.status === 'human-supplied') supplied++;
      ok++;
    }
  }
  // 默认立绘两两不同
  const seen = new Map();
  for (const [k, sha] of digests) {
    if (!k.endsWith('|default')) continue;
    if (seen.has(sha)) problems.push(`槽 ${k.split('|')[0]} 与槽 ${seen.get(sha)} 的默认立绘是同一张图（sha ${sha.slice(0, 12)}）`);
    else seen.set(sha, k.split('|')[0]);
  }
  // 每个槽位 default 与 action 必须是两张画（同角色不同姿态）
  for (const row of manifest) {
    const d = digests.get(`${row.slot}|default`), a = digests.get(`${row.slot}|action`);
    if (d && a && d === a) problems.push(`槽 ${row.slot} 的 default 与 action 是同一张图`);
  }
  // 未归属资产必须仍被记录（它是「素材集多一张」的证据，删掉就等于抹掉结论）
  const pd = join(ROOT, 'data', 'roco', 'assets', 'pets-unmapped');
  const parked = existsSync(pd) ? readdirSync(pd).filter((f) => f.endsWith('.png')).length : 0;
  if (parked !== (doc.orphans?.length ?? 0)) problems.push(`未归属立绘目录里有 ${parked} 张，审计记了 ${doc.orphans?.length ?? 0} 张`);
  for (const o of doc.orphans ?? []) {
    const p = join(pd, o.file);
    if (!existsSync(p)) { problems.push(`未归属立绘缺失：${o.file}`); continue; }
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
    if (sha !== o.sha256) problems.push(`未归属立绘 ${o.file} 变了`);
  }
  return {problems, counts: {checked: ok, supplied, missing, orphans: doc.orphans?.length ?? 0, distinct: seen.size}};
}

if (process.argv[1] && process.argv[1].endsWith('verify-pet-sprites.mjs')) {
  const {problems, counts} = verify();
  if (process.argv.includes('--json')) console.log(JSON.stringify({counts, problems}));
  else {
    console.log(`立绘身份：核对 ${counts.checked} 张（其中人类供图 ${counts.supplied}，已知缺图 ${counts.missing}，`
      + `未归属 ${counts.orphans}，默认立绘互异 ${counts.distinct}）`);
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(problems.length ? '结论：FAILED' : '结论：pass');
  }
  process.exit(problems.length ? 1 : 0);
}
