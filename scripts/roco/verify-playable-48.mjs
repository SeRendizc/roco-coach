#!/usr/bin/env node
// 「可玩 48 只」的真服务验收：分页/筛选 + 真打 3v3 到结束。
//
// 它证明的是**接上真服务之后**的行为，不是磁盘上的数字：
//   · `/api/roco/roster` 无参时**旧键一个不少、语义不变**（第 61 轮起多出出处键：
//     顶层 `evidence_ids` 与逐只/逐招的 `evidence_ids`，是加性变更）；
//   · `?limit=48` → 48、`?offset=24&limit=12` → 第 25—36 只、`?type=草系` 只出草系；
//   · `?role=` 与独立审计产物（`reports/roco/coverage/roster-48.json`）对账，
//     不是拿引擎自己的输出验证引擎自己；
//   · 从 48 只里**跨批次**取 3 只组阵容，`/battle/new` + 反复 `advance` 打到
//     `battle_result` 出现（默认 12 个阵容 × 3 个 seed = 36 局）。
//
// 用法（会真的起一个本地服务并跑几十局，串行跑，别与其它重活并行）：
//   node scripts/roco/verify-playable-48.mjs
//   node scripts/roco/verify-playable-48.mjs --matches 30
//   node scripts/roco/verify-playable-48.mjs --json

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {startServer} from './coach-position-harness.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const DATA = join(ROOT, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10');
const AUDIT = join(ROOT, 'reports', 'roco', 'coverage', 'roster-48.json');
const OUT = join(ROOT, 'reports', 'roco', 'coverage', 'playable-48-live-verification.json');
/**
 * 无参回执的顶层键。第 61 轮加了 `evidence_ids`（roster 级出处）——这是**加性**变更：
 * 旧键一个没少、语义没变，所以清单里补上新键，而不是把这条兼容性检查删掉。
 */
const LEGACY_KEYS = Object.freeze(['ok', 'count', 'usable_count', 'team_size', 'note', 'pets', 'evidence_ids']);
/**
 * 无参回执里每只精灵的键。第 61 轮每只多了自己的 `evidence_ids`
 * （`ev:<ruleset>:pets.json#<pet_id>`）——同样是加性变更。
 */
const LEGACY_PET_KEYS = Object.freeze(['pet_id', 'name', 'types', 'stats', 'pet_class', 'stage', 'moveset_size', 'moveset', 'evidence_ids']);
const SEEDS = Object.freeze([20260921, 5, 11]);
const TURN_CAP = 200;

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const MATCHES = Number.parseInt(argOf('--matches', '36'), 10);

const checks = [];
function check(name, ok, detail) {
  checks.push({name, ok: Boolean(ok), detail});
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `\n        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}

const sortedKeys = (o) => Object.keys(o).sort().join(',');
const sortedIds = (pets) => pets.map((p) => p.pet_id);

/** 从 48 只里跨批次取 3 只：三段各取一只，位置固定 → 样本可复现。 */
function crossBatchLineups(ids, count) {
  const thirds = [0, 1, 2].map((i) => Math.floor((ids.length * i) / 3));
  const lineups = [];
  for (let i = 0; i < count; i += 1) {
    const a = ids[(thirds[0] + i * 3) % thirds[1]];
    const b = ids[thirds[1] + (i * 5) % (thirds[2] - thirds[1])];
    const c = ids[thirds[2] + (i * 7) % (ids.length - thirds[2])];
    if (new Set([a, b, c]).size !== 3) continue;
    lineups.push([a, b, c]);
  }
  return lineups;
}

async function playMatch(server, seed, team, enemyTeam) {
  const started = await server.post('/api/roco/battle/new', {seed, strategy: 'greedy_damage', team, enemy_team: enemyTeam});
  if (!started.ok) return {ok: false, reason: started.error ?? 'battle/new 失败'};
  let current = started;
  let advances = 0;
  while (current.ok && !current.view?.battle_result && advances < TURN_CAP) {
    current = await server.post('/api/roco/battle/advance', {battle_id: started.battle_id, auto: true});
    advances += 1;
    if (!current.ok) return {ok: false, reason: current.error ?? 'advance 失败', advances};
  }
  if (!current.ok) return {ok: false, reason: current.error ?? 'advance 失败', advances};
  const result = current.view?.battle_result ?? null;
  if (!result) return {ok: false, reason: `推进 ${advances} 手仍未结束（turn_cap=${TURN_CAP}）`, advances, truncated: true};
  return {ok: true, advances, result, phase: current.view?.phase ?? null};
}

async function main() {
  const server = await startServer({});
  const startedAt = Date.now();
  try {
    // ── ① 无参回执：旧键逐键都在（加出处是**加性**变更，旧键没动）──────────
    const base = await server.get('/api/roco/roster');
    check('GET /api/roco/roster 的顶层键包含全部旧键（加性变更：只多 evidence_ids）',
      [...LEGACY_KEYS].every((k) => k in base) && sortedKeys(base) === [...LEGACY_KEYS].sort().join(','),
      {got: Object.keys(base), want: [...LEGACY_KEYS]});
    check('GET /api/roco/roster 的 pets[] 元素键包含全部旧键（只多 evidence_ids）',
      base.pets.every((p) => sortedKeys(p) === [...LEGACY_PET_KEYS].sort().join(',')),
      {sample: Object.keys(base.pets[0])});
    check('GET /api/roco/roster 逐只、逐招都带自己的出处（pets.json#… / skills.json#…）',
      (() => {
        const ruleset = /^ev:([^:]+):roster#/.exec(String((base.evidence_ids ?? [])[0] ?? ''))?.[1] ?? null;
        if (!ruleset) return false;
        return base.pets.every((p) => (p.evidence_ids ?? []).join(',') === `ev:${ruleset}:pets.json#${p.pet_id}`
          && (p.moveset ?? []).every((m) => (m.evidence_ids ?? []).join(',') === `ev:${ruleset}:skills.json#${m.skill_id}`));
      })(),
      {answer_evidence: base.evidence_ids ?? null,
        sample_pet: base.pets[0]?.evidence_ids, sample_move: base.pets[0]?.moveset?.[0]?.evidence_ids});
    check('GET /api/roco/roster → count=48 / usable_count=48',
      base.count === 48 && base.usable_count === 48,
      {count: base.count, usable_count: base.usable_count});
    check('GET /api/roco/roster 每只都正好 4 个配招技能',
      base.pets.every((p) => p.moveset_size === 4 && (p.moveset ?? []).length === 4),
      {sizes: [...new Set(base.pets.map((p) => p.moveset_size))]});
    const fullIds = sortedIds(base.pets);

    // ── ② 分页 ────────────────────────────────────────────────────────────
    const all = await server.get('/api/roco/roster?limit=48');
    check('?limit=48 → count=48 / total=48 / offset=0 / limit=48',
      all.count === 48 && all.total === 48 && all.offset === 0 && all.limit === 48,
      {count: all.count, total: all.total, offset: all.offset, limit: all.limit});
    check('?limit=48 的 pet_id 顺序与无参回执一致',
      sortedIds(all.pets).join(',') === fullIds.join(','),
      {first: fullIds[0], last: fullIds[fullIds.length - 1]});
    const page = await server.get('/api/roco/roster?offset=24&limit=12');
    check('?offset=24&limit=12 → 第 25—36 只（与全量名单切片逐 id 相同）',
      sortedIds(page.pets).join(',') === fullIds.slice(24, 36).join(','),
      {count: page.count, total: page.total, offset: page.offset, limit: page.limit,
        got: sortedIds(page.pets), want: fullIds.slice(24, 36)});

    // ── ③ 系别筛选（期望值从**无参回执**独立算出来，不读引擎内部）──────────
    const grass = await server.get(`/api/roco/roster?type=${encodeURIComponent('草系')}`);
    const wantGrass = fullIds.filter((id) => base.pets.find((p) => p.pet_id === id).types.includes('草系'));
    check('?type=草系 只出草系，且条数与全量名单里的草系一致',
      grass.pets.length > 0 && grass.pets.every((p) => p.types.includes('草系'))
        && sortedIds(grass.pets).join(',') === wantGrass.join(','),
      {count: grass.count, total: grass.total, want: wantGrass.length, got: sortedIds(grass.pets)});
    const grassShort = await server.get(`/api/roco/roster?type=${encodeURIComponent('草')}`);
    check('?type=草（缺后缀）与 ?type=草系 命中同一批',
      sortedIds(grassShort.pets).join(',') === sortedIds(grass.pets).join(','),
      {草: sortedIds(grassShort.pets)});

    // ── ④ 角色筛选：期望值来自**独立审计产物**，不是引擎自己的输出 ─────────
    const audit = JSON.parse(readFileSync(AUDIT, 'utf8'));
    const wantRole = audit.pets.filter((p) => p.role === 'attacker').map((p) => p.pet_id).sort();
    const attackers = await server.get('/api/roco/roster?role=attacker');
    check('?role=attacker 全部是 attacker，且与审计产物的名单逐 id 一致',
      attackers.pets.length > 0 && attackers.pets.every((p) => p.role === 'attacker')
        && sortedIds(attackers.pets).join(',') === wantRole.join(','),
      {count: attackers.count, total: attackers.total, want: wantRole.length, got: sortedIds(attackers.pets)});
    const combined = await server.get(`/api/roco/roster?role=attacker&type=${encodeURIComponent('火系')}`);
    check('?role=attacker&type=火系 两个筛选同时生效（交集，不是并集）',
      combined.pets.every((p) => p.role === 'attacker' && p.types.includes('火系'))
        && combined.total === combined.count && combined.total > 0,
      {total: combined.total, pets: sortedIds(combined.pets)});

    // ── ⑤ 坏参数 fail closed（不静默取整、不静默忽略）─────────────────────
    const bad = await server.get('/api/roco/roster?limit=abc');
    check('?limit=abc → ok:false（fail closed，不静默当默认值）', bad.ok === false,
      {ok: bad.ok, error: bad.error ?? null});

    // ── ⑥ 真打：跨批次阵容，打到 battle_result 出现 ────────────────────────
    const wantedLineups = Math.max(1, Math.ceil(MATCHES / SEEDS.length));
    const lineups = crossBatchLineups(fullIds, wantedLineups);
    const used = new Set();
    const matches = [];
    for (let i = 0; i < lineups.length && matches.length < MATCHES; i += 1) {
      for (const seed of SEEDS) {
        if (matches.length >= MATCHES) break;
        const team = lineups[i];
        const enemyTeam = lineups[(i + 1) % lineups.length];
        team.forEach((id) => used.add(id));
        const outcome = await playMatch(server, seed, team, enemyTeam);
        matches.push({seed, team, enemyTeam, ...outcome});
      }
    }
    const done = matches.filter((m) => m.ok);
    const failed = matches.filter((m) => !m.ok);
    const advances = done.map((m) => m.advances).sort((a, b) => a - b);
    const median = advances.length ? advances[Math.floor(advances.length / 2)] : null;
    const batches = [0, 1, 2].map((i) => [...used].filter((id) => fullIds.indexOf(id) >= Math.floor((fullIds.length * i) / 3)
      && fullIds.indexOf(id) < Math.floor((fullIds.length * (i + 1)) / 3)).length);
    check(`真服务 3v3：${done.length}/${matches.length} 局打到 battle_result`,
      done.length === matches.length && matches.length >= Math.min(30, MATCHES),
      {matches: matches.length, completed: done.length, failed: failed.length,
        cross_batch_pets_used: batches, advances_min: advances[0] ?? null,
        advances_median: median, advances_max: advances[advances.length - 1] ?? null});
    check('每个跨批次阵容都用够 3 只、且 3 只互不相同',
      lineups.every((t) => t.length === 3 && new Set(t).size === 3),
      {lineups: lineups.length, distinct_pets_used: used.size});
    if (failed.length) {
      console.log('        失败样本：');
      for (const f of failed.slice(0, 5)) console.log(`          seed=${f.seed} team=${f.team.join(',')} → ${f.reason}`);
    }

    const report = {
      schema_version: 1,
      generated_by: 'scripts/roco/verify-playable-48.mjs',
      command: `node scripts/roco/verify-playable-48.mjs --matches ${MATCHES}`,
      elapsed_ms: Date.now() - startedAt,
      ruleset_id: 'roco-world-s4-2026-09-10',
      roster: {count: base.count, usable_count: base.usable_count, first_pet_id: fullIds[0], last_pet_id: fullIds[fullIds.length - 1]},
      page: {ids: sortedIds(page.pets)},
      filters: {
        'type=草系': sortedIds(grass.pets),
        'role=attacker': sortedIds(attackers.pets),
        'role=attacker&type=火系': sortedIds(combined.pets),
      },
      matches: {
        total: matches.length, completed: done.length, failed: failed.length,
        advances: {min: advances[0] ?? null, median, max: advances[advances.length - 1] ?? null},
        distinct_pets_used: used.size,
        cross_batch_pets_used: batches,
        failures: failed.map((f) => ({seed: f.seed, team: f.team, reason: f.reason})),
        samples: done.slice(0, 5).map((m) => ({seed: m.seed, team: m.team, advances: m.advances, result: m.result})),
      },
      checks,
      ok: checks.every((c) => c.ok),
    };
    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${report.ok ? 'OK' : 'FAIL'}  真服务验收 → ${OUT.replace(`${ROOT}/`, '')}（${report.elapsed_ms} ms）`);
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 1));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(`✖ 验收脚本自身出错：${error?.stack ?? error}`);
  process.exitCode = 1;
});
