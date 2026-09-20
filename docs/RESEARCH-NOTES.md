# 调研依据与使用边界

整理日期：2026-09-16。用于方案设计与后续面试报告。当前为资料调研，不冒充对王者荣耀客户端的亲自实测；不从功能表现推断其未公开内部模型和训练方法。

## 灵宝

### 已查到的产品演进

- 2025-01-23 版本公告：局内陪伴上线；可以调整语音频率、风格和音量；队友语音交流时降低出现频率。来源为 TapTap 王者荣耀官方资讯栏目。启发：用户无需打开聊天；注意力与语音通道要避让。
  https://www.taptap.cn/moment/631897018159071609
- 2025-09-25 S41 公告：灵宝相关交互、局内设置与字幕信息表现有更新。来源为 TapTap 官方资讯栏目。启发：控制与信息可读性本身也是功能的一部分，不只看模型会说什么。
  https://www.taptap.cn/moment/719665013786150083
- 2026-01-29 公告转载：局内对话响应是小范围限时超前体验，不能据此认定所有用户当前都可用。
  https://bbs.4399.cn/thread-view-tid-51895669
- 2026-03-20 体验服公告转载：唤醒后连续对话、退出指令，以及战局查询和指导等能力。明确属于当时的灰度/体验服信息，不能当作全量上线状态。虎扑正文标注来源王者荣耀官网，但本次未取得对应官网原链接。
  https://bbs.hupu.com/638009474.html
- 2026-06-25 正式服版本公告转载：条件提示、设置调整等对话能力更新。可借鉴“用户委托后持续观察”的方式。仅据公开转载描述能力，不声称已验证覆盖范围和当前账户可用性。
  https://bbs.4399.cn/thread-view-tid-53273976

### 对小芽的设计启发

主动提醒必须直接包含有用信息，解释才放到二级入口。用户不点击聊天，不代表没有使用教练。提示围绕事件与场景，明确支持降频和退出。条件委托是补充，不能作为得到主动帮助的前提。

不要宣称灵宝采用了本方案的 ReAct、RAG、RL 或特定记忆结构；这些是小芽拟采用的技术方案，公开功能资料不能证明其内部实现。

## Agent 技术

- ReAct：推理与工具行动交替，根据观察决定下一步。小芽用于复杂局面的按需查证，不强行让确定性风险也走长链。
  https://research.google/blog/react-synergizing-reasoning-and-acting-in-language-models/
- RAG：检索外部知识辅助生成。小芽用版本知识与战术材料，实时数值仍来自工具。
  https://arxiv.org/abs/2005.11401
- Generative Agents：记忆检索、反思与计划。可借鉴经历与反思结构，不照搬其社会模拟效果作为本项目证据。
  https://arxiv.org/abs/2304.03442
- Reflexion：语言反馈和情景记忆可以改进行为；其 verbal reinforcement learning 不应与更新模型参数混淆。
  https://arxiv.org/abs/2303.11366
- Agent Lightning：连接 Agent 执行数据和训练流程的候选框架。安装或接入不等于已完成 RL。
  https://www.microsoft.com/en-us/research/blog/agent-lightning-adding-reinforcement-learning-to-ai-agents-without-code-rewrites/
  https://github.com/microsoft/agent-lightning
- Agent 工作流方法：路由、评审等可按需求组合，区别固定工作流与自主工具决策。
  https://www.anthropic.com/engineering/building-effective-agents
- 上下文工程：压缩和外部结构化笔记帮助长时任务；~~小芽还需自行实现证据 ID、版本与删除同步~~ **2026-09-17 更正：这三项都已实现**——`src/coach/runtime.js:16` 生成形如 `…:turn:N` 的证据 ID；`src/coach/experience.js:153-154` 的 `taskStamp / taskIsCurrent` 校验 epoch + matchId + rulesVersion + TTL；`src/coach/memory.js:126-129` 的 `deleteMemoryEvidence` 级联删除引用它的反思（`tests/evals/agent.test.js:16` 有断言）。
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Lost in the Middle：研究中的长上下文利用受位置影响。不能直接套用为某个当前 DeepSeek 型号的性能结论，但提示我们必须做独立的长历史检索测试。
  https://arxiv.org/abs/2307.03172

## 游戏战术

宝可梦官方战斗指南和组队攻略作为产品原则参考：不同技能类别、属性、队伍职责和配置共同产生取舍。研究基准用于启发对照实验，不以对战 Agent 的胜率代替教练效果。

完整链接与本项目设计边界见 [游戏扩展预案](GAME-EXPANSION-PROPOSAL.md#参考资料)。此次未复制原作角色设定、美术或现成数值表。
