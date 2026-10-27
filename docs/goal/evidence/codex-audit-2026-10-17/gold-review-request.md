# 规则金标送审请求（待 Lead/DS 审核，未应用）

状态：REVIEW_REQUIRED。目标规则是仓库已采纳的 2026-10-17 快照口径；本请求不另定规则、不自动提升证据等级。

| 对象 | 旧钉/旧活动内容 | 提案 | 留痕/验收 |
|---|---|---|---|
| EV-TYPE-MULTIPLIER 当前 claim | 双属性两系相乘，双弱 ×4 | 单/双属性读 types.json 显式行；双弱 ×3；缺 67 组合 unsupported | 原 claim/裁决原话归历史；默认 RAG 当前正文不再拼入已退役规则；审查来源/等级是否仍合适 |
| heldout M07 | anchors=[×4, ×0.25]；why 仍认相乘 | 查询及 expected id 保留，anchor 按新口径改 ×3/×0.25；why 明确新版理由 | 旧 expected/anchors/why 有历史记录；不能删除 M07 或放宽到任意匹配 |
| bridge 相性契约 | 4 / snapshot_agrees=false / multiply | 3 / true / snapshot_row；缺行 unsupported 不变 | 提案 patch 003；旧钉留注释；新钉已验证正常绿、回退相乘必红 |
| meta-prior 来源 claim | 生成器及 v1.json 均仍写相乘 | 修生成器再重建派生件，避免手改 JSON 被覆盖 | 查所有 EV-TYPE-MULTIPLIER 引用；生成一致性与内容语义两者都要查 |
| 回执 note / multiplier_rule | 数值 3、说明相乘 | 当前说明逐字快照，旧文案仅在源码历史注释保留 | patch 001/002，4 条新测试中 W 原来 2 红、补丁后含原16条共20绿 |

证据：rule-audit.md A1–A5；原始 logs；source/latest manifests。

特别约束：不能只改 claim 却把旧 notes/source quotes 原样塞回模型的当前规则正文；不能把旧历史真相删除以换绿；不要把历史 recorded_gameplay 裁决自动等同于今天有独立官方验证。

建议 DS 整合顺序：确认活动/历史 schema 与等级 → 规则台账 → 先验生成器 → 派生件 → M07/bridge 改钉送审 → 相关回归 → 固定最终 SHA 再验收。

本文件已作为审计包提交给 Lead 审阅；尚未通过外部通信工具发给 DS，也没有写共享台账或审批状态文件。
