# 实验与验收记录 v0.10

更新：2026-09-17。游戏规则0.6；历史报告保留在对应原始文件中。本页区分模拟实验、真实模型调用与真人效果。

## 1. 本地混合检索

知识卡 = **49 张原创本地化战术卡** + **由引擎生成的宠物/技能/属性参考卡**（`knowledge/reference.generated.json`；条目数随 `SPECIES`/`SKILLS`/`TYPE_ADVANTAGES` 生成，原来 41 条，本轮新增两只普通系宠物后为 44 条，合计 93）。**具体条数请现场复算**：`node -e "const t=require('./knowledge/tactics.json'),r=require('./knowledge/reference.generated.json');console.log(t.length+' + '+r.length)"`。卡片带规则版本、来源、反例和适用条件，引用按ID回查。外部宝可梦资料用于战术设计参考，不把外部伤害公式冒充本地规则。

真实运行 sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2，CPU生成384维向量，与词项检索用RRF融合。模型预热或请求失败时退回词项，并标注状态。

|方法|相关查询命中@3|MRR|负例拒绝|
|---|---|---|---|
|词项|11/14|0.667|1/2|
|纯语义|9/14|0.536|2/2|
|混合|11/14|0.750|1/2|

20条开发用查询：4条dev，16条test含2负例；此前已经使用过，不是独立盲测。混合只改善本样本排序，没有提升命中数，更不能据此宣称模型回答质量提高。真实模型weather-tools实际选择search_rules后read_state；这证明接入调用，不证明RAG因果增益。

复现：`node scripts/build-knowledge.js`、`node scripts/eval-semantic.js`；结果 `reports/semantic-retrieval.json`。

## 2. 干预策略Q-learning

5类模拟玩家：新手、熟练、探索、偏静默、本命偏好。3个训练种子17/71/199，各6000局，每局24步；每500局验证，测试集种子分离。另测降低耐心与采纳/学习概率的分布偏移。只按验证成绩选检查点，选中seed71。

|策略|回报/局|提示/局|增量帮助/局|
|---|---|---|---|
|沉默|0|0|0|
|固定规则|-1.113|5.89|1.38|
|未训练|-0.770|4.55|1.16|
|Q-learning|1.116|1.70|0.86|

偏移测试Q-learning回报0.581，规则-2.330。RL提示少、增量帮助也少；较高奖励来自人工设定的帮助/打扰权衡，不能写成所有指标都提升。

完整压缩轨迹：训练18000局/432000步、验证3600局/86400步、测试12000局/288000步；`reports/trajectory-audit.json`记录字节与计数。奖励检查包括始终提示、始终沉默、只挑高水平/危险场景和把本来做对算作AI功劳。所有结果都是模拟器产物，真人策略未接入探索。

复现：`node scripts/train-intervention.js`；结果 `reports/intervention.json`，检查点 `checkpoints/intervention-policy.json`。

## 3. 开源语言模型工具选择RL

模型 HuggingFaceTB/SmolLM2-135M-Instruct，revision 12fd25f77366fa6b3b4b768ec3050bf629380bac。冻结骨干，对“read_state / search_rules”对应的两个输出头行做REINFORCE更新；实际训练参数1152，含batch baseline、KL正则和梯度裁剪。不是DeepSeek微调，不是完整多步Agent Lightning训练。

英文手写任务24训练、8验证、16测试，三个种子各250轮；测试不参与参数更新或检查点选择。未训练8/16；训练后三个种子均15/16。参数L2变化0.9149至0.9744，检查点和750行训练轨迹均保存。

这是极小的二选一工具任务，题目分布简单，无独立第三方标注，不能外推中文对话、完整Agent或真人学习收益。线上仍用DeepSeek规划，不偷偷替换成这个实验模型。

复现：`.venv-agent/bin/python scripts/train-tool-router.py`；结果 `reports/tool-router-rl.json`，检查点 `checkpoints/tool-router-head.pt`。

## 4. 上下文与真实模型

官方DeepSeek V4 tokenizer和chat template本地计数，**工作预算窗口 200000（`WORKING_CONTEXT`）**，输出预留320，安全余量1024（`src/server/token-budget-server.js:11-16`；**本文原写作"窗口32768"，那是项目此前的保守值，已由官方 1M 容量下的 200K 工作预算取代**）。计入序列化工具合同与回执。超长历史测试按完整消息删除，保留系统约束、末尾28HP/6能量和回合证据ID。原始战报保留在浏览器归档，可指定回合重新装配；当前请求未带某回合时明确missing，不用摘要编造。

v0.10真实调用：补位、败局分析、追问、自动总结、天气规则五条均由DeepSeek生成，3134–3722ms；PVP绕过3ms本地拒绝。tokenizer计数与API prompt_tokens相差2–3，保留余量并以API usage计费为准。usage当前只记录最终生成，规划调用未合计，不能用它当整条链成本。

人工逐条阅读发现：败局分析把“净化药、能量果”叫作“解药、以太”，数字检查没有拦住；**名称约束与窄校验已补上并已复验**（`src/coach/runtime.js` 的 `item-name-drift` 与 `causal-cancelled-action`；测试 `item-name drift is rejected even when every number is grounded`；第三轮 44 条真实调用的 `badAnswers` 里没有任何 `item-name-drift`，见 `reports/live-model-eval.json`）。天气回答没有充分解释速度顺序，属于解释质量不足。接口成功与窄校验通过不等于全部答案正确。

原始结果：`reports/live-model-v10.json`；旧v0.8数据保留。S04独立质量评测**当时**继续保留未勾（**2026-09-17 晚复核：S04 已勾选**，三轮共 132 次真实调用，产物 `reports/live-model-eval.json` 与 `reports/live-model-eval-before-after.md`）。

## 5. 游戏与自动测试

**写作时为 127 项**自动测试通过，含新增6项机制回归与本地对战回归（**该数字已过时**：此后 `reports/test-output.txt` 记录 **251 / 251 / 0**，写这份修复报告时现场 `npm test` 为 **257 项**——含并发进行的宠物扩展，见 `docs/DOCS-AUDIT-FIXES.md`。现场复核请直接跑 `npm test`）。660场等等级、默认配招、无道具天气的单宠有序对照，仅用于发现极端项，不代表3v3平衡。风系支援伙伴在此口径下偏弱，不能靠单项胜率宣称全宠平衡；后续需配装、环境和队伍组合矩阵。

## 6. 来源与资源

- DeepSeek官方token说明及下载：https://api-docs.deepseek.com/quick_start/token_usage/
- 多语言嵌入模型：https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
- 小模型：https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct
- `.venv-agent`依赖锁定于 `requirements-agent.lock.txt`；模型在`.models`，不进提交源码。
- 真实学习迁移、语音是否舒适可听、最终面试日期与API预算仍需要用户反馈，未伪造结果。
