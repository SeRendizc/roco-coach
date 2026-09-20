// Mac 本地小模型：Agent 侧的**唯一**调用点。
//
// 位置
// ----
// 它是 `src/coach/runtime.js` 里 `provider` 契约的一个实现：
//
//     {name, async generate(packet) -> string}
//
// 与 `localProvider`（直接返回已渲染好的模板文字）和 DeepSeek 网关并列。
// 选它还是选云端由 **feature flag** 决定（`ROCO_LOCAL_MODEL`），默认关闭：
// 没有明确打开时行为与今天完全一致，本地模型不可能悄悄改变玩家看到的东西。
//
// 它不允许做的事
// --------------
// 这个模块**只**把一段已经装配好的提示交给本地模型并拿回文字。
// 它不查规则、不算数值、不改写工具回执，也不替 runtime 决定事实。
// 模型输出回到 runtime 后仍要过 `checkGroundedAnswer` / `checkReceiptConsistency`，
// 与云端回答走同一条事实校验——「本地模型说的一定对」不是本项目的假设。
//
// 进程模型
// --------
// 下面是**常驻子进程 + stdio JSONL**：加载一次权重，之后按行收发。
// 理由：4B 4bit 的加载是秒级且立刻占 3 GB 统一内存；每个请求重载会把
// 「首 token 延迟」这个指标变成加载时间。常驻让两者可分开测量。
//
// 失败一律**降级到云端或本地模板**，不抛给玩家：局内不能因为本地模型不可用就卡住。

import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const SERVE_SCRIPT = join(REPO_ROOT, 'scripts', 'model', 'serve_mlx.py');
export const DEFAULT_VENV_PYTHON = join(REPO_ROOT, '.venv-mlx', 'bin', 'python');
export const DEFAULT_MODEL_DIR = join(REPO_ROOT, '.models', 'mlx', 'Qwen3.5-4B-4bit');

/** 局内预算：约 3 秒。超时不是异常路径，是**设计的一部分**。 */
export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_MAX_TOKENS = 256;
/** 并发上限：单机统一内存，跑两个 4B 推理会互相拖慢并抬高首 token 延迟。 */
export const DEFAULT_MAX_CONCURRENCY = 1;

/**
 * feature flag 的唯一读法。
 *
 * `off`（默认）/ `on` / `shadow`：
 *   - `off`   完全不走本地模型，行为与没有这个模块一样；
 *   - `shadow` **照常返回云端结果**，但把本地模型也跑一遍并记下差异，
 *              用来在真实流量上比对而不影响玩家；
 *   - `on`    本地模型可用时用本地结果，不可用/超时/非法则回退。
 */
export function localModelMode(env = process.env) {
  const raw = String(env.ROCO_LOCAL_MODEL || 'off').trim().toLowerCase();
  if (raw === 'on' || raw === 'shadow' || raw === 'off') return raw;
  if (raw === '1' || raw === 'true' || raw === 'yes') return 'on';
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === '') return 'off';
  return 'off';
}

/** 模型 manifest 里的关键事实，用来在日志里说清「这次用的是哪一份权重」。 */
export function localModelIdentity(env = process.env) {
  return {
    provider: 'mlx-local',
    model: env.ROCO_LOCAL_MODEL_PATH || DEFAULT_MODEL_DIR,
    adapter: env.ROCO_LOCAL_ADAPTER || null,
    python: env.ROCO_LOCAL_PYTHON || DEFAULT_VENV_PYTHON,
  };
}

class Semaphore {
  constructor(limit) { this.limit = Math.max(1, limit); this.active = 0; this.queue = []; }
  async acquire() {
    if (this.active < this.limit) { this.active += 1; return; }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/**
 * 常驻推理句柄。
 *
 * `spawnImpl` 可注入：测试用它塞一个假子进程，从而在不加载 3 GB 权重的情况下
 * 覆盖「超时 / 进程死掉 / 返回非 JSON / 并发排队」这些真实会发生的路径。
 */
export class LocalModel {
  constructor({
    python = process.env.ROCO_LOCAL_PYTHON || DEFAULT_VENV_PYTHON,
    modelPath = process.env.ROCO_LOCAL_MODEL_PATH || DEFAULT_MODEL_DIR,
    adapter = process.env.ROCO_LOCAL_ADAPTER || null,
    timeoutMs = Number(process.env.ROCO_LOCAL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    maxTokens = Number(process.env.ROCO_LOCAL_MAX_TOKENS || DEFAULT_MAX_TOKENS),
    maxConcurrency = Number(process.env.ROCO_LOCAL_MAX_CONCURRENCY || DEFAULT_MAX_CONCURRENCY),
    spawnImpl = spawn,
    scriptPath = SERVE_SCRIPT,
    readyTimeoutMs = 120000,
  } = {}) {
    this.python = python;
    this.modelPath = modelPath;
    this.adapter = adapter;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.gate = new Semaphore(maxConcurrency);
    this.spawnImpl = spawnImpl;
    this.scriptPath = scriptPath;
    this.readyTimeoutMs = readyTimeoutMs;
    this.child = null;
    this.pending = new Map();
    this.counter = 0;
    this.buffer = '';
    this.stderrLines = [];
    this.ready = null;
    this.stats = {requests: 0, ok: 0, timeouts: 0, errors: 0, cancelled: 0, lastLatencyMs: null};
  }

  /** 本机是否具备跑起来的条件（不启动进程、不加载权重）。 */
  preflight() {
    const missing = [];
    if (!existsSync(this.python)) missing.push(`python 不存在：${this.python}（先跑 scripts/model/setup-mac.sh）`);
    if (!existsSync(this.scriptPath)) missing.push(`推理脚本不存在：${this.scriptPath}`);
    if (!existsSync(this.modelPath)) missing.push(`权重目录不存在：${this.modelPath}`);
    return {ok: missing.length === 0, missing, ...localModelIdentity({ROCO_LOCAL_PYTHON: this.python, ROCO_LOCAL_MODEL_PATH: this.modelPath})};
  }

  async start() {
    if (this.ready) return this.ready;
    const check = this.preflight();
    if (!check.ok) throw Object.assign(new Error(check.missing.join('；')), {code: 'preflight'});
    const args = [this.scriptPath, '--model', this.modelPath];
    if (this.adapter) args.push('--adapter', this.adapter);
    this.child = this.spawnImpl(this.python, args, {stdio: ['pipe', 'pipe', 'pipe']});
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      // stderr 是日志通道。只留尾部若干行，健康检查要能把它显示出来。
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) this.stderrLines.push(line.trim());
      }
      if (this.stderrLines.length > 50) this.stderrLines.splice(0, this.stderrLines.length - 50);
    });
    this.child.on('exit', (code, signal) => {
      this.child = null;
      this.ready = null;
      // 进程死了，所有在途请求必须**立刻**失败，而不是等各自的超时。
      for (const [, entry] of this.pending) {
        entry.reject(Object.assign(new Error(`本地推理进程退出（code=${code} signal=${signal}）`),
          {code: 'crashed'}));
      }
      this.pending.clear();
    });
    this.ready = this._awaitReady();
    return this.ready;
  }

  _awaitReady() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.stderrLines.some((line) => line.includes('"event": "ready"'))) {
          clearInterval(timer);
          resolve({ready: true, stderr: this.stderrLines.slice(-5)});
        } else if (!this.child) {
          clearInterval(timer);
          reject(Object.assign(new Error('本地推理进程在就绪前退出'), {code: 'crashed'}));
        } else if (Date.now() - started > this.readyTimeoutMs) {
          clearInterval(timer);
          reject(Object.assign(new Error(`本地推理进程 ${this.readyTimeoutMs}ms 内未就绪`), {code: 'ready-timeout'}));
        }
      }, 50);
      timer.unref?.();
    });
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this._dispatch(line);
      index = this.buffer.indexOf('\n');
    }
  }

  _dispatch(line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      // 非 JSON 输出：不能猜，记一条错误并丢掉这一行。
      this.stats.errors += 1;
      return;
    }
    const entry = this.pending.get(payload.id);
    if (!entry) return;
    this.pending.delete(payload.id);
    clearTimeout(entry.timer);
    entry.resolve(payload);
  }

  /**
   * 一次生成。**超时/取消/崩溃都会 reject**，由调用方决定回退——
   * 这里不吞错、也不返回空字符串冒充成功。
   */
  async generate({system = null, messages = null, prompt = null, maxTokens = null,
                  temperature = 0, timeoutMs = null, signal = null, enableThinking = false} = {}) {
    await this.start();
    const budget = timeoutMs === null ? this.timeoutMs : timeoutMs;
    await this.gate.acquire();
    try {
      if (signal?.aborted) {
        this.stats.cancelled += 1;
        throw Object.assign(new Error('已取消'), {code: 'cancelled'});
      }
      const id = `r${++this.counter}`;
      const body = JSON.stringify({
        id,
        ...(system ? {system} : {}),
        ...(messages ? {messages} : {}),
        ...(prompt !== null ? {prompt} : {}),
        max_tokens: maxTokens === null ? this.maxTokens : maxTokens,
        temperature,
        enable_thinking: enableThinking,
      });
      this.stats.requests += 1;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.stats.timeouts += 1;
          reject(Object.assign(new Error(`本地模型 ${budget}ms 内没有返回`), {code: 'timeout'}));
        }, budget);
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          this.stats.cancelled += 1;
          reject(Object.assign(new Error('已取消'), {code: 'cancelled'}));
        };
        signal?.addEventListener?.('abort', onAbort, {once: true});
        this.pending.set(id, {
          resolve: (payload) => { signal?.removeEventListener?.('abort', onAbort); resolve(payload); },
          reject: (error) => { signal?.removeEventListener?.('abort', onAbort); reject(error); },
          timer,
        });
        try {
          this.child.stdin.write(`${body}\n`);
        } catch (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(Object.assign(new Error(`写入推理进程失败：${error.message}`), {code: 'crashed'}));
        }
      });
      if (!result.ok) {
        this.stats.errors += 1;
        throw Object.assign(new Error(result.message || '本地模型返回失败'),
          {code: result.error_type || 'model-error', detail: result});
      }
      this.stats.ok += 1;
      this.stats.lastLatencyMs = result.total_ms ?? null;
      return result;
    } finally {
      this.gate.release();
    }
  }

  /** 健康检查：真的跑一次最短的生成，而不是只看进程在不在。 */
  async healthcheck({probe = '回答一个字：好', timeoutMs = null} = {}) {
    const started = Date.now();
    const identity = localModelIdentity({ROCO_LOCAL_PYTHON: this.python, ROCO_LOCAL_MODEL_PATH: this.modelPath});
    try {
      const result = await this.generate({prompt: probe, maxTokens: 8, temperature: 0,
        timeoutMs: timeoutMs === null ? Math.max(this.timeoutMs, 10000) : timeoutMs});
      return {
        ok: true, ...identity,
        wall_ms: Date.now() - started,
        first_token_ms: result.first_token_ms,
        total_ms: result.total_ms,
        tokens_per_second: result.tokens_per_second,
        peak_memory_gb: result.peak_memory_gb,
        memory_source: result.memory_source,
        text: result.text,
        stats: {...this.stats},
      };
    } catch (error) {
      return {ok: false, ...identity, wall_ms: Date.now() - started,
        error_code: error.code || 'unknown', error: error.message,
        stderr: this.stderrLines.slice(-5), stats: {...this.stats}};
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const [, entry] of this.pending) {
      entry.reject(Object.assign(new Error('已停止'), {code: 'cancelled'}));
    }
    this.pending.clear();
    if (!child) return;
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      try { child.stdin.end(); } catch { /* 已经关了就算了 */ }
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000);
      killer.unref?.();
    });
  }
}

/**
 * 用本地模型承担**工具选择**（runtime 的 `provider.plan` 契约）。
 *
 * 契约很窄，而且失败方向是**关**的：
 *   - 只允许模型输出 `{"tool":"<已注册工具名>","args":{...}}` 或 `{"stop":true}`；
 *   - 工具名不在 `tools` 里 → 当作 `{stop:true}`（不是报错、更不是猜一个）；
 *   - JSON 解析失败、超时、模型不可用 → 一律 `{stop:true}`，
 *     让 runtime 拿已有证据作答，而不是卡在「模型决定不了」。
 *
 * 为什么失败要偏向 stop：多查一次工具只是慢一点，而**猜**一个工具或参数
 * 会让回执与问题无关（本项目已经踩过：期望参数写成工具不接受的键）。
 * 所以宁可少查，不可乱查。
 */
export function createLocalPlan({model, tools, timeoutMs = 1200, maxTokens = 160, temperature = 0} = {}) {
  if (!Array.isArray(tools) || !tools.length) throw new Error('createLocalPlan 需要 tools 列表');
  const allowed = new Set(tools);
  const system = [
    '你在为游戏教练决定「下一步查不查工具、查哪个」。只输出一行 JSON，不要解释，不要思考过程。',
    `可用工具：${tools.join(' / ')}。`,
    '需要查证时输出 {"tool":"工具名","args":{...}}；证据已经足够时输出 {"stop":true}。',
    '**默认是停止。** receipts 里已经有的事实不要再查；不确定就输出 {"stop":true}。',
    '工具名必须是上面列出的之一；参数必须是该工具契约里存在的键。',
  ].join('');
  return {
    name: 'mlx-local-plan',
    lastDecision: null,
    async plan(task) {
      const user = JSON.stringify({message: task?.message ?? null, receipts: task?.receipts ?? [],
        tools: task?.tools ?? tools, contracts: task?.contracts ?? null, remaining: task?.remaining ?? null});
      let text;
      try {
        const result = await model.generate({system, prompt: user, maxTokens, temperature, timeoutMs});
        text = result.text;
      } catch (error) {
        this.lastDecision = {decision: 'stop', reason: error.code || 'unknown'};
        return {stop: true};
      }
      const parsed = extractJson(text);
      if (!parsed || typeof parsed !== 'object') {
        this.lastDecision = {decision: 'stop', reason: 'unparseable', raw: String(text).slice(0, 120)};
        return {stop: true};
      }
      if (parsed.stop === true) {
        this.lastDecision = {decision: 'stop', reason: 'model-stop'};
        return {stop: true};
      }
      if (typeof parsed.tool !== 'string' || !allowed.has(parsed.tool)) {
        // 不认识的工具名不是「小问题」：它会让工具层直接判非法。
        // 这里当作停止，并把原始输出记下来供诊断。
        this.lastDecision = {decision: 'stop', reason: 'unknown-tool',
          tool: parsed.tool ?? null, raw: String(text).slice(0, 120)};
        return {stop: true};
      }
      const args = (parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args))
        ? parsed.args : {};
      this.lastDecision = {decision: 'call', tool: parsed.tool, args};
      return {tool: parsed.tool, args};
    },
  };
}

/** 从模型输出里抠出第一个 JSON 对象。抠不出来返回 null（不猜）。 */
export function extractJson(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * 把一个 provider 包成「本地优先、失败回退」。
 *
 * 这一层是 Agent **真实接入点**：`coach/client.js` 用它包住 DeepSeek 网关，
 * 于是 `ROCO_LOCAL_MODEL` 这一个开关就能切换路由，而不需要在 runtime 里
 * 加分支（runtime 完全不知道本地模型的存在，事实校验也不用改）。
 *
 * 三种模式的语义**必须分清**，否则 shadow 会被误读成「已经上线」：
 *   - `off`    ：原样返回 base，多一行代码都不走；
 *   - `shadow` ：**返回 base 的结果**（玩家看到的完全不变），
 *                另外跑一次本地模型并记下 `shadow` 记录，用来对比；
 *   - `on`     ：本地成功就用本地；超时/不可用/空输出 → base，并记 `lastFallback`。
 *
 * 无论哪种模式，`provider.name` 都保留 base 的名字，除非真的用了本地结果——
 * 这样 `runtime` 里「provider.name !== 'local'」那条判定与日志口径不会漂。
 */
export function wrapWithLocalModel(base, {model, mode = localModelMode(), maxTokens = DEFAULT_MAX_TOKENS,
  fallback = null, maxPromptChars = 8000} = {}) {
  if (mode === 'off') return base;
  const state = {lastFallback: null, shadow: null, localUsed: 0, localFailed: 0};
  const effectiveFallback = fallback || (async (packet) => base.generate(packet));
  const runLocal = async (packet) => {
    const text = typeof packet === 'string' ? packet : packet?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw Object.assign(new Error('证据包为空，不交给模型'), {code: 'empty-packet'});
    }
    if (text.length > maxPromptChars) {
      // 超长包直接不试：本地小模型在长上下文上又慢又容易跑偏，
      // 而且局内预算会被 context 处理吃掉。这里明确拒绝而不是截断后假装成功。
      throw Object.assign(new Error(`证据包 ${text.length} 字超过本地模型上限 ${maxPromptChars}`),
        {code: 'prompt-too-long'});
    }
    return model.generate({prompt: text, maxTokens, temperature: 0});
  };
  return {
    name: base.name,
    localMode: mode,
    get lastFallback() { return state.lastFallback; },
    get shadow() { return state.shadow; },
    get stats() { return {localUsed: state.localUsed, localFailed: state.localFailed}; },
    async generate(packet) {
      if (mode === 'shadow') {
        // 影子模式：先把 base 的结果定下来（这是玩家真正会看到的），
        // 再顺便跑一次本地。本地失败只记账，不影响返回。
        const result = await base.generate(packet);
        try {
          const local = await runLocal(packet);
          state.shadow = {at: Date.now(), local_text: local.text,
            local_total_ms: local.total_ms, local_first_token_ms: local.first_token_ms,
            base_text: typeof result === 'string' ? result : result?.text ?? null,
            identical: (typeof result === 'string' ? result : result?.text) === local.text};
        } catch (error) {
          state.shadow = {at: Date.now(), error_code: error.code || 'unknown', message: error.message};
        }
        return result;
      }
      try {
        const local = await runLocal(packet);
        if (typeof local.text !== 'string' || !local.text.trim()) {
          throw Object.assign(new Error('本地模型返回空文本'), {code: 'empty-output'});
        }
        state.localUsed += 1;
        state.lastFallback = null;
        return local.text;
      } catch (error) {
        state.localFailed += 1;
        state.lastFallback = {code: error.code || 'unknown', message: error.message, at: Date.now()};
        return effectiveFallback(packet);
      }
    },
  };
}

/**
 * runtime 的 provider 适配：把 `packet` 里的文字交给本地模型。
 *
 * `fallback` 是**必填**：没有它就没有降级路径，局内会卡住。
 * 失败时返回 fallback 的结果，并把失败原因放进 `lastFallback` 供日志与验收读取——
 * 静默降级等于把「本地模型根本没在工作」藏起来。
 */
export function createLocalProvider({model, fallback, mode = localModelMode(), maxTokens = DEFAULT_MAX_TOKENS} = {}) {
  if (typeof fallback !== 'function') throw new Error('createLocalProvider 需要 fallback（没有降级路径）');
  const provider = {
    name: 'mlx-local',
    mode,
    lastFallback: null,
    async generate(packet) {
      const text = typeof packet === 'string' ? packet : packet?.text;
      if (typeof text !== 'string' || !text.trim()) {
        provider.lastFallback = {code: 'empty-packet', at: Date.now()};
        return fallback(packet);
      }
      try {
        const result = await model.generate({prompt: text, maxTokens, temperature: 0});
        provider.lastFallback = null;
        return result.text;
      } catch (error) {
        provider.lastFallback = {code: error.code || 'unknown', message: error.message, at: Date.now()};
        return fallback(packet);
      }
    },
  };
  return provider;
}
