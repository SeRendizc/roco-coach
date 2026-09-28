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

import {buildOnDemandBuilds, checkOnDemandBuilds, combinedFrozenHash, selftest, sha256} from './on-demand-builds-lib.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const CATALOG = 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json';
const SKILLS = 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json';
// ⚠ `data/roco/owned/owned-pets.json` 自 2026-09-28 起**不再是本产物的输入**（旧值不删：
// 它曾经是 `frozenBuilds` 的来源）。冻结那一档现在只认冻结层（基线 12 + 可玩层 530）的规范配招 ——
// 理由见下面的注释。
const BASE_SUPPORT = 'data/roco/normalized/roco-world-s4-2026-09-10/support-matrix.json';
const LAYER_SUPPORT = 'data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/support-matrix.json';
const OUT = 'data/roco/derived/on-demand-builds.json';

const read = (rel) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw new Error(`缺少输入文件：${rel}`);
  const text = readFileSync(abs, 'utf8');
  return {text, json: JSON.parse(text), hash: sha256(text)};
};

/**
 * 「冻结已核验」那一档 = **冻结层的规范配招**：基线 `support-matrix.json`（12 只，M1 验收基线）
 * ＋ 可玩层 `layer-playable-48/support-matrix.json`（530 只）—— 这正是引擎 `load_ruleset()`
 * 真正会用的那 4 个技能（两份合起来 = 引擎里 `FULL_VERIFIED` 的 542 只）。
 *
 * ⚠ 2026-09-28 换源（旧值不删）：原来这一档取自 `data/roco/owned/owned-pets.json#battle_builds`
 * （人类自己盒子里那些个体）。换源的两条理由都是实测出来的：
 *   ① 人类 2026-09-28 逐字：「所有精灵实装，**这样就不需要我的精灵了**，直接全筛选」——
 *      冻结那一档不该再由「我的盒子」定义；
 *   ② 用 owned-pets 当源会**丢精灵**：旧可玩层撤下的 7 只（`pet_000139 古啦多` /
 *      `pet_000485 学院呱呱` / `pet_000542 祭礼巨像` / `pet_000556 棋契陛下` /
 *      `pet_000575 棋契陛下` / `pet_000609 新月鹭` / `pet_000613 智辉章脑`）在产物里仍是
 *      `FULL_VERIFIED`，而引擎对 `FULL_VERIFIED` 的行直接 `continue`（它假定冻结层会管）——
 *      于是这 7 只**既不在冻结层、也不会被按需补上**，从候选池整个消失（实测 622 → 615）。
 *      换成冻结层当源之后，它们落到 `SIMULATABLE_UNVERIFIED`，由本模块编上 4 个技能。
 */
function frozenBuildsFromLayers(baseDoc, layerDoc) {
  const out = {__source: `${BASE_SUPPORT}#pets[].candidate_moveset + ${LAYER_SUPPORT}#pets[].candidate_moveset`};
  for (const doc of [baseDoc, layerDoc]) {
    for (const entry of Array.isArray(doc?.pets) ? doc.pets : []) {
      const skills = (entry?.candidate_moveset?.skills ?? []).map((row) => row?.skill_id).filter(Boolean);
      if (!entry?.pet_id || skills.length === 0) continue;
      if (!out[entry.pet_id]) out[entry.pet_id] = skills;
    }
  }
  return out;
}

export function build() {
  const catalog = read(CATALOG);
  const skills = read(SKILLS);
  const base = read(BASE_SUPPORT);
  const layer = read(LAYER_SUPPORT);
  const frozenBuilds = frozenBuildsFromLayers(base.json, layer.json);
  const doc = buildOnDemandBuilds({
    catalog: catalog.json, skills: skills.json, frozenBuilds,
    hashes: {catalog: catalog.hash, skills: skills.hash, frozen: combinedFrozenHash([base.text, layer.text])},
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
