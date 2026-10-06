# 六宠复盘→可选变式：本地候选，待根独立复核

基线 fc4a3db471c1f0fc86660e8eb7cd3a9021a84208。唯一实现写域：replacement-practice.js、roco.js、roco.html、replacement-practice.test.js、新 learning-loop-natural.test.js 与本目录。decision-evidence.js/teacher-review.js 未改。其它 agent 的问句改动不属于本交付。未进行 git 写入/推送、共享 checkout/STATE/8765 操作、模型请求/训练。

## 真实失败与最小修改

保存的旧自然轨迹有22回执（1 new、20 manual advance、1 auto advance）；实际DOM课题为 switch-out-of-the-bad-matchup。基线练习adapter只接受read-the-replacement-first，因此入口不存在。另一独立断点：首个敌方替换为第6回合slot4/草头鸭/v39，而终局公开field是slot1/迪莫/v86，基线把事件配到终局field，无法建立来源。replacement条件性测试只把既有轨迹交给该课adapter，**没有称原自然比赛选了此课**。

`node --test tests/learning-loop-natural.test.js` 原exit1，before.tap：两条期望来源的反例红；两条拒绝反例绿。首稿新测试曾把slot4名字误写为水蓝蓝，源为空时未执行到该断言；核对原receipt后修为草头鸭，未改任何原证据。第一候选同命令exit0，after.tap；后续追加实际snapshot生产与terminal/source版本分离反例。

applyResult逐回执保存最小公开快照：session/public局号、decisionId/version/turn/phase、事件区间、自方active、对手公开slot/name/types。不给练习整份context或隐藏bench。换宠课只接受teacher已经确认的decision-evidence替代，重新核对accepted主动记录、事件实际动作、同版本快照和此前打在同active上的公开克制伤害。有资料缺口则不出题。换入课改取替换事件所在回执的公开field，不读终局field。selected goal、伤害规则、动作合法性和accepted合同不变。

假设变式改变“仍可主动行动并有合法换人”与“已经倒下只能补位”，同选项、不同正确答案；问玩家当前能否主动换宠，不保证最优出招或免伤。旧公开信息刷新课保留。来源stateVersion保留实际决定/替换版本；endStateVersion单独做结算提交门控。一次题号只写一次attempt、看提示非独立、跳过不写attempt，均复用原合同。

## 旧测试合同维护

replacement-practice-original.txt逐字保存原5项；baseline-source-original.txt逐字保存基线adapter。baseline-source.mjs、baseline-test.mjs只迁import路径，便于在本目录运行基线逻辑。

- `node --test docs/roco/verification/2026-10-06-continued/learning-loop/baseline-test.mjs`：exit0、原5绿，original-test-baseline.tap。
- `node --test tests/replacement-practice.test.js` 在候选未维护fixture时：exit1，original-test-candidate-before-fixture.tap。
- 维护只给fixture补公开match_id和事件时v2 snapshot，并把空白名字/属性、错slot、缺属性的拒绝输入迁到snapshot；原拒绝断言、提示、跨局/版本、重复与下一局未知断言保留。终局field不再作为资格来源，新增反例确认终局资料改变不影响事件来源。

最终命令：`node --test tests/learning-loop-natural.test.js tests/replacement-practice.test.js tests/teacher-decision-identity.test.js`，exit0，relevant-final.tap：20绿/0失败取消跳过；与早期18绿有重叠，不相加。`node --check src/client/roco.js` exit0。未跑全库或真实模型验收。

## 实际页面回放

`node docs/roco/verification/2026-10-06-continued/learning-loop/replay-probe.mjs`：最终exit0，replay.log、replay-ui.json、replay-practice.json、replay-ui.png。**旧真实公开轨迹回放，非新自然比赛**；回放严格核对原请求动作/version并返回原body/status，没有改goal/event。实际playAction/autoTurn→finishMatch→按钮链：入口可见、打开来源折叠区显示v4、提交正确答案、重复0追加、另一变式提示后答对非independent、跳过/重开。

首次沙箱Chrome未产生DevToolsActivePort，失败提示为“owned Chrome started”assertion（stderr空）；原启动日志被后续脚本运行覆盖，此项只有本记录，不能称保留完整原始日志。授权隔离执行启动成功。首次consumer检查因来源details关闭而innerText空失败，replay-first-consumer-failure.log原文留档；脚本改为真实点击summary后检查，没有放宽来源版本判据。

## 一局新的自然可达性验收

`node docs/roco/verification/2026-10-06-continued/learning-loop/natural-probe.mjs`：exit0，natural.log；本阶段只开1局，不跑第二局。独立8899服务、临时Chrome profile，provider fetch/localModelFactory均拒绝外部/神经模型。实际HTTP fetch响应原样返回，无回执/事件/goal注入。CDP binding在每个响应返回前把公开receipt逐条落natural-receipts.ndjson，再做后续提取。

natural-round-1-raw.json保留请求/status/body与局末快照；NDJSON的22条与raw逐条完全一致。共21 advance=20 manual+1 auto，2.808秒，真实loss、无预算投降。单局所有advance上限40，总墙钟10分钟；实际远低于上限。actual DOM课题仍switch-out-of-the-bad-matchup，练习可见→打开→主动选项/提交→正确反馈→1条attempt，sourceTurn2/sourceVersion4、terminal86。natural-round-1.json/summary.json与natural-round-1.png保存该链；截图已检查，明确假设、不代表原手做错、一次答对不构成掌握。测试者代验点击，不是真人学习效果或本人闭卷练习。

独立服务及Chrome精确按自己PID关闭、profile删除；lsof8899退出1/无监听。replacement课的自然选课→练习仍未证实；这里只证明它能按事件时公开资料建立条件性来源。未测真实云模型、真实玩家8765、人类迁移效果。下一步仅根独立复核候选和自然回执，不自行扩课/新比赛。
