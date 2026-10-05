# 下一阶段门槛：R3/R4 有界只读诊断

2026-10-06。检查基线 `c37aa5a9e35ac2a4d4eb2ee6508caa3cd62a0c0c`，产品代码与独立复核候选716cb5fe一致。只读一条provider链和一条六宠结算消费链；没有运行模型、规则桥、UI或8765，没有读配置文件/密钥值，没有修改生产代码。下面是源码可达性证据，不是模型或玩家验收。

## R3：配置 → 工具/回答 → 来源回执

消费链为 `POST /api/coach` → `runCoach` → `gatherAgentEvidence`/`provider.generate` → 服务端payload。

- `src/server/index.js:558,669,977`：服务启动时credential初值为空；符合格式的环境配置或连接入口可设置它。源码中存在配置入口，不证明当前机器已经配置、余额可用或请求成功。本次没有读取环境密钥值、连接配置或调用云端。
- `src/server/index.js:745-760`：status的configured/provider只是配置状态；`complete`实际向DeepSeek chat/completions发送消息，检查HTTP、JSON、非空正文与配置generation，成功后返回文字及usage。失败会抛出明确网络/鉴权/余额/格式错误，不能把配置标志当成功。
- `src/server/index.js:1016-1060,1086-1098`：云provider有plan（2500ms）和generate（8000ms）；本地模型off/on/shadow以及cloudDecision会影响选择。payload保留usage、tokenAudit，非off才附modelRoute。缓存命中将usage/tokenAudit设null，因此usage为空也不能单独证明本次走了模板。
- `src/coach/runtime.js:50,2248,2549,2610,2647-2666,2690,2887-2888`：无provider默认是local模板；deterministic或纯事实回答会绕过模型。需要模型且政策要求查证时才进入工具循环，回执带toolTrace/agentStop；模型回答经过一致性与事实守卫。守卫拒绝或本地模型降级时标local-fallback并带fallbackReason；正常local是local，正常模型以provider.name标记。`verified:!useModel`指此回答的本地路径，不等价于服务器status的云端verified。

确定缺口：本轮所有绿测试和UI是离线证据，尚无真实云provider请求、模型工具选择、最终可见回答与来源字段的同次关联记录。本地神经模型也未测。源码里`provider.generate`异常直接抛出，不能笼统声称所有网络错误都会给模板fallback；本次没有验证HTTP错误到玩家显示的完整链。

可直接实施任务卡 R3a：在获得明确既有调用预算后，选一个公开PvE快照、一个必须查证且需要取舍的问题，在独立端口/profile只做一条云请求；保存脱敏请求身份/公开上下文、实际工具参数及回执、answer provider/usage/modelRoute/fallbackReason、页面实际文字与状态戳。验收要求同次请求的事实与来源一致；如网络/预算不可用，记录失败和缺项，不以离线factory或status替代。先用依赖注入补一个无网络的transport失败→HTTP→客户端显示反例，明确失败与local-fallback的区别；真实调用须预算授权，且不得发送隐藏对手真值。

## R4：复盘 → 下一局核对；变式入口未证实

选择真实六宠页面结算入口，不追另一套聊天教学链：

- `src/client/roco.js:4263,5136-5170`：收到battle_result后finishMatch，带公开finalView/lastLiveView/events/legalByTurn调用rocoMatchReview。
- `src/coach/roco-experience.js:1010-1054`：rocoMatchReview调用checkLearningProgress、reviewMatch、rocoMatchDepth；lessonGoalRow把learning与depth.next_step.text组合为可见指导，空内容隐藏。
- `src/client/roco.js:5196-5217`：页面显示复盘、下一步与核对说明，并recordTeacherReview/recordLearningCheck后saveMemory。
- `src/coach/teacher-review.js:1362-1399,1443-1475`：记录含课题、局面、处理方式和真实局面回合；下一次结算用新事件评估同类局面。未再出现时明确recurred:false、improved:null，不把没出现当改善。
- `src/client/roco.html:193-209`与上述lesson-card写入点：这一消费链显示文本/依据。按lesson-answer/lesson-submit/teacherGoalLesson检索这三个具体消费者文件，没有发现从此结算卡创建变式题、接收玩家回答或反馈答案的入口。`teacherGoalLesson`只是teacher-review中的goal映射，未被选定页面调用。

边界：这说明“本局复盘→存学习账→下局同类局面核对”源码有实际消费者，不能证明已经实现或体验过“复盘→独立变式练习”。没有全库查找，不断言整个产品完全不存在其它练习入口；没有真人试用或学习收益证据。

可直接实施任务卡 R4a：先只做一课、一个公开且有足够依据的局末场景。将结算卡的该课题连到可见变式入口，复用现有课题/练习合同（开工先核实，不新建未调用旁路），让玩家提交一次选择并收到对应解释；题目与复盘共享公开证据身份，答案不提前泄露。反例要求旧页面点击路径确实到不了练习、资料不足/过期场景不能出题、原局数字不能伪装成新变式真实结果；隔离页面必须走完“复盘→打开→作答→反馈”。下局核对另保留“无同类局面→未知”的门控。此卡尚未实施。

## 命令与限度

只读命令均exit0：`sed -n '602,640p;745,773p;994,1105p' src/server/index.js`；`rg -n 'provider\\.generate|provider\\.plan|useModel=|deterministic=' src/coach/runtime.js`并读取对应片段；`sed -n '5136,5240p' src/client/roco.js`；`sed -n '1010,1075p' src/coach/roco-experience.js`；`sed -n '1362,1399p;1443,1475p;1523,1529p' src/coach/teacher-review.js`；`rg -n 'teacherGoalLesson|lesson-answer|lesson-question|lesson-card|lesson-submit' src/client/roco.js src/client/roco.html src/coach/runtime.js`。检索范围只有上述消费链，命令是源码证据，没有新增执行测试或付费请求。

代码：前阶段已有独立复核；本诊断没有代码变更。隔离：未新增验收。模型：未测。玩家：未测/未部署。下一步等root定界R3a或R4a，不自动扩功能。
