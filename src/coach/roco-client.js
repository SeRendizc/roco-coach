// Node ↔ Python 规则服务桥（教练侧唯一允许触达真实规则引擎的适配器）
//
// 为什么要有这一层：手游规则的**唯一来源**是 `roco/src/roco_env/**`（Python）。
// Node 侧不许再实现一套数值或机制。所有事实都必须经过这里，并带上出处。
//
// 五条纪律（与实施书一致）：
//
// 1. **只用 node:child_process / node:http / node:fs。** 没有 npm 依赖，
//    也没有 node:path / node:url —— 路径用字符串拼、URL 用全局 `URL`。
// 2. **每个调用都带 `ruleset_id` + `state_version`；每个回执都返回
//    `ruleset_id` / `state_version` / `coverage` / `evidence_ids` / `latency_ms` / `error_type`。**
//    回执缺任一字段视为协议违规（`protocol_error`），不猜。
// 3. **四类失败必须可区分**：服务超时、规则集不支持、版本不一致、机制不支持。
//    用 `result.code` 看细节，用 `result.failure_class` 看四大类：
//    `service` / `ruleset` / `version` / `unsupported`。
// 4. **不读隐藏信息**：请求里出现对手待执行动作、真实随机种子等键一律**拒绝发送**；
//    回执里出现同类键一律判协议违规，且**不把泄漏内容透传出去**（MC-013）。
// 5. **fail closed**：引擎说「不支持」，这里就回 `unsupported`，
//    **绝不**替它补一个默认威力/默认伤害。返回对象里不会有编造的数值。
//
// 返回约定：所有**请求方法**都返回同一个形状的结果对象，不抛异常：
//
//     {
//       ok: boolean,                 // 引擎真的答了（不是「答不了」）
//       code: string|null,           // ROCO_ERROR 之一；ok 为 true 时是 null
//       failure_class: string|null,  // service / ruleset / version / unsupported / request / protocol
//       message: string|null,
//       ruleset_id, state_version, coverage, evidence_ids, latency_ms, service_latency_ms,
//       error_type, unsupported, result, snapshot_fingerprint, http_status
//     }
//
// 为什么用返回值而不是抛异常：工具层（模型可调用的 5 个工具）需要把
// 「不支持」当成**正常答案**交给上层去解释给玩家，而不是让异常穿到工具调度里。
// 想要异常语义的调用方用 `assertOk(result)`。
//
// 生命周期方法（`startService` / `stopService`）是例外：它们的失败是环境问题，
// 直接抛 `RocoError`。

import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';

/** 本适配器编译时钉住的规则集版本。请求别的版本一定会拿到 version_mismatch。 */
export const RULESET_ID = 'roco-world-s4-2026-09-10';
/** 与 `roco_env/service.py` 的 PROTOCOL_VERSION 对齐。 */
export const PROTOCOL_VERSION = 1;

/** 客户端错误码。前四个就是任务要求的四类失败，其余是请求层/协议层的补充。 */
export const ROCO_ERROR = Object.freeze({
  TIMEOUT: 'timeout',                          // ① 服务超时
  RULESET_UNSUPPORTED: 'ruleset_unsupported',  // ② 规则集不支持
  VERSION_MISMATCH: 'version_mismatch',        // ③ 版本不一致
  UNSUPPORTED_EFFECT: 'unsupported_effect',    // ④ 机制不支持（fail closed）
  NOT_IMPLEMENTED: 'not_implemented',          // ④ 的兄弟：端点对应的引擎逻辑还没写
  UNAVAILABLE: 'unavailable',                  // 连不上 / 起不来
  BAD_REQUEST: 'bad_request',
  NOT_FOUND: 'not_found',
  HIDDEN_INFORMATION: 'hidden_information',
  INTERNAL_ERROR: 'internal_error',
  PROTOCOL_ERROR: 'protocol_error',
});

/** 四大类失败（外加 request / protocol 两个调用方自身的错误类）。 */
export const ROCO_FAILURE_CLASS = Object.freeze({
  SERVICE: 'service',
  RULESET: 'ruleset',
  VERSION: 'version',
  UNSUPPORTED: 'unsupported',
  REQUEST: 'request',
  PROTOCOL: 'protocol',
});

const FAILURE_CLASS = Object.freeze({
  [ROCO_ERROR.TIMEOUT]: ROCO_FAILURE_CLASS.SERVICE,
  [ROCO_ERROR.UNAVAILABLE]: ROCO_FAILURE_CLASS.SERVICE,
  [ROCO_ERROR.INTERNAL_ERROR]: ROCO_FAILURE_CLASS.SERVICE,
  [ROCO_ERROR.RULESET_UNSUPPORTED]: ROCO_FAILURE_CLASS.RULESET,
  [ROCO_ERROR.VERSION_MISMATCH]: ROCO_FAILURE_CLASS.VERSION,
  [ROCO_ERROR.UNSUPPORTED_EFFECT]: ROCO_FAILURE_CLASS.UNSUPPORTED,
  [ROCO_ERROR.NOT_IMPLEMENTED]: ROCO_FAILURE_CLASS.UNSUPPORTED,
  [ROCO_ERROR.BAD_REQUEST]: ROCO_FAILURE_CLASS.REQUEST,
  [ROCO_ERROR.NOT_FOUND]: ROCO_FAILURE_CLASS.REQUEST,
  [ROCO_ERROR.HIDDEN_INFORMATION]: ROCO_FAILURE_CLASS.REQUEST,
  [ROCO_ERROR.PROTOCOL_ERROR]: ROCO_FAILURE_CLASS.PROTOCOL,
});

/** 回执必须带齐的契约字段（`error_type` 可以为 null，但必须**存在**）。 */
export const CONTRACT_FIELDS = Object.freeze([
  'ruleset_id',
  'state_version',
  'coverage',
  'evidence_ids',
  'latency_ms',
  'error_type',
]);

// 契约字段之外，这些顶层键已被单独取出；**其余顶层键属于端点专有字段**，
// 会被 _normalize 透传给调用方。
// 为什么要透传：服务端 `_envelope(**extra)` 把 extra 展开到顶层，里面可能有
// 关键信息——最典型的是阵容评估的 `limitations` 与 `calibration`，
// 它们说明这个结果**不声称**什么（例如不声称胜率）。
// 只列固定契约字段、把其余丢掉，等于把「我们不知道什么」一起丢了。
const KNOWN_TOP_LEVEL = new Set(['ok', 'error']);

/** 给「还没来得及发请求就失败」的路径一个耗时读数（0 是可接受的）。 */
function elapsedSince(options) {
  return typeof options?.startedAt === 'number' ? Date.now() - options.startedAt : 0;
}

/** 隐藏信息键（归一化后比较）：对手待执行动作、真实随机种子、私有状态。依据 MC-013。 */
export const HIDDEN_KEYS = Object.freeze([
  'opponentaction',
  'opponentpendingaction',
  'opponentchoice',
  'opponentselection',
  'pendingaction',
  'hiddenaction',
  'hiddenstate',
  'privatestate',
  'opponentprivatestate',
  'trueseed',
  'rngseed',
  'randomseed',
  'seed',
  // env/schema 真正会序列化出来的内部字段（归一化后比较，下划线会被去掉）。
  // 少了这几个，私有 `serialize()` 就能从桥本地穿过去、只靠服务端兜底——
  // MC-013 要求两层都拦，而桥是第一层。这几个键是与
  // roco/src/roco_env/service.py 的 HIDDEN_KEYS 一一对应的。
  'pendingenemy',
  'pendingplayer',
  'pendingenemyaction',
  'pendingplayeraction',
  // 换人队列：它说明「谁被迫换人」，是待执行状态，不是公开观察。
  'replacequeue',
]);

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_START_TIMEOUT_MS = 20000;
const DEFAULT_STOP_GRACE_MS = 3000;

// ── 错误类型 ────────────────────────────────────────────────────────────

export class RocoError extends Error {
  constructor(code, message, { details = null, response = null, httpStatus = null, cause = null } = {}) {
    super(message);
    this.name = 'RocoError';
    this.code = code;
    this.failureClass = FAILURE_CLASS[code] || 'unknown';
    this.errorType = (response && response.error_type) || null;
    this.details = details;
    this.response = response;
    this.httpStatus = httpStatus;
    this.cause = cause;
  }

  /** 只有服务类失败值得原样重试；不支持/版本不一致重试没有意义。 */
  get retriable() {
    return (
      this.code === ROCO_ERROR.TIMEOUT ||
      this.code === ROCO_ERROR.UNAVAILABLE ||
      this.code === ROCO_ERROR.INTERNAL_ERROR
    );
  }
}

export const isTimeout = (r) => codeOf(r) === ROCO_ERROR.TIMEOUT;
export const isRulesetUnsupported = (r) => codeOf(r) === ROCO_ERROR.RULESET_UNSUPPORTED;
export const isVersionMismatch = (r) => codeOf(r) === ROCO_ERROR.VERSION_MISMATCH;
export const isUnsupportedEffect = (r) => codeOf(r) === ROCO_ERROR.UNSUPPORTED_EFFECT;
export const isNotImplemented = (r) => codeOf(r) === ROCO_ERROR.NOT_IMPLEMENTED;
export const isUnsupported = (r) =>
  codeOf(r) === ROCO_ERROR.UNSUPPORTED_EFFECT || codeOf(r) === ROCO_ERROR.NOT_IMPLEMENTED;
export const isOk = (r) => Boolean(r && r.ok === true);
export const failureClassOf = (r) => (r && r.failure_class) || null;

function codeOf(result) {
  if (result instanceof RocoError) return result.code;
  return (result && result.code) || null;
}

/**
 * 把「不 ok 的结果对象」变成异常。想要异常语义的调用方用这个。
 * 注意：它**不会**把隐藏信息内容带进异常（那部分在客户端就被丢掉了）。
 */
export function assertOk(result, label = '规则服务调用') {
  if (isOk(result)) return result;
  const code = codeOf(result) || ROCO_ERROR.INTERNAL_ERROR;
  throw new RocoError(code, `${label}失败：${(result && result.message) || '未知原因'}`, {
    details: (result && result.details) || null,
    response: result,
    httpStatus: (result && result.http_status) || null,
  });
}

// ── 隐藏信息扫描 ────────────────────────────────────────────────────────

const HIDDEN_KEYSET = new Set(HIDDEN_KEYS);

/**
 * **本地对局域**端点：它们按设计就携带私有状态（含真实 seed）。
 *
 * 服务端在这条路径上显式声明 `trust_domain: "local_sim"`，并且回执里的私有状态
 * 只允许留在本机 Node 内存里，绝不返回浏览器。所以桥的本地守卫对这几个路径
 * 不做隐藏信息扫描 —— 否则对局域连开一局都做不到。
 *
 * 这是一份**白名单**，不是「按名字猜」：只有这里逐条列出的路径会被跳过。
 * 教练域的路径（`/battle/plan`、`/rules/query`、`/team/*`）永远在扫描范围内。
 * 新增一个会带私有状态的端点，必须同时改这里和 `roco-service.js`，
 * 并由 `tests/evals/roco/bridge.test.js` 的「两个域互不串门」钉住。
 */
const PRIVATE_PLANE_PATHS = new Set(['/battle/new', '/battle/legal', '/battle/advance']);

export {HIDDEN_KEYSET, PRIVATE_PLANE_PATHS};

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * 允许以**纯标记字段**出现的键名：它们不是「携带隐藏信息」，而是在说
 * 「这一项讲的是对手的某个动作」。
 *
 * 为什么需要这一条：风险分支（W3-04）的回执里有
 * `risk.worst_seed_risks[].opponent_action`，值是像「诡刺」这样的**动作名字串**。
 * 按名字扫会把它判成协议违规，于是 `/battle/plan` 的正常回执被整份丢掉——
 * 这是我在加风险分支时撞出来的真实误报。
 *
 * 纪律：白名单**只按路径的最后一段**匹配，而且这些名字必须出现在
 * `VALUE_MARKER_PARENTS` 列出的父路径下（`risk` / `top_risks` / `per_seed` 等
 * **分析结果**字段）。`state.opponent_action` 这种**状态字段**照样会被拦。
 */
const VALUE_MARKER_KEYS = new Set(['opponentaction', 'opponentchoice', 'opponentselection']);
const VALUE_MARKER_PARENTS = new Set(['risk', 'toprisks', 'worstseedrisks', 'perseed', 'branches']);

/**
 * 递归找出隐藏信息键，返回可读路径（如 `state.opponent_action`）。
 * 有深度上限与环保护：调用方传进来一个有环对象也不会把桥挂死。
 */
export function findHiddenKeys(payload, { prefix = '', depth = 0, seen = new WeakSet() } = {}) {
  const hits = [];
  if (depth > 12 || payload === null || typeof payload !== 'object') return hits;
  if (seen.has(payload)) return hits;
  seen.add(payload);
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => hits.push(...findHiddenKeys(item, { prefix: `${prefix}[${i}]`, depth: depth + 1, seen })));
    return hits;
  }
  // 父路径的最后一段（跳过数组下标），用来判断「这个键名是在说标记还是携带状态」。
  // 取父路径的最后一段：`risk.worst_seed_risks[0]` → `worstseedrisks`。
  // 先把数组下标后缀去掉再归一化，否则会得到 `worstseedrisks0` 而匹配不上。
  const parentSegment = (prefix.split('.').filter(Boolean).pop() ?? '').replace(/\[\d+\]$/g, '');
  const underMarkerParent = VALUE_MARKER_PARENTS.has(normalizeKey(parentSegment));
  for (const [key, value] of Object.entries(payload)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const normalized = normalizeKey(key);
    // 纯标记字段（值必须是字符串）且在分析结果下 → 放行；其余照旧拦。
    const isMarker = underMarkerParent && VALUE_MARKER_KEYS.has(normalized) && typeof value === 'string';
    if (HIDDEN_KEYSET.has(normalized) && !isMarker) hits.push(path);
    hits.push(...findHiddenKeys(value, { prefix: path, depth: depth + 1, seen }));
  }
  return hits;
}

// ── 小工具 ──────────────────────────────────────────────────────────────

const round3 = (n) => Math.round(n * 1000) / 1000;

function stripTrailingSlash(text) {
  return String(text).replace(/\/+$/, '');
}

function mapServerErrorType(errorType, coverage) {
  switch (errorType) {
    case 'ruleset_unsupported':
      return ROCO_ERROR.RULESET_UNSUPPORTED;
    case 'version_mismatch':
      return ROCO_ERROR.VERSION_MISMATCH;
    case 'unsupported_effect':
      return ROCO_ERROR.UNSUPPORTED_EFFECT;
    case 'not_implemented':
      return ROCO_ERROR.NOT_IMPLEMENTED;
    case 'bad_request':
      return ROCO_ERROR.BAD_REQUEST;
    case 'not_found':
      return ROCO_ERROR.NOT_FOUND;
    case 'hidden_information':
      return ROCO_ERROR.HIDDEN_INFORMATION;
    case 'internal_error':
      return ROCO_ERROR.INTERNAL_ERROR;
    default:
      // 协议兜底：引擎说 coverage = 0 又没给 error_type，按「不支持」处理（fail closed）
      return coverage === 0 ? ROCO_ERROR.UNSUPPORTED_EFFECT : ROCO_ERROR.INTERNAL_ERROR;
  }
}

// ── 客户端 ──────────────────────────────────────────────────────────────

export class RocoClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]      已有服务的地址（连已运行的服务时用）
   * @param {string} [options.rulesetId]    本适配器钉住的规则集版本
   * @param {string} [options.repoRoot]     仓库根；默认 `$ROCO_REPO_ROOT` 或 cwd
   * @param {string} [options.pythonBin]    Python 解释器；默认 `$ROCO_PYTHON` 或 python3
   * @param {string} [options.pythonPath]   PYTHONPATH；默认 `<repoRoot>/roco/src`
   * @param {number} [options.port]         起服务时用的端口；0 = 由系统分配
   * @param {number} [options.timeoutMs]    单次请求超时
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ? stripTrailingSlash(options.baseUrl) : null;
    this.rulesetId = options.rulesetId || RULESET_ID;
    this.repoRoot = stripTrailingSlash(options.repoRoot || process.env.ROCO_REPO_ROOT || process.cwd());
    this.pythonBin = options.pythonBin || process.env.ROCO_PYTHON || 'python3';
    this.pythonPath = options.pythonPath || `${this.repoRoot}/roco/src`;
    this.serviceModule = options.serviceModule || 'roco_env.service';
    this.host = options.host || '127.0.0.1';
    this.port = Number.isInteger(options.port) ? options.port : 0;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.startTimeoutMs = options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs || DEFAULT_STOP_GRACE_MS;
    this.extraArgs = options.extraArgs || [];
    this.env = options.env || {};
    this.verbose = Boolean(options.verbose);

    this.child = null;
    this.readyInfo = null;
    this.ownedService = false;
    this._healthCache = null;
  }

  /** python3 在不在。用来决定「优雅跳过」还是「真的跑」。 */
  static probePython(pythonBin = 'python3') {
    try {
      const probe = spawnSync(pythonBin, ['--version'], { encoding: 'utf8' });
      if (probe.error || probe.status !== 0) return { ok: false, version: null, error: probe.error?.message || `退出码 ${probe.status}` };
      return { ok: true, version: (probe.stdout || probe.stderr || '').trim(), error: null };
    } catch (error) {
      return { ok: false, version: null, error: error.message };
    }
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────

  /** 服务入口文件的实际路径。找不到就说明布局变了，直接报出来而不是猜。 */
  get serviceEntry() {
    return `${this.repoRoot}/roco/src/roco_env/service.py`;
  }

  /**
   * 起一个本地 Python 规则服务并等它就绪（读 stdout 的 `ROCO_SERVICE_READY` 行）。
   * 失败一律抛 `RocoError`：这是环境问题，不是「引擎答不了」。
   */
  async startService(options = {}) {
    if (this.child && this.child.exitCode === null && this.baseUrl) {
      return { ok: true, alreadyRunning: true, baseUrl: this.baseUrl, ...(this.readyInfo || {}) };
    }
    const port = Number.isInteger(options.port) ? options.port : this.port;
    const rulesetId = options.rulesetId || this.rulesetId;
    const timeoutMs = options.timeoutMs || this.startTimeoutMs;

    if (!existsSync(this.serviceEntry)) {
      throw new RocoError(ROCO_ERROR.UNAVAILABLE, `找不到 Python 服务入口：${this.serviceEntry}`, {
        details: { entry: this.serviceEntry },
      });
    }

    const args = [
      '-m', this.serviceModule,
      '--host', this.host,
      '--port', String(port),
      '--ruleset', rulesetId,
      '--parent-pid', String(process.pid),
    ];
    if (this.verbose) args.push('--verbose');
    if (options.extraArgs) args.push(...options.extraArgs);
    args.push(...this.extraArgs);

    let child;
    try {
      child = spawn(this.pythonBin, args, {
        cwd: this.repoRoot,
        env: { ...process.env, PYTHONPATH: this.pythonPath, PYTHONUNBUFFERED: '1', ...this.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      throw new RocoError(ROCO_ERROR.UNAVAILABLE, `启动 Python 服务失败：${cause.message}`, { cause });
    }

    this.child = child;
    this.ownedService = true;
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });

    const ready = await new Promise((resolve, reject) => {
      let buffer = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.removeListener('data', onStdout);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        fn(value);
      };
      const onStdout = (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.startsWith('ROCO_SERVICE_READY ')) {
            try {
              finish(resolve, JSON.parse(line.slice('ROCO_SERVICE_READY '.length)));
            } catch (error) {
              finish(reject, new RocoError(ROCO_ERROR.PROTOCOL_ERROR, `就绪行不是合法 JSON：${line}`, { cause: error }));
            }
            return;
          }
          if (line.startsWith('ROCO_SERVICE_FAILED ')) {
            let payload = {};
            try {
              payload = JSON.parse(line.slice('ROCO_SERVICE_FAILED '.length));
            } catch {
              payload = { error: line };
            }
            finish(
              reject,
              new RocoError(mapServerErrorType(payload.error_type, 0), `Python 服务启动失败：${payload.error || line}`, {
                details: payload,
              }),
            );
            return;
          }
        }
      };
      const onExit = (code, signal) => {
        finish(
          reject,
          new RocoError(ROCO_ERROR.UNAVAILABLE, `Python 服务在就绪前退出（code=${code} signal=${signal}）：${stderrTail.trim()}`),
        );
      };
      const onError = (error) => {
        finish(
          reject,
          new RocoError(
            ROCO_ERROR.UNAVAILABLE,
            error.code === 'ENOENT' ? `找不到 Python 解释器：${this.pythonBin}` : `启动 Python 服务失败：${error.message}`,
            { cause: error },
          ),
        );
      };
      const timer = setTimeout(() => {
        finish(reject, new RocoError(ROCO_ERROR.TIMEOUT, `Python 服务在 ${timeoutMs}ms 内没有就绪`));
      }, timeoutMs);
      child.stdout.on('data', onStdout);
      child.once('exit', onExit);
      child.once('error', onError);
    }).catch(async (error) => {
      await this._killChild(true);
      throw error;
    });

    // 就绪行给的端口才是真端口（--port 0 时由系统分配）
    this.readyInfo = ready;
    this.baseUrl = stripTrailingSlash(`http://${ready.host || this.host}:${ready.port}`);
    this._healthCache = null;
    return { ok: true, alreadyRunning: false, baseUrl: this.baseUrl, ...ready };
  }

  async _killChild(force = false) {
    const child = this.child;
    this.child = null;
    this.readyInfo = null;
    this.baseUrl = null;
    this._healthCache = null;
    this.ownedService = false;
    if (!child || child.exitCode !== null) return false;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出 */
        }
        finish();
      }, force ? 0 : this.stopGraceMs);
      child.once('exit', finish);
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        finish();
      }
    });
    return true;
  }

  /** 停掉本客户端起的服务。幂等：没起过或已退出都返回 ok。 */
  async stopService() {
    const had = Boolean(this.child && this.child.exitCode === null);
    if (had) await this._killChild(false);
    else {
      this.child = null;
      this.readyInfo = null;
      if (this.ownedService) this.baseUrl = null;
      this._healthCache = null;
    }
    return { ok: true, stopped: had };
  }

  /** 与 stopService 同义，方便 `try/finally` 里统一写。 */
  async close() {
    return this.stopService();
  }

  // ── HTTP 底层 ─────────────────────────────────────────────────────────

  _localFailure(code, message, latencyMs, extra = {}) {
    return {
      ok: false,
      code,
      failure_class: FAILURE_CLASS[code] || 'unknown',
      message,
      ruleset_id: extra.ruleset_id ?? this.rulesetId,
      state_version: extra.state_version ?? null,
      snapshot_fingerprint: null,
      coverage: extra.coverage ?? 0,
      evidence_ids: [],
      unsupported: extra.unsupported || [],
      latency_ms: round3(latencyMs),
      service_latency_ms: null,
      error_type: extra.error_type ?? null,
      result: null,
      http_status: null,
      protocol_version: null,
      service_version: null,
      details: extra.details || null,
    };
  }

  /**
   * 发一次请求。**不抛异常**：传输层失败也会变成同形状的结果对象。
   */
  async _request(method, path, payload, options = {}) {
    const started = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
    // 契约要求回执里总有 state_version：GET /health 没有状态，按服务端口径记 0。
    const stateVersion =
      payload && typeof payload.state_version === 'number'
        ? payload.state_version
        : method === 'GET'
          ? 0
          : null;
    const rulesetId = (payload && payload.ruleset_id) || this.rulesetId;

    if (payload && typeof payload === 'object' && !PRIVATE_PLANE_PATHS.has(path)) {
      const hidden = findHiddenKeys(payload);
      if (hidden.length) {
        // 纪律 4：宁可拒绝，也不把对手的未公开选择发出去（连发都不发）。
        return this._localFailure(
          ROCO_ERROR.HIDDEN_INFORMATION,
          `请求里出现隐藏信息字段：${hidden.join(', ')}。依据 MC-013，教练侧不得携带对手待执行动作或真实随机种子`,
          elapsed(),
          { ruleset_id: rulesetId, state_version: stateVersion, details: { hidden_paths: hidden } },
        );
      }
    }

    if (!this.baseUrl) {
      return this._localFailure(ROCO_ERROR.UNAVAILABLE, '规则服务未启动：先 startService()，或在构造时传 baseUrl', elapsed(), {
        ruleset_id: rulesetId,
        state_version: stateVersion,
      });
    }

    let body = null;
    if (payload !== undefined && payload !== null) {
      try {
        body = Buffer.from(JSON.stringify(payload), 'utf8');
      } catch (cause) {
        return this._localFailure(ROCO_ERROR.BAD_REQUEST, `请求体无法序列化：${cause.message}`, elapsed(), {
          ruleset_id: rulesetId,
          state_version: stateVersion,
        });
      }
    }

    const timeoutMs = options.timeoutMs || this.timeoutMs;
    const response = await this._http(method, path, body, timeoutMs);
    if (response.error) {
      if (response.timedOut) {
        return this._localFailure(ROCO_ERROR.TIMEOUT, `规则服务在 ${timeoutMs}ms 内没有响应`, elapsed(), {
          ruleset_id: rulesetId,
          state_version: stateVersion,
        });
      }
      return this._localFailure(
        ROCO_ERROR.UNAVAILABLE,
        `连不上规则服务 ${this.baseUrl}：${response.error.message}`,
        elapsed(),
        { ruleset_id: rulesetId, state_version: stateVersion },
      );
    }

    let envelope;
    try {
      envelope = JSON.parse(response.text);
    } catch (cause) {
      return this._localFailure(ROCO_ERROR.PROTOCOL_ERROR, `回执不是合法 JSON：${response.text.slice(0, 200)}`, elapsed(), {
        ruleset_id: rulesetId,
        state_version: stateVersion,
        details: { http_status: response.status, cause: cause.message },
      });
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return this._localFailure(ROCO_ERROR.PROTOCOL_ERROR, '回执不是 JSON 对象', elapsed(), {
        ruleset_id: rulesetId,
        state_version: stateVersion,
        details: { http_status: response.status },
      });
    }

    // 纪律 2：契约字段缺一不可 —— 宁可判协议违规，也不让「没有出处的数字」流进来。
    const missing = CONTRACT_FIELDS.filter((field) => !(field in envelope));
    if (missing.length) {
      return this._localFailure(
        ROCO_ERROR.PROTOCOL_ERROR,
        `回执缺少契约字段：${missing.join(', ')}`,
        elapsed(),
        { ruleset_id: rulesetId, state_version: stateVersion, details: { missing, http_status: response.status } },
      );
    }

    // 纪律 4（回执侧）：发现隐藏信息就判协议违规，并且**不把泄漏内容透传**。
    //
    // 例外只有一处，而且是**按路径**给的：本地对局域（/battle/new|legal|advance）
    // 的回执按设计就带私有状态（含真实 seed），服务端也声明了 trust_domain。
    // 那些回执**不得**返回浏览器 —— 这个约束由 src/server/roco-service.js 的
    // publicView() 白名单负责，那一层只吐公开面。
    const privatePlane = PRIVATE_PLANE_PATHS.has(path);
    const leaked = privatePlane ? [] : findHiddenKeys(envelope);
    if (leaked.length) {
      return this._localFailure(
        ROCO_ERROR.PROTOCOL_ERROR,
        `回执里出现隐藏信息字段：${leaked.join(', ')}（已丢弃该回执内容）`,
        elapsed(),
        {
          ruleset_id: envelope.ruleset_id ?? rulesetId,
          state_version: envelope.state_version ?? stateVersion,
          details: { leaked_paths: leaked, http_status: response.status },
        },
      );
    }

    return this._normalize(envelope, response.status, elapsed());
  }

  _http(method, path, body, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let url;
      try {
        url = new URL(this.baseUrl + path);
      } catch (error) {
        done({ error });
        return;
      }
      const headers = {};
      if (body) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        headers['Content-Length'] = body.length;
      }
      const req = httpRequest(
        { host: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            done({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.setTimeout(timeoutMs, () => {
        timedOut = true;
        req.destroy(new Error(`超时 ${timeoutMs}ms`));
      });
      req.on('error', (error) => done({ error, timedOut }));
      if (body) req.write(body);
      req.end();
    });
  }

  _normalize(envelope, httpStatus, clientLatencyMs) {
    const errorType = envelope.error_type ?? null;
    const coverage = typeof envelope.coverage === 'number' ? envelope.coverage : null;
    const code = errorType === null ? (envelope.ok === false ? mapServerErrorType(null, coverage) : null) : mapServerErrorType(errorType, coverage);
    const ok = envelope.ok === true && code === null;
    // 信封允许带端点专有字段（服务端 `_envelope(**extra)` 会展开到顶层）。
    // 这些字段必须透传，否则会丢掉关键信息——最典型的是阵容评估的 `limitations`
    // 与 `calibration`：它们说明这个结果**不声称**什么（例如不声称胜率）。
    // 只列已知的契约字段、把其余丢掉，等于把「我们不知道什么」一起丢了。
    const extra = {};
    for (const key of Object.keys(envelope)) {
      if (CONTRACT_FIELDS.includes(key) || KNOWN_TOP_LEVEL.has(key)) continue;
      extra[key] = envelope[key];
    }
    return {
      ...extra,
      ok,
      code: ok ? null : code,
      failure_class: ok ? null : FAILURE_CLASS[code] || 'unknown',
      message: ok ? null : envelope.error || `规则服务拒绝：${errorType || code}`,
      ruleset_id: envelope.ruleset_id ?? null,
      state_version: envelope.state_version ?? null,
      snapshot_fingerprint: envelope.snapshot_fingerprint ?? null,
      coverage,
      evidence_ids: Array.isArray(envelope.evidence_ids) ? envelope.evidence_ids : [],
      unsupported: Array.isArray(envelope.unsupported) ? envelope.unsupported : [],
      // 客户端自测的往返耗时（权威）；服务端自测的另存一栏，方便区分是网络还是引擎慢。
      latency_ms: round3(clientLatencyMs),
      service_latency_ms: typeof envelope.latency_ms === 'number' ? envelope.latency_ms : null,
      error_type: errorType,
      result: envelope.result ?? null,
      http_status: httpStatus,
      protocol_version: envelope.protocol_version ?? null,
      service_version: envelope.service_version ?? null,
      details: null,
    };
  }

  // ── /health ───────────────────────────────────────────────────────────

  /** 问服务是谁、拿的是哪个规则集。`fresh` 为真时绕过缓存。 */
  async health({ fresh = false } = {}) {
    if (!fresh && this._healthCache) return this._healthCache;
    const result = await this._request('GET', '/health', null);
    if (!result.ok && result.code === ROCO_ERROR.PROTOCOL_ERROR) return result;
    this._healthCache = result;
    return result;
  }

  /**
   * 健康检查 + 版本握手。返回 `{ result, ready }`：
   * 服务不可用、规则集加载不了、协议版本不一致都会给出可区分的 code。
   */
  async handshake() {
    const health = await this.health();
    if (!health.ok) return { result: health, ready: false };
    if (health.protocol_version !== null && health.protocol_version !== PROTOCOL_VERSION) {
      return {
        result: this._localFailure(
          ROCO_ERROR.VERSION_MISMATCH,
          `桥协议版本不一致：适配器 ${PROTOCOL_VERSION}，服务 ${health.protocol_version}`,
          health.latency_ms,
          {
            ruleset_id: health.ruleset_id,
            state_version: health.state_version,
            details: { adapter: PROTOCOL_VERSION, service: health.protocol_version },
          },
        ),
        ready: false,
      };
    }
    return { result: health, ready: true };
  }

  // ── /rules/query ──────────────────────────────────────────────────────

  _payload(extra = {}, options = {}) {
    const payload = {
      ruleset_id: options.rulesetId || this.rulesetId,
      state_version: Number.isInteger(options.stateVersion) ? options.stateVersion : 0,
      ...extra,
    };
    if (options.expectedFingerprint) payload.expected_fingerprint = options.expectedFingerprint;
    return payload;
  }

  /** `query_rules` 工具：只读事实查询。kind 见 service.py。 */
  async query(fact = {}, options = {}) {
    const { kind, stateVersion, ...rest } = fact || {};
    return this._request('POST', '/rules/query', this._payload({ kind, ...rest }, { ...options, stateVersion: stateVersion ?? options.stateVersion }));
  }

  async pet(petId, options = {}) {
    return this.query({ kind: 'pet', pet_id: petId }, options);
  }

  async petByName(name, options = {}) {
    return this.query({ kind: 'pet', name }, options);
  }

  async skill(reference, options = {}) {
    const key = String(reference || '');
    return this.query(key.startsWith('skill_') ? { kind: 'skill', skill_id: key } : { kind: 'skill', name: key }, options);
  }

  async skillById(skillId, options = {}) {
    return this.query({ kind: 'skill', skill_id: skillId }, options);
  }

  async skillByName(name, options = {}) {
    return this.query({ kind: 'skill', name }, options);
  }

  async learnset(petId, { includeRecords = true, ...options } = {}) {
    return this.query({ kind: 'learnset', pet_id: petId, include_records: includeRecords }, options);
  }

  async term(termId, options = {}) {
    return this.query({ kind: 'term', term_id: String(termId) }, options);
  }

  async rulesetSummary(options = {}) {
    return this.query({ kind: 'ruleset' }, options);
  }

  async typeRow(type, options = {}) {
    return this.query({ kind: 'type_row', type }, options);
  }

  async typeChart(options = {}) {
    return this.query({ kind: 'type_chart' }, options);
  }

  /** 相性倍率。双属性只用快照显式行；缺行时返回 unsupported，不做相乘假设。 */
  async typeMultiplier(defenderTypes, attackElement, options = {}) {
    return this.query(
      { kind: 'type_multiplier', defender_types: defenderTypes, attack_element: attackElement },
      options,
    );
  }

  /**
   * 解析技能效果/威力。当前引擎没实现效果原语 → 稳定返回 `unsupported_effect`。
   * 这个方法是**故意**保留的：上层要能看见「这里不支持」，而不是拿到一个数。
   */
  async resolveEffect(skillId, options = {}) {
    return this.query({ kind: 'effect', skill_id: skillId }, options);
  }

  // ── 尚未实现的引擎端点（结构化拒绝，绝不编数）─────────────────────────

  async evaluateTeam(team, options = {}) {
    return this._request('POST', '/team/evaluate', this._payload({ team }, options));
  }

  async compareTeamChange(teamBefore, teamAfter, options = {}) {
    return this._request('POST', '/team/compare', this._payload({ team_before: teamBefore, team_after: teamAfter }, options));
  }

  /**
   * 2—3 回合规划。
   *
   * `publicState` 必须是 `env.public_planner_state()` 产出的**公开** state，
   * 不能是 `env.serialize()` 的私有完整状态：后者带真实 seed、对手本回合已提交的
   * 动作与对手后备血量，服务端会以 hidden_information 直接拒绝——这是有意的，
   * 真实 seed 能预测同速与伤害的随机结果，属于隐藏信息（MC-013）。
   *
   * `analysisSeeds` 与真实对局 seed 无关；服务端跨种子聚合，回执给的是区间。
   * 参数名从 `state` 改成 `publicState` 是刻意的：让「传错东西」在调用点就看得出来。
   */
  async planActions(publicState, options = {}) {
    if (publicState == null || typeof publicState !== 'object') {
      return this._localFailure(
        ROCO_ERROR.BAD_REQUEST,
        'planActions 需要公开 planner state（env.public_planner_state() 的产物），不是私有 serialize()',
        elapsedSince(options), { ruleset_id: this.rulesetId, state_version: options.stateVersion ?? 0 },
      );
    }
    const body = { public: publicState };
    if (Number.isInteger(options.depth)) body.depth = options.depth;
    if (Number.isInteger(options.beam)) body.beam = options.beam;
    if (Number.isInteger(options.budgetMs)) body.budget_ms = options.budgetMs;
    if (Array.isArray(options.analysisSeeds)) body.analysis_seeds = options.analysisSeeds;
    // 伤害预览（原始伤害范围 + 能不能一击收掉）。
    //
    // 第 43 轮补：`roco-service.js` 一直在传 `damagePreview: true`，而这里**从来没读过它**，
    // 于是服务端永远收不到 `damage_preview`、回执里那一栏恒为 null，
    // 页面上的「这一步能打出多少、够不够收」就一直是空的——又是「接上了但不生效」，
    // 而且不报错。第四个同类问题了（前三次：特征只读调用方字段、命名不一致、
    // 边际量对象形状）。
    if (options.damagePreview === true) body.damage_preview = true;
    return this._request('POST', '/battle/plan', this._payload(body, options), options);
  }

  /**
   * 开一局**本地练习对局**（本地对局域，含私有状态）。
   *
   * 与 `planActions` 的区别是刻意的、也是本文件里最重要的一条边界：
   *   · `planActions` 属于**教练域**：只发公开面，带 seed 一律本地拒绝；
   *   · 这三个 `battleXxx` 方法属于**本地对局域**：它们按设计就带完整私有状态
   *     （含真实 seed），由本机 Node 服务调用，回执里的私有状态**不得返回浏览器**。
   *
   * 服务端会在这两个域的请求上分别打标记（`trust_domain`），所以这里的私有状态
   * 不会被误当成教练输入；反过来，教练输入也不允许走这几个方法。
   */
  /**
   * 开一局（本地对局域）。
   *
   * RC-106 起多两个参数，语义都来自引擎侧（Node 只是转发，不自己解释）：
   *   · `rulesetConfigId`：这一局用哪份规则配置（**由 BattleMode 登记表的 `ruleset_binding` 决定**，
   *     调用方不许抄字符串）；省略 = 引擎当前生效配置（legacy 的逐位不变路径）。
   *   · `unverifiedOverrides`：显式的、带出处的未核验覆盖（例如 v3 的 `energy.initial`）。
   *     形状不合法/覆盖了已核验的路径 ⇒ 引擎 400；缺覆盖而配置里是 UNKNOWN ⇒ 引擎 422。
   */
  async battleNew({ team, enemyTeam, seed = 1, strategy = 'greedy_damage', loadouts = null, stateVersion = 0,
    rulesetConfigId = null, unverifiedOverrides = null } = {}) {
    const body = { team, seed, strategy };
    if (enemyTeam) body.enemy_team = enemyTeam;
    if (loadouts) body.loadouts = loadouts;
    if (rulesetConfigId) body.ruleset_config_id = rulesetConfigId;
    if (Array.isArray(unverifiedOverrides) && unverifiedOverrides.length) body.unverified_overrides = unverifiedOverrides;
    return this._request('POST', '/battle/new', this._payload(body, { stateVersion }), { stateVersion });
  }

  /** 列出某一局当前的合法动作（本地对局域）。 */
  async battleLegal({ state, strategy = 'greedy_damage', stateVersion = 0 } = {}) {
    return this._request(
      'POST', '/battle/legal',
      this._payload({ state, strategy }, { stateVersion }), { stateVersion },
    );
  }

  /**
   * 推进一个回合或一次补位（本地对局域）。
   *
   * `action` 给了就是玩家自己出招；只给 `playerStrategy` 就是让策略代打
   * （自动演示与批量推演用）。两者都没给会被服务端以 400 拒绝——不猜玩家想干什么。
   */
  async battleAdvance({ state, action = null, strategy = 'greedy_damage', playerStrategy = null, stateVersion = 0 } = {}) {
    const body = { state, strategy };
    if (action) body.action = action;
    if (playerStrategy) body.player_strategy = playerStrategy;
    return this._request('POST', '/battle/advance', this._payload(body, { stateVersion }), { stateVersion });
  }

  /**
   * 复盘摘要：**没有**对应的服务端点（实施书只定义了 5 个工具里的 4 个端点）。
   * 这里不假装能算，直接给结构化 not_implemented。
   */
  async summarizeBattle(record, options = {}) {
    return this._localFailure(
      ROCO_ERROR.NOT_IMPLEMENTED,
      '复盘摘要没有对应的规则服务端点：摘要需要事件序列与伤害结算，两者都未核验（MC-010/MC-012）',
      0,
      {
        ruleset_id: options.rulesetId || this.rulesetId,
        state_version: Number.isInteger(options.stateVersion) ? options.stateVersion : 0,
        error_type: 'not_implemented',
        unsupported: [
          {
            code: 'battle_summary',
            reason: '规则服务未定义 /battle/summary；事件序与伤害结算未核验',
            missing: ['event_ordering', 'official_damage_formula'],
          },
        ],
        details: { record_keys: record && typeof record === 'object' ? Object.keys(record).slice(0, 20) : [] },
      },
    );
  }
}

/** 便捷构造。 */
export function createRocoClient(options = {}) {
  return new RocoClient(options);
}

// ── 工具层：5 个模型可调用工具的声明 ───────────────────────────────────
//
// 只声明**形状**（名字、说明、入参），不绑定具体编排：工具调度与参数校验
// 属于 `src/coach/toolbox.js` 的职责。这里保证「稳定标识不用下标」「必填项明确」。

export const ROCO_TOOLS = Object.freeze([
  {
    name: 'query_rules',
    description:
      '只读查询手游规则事实（精灵/技能/学习表/属性相性/术语）。返回带 ruleset_id、coverage、evidence_ids 的回执；机制未支持时返回 unsupported，不含编造数值。',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['ruleset', 'pet', 'skill', 'learnset', 'term', 'type_row', 'type_chart', 'type_multiplier', 'effect'] },
        pet_id: { type: 'string', description: '稳定 id，如 pet_000225；不要用下标' },
        skill_id: { type: 'string' },
        name: { type: 'string' },
        term_id: { type: 'string' },
        type: { type: 'string' },
        defender_types: { type: 'array', items: { type: 'string' } },
        attack_element: { type: 'string' },
        state_version: { type: 'integer', minimum: 0 },
      },
      required: ['kind', 'state_version'],
    },
  },
  {
    name: 'evaluate_team',
    description: '队伍强度评估。引擎逻辑未实现（缺官方伤害公式与等级→面板换算），当前返回 not_implemented。',
    input_schema: {
      type: 'object',
      properties: {
        team: { type: 'array', items: { type: 'string' }, description: '精灵 id 列表（稳定 id）' },
        state_version: { type: 'integer', minimum: 0 },
      },
      required: ['team', 'state_version'],
    },
  },
  {
    name: 'compare_team_change',
    description: '换人前后对比。依赖与 evaluate_team 相同的未核验机制，当前返回 not_implemented。',
    input_schema: {
      type: 'object',
      properties: {
        team_before: { type: 'array', items: { type: 'string' } },
        team_after: { type: 'array', items: { type: 'string' } },
        state_version: { type: 'integer', minimum: 0 },
      },
      required: ['team_before', 'team_after', 'state_version'],
    },
  },
  {
    name: 'plan_actions',
    description: '给定公开状态给出回合行动建议。行动排序键/应对/蓄力时序未核验，当前返回 not_implemented。',
    input_schema: {
      type: 'object',
      properties: {
        state: { type: 'object', description: '**公开**状态；不得包含对手待执行动作或真实随机种子' },
        state_version: { type: 'integer', minimum: 0 },
      },
      required: ['state', 'state_version'],
    },
  },
  {
    name: 'summarize_battle',
    description: '对局复盘摘要。无对应服务端点，当前返回 not_implemented。',
    input_schema: {
      type: 'object',
      properties: {
        record: { type: 'object', description: '对局记录（公开信息）' },
        state_version: { type: 'integer', minimum: 0 },
      },
      required: ['record', 'state_version'],
    },
  },
]);

export default RocoClient;
