// 台账六级（强 → 弱）与它们的中文标签 —— **只有这一份**。
//
// 为什么单独一个文件（2026-09-27，审计 ② 的收尾）：天气那条回答要把依据等级印给玩家看，
// 而原来这两个常量住在 `rag-index.js` 里 —— 那个文件顶部 `import 'node:fs'`，
// 浏览器里加载不了（`runtime.js` 是 `xiaoya.js` / `app.js` 也 import 的共享层）。
// 于是把它们挪到这个**不碰 node 内建**的小文件里，`rag-index.js` 原样再导出（外部 API 不变），
// 玩家可见的那一处从 `runtime.js` 直接 import —— 一份表，两个入口，不会再漂出第三份。
//
// ⚠ 顺序与 `scripts/roco/evidence-ledger-lib.mjs` 的 `CONFIDENCE_ORDER` **必须逐字一致**：
// `eval-rag-retrieval.mjs` 启动时 deepEqual 对一次，`tests/roco-rag-eval.test.js` 再对一次。
export const EVIDENCE_LEVELS = Object.freeze([
  'OFFICIAL_CURRENT',
  'RECORDED_IN_GAME',
  'COMMUNITY_CURRENT',
  'CROSS_SOURCE_SUPPORTED',
  'ENGINE_HYPOTHESIS',
  'UNKNOWN',
]);

/** 中文标签只用于**给玩家看**（正文里的「依据等级」）与报告可读性，不参与打分。 */
export const EVIDENCE_LABELS = Object.freeze({
  OFFICIAL_CURRENT: '官方当前材料',
  RECORDED_IN_GAME: '可复核实机',
  COMMUNITY_CURRENT: '社区当前可见',
  CROSS_SOURCE_SUPPORTED: '多来源支持',
  ENGINE_HYPOTHESIS: '工程假设',
  UNKNOWN: '无证据',
});
