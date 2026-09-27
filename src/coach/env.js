// 环境变量的**唯一**一份浏览器安全读法。
//
// 为什么必须有这一份（不是洁癖，是真事故）：
// 浏览器里没有 `process` 全局，而**默认参数是在调用时求值的** —— 写成
// `export function judgeMode(env = process.env)` 时，函数体里看不见 `process`，
// 但只要有人**不带参数**调用它（浏览器侧全都是无参调用），这一句就抛
// `ReferenceError: process is not defined`。
//
// 2026-09-25 真机实测（无头 Chrome，营地页）：点「✦ 小芽」→ 输入「怎么培养」→
// 状态行显示 `process is not defined`，对话里是「这次没有完成分析，请重试。」，
// 而 `/api/coach` **一次请求都没发出去**（只发了 `/api/bootstrap`）。
// 根因就是 `src/coach/runtime.js` 里 9 个开关函数都写了 `env = process.env`。
// 同一类事故在本仓还发生过一次：`src/coach/intervention-model.js`（那里的注释留着完整记录，
// 症状更隐蔽——判定层在页面上从来没生效过，报告里只看到一行 `layer-error`）。
//
// 为什么用 `globalThis.process?.env` 而不是 `typeof process`：
// `typeof process` 在浏览器里是安全的，但打包器/工具链可能把它**静态替换**掉；
// 直接读 `globalThis` 更明确，也不依赖任何全局是否存在。
//
// 纪律：`src/coach/**` 里任何要读环境的地方都用这一份，**不许**再写 `process.env` 默认参数。
// 这一条由 `tests/evals/structure-contract.test.js` 的「浏览器模块图里不许裸用 Node 专有全局」
// 逐文件钉住（反证：把 `processEnv()` 换回 `process.env` 必须红）。
export function processEnv() {
  const env = globalThis.process?.env;
  return env && typeof env === 'object' ? env : {};
}
