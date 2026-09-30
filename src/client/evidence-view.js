/**
 * 「依据」这一栏**给玩家看什么**（2026-09-26）。
 *
 * 背景：`packet.evidence` 这个数组身兼两职 —— ① 守卫拿它核对正文里的每个数字
 * （「数字必须能在证据里查到」），② 页面把它当"依据"展示给玩家。两者的读者不同：
 * 证据那一份是**写给自己人看的**（`RULES.guard={reduction:0.65,energy:1}`、`memory.events` 路径、
 * `tactic:poison` 这种内部编号），玩家要的是"你凭什么这么说"。
 * 真机审计（`/tmp/plain-speak/report.md`）把它记成"同一个数组兼作两种用途"，训练场那一页
 * 因此长期把工程串摊在玩家眼前。
 *
 * 这里只做一件可判定的事：**挑出人话那一部分**，把看着像工程记号的挑出去单独归类
 * （不是删——调用方仍可以把它们放进技术细节或日志）。判据见 `tests/roco-plain-speak.test.js`。
 */

// ⚠ 2026-09-29（本轮）：判据的**实现搬去了 `src/coach/evidence-lines.js`**，这里只 import。
// 为什么搬：这一条**服务端迟早也要用**（在回包边界把"给模型的话"从"给玩家的话"里分出去），
// 两边各写一条正则就是本仓最贵的那种债。放 `src/coach/` 是因为服务端直接 import 得了，
// 客户端也能 import 同一份（`src/coach/**` 是静态服务的，`roco.js` 已经在 import 它下面的模块）。
// 旧正则**原文留档**（别删；`INTERNAL` 那一条的内容与新的 `INTERNAL_EVIDENCE` 逐字相同）：
//   const INTERNAL = /[{}]|src\/|\bRULES\.|\bENGINE_[A-Z]|\bmemory\.|\bev:|\b[a-z]{2,}_[a-z]{2,}(?:_[a-z]{2,})?\b|=\s*\S/;
//   const MODEL_INSTRUCTION = /冒充引擎|写给模型|引用它不算|不许编|不编造|也不必另找依据|依据语气档位\s*R\d/;
import {isModelFacingEvidence} from '../coach/evidence-lines.js';

/**
 * 判据的**实现**现在只有一份：`src/coach/evidence-lines.js` 的 `isModelFacingEvidence()`。
 * 它把两类都咬住 —— ① 工程记号（`snake_case` / `src/` / `{}` / `memory.` / `ev:` …）；
 * ② **写给模型的指令句**（`冒充引擎` / `不许编` / `不编造` / `依据语气档位 R<n>` …）。
 * 真机漏出去的那两句逐字留档：
 *   「依据语气档位 R0（不说）：本机没有任何真实记录，不编造过去。…」
 *   「本回合引擎已经算过一手：…**引用它不算"冒充引擎"**，也不必另找依据；引擎没给的
 *     （例如胜率）**不许编**。」——都在对**写答案的那个人**说话，不是对玩家说话。
 */

/**
 * **写给模型的指令句**（2026-09-29，U08 真机在小芽面板抓到的真缺陷）。
 *
 * 为什么必须单独一条：`packet.evidence` 这个字段**兼作两种用途** —— 一半是给玩家看的依据，
 * 一半是**给模型的禁令/说明**。判据 ⑦（`tests/roco-plain-speak.test.js`）早就点名了这件事，
 * 当时的兜底是「客户端过滤先兜住」；而 `INTERNAL` 只认 snake_case 这类**工程记号**，
 * 认不出"祈使语气 + 元话语"这种**整句**。
 *
 * 真机漏出去的两句（逐字，来自 `src/coach/runtime.js:2238-2239`，出现在小芽的「依据」折叠区）：
 *   「依据语气档位 R0（不说）：本机没有任何真实记录，不编造过去。…」
 *   「本回合引擎已经算过一手：…**引用它不算"冒充引擎"**，也不必另找依据；引擎没给的
 *     （例如胜率）**不许编**。」
 * 两句都在对**写答案的那个人**说话，不是对玩家说话。
 *
 * 只咬**元话语**，不咬普通的「不许」（玩家文案里会有合法的否定句）：
 *   · 点名作者/模型身份：`冒充引擎`、`写给模型`、`引用它不算`、`不许编`、`不编造`；
 *   · 语气档位那句内部抬头：`依据语气档位 R<n>`。
 */
const MODEL_INSTRUCTION = /冒充引擎|写给模型|引用它不算|不许编|不编造|也不必另找依据|依据语气档位\s*R\d/;

/**
 * @param {unknown} lines 原始证据行（可能是任何东西，调用方不必先清洗）
 * @returns {{shown: string[], internal: string[]}}
 *   `shown` = 可以给玩家看的（人话）；`internal` = 看着像工程记号的（给日志/技术细节）。
 */
export function splitEvidence(lines) {
 const shown = [], internal = [];
 for (const line of Array.isArray(lines) ? lines : []) {
  if (typeof line !== 'string') continue;
  const text = line.trim();
  if (!text) continue;
  (isModelFacingEvidence(text) ? internal : shown).push(text);
 }
 return {shown, internal};
}

/**
 * 「依据」栏该显示的那几行：优先人话；一条人话都没有时给一句**如实**的兜底
 * （不假装有依据，也不把工程串端出去）。
 */
export function playerEvidence(lines) {
 const {shown} = splitEvidence(lines);
 if (shown.length) return shown;
 const hadInternal = splitEvidence(lines).internal.length > 0;
 // ⚠ 这句话必须**字面为真**：先前那版写的是「已记进排查日志」，而那些行只是被丢掉、
 // 什么都没记（我在自己的台账里也照抄了那句不准确的话）。所以这里只写「依据是什么」。
 return [hadInternal ? '依据是引擎的数据与规则表。'
  : '这一条没有额外的依据可展示。'];
}
