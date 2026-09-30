#!/usr/bin/env node
/**
 * **跨集泄漏判据**：`triple` / `seed` / `family`（+ 队伍组合）四个键都不许跨集。
 *
 * 为什么单独一份（2026-09-30 · P0）：`triple` 是 `createGame(seed, triple)` 拿去建局的三只物种 ——
 * **模型在 receipts 里看到的就是这三只**（`player.pets[].id/hp/energy/skills` 全是它）。
 * 旧生成器里 `triple` 只由**家族序号取模**得到，而 split 是 `SPLITS[fi % 3]`
 * ⇒ **同一个 triple 落进不同集合**（实测 85 行里 **14/14 个 triple 全部跨集** ✗）。
 * seed 不同**不代表**是"另一场战斗"：**组合相同就是同一类泄漏** ✗
 * （与"同一场战斗 / 同一只精灵的不同问法"同族）。
 *
 * 判据（四个键，**别只修一个** ✗）：
 *   ① `triple` ② `seed` ③ `family` ④ `team`（`messages[2].args` 里的 team/team_before/team_after）
 *   —— 一个取值只许出现在一个集合里 ⇒ 计数必须**全 0** ✓
 *
 * 生成器侧还有一道**运行期守卫**（`gen-router-v9-v2.mjs`：`usedTriples` 撞号就 `throw`）✓
 *   —— 本文件是**事后的、可复跑的**那一半（能验**已经落盘的数据**，包括别人手改过的 ✗）。
 *
 * 用法：node training/prep-2026-09-29/router-v9/evidence/check-split-keys.mjs [产物目录]
 *   省略目录 = 正式产物目录（`router-v9/`）
 * 退出码：0 = 四键全 0 ✓ · 1 = 有跨集（逐条点名 ✗）
 */
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = process.argv[2] ?? join(HERE, '..');
const SPLITS = ['train', 'valid', 'test'];

const keyOf = {
  triple: (r) => {
    const t = (r.context_spec ?? {}).triple;
    return Array.isArray(t) && t.length ? t.join(',') : null;
  },
  seed: (r) => {
    const s = (r.context_spec ?? {}).seed;
    return s === undefined || s === null ? null : String(s);
  },
  family: (r) => (r.group_id ? String(r.group_id) : null),
  team: (r) => {
    let args = {};
    try {
      args = JSON.parse(r.messages[2].content).args ?? {};
    } catch {
      return null;
    }
    const team = [].concat(args.team ?? [], args.team_before ?? [], args.team_after ?? []);
    return team.length ? team.join(',') : null;
  },
};

const where = new Map();          // `${key}\u0000${value}` → split
const values = {triple: new Set(), seed: new Set(), family: new Set(), team: new Set()};
const problems = [];
let total = 0;
for (const split of SPLITS) {
  const path = join(DIR, `${split}.jsonl`);
  if (!existsSync(path)) {
    console.error(`✗ 产物不存在：${path}（先跑生成器，或用 --check 落到 tmp/）`);
    process.exit(1);
  }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    total += 1;
    const row = JSON.parse(line);
    for (const [label, fn] of Object.entries(keyOf)) {
      const v = fn(row);
      if (v === null || v === undefined || v === '') continue;
      values[label].add(v);
      const k = `${label}\u0000${v}`;
      if (where.has(k) && where.get(k) !== split) {
        problems.push(`${label} 跨集出现：${v}（${where.get(k)} 与 ${split}）`);
      }
      where.set(k, split);
    }
  }
}
console.log(`产物目录：${DIR} · 共 ${total} 行（${SPLITS.map((s) => s).join('/')}）`);
for (const label of Object.keys(keyOf)) {
  const n = problems.filter((p) => p.startsWith(`${label} `)).length;
  console.log(`  ${n === 0 ? '✓' : '✗'} ${label.padEnd(7)} 共 ${String(values[label].size).padStart(3)} 个取值 · **跨集 ${n}**`);
}
if (problems.length) {
  console.error('生成自查不过：\n - ' + problems.slice(0, 10).join('\n - '));
  process.exit(1);
}
console.log('⇒ 四键全部 0 跨集 ✓');
process.exit(0);
