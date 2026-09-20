# S05 / W09 慢模型演示（客户端侧可自动复现的部分）

清单项：

- `S05 慢模型演示：快速出招后无旧文字、无旧语音、无重复补发。`
- `W09 新版完整浏览器慢响应、语音取消与长局验收。`

本轮完成时间：2026-09-17。产物：**新增 `tests/evals/slow-model.test.js`（6 项）**，`package.json` 新增 `npm run test:slow-model`。

**没有修改 `src/coach/client.js`**——见下节说明，这不是妥协，而是比注入更严格的验证方式。

---

## 一、为什么不给 `src/coach/client.js` 加延迟注入

任务允许"给 `src/coach/client.js` 加一个测试用的延迟注入（不改生产行为）"，但更干净的做法是**在测试里替换 `globalThis.fetch`**：

- `src/coach/client.js` 的慢响应瓶颈在 `fetch('/api/coach', …)`，测试里换掉 `fetch` 就等于制造了可控慢网，**生产代码一行都不动**；
- 走的是线上那条完整路径：`requestCoach → CoachScheduler.run → executeCoach → runCoach(本地预演) → assembleContext → fetch → checkGroundedAnswer`，没有另写替身；
- 避免在生产文件里留一个只有测试用的开关（那种开关本身就是"生产行为被改了"的风险面）。

因此 `src/coach/client.js`、`src/coach/scheduler.js` 本轮**没有任何改动**。

## 二、慢网替身怎么造

```js
// tests/evals/slow-model.test.js
globalThis.fetch = async (url, options={}) => {
  if (String(url).includes('/api/bootstrap')) return new Response(JSON.stringify({configured:true,verified:true,csrf:'test-csrf'}), …);
  // /api/coach：延迟 delayMs 再回；如实响应 abort（signal 一中止就抛 AbortError）
  return new Response(JSON.stringify({text, provider:'deepseek', route:'strategist', stateToken:body.stateToken}), …);
};
```

替身回传 `stateToken`，与真实服务端一致（`src/server/index.js` 的 `/api/coach` 返回 `stateToken: b.stateToken`），否则测的不是真实合同。

## 三、6 项断言与实测结果

| 测试 | 场景 | 断言 | 实测 |
|---|---|---|---|
| `a slow model answer is aborted when the player acts first, so no stale text is delivered` | 慢回答 250ms；40ms 时"出招"（`invalidateCoachRequests()`，即 `src/client/app.js` 的 `advanceContext`） | 调用方拿到 `AbortError`；上游被中止恰好 1 次；被中止的请求 `completed===0`；**交付列表为空**——旧文字一次都没出现 | 通过（362ms） |
| `after a fast action only the newest position is delivered` | 慢回答 120ms；20ms 时出招，然后立刻按新局面提问 | 旧请求 `AbortError`；新回答文本属于新局面 B；`stateToken===1`；中止 1 次、完成 1 次 | 通过（155ms） |
| `the same position asked twice is merged into one upstream call (no duplicate delivery)` | 同一局面并发问两次（自动提示与手动提问同时发生的情形） | 上游只被调用 **1** 次；两次拿到同一份文本 | 通过（149ms） |
| `three rapid actions in a row deliver exactly one answer: the last one` | 连续三次快速出招 | 前两次都是 `AbortError`；上游 3 次（不同局面不合并）、中止 2 次、完成 1 次；**只补发 1 条**，且是最后一次的 | 通过（130ms） |
| `the client layer never speaks: no speech call exists on the answer path` | 静态检查"无旧语音" | `src/coach/client.js` 里没有任何 `speechSynthesis`/`playVoice`/`speak` 引用；`src/client/app.js` 的 `VOICE_FEATURE=false` 仍在；`playVoice` 在停用时第一行 `return`；`speakCue` 受 `voiceEnabled` 约束 | 通过（1.4ms） |
| `a slow answer that arrives after the deadline is not resurrected` | 慢到 600ms，中途不出招 | 100ms 时还没有结果；最终拿到正确文本；**只交付一次**，之后不再补发 | 通过（811ms） |

合计 6/6 通过。跑法：`npm run test:slow-model`（或 `node --test tests/evals/slow-model.test.js`）。

## 四、"无旧文字 / 无旧语音 / 无重复补发"逐条对照

| 要求 | 机制 | 本次证据 |
|---|---|---|
| 无旧文字 | `CoachScheduler.invalidate()` 提升 epoch 并 `abort()` 在途请求；`run()` 在发出前、返回后各检查一次 epoch，epoch 变了就抛 `AbortError`；`src/client/app.js` 的 `ask()`/自动提示另外用 `stateToken` + `hintEpoch` 二次校验 | 前 4 项测试 |
| 无旧语音 | 客户端层不碰语音；`src/client/app.js` 的 `playVoice` 在 `VOICE_FEATURE=false` 时第一行就返回，`speakCue` 由 `voiceEnabled`（= `VOICE_FEATURE && setting.enabled`）短路；出招时 `act()` 会先 `cancelVoice()` | 第 5 项测试（静态断言） |
| 无重复补发 | 同 key 请求在 `pending` 表里合并；回答只在 `requestCoach` 的 promise 上交付一次，测试用收集数组统计交付次数 | 第 3、4、6 项测试（各断言交付次数恰好为 1） |

## 五、W09 里**没有**做到的部分（照实说）

`W09` 要求"新版完整浏览器慢响应、语音取消与长局验收"。本轮做到的是**客户端逻辑层面的慢响应与取消**，以下三点没做：

1. **没有在真实浏览器里注入慢网跑一遍完整链路**。原因：本机 8765 是用户已在运行的服务，直接用真实 DeepSeek 制造"可控慢网"做不到（只能等它真的慢），而引入 CDP 请求拦截改写 `/api/coach` 响应属于对运行中服务的额外干预。本轮的长局浏览器验收（`C17`）走的是真实服务，但**没有**同时叠加慢响应。
2. **语音取消没有实测**。语音已整体停用（`VOICE_FEATURE=false`，`U05`/`V08`/`E08` 保持未勾），停用状态下"语音取消"没有可观察对象；本轮只断言了"停用生效且回答路径不触碰语音"。**恢复语音之前，这一半无法验收**。
3. **没有测量浏览器端渲染在慢回答下的表现**（例如短字幕占位、按钮禁用态、`showThinking` 动画在 5 秒以上的实际观感）。这需要真人观察或录屏，属于 `F04` 的范围。

因此 `S05` 可以认为**客户端行为已验证**（4 项针对性断言 + 2 项边界断言），`W09` 仍**未完成**：它要的是"完整浏览器 + 慢响应 + 长局 + 语音取消"四件事同时在真实页面里跑通，本轮只覆盖了其中"长局"（见 `reports/c17-endgame-browser.md`）与"客户端取消语义"两块。

## 六、可核查命令

```bash
npm run test:slow-model
node --test tests/evals/slow-model.test.js     # 同样 6 项
grep -n "VOICE_FEATURE" src/client/app.js           # 语音停用位置
grep -n "scheduler.run\|invalidate" src/coach/client.js src/coach/scheduler.js   # 取消与合并的实现位置
```

> 注：`src/coach/client.js` 在本轮**没有**为慢模型测试做任何改动。若 `git diff` 显示该文件有变更，那是同期另一个并行任务（陪练档位约束）带来的，不是本项所需。
