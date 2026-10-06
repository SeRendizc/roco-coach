# R3a 本地交付草稿（等待 root 复核）

基线 f33d685202b6a4f958ac871add85a5c0aadb7949；没有提交、上传或推送。本阶段只修真实 HTTP 客户端与来源显示。`candidate.patch` 包含3个生产文件、1个旧测试的合同修订、3个新反例文件，SHA256 `7462cf98fba559796122cc0d07d622118b82b8f6f9d452f2638ca9e2108293ed`。STATE、共享checkout、8765、真实凭据/数据、训练均未操作。

**所有云传输均为人工夹具，真实模型未测。** 创建服务器前删除子进程继承的密钥变量，设置公开的人工标记以到达现有 configured 分支；注入 fetchImpl 截断全部外部请求，本地神经模型工厂抛错。成功正文同样是人工 Response，不能称为真实云调用或模型验收。

## 实际链与最小修改

真实浏览器表单 → requestCoach → POST /api/coach → runCoach → provider.generate → complete/注入fetch → HTTP502 → client.js真实runCoach本地回退 → popup可见回答。不是替换HTTP错误或页面文本。

- client.js保留local-fallback，伴聊不再冒称“本局规则结论”；即时网络错误不再断言等待过久。失败后的本地runCoach只收到原用户话，memory.dialogue不夹入内部回答要求；两次403后不再虚称“正在重连”；取消保持AbortError。
- xiaoya.js探针只说已配置。非缓存cloud回执才说明这次云端正文，fallback说明本地；每条已接收回答都更新/清空model证据，pure-local/cache不继承前一条cloud成功。缓存状态明确“显示缓存回答”。tools/off/unknown与连接协议保留。
- 当前局battle_id限定model证据；两条实际开局入口调用已有singleton.render（不会重复挂监听）；新对话/清空清model证据。在飞时render保留可见玩家问题，结束后恢复历史渲染。
- **历史接线说明纠正**：rocoDemo原先先定义真实render出口，随后同名shorthand覆盖成退役DOM早退函数。过去“公共render真实可达”的源码说明不能当运行证据。`render-export-before.log/json`实际刷新超时；只删除重复shorthand后真实刷新可达。内部退役函数/原调用频率未改。

## 原始反例与检查

命令均从clone根执行，文件均在本目录。

1. `node --test tests/roco-quality-transport-20261006.test.js`：`transport-before-two-counterexamples.tap` exit1，原话被内部指令污染、状态误称规则结论分别红；修后`transport-final.tap` exit0，5个父/子项目通过。最初不完整context夹具产生400（`transport-fixture-diagnostic.tap`），已改用实际buildContext，未冒充provider命中。
2. `node --test tests/roco-quality-capability-20261006.test.js`：`capability-before.tap` exit1，3红；修后3绿。旧capability两处“已连接”文案与源码形状要求和新来源合同冲突，原文逐字保存在`obsolete-capability-assertions.txt`，旧测试实际红保留`original-capability-after.tap`；修订增加非连接承诺、实际共享门控行为断言，工具/off/unknown断言不动。`node --test --test-name-pattern='U07.*④|R06' tests/roco-xiaoya-context.test.js` → `original-capability-updated.tap` exit0，2绿。
3. `ROCO_R3A_LATEST_BASELINE=1 node --test tests/roco-quality-latest-source-20261006.test.js` → `latest-consumer-before.tap` exit1，2红。这里复现的是**前一候选if(seen.model)消费者**，不是f33最初实现；调用实际提取的noteAnswerEvidence及实际UI/HTTP记录。默认模式调用当前消费者，cloud→local、cloud→cache清旧model证据。
4. 最终 `node --test tests/roco-quality-latest-source-20261006.test.js tests/roco-quality-capability-20261006.test.js tests/roco-quality-transport-20261006.test.js tests/evals/slow-model.test.js` → `final-focused.tap` exit0，16通过、0失败/取消/跳过，约1.65秒。独立root输出不重复计数。
5. `node --test --test-name-pattern='invalid model numbers and network errors|model length fallback|client sends whole-match|automatic and manual|generation instructions' tests/evals/agent.test.js` → `client-regression-after.tap` exit0，5绿。此前扩展49项有48绿1红：旧事实断言“4豆”对实际“4能量”（`focused-after.tap`）；使用baseline-loader的原client重跑该单项同样红（`unrelated-fact-baseline.tap`），其余相关源码/数据未改，未更改旧断言或扩修。
6. `node docs/roco/verification/2026-10-06-quality/r3a/ui-probe.mjs` → `ui-final.log` exit0，13项实际UI检查。沙箱内Chrome未启动两次的日志保留；仅隔离脚本升权执行。`pending-history-before.json/log`保存新局render删除在飞问题的红结果，随后保持严格原问题可见/0追加断言修正实际render。

## 隔离UI与来源证据

`ui-results.json`保存原/发送请求、HTTP状态/body、可见文本、capability长短句、当前局号/版本、localStorage聊天记录和provider传输包（不保存认证header）。最终9条实际本机coach HTTP：3条注入失败、3条人工成功、2条纯local、1条真实server cache hit；外部网络调用0。缓存夹具**仅复用stateToken身份**使现有服务缓存命中，原UI请求与实际发送payload都保存，不把此改写藏起来；同公开快照，命中时provider调用数不增加。

13项包括：配置不等于连接、失败明确本地、真实刷新不覆盖、pure-local零provider调用、换宠与换局迟到0新增回答/0持久化且问题仍可见、请求结束后正常history render、人工非缓存cloud来源、cloud→local、cloud→实际cache、新局清旧model证据、显式新对话与清空。后两项在请求结束后测试；在飞新对话/清空后旧请求的完整取消行为未做本轮UI验收。

截图：`baseline-transport-error-ui.png`原矛盾；`transport-error-ui.png`修后真实502；`synthetic-success-ui.png`**人工成功**；`cached-answer-ui.png`真实本机缓存；`late-error-switch-ui.png`、`late-error-new-battle-ui.png`；`new-match-capability-ui.png`清旧证据。已目视核对。

自有服务11349/Chrome11359随脚本确切对象关闭，临时profile删除；只读ps精确PID exit1无存活，8898 lsof exit1无监听。未操作8765。

## 限度与下一步

代码：上述定向通过，src/tests diff --check exit0。隔离：上述13项通过。真实云/本地神经模型：未测。玩家：未测/未部署。旧历史仍可见，新局statusLine可暂留历史“DeepSeek已回答”，chip已不把它当当前局证明；root明确允许保留该缺口，不扩大。没有真人学习/试用证据。等待root独立复核后分配R4；本阶段不上传、不联系DSH或真人。
