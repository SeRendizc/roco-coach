// 「一行证据是**给玩家的**，还是**写给模型的**」——**唯一一份判据**。
//
// 为什么要有这个文件（2026-09-29，U08 真机抓到 + 监工点名）
// ----------------------------------------------------------
// `packet.evidence` 这个字段**兼作两种用途**：一半是给玩家看的依据，一半是**给模型的禁令/说明**
// （`src/coach/runtime.js:2224-2239` 那三处 `...(cond?{evidence:[...]}:{})` 追加的就是后者）。
// 判据 ⑦（`tests/roco-plain-speak.test.js`）早就点名了这件事，兜底写的是「客户端过滤先兜住」。
//
// 兜底当时落在 `src/client/evidence-view.js` 里 —— 那是**第二份实现**的风险：
// 服务端迟早也要在**回包边界**做同一件事（把给模型的话从给玩家的话里分出去），
// 到时候两边各写一条正则，就是本仓最贵的那种债（"同一件东西两份"）。
// 所以这里把判据**只写一遍**，放 `src/coach/`：服务端直接 import；
// 客户端通过 HTTP 也能 import 同一份（`src/coach/**` 是静态服务的，
// `roco.js` 已经在 import `../coach/roco-experience.js`）。
//
// 真机漏出去的两句（逐字，出现在小芽的「依据」折叠区里）：
//   「依据语气档位 R0（不说）：本机没有任何真实记录，不编造过去。…」
//   「本回合引擎已经算过一手：…**引用它不算"冒充引擎"**，也不必另找依据；引擎没给的
//     （例如胜率）**不许编**。」
// 两句都在对**写答案的那个人**说话，不是对玩家说话。
//
// 只咬**元话语**，不咬普通的「不许」——玩家文案里会有合法的否定句。

/**
 * 工程记号（`snake_case`、`src/`、花括号、`memory.` …）：这类行一直不给玩家看。
 * 原文自 `src/client/evidence-view.js`（这一条**没动**，只是搬过来与下面那条并排）。
 */
export const INTERNAL_EVIDENCE = /[{}]|src\/|\bRULES\.|\bENGINE_[A-Z]|\bmemory\.|\bev:|\b[a-z]{2,}_[a-z]{2,}(?:_[a-z]{2,})?\b|=\s*\S/;

/**
 * **行号型出处**（2026-09-29 本轮实测补上）。
 *
 * `docs/roco/GAME-ADAPTER.md` §7 第 1 条记着：**事件级 `evidence` 是行号**，不是 `…json#实体`。
 * 而原来的两条判据都盖不住这个形状 —— 实测（`playerEvidence` 直调）：
 * ```
 * '12'                                  → 保留
 * 'line 34'                             → 保留
 * 'events.json:34'                      → 保留     ← 典型的行号型出处
 * '#L12'                                → 保留
 * '第 3 回合对方补位（events.json 第 34 行）' → 保留
 * 'roco/src/roco_env/env.py:1508'       → 滤掉（命中 src/）
 * 'ev:…:pets#pet_000225'                → 滤掉（命中 ev:）
 * ```
 * ⇒ **只要引擎把出处给成"文件名:行号"，它就会原样摆到玩家的「依据」栏里**。
 * 这一条把那个形状也归到"不给玩家看"（调用方仍可把它放进日志/技术细节 —— 只分类，不删）。
 *
 * ⚠ 只咬**带文件名的行号**与 `#L12`、`第 N 行`，**不咬裸数字**：
 * 依据行里出现一个数字是正常的（判据也要求数字可核对），一律滤掉会误伤。
 */
export const LINE_REFERENCE_EVIDENCE =
  /\b[\w.-]+\.(?:json|py|js|mjs|lua|txt|md):\d+\b|#L\d+\b|第\s*\d+\s*行/;

/** 写给模型的**指令句**：点名作者/模型身份，或语气档位的内部抬头。 */
export const MODEL_INSTRUCTION_EVIDENCE =
  /冒充引擎|写给模型|引用它不算|不许编|不编造|也不必另找依据|依据语气档位\s*R\d/;

/** 这一行是不是**不该给玩家看**的（工程记号 或 写给模型的指令句）。 */
export function isModelFacingEvidence(line) {
  if (typeof line !== 'string') return false;
  const text = line.trim();
  if (!text) return false;
  return INTERNAL_EVIDENCE.test(text) || MODEL_INSTRUCTION_EVIDENCE.test(text)
    || LINE_REFERENCE_EVIDENCE.test(text);
}

/**
 * 把一组证据行分成两份：`player`（给玩家看的）与 `modelOnly`（只给模型/只进日志的）。
 * **不删、不改**任何一行 —— 只是分类，调用方决定怎么用（客户端不渲染 modelOnly，
 * 服务端将来可以把 modelOnly 从回包里分出去而**不动 `packet.evidence`**）。
 */
export function splitEvidenceLines(lines) {
  const player = [];
  const modelOnly = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line !== 'string') continue;
    if (!line.trim()) continue;
    (isModelFacingEvidence(line) ? modelOnly : player).push(line);
  }
  return {player, modelOnly};
}
