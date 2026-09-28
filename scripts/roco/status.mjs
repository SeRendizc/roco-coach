#!/usr/bin/env node
// ── `npm run roco:status`：一条命令看清现状 ──────────────────────────────────
//
// 为什么要有它：人类 2026-09-28 中途问「现在啥进度，给我同步一下」—— 当时答案散在三个地方
// （台账要翻到文件末尾、门禁结果在 `reports/roco/verification/latest.json`、判据数在 `package.json`），
// 谁问一次我就得现查一次。这一支把它们拼成一屏。
//
// 它**只读**：不跑判据、不改任何文件（跑判据是 `npm run test:unit` / `verify:release` 的事）。
// 用法：`node scripts/roco/status.mjs [--json]`

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const asJson = process.argv.includes('--json');

const readJson = (rel) => {
  try { return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')); } catch { return null; }
};
const exec = (cmd, args) => {
  try { return execFileSync(cmd, args, {cwd: ROOT, encoding: 'utf8'}).trim(); } catch { return null; }
};

/** ① 判据文件数（`test:unit` 是手写清单，数出来才知道覆盖面有没有缩） */
const pkg = readJson('package.json');
const unitFiles = String(pkg?.scripts?.['test:unit'] ?? '')
  .split(' ').filter((x) => x.endsWith('.js') || x.endsWith('.mjs')).length;

/** ② 发版门禁：最近一次结果 + 它是什么时候跑的 */
const gate = readJson('reports/roco/verification/latest.json');
const gateAt = (() => {
  try { return statSync(join(ROOT, 'reports/roco/verification/latest.json')).mtime.toISOString(); }
  catch { return null; }
})();

/** ③ 单元判据的最近一次结果：从门禁产物里取 `unit` 那一套（它就在门禁里跑） */
const unitSuite = (gate?.suites ?? []).find((s) => s.id === 'unit');
const unitLine = unitSuite ? (unitSuite.ok ? '通过' : '未通过') : '（门禁里没有 unit 记录）';

/** ④ 演示服务 8765（有就报 HTTP 码；没有就如实说没起） */
async function portStatus() {
  try {
    const response = await fetch('http://127.0.0.1:8765/box.html', {method: 'GET'});
    return `HTTP ${response.status}`;
  } catch { return '（没起 / 连不上）'; }
}

/** ⑤ 工作区：改了多少文件、有没有未跟踪的新文件 */
const porcelain = exec('git', ['status', '--porcelain']) ?? '';
const changed = porcelain ? porcelain.split('\n').filter(Boolean) : [];
const untracked = changed.filter((line) => line.startsWith('??')).length;

/** ⑥ 最新一轮台账标题（文件末尾往前找最后一个 `§C6.xxx` / `### C6.xxx`） */
const ledger = (() => {
  try { return readFileSync(join(ROOT, 'docs/roadmap/DSH-EXECUTION-STATE.md'), 'utf8'); } catch { return ''; }
})();
const headings = [...ledger.matchAll(/^#{2,5}\s*(§?C6\.\d+[a-z]?)\s*(.*)$/gm)];
const latest = headings.at(-1);
const recent = headings.slice(-3).map((m) => `${m[1]} ${m[2].slice(0, 46)}`);

/** ⑦ 已知延后/待人类拍板（写在这里的是**当前**的，不是历史） */
const pending = [
  'trajectories-model 红：要跑本地 4B 模型重出轨迹（人类叮嘱过别卡 → 没跑）',
  '提交不提交：工作区改动全部未提交（上一轮口径：没点头不提交）',
  '要不要造一对同种个体，以真验"两个个体比较"（会动已钉住的"同种组 0"口径）',
];

const status = {
  unitFiles,
  unit: unitLine,
  gate: {verdict: gate?.verdict ?? '（没有产物）', failed: gate?.failed ?? [], at: gateAt},
  demo8765: await portStatus(),
  workspace: {changed: changed.length, untracked},
  ledgerLatest: latest ? `${latest[1]} ${latest[2]}` : '（读不到台账）',
  ledgerRecent: recent,
  pending,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(status, null, 1)}\n`);
} else {
  const line = (label, value) => process.stdout.write(`  ${label.padEnd(14)}${value}\n`);
  process.stdout.write('小芽 · 现状（只读，不改任何东西）\n');
  line('判据文件', `${unitFiles} 个（test:unit 手写清单）`);
  line('单元判据', unitLine);
  line('发版门禁', `${status.gate.verdict}${status.gate.failed.length ? ` —— 未通过：${status.gate.failed.join('、')}` : ''}`
    + `（${status.gate.at ? status.gate.at.replace('T', ' ').slice(0, 16) : '时间未知'}）`);
  line('演示服务', `8765 ${status.demo8765}`);
  line('工作区', `${changed.length} 个文件有改动（其中未跟踪 ${untracked} 个）—— 未提交`);
  line('最新台账', status.ledgerLatest);
  process.stdout.write('  最近三轮：\n');
  for (const row of status.ledgerRecent) process.stdout.write(`    · ${row}\n`);
  process.stdout.write('  待拍板/延后：\n');
  for (const row of pending) process.stdout.write(`    · ${row}\n`);
}
