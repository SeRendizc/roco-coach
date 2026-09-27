// 云臂（DeepSeek）的**离线录制 / 回放**：把「真模型判据」变成不联网、不花钱、可进闸门的判据。
//
// 为什么需要它（2026-09-25 人类口径：「无预算限制，但也不要浪费」+「做真 agentic 的东西」）：
//   `scripts/eval-live-s04.js` 有 44 条预注册判据，跑一次要真调 DeepSeek；它**不在 24 套门禁里**，
//   于是云臂的输出质量**没有任何自动化守卫**：模型换了、提示改了、守卫放松了，闸门都看不见。
//   录制一次真跑（人工、有预算意识），之后每次门禁都**回放**同一批响应来复验守卫与判据。
//
// 一条硬口径：**回放模式下没命中指纹就抛错**（`CloudReplayMissError`）。
//   不许静默放行、不许回落到真网络 —— 否则「离线门禁」会在 CI 里偷偷变成真调用（烧钱且不可复现）。
//
// 指纹（键）= sha256( url + model + sha256(messages) + {max_tokens, stream, thinking} )。
//   **不含时间戳**：同一请求在任何时候都必须命中同一条录制。
//
// 本模块**不发网络请求**，除非调用方显式用 `record: true`（那时它把 `fetchImpl` 透传给真实现）。
import {createHash} from 'node:crypto';
import {appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

/** 录制目录默认落 /tmp：**真模型输出不进仓**（见 docs/roco/CLOUD-ARM-REPLAY.md 的理由）。 */
export const DEFAULT_DIR = process.env.ROCO_CLOUD_REPLAY_DIR || join(tmpdir(), 'roco-cloud-replay');
export const RECORD_FILE = 'cloud-arm.jsonl';
export const MISS_CODE = 'CLOUD_REPLAY_MISS';

export class CloudReplayMissError extends Error {
  constructor(key, dir) {
    super(`回放未命中指纹 ${key}（目录 ${dir}）—— 不许回落到真网络：`
      + '要么用 --record 补录这一条，要么把请求改成与录制一致');
    this.name = 'CloudReplayMissError';
    this.code = MISS_CODE;
    this.key = key;
    this.dir = dir;
  }
}

/** 从 URL 判「这是哪条臂」：只认 api.deepseek.com ⇒ deepseek；其余一律 other。 */
export function providerOf(url = '') {
  try { return new URL(url).host === 'api.deepseek.com' ? 'deepseek' : 'other'; } catch { return 'other'; }
}

/** 请求指纹（**不含时间戳**）。`body` 可以是 JSON 字符串或已解析对象。 */
export function fingerprintOf({url, body}) {
  const parsed = typeof body === 'string' ? JSON.parse(body) : (body ?? {});
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const messagesSha256 = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  const params = {
    max_tokens: parsed.max_tokens ?? null,
    stream: parsed.stream ?? null,
    thinking: parsed.thinking ?? null,
  };
  const key = createHash('sha256')
    .update(JSON.stringify({url, model: parsed.model ?? null, messages_sha256: messagesSha256, params}))
    .digest('hex');
  return {key, model: parsed.model ?? null, messages_sha256: messagesSha256, params,
    messages_count: messages.length, provider: providerOf(url)};
}

/** 读一个目录里的全部录制（`*.jsonl`，每行一条）。返回 `Map<key, entry>`。 */
export function loadRecordings(dir = DEFAULT_DIR) {
  const store = new Map();
  if (!existsSync(dir)) return store;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const text = readFileSync(join(dir, name), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      if (entry && typeof entry.key === 'string') store.set(entry.key, entry);
    }
  }
  return store;
}

/**
 * 把「可提交的合成样本」物化成一份 store（供测试与文档示例用）。
 *
 * `entries[]` 的形状（`tests/evals/fixtures/cloud-arm/*.json` 就是这个形状）：
 *   `{provider, url, model, request: {messages, params?}, response: {status, body}}`
 * 其中 `params` 只是**给人看的**（max_tokens/stream/thinking 已经写进 messages 之外的请求体里时，
 * 这里可以省）——真正的键一律由 `fingerprintOf()` 从 `{url, body}` 现算，绝不手写哈希。
 */
export function materializeStore(entries, dir) {
  mkdirSync(dir, {recursive: true});
  const written = [];
  for (const e of entries) {
    const body = {
      model: e.model ?? 'deepseek-flash',
      messages: e.request?.messages ?? [],
      ...(e.request?.params ?? {}),
    };
    const {key, messages_sha256, params, provider} = fingerprintOf({url: e.url, body});
    const entry = {
      key, url: e.url, provider: e.provider ?? provider, model: body.model,
      request: {messages_sha256, params, messages_count: body.messages.length, body},
      response: e.response ?? {status: 200, body: {}},
    };
    appendFileSync(join(dir, RECORD_FILE), JSON.stringify(entry) + '\n');
    written.push(entry);
  }
  return written;
}

/**
 * 造一个可注入的 `fetchImpl`（形状与 `complete()` 用的那个一致：`fetchImpl(url, init)`）。
 *
 * - `record: false`（默认，**回放**）：命中指纹 → 返回录制的响应；**没命中 → 抛 `CloudReplayMissError`**。
 * - `record: true`（**录制**）：真的调用底层 `fetchImpl`（默认全局 fetch），把
 *   `{key, url, provider, model, request, response, at}` 追加进 `<dir>/cloud-arm.jsonl`，并把同一份响应回给调用方。
 */
export function makeReplayFetch({dir = DEFAULT_DIR, record = false, fetchImpl = globalThis.fetch,
  clock = () => new Date().toISOString()} = {}) {
  const store = record ? null : loadRecordings(dir);
  const calls = [];
  let hits = 0;
  const fetchFn = async (url, init = {}) => {
    const fp = fingerprintOf({url, body: init?.body});
    calls.push({key: fp.key, url, model: fp.model, provider: fp.provider, messages_sha256: fp.messages_sha256});
    if (record) {
      const res = await fetchImpl(url, init);
      const body = await res.json();
      mkdirSync(dir, {recursive: true});
      const entry = {
        key: fp.key, url, provider: fp.provider, model: fp.model,
        request: {messages_sha256: fp.messages_sha256, params: fp.params,
          messages_count: fp.messages_count, body: JSON.parse(init.body)},
        response: {status: res.status, body}, at: clock(),
      };
      appendFileSync(join(dir, RECORD_FILE), JSON.stringify(entry) + '\n');
      return {ok: res.ok, status: res.status, headers: res.headers, json: async () => body};
    }
    const hit = store.get(fp.key);
    if (!hit) throw new CloudReplayMissError(fp.key, dir);
    hits += 1;
    const status = hit.response?.status ?? 200;
    const body = hit.response?.body ?? {};
    return {ok: status >= 200 && status < 300, status, headers: new Map(), json: async () => body};
  };
  return {
    fetchImpl: fetchFn, dir, mode: record ? 'record' : 'replay', calls,
    get stats() { return {mode: record ? 'record' : 'replay', calls: calls.length, hits,
      misses: calls.length - hits, recorded: store ? store.size : null}; },
  };
}
