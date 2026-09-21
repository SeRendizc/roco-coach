#!/usr/bin/env node
// RC-000 当前 HEAD 基线审计（机器可读）。
//
// 为什么要有它：v3 纠偏要求「先审计再施工」，而且审计结论必须能被**独立复跑** ——
// 一份手写的 audit.md 第二天就过期，谁也说不清它说的是哪个 HEAD。
// 这个脚本只做一件事：把「现在的仓库到底是什么状态」变成 `reports/roco/flagship-upgrade/baseline.json`。
//
// 它**不跑测试、不改代码、不下载东西**（跑测试是 verify-release 的事）。它读的全是仓库里的
// 既成事实：HEAD / 工作区 / 规则常量 / 数据规模 / 产物指纹 / 两盏门禁灯。
//
// 跑法::
//
//     node scripts/roco/flagship-baseline.mjs            # 写 reports/roco/flagship-upgrade/baseline.json
//     node scripts/roco/flagship-baseline.mjs --json     # 只打到 stdout
//     node scripts/roco/flagship-baseline.mjs --selftest # 自检（含反向控制）

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
const OUT = join(ROOT, 'reports', 'roco', 'flagship-upgrade');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

const git = (args) => {
  try {
    return execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
  } catch (error) {
    return `（git 失败：${error?.message ?? error}）`;
  }
};
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const sha256 = (rel) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return null;
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
};

/**
 * 从 `roco/src/roco_env/env.py` 里读**规则常量**。
 *
 * 为什么用正则读源码而不是 import：这是 Python 包，Node 里 import 不了；而且我们要的
 * 正是「源码里现在写的是什么」这个事实。读不到就如实返回 null —— **不许猜默认值**
 * （猜出来的数字会让审计看起来比实际更确定）。
 */
export function readEnergyConstants(source) {
  const num = (name) => {
    const m = new RegExp(`^${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, 'm').exec(source);
    return m ? Number(m[1]) : null;
  };
  const initial = (() => {
    // 入场初始能量在 env.py 里不是一条命名常量，而是一处赋值注释/字面量。
    // 找不到就 null（审计只报事实，不补默认值）。
    const m = /入场[^\n]*?(\d+)/.exec(source) ?? /initial_energy\s*=\s*(\d+)/.exec(source);
    return m ? Number(m[1]) : null;
  })();
  return {
    ENERGY_MAX: num('ENERGY_MAX'),
    ENERGY_REGEN_PER_TURN: num('ENERGY_REGEN_PER_TURN'),
    initial_energy_from_source: initial,
    source_file: 'roco/src/roco_env/env.py',
  };
}

/** 数据规模：只报**读得到**的数字，读不到就是 null。 */
export function readDataScale() {
  const dir = 'data/roco/normalized/roco-world-s4-2026-09-10';
  const count = (rel, listKey) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return null;
    const doc = JSON.parse(readFileSync(abs, 'utf8'));
    if (Array.isArray(doc)) return doc.length;
    const list = doc?.[listKey];
    return Array.isArray(list) ? list.length : (typeof doc?.count === 'number' ? doc.count : null);
  };
  const petsFile = readJson(`${dir}/pets.json`);
  const skillsFile = readJson(`${dir}/skills.json`);
  const countOf = (doc) => (Array.isArray(doc) ? doc.length
    : (typeof doc?.count === 'number' ? doc.count
      : Object.keys(doc?.pets ?? doc?.skills ?? {}).length || null));
  return {
    ruleset_dir: dir,
    pets_baseline_layer: countOf(petsFile),
    skills_baseline_layer: countOf(skillsFile),
    full_catalog: count(`${dir}/full-catalog.json`, 'pets'),
    roster_48: count(`${dir}/roster-48.json`, 'pets'),
    layer_playable_48_pets: count(`${dir}/layer-playable-48/pets.json`, 'pets'),
    note: '这些是**仓库冻结快照**的规模，不等于当前公网可见规模（621/579/242 需另做对账）。',
  };
}

/** 旧规则产物指纹：规则一改，这些必须先标 legacy/invalidated 再重建。 */
export function readArtifactFingerprints() {
  const files = [
    'tests/evals/agent-trajectories-v1.jsonl',
    'tests/evals/agent-trajectories-model-v1.jsonl',
    'tests/evals/roco/model-error-trajectories-v4.jsonl',
    'tests/evals/roco/intervention-windows-roco.jsonl',
    'tests/evals/roco/intervention-windows-v2.jsonl',
    'src/coach/intervention-model.generated.js',
    'reports/roco/g02-team/model.json',
    'reports/roco/demo-perf.json',
  ];
  const out = {};
  for (const rel of files) out[rel] = sha256(rel);
  return out;
}

function lamps() {
  const read = (rel) => (existsSync(join(ROOT, rel)) ? JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) : null);
  const latest = read('reports/roco/verification/latest.json');
  const green = read('reports/roco/verification/last-green.json');
  return {
    latest: latest ? {verdict: latest.verdict, ok_suites: (latest.suites ?? []).filter((s) => s.ok).length,
      suites: (latest.suites ?? []).length, failed: (latest.suites ?? []).filter((s) => !s.ok).map((s) => s.id)} : null,
    last_green: green ? {verdict: green.verdict, head: green.head, ran_at: green.ran_at,
      suites: (green.suites ?? []).length} : null,
  };
}

export function buildBaseline() {
  const envSource = readFileSync(join(ROOT, 'roco/src/roco_env/env.py'), 'utf8');
  const registry = existsSync(join(ROOT, 'models/registry.json')) ? readJson('models/registry.json') : null;
  const localModels = [];
  for (const row of registry?.models ?? []) {
    localModels.push({id: row.id ?? row.name ?? null, path: row.path ?? null,
      revision: row.revision ?? null, license: row.license ?? null});
  }
  return {
    schema: 'roco-flagship-baseline/v1',
    generated_by: 'scripts/roco/flagship-baseline.mjs',
    generated_at: new Date().toISOString(),
    head: {
      sha: git(['rev-parse', 'HEAD']),
      subject: git(['log', '-1', '--pretty=%s']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      remote: git(['remote', 'get-url', 'origin']),
      dirty_files: git(['status', '--porcelain']).split('\n').filter(Boolean),
    },
    runtime: {
      node: process.version,
      python: (() => {
        try {
          return execFileSync('python3', ['-V'], {encoding: 'utf8'}).trim();
        } catch (error) {
          return `（python3 不可用：${error?.message ?? error}）`;
        }
      })(),
    },
    // ── 规则基线：这一节就是 v3 纠偏要动的那个东西 ──────────────────────────
    rule_baseline: {
      ruleset_id: 'roco-world-s4-2026-09-10',
      engine_energy: readEnergyConstants(envSource),
      confidence_note: 'ENERGY_MAX=6 / 回合末 +1 在 env.py 里自注为「假设」；外部多源交叉支持 '
        + 'max=10 / 聚能 +5。因此当前引擎是 legacy 基线，不得再据此生产新轨迹（见 evidence ledger）。',
      battle_modes_present: ['pve-training-3v3（当前 Demo 练习局）'],
      battle_modes_missing: ['pvp-standard-six-pet（候选）', 'pvp-speed-duel-3v3（极速对决，OFFICIAL_CURRENT）',
        'pvp-territory-trial-2v2（领地试炼，特性共享/首领形态）'],
    },
    data_scale: readDataScale(),
    model_identity: {
      registry_present: Boolean(registry),
      registry_sha256: sha256('models/registry.json'),
      local_models: localModels,
      adapter: {
        path: existsSync(join(ROOT, '.models/adapters/qwen35-4b-tool-v4')) ? '.models/adapters/qwen35-4b-tool-v4' : null,
        note: '权重与适配器不进 git；这里只登记路径与登记表指纹。',
      },
    },
    artifacts: {
      fingerprints: readArtifactFingerprints(),
      note: '旧规则产物的 sha256。规则 candidate 一旦被采纳，这些必须重新生成并改绑 ruleset。',
    },
    gate: lamps(),
    known_gaps_this_audit_does_not_cover: [
      '不跑测试（跑测试是 verify-release 的事），因此这里只有上一次门禁的灯，不是本次结论。',
      '公网 621/579/242 与仓库 622/824 的对账**没做**（那是 RC-201）。',
      '实机 microcase 一个都还没有（需要录制实机）。',
    ],
  };
}

/** 自检：基线脚本的每个读数都要能证明「它真的在读，而不是写死」。 */
function selftest() {
  const checks = [];
  const push = (name, ok, actual) => checks.push({name, ok: Boolean(ok), actual});
  const sample = 'ENERGY_MAX = 6              # 假设\nENERGY_REGEN_PER_TURN = 1   # 假设\n# 入场初始 2\n';
  const parsed = readEnergyConstants(sample);
  push('反向控制：能从源码文本里读出 ENERGY_MAX=6', parsed.ENERGY_MAX === 6, JSON.stringify(parsed));
  push('反向控制：改成 10 就读出 10（说明不是写死的）',
    readEnergyConstants(sample.replace('ENERGY_MAX = 6', 'ENERGY_MAX = 10')).ENERGY_MAX === 10,
    String(readEnergyConstants(sample.replace('ENERGY_MAX = 6', 'ENERGY_MAX = 10')).ENERGY_MAX));
  push('读不到时常量必须是 null，不许补默认值', readEnergyConstants('no constants here').ENERGY_MAX === null,
    String(readEnergyConstants('no constants here').ENERGY_MAX));
  const baseline = buildBaseline();
  push('基线里的 HEAD 是 40 位 sha', /^[0-9a-f]{40}$/.test(baseline.head.sha), baseline.head.sha);
  push('基线里带上了旧规则产物的指纹（至少一项非 null）',
    Object.values(baseline.artifacts.fingerprints).some((v) => typeof v === 'string' && v.length === 64),
    JSON.stringify(Object.entries(baseline.artifacts.fingerprints).filter(([, v]) => v).length) + ' 项有指纹');
  push('门禁灯如实记录（latest 与 last_green 两个字段都在）',
    baseline.gate.latest !== undefined && baseline.gate.last_green !== undefined,
    JSON.stringify(baseline.gate));
  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name} — 实际：${c.actual}`);
  console.log(`自检：${checks.length - failed.length}/${checks.length} 通过`);
  return failed.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (flag('selftest')) process.exit(selftest());
  const baseline = buildBaseline();
  if (flag('json')) {
    console.log(JSON.stringify(baseline, null, 2));
  } else {
    mkdirSync(OUT, {recursive: true});
    const target = join(OUT, 'baseline.json');
    writeFileSync(target, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`wrote ${relative(ROOT, target)}`);
    console.log(`  HEAD ${baseline.head.sha.slice(0, 7)} · ${baseline.head.subject}`);
    console.log(`  工作区未提交 ${baseline.head.dirty_files.length} 项`);
    console.log(`  引擎能量常量 ${JSON.stringify(baseline.rule_baseline.engine_energy)}`);
    console.log(`  L1 目录 ${baseline.data_scale.full_catalog} · roster-48 ${baseline.data_scale.roster_48}`);
    console.log(`  门禁 latest=${baseline.gate.latest?.verdict ?? '（无）'} `
      + `last-green=${baseline.gate.last_green?.verdict ?? '（无）'}@${baseline.gate.last_green?.head?.slice(0, 7) ?? '—'}`);
  }
}
