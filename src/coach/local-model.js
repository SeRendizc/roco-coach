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

// ── 4B 权重目录的环境变量名：**唯一事实源**（2026-09-25，审计 ENV-001）──────────
//
// 事实（审计实测）：面板 `src/server/index.js` 曾经只认 `ROCO_LOCAL_MODEL_4B_PATH`
// 并把它印给用户看，而**运行时真正读的是** `ROCO_LOCAL_MODEL_PATH`（本文件）。
// 结果是双向谎报：按面板提示设变量 ⇒ 面板说「已连」而 LocalModel 仍回落到默认目录；
// 正确设 `..._MODEL_PATH` 的用户 ⇒ 面板说「没设」且 connected:false。
//
// 纪律：面板与运行时**只允许**从下面这两个常量取名，谁也不许再各读各的。
//   · 真名（canonical）：`ROCO_LOCAL_MODEL_PATH`
//   · 兼容别名（alias）：`ROCO_LOCAL_MODEL_4B_PATH`（旧面板用过的名字，仍接受但**不宣传**）
export const LOCAL_MODEL_PATH_ENV = 'ROCO_LOCAL_MODEL_PATH';
export const LOCAL_MODEL_PATH_ALIASES = Object.freeze(['ROCO_LOCAL_MODEL_4B_PATH']);

/**
 * 取 4B 权重目录：真名优先，兼容别名兜底。
 *
 * 空串按「没设」处理（`ROCO_LOCAL_MODEL_PATH=` 不该把别名也一起吃掉）。
 * 返回 `source` 是为了让面板能**如实说明**这份配置是从哪个变量名读到的 ——
 * 用户按旧名字设了东西时必须看得见「你用的是别名」，否则下次还会踩同一个坑。
 */
export function localModelPathFromEnv(env = process.env) {
  const read = (key) => {
    const raw = String(env?.[key] ?? '').trim();
    return raw ? {value: raw, source: key} : null;
  };
  const canonical = read(LOCAL_MODEL_PATH_ENV);
  if (canonical) return canonical;
  for (const alias of LOCAL_MODEL_PATH_ALIASES) {
    const hit = read(alias);
    if (hit) return hit;
  }
  return {value: null, source: null};
}

/** 局内预算：约 3 秒。超时不是异常路径，是**设计的一部分**。 */
export const DEFAULT_TIMEOUT_MS = 3000;
export const DEFAULT_MAX_TOKENS = 256;

/**
 * 默认适配器（人类 2026-09-26：「默认是空就做成真真的产品呀」）。
 *
 * 为什么是 v8：它是目前**唯一两把尺子都最好**的 arm（老门禁 282/288 = 97.9%、新切片 17/20 = 85%），
 * 而 v3/v4/v5/v6/v7 各有各的坑（见台账 §C6.281–§C6.286）。
 * **只在目录真的存在时才用**：适配器目录不在（换机器/被清掉）就退回底模，
 * 而不是让加载直接失败 —— 缺文件不该把整条本地链路打死。
 */
export const DEFAULT_ADAPTER_NAME = 'qwen35-4b-tool-v8';
export const DEFAULT_ADAPTER_IF_PRESENT = (() => {
  try {
    const url = new URL(`../../.models/adapters/${DEFAULT_ADAPTER_NAME}`, import.meta.url);
    return existsSync(url) ? url.pathname : null;
  } catch { return null; }
})();
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
    model: localModelPathFromEnv(env).value || DEFAULT_MODEL_DIR,
    adapter: env.ROCO_LOCAL_ADAPTER || DEFAULT_ADAPTER_IF_PRESENT,
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
    modelPath = localModelPathFromEnv(process.env).value || DEFAULT_MODEL_DIR,
    adapter = process.env.ROCO_LOCAL_ADAPTER || DEFAULT_ADAPTER_IF_PRESENT,
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
/**
 * 本地模型的**输出契约**（2026-09-27，人类 ⑤：「不许输出英语然后正则删掉」）。
 *
 * 那条路的毛病不是"删不干净"，是**方向错了**：先让模型随便写、再拿正则去修它的输出，
 * 等于把"合格"定义成"我事后能修补"。这里的做法相反：
 *   · 先说清要什么（**只输出一个 JSON 对象**：`answer` + `basis`）；
 *   · 拿到之后**按契约校验**，不合格就是不合格 —— **不修剪、不救场**，如实降级并记账；
 *   · 于是"成功率 / 违规率 / 降级率"是可以报出来的数，而不是感觉。
 *
 * ⚠ `answer` 里出现成串的 Latin 字母 = **违规**（真机实测：4B 会把 `roster_total`、`hp` 念给玩家）。
 * 修法是"让它别写"（材料洗干净 + 契约里写死），**不是"它写了我们删掉"**。
 */
export const LOCAL_OUTPUT_CONTRACT = {
  version: 'local-answer/v1',
  instruction: [
    '只输出一个 JSON 对象，不要代码块、不要多余的字。',
    '字段：{"answer": "给玩家看的两到四句口语回答", "basis": ["你引用了材料里的哪几条，短句"]}。',
    'answer 里不许出现英文字母组成的词（例如 hp、roster_total 这类），也不许出现星号、井号、反引号。',
    '材料里没有的数字不要写；写不出就照实说没有。',
  ].join(''),
  maxAnswerChars: 160,
  maxBasisItems: 4,
};

const ASCII_WORD = /[A-Za-z]{2,}/;
const MARKDOWN_MARK = /[*#`_]{1,}|\*\*/;

/**
 * 按契约校验一段模型输出。**不修**：不合格就返回原因，由调用方如实降级。
 * 返回 `{ok:true, value:{answer, basis}}` 或 `{ok:false, code, detail}`。
 */
export function parseLocalOutput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return {ok: false, code: 'empty-output', detail: '模型没有输出任何内容'};
  // 只容忍**整段被包在代码块里**这一种常见形式（剥壳，不是修内容）
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return {ok: false, code: 'not-json', detail: `输出不是 JSON 对象：${text.slice(0, 60)}`};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {ok: false, code: 'not-object', detail: '输出的 JSON 不是一个对象'};
  }
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  if (!answer) return {ok: false, code: 'missing-answer', detail: 'JSON 里没有 answer 字段（或它是空的）'};
  if (answer.length > LOCAL_OUTPUT_CONTRACT.maxAnswerChars) {
    return {ok: false, code: 'answer-too-long',
      detail: `answer ${answer.length} 字超过上限 ${LOCAL_OUTPUT_CONTRACT.maxAnswerChars}`};
  }
  if (ASCII_WORD.test(answer)) {
    return {ok: false, code: 'latin-leak',
      detail: `answer 里有英文字母词：${answer.match(ASCII_WORD)?.[0]}`};
  }
  if (MARKDOWN_MARK.test(answer)) {
    return {ok: false, code: 'markdown-leak', detail: 'answer 里有星号/井号/反引号'};
  }
  const basis = Array.isArray(parsed.basis)
    ? parsed.basis.filter((row) => typeof row === 'string' && row.trim()).slice(0, LOCAL_OUTPUT_CONTRACT.maxBasisItems)
    : [];
  return {ok: true, value: {answer, basis}};
}

/**
 * 交给本地 4B 的**系统约定**（2026-09-26 加性新增）。
 *
 * 修前的实情：`runLocal` 只把 `packet.text`（3–25 字的引擎草稿）原样当 prompt 发给模型，
 * 既没有玩家问的是什么，也没有"你该输出什么"。真机实测（`/tmp/fourb/fourb.mjs`）：
 * 冷启 5135 ms 后模型回的是「您似乎只输入了我在。」——它没有坏，是**没人告诉它要干什么**。
 * 这一条与下面的 `localPrompt` 一起把"玩家的问题 + 引擎事实 + 输出要求"凑成一个能答的问句。
 */
export const LOCAL_SYSTEM_PROMPT = [
  '你是《洛克王国：世界》里跟着玩家一起打的新手教练，名字叫小芽，说话像队友，不像说明书。',
  '用两到四句口语回答玩家的问题，第一句直接给答案，不要标题、不要编号、不要 Markdown、不要复述材料。',
  '数字只能引用材料里给的；材料里没有的数字（例如胜率、概率）就说没有，不许自己算一个。',
  // 2026-09-26 加这一条的理由是**真机实测**：4B 把材料里的英文字段名照抄进了回答
  // （「先把你 roster 里的角色按属性配好」——`roster_total` 直接漏到玩家眼前）。
  '材料里的数字可以直接引用，但不要照抄英文词或符号（材料已经尽量换成中文了，剩下的英文就不再念出来）。',
  // 2026-09-27（人类 ⑤）：把"要什么格式"写死在提示里，并由 `parseLocalOutput` **校验**；
  // 不合格就如实降级 —— 不再"先让它写，再拿正则删"。
].join('') + LOCAL_OUTPUT_CONTRACT.instruction;

/**
 * 把证据包编成**一句人话问句**。至少要有玩家原话，其次是引擎给的事实与建议，最后是输出要求。
 *
 * `maxChars` 只裁「依据」这些长尾，**永不裁玩家原话与引擎草稿**——那两段是答案的骨头，
 * 裁掉就等于又回到"模型不知道在答什么"的老路（这正是加这一层的原因）。
 */
/**
 * 把要交给模型的**材料**翻译成人话（2026-09-26 加性新增，真机实测逼出来的）。
 *
 * 为什么不能只靠提示词：先在系统约定里写了一条"英文字段名要换成中文"，真机复测 4B 反而
 * **照抄得更凶**（冷启 5.4s 的答案是「先确认你 roster_total 里的 48 只，再按 hp 和 spe 选最强的」）。
 * 4B 跟着材料走、不跟着约定走 ⇒ 只能由代码把材料洗干净：证据行里本来就带着
 * `profile.pets`、`roster_total`、`**` 这些工程记号（那是**给人看的内部说明**），
 * 模型看不懂就会原样吐给玩家。这里在**发出之前**把它们换成中文说法。
 */
const FIELD_WORDS = new Map(Object.entries({
 profile: '名单', pets: '精灵', pool_summary: '候选池', roster_total: '名单总数', total: '总数',
 battle: '对局', turn: '回合', hp: '血量', atk: '攻击', def: '防御', spa: '魔攻', spd: '魔防', spe: '速度',
 types: '属性', role: '定位', stats: '面板', energy: '能量', level: '等级', skills: '技能', evidence: '依据',
 focus: '当前这只', lineage: '血脉', mechanism: '机制', lineup: '出战阵容',
}));

export function plainForModel(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')             // 星号加粗：材料里的记号，念出来就是噪音
    .replace(/`([^`]+)`/g, '$1')
    .replace(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)/g,
      (whole) => FIELD_WORDS.get(whole.split('.').pop()) ?? '名单里的这一项')
    .replace(/\b([a-z][a-z0-9]*_[a-z0-9_]+)\b/g, (whole) => FIELD_WORDS.get(whole) ?? '这一项')
    // 光杆字段名（`hp`/`spe` 这种）也要换：真机实测里 4B 就是照抄了「按 hp 和 spe 选最强的」。
    .replace(/\b(hp|atk|def|spa|spd|spe|types|role|stats|level|energy)\b/g,
      (whole) => FIELD_WORDS.get(whole) ?? whole)
    .replace(/[（(]\s*[）)]/g, '')                 // 上面替换掉的词如果带括号，别留个空括号
    .replace(/[ \t]{2,}/g, ' ')
    // 上面每种替换都可能留下一个空格（「按 hp 和 spe」→「按血量 和 速度」），
    // 所以**放在最后**统一收：中文之间不留空格。放前面等于白做（第一版就是这么错的）。
    .replace(/([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1');
}

export function localPrompt(packet, {maxChars = 4000} = {}) {
  if (typeof packet === 'string') return packet;          // 老调用：纯字符串包原样透传
  const message = typeof packet?.message === 'string' && packet.message.trim() ? packet.message.trim() : null;
  // 材料一律先过 `plainForModel`；**玩家原话一个字都不动**（那是他自己打的字，不是我们的材料）。
  const draft = plainForModel(typeof packet?.text === 'string' ? packet.text.trim() : '');
  const evidence = (Array.isArray(packet?.evidence) ? packet.evidence : [])
    .map(plainForModel).filter((row) => row.trim()).slice(0, 6);
  const head = [];
  if (message) head.push(`玩家问：${message}`);
  if (draft) head.push(`引擎给出的事实与建议：${draft}`);
  const tail = '请照上面的约定回一句给玩家。';
  const fixed = [...head, tail].join('\n').length;
  const kept = [];
  let used = fixed;
  for (const row of evidence) {
    // 依据按剩余预算逐条收，收不下就停 —— 不截半句（半句话比没有更容易让模型跑偏）。
    if (used + row.length + 3 > maxChars) break;
    kept.push(row); used += row.length + 3;
  }
  const lines = [];
  if (kept.length) lines.push(`依据：\n- ${kept.join('\n- ')}`);
  lines.push(...head, tail);
  return lines.join('\n');
}

export function wrapWithLocalModel(base, {model, mode = localModelMode(), maxTokens = DEFAULT_MAX_TOKENS,
  fallback = null, maxPromptChars = 8000} = {}) {
  if (mode === 'off') return base;
  // `contractViolations`：模型答了、但**没按输出契约**答的次数（单独记账，不许混进 localFailed ——
  // 「没答」和「答了但不合格」是两件事，报告里要分得开）。
  const state = {lastFallback: null, shadow: null, localUsed: 0, localFailed: 0, contractViolations: 0};
  const effectiveFallback = fallback || (async (packet) => base.generate(packet));
  const runLocal = async (packet) => {
    const text = typeof packet === 'string' ? packet : packet?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw Object.assign(new Error('证据包为空，不交给模型'), {code: 'empty-packet'});
    }
    // 超长包直接不试：本地小模型在长上下文上又慢又容易跑偏，
    // 而且局内预算会被 context 处理吃掉。这里明确拒绝而不是截断后假装成功；
    // 长度判定挪到编好问句之后（见下），否则量的是草稿、永远量不出真长度。
    const prompt = localPrompt(packet);
    if (prompt.length > maxPromptChars) {
      // 裁的是**编好的问句**，不是草稿：修前这里量的是 3–25 字的草稿，
      // 于是无论证据多长都判"不长"。现在量的是真正会发出去的那段文字。
      throw Object.assign(new Error(`本地模型问句 ${prompt.length} 字超过上限 ${maxPromptChars}`),
        {code: 'prompt-too-long'});
    }
    const result = await model.generate({system: LOCAL_SYSTEM_PROMPT, prompt, maxTokens, temperature: 0});
    // 按契约校验；**不修剪**：不合格就是不合格，交给下面的降级路径如实记账。
    const checked = parseLocalOutput(typeof result === 'string' ? result : result?.text);
    if (!checked.ok) {
      state.contractViolations += 1;
      throw Object.assign(new Error(`本地模型没按输出契约回答（${checked.code}）：${checked.detail}`),
        {code: checked.code, contract: LOCAL_OUTPUT_CONTRACT.version});
    }
    return {...(typeof result === 'object' && result ? result : {}),
      text: checked.value.answer, basis: checked.value.basis, contract: LOCAL_OUTPUT_CONTRACT.version};
  };
  return {
    // 2026-09-26 修（人类问「4b 接入了吗？」——答案是**没有**，根因就在这一行）：
    // 原来无论哪一档都 `name: base.name`。而 `on` 档的 base 是 `localProvider`（name='local'），
    // `runtime.js` 用 `provider.name!=='local'` 判"有没有模型" ⇒ **4B 的 generate 一次都不执行**，
    // 玩家拿到的是引擎模板（真机实测：on 档 8 问 0 次 4B、0 次云端，3 条只回了三个字「我在。」）。
    // 现在 on 档如实叫 `mlx-local`（它真的是模型）；shadow 档保留 base 的名字 —— 那一档玩家看到的结果
    // 来自 base，名字必须照旧，否则日志与判据口径都会漂。
    name: mode === 'on' ? 'mlx-local' : base.name,
    localMode: mode,
    get lastFallback() { return state.lastFallback; },
    get shadow() { return state.shadow; },
    get stats() { return {localUsed: state.localUsed, localFailed: state.localFailed,
      contractViolations: state.contractViolations}; },
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
    stats: {answerUsed: 0, contractViolations: 0},
    async generate(packet) {
      const text = typeof packet === 'string' ? packet : packet?.text;
      if (typeof text !== 'string' || !text.trim()) {
        provider.lastFallback = {code: 'empty-packet', at: Date.now()};
        return fallback(packet);
      }
      try {
        const result = await model.generate({system: LOCAL_SYSTEM_PROMPT, prompt: localPrompt(packet), maxTokens, temperature: 0});
        const checked = parseLocalOutput(typeof result === 'string' ? result : result?.text);
        if (!checked.ok) {
          // 同一套契约、同一种处理：**不修剪**，如实降级。
          provider.lastFallback = {code: checked.code, message: checked.detail, at: Date.now()};
          provider.stats.contractViolations += 1;
          return fallback(packet);
        }
        provider.lastFallback = null;
        provider.stats.answerUsed += 1;
        return checked.value.answer;
      } catch (error) {
        provider.lastFallback = {code: error.code || 'unknown', message: error.message, at: Date.now()};
        return fallback(packet);
      }
    },
  };
  return provider;
}
