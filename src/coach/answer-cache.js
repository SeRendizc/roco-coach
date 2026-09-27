// RC-901 R4：「回答缓存 + 同局去重」的**纯逻辑**（规划出处 `docs/roadmap/MODEL-ROUTING-PLAN.md` §2.3）。
//
// 规划原文（建议新增第 1、2 条）：
//   · 「**回答缓存**：key = `stateToken + role + message 摘要 + 工具回执摘要 + 提示摘要`；
//      命中直接返回并标 `cache:'hit'`。**反证**：改 `stateToken` 必须 miss
//      （否则会把上一局的答案发给下一局）。」
//   · 「**同局去重**：同一 `stateToken` 下同一 `role` 的重复请求合并…… **反证**：两个不同消息不许合并。」
//
// ⚠ 与规划的一处**如实偏差**：`工具回执摘要` 与 `提示摘要`（如果指"这一轮实际发出去的那份 packet"）
// 在**请求进来时还不知道** —— 它们要跑完工具循环才存在。所以这里的 key 用**请求侧可知**的身份：
// `stateToken + role + message + 上下文身份（版本/配置/模式）+ 模型 + 提示摘要（计划器提示的那颗钉）`。
// 工具回执摘要没法进 key，于是**只缓存"这一轮真的走了云端且通过了守卫"的答案**（见 `shouldCache`），
// 这样"同一 key 两次请求拿到同样工具回执"这件事由 `stateToken`（局面版本）本身保证。
//
// 纪律：本模块**不读环境变量、不做 I/O、不调模型**；`clock` 由调用方注入（判据才能控时间）。

/** 提示摘要（计划器提示的那颗钉）：换提示词必须 miss。 */
export const PROMPT_DIGEST = 'fbdcff009e44fe7286e8d327c46ab3221552b7147372360158aeb85a61ec471b';

/** 缓存默认存活时间：60 秒。理由：`stateToken` 是**局面版本**，同一局里 60 秒内重复问同一句才值得复用；
 *  跨局一定会因为 `stateToken` 变而 miss（那是反证要钉死的那条）。 */
export const DEFAULT_TTL_MS = 60_000;

/** 缓存条数上限（超出按插入顺序淘汰最老的）。 */
export const DEFAULT_MAX_ENTRIES = 64;

/** FNV-1a：确定性、纯 JS、不引 `node:crypto`（与 `runtime.js` 的 `argsFingerprintOf` 同一种做法）。 */
export function digestOf(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 这一问的缓存身份。**每一个字段变了都必须 miss**（判据逐字段表格化）。
 *
 * `context` 只取**身份**不取全量（全量大、且含会变的字段）：模式 / 规则配置 / 规则版本 / 状态版本。
 */
export function answerCacheKey({stateToken = null, role = 'auto', message = '', context = null,
                                model = '', rulesVersion = '', promptDigest = PROMPT_DIGEST} = {}) {
  const identity = {
    stateToken: stateToken ?? null,
    role,
    message: String(message),
    mode: context?.mode ?? null,
    rulesetConfigId: context?.ruleset_config_id ?? context?.rulesetConfigId ?? null,
    rulesVersion,
    model,
    promptDigest,
  };
  return `${digestOf(identity)}`;
}

/** 建一个带 TTL 与容量上限的缓存。`clock` 注入是为了判据能"把时间拨过去"。 */
export function createAnswerCache({ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES,
                                   clock = () => Date.now()} = {}) {
  const rows = new Map();
  const stats = {hit: 0, miss: 0, expired: 0, evicted: 0, stored: 0, skipped: 0};
  return {
    stats,
    get size() { return rows.size; },
    get(key) {
      const row = rows.get(key);
      if (!row) { stats.miss += 1; return null; }
      if (clock() - row.at > ttlMs) {
        rows.delete(key);
        stats.expired += 1;
        stats.miss += 1;
        return null;
      }
      stats.hit += 1;
      return row.value;
    },
    set(key, value) {
      rows.set(key, {at: clock(), value});
      stats.stored += 1;
      while (rows.size > maxEntries) {
        const oldest = rows.keys().next().value;
        rows.delete(oldest);
        stats.evicted += 1;
      }
      return value;
    },
    /** 记一条"这一轮没进缓存"（原因见 `shouldCache`），用于回执与统计。 */
    skip() { stats.skipped += 1; },
    /** 清空（断开连接 / 换模型时必须调：key 里没有凭据身份）。 */
    clear() { rows.clear(); },
  };
}

/**
 * 这一轮的答案**能不能进缓存**。
 *
 * 只缓存「**走了云端** + **通过守卫** + **不是降级**」的答案：
 *   · 降级/回退的正文是本地模板（本来就不花钱，缓存它没有任何收益，却会让一次偶发的失败**粘住**）；
 *   · 本地/策略路径同理（`provider` 不是云端模型名时没有省下任何调用）。
 * 换句话说：缓存的收益与它的合法性是同一件事 —— **省下的必须是一次真的云端调用**。
 */
export function shouldCache(answer = {}, {cloudProviderName = null} = {}) {
  if (!cloudProviderName) return false;
  if (answer.provider !== cloudProviderName) return false;
  if (answer.validation && answer.validation.valid === false) return false;
  if (answer.rejected === true) return false;
  return typeof answer.text === 'string' && answer.text.length > 0;
}
