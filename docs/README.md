# 小芽交付与执行入口

当前UI v0.11，游戏规则v0.6。14宠（本轮新增磐耳羊/灵瞳猫两只普通系；此前为12宠）、知识卡 = 49 张战术卡 + 由引擎生成的参考卡（原 41 条，随 `SPECIES` 生成、本轮扩容后为 44 条）、有界工具Agent、整局复盘、事件记忆、条件提醒、参数化练习，以及实际小型干预RL实验。（知识卡条数请现场复算：`node -e "const t=require('./knowledge/tactics.json'),r=require('./knowledge/reference.generated.json');console.log(t.length,r.length)"`。）

优先阅读：

- [目录结构与约定](STRUCTURE.md) ← **新文件该放哪看这份**

- [当前状态](IMPLEMENTATION-STATUS.md)
- [逐项清单](CHECKLIST.md)
- [演示与验收](DEMO-ACCEPTANCE.md)
- [实验报告](EXPERIMENTS.md)
- [面试讲述](INTERVIEW-GUIDE.md)
- [灵宝调研](LINGBAO-RESEARCH.md)
- [证据与权限](EVIDENCE-SCHEMA.md)
- [整体方案](COACH-PLAN.md)
- [游戏扩展预案](GAME-EXPANSION-PROPOSAL.md)

可提交PDF在 output/pdf/xiaoya-coach-report.pdf。报告区分实装、实验与未完成项；检查点不是DeepSeek权重，模拟收益不是玩家研究，检索卡片数不是回答质量。
