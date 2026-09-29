#!/usr/bin/env python3
"""核**训练侧与推理侧的 token 模板是否一致**（Codex 4B 前置第 4 项）。

Codex 原话：
  「验证训练/推理 `enable_thinking`、token 前缀及 `mask_prompt` 的答案区间一致；
    **不要只看字符串相似**，也不要无证据修改依赖库。」

而交接包自带的 `token_audit.py` 只打印一句提示（「Train prefix default and serving
enable_thinking=False differ」）—— **那是"要核"，不是"核过"**。这个脚本才是核。

## 两侧各自怎么设的（先读代码，再用 tokenizer 实测）

| 侧 | 出处 | 传了什么 |
|---|---|---|
| **训练** | `train_v9.sh` → `mlx_lm lora --config lora-v9.yaml` | **什么都没传** ⇒ 模板里 `enable_thinking` **未定义** |
| **服务** | `scripts/model/serve_mlx.py:108` | `request.get("enable_thinking", False)` ⇒ 默认 **False** |

模板（`.models/mlx/Qwen3.5-4B-4bit/chat_template.jinja:147-152`）：
```jinja
{%- if add_generation_prompt %}
  {%- if enable_thinking is defined and enable_thinking is false %}
      {{- '<think>\n\n</think>\n\n' }}
  {%- else %}
      {{- '<think>\n' }}
```
⇒ 两条分支拼出的**前缀 token 不同**。本脚本量：差在哪、差多少、**答案区间是否受影响**。

## `mask_prompt: true` 的答案区间怎么算

`lora-v9.yaml` 里 `mask_prompt: true`。mlx-lm 的约定是：`prompt = 模板(messages[:-1], add_generation_prompt=True)`、
`completion = messages[-1]`，**损失只算 completion 那一段**。
⇒ 所以"答案区间一致"= 两种模式下 `len(prompt_tokens)` 之后的那段**逐 token 相同**。

用法：`.venv-mlx/bin/python scripts/model/verify-template-consistency.py`
"""

import json
import sys
from pathlib import Path

from transformers import AutoTokenizer

REPO = Path(__file__).resolve().parents[2]
MODEL_DIR = REPO / ".models" / "mlx" / "Qwen3.5-4B-4bit"
SEED = REPO / "reports" / "roco" / "sft-v9-seed" / "train.jsonl"


def message_pair():
    """取一条**真实种子样本**的 messages（没有就退回一条最小对）。"""
    if SEED.exists():
        first = SEED.read_text(encoding="utf8").splitlines()[0]
        row = json.loads(first)
        msgs = [{"role": m["role"], "content": m["content"]} for m in row["messages"]]
        if not any(m["role"] == "system" for m in msgs):
            msgs = [{"role": "system", "content": "你在为游戏教练决定下一步查不查工具。"}] + msgs
        return msgs, "reports/roco/sft-v9-seed/train.jsonl#1"
    return [
        {"role": "system", "content": "你在为游戏教练决定下一步查不查工具。"},
        {"role": "user", "content": '{"message":"寂灭骨龙的种族值是多少？","screen":"camp"}'},
        {"role": "assistant", "content": '{"tool":"query_rules","args":{"kind":"pet"}}'},
    ], "（种子不在，用最小对）"


def _ids(out):
    """`apply_chat_template(tokenize=True)` 在不同版本里返回 list / Encoding / dict —— 统一成 list[int]。"""
    if isinstance(out, list) and (not out or isinstance(out[0], int)):
        return list(out)
    ids = getattr(out, "ids", None)          # tokenizers.Encoding
    if ids is not None:
        return list(ids)
    if isinstance(out, dict) and "input_ids" in out:
        return list(out["input_ids"])
    raise TypeError(f"认不出的 tokenize 返回类型：{type(out)}")


def render(tok, messages, kwargs):
    full = _ids(tok.apply_chat_template(messages, tokenize=True, add_generation_prompt=False,
                                        return_dict=False, **kwargs))
    prompt = _ids(tok.apply_chat_template(messages[:-1], tokenize=True, add_generation_prompt=True,
                                          return_dict=False, **kwargs))
    return {"full": full, "prompt": prompt}


def tail(tok, ids, n=10):
    return repr(tok.decode(ids[-n:]))


def main():
    tok = AutoTokenizer.from_pretrained(str(MODEL_DIR))
    messages, origin = message_pair()
    print(f"[模板核验] 模型 {MODEL_DIR.name}｜样本来自 {origin}")
    print(f"[模板核验] messages：{len(messages)} 条（最后一条是助手答案）")

    # 训练侧：**不传 enable_thinking**（模板里未定义 ⇒ 走 else 分支）
    train = render(tok, messages, {})
    # 服务侧：默认 False（`serve_mlx.py:108`）
    serve = render(tok, messages, {"enable_thinking": False})
    # 对照：显式 True
    think = render(tok, messages, {"enable_thinking": True})

    rows = [("训练（未传 = 模板默认）", train), ("服务（enable_thinking=False）", serve), ("对照 enable_thinking=True", think)]
    for name, r in rows:
        print(f"  {name:28s} prompt={len(r['prompt']):4d} tok｜full={len(r['full']):4d} tok｜前缀尾部 {tail(tok, r['prompt'])}")

    same_prefix = train["prompt"] == serve["prompt"]
    same_full = train["full"] == serve["full"]
    print()
    print(f"  训练与服务的前缀**逐 token 相同**：{same_prefix}")
    print(f"  训练与服务的整串**逐 token 相同**：{same_full}")

    # ── `mask_prompt: true` 的答案区间 ──────────────────────────────────────
    # mlx-lm 约定：损失只算 prompt 之后那一段。所以"答案区间一致"= 那段逐 token 相同。
    span_train = train["full"][len(train["prompt"]):]
    span_serve = serve["full"][len(serve["prompt"]):]
    ans_same = span_train == span_serve
    print(f"  被 mask 的答案区间**逐 token 相同**：{ans_same}"
          f"（训练 {len(span_train)} tok / 服务 {len(span_serve)} tok）")
    if ans_same:
        print(f"    答案区间原文：{tail(tok, span_train, 12)}")
    else:
        print(f"    训练：{tail(tok, span_train, 12)}")
        print(f"    服务：{tail(tok, span_serve, 12)}")

    # ── 包装档（Codex 第 4 项的**可运行对齐方案**）─────────────────────────────
    # `train_v9_aligned.py` 在训练入口把 `apply_chat_template` 包一层，默认补
    # `enable_thinking=False`。这里**独立验一次**：包装后的渲染是否与服务侧**逐 token 相同**。
    if "--with-wrapper" in sys.argv:
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location("tva", REPO / "scripts" / "model" / "train_v9_aligned.py")
        tva = _ilu.module_from_spec(spec)
        spec.loader.exec_module(tva)
        tok2 = AutoTokenizer.from_pretrained(str(MODEL_DIR))
        tva.align_tokenizer(tok2)
        wrapped = render(tok2, messages, {})          # 注意：**不传** enable_thinking，靠包装补
        same_as_serve = wrapped["prompt"] == serve["prompt"]
        span_wrapped = wrapped["full"][len(wrapped["prompt"]):]
        print()
        print(f"  [包装档] 训练侧经 `train_v9_aligned.py` 包装后 prompt={len(wrapped['prompt'])} tok")
        print(f"  [包装档] 与服务侧前缀**逐 token 相同**：{same_as_serve}")
        print(f"  [包装档] 被 mask 的答案区间与服务侧相同：{span_wrapped == span_serve}"
              f"（{len(span_wrapped)} vs {len(span_serve)} tok）")
        if same_as_serve and span_wrapped == span_serve:
            print("  [包装档] ✔ **训练侧已对齐到服务侧**（`--with-wrapper` 退出码 0）")
            return 0
        print("  [包装档] ✖ 仍未对齐 —— 不要开始正式训练")
        return 2

    verdict = "一致" if (same_prefix and ans_same) else "**不一致**"
    print()
    print(f"[模板核验] 结论：训练侧与服务侧 {verdict}")
    if not same_prefix:
        print("  ⚠ 前缀不同 ⇒ 模型在训练时见到的 token 序列与上线时不同。")
        print("     训练侧走模板 else 分支（`<think>` 开着一个思考块），服务侧默认关思考（空思考块）。")
        print("     **修法（不由本脚本执行，需人决定）**：让两侧显式取同一个值 ——")
        print("       · 要么训练也传 `enable_thinking=False`（与线上一致，且省 token）；")
        print("       · 要么服务默认改成 True（与当前训练一致）。")
        print("     在作出选择之前，**不要开始正式训练** —— 否则练出来的 prefix 与线上不一致。")
    return 0 if (same_prefix and ans_same) else 2


if __name__ == "__main__":
    sys.exit(main())
