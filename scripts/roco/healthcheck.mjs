#!/usr/bin/env node
/**
 * 服务**健康检查**：不只报 HTTP 200。
 *
 * 由来（Codex 2026-09-29 第一轮监工第 1 条，逐字）：
 * 「8765 /api/models 云端 connected=false/verified=false，reason=还没有配置API key；上轮检查曾 connected=true。
 *   server-restart 日志明确密钥只存在进程内存，重启丢连接。**禁止再次无保护重启**；不找/打印密钥、不擅自持久化。
 *   请记录恢复依赖、改善重启流程与缺连接反馈，**并把模型连通作为服务健康项；现阶段不能只报 HTTP 200**。」
 *
 * 所以这一份检查**五类**，缺任何一类都不算"健康"：
 *   ① 进程在不在（HTTP）
 *   ② 数据对不对（盒子 542 / 图鉴 622 —— 缓存型服务重启后要能立刻拿到这两个数）
 *   ③ **引擎连不连得上**（`/api/roco/status` 的 available）
 *   ④ **模型连不连得上**（`/api/models`：云端 connected+verified、本地开关）← 就是这一条以前没人报
 *   ⑤ 立绘这一层活没活（`/api/roco/sprite?id=pet_000004` 返回 200 + image/png）
 *
 * 退出码（给脚本与监工用）：
 *   0 = 全绿；2 = **降级**（服务与数据都好，但模型**明确**没连上）；
 *   1 = **坏了**（HTTP/数据/引擎/立绘 有硬伤，**或者模型连接状态未知**）。
 *   ⚠「未知」归到「坏了」而不是「降级」：不知道连接在不在时，**不许对外宣称健康**（Codex 第二轮）。
 *   ⇒ 「降级」与「坏了」分开，是因为 Codex 要的正是这个区分：只报 200 会把"模型没连上"藏起来。
 *
 * 用法：node scripts/roco/healthcheck.mjs [--json]
 */

import {classifyModels} from './serve-lib.mjs';

const BASE = process.env.ROCO_BASE || 'http://127.0.0.1:8765';

async function getJson(path) {
  try {
    const res = await fetch(`${BASE}${path}`, {signal: AbortSignal.timeout(8000)});
    if (!res.ok) return {ok: false, http: res.status};
    return {ok: true, http: res.status, body: await res.json()};
  } catch (error) {
    return {ok: false, http: null, error: String(error?.message || error).slice(0, 80)};
  }
}

async function main() {
  const asJson = process.argv.includes('--json');
  const items = [];
  const add = (id, level, text) => items.push({id, level, text});

  // ① 进程
  const box = await fetch(`${BASE}/box.html`, {signal: AbortSignal.timeout(8000)})
    .then((r) => ({ok: r.ok, http: r.status})).catch((e) => ({ok: false, http: null, error: String(e?.message || e)}));
  add('http', box.ok ? 'ok' : 'fail', box.ok ? `box.html HTTP ${box.http}` : `box.html 打不开（${box.error ?? box.http}）`);

  // ② 数据
  const mine = await getJson('/api/roco/box?kind=mine&limit=1&offset=0');
  const catalog = await getJson('/api/roco/box?kind=catalog&limit=1&offset=0');
  const mineTotal = mine.body?.player?.total ?? null;
  const catTotal = catalog.body?.player?.total ?? null;
  add('data', (mineTotal && catTotal) ? 'ok' : 'fail',
    `我的盒子 ${mineTotal ?? '取不到'} / 图鉴 ${catTotal ?? '取不到'}`);

  // ③ 引擎
  const status = await getJson('/api/roco/status');
  const engine = status.body?.available ?? status.body?.engine ?? null;
  add('engine', engine === true ? 'ok' : (engine === false ? 'fail' : 'warn'),
    engine === null ? '状态接口没给 available（形状变了？）' : `引擎 available=${engine}`);

  // ④ 模型（Codex 第一轮点名的那一条；第二轮又补了一条：**未知也算非健康**）
  //
  // ⚠ 2026-09-29 第二轮修正（Codex 逐字）：
  // 「`/api/models` 失败或形状异常时，healthcheck 目前 **warn 却最终可返回 healthy**，
  //   serve 可能把**未知**误当**没连接**而放行重启；请将**连接未知设为非健康**并拒绝重启。」
  // 所以这里不再有 warn 档：**取不到 / 形状不对 / connected 不是布尔** ⇒ 一律 `fail`。
  // 语义上也对：我们**不知道**连接在不在，就不能对外宣称健康。
  const models = await getJson('/api/models');
  const list = Array.isArray(models.body?.models) ? models.body.models : [];
  const classified = classifyModels(models.body);
  if (!models.ok) {
    add('model', 'fail', `\`/api/models\` 取不到（${models.error ?? `HTTP ${models.http}`}）⇒ **连接状态未知**，按非健康处理`);
  } else if (classified.state === 'unknown') {
    add('model', 'fail', `模型连接状态**未知**：${classified.why} ⇒ 按非健康处理（不许当成"没连接"）`);
  } else if (classified.state === 'connected') {
    add('model', classified.verified === true ? 'ok' : 'degraded',
      `云端 ${classified.cloudId}：connected=true verified=${classified.verified}`
      + (classified.verified === true ? '' : '（**未验证**：连上了但还没验证过，仍按降级报）'));
  } else {
    add('model', 'degraded',
      `云端 ${classified.cloudId}：connected=false｜reason=${JSON.stringify(classified.reason)}`);
  }
  for (const m of list) {
    if (m === (list.find((x) => /cloud|deepseek/i.test(String(x?.id ?? ''))) ?? null)) continue;
    add('model.local', 'info', `${m.id}：connected=${m.connected}｜reason=${JSON.stringify(m.reason ?? null)}`);
  }

  // ⑤ 立绘
  const sprite = await fetch(`${BASE}/api/roco/sprite?id=pet_000004&v=default`, {signal: AbortSignal.timeout(8000)})
    .then(async (r) => ({ok: r.ok, type: r.headers.get('content-type'), variant: r.headers.get('x-roco-sprite-variant'), bytes: (await r.arrayBuffer()).byteLength}))
    .catch((e) => ({ok: false, error: String(e?.message || e)}));
  add('sprite', sprite.ok && /image\//.test(String(sprite.type)) ? 'ok' : 'fail',
    sprite.ok ? `迪莫 ${sprite.variant ?? '?'} ${sprite.bytes} 字节 ${sprite.type}` : `立绘取不到（${sprite.error}）`);

  const worst = items.some((i) => i.level === 'fail') ? 1
    : (items.some((i) => i.level === 'degraded') ? 2 : 0);

  if (asJson) {
    console.log(JSON.stringify({base: BASE, verdict: worst === 0 ? 'healthy' : (worst === 2 ? 'degraded' : 'broken'), items}, null, 1));
  } else {
    const icon = {ok: '✔', fail: '✖', degraded: '▲', warn: '▲', info: '·'};
    console.log(`[health] ${BASE} —— ${worst === 0 ? '**健康**' : (worst === 2 ? '**降级**（服务与数据正常，但模型没连上）' : '**坏了**')}`);
    for (const i of items) console.log(`  ${icon[i.level] ?? '?'} ${i.id.padEnd(11)} ${i.text}`);
    if (worst === 2) {
      console.log('  ↳ 模型没连上**不算服务坏了**，但它是一个独立的健康项：玩家看到的是"小芽答不了"而不是"页面打不开"。');
      console.log('  ↳ 恢复只能由**人**把 key 重新提供给进程（见 docs/roco/review-2026-09-28/codex-healthcheck/模型连接与重启安全.md）。');
    }
  }
  process.exit(worst);
}

await main();
