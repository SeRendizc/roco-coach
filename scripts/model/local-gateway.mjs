#!/usr/bin/env node
// 本地模型网关：把常驻 MLX 推理进程暴露成 **OpenAI-compatible** HTTP 接口。
//
// 为什么要有它（而不是让 Agent 直接读进程 stdout）
// ----------------------------------------------
// 1. Agent、评测脚本、人工诊断都用同一个入口，口径只有一份；
// 2. 超时 / 并发 / 取消 / 不可用回退有一个**集中的**实现位置，
//    而不是散在每个调用点各写一遍（那样一定会漂移）；
// 3. OpenAI 兼容意味着任何现成客户端都能连上来做对照，不需要为它写适配器。
//
// 兼容到哪一步（说清楚，不含糊）
// ----------------------------
// 实现 `/v1/chat/completions`、`/v1/models`、`/healthz`、`/metrics`。
// **不支持**流式（`stream: true` 会被明确拒绝为 501，而不是假装支持然后一次吐完）、
// 不支持 `tools` 原生工具协议（工具选择由 Agent 的 prompt 契约承担，
// 见 docs/roco/LOCAL-MODEL.md）、不记账 token 费用。
//
// 事实边界
// --------
// 网关**不**修改模型输出、**不**补全缺失的工具回执、**不**把失败包装成成功。
// 上游不可用时返回 503 + `error.type=unavailable`，由调用方回退。

import {createServer as createHttpServer} from 'node:http';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const GATEWAY_ROOT = join(HERE, '..', '..');
export const DEFAULT_PORT = 8766;

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 网关。
 *
 * 参数都可在测试里注入：`spawnImpl` 换掉真实子进程，从而在没有权重、
 * 甚至没有 MLX 的机器上覆盖超时/崩溃/并发排队这些路径。
 */
export class LocalModelGateway {
  constructor({
    python = process.env.ROCO_LOCAL_PYTHON || join(GATEWAY_ROOT, '.venv-mlx', 'bin', 'python'),
    modelPath = process.env.ROCO_LOCAL_MODEL_PATH || join(GATEWAY_ROOT, '.models', 'mlx', 'Qwen3.5-4B-4bit'),
    scriptPath = join(GATEWAY_ROOT, 'scripts', 'model', 'serve_mlx.py'),
    adapter = process.env.ROCO_LOCAL_ADAPTER || null,
    timeoutMs = envInt('ROCO_LOCAL_TIMEOUT_MS', 3000),
    readyTimeoutMs = envInt('ROCO_LOCAL_READY_TIMEOUT_MS', 180000),
    maxConcurrency = envInt('ROCO_LOCAL_MAX_CONCURRENCY', 1),
    maxQueue = envInt('ROCO_LOCAL_MAX_QUEUE', 4),
    spawnImpl = spawn,
  } = {}) {
    this.python = python;
    this.modelPath = modelPath;
    this.scriptPath = scriptPath;
    this.adapter = adapter;
    this.timeoutMs = timeoutMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.maxConcurrency = maxConcurrency;
    this.maxQueue = maxQueue;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.counter = 0;
    this.stderrTail = [];
    this.ready = false;
    this.starting = null;
    this.active = 0;
    this.queued = 0;
    this.metrics = {
      requests: 0, ok: 0, rejected_busy: 0, timeouts: 0, cancelled: 0,
      upstream_errors: 0, unresponsive: 0,
      latency_ms: [], first_token_ms: [], tokens_per_second: [], peak_memory_gb: [],
    };
  }

  get busy() { return this.active + this.queued; }

  async start() {
    if (this.ready || this.starting) return this.starting;
    this.starting = (async () => {
      const missing = [];
      if (!existsSync(this.python)) missing.push(`python：${this.python}`);
      if (!existsSync(this.scriptPath)) missing.push(`脚本：${this.scriptPath}`);
      if (!existsSync(this.modelPath)) missing.push(`权重：${this.modelPath}`);
      if (missing.length) {
        throw Object.assign(new Error(`本地模型未就绪：缺少 ${missing.join('、')}`), {code: 'preflight'});
      }
      const args = [this.scriptPath, '--model', this.modelPath];
      if (this.adapter) args.push('--adapter', this.adapter);
      this.child = this.spawnImpl(this.python, args, {stdio: ['pipe', 'pipe', 'pipe']});
      this.child.stdout.setEncoding('utf8');
      this.child.stderr.setEncoding('utf8');
      this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
      this.child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          this.stderrTail.push(line.trim());
          if (line.includes('"event": "ready"')) this.ready = true;
        }
        if (this.stderrTail.length > 80) this.stderrTail.splice(0, this.stderrTail.length - 80);
      });
      this.child.on('exit', (code, signal) => {
        this.child = null;
        this.ready = false;
        this.starting = null;
        for (const [, entry] of this.pending) {
          entry.reject(Object.assign(new Error(`推理进程退出（code=${code} signal=${signal}）`),
            {code: 'upstream-exit'}));
        }
        this.pending.clear();
      });
      const started = Date.now();
      while (!this.ready) {
        if (!this.child) throw Object.assign(new Error('推理进程在就绪前退出'), {code: 'upstream-exit'});
        if (Date.now() - started > this.readyTimeoutMs) {
          throw Object.assign(new Error(`${this.readyTimeoutMs}ms 内未就绪`), {code: 'ready-timeout'});
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return {ready: true};
    })();
    try { return await this.starting; } catch (error) { this.starting = null; throw error; }
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        try {
          const payload = JSON.parse(line);
          const entry = this.pending.get(payload.id);
          if (entry) { this.pending.delete(payload.id); entry.resolve(payload); }
        } catch { this.metrics.upstream_errors += 1; }
      }
      index = this.buffer.indexOf('\n');
    }
  }

  /** 排队策略：满了就**快速失败**，不无限等——局内等不起排到天荒地老。 */
  _admit() {
    if (this.active >= this.maxConcurrency) {
      if (this.queued >= this.maxQueue) return false;
      this.queued += 1;
      return 'queue';
    }
    this.active += 1;
    return 'run';
  }

  async request(body, {timeoutMs = null, signal = null} = {}) {
    const budget = timeoutMs === null ? this.timeoutMs : timeoutMs;
    const admission = this._admit();
    if (admission === false) {
      this.metrics.rejected_busy += 1;
      throw Object.assign(new Error(`本地模型忙（并发 ${this.maxConcurrency}，队列 ${this.maxQueue}）`),
        {code: 'busy'});
    }
    if (admission === 'queue') {
      await new Promise((resolve) => setTimeout(resolve, 25));
      this.queued -= 1;
      return this.request(body, {timeoutMs, signal});
    }
    try {
      return await this._send(body, budget, signal);
    } finally {
      this.active -= 1;
    }
  }

  _send(body, budget, signal) {
    if (signal?.aborted) {
      this.metrics.cancelled += 1;
      return Promise.reject(Object.assign(new Error('已取消'), {code: 'cancelled'}));
    }
    const id = `g${++this.counter}`;
    this.metrics.requests += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.metrics.timeouts += 1;
        reject(Object.assign(new Error(`本地模型 ${budget}ms 内未返回`), {code: 'timeout'}));
      }, budget);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        this.metrics.cancelled += 1;
        reject(Object.assign(new Error('已取消'), {code: 'cancelled'}));
      };
      signal?.addEventListener?.('abort', onAbort, {once: true});
      this.pending.set(id, {
        resolve: (payload) => { signal?.removeEventListener?.('abort', onAbort); clearTimeout(timer); resolve(payload); },
        reject: (error) => { signal?.removeEventListener?.('abort', onAbort); clearTimeout(timer); reject(error); },
      });
      try {
        this.child.stdin.write(`${JSON.stringify({id, ...body})}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(Object.assign(new Error(`写入失败：${error.message}`), {code: 'upstream-exit'}));
      }
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.starting = null;
    for (const [, entry] of this.pending) entry.reject(Object.assign(new Error('已停止'), {code: 'cancelled'}));
    this.pending.clear();
    if (!child) return;
    await new Promise((resolve) => {
      child.once('exit', resolve);
      try { child.stdin.end(); } catch { /* ignore */ }
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
      killer.unref?.();
    });
  }

  health() {
    const recent = (list, n = 20) => list.slice(-n);
    const pct = (list, p) => {
      if (!list.length) return null;
      const sorted = [...list].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    };
    return {
      ok: this.ready && Boolean(this.child),
      model: this.modelPath,
      adapter: this.adapter,
      ready: this.ready,
      concurrency: {active: this.active, queued: this.queued, max: this.maxConcurrency},
      latest: {
        first_token_ms: recent(this.metrics.first_token_ms, 1)[0] ?? null,
        total_ms: recent(this.metrics.latency_ms, 1)[0] ?? null,
        tokens_per_second: recent(this.metrics.tokens_per_second, 1)[0] ?? null,
        peak_memory_gb: recent(this.metrics.peak_memory_gb, 1)[0] ?? null,
      },
      p50_total_ms: pct(this.metrics.latency_ms, 0.5),
      p95_total_ms: pct(this.metrics.latency_ms, 0.95),
      counters: {...this.metrics, latency_ms: undefined, first_token_ms: undefined,
        tokens_per_second: undefined, peak_memory_gb: undefined},
      stderr_tail: this.stderrTail.slice(-5),
    };
  }
}

/** OpenAI 形状的响应。`usage` 用引擎自报的 token 数，不估算。 */
function openAiResponse(id, model, result) {
  return {
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{index: 0, message: {role: 'assistant', content: result.text}, finish_reason: result.stop_reason || 'stop'}],
    usage: {
      prompt_tokens: result.prompt_tokens ?? null,
      completion_tokens: result.completion_tokens ?? null,
      total_tokens: (result.prompt_tokens ?? 0) + (result.completion_tokens ?? 0) || null,
    },
    x_roco: {
      first_token_ms: result.first_token_ms ?? null,
      total_ms: result.total_ms ?? null,
      tokens_per_second: result.tokens_per_second ?? null,
      peak_memory_gb: result.peak_memory_gb ?? null,
      memory_source: result.memory_source ?? null,
      counted_by: result.counted_by ?? null,
    },
  };
}

function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { reject(Object.assign(new Error('请求体过大'), {code: 'too-large'})); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length});
  res.end(body);
}

function errorPayload(code, message, type) {
  return {error: {message, type, code}};
}

/** 建 HTTP server。测试可以直接拿它 listen(0) 而不用 CLI。 */
export function createGatewayServer(gateway) {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        const health = gateway.health();
        return send(res, health.ok ? 200 : 503, health);
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        return send(res, 200, gateway.health());
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return send(res, 200, {object: 'list', data: [{
          id: 'roco-local', object: 'model', owned_by: 'local-mlx',
          root: gateway.modelPath, adapter: gateway.adapter,
          x_roco: {role: 'intent-routing/tool-selection/intervention-wording/fallback'},
        }]});
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw || '{}'); }
        catch { return send(res, 400, errorPayload('bad_json', '请求体不是合法 JSON', 'invalid_request_error')); }
        if (body.stream === true) {
          // 明确拒绝，而不是假装支持：假装支持会让客户端以为拿到的是流。
          return send(res, 501, errorPayload('stream_unsupported',
            '本网关不支持流式输出；请使用 stream=false', 'not_implemented'));
        }
        if (!Array.isArray(body.messages) || !body.messages.length) {
          return send(res, 400, errorPayload('messages_required', '需要非空的 messages', 'invalid_request_error'));
        }
        const timeoutMs = Number.isFinite(body.timeout_ms) ? Number(body.timeout_ms) : null;
        const controller = new AbortController();
        // 客户端断开 = 取消：不等满超时，立刻释放并发名额。
        req.on('close', () => { if (!res.writableEnded) controller.abort(); });
        let result;
        try {
          result = await gateway.request({
            messages: body.messages,
            max_tokens: body.max_tokens,
            temperature: body.temperature ?? 0,
            enable_thinking: Boolean(body.enable_thinking),
          }, {timeoutMs, signal: controller.signal});
        } catch (error) {
          const code = error.code || 'unknown';
          const map = {
            timeout: [504, 'timeout'], busy: [429, 'rate_limit_exceeded'],
            cancelled: [499, 'cancelled'], 'upstream-exit': [503, 'unavailable'],
            'ready-timeout': [503, 'unavailable'], preflight: [503, 'unavailable'],
          };
          const [status, type] = map[code] || [502, 'upstream_error'];
          gateway.metrics.unresponsive += code === 'timeout' ? 1 : 0;
          return send(res, status, errorPayload(code, error.message, type));
        }
        if (!result.ok) {
          gateway.metrics.upstream_errors += 1;
          return send(res, 502, errorPayload(result.error_type || 'model_error',
            result.message || '模型返回失败', 'upstream_error'));
        }
        gateway.metrics.ok += 1;
        for (const [key, value] of [['latency_ms', result.total_ms], ['first_token_ms', result.first_token_ms],
          ['tokens_per_second', result.tokens_per_second], ['peak_memory_gb', result.peak_memory_gb]]) {
          if (typeof value === 'number') gateway.metrics[key].push(value);
        }
        return send(res, 200, openAiResponse(`chatcmpl-local-${randomUUID().slice(0, 8)}`,
          'roco-local', result));
      }
      return send(res, 404, errorPayload('not_found', `没有这个路径：${url.pathname}`, 'invalid_request_error'));
    } catch (error) {
      if (error.code === 'too-large') {
        return send(res, 413, errorPayload('too_large', error.message, 'invalid_request_error'));
      }
      return send(res, 500, errorPayload('internal', String(error.message || error), 'internal_error'));
    }
  });
}

async function main(argv) {
  const portArg = argv.indexOf('--port');
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : envInt('ROCO_LOCAL_PORT', DEFAULT_PORT);
  const gateway = new LocalModelGateway();
  const server = createGatewayServer(gateway);
  const outDir = join(GATEWAY_ROOT, 'reports', 'roco', 'local-model');
  mkdirSync(outDir, {recursive: true});
  const pidFile = join(outDir, 'gateway.pid');
  writeFileSync(pidFile, String(process.pid));
  try {
    await gateway.start();
  } catch (error) {
    process.stderr.write(`[gateway] 启动失败：${error.message}\n`);
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    return 2;
  }
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  process.stdout.write(`${JSON.stringify({event: 'gateway-ready', port, pid: process.pid,
    model: gateway.modelPath})}\n`);
  const shutdown = async () => {
    server.close();
    await gateway.stop();
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {});
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main(process.argv.slice(2)).then((code) => { if (code !== undefined) process.exit(code); })
    .catch((error) => { process.stderr.write(`[gateway] ${error?.stack || error}\n`); process.exit(1); });
}
