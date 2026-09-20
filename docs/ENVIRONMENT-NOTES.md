# 环境差异记录

## tests/replace.test.js 需要能启动 Chrome

`tests/replace.test.js` 是无头浏览器端到端用例（真 Chrome + 真 server + 真点击），
它**要求运行环境允许启动 Chrome 并写出 `DevToolsActivePort`**。

**在受限沙箱里它必定失败**，报错形如「15 秒内没有生成 DevToolsActivePort」。
**这不是产品逻辑失败**——同一个命令在沙箱外重跑 1/1 通过，约 19 秒。
复核方两次失败都是沙箱禁止/干扰 Chrome 启动所致。

**所以：看到这条红，先确认环境能不能起 Chrome，不要去改产品代码。**

为此测试本身做了三件事，都只是让失败可诊断，不改变它要断言的东西：

1. **收 Chrome 的 stderr**（原来是 `stdio:'ignore'`，起不来的原因被吞掉）
2. **超时 15 秒 → 60 秒**，可用 `CHROME_START_MS` 覆盖；进程已退出就早停，不再空等
3. **失败信息打印**：可执行文件路径、进程状态（退出码或信号）、profile 目录、stderr 末尾

它**不跳过、不弱化断言**。环境起不来 Chrome 时它仍然红——只是红得能看懂。

## 本仓库其他需要外部条件的东西

| 需要 | 哪些 | 缺了会怎样 |
|---|---|---|
| Chrome | `tests/replace.test.js`、`tests/browser.test.js`、`npm run test:smoke` | 报环境错误，不是逻辑错误 |
| 模型密钥 | `npm run eval:live*`（不在 `npm test` 里） | 需在 `/connect.html` 或 `./scripts/start.sh --save-key` 配 |
| Python | 语义检索与两个训练实验 | 自动退回词项检索，产品仍可用 |
