// 本地模型网关的 `ask`：**一处实现**，模型臂与影子回放共用。
//
// 为什么不各写一份：`shadow-replay.mjs` 与 `build-agent-trajectories.mjs` 都要
// 「问一次网关、拿一段文本、超时如实失败」。两份实现必然在某次改动里漂移
// （超时默认值、错误包装、返回形状），而漂移的后果是两条链上的模型行为**不可比**，
// 却看不出来。这个仓库已经因为「同一条量在两处各写一遍」吃过好几次亏。
//
// 也不放在 `shadow-replay.mjs` 里再让轨迹生成器 import：那两个模块本来就互相 import
// （shadow-replay 用 build-agent-trajectories 的世界构造），再反向依赖就是**循环引用**。
// 抽成第三个模块，两边都只依赖它。
//
// 2026-09-24 追加：`deepseekAsk`。为什么加在这里而不是新写一个客户端的理由与上面同源 ——
// 「4B 与 DeepSeek 在同一提示集上比」要成立，两条臂的 **ask 形状必须一模一样**
// （同一个 system、同一份 prompt、同样的 per-call 超时口径、同样「拿不到就抛」）。
// 各写一份必然在某次改动里漂移，而漂移之后两边的数字**不可比却看不出来**。
//
// `deepseekAsk` 与产品侧（`src/server/index.js` 的 `/api/coach`）用的是同一个上游：
// `https://api.deepseek.com/chat/completions` + `model: deepseek-flash` + `thinking: disabled`。
// 它**多**返回 `usage`（真回执里的 token 数）与 `model`，好让成本能被复算而不是被估计。

/** 真实网关客户端：一次请求，带超时；拿不到就如实抛，由调用方记成失败。 */
export function gatewayAsk(baseUrl, {timeoutMs = 8000} = {}) {
  return async ({system = null, prompt, maxTokens = 96, temperature = 0, timeoutMs: perCall = null}) => {
    const controller = new AbortController();
    const budget = perCall === null ? timeoutMs : perCall;
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          messages: [...(system ? [{role: 'system', content: system}] : []),
            {role: 'user', content: prompt}],
          max_tokens: maxTokens, temperature, timeout_ms: budget,
        }),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error(payload?.error?.message || `HTTP ${response.status}`),
          {code: payload?.error?.code || 'http-error'});
      }
      return {text: payload.choices?.[0]?.message?.content ?? '', x_roco: payload.x_roco || null};
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 上游与产品侧一致；改这里等于改「对照实验里云端那一臂是谁」，必须显式。 */
export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-flash';

/**
 * 云端臂的 `ask`：与 `gatewayAsk` **同形状**（同名参数、同返回 `{text}`），
 * 只是把请求发到 DeepSeek，并额外带回 `usage` / `model` / 墙钟。
 *
 * 失败一律抛（HTTP 非 2xx、网络错、超时、空 choices）——不许用空字符串冒充成功：
 * 那样「云端答对了」与「云端根本没答」在产物里长得一样。
 *
 * 密钥由调用方给（默认读 `DEEPSEEK_API_KEY`），本模块**不读盘、不写盘**。
 */
export function deepseekAsk({apiKey = process.env.DEEPSEEK_API_KEY, model = DEEPSEEK_MODEL,
  url = DEEPSEEK_URL, timeoutMs = 60000} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('deepseekAsk 需要密钥：设 DEEPSEEK_API_KEY 或显式传入 apiKey');
  }
  return async ({system = null, prompt, maxTokens = 96, temperature = 0, timeoutMs: perCall = null}) => {
    const controller = new AbortController();
    const budget = perCall === null ? timeoutMs : perCall;
    const timer = setTimeout(() => controller.abort(), budget);
    const started = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`},
        body: JSON.stringify({
          model,
          messages: [...(system ? [{role: 'system', content: system}] : []),
            {role: 'user', content: prompt}],
          max_tokens: maxTokens, temperature,
          stream: false, thinking: {type: 'disabled'},
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      const payload = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error(payload?.error?.message || `HTTP ${response.status}`),
          {code: payload?.error?.code || 'http-error', status: response.status});
      }
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw Object.assign(new Error('云端回执里没有 choices[0].message.content'),
          {code: 'empty-response'});
      }
      return {text, usage: payload.usage ?? null, model: payload.model ?? model,
        wall_ms: Date.now() - started, upstream_url: url};
    } finally {
      clearTimeout(timer);
    }
  };
}
