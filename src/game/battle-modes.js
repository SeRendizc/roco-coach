/**
 * 战斗模式的 id —— `data/roco/battle-modes.json` 的 `modes[].id`。
 *
 * 为什么单独一个模块、而不是各层各写一遍字面量：
 *   · 这个 id 是**跨界的事实**：服务端按它选模式（`roco-service.js` 的阵容工坊）、
 *     客户端开局按它发请求（`roco.js` 的 `/api/roco/reset`）、教练问规则策略时按它
 *     解析绑定的规则配置（`runtime.js` 的 policy 读口）；
 *   · 三处各抄一份字面量 ⇒ 登记表里换了绑定，页面还在按老 id 开局（RC-105 就是这么
 *     让标准 PVP 一度跑在「没有魔力系统」的 v2 上）。所以只留**一处**。
 *
 * 注意它**只是 id**：绑定哪份规则配置由引擎读登记表解析
 * （`roco/src/roco_env/rule_config.py` 的 `bound_config_id_for_mode`），
 * JS 这边**不许**再抄一份「模式 → 配置」的映射。
 *
 * 这个模块必须浏览器安全（`src/client/roco.js` 会 import 它）：零依赖、无 Node API。
 */
export const STANDARD_PVP_MODE_ID='pvp-standard-six-pet';
