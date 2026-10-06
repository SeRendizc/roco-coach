# 2026-10-06 继续优化与验收

本次人类授权：继续优化 Roco，可整合主分支并启动本地服务。保留 `/Users/serendizc/Developer/roco-coach` 的既有脏文件；全部代码在隔离克隆完成。两个 GPT-6.1 Sol medium 子agent 分别负责明确比较意图和复盘练习，根独立复核、整合与玩家页面验收。

## 已取得的证据

- [明确类型比较](explicit-intent/README.md)：主句绑定两个公开对象，条件里的第三个对象不顶替；明确属性不被当前对手属性替换。实际客户端 producer → HTTP 的前红后绿证明了公开属性不再丢失。纯比较没有可执行行动，交付时不误判成“缺合法首选”的行动回退。
- [复盘到变式练习](learning-loop/README.md)：一场新自然比赛，21 次推进全量留档；实际选中的换宠复盘课题可以打开、作答并看到反馈。决策当时的公开快照与终局版本分开绑定。未证实补位课题自然选中后的同等链路；未验证真人学习收益。
- 根最终定向回归 `npm run test:roco-quality`：75/75（含立绘回退）。服务端与属性表相邻复跑33/33；此前公开战况契约等37/37，均有重叠，不相加。见 `root/quality-final-all.tap`、`root/sprite-server-adjacent.tap` 与 `root/producer-adjacent.tap`。
- 核心候选 `20cb3346` 的完整单测：2024 通过、37 失败、21 跳过；基线 `fc4a3db4`：2023 通过、38 失败、21 跳过。失败名称集合没有新增，一项测试登记结构契约失败消除。此轮包含 producer、纯比较交付与高能量风险修复；后续立绘回退修复另跑定向 HTTP/单测。详见 `root/energy-final-unit-summary.json`。全仓单测仍非全绿。
- 根第一次 8765 页面实测发现真实 producer 丢属性：当前对手迪莫光系，询问喵喵/水蓝蓝火系承伤得到“读不到”。该失败推动了第二轮修复；不能把此前手工快照通过当作真实页面已通过。

## 验证命令

```sh
npm run test:roco-quality
node --test tests/server.test.js tests/roco-coach-context-contract.test.js tests/roco-client-type-affinity.test.js
npm run test:unit
```

完整单测在本机复核时按原 `test:unit` 文件列表执行，并加单测试 45 秒超时及 TAP 输出，以避免失败的浏览器测试无限阻塞。原始大日志保留在本地 `tmp/continued-verification/`，摘要入库。

## 根的实际页面复核

核心候选 `20cb3346`，无凭据且 fetch 明确禁止云端传输的独立 `8898`，真实 CUA 点击公开测试阵容：

- 当前对手魔力猫草系，点名比较喵喵与水蓝蓝火系承伤：2 与 0.5，保留真实伤害/隐藏招式未知；比较回答没有新的可执行行动卡。见 `root/local-ui-comparison-final.txt/.jpg`。
- 根发现满能量建议仅按血量比例和槽位换上水蓝蓝、却声称“留厚的那只”：原页面 `root/local-ui-unsafe-switch-before.txt/.jpg` 留档。修复后回到当前规划建议换火神，明确换人接招风险与下一招未知；真实采用后第2回合、火神上场，战报记换第6位。再点旧建议被提示“对局或局面已经变了”，没有再推进。见 `root/local-ui-energy-after.txt/.jpg`、`root/local-ui-adopt-after.txt`、`root/local-ui-stale-rejected.txt`。
- [高能量风险修复](energy-warning/README.md) 不意味着策略最优；它撤掉了没有证据的强制换人推论。相邻回归根复跑62/62，子agent另有82/82，两者重叠不相加。
- 根独立逐条核对自然比赛22条NDJSON与raw receipts完全相同、21advance、自然loss、事件时v4和终局v86分开；见 `root/natural-receipt-review.json`。点击作答由子agent完成，不把它写成真人迁移效果。

8765 从独立主分支工作区启动，规则服务 `available:true`。保留原 `/Users/serendizc/Developer/roco-coach` 的脏文件和其它进程；仅按自己记录的PID更新本轮服务。界面已刷新为当前版本，未清除原阵容或对话历史。

## 新克隆的立绘回退与最终页面

根实际截图发现战斗立绘空白。新工作区没有被 Git 忽略的512px大图，但已有跟踪的256px缩略图；原选择逻辑没有按注释回退到小图，而是404。子agent仅修同物种图的存在性选择，未复制、下载或上传新素材，保留full=1只取原件的行为。

生产代码候选 `40c395a6` 已在8765和无云端8898生效：喵喵、火神、魔力猫两端真实GET均200、variant=thumb，响应字节SHA与跟踪的该物种缩略图完全相同。见 `root/sprite-http-before.json`、`root/sprite-http-after.json` 与 [选择合同证据](sprite-fallback/README.md)。最终实际页面能显示双方角色；问“喵喵和水蓝蓝谁更扛光系？如果迪莫下一招不是光系呢？”得到0.5与1，第三对象没有顶替比较对象；条件里的新攻击属性未指定时要求澄清，而不编造下一招。见 `root/local-ui-final.txt/.jpg`。这是本地规则回答，不是模型回答。

最终完整回归比较执行于核心候选20cb3346；随后图片选择段只加2行/删3行，独立选择合同、真实HTTP及服务端回归通过。没有把前一版本的完整回归写成图片修复后又跑过全仓。全仓失败清单见 `root/energy-final-unit-summary.json`。

主分支工作区：`/Users/serendizc/Codex/Internship/work/roco-main-20261006`；对外入口：`http://127.0.0.1:8765/roco.html`。服务启动版本保存在本机 `tmp/player-service.json`；此后若只追加验证文档，生产代码与启动版本保持相同。临时8898与其浏览器页验收后关闭，8765保留。

## 云端验收审批缺口

自动审批拒绝在已配置8765页面发送比较问题，理由：可能携带当前队伍和对局上下文到云端模型，缺少该具体传输的授权。根已询问人类是否允许公开六宠局面及测试问题经已有DeepSeek连接做最多3轮验收；未收到回复前，不重试、也不通过CLI绕过。上述8898页面证据是明确不连接模型的安全替代，不证明真实模型正文质量。第一次8765旧版本页面曾得到本地回退，也不算模型质量通过。

训练、用户闭卷练习、真人学习收益、补位课题自然选中后的练习链路仍未完成；全仓37项既有失败单列，不称发布成熟版。
