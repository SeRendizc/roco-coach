#!/usr/bin/env python3
"""**训练侧对齐包装**：让 `mlx_lm lora` 走 `enable_thinking=False`（与服务一致）。

Codex 4B 前置第 4 项实测的**不一致**（`scripts/model/verify-template-consistency.py`）：

| 侧 | 出处 | 传了什么 | prompt tokens |
|---|---|---|---|
| 训练 | `train_v9.sh` → `mlx_lm lora` | **什么都没传**（模板里 `enable_thinking` 未定义 ⇒ 走 else 分支） | **99** |
| 服务 | `scripts/model/serve_mlx.py:108` | `request.get("enable_thinking", False)` ⇒ 默认 **False** | **101** |

整串长度相同（123），差的是**切分点**：`mask_prompt: true` 下训练把 **24** tok 当答案、服务只把 **22** 当答案
⇒ **训练在教模型生成那 2 个 token（空 think 块收尾），而服务端会替它注入**。

## 为什么用"包装"而不是"改依赖"

已核实：`mlx_lm.tuner.datasets` 调 `apply_chat_template` **4 处、一处都没传 `enable_thinking`**
（该类源码里该关键字 **0 命中**）⇒ **mlx-lm 没有这个旋钮**，"在 yaml 里加一行"**做不到**。

而在**我们自己的入口**里包一层 `apply_chat_template`：
- **不改 `mlx_lm` 源码**（Codex：不得无证据修改依赖库）；
- **不动主服务**（`serve_mlx.py` 的默认值保持 `False`）；
- 对齐方向选"改训练"，所以**线上一个字都不用变**。

## ⚠ 本文件**没有执行过训练**

DSH 不启动训练。这里只提供**可运行的实现** + 一个**独立的 token/mask 验证**供人审阅：

```sh
# 1) 先验证包装后的前缀与服务一致（退出码 0 才算对齐）——**不训练**
.venv-mlx/bin/python scripts/model/verify-template-consistency.py --with-wrapper

# 2) 真要训练时，用本文件代替 `python -m mlx_lm lora`（参数原样透传）
.venv-mlx/bin/python scripts/model/train_v9_aligned.py --config …/lora-v9.yaml --model … --data … --train …
```

用法上它**就是** `mlx_lm lora` 的替身：把 `--` 之后的参数原样交给 `mlx_lm.lora.main()`。
"""

import functools
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def align_tokenizer(tokenizer):
    """把 `apply_chat_template` 包一层：**默认补上 `enable_thinking=False`**（与服务一致）。

    显式传入的 `enable_thinking` 尊重调用方（`setdefault` 而不是硬覆盖）——
    这样将来若要跑"开思考"的对照，不用改这个文件。
    """
    original = tokenizer.apply_chat_template
    if getattr(original, "__roco_aligned__", False):
        return tokenizer  # 幂等：重复包不叠加

    @functools.wraps(original)
    def wrapped(*args, **kwargs):
        kwargs.setdefault("enable_thinking", False)
        return original(*args, **kwargs)

    wrapped.__roco_aligned__ = True
    tokenizer.apply_chat_template = wrapped
    return tokenizer


def main(argv=None):
    saved_argv_probe = list(sys.argv)
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] == "--self-check":
        # 只验证"包得上、幂等、且真的改了前缀"，**不训练、不加载权重**
        from transformers import AutoTokenizer

        model_dir = Path(args[1]) if len(args) > 1 else REPO / ".models" / "mlx" / "Qwen3.5-4B-4bit"
        tok = AutoTokenizer.from_pretrained(str(model_dir))
        msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "ok"}]
        before = tok.apply_chat_template(msgs[:-1], tokenize=True, add_generation_prompt=True, return_dict=False)
        align_tokenizer(tok)
        after = tok.apply_chat_template(msgs[:-1], tokenize=True, add_generation_prompt=True, return_dict=False)
        align_tokenizer(tok)  # 幂等
        again = tok.apply_chat_template(msgs[:-1], tokenize=True, add_generation_prompt=True, return_dict=False)
        ids = lambda o: list(getattr(o, "ids", o))
        print(f"[包装自检] 包装前 prompt={len(ids(before))} tok｜包装后 prompt={len(ids(after))} tok")
        print(f"[包装自检] 幂等（再包一次结果不变）：{ids(after) == ids(again)}")
        print(f"[包装自检] 包装确实改了前缀：{ids(before) != ids(after)}")
        return 0

    if args and args[0] == '--entry-check':
        # **入口集成检查**（Codex 要求）：不加载权重、不训练，只验"参数能不能真的到 `main`、
        # tokenizer 替身会不会被调上"。做法：把 `load` 与 `main` 都换成替身。
        import mlx_lm.lora as lora_mod

        seen = {'argv': None, 'load_called': False, 'aligned': False}

        def fake_load(*a, **kw):
            seen['load_called'] = True
            class _Tok:
                def apply_chat_template(self, *aa, **kk):
                    return [1, 2, 3]
            tok = _Tok()
            seen['aligned'] = bool(getattr(align_tokenizer(tok).apply_chat_template, '__roco_aligned__', False))
            return object(), tok

        def fake_main():
            seen['argv'] = list(sys.argv[1:])
            # 走 `load` 那条路，确认替身接得上（真实 `lora.py:329` 就是裸名调用 `load(...)`）
            _m, tok = lora_mod.load('fake-model')
            tok.apply_chat_template([{'role': 'user', 'content': 'x'}])
            return 0

        original_main, original_load = lora_mod.main, lora_mod.load
        lora_mod.main, lora_mod.load = fake_main, fake_load
        try:
            rc = main(['--config', 'x.yaml', '--data', 'd', '--train'])
        finally:
            lora_mod.main, lora_mod.load = original_main, original_load
        ok = rc == 0 and seen['argv'] == ['--config', 'x.yaml', '--data', 'd', '--train'] \
            and seen['load_called'] and seen['aligned'] and sys.argv == saved_argv_probe
        print(f"[入口检查] 参数到达 main：{seen['argv']}")
        print(f"[入口检查] 替身 load 被调用：{seen['load_called']}｜tokenizer 已被包装：{seen['aligned']}")
        print(f"[入口检查] sys.argv 已还原：{sys.argv == saved_argv_probe}")
        print(f"[入口检查] {'✔ 通过' if ok else '✖ 不通过'}")
        return 0 if ok else 2

    # 真正训练时的入口：先包 tokenizer，再把参数原样交给 mlx_lm。
    #
    # ⚠ 2026-09-29 修（**Codex 09:38 复核抓到的真 bug**）：
    # 本机依赖里 `mlx_lm.lora.main` 的签名是 **`()`（无参）**，内部走 `parser.parse_args()`
    # **从 `sys.argv` 读**（实测：`.venv-mlx/.../mlx_lm/lora.py:350 def main():`、`:353 parser.parse_args()`）。
    # 我上一版写的是 `lora_mod.main(args)` ⇒ **会 TypeError**，而当时的"包装验证"只验了 **token 前缀**、
    # **没覆盖真实入口调用** ⇒ 那条验证通过**不等于**入口能用。**Codex 说得对。**
    #
    # ⇒ 按本机实际依赖改：**临时换 `sys.argv`、`finally` 原样恢复**。
    import mlx_lm.lora as lora_mod

    original_load = lora_mod.load

    @functools.wraps(original_load)
    def load_aligned(*a, **kw):
        model, tokenizer = original_load(*a, **kw)
        align_tokenizer(tokenizer)
        return model, tokenizer

    # `lora.py` 是 `from .utils import … load …` 且以**裸名** `load(...)` 调用（`:24` / `:329`）
    # ⇒ 替换模块属性**确实能替上**（这一点单独核过，不是想当然）。
    lora_mod.load = load_aligned
    saved_argv = sys.argv
    try:
        sys.argv = [saved_argv[0], *args]
        return lora_mod.main()           # ← **不传参**：它自己读 sys.argv
    finally:
        sys.argv = saved_argv            # 参数环境原样还原
        lora_mod.load = original_load    # 替身也还原，别污染同进程的后续调用


if __name__ == "__main__":
    raise SystemExit(main())
