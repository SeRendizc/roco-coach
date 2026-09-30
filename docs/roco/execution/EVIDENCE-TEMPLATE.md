# 分计划证据格式

每个分计划保存 reports/roco/product-execution/<ID>/result.json 与 acceptance.md，原始数据使用相对路径引用。不要复制大量日志进总计划。

## result.json 必需字段

- schema: roco-dsh-plan-result/v1
- plan_id、status、completed_steps、remaining_steps、checked_at
- base_head、tested_head、dirty_file_hashes、rules_version
- owner、changed_files、write_scope_conflicts
- commands: 每条含命令、cwd、退出码、日志路径、实际执行时间
- checks: 每条含验收条件、结果、证据路径；失败不能漏报
- counterexamples: 输入改了什么、预期、实际、证据路径
- runtime: code / isolated / player 三栏；各含 status、URL、启动时间/实例标识/构建指纹（无法取得写 null 并解释）、已运行端点
- commit、remote_sha；尚未提交写 null，验收后再更新，不能编造未来 SHA
- blockers: 阻塞条件、尝试、解除者、允许的独立工作
- next_plan、next_action

工具或引擎分析还需保留 match_id、decision_id/state_version、event_seq、公开观察、假设来源、合法动作、分析预算、结果与实际状态转移。实际 schema 可复用仓库定义，不重复发明相同字段。

## acceptance.md 最多保留这些内容

1. 玩家问题与本次结果。
2. 改了哪些文件及原因。
3. 已通过与失败的验收，链接原始证据。
4. 信息边界与反例结果。
5. 代码/隔离实例/玩家运行版分别是什么状态。
6. 剩余问题、下一项入口及唯一 next_action。

引用截图需附 URL、视口、版本、操作步骤；截图只证明可见结果，计算与状态变化仍需 JSON/事件。不得以页面 200、测试总数、文件存在、模型自评或更长回复单独作为完成证明。
