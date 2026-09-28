#!/usr/bin/env node
/**
 * 演示服务的**受保护**启停：不许再无保护地 `pkill`，也不许再模糊地杀。
 *
 * 由来（Codex 两轮监工，逐字）：
 *  第一轮：「server-restart 日志明确密钥只存在进程内存，重启丢连接。**禁止再次无保护重启**；
 *          不找/打印密钥、不擅自持久化。请记录恢复依赖、改善重启流程与缺连接反馈，
 *          **并把模型连通作为服务健康项；现阶段不能只报 HTTP 200**。」
 *  第二轮：「serve.mjs 用 `pkill -f src/server/index.js`，会匹配**其他项目/其他端口的同名服务**。
 *          请**只停止经端口 8765 + 本仓绝对入口/工作目录核实的 PID**；目标不明确就**拒绝**，
 *          不用模糊全局 pkill，也**不要为了验证再重启主服务**。」
 *
 * 所以现在停服务走的是**三重取证**，任何一条不过就**拒绝**（绝不"差不多就杀"）：
 *   ① 端口必须是 **8765**（按端口查，不按名字查）；
 *   ② 那个 PID 的**工作目录必须 == 本仓根**（这台机器 `ps` 不可用，cwd 是最可靠的归属证据）；
 *   ③ 杀之前再做一次 **HTTP 身份探测**（页面里必须有本产品自己的字样）。
 *   `lsof` 查不到、有多个监听者、cwd 对不上、身份探测不对 ⇒ 一律拒绝并说明原因。
 *
 * 它**不会**：读/打印/保存任何密钥；改 `.env`；动真实账号；用 `pkill` 按名字模糊匹配。
 *
 * 用法：
 *   node scripts/roco/serve.mjs --status
 *   node scripts/roco/serve.mjs --restart --dry-run   # **只打印要做什么，什么都不杀**（验证这条路用它）
 *   node scripts/roco/serve.mjs --start
 *   node scripts/roco/serve.mjs --restart [--force]
 */

import {spawn, spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyModels, decideRestart, parseLsofCwd, parseLsofListeners, selectTargets} from './serve-lib.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASE = process.env.ROCO_BASE || 'http://127.0.0.1:8765';
const PORT = Number(new URL(BASE).port || 8765);
const ENTRY = join(ROOT, 'src', 'server', 'index.js');

const lsof = (args) => {
  const r = spawnSync('/usr/sbin/lsof', args, {encoding: 'utf8'});
  return {ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim()};
};

/** 8765 上的监听者 + 它们的工作目录（拿不到 cwd 的会带 `cwd:null`，交给 selectTargets 拒绝）。 */
function listeners() {
  const listed = lsof(['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-F', 'pc']);
  if (!listed.ok && !listed.out) return {rows: [], why: `lsof 查监听者失败：${listed.err || '无输出'}`};
  const rows = parseLsofListeners(listed.out).map((one) => {
    const cwdOut = lsof(['-a', '-p', String(one.pid), '-d', 'cwd', '-F', 'n']);
    return {...one, cwd: cwdOut.ok ? parseLsofCwd(cwdOut.out) : null};
  });
  return {rows, why: null};
}

/** HTTP 身份探测：这个 8765 上的服务必须**看起来是我们自己的**。 */
async function identifyHttp() {
  try {
    const res = await fetch(`${BASE}/box.html`, {signal: AbortSignal.timeout(6000)});
    if (!res.ok) return {ok: false, why: `/box.html 返回 HTTP ${res.status}`};
    const html = await res.text();
    if (!/小芽/.test(html)) return {ok: false, why: '/box.html 里没有本产品的字样（不是我们的服务？）'};
    return {ok: true, why: '页面带本产品字样'};
  } catch (error) {
    return {ok: false, why: `取 /box.html 失败：${String(error?.message || error).slice(0, 60)}`};
  }
}

async function modelState() {
  try {
    const res = await fetch(`${BASE}/api/models`, {signal: AbortSignal.timeout(6000)});
    if (!res.ok) return classifyModels(null);
    return classifyModels(await res.json());
  } catch {
    return classifyModels(null);   // 取不到 ⇒ unknown（**不是** disconnected）
  }
}

async function status() {
  const box = await fetch(`${BASE}/box.html`, {signal: AbortSignal.timeout(6000)})
    .then((r) => ({ok: r.ok, http: r.status})).catch((e) => ({ok: false, why: String(e?.message || e)}));
  if (!box.ok) return {up: false, why: box.why ?? `HTTP ${box.http}`};
  const cloud = await modelState();
  const {rows, why} = listeners();
  const target = selectTargets({listeners: rows, repoRoot: ROOT, port: PORT});
  return {up: true, cloud, target, listenWhy: why};
}

function printStatus(s) {
  if (!s.up) { console.log(`[serve] ${PORT} 上没有服务（${s.why}）`); return; }
  console.log(`[serve] ${PORT} 上已经有服务在跑：`);
  console.log(`  · 云端模型：state=**${s.cloud.state}** connected=${s.cloud.connected} verified=${s.cloud.verified}｜reason=${JSON.stringify(s.cloud.reason)}`);
  console.log(`  · 归属取证：${s.target.ok ? `✔ ${s.target.reason}` : `✖ ${s.target.reason}`}${s.listenWhy ? `（${s.listenWhy}）` : ''}`);
  console.log(`  · 重启会丢：${s.cloud.state === 'disconnected' ? '没有云端连接可丢' : '**可能是这台进程内存里的云端连接**'}`);
}

async function waitReady(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await fetch(`${BASE}/api/roco/box?kind=mine&limit=1&offset=0`, {signal: AbortSignal.timeout(4000)})
      .then((r) => r.ok).catch(() => false);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function start() {
  const child = spawn(process.execPath, [ENTRY], {cwd: ROOT, detached: true, stdio: 'ignore'});
  child.unref();
  console.log(`[serve] 已启动（pid ${child.pid}，cwd=${ROOT}）`);
  return child.pid;
}

async function runHealthcheck() {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'roco', 'healthcheck.mjs')], {cwd: ROOT, stdio: 'inherit'});
  return r.status ?? 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const dryRun = has('--dry-run');

  if (has('--status') || argv.length === 0) {
    const s = await status();
    printStatus(s);
    process.exit(s.up ? 0 : 1);
  }

  if (has('--start')) {
    const s = await status();
    if (s.up) { console.log('[serve] 已经在跑，不重复启动。'); printStatus(s); process.exit(0); }
    if (dryRun) { console.log(`[serve] --dry-run：会启动 ${ENTRY}（cwd=${ROOT}），实际什么都没做。`); process.exit(0); }
    start();
    const ok = await waitReady();
    console.log(ok ? '[serve] 就绪。' : '[serve] ✖ 30 秒内没就绪。');
    process.exit(await runHealthcheck());
  }

  if (!has('--restart')) {
    console.error('用法：--status | --start | --restart [--force] [--dry-run]');
    process.exit(2);
  }

  // ── 重启 ────────────────────────────────────────────────────────────────
  const s = await status();

  if (!s.up) {
    console.log(`[serve] ${PORT} 上没有服务，直接启动。`);
    if (dryRun) { console.log(`[serve] --dry-run：会启动 ${ENTRY}，实际什么都没做。`); process.exit(0); }
    start();
    const ok = await waitReady();
    console.log(ok ? '[serve] 就绪。' : '[serve] ✖ 没起来。');
    process.exit(await runHealthcheck());
  }

  // ① 先判"能不能重启"（连着 / **未知** 都拒绝）
  const decision = decideRestart({cloudState: s.cloud.state, force: has('--force')});
  if (!decision.allow) {
    console.log(`[serve] **拒绝重启**：${decision.why}`);
    console.log(`  · 云端 state=**${s.cloud.state}**（${s.cloud.why}）reason=${JSON.stringify(s.cloud.reason)}`);
    console.log('  · 恢复/重连请用 **connect.html**（密钥在本页加密后只进后端内存，不用重启、不落盘）：');
    console.log(`    ${BASE}/connect.html`);
    console.log('  · 说明见 docs/roco/review-2026-09-28/codex-healthcheck/模型连接与重启安全.md');
    process.exit(decision.code);
  }

  // ② 再判"要杀谁"（端口 + cwd + HTTP 身份三重取证，不明确就拒绝）
  const ident = await identifyHttp();
  const target = s.target;
  if (!target.ok || !ident.ok) {
    console.log('[serve] **拒绝重启**：无法确认 8765 上这个服务是本仓的。');
    console.log(`  · 归属取证：${target.reason}`);
    console.log(`  · 身份探测：${ident.why}`);
    console.log('  · 本脚本**不会**用 pkill 按名字模糊匹配（那会误杀别人的同名服务）。');
    process.exit(4);
  }
  console.log(`[serve] 目标确认：${target.reason}；身份探测：${ident.why}`);
  console.log(`[serve] 重启理由：${decision.why}`);

  if (dryRun) {
    console.log(`[serve] --dry-run：**只会** kill pid ${target.pid}（TERM）然后启动 ${ENTRY}；实际什么都没做。`);
    process.exit(0);
  }

  try {
    process.kill(target.pid, 'SIGTERM');
    console.log(`[serve] 已向 pid ${target.pid} 发 SIGTERM（只这一个进程，不是全局 pkill）。`);
  } catch (error) {
    console.log(`[serve] ✖ kill pid ${target.pid} 失败：${String(error?.message || error).slice(0, 80)}`);
    process.exit(5);
  }
  await new Promise((r) => setTimeout(r, 900));
  start();
  const ok = await waitReady();
  console.log(ok ? '[serve] 就绪。' : '[serve] ✖ 没起来。');
  const code = await runHealthcheck();
  if (code === 1) console.log('[serve] 提醒：健康检查报**坏了**。');
  process.exit(code);
}

await main();
