#!/usr/bin/env node
/**
 * 演示服务的**受保护**启停：不许再无保护地 `pkill`。
 *
 * 由来（Codex 2026-09-29 第一轮监工第 1 条，逐字）：
 * 「server-restart 日志明确密钥只存在进程内存，重启丢连接。**禁止再次无保护重启**；
 *   不找/打印密钥、不擅自持久化。请记录恢复依赖、改善重启流程与缺连接反馈。」
 *
 * 破坏性在哪：**云端连接是进程内存里的状态**（`src/server/index.js:562` 从
 * `process.env.DEEPSEEK_API_KEY` 读一次，之后只活在内存里）。`pkill` 一下，
 * 页面就变成「connected=false / reason=还没有配置 API key」——**而 HTTP 仍然是 200**，
 * 所以只看 200 的人会以为一切正常（这正是 Codex 点出来的问题）。
 *
 * 所以这个脚本做三件事：
 *   1. `--status`  : 先告诉你要不要重启、重启会丢什么（会读 `/api/models`，不读任何密钥）；
 *   2. `--restart` : **连着模型时默认拒绝**，除非显式 `--force`；拒绝时说清"丢什么 + 怎么恢复"；
 *   3. 起来之后**自动跑一遍健康检查**，把"模型连不上"这件事**当场喊出来**，而不是留给人猜。
 *
 * 它**不会**：读/打印/保存任何密钥；改 `.env` 或任何配置文件；动真实游戏账号。
 *
 * 用法：
 *   node scripts/roco/serve.mjs --status
 *   node scripts/roco/serve.mjs --start
 *   node scripts/roco/serve.mjs --restart            # 连着模型时会拒绝
 *   node scripts/roco/serve.mjs --restart --force    # 明确承担"丢连接"
 */

import {spawn} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASE = process.env.ROCO_BASE || 'http://127.0.0.1:8765';
const PORT = Number(new URL(BASE).port || 8765);
const PLAYER_ID = 'own-0001';   // 用来判"是不是同一个服务"的探针实例

async function probe(path, ms = 6000) {
  try {
    const res = await fetch(`${BASE}${path}`, {signal: AbortSignal.timeout(ms)});
    return {ok: res.ok, http: res.status, headers: res.headers, json: async () => res.json()};
  } catch (error) {
    return {ok: false, http: null, error: String(error?.message || error).slice(0, 80)};
  }
}

/** 当前服务的状态：活着吗？引擎在吗？**模型连着吗**？ */
async function status() {
  const box = await probe('/box.html');
  if (!box.ok) return {up: false, why: box.error ?? `HTTP ${box.http}`};
  const models = await probe('/api/models');
  const body = models.ok ? await models.json() : {models: []};
  const list = Array.isArray(body.models) ? body.models : [];
  const cloud = list.find((m) => /cloud|deepseek/i.test(String(m?.id ?? ''))) ?? null;
  const st = await probe('/api/roco/status');
  const stBody = st.ok ? await st.json() : {};
  return {
    up: true,
    engine: stBody.available ?? null,
    cloudConnected: cloud?.connected === true,
    cloudVerified: cloud?.verified === true,
    cloudReason: cloud?.reason ?? null,
    models: list,
  };
}

function printStatus(s) {
  if (!s.up) { console.log(`[serve] 8765 上没有服务（${s.why}）`); return; }
  console.log('[serve] 8765 上已经有服务在跑：');
  console.log(`  · 引擎 available=${s.engine}`);
  console.log(`  · 云端模型：connected=${s.cloudConnected} verified=${s.cloudVerified}｜reason=${JSON.stringify(s.cloudReason)}`);
  console.log(`  · 重启会丢掉：${s.cloudConnected ? '**这台进程内存里的云端连接**（要人重新提供 key 才能恢复）' : '没有云端连接可丢（现在本来就没连上）'}`);
}

function start() {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server', 'index.js')], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });
  child.unref();
  console.log(`[serve] 已启动（pid ${child.pid}），等它就绪…`);
  return child.pid;
}

async function waitReady(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const res = await probe('/api/roco/box?kind=mine&limit=1&offset=0', 4000);
    if (res.ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function healthcheck() {
  const {spawnSync} = await import('node:child_process');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'roco', 'healthcheck.mjs')], {cwd: ROOT, stdio: 'inherit'});
  return r.status ?? 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);
  const s = await status();

  if (has('--status') || argv.length === 0) { printStatus(s); process.exit(s.up ? 0 : 1); }

  if (has('--start')) {
    if (s.up) { console.log('[serve] 已经在跑，不重复启动。'); printStatus(s); process.exit(0); }
    start();
    const ok = await waitReady();
    console.log(ok ? '[serve] 就绪。' : '[serve] ✖ 30 秒内没就绪。');
    process.exit(await healthcheck() === 0 ? 0 : (ok ? 2 : 1));
  }

  if (has('--restart')) {
    if (!s.up) {
      start();
      const ok = await waitReady();
      console.log(ok ? '[serve] 就绪。' : '[serve] ✖ 没起来。');
      process.exit(await healthcheck());
    }
    // ⚠ 核心保护：连着模型时**默认拒绝**
    if (s.cloudConnected && !has('--force')) {
      console.log('[serve] **拒绝重启**：这台服务正连着云端模型。');
      console.log('  · 重启会丢掉**进程内存里的连接**（key 只在启动时从环境变量读一次）。');
      console.log('  · 恢复只能由**人**把 key 重新提供给进程；本脚本不读、不打印、不保存任何密钥。');
      console.log('  · 确实要重启就显式加 `--force`，并准备好恢复步骤：');
      console.log('    docs/roco/review-2026-09-28/codex-healthcheck/模型连接与重启安全.md');
      process.exit(3);
    }
    console.log(s.cloudConnected ? '[serve] --force：承担丢连接，开始重启…' : '[serve] 现在没有云端连接可丢，安全重启…');
    const {spawnSync} = await import('node:child_process');
    // ⚠ 模式必须写成 `src/server/index.js`（**不带 `node ` 前缀**）：
    // 这个脚本自己是用**绝对路径**起子进程的，`pkill -f "node src/server/index.js"` 匹配不到它
    // ⇒ 下一次重启会「杀了个寂寞」，然后两个服务抢同一个端口（实测踩到）。
    spawnSync('/usr/bin/pkill', ['-f', 'src/server/index.js'], {stdio: 'ignore'});
    await new Promise((r) => setTimeout(r, 900));
    start();
    const ok = await waitReady();
    console.log(ok ? '[serve] 就绪。' : '[serve] ✖ 没起来。');
    const code = await healthcheck();
    if (code === 2) console.log('[serve] 提醒：服务是好的，但**模型没连上** —— 玩家会看到"小芽答不了"。');
    process.exit(code);
  }

  console.error('用法：--status | --start | --restart [--force]');
  process.exit(2);
}

await main();
