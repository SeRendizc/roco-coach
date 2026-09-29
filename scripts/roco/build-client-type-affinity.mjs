#!/usr/bin/env node
// 客户端属性相性表：**从冻结真值生成**，不手写。
//
// 为什么需要它（U05，2026-09-29 用户截图 5/6）
// ------------------------------------------------
// 玩家报的是「换精灵之后克制/被克制标记丢失」。查到的原因不是渲染 bug，而是
// `roco.js` 那一格**故意留空**：
//     `if (rel) rel.textContent = '';  // 克制关系要倍率；拿不到就留空（不编）`
//     `if (mark) mark.dataset.b3Rel = 'unknown';`
// 倍率当时只有一条来源：引擎的 `damage_preview.samples` —— 那是**我方技能打对手**的
// 进攻向倍率。而「换人候选的相性」问的是**反方向**（对手的属性打这一只，它承伤多少），
// 引擎的 samples 里根本没有这一项，所以只能不画。
//
// 这一层补的就是那个反方向：把冻结真值 `types.json#types`（键 = 防御方的属性组合，
// 值 = 各攻击属性对该组合的倍率）搬到客户端，让「承伤相性」能**现算**。
//
// 三条纪律（照本仓规矩）
// ----------------------
//   ① **只有一个真值来源**：数据逐字来自 `data/roco/normalized/<ruleset>/types.json`，
//      本文件不写任何倍率常量；产物里带 `source_sha256` + `ruleset_id` + `source_id`。
//   ② **和教练层同一套口径**：整数标度 ×4、防御键 = `types.join('|')`
//      （与 `src/coach/team-gaps.js:438 defenceScale()` 逐字一致），
//      组合键没登记 ⇒ `null`（未知），**不猜成 1**。
//   ③ **可验证漂移**：`--verify` 重新生成一遍与磁盘逐字节比对，不一致就退出码 1
//      （不是"看一眼觉得对"）。
//
// 用法：
//   node scripts/roco/build-client-type-affinity.mjs            # 写产物
//   node scripts/roco/build-client-type-affinity.mjs --verify    # 只校验，不写

import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, relative} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const RULESET_ID = 'roco-world-s4-2026-09-10';
export const SOURCE_PATH = join(REPO_ROOT, 'data', 'roco', 'normalized', RULESET_ID, 'types.json');
export const OUT_PATH = join(REPO_ROOT, 'src', 'client', 'type-affinity.data.js');

/** 整数标度：倍率 ×4（与 `team-gaps.js` 的 `scaleByCombo` 同一口径）。 */
const SCALE_PER_UNIT = 4;

/** 倍率 → 标度。只认冻结表里真的出现过的档位；出现新档位就**报错停下**，不四舍五入偷偷吞掉。 */
export function scaleOf(multiplier) {
  const scale = multiplier * SCALE_PER_UNIT;
  if (!Number.isInteger(scale)) {
    throw new Error(`倍率 ${multiplier} × ${SCALE_PER_UNIT} 不是整数：冻结表出现未登记档位，先裁口径再生成。`);
  }
  return scale;
}

/** 读冻结真值 + 生成数据体（纯函数，便于测试直接调用）。 */
export function buildAffinityData() {
  const raw = readFileSync(SOURCE_PATH, 'utf8');
  const sourceSha256 = createHash('sha256').update(raw).digest('hex');
  const doc = JSON.parse(raw);
  const types = doc?.types;
  if (!types || typeof types !== 'object') throw new Error('types.json 没有 #types 对象。');

  /** @type {Record<string, Array<[string, number]>>} */
  const combos = {};
  for (const key of Object.keys(types).sort()) {
    const entry = types[key];
    /** @type {Map<string, number>} */
    const byAttack = new Map();
    for (const bucket of ['resist', 'weak']) {
      for (const row of entry?.[bucket] ?? []) {
        const attack = row?.type;
        if (typeof attack !== 'string' || !attack) throw new Error(`${key} 的 ${bucket} 有一行没有 type。`);
        const scale = scaleOf(Number(row.multiplier));
        if (byAttack.has(attack)) throw new Error(`${key} 的攻击属性 ${attack} 在 resist/weak 里各出现一次。`);
        byAttack.set(attack, scale);
      }
    }
    // 只存**偏离中性**的格子（中性 = 4）。这一条让产物从 120×18 缩到 1023 行。
    const rows = [...byAttack.entries()]
      .filter(([, scale]) => scale !== SCALE_PER_UNIT)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    combos[key] = rows;
  }

  const singles = Object.keys(combos).filter((k) => !k.includes('|'));
  if (singles.length !== 18) throw new Error(`单属性键应当 18 个，实测 ${singles.length} 个。`);

  return {
    schemaVersion: doc.schema_version ?? null,
    rulesetId: doc.ruleset_id ?? RULESET_ID,
    sourceId: doc.source_id ?? null,
    sourceSha256,
    sourceNote: doc.note ?? '',
    comboCount: Object.keys(combos).length,
    entryCount: Object.values(combos).reduce((n, rows) => n + rows.length, 0),
    combos,
  };
}

/** 产物文本（生成器与 `--verify` 走**同一个**函数，不许各写一份）。 */
export function renderAffinityModule(data) {
  const lines = Object.entries(data.combos)
    .map(([key, rows]) => `  ${JSON.stringify(key)}: [${rows.map(([t, s]) => `[${JSON.stringify(t)},${s}]`).join(',')}],`);
  return `// ⚠⚠ 自动生成，**不要手改**。改口径请改 scripts/roco/build-client-type-affinity.mjs 再重新生成。
//
// 生成命令：node scripts/roco/build-client-type-affinity.mjs
// 校验命令：node scripts/roco/build-client-type-affinity.mjs --verify   （磁盘与源不一致 ⇒ 退出码 1）
//
// 数据来源（逐字，未做任何换算以外的加工）：
//   · 文件：data/roco/normalized/${data.rulesetId}/types.json
//   · sha256：${data.sourceSha256}
//   · ruleset_id：${data.rulesetId}
//   · source_id：${data.sourceId}
//   · schema_version：${data.schemaVersion}
//   · 源文件自述：${data.sourceNote}
//
// 形状：combo（防御方属性组合，\`types.join('|')\`）→ [[攻击属性, 标度]]，标度 = 倍率 × 4。
// **只列偏离中性的格子**：没列到的攻击属性就是中性（标度 ${SCALE_PER_UNIT}）。
// 组合键没登记 ⇒ 调用方**必须**返回"未知"，不许当成中性。

export const RULESET_ID = ${JSON.stringify(data.rulesetId)};
export const SOURCE_SHA256 = ${JSON.stringify(data.sourceSha256)};
export const SOURCE_ID = ${JSON.stringify(data.sourceId)};
export const SCALE_NEUTRAL = ${SCALE_PER_UNIT};
export const COMBO_COUNT = ${data.comboCount};
export const ENTRY_COUNT = ${data.entryCount};

/** @type {Record<string, Array<[string, number]>>} */
export const DEFENCE_SCALE_BY_COMBO = {
${lines.join('\n')}
};
`;
}

function main(argv) {
  const verify = argv.includes('--verify');
  const data = buildAffinityData();
  const next = renderAffinityModule(data);
  let prev = null;
  try { prev = readFileSync(OUT_PATH, 'utf8'); } catch { prev = null; }

  if (verify) {
    if (prev === next) {
      process.stdout.write(`ok ${relative(REPO_ROOT, OUT_PATH)} 与 ${relative(REPO_ROOT, SOURCE_PATH)} 一致`
        + `（${data.comboCount} 组合 / ${data.entryCount} 非中性格 / sha256 ${data.sourceSha256.slice(0, 12)}…）\n`);
      return 0;
    }
    process.stderr.write(`DRIFT ${relative(REPO_ROOT, OUT_PATH)} 与冻结真值不一致（或不存在）。`
      + `重新生成：node scripts/roco/build-client-type-affinity.mjs\n`);
    return 1;
  }

  if (prev === next) {
    process.stdout.write(`unchanged ${relative(REPO_ROOT, OUT_PATH)}\n`);
    return 0;
  }
  writeFileSync(OUT_PATH, next);
  process.stdout.write(`wrote ${relative(REPO_ROOT, OUT_PATH)}`
    + `（${data.comboCount} 组合 / ${data.entryCount} 非中性格 / sha256 ${data.sourceSha256.slice(0, 12)}…）\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
