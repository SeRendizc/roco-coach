#!/usr/bin/env node
// ── 把抓包六维也应用到**执行域**（引擎那两份 pet 文件）────────────────────────────
//
// 为什么要有这一步（真机实测的现场）：改完检索层之后，问小芽「铠甲虫的种族值是多少？」，
// 它答的是 **555**（引擎那份），而检索层/抓包是 **522** —— 玩家会看到两个数打架。
// 人类 2026-09-27 的口径是「精灵就用现在抓出来的数据做吧」「**以具体数据为准**」，
// 所以执行域也要跟抓包走；但**做法要可逆、可追、逐值留档**：
//
//   · 只改 `stats`（六维），其它字段一个都不动；
//   · 改过的每一条把旧值写进同一条记录的 `stats_previous`，并标 `stats_source`；
//   · 顶层加一个 `capture_override` 块：来源 CSV 的 sha256 + 人类原话 + 改了哪几只；
//   · `--check`：逐只核对「抓包里有它的，六维必须等于抓包」；
//   · `--revert`：把 `stats_previous` 写回去、删掉标记（一条命令回到采用之前）。
//
// ⚠ `layer-playable-48/pets.json` 的 `generated_from` 是**构建期**输入指纹（见
// `build-roster-48-engine-inputs.mjs`），这里**不动它** —— 它是"当初用什么建的"的真实记录；
// 本次采用记在自己的 `capture_override` 块里，两件事分开记。

import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const RULESET = 'roco-world-s4-2026-09-10';
const CAPTURE_CSV = join(ROOT, 'data/roco/raw/hke-2026-09-27/pets.csv');
// ⚠ 2026-09-28 改钉（旧值不删）：`TARGETS` 里原来还有第二份
//   data/roco/normalized/<ruleset>/layer-playable-48/pets.json
// 本轮起**不再由本脚本改写它**：那一层现在由 `scripts/roco/build-all-pets-engine-inputs.mjs`
// 从**抓包原始响应**直接生成（六维、属性、特性、三桶技能池全部取自抓包，不再需要事后打补丁），
// 而本脚本写盘用的是 1 空格缩进 + `stats_previous`/`capture_override` 补丁块 —— 两个写法同时写
// 同一份文件，正是本轮开工前 `--verify` exit 1 的成因（实测 pets.json 75609 vs 82540 字节）。
// 基线 `pets.json`（M1 那 12 只，仍从 wiki 快照来）继续由本脚本对齐抓包六维，这条没变。
const TARGETS = [
  join(ROOT, 'data/roco/normalized', RULESET, 'pets.json'),
];
const KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const HUMAN_RULING = '2026-09-27 人类：「精灵就用现在抓出来的数据做吧」「按照抓包数据来吧」「以具体数据为准吧」';

export function readCaptureRows(csvPath = CAPTURE_CSV) {
  const text = readFileSync(csvPath, 'utf8');
  const [head, ...lines] = text.trim().split('\n');
  const index = Object.fromEntries(head.split(',').map((name, i) => [name, i]));
  const rows = new Map();
  for (const line of lines) {
    const cells = line.split(',');
    const id = Number(cells[index.id]);
    if (!Number.isInteger(id)) continue;
    rows.set(id, {name: cells[index.name], stats: {hp: Number(cells[index.hp]),
      atk: Number(cells[index.phy_atk]), def: Number(cells[index.phy_def]),
      spa: Number(cells[index.spe_atk]), spd: Number(cells[index.spe_def]), spe: Number(cells[index.speed])}});
  }
  return {rows, sha256: createHash('sha256').update(text).digest('hex')};
}

/** 逐份文件算「该改成什么」，**不写盘**（`--check` 与真正写盘共用同一份判断）。 */
export function planPatches(capture, targets = TARGETS) {
  const plans = [];
  for (const path of targets) {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const changes = [];
    for (const [petId, pet] of Object.entries(doc.pets ?? {})) {
      const hit = capture.rows.get(Number(pet.game_id));
      if (!hit || !pet.stats) continue;
      const differs = KEYS.filter((key) => Number.isFinite(hit.stats[key]) && hit.stats[key] !== pet.stats[key]);
      const already = pet.stats_source === 'capture-2026-09-27' && !differs;
      if (!differs.length && already) continue;
      changes.push({petId, gameId: Number(pet.game_id), name: pet.name, captureName: hit.name,
        before: Object.fromEntries(differs.map((key) => [key, pet.stats[key]])),
        after: hit.stats, needsPatch: differs.length > 0});
    }
    plans.push({path, doc, changes});
  }
  return plans;
}

function apply(plans, capture) {
  let patched = 0;
  for (const plan of plans) {
    const changed = plan.changes.filter((row) => row.needsPatch);
    if (!changed.length) continue;
    for (const row of changed) {
      const pet = plan.doc.pets[row.petId];
      pet.stats_previous = {...(pet.stats_previous ?? {}), ...row.before};
      pet.stats = {...pet.stats, ...row.after};
      pet.stats_source = 'capture-2026-09-27';
      patched += 1;
    }
    const names = changed.map((row) => `${row.gameId} ${row.name}(${Object.keys(row.before).join('/')})`);
    plan.doc.capture_override = {
      source_id: 'hke-2026-09-27',
      artifact_path: 'data/roco/raw/hke-2026-09-27/pets.csv',
      artifact_sha256: capture.sha256,
      license: 'UNKNOWN', redistribution: 'REFERENCE_ONLY',
      human_ruling: HUMAN_RULING,
      patched_pets: changed.length,
      covered_pets: plan.changes.length,
      patched: names,
      note: '只覆盖六维；旧值逐条留在 pet.stats_previous。`generated_from` 是**构建期**输入指纹，'
        + '不因本次采用而改（那是"当初用什么建的"的记录）。--revert 可整块还原。',
    };
    writeFileSync(plan.path, `${JSON.stringify(plan.doc, null, 1)}\n`);
  }
  return patched;
}

function revert(plans) {
  let done = 0;
  for (const plan of plans) {
    if (!plan.doc.capture_override) continue;
    for (const [petId, pet] of Object.entries(plan.doc.pets ?? {})) {
      if (pet.stats_source !== 'capture-2026-09-27' || !pet.stats_previous) continue;
      pet.stats = {...pet.stats, ...pet.stats_previous};
      delete pet.stats_previous;
      delete pet.stats_source;
      done += 1;
    }
    delete plan.doc.capture_override;
    writeFileSync(plan.path, `${JSON.stringify(plan.doc, null, 1)}\n`);
  }
  return done;
}

function check(capture, plans) {
  const problems = [];
  for (const plan of plans) {
    const rel = plan.path.replace(`${ROOT}/`, '');
    const override = plan.doc.capture_override;
    let covered = 0;
    for (const [petId, pet] of Object.entries(plan.doc.pets ?? {})) {
      const hit = capture.rows.get(Number(pet.game_id));
      if (!hit || !pet.stats) continue;
      covered += 1;
      for (const key of KEYS) {
        if (Number.isFinite(hit.stats[key]) && pet.stats[key] !== hit.stats[key]) {
          problems.push(`${rel} ${petId}（${pet.name}）的 ${key}：执行域 ${pet.stats[key]} vs 抓包 ${hit.stats[key]}`);
        }
      }
      if (hit.name && pet.name && hit.name !== pet.name) {
        problems.push(`${rel} ${petId} 同 id 名字对不上：执行域「${pet.name}」vs 抓包「${hit.name}」`);
      }
    }
    if (covered === 0) problems.push(`${rel} 里一只都没被抓包覆盖 —— 对齐全错或 CSV 不在`);
    if (override && override.artifact_sha256 !== capture.sha256) {
      problems.push(`${rel} 的 capture_override.artifact_sha256 与磁盘上的 CSV 对不上（换过一份 CSV？）`);
    }
    // `patched_pets` 记的是**改过值**的只数（= 标了 stats_source 的那些）；
    // `covered_pets` 记的是"抓包里有它"的只数（多数本来就没差异）。
    const marked = Object.values(plan.doc.pets ?? {})
      .filter((pet) => pet.stats_source === 'capture-2026-09-27').length;
    if (override && override.patched_pets !== marked) {
      problems.push(`${rel} 的 capture_override.patched_pets=${override.patched_pets}，标了来源的是 ${marked} 只`);
    }
    if (override && override.covered_pets !== covered) {
      problems.push(`${rel} 的 capture_override.covered_pets=${override.covered_pets}，实际覆盖 ${covered} 只`);
    }
    if (!override) problems.push(`${rel} 缺 capture_override —— 说不清执行域有没有跟抓包`);
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const capture = readCaptureRows(TARGETS.length ? undefined : undefined);
  const plans = planPatches(capture);
  if (args.includes('--revert')) {
    console.log(`还原了 ${revert(plans)} 只（执行域回到采用之前；检索层的 --no-capture 另算）`);
    return;
  }
  if (args.includes('--check')) {
    const problems = check(capture, plans);
    if (problems.length) {
      console.error(`[check] ✖ ${problems.length} 条问题：\n  ` + problems.slice(0, 10).join('\n  '));
      process.exit(1);
    }
    console.log('[check] OK：执行域与抓包逐值一致（覆盖 '
      + plans.reduce((sum, plan) => sum + (plan.changes.length), 0) + ' 只）');
    return;
  }
  const patched = apply(plans, capture);
  console.log(`OK：执行域改了 ${patched} 只（旧值留在 stats_previous，可用 --revert 还原）`);
  const problems = check(capture, plans);
  if (problems.length) { console.error('[check] ✖\n  ' + problems.slice(0, 8).join('\n  ')); process.exit(1); }
  console.log('[check] OK：逐值一致');
}

if (process.argv[1] && process.argv[1].endsWith('apply-capture-to-engine.mjs')) main();
