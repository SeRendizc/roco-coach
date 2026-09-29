#!/usr/bin/env node
// task-18 ① **四项中招表**：把"探针自己的生命周期问题"逐脚本量出来（不笼统说"有些脚本"）。
//
// 四项（每一项都写清**判定用的正则**，读数里带命中行号 —— 读者可以逐条复核）：
//   ① 临时 profile      ：`mkdtempSync(` ⇒ 每轮新 profile ⇒ 每轮烧一个会话位（task-15 的根源）
//   ② 不确认会话有效    ：全文件里没有 `/api/roco/status` 与 `/api/bootstrap` 的任何握手
//                        （会话失效/表满时，探针会把 403/429 读成"产品坏了"）
//   ③ 不等宿主 API 挂上 ：用了 `window.rocoDemo` / `window.rocoTeamWorkshop`，
//                        却没有任何**提到同一个标识符**的 wait/poll
//   ④ 点按钮不做命中测试：派发鼠标事件却没有 `elementFromPoint` 命中测试；
//                        另外单独标出用 `element.click()`（JS 点击，不是真鼠标）的文件
//
// 用法：`node reports/roco/build-snapshot/scan-probe-lifecycle.mjs`
// 产物：`reports/roco/build-snapshot/probe-lifecycle.json`（+ stdout 的表）

import {readdirSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/build-snapshot$/, '');
const OUT = join(ROOT, 'reports/roco/build-snapshot');
const log = (...a) => console.log('[probe-lifecycle]', ...a);

const SCRIPT_DIR = join(ROOT, 'scripts/roco');
const files = [
  ...readdirSync(SCRIPT_DIR).filter((name) => /^browser-.*\.mjs$/.test(name)).map((name) => join('scripts/roco', name)),
  ...readdirSync(join(ROOT, 'reports/roco')).filter((name) => name === 'xiaoya-context')
    .flatMap((name) => readdirSync(join(ROOT, 'reports/roco', name))
      .filter((f) => f.endsWith('.mjs')).map((f) => join('reports/roco', name, f))),
];
// 我自己的三个真机判据脚本也一起量（它们同属"探针"，不该例外）
for (const f of readdirSync(OUT).filter((name) => /^browser-.*\.mjs$/.test(name))) {
  files.push(join('reports/roco/build-snapshot', f));
}

const linesOf = (text) => text.split('\n');
const hits = (lines, re) => lines.map((line, i) => ({line: i + 1, text: line.trim()}))
  .filter((row) => re.test(row.text));

const HOST_API = /window\.rocoDemo|window\.rocoTeamWorkshop/;
const WAIT_CALL = /waitFor|waitUntil|poll|until\(|for\s*\(.*<\s*\d+/;

const rows = [];
for (const rel of [...new Set(files)].sort()) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const lines = linesOf(text);
  const row = {file: rel, lines: lines.length};
  // ① 临时 profile
  row.tempProfile = {hit: /mkdtempSync\(/.test(text), at: hits(lines, /mkdtempSync\(/).map((r) => r.line)};
  row.persistentProfile = /tmp\/browser-profile|browser-profile/.test(text);
  // ② 会话/引擎握手
  const statusHits = hits(lines, /\/api\/roco\/status/);
  const bootstrapHits = hits(lines, /\/api\/bootstrap/);
  row.sessionHandshake = {status: statusHits.map((r) => r.line), bootstrap: bootstrapHits.map((r) => r.line),
    hit: statusHits.length === 0 && bootstrapHits.length === 0};
  // ③ 宿主 API 就绪：**逐调用点**看它前面 6 行里有没有一次 waitFor/poll（启发式，写在这里免得被当成精确分析）
  const hostHits = hits(lines, HOST_API).filter((h) => !/^\s*\/\//.test(lines[h.line - 1]));
  const sites = hostHits.map((h) => {
    const from = Math.max(0, h.line - 7);
    const guard = lines.slice(from, h.line).some((line) => WAIT_CALL.test(line));
    return {line: h.line, text: h.text.slice(0, 90), waitedWithin6Lines: guard};
  });
  const unguarded = sites.filter((site) => !site.waitedWithin6Lines);
  row.hostApi = {used: sites.length > 0, sites: sites.slice(0, 8), unguarded: unguarded.length,
    hit: sites.length > 0 && unguarded.length > 0, first: sites[0]?.line ?? null};
  // ④ 命中测试 / 真鼠标
  const mouseDispatch = /Input\.dispatchMouseEvent/.test(text);
  const hitTest = /elementFromPoint/.test(text);
  const jsClick = hits(lines, /\.click\(\)/);
  row.clicks = {mouseDispatch, hitTest, jsClick: jsClick.map((r) => r.line).slice(0, 6),
    hit: mouseDispatch && !hitTest};
  rows.push(row);
}

const report = {generated: new Date().toISOString(),
  command: 'node reports/roco/build-snapshot/scan-probe-lifecycle.mjs',
  patterns: {
    temp_profile: 'mkdtempSync(',
    session_handshake: '/api/roco/status 或 /api/bootstrap',
    host_api: 'window.rocoDemo|window.rocoTeamWorkshop（且没有任何提到它的 wait/poll）',
    hit_test: 'Input.dispatchMouseEvent 但没有 elementFromPoint',
  },
  rows};
mkdirSync(OUT, {recursive: true});
writeFileSync(join(OUT, 'probe-lifecycle.json'), `${JSON.stringify(report, null, 1)}\n`);

const mark = (bad) => (bad ? '✗' : '·');
log('脚本'.padEnd(46) + '①临时profile ②无会话握手 ③不等宿主API ④无命中测试');
for (const row of rows) {
  log(row.file.padEnd(46)
    + `${mark(row.tempProfile.hit)}${row.tempProfile.hit ? '(' + row.tempProfile.at.join(',') + ')' : ''}`.padEnd(14)
    + `${mark(row.sessionHandshake.hit)}`.padEnd(12)
    + `${mark(row.hostApi.hit)}${row.hostApi.used ? `(调用${row.hostApi.sites.length}处,未等${row.hostApi.unguarded})` : '(未用)'}`.padEnd(22)
    + `${mark(row.clicks.hit)}${row.clicks.jsClick.length ? ` jsClick:${row.clicks.jsClick.join(',')}` : ''}`);
}
const count = (key, sub = 'hit') => rows.filter((r) => r[key][sub]).length;
log(`合计 ${rows.length} 个文件：①临时 profile ${count('tempProfile')} 个 · `
  + `②无会话握手 ${count('sessionHandshake')} 个 · ③不等宿主 API ${count('hostApi')} 个 · `
  + `④无命中测试 ${count('clicks')} 个`);
log('报告：reports/roco/build-snapshot/probe-lifecycle.json');
