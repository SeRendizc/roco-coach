#!/usr/bin/env node
// RC-104 规则变化 → 产物失效图。
//
// 问题：基础规则（能量上限/初始值/回能、时序、属性倍率、候选宇宙、BattleMode…）一旦改，
// 一批产物**当场作废**：轨迹、SFT 数据、介入窗口与判定层、planner 基准、局面夹具、文档、
// 页面文案。当前仓库没有任何地方记着这件事 —— 只能靠人回想，而第 63 轮已经吃过一次
// （引擎 fail-closed 修复改变战斗走向，12 个局面夹具全部失配才发现）。
//
// 这个脚本把「登记表 → 受影响清单」变成可复跑的一步：
//
//     node scripts/roco/artifact-invalidation.mjs                        # 写报告（默认：所有主题）
//     node scripts/roco/artifact-invalidation.mjs --topics energy.max,energy.regen
//     node scripts/roco/artifact-invalidation.mjs --json
//     node scripts/roco/artifact-invalidation.mjs --selftest
//
// 判据（都能被反证）：
//   · 每条 artifact 至少一个 depends_on；每个 rule topic 至少被一条 artifact 依赖；
//   · path 必须真实存在（glob 至少命中一个文件）——登记表不许写想象中的路径；
//   · `status=legacy` 的产物进入 `do_not_regenerate` 清单：规则 candidate 采纳前**禁止重跑**
//     （否则只是在生产更多绑定旧规则的产物，正合人类指令「先不要用旧规则继续训练或生成轨迹」）。

import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
const REGISTRY = 'data/roco/artifact-registry.json';
const OUT = join(ROOT, 'reports', 'roco', 'flagship-upgrade');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** 路径是否真的存在（目录/文件都算；`*` 结尾当 glob，至少命中一个）。 */
export function pathExists(rel) {
  const abs = join(ROOT, rel);
  if (existsSync(abs)) return true;
  if (!rel.includes('*')) return false;
  const dir = dirname(rel);
  const prefix = rel.slice(dir.length + 1).replace(/\*+$/, '');
  const absDir = join(ROOT, dir);
  if (!existsSync(absDir)) return false;
  return readdirSync(absDir).some((name) => name.startsWith(prefix));
}

/**
 * 校验登记表本身。返回违规列表（空 = 合规）。
 *
 * 抽成导出的纯函数，是为了让测试能**直接对规则本体**做反证（构造一份坏登记表），
 * 而不是抄一份实现。
 */
export function validateRegistry(registry) {
  const problems = [];
  const topics = new Set((registry.rule_topics ?? []).map((t) => t.id));
  if (!topics.size) problems.push('rule_topics 为空：没有主题就没有失效图');
  const used = new Set();
  for (const art of registry.artifacts ?? []) {
    const id = art.id ?? '（没有 id）';
    if (!Array.isArray(art.depends_on) || art.depends_on.length === 0) {
      problems.push(`${id}：没有声明 depends_on —— 那我们就不知道它为什么是对的`);
    } else {
      for (const topic of art.depends_on) {
        used.add(topic);
        if (!topics.has(topic)) problems.push(`${id}：依赖了未登记的主题 ${topic}`);
      }
    }
    if (!art.path) problems.push(`${id}：没有 path`);
    else if (!pathExists(art.path)) problems.push(`${id}：path 不存在（${art.path}）——不许登记想象中的路径`);
    if (!art.rebuild) problems.push(`${id}：没有 rebuild（失效之后要能重建）`);
    if (!art.status) problems.push(`${id}：没有 status`);
  }
  for (const topic of topics) {
    if (!used.has(topic)) problems.push(`主题 ${topic} 没有任何产物依赖它 —— 这张失效图漏了东西`);
  }
  return problems;
}

/**
 * 算出「这些规则主题变了 → 哪些产物受影响」。
 *
 * @param {object} registry 登记表
 * @param {string[]} topics 变化的主题（空 = 全部主题）
 */
export function invalidate(registry, topics = []) {
  const changed = topics.length ? topics : (registry.rule_topics ?? []).map((t) => t.id);
  const byTopic = {};
  for (const topic of changed) {
    byTopic[topic] = (registry.artifacts ?? [])
      .filter((a) => (a.depends_on ?? []).includes(topic))
      .map((a) => ({id: a.id, kind: a.kind, status: a.status, path: a.path, rebuild: a.rebuild}));
  }
  const affectedIds = new Set();
  for (const rows of Object.values(byTopic)) for (const row of rows) affectedIds.add(row.id);
  const affected = (registry.artifacts ?? []).filter((a) => affectedIds.has(a.id));
  const mustNotRegenerate = affected.filter((a) => String(a.status ?? '').startsWith('legacy'));
  return {
    changed_topics: changed,
    by_topic: byTopic,
    affected: affected.map((a) => ({
      id: a.id, kind: a.kind, status: a.status, path: a.path, rebuild: a.rebuild,
      depends_on: a.depends_on,
    })),
    summary: {
      topics: changed.length,
      affected: affected.length,
      artifacts_total: (registry.artifacts ?? []).length,
      by_status: affected.reduce((acc, a) => {
        acc[a.status] = (acc[a.status] ?? 0) + 1;
        return acc;
      }, {}),
      by_kind: affected.reduce((acc, a) => {
        acc[a.kind] = (acc[a.kind] ?? 0) + 1;
        return acc;
      }, {}),
    },
    do_not_regenerate: mustNotRegenerate.map((a) => ({
      id: a.id, status: a.status, path: a.path,
      why: '绑定旧规则的产物：对应规则 candidate 被采纳前重跑，只会再生产一批绑定旧规则的东西。',
    })),
  };
}

export function buildReport() {
  const registry = JSON.parse(readFileSync(join(ROOT, REGISTRY), 'utf8'));
  const problems = validateRegistry(registry);
  const topicsArg = arg('topics');
  const changed = topicsArg ? topicsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const unknown = changed.filter((t) => !(registry.rule_topics ?? []).some((row) => row.id === t));
  return {
    schema: 'roco-artifact-invalidation/v1',
    generated_by: 'scripts/roco/artifact-invalidation.mjs',
    generated_at: new Date().toISOString(),
    registry: {
      path: REGISTRY,
      sha256: createHash('sha256').update(readFileSync(join(ROOT, REGISTRY))).digest('hex'),
      artifacts: (registry.artifacts ?? []).length,
      rule_topics: (registry.rule_topics ?? []).length,
    },
    registry_problems: problems,
    requested_topics: changed,
    unknown_topics: unknown,
    ...invalidate(registry, changed),
  };
}

function selftest() {
  const registry = JSON.parse(readFileSync(join(ROOT, REGISTRY), 'utf8'));
  const checks = [];
  const push = (name, ok, actual) => checks.push({name, ok: Boolean(ok), actual});
  push('登记表本身合规（路径都存在、每个主题都有人依赖）',
    validateRegistry(registry).length === 0, JSON.stringify(validateRegistry(registry)).slice(0, 300));

  // 反证①：摘掉一条产物的 depends_on → 必须红
  const noDeps = JSON.parse(JSON.stringify(registry));
  delete noDeps.artifacts[0].depends_on;
  push('反证①：产物没有 depends_on 必须被判红',
    validateRegistry(noDeps).some((p) => p.includes('depends_on')),
    JSON.stringify(validateRegistry(noDeps)).slice(0, 200));

  // 反证②：登记一个不存在的路径 → 必须红
  const badPath = JSON.parse(JSON.stringify(registry));
  badPath.artifacts[0].path = 'reports/roco/does-not-exist-xyz.json';
  push('反证②：登记想象中的路径必须被判红',
    validateRegistry(badPath).some((p) => p.includes('path 不存在')),
    JSON.stringify(validateRegistry(badPath)).slice(0, 200));

  // 反证③：加一个没人依赖的主题 → 必须红（说明失效图漏了东西）
  const orphanTopic = JSON.parse(JSON.stringify(registry));
  orphanTopic.rule_topics.push({id: 'topic.nobody.depends', why: '反证用'});
  push('反证③：没有任何产物依赖的主题必须被判红',
    validateRegistry(orphanTopic).some((p) => p.includes('没有任何产物依赖')),
    JSON.stringify(validateRegistry(orphanTopic).filter((p) => p.includes('没有任何产物依赖'))).slice(0, 200));

  // 反证④：失效计算必须**真的查依赖**，不是把清单写死
  const trimmed = JSON.parse(JSON.stringify(registry));
  const traj = trimmed.artifacts.find((a) => a.id === 'traj-rule-arm-v1');
  traj.depends_on = traj.depends_on.filter((t) => t !== 'energy.max');
  const before = invalidate(registry, ['energy.max']).affected.map((a) => a.id);
  const after = invalidate(trimmed, ['energy.max']).affected.map((a) => a.id);
  push('反证④：把某产物对 energy.max 的依赖删掉，它就不该再出现在受影响清单里',
    before.includes('traj-rule-arm-v1') && !after.includes('traj-rule-arm-v1'),
    `before=${before.length} 条（含 traj-rule-arm-v1=${before.includes('traj-rule-arm-v1')}）`
    + ` after=${after.length} 条（含=${after.includes('traj-rule-arm-v1')}）`);

  // 反证⑤：旧规则产物必须进「禁止重跑」清单
  const energy = invalidate(registry, ['energy.max']);
  push('反证⑤：energy.max 一变，绑定旧规则的产物必须进 do_not_regenerate',
    energy.do_not_regenerate.length > 0, `do_not_regenerate=${energy.do_not_regenerate.length} 条`);

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name} — 实际：${c.actual}`);
  console.log(`自检：${checks.length - failed.length}/${checks.length} 通过`);
  return failed.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (flag('selftest')) process.exit(selftest());
  const report = buildReport();
  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    mkdirSync(OUT, {recursive: true});
    const target = join(OUT, 'artifact-invalidation.json');
    writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    console.log(`wrote ${relative(ROOT, target)}`);
    console.log(`  登记 ${report.registry.artifacts} 条产物 / ${report.registry.rule_topics} 个规则主题`
      + `（登记表问题 ${report.registry_problems.length} 项）`);
    console.log(`  变化主题 ${report.summary.topics} 个 → 受影响 ${report.summary.affected} 条产物`);
    console.log(`  其中**禁止重跑**（绑定旧规则）：${report.do_not_regenerate.length} 条`);
    for (const row of report.do_not_regenerate.slice(0, 12)) console.log(`    · ${row.id}（${row.status}）${row.path}`);
  }
}
