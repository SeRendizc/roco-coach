/**
 * 纯文本落点用的"去 markdown 记号"（2026-09-26）。
 *
 * 背景（审计 R6）：文案里写 `**加粗**` 是有意的（很多界面走 `markdown()` 渲染），
 * 但**不是每个落点都渲染 markdown**：`textContent = …`、HTML 文本节点、`escape()` + 裸 `innerHTML`
 * 这几类会把星号原样显示给玩家。审计的原话是「判 R6 必须看落点，不能看字符串」——
 * 所以这里不删文案里的标记，而是在**不渲染的落点**上过一道 `plain()`。
 *
 * 判据：`tests/roco-plain-speak.test.js` ⑥（HTML 文本节点里不许有 `**`；这几处落点必须过 `plain()`）。
 */
export function plain(text) {
 return String(text ?? '')
  .replace(/\*\*([^*]+)\*\*/g, '$1')   // **加粗** → 加粗
  .replace(/`([^`]+)`/g, '$1')         // `行内码` → 行内码
  .replace(/^#{1,6}\s+/gm, '');        // 行首的 # 标题记号
}
