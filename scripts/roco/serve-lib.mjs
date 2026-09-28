/**
 * `serve.mjs` / `healthcheck.mjs` 的**纯决策逻辑**（单独一个文件，为的是能隔离测试）。
 *
 * 由来（Codex 2026-09-29 第二轮复核，逐字）：
 * 「serve.mjs 用 `pkill -f src/server/index.js`，会匹配其他项目/其他端口的同名服务。
 *   请**只停止经端口 8765 + 本仓绝对入口/工作目录核实的 PID**；目标不明确就**拒绝**，
 *   不用模糊全局 pkill，也**不要为了验证再重启主服务**。」
 * 「`/api/models` 失败或形状异常时，healthcheck 目前 warn 却最终可返回 healthy，
 *   serve 可能把**未知**误当**没连接**而放行重启；请将**连接未知设为非健康并拒绝重启**，
 *   补**隔离的拒绝路径测试**。」
 *
 * 所以这里的三个函数都是**纯的**：输入数据、输出判定。所有真实现（lsof / HTTP）都在调用方，
 * 测试里喂合成数据即可覆盖"拒绝"的每条路径 —— **不需要碰真服务，更不需要重启它**。
 */

const PINNED_PORT = 8765;

/**
 * 判定"这个回执里的云端模型到底连没连上"。
 *
 * 关键：**未知必须与"没连"分开**。原版把"取不到 / 形状不对"当 warn，
 * 于是 `serve` 会把它当成"没有连接可丢"而**放行重启** —— 这正是要堵的洞。
 *
 * @returns {{state:'connected'|'disconnected'|'unknown', cloudId:string|null, connected:boolean|null,
 *            verified:boolean|null, reason:string, why:string}}
 */
export function classifyModels(payload) {
  const unknown = (why, cloud = null) => ({
    state: 'unknown', cloudId: cloud?.id ?? null, connected: null, verified: null,
    reason: cloud?.reason ?? null, why,
  });
  if (!payload || typeof payload !== 'object') return unknown('回执不是对象');
  if (!Array.isArray(payload.models)) return unknown('回执里没有 models 数组（形状不对）');
  const cloud = payload.models.find((m) => m && /cloud|deepseek/i.test(String(m.id ?? ''))) ?? null;
  if (!cloud) return unknown('清单里找不到云端模型条目');
  // **必须是布尔**：`connected` 缺失 / 是字符串 / 是 null 都算未知 —— 不许拿真值性蒙。
  if (typeof cloud.connected !== 'boolean') return unknown('云端条目的 connected 不是布尔值', cloud);
  const state = cloud.connected ? 'connected' : 'disconnected';
  return {
    state, cloudId: cloud.id ?? null, connected: cloud.connected,
    verified: typeof cloud.verified === 'boolean' ? cloud.verified : null,
    reason: cloud.reason ?? null,
    why: cloud.connected ? '云端已连接' : '云端明确报告未连接',
  };
}

/**
 * 重启决策。**只有"明确报告没连接"才放行**；连着的、以及**任何未知**一律拒绝。
 * @returns {{allow:boolean, code:number, why:string}}
 */
export function decideRestart({cloudState, force = false}) {
  if (force) {
    return {allow: true, code: 0, why: `--force：已知 cloudState=${cloudState}，由调用者承担丢连接`};
  }
  if (cloudState === 'connected') {
    return {allow: false, code: 3, why: '这台服务正连着云端模型：重启会丢掉进程内存里的连接'};
  }
  if (cloudState === 'unknown') {
    return {allow: false, code: 3, why: '**连接状态未知**（回执取不到或形状不对）：不知道会不会丢连接，所以拒绝重启'};
  }
  if (cloudState === 'disconnected') {
    return {allow: true, code: 0, why: '云端明确报告未连接：没有连接可丢'};
  }
  return {allow: false, code: 3, why: `无法判定的 cloudState=${JSON.stringify(cloudState)}：拒绝重启`};
}

/** `lsof -nP -iTCP:8765 -sTCP:LISTEN -F pc` 的输出 → `[{pid, command}]`。 */
export function parseLsofListeners(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('p')) { cur = {pid: Number(line.slice(1)), command: null}; if (Number.isInteger(cur.pid)) out.push(cur); }
    else if (line.startsWith('c') && cur) cur.command = line.slice(1);
  }
  return out.filter((x) => Number.isInteger(x.pid));
}

/** `lsof -a -p PID -d cwd -Fn` 的输出 → 工作目录路径（取不到返回 null）。 */
export function parseLsofCwd(text) {
  for (const line of String(text ?? '').split('\n')) if (line.startsWith('n')) return line.slice(1);
  return null;
}

/**
 * 从 8765 上的监听者里挑出**我们自己的**那一个 PID。
 *
 * 三重取证，缺一不可（因为这台机器上 `ps` 不可用，拿不到完整命令行，所以用 cwd 代替）：
 *   ① 端口就是 8765（查的时候就按它查的）；
 *   ② **工作目录 == 本仓根**；
 *   ③ 调用方另外再做一次 **HTTP 身份探测**（见 serve.mjs 的 identifyHttp）。
 *
 * 任何一条不满足、或者**有多个候选**、或者压根查不到 ⇒ **拒绝**（`ok:false`），绝不模糊地杀。
 * @returns {{ok:boolean, pid:number|null, reason:string}}
 */
export function selectTargets({listeners, repoRoot, port = PINNED_PORT}) {
  const rows = Array.isArray(listeners) ? listeners.filter((x) => Number.isInteger(x?.pid)) : [];
  if (port !== PINNED_PORT) return {ok: false, pid: null, reason: `端口不是 ${PINNED_PORT}（${port}）：本脚本只管这一个端口`};
  if (!rows.length) return {ok: false, pid: null, reason: `没有查到任何进程在监听 ${PINNED_PORT}（查不到 ≠ 可以乱杀）`};
  if (rows.length > 1) return {ok: false, pid: null, reason: `${PINNED_PORT} 上有 ${rows.length} 个监听者（${rows.map((r) => r.pid).join(',')}）：目标不明确，拒绝`};
  const only = rows[0];
  if (!only.cwd) return {ok: false, pid: null, reason: `拿不到 pid ${only.pid} 的工作目录：无法确认是不是本仓，拒绝`};
  if (only.cwd !== repoRoot) return {ok: false, pid: null, reason: `pid ${only.pid} 的工作目录是 ${only.cwd}，不是本仓 ${repoRoot}：拒绝`};
  return {ok: true, pid: only.pid, reason: `pid ${only.pid}：端口 ${PINNED_PORT} + 工作目录 == 本仓`};
}
