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

/**
 * **名字的展示兜底**（2026-09-29，T3 复核抓到的口径不一致）。
 *
 * 为什么单独一个函数：`??` **只兜 `null` / `undefined`，不兜空串**——
 * 于是 `card.name ?? '未登记'` 在 `name: ''` 时会印出一个**空名字**（左边整块空白），
 * 而 `name: null` 时印「未登记」。**同一个"没有名字"，两种待遇**，与本仓
 * fail-closed（未知 ≠ 中性）的口径相反：**空串就是"没有"**。
 *
 * 实测背景（T3 `task-7`）：CDP 把回执里的名字改成 `null` 与 `''` 两种形状，
 * `null` → 组头写「未登记」（好），`''` → **连组头都不写**，实例行名字为空。
 * 今天的数据里没有空串（T3 扫 `data/roco/normalized/**` 3242 个 name/title/species_name，**0 命中**）
 * ⇒ **今天不可达、一改数据就现形** —— 属于"口径不一致"，不是已发生的故障。**该修**，理由同上。
 *
 * @returns {string} 有名字就给名字（原样，不 trim 内容只判空）；没有就给 `fallback`。
 */
export function nameOr(text, fallback = '未登记') {
  const one = typeof text === 'string' ? text : (text === null || text === undefined ? '' : String(text));
  return one.trim() ? one : fallback;
}
