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

/** 像工程记号的行：花括号/等号赋值、源码路径、内部模块名、内部编号、snake_case 常量。 */
// ⚠ 2026-09-29 补（`coach-context` 报、Lead 复核后拍板）：加 `\bev:`。
// 依据行的**原始出处 id** 形如 `ev:roco-world-s4-2026-09-10:pets#pet_000225`，是工程串，
// 不该给玩家看（哪怕它在可展开的「依据」块里）。
// **只滤 id、不动正文**：玩家读到的「（依据：游戏图鉴的相性表 火系 那一行，逐字抄录）」
// 是回答 `text` 的一部分（`runtime.js:1534`），而 `ev:` 来自**单独的** `evidence` 数组
// （`receipt.evidence_ids`）—— 两者不是同一行，所以这一改不会把人话一起滤掉。
// 旧正则留档：/[{}]|src\/|\bRULES\.|\bENGINE_[A-Z]|\bmemory\.|\b[a-z]{2,}_[a-z]{2,}(?:_[a-z]{2,})?\b|=\s*\S/
const INTERNAL = /[{}]|src\/|\bRULES\.|\bENGINE_[A-Z]|\bmemory\.|\bev:|\b[a-z]{2,}_[a-z]{2,}(?:_[a-z]{2,})?\b|=\s*\S/;

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
  (INTERNAL.test(text) ? internal : shown).push(text);
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
