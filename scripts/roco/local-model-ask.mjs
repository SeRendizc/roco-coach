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
