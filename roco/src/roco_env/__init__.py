"""roco_env —— 《洛克王国：世界》手游规则的唯一来源。

设计约束（来自实施书，必须遵守）：

1. **数值不写在这里。** 精灵面板、技能威力/能耗、属性相性、术语文本
   全部从 ``data/roco/normalized/<ruleset_id>/`` 读取。本包只写「规则」——
   即这些数值如何组合、事件按什么顺序发生。
2. **未知机制 fail closed。** 没有实现的效果原语返回 ``unsupported``，
   **绝不**退化成「默认 40 威力普通攻击」这类自创默认值。
3. **确定性。** 同一个 seed + 同一串动作 = 完全相同的状态与事件序列。
   随机只在显式声明处发生，且由 seed 驱动。
4. **双方基于同一事前状态决策。** 任何一方的观察里都不出现对手的未公开选择。
5. **只有 SIM_VERIFIED 的精灵能进训练场。** 本包不负责 UI。

模块划分：

    data.py     规则集加载与只读访问（唯一 I/O 边界）
    schema.py   数据结构与序列化
    effects.py  效果原语；未实现的一律 UnsupportedEffect
    env.py      reset / observe / legal_actions / step_joint / serialize / replay
    ruleset.py  规则版本、覆盖状态、支持等级

证据等级：每个非平凡决策都在代码里注明它依据的是
`Terms.lua` 的哪一条（``依据：术语 1016``）还是**假设**（``假设``）。
标了「假设」的地方，都是 microcase 尚未用实测确认的，必须能被单独推翻。
"""

__version__ = "0.1.0"

__all__ = ["data", "schema", "effects", "env", "ruleset"]
