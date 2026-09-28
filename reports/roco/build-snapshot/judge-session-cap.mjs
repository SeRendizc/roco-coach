#!/usr/bin/env node
// task-15：会话层的**容量判据 + 必红反证**（真机等价：跑的是真 `createCoachServer`，独立端口/独立内存）。
//
// 为什么不量 8765：主服务现在**已经**满过（`/api/bootstrap` → 429），而且不许重启。
// 所以这里起**独立实例**，读的是同一份实现 —— 与 `tmp/BROWSER-LOCK.md` 那条"验收一律走独立实例"一致。
//
// 判据（纯函数 `sessionCapProblems`，喂坏数据必须报）：
//   ① 连建 100 个会话：全部 200（这一步在改之前也是绿的 —— 它不是判据的重点）；
//   ② 第 101 个**仍然拿到会话**（200 + 新 cookie），而且**能带着它 POST 成功**（CSRF 通）；
//   ③ **刚用过的会话不被打断**（第 1 个 touch 一下之后仍然 200）；
//   ④ 被淘汰的是**最久没用过**的那一个 ⇒ 它下一次请求得到的是 **403「会话已失效」**，
//      不是 429、也不是静默失败（"两种形状不许混"的机器保证）；
//   ⑤ **上限仍然存在**：一共 121 个 cookie，逐个数活着的 ⇒ 必须**恰好 100**。
//
// 必红反证：把 `reclaimSessions(now,1)` 那一句**摘掉**（等于回到今天的实现）再跑同一套判据，
// 判据②必须红。做法是把源码复制到 `tmp/` 下的一个镜像（`src/coach`、`src/game` 用符号链接），
// 只改那一处 —— **不动仓库里的源文件**。
//
// 用法：`node reports/roco/build-snapshot/judge-session-cap.mjs`
// 产物：`reports/roco/build-snapshot/session-cap.json`

import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createCoachServer} from '../../../src/server/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/build-snapshot$/, '');
const OUT = join(ROOT, 'reports/roco/build-snapshot');
const SERVER_SRC = join(ROOT, 'src/server/index.js');
const CAP = 100;
const log = (...a) => console.log('[session-cap]', ...a);

async function start(modulePath = null) {
  const mod = modulePath ? await import(pathToFileURL(modulePath).href) : {createCoachServer};
  const server = mod.createCoachServer({semantic: false,
    fetchImpl: async () => { throw new Error('量测环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {base, close: () => { server.closeAllConnections?.(); server.close(); }};
}

const bootstrap = async (base, cookie = null) => {
  const res = await fetch(`${base}/api/bootstrap`, {headers: cookie ? {Cookie: cookie} : {}});
  let body = null;
  try { body = await res.json(); } catch { /* 空体 */ }
  const setCookie = res.headers.get('set-cookie');
  return {status: res.status, body, cookie: setCookie ? setCookie.split(';')[0] : null};
};

/** 一次"这个会话还活着吗"的探测：`/api/disconnect` 是**不需要会话以外任何东西**的 POST ⇒ 200 活着 / 403 没了。 */
const alive = async (base, cookie, csrf) => {
  const res = await fetch(`${base}/api/disconnect`, {method: 'POST',
    headers: {Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': csrf},
    body: '{}'});
  return res.status;
};

/**
 * **判据（纯函数）**：喂一份"跑完之后的读数"进去，返回问题清单。
 * 浏览器/单元判据都调它 —— 改钉一处，两边一起动。
 */
export function sessionCapProblems(facts = {}) {
  const problems = [];
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  if (n(facts.created100?.ok) !== CAP) {
    problems.push(`连建 ${CAP} 个会话应当全部成功，实际成功 ${facts.created100?.ok} 个`);
  }
  if (n(facts.session101?.status) !== 200 || !facts.session101?.gotCookie) {
    problems.push(`第 ${CAP + 1} 个新会话必须仍能拿到会话（200 + 新 cookie），`
      + `实际 HTTP ${facts.session101?.status}${facts.session101?.gotCookie ? '' : '、没有 Set-Cookie'}`
      + `（429 = 表满且没有出口 —— 只能重启，那是 task-15 要修的缺陷）`);
  }
  if (n(facts.session101?.postStatus) !== 200) {
    problems.push(`第 ${CAP + 1} 个会话拿到了却用不了（POST 应当 200，实际 ${facts.session101?.postStatus}）`);
  }
  if (n(facts.hotSession?.status) !== 200 || facts.hotSession?.gotCookie === true) {
    problems.push(`刚用过的会话被打断了（bootstrap 应当 200 **且不发新 cookie**，实际 HTTP `
      + `${facts.hotSession?.status}${facts.hotSession?.gotCookie ? '、发了一个新 cookie（说明旧的那条已经不在表里）' : ''}）`
      + ` —— 淘汰只能淘汰**最久没用过**的那一个`);
  }
  if (n(facts.hotSession?.postStatus) !== 200) {
    problems.push(`刚用过的会话 POST 不通（应当 200，实际 ${facts.hotSession?.postStatus}）`);
  }
  if (n(facts.evictedSession?.status) !== 403) {
    problems.push(`被淘汰的那一个下一次请求应当是 **403「会话已失效」**（可分辨、可刷新恢复），`
      + `实际 ${facts.evictedSession?.status}`);
  }
  if (n(facts.liveCount) !== CAP) {
    problems.push(`上限必须仍然存在：活着的会话应当**恰好 ${CAP}** 个，实际 ${facts.liveCount} 个`);
  }
  return problems;
}

/** 跑一遍完整序列，返回**事实**（判据再拿它判 —— 事实与判据分开，反证才喂得进去）。 */
async function runSequence({base, total = 121}) {
  const facts = {};
  const created = [];
  for (let i = 0; i < CAP; i += 1) {
    const one = await bootstrap(base);
    if (one.status !== 200) break;
    created.push({i: i + 1, cookie: one.cookie, csrf: one.body?.csrf ?? null});
  }
  facts.created100 = {ok: created.length, first: created[0]?.i, last: created[created.length - 1]?.i};
  // ② **先 touch 第 1 个**：它刚刚被用过 ⇒ 从此**最久没用过的是第 2 个**。
  //    ⚠ 顺序很要紧：先 touch 再建新的，才能证明"淘汰的是最久没用过的"而不是"淘汰建得最早的"。
  const hot = await bootstrap(base, created[0]?.cookie);
  facts.hotSession = {status: hot.status, gotCookie: Boolean(hot.cookie), i: 1,
    // 同一会话 ⇒ 回执里的 csrf 不变（`/api/bootstrap` 每次都重画 nonce，但 csrf 只在新建时给）
    sameCsrf: hot.body?.csrf === created[0]?.csrf,
    postStatus: hot.body?.csrf ? await alive(base, created[0].cookie, hot.body.csrf) : null};
  // ③ 第 101 个：应当**仍然拿到会话**
  const over = await bootstrap(base);
  facts.session101 = {status: over.status, gotCookie: Boolean(over.cookie),
    postStatus: over.cookie ? await alive(base, over.cookie, over.body?.csrf) : null};
  // ⚠ 第 101 个也要**记进 created**（第一版漏了，于是后面"数活着的"少数了它 ⇒ 99 而不是 100）。
  if (over.cookie) created.push({i: CAP + 1, cookie: over.cookie, csrf: over.body?.csrf ?? null});
  // ④ 最久没用过的那一个 = 第 2 个（建完就再没回来过）⇒ 它被淘汰了，下一次请求应当 403
  facts.evictedSession = {i: 2, status: await alive(base, created[1]?.cookie, created[1]?.csrf)};
  // ⑤ 再把表推满一轮，然后**逐个点一遍**数活着的（上限是否仍然存在）
  while (created.length < total) {
    const one = await bootstrap(base);
    if (one.status !== 200) break;
    created.push({i: created.length + 1, cookie: one.cookie, csrf: one.body?.csrf ?? null});
  }
  let live = 0;
  const dead = [];
  for (const one of created) {
    const status = await alive(base, one.cookie, one.csrf);
    if (status === 200) live += 1; else dead.push({i: one.i, status});
  }
  facts.liveCount = live;
  facts.totalCookies = created.length;
  facts.distinctCookies = new Set(created.map((one) => one.cookie)).size;
  // 排障用：死掉的是哪几个（判据只数个数，这里给"淘汰的是不是最久没用过的"留证据）
  facts.deadIndices = dead.map((row) => row.i);
  facts.deadStatuses = [...new Set(dead.map((row) => row.status))];
  return facts;
}

/** 把源码复制到 `tmp/` 的镜像里，并把 `reclaimSessions(now,1);` 那一句摘掉（= 回到今天的实现）。 */
function mirrorWithoutReclaim() {
  const dir = mkdtempSync(join(tmpdir(), 'roco-session-mirror-'));
  mkdirSync(join(dir, 'src/server'), {recursive: true});
  for (const sub of ['coach', 'game']) symlinkSync(join(ROOT, 'src', sub), join(dir, 'src', sub), 'dir');
  for (const file of ['token-budget-server.js', 'semantic-server.js', 'opponent.js', 'roco-service.js']) {
    symlinkSync(join(ROOT, 'src/server', file), join(dir, 'src/server', file), 'file');
  }
  const source = readFileSync(SERVER_SRC, 'utf8');
  const withoutReclaim = source.replace('     reclaimSessions(now,1);',
    '     /* 必红反证：这一句被摘掉了 */');
  // 同时把不变量守卫换回**旧的那句 429** —— 这样镜像 = "task-15 之前的实现"，误差为零。
  const patched = withoutReclaim.replace(
    /if\(sessions\.size>=SESSION_CAP\)throw fail\(500,[^;]*;/,
    "if(sessions.size>=SESSION_CAP)throw fail(429,'本机会话过多，请重启服务');");
  if (patched === source) throw new Error('反证镜像没改到那一句（源码形状变了？）');
  if (!/fail\(429,'本机会话过多，请重启服务'\)/.test(patched)) {
    throw new Error('反证镜像没有换回旧的那句 429（不变量守卫那一行的形状变了？）');
  }
  writeFileSync(join(dir, 'src/server/index.js'), patched);
  return {dir, modulePath: join(dir, 'src/server/index.js'),
    cleanup: () => rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 120})};
}

async function main() {
  mkdirSync(OUT, {recursive: true});
  const source = readFileSync(SERVER_SRC, 'utf8');
  const lineOf = (needle) => source.split('\n').findIndex((l) => l.includes(needle)) + 1;
  const report = {generated: new Date().toISOString(),
    command: 'node reports/roco/build-snapshot/judge-session-cap.mjs',
    source_evidence: {
      store: {line: lineOf('const sessions=new Map()')},
      cap: {line: lineOf('const SESSION_CAP=100')},
      ttl: {line: lineOf('const SESSION_TTL_MS=8*3600000')},
      touch: {line: lineOf('const touchSession=')},
      reclaim: {line: lineOf('const reclaimSessions=')},
      bootstrap_miss: {line: lineOf('reclaimSessions(now,1);')},
      consumer_csrf: {line: lineOf("if(!s||s.expires<Date.now()||!equal(req.headers['x-coach-csrf'],s.csrf))")},
      clear_on_close: {line: lineOf("server.on('close',()=>{retriever?.close();credential='';sessions.clear()")},
    }};

  // ── 正向：真实现 ─────────────────────────────────────────────────────────
  const real = await start();
  try { report.facts = await runSequence({base: real.base}); } finally { real.close(); }
  report.problems = sessionCapProblems(report.facts);

  // ── 必红反证：摘掉淘汰那一句 ──────────────────────────────────────────────
  const mirror = mirrorWithoutReclaim();
  try {
    const broken = await start(mirror.modulePath);
    try { report.counterproof_facts = await runSequence({base: broken.base}); } finally { broken.close(); }
  } finally { mirror.cleanup(); }
  report.counterproof_problems = sessionCapProblems(report.counterproof_facts);

  writeFileSync(join(OUT, 'session-cap.json'), `${JSON.stringify(report, null, 1)}\n`);
  log(`源码出处：会话表 :${report.source_evidence.store.line} · 上限 :${report.source_evidence.cap.line}`
    + ` · TTL :${report.source_evidence.ttl.line} · touch :${report.source_evidence.touch.line}`
    + ` · 回收 :${report.source_evidence.reclaim.line} · 建会话口 :${report.source_evidence.bootstrap_miss.line}`
    + ` · CSRF 消费点 :${report.source_evidence.consumer_csrf.line}`);
  log(`① 连建 100 个：成功 ${report.facts.created100.ok}`);
  log(`② 第 101 个：HTTP ${report.facts.session101.status}，拿到 cookie=${report.facts.session101.gotCookie}，`
    + `带它 POST=${report.facts.session101.postStatus}`);
  log(`③ 刚用过的那一个：HTTP ${report.facts.hotSession.status}`);
  log(`④ 最久没用过的那一个：HTTP ${report.facts.evictedSession.status}（期望 403）`);
  log(`⑤ 推满 ${report.facts.totalCookies} 个之后数活着的：${report.facts.liveCount} 个（上限 ${CAP}）`);
  log(`${report.problems.length ? 'RED ' : 'GREEN'} 正向判据：${report.problems.length ? report.problems.join(' | ') : '4 条全过'}`);
  log(`${report.counterproof_problems.length ? 'GREEN' : 'RED '} 必红反证（摘掉 reclaimSessions）：`
    + `${report.counterproof_problems.length ? `按预期报出 → ${report.counterproof_problems[0]}` : '**没报** —— 判据是空的！'}`);
  log('报告：reports/roco/build-snapshot/session-cap.json');
  if (report.problems.length || !report.counterproof_problems.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('[session-cap] 失败：', error); process.exit(1); });
}
