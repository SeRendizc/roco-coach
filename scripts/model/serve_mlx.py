#!/usr/bin/env python3
"""Mac 本地小模型推理服务（MLX）。

它是什么
--------
一个**常驻**的推理进程：启动时加载一次量化权重，之后从 stdin 逐行读 JSON 请求、
往 stdout 逐行写 JSON 响应。上面再套一层 Node 网关（`src/coach/local-model.js`）
把它暴露成 Agent 能用的接口。

为什么是常驻 + stdio，而不是每个请求起一个进程：
权重加载是秒级、且立刻占用数 GB 统一内存。每次请求重载既慢又会把
「首 token 延迟」这个指标彻底污染（测出来的是加载时间）。
常驻让「首 token」与「加载」分开可测。

这里**不做**的事（刻意的）
------------------------
- 不解析游戏事实、不算伤害、不生成合法动作：那些只能来自规则引擎与 planner。
  本进程只把给定的**结构化输入**转成一段文字或一次工具选择。
- 不联网。除了启动时读本地权重，运行期没有任何出网路径。
- 不写文件。stdout 只有协议 JSON，日志走 stderr。

协议
----
请求（每行一个 JSON）::

    {"id":"r1","prompt":"...","system":"...","max_tokens":128,"temperature":0.0}
    {"id":"r2","messages":[{"role":"user","content":"..."}],"max_tokens":128}

响应::

    {"id":"r1","ok":true,"text":"...","prompt_tokens":N,"completion_tokens":M,
     "first_token_ms":F,"total_ms":T,"tokens_per_second":R,
     "peak_memory_gb":G,"stop_reason":"length|stop"}
    {"id":"r1","ok":false,"error_type":"timeout|bad_request|internal","message":"..."}

`temperature=0` 是默认值：这一层的职责是**可复现**的结构化输出，
采样带来的多样性由上层用不同的候选数解决，不在这里引入。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional

DEFAULT_MODEL = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", ".models",
    "mlx", "Qwen3.5-4B-4bit")


def _peak_memory_gb() -> Optional[float]:
    """MLX 自己报的峰值显存/统一内存（GB）。

    `mx.metal.get_peak_memory()` 只统计 MLX 分配的缓冲，不含 Python 堆与权重映射，
    所以它是**下限**而不是整机内存占用。整机口径另由 `scripts/model/healthcheck`
    读 `ps` 的 RSS 给出，两个都要报，不能只报一个。
    """
    try:
        import mlx.core as mx
        if hasattr(mx, "metal") and hasattr(mx.metal, "get_peak_memory"):
            return round(mx.metal.get_peak_memory() / (1024 ** 3), 3)
        if hasattr(mx, "get_peak_memory"):
            return round(mx.get_peak_memory() / (1024 ** 3), 3)
    except Exception:  # noqa: BLE001 - 拿不到就不报，不编一个数字
        return None
    return None


class Engine:
    """把一个 mlx-lm 模型包成「可复现、可测延迟」的调用。"""

    def __init__(self, model_path: str, *, adapter_path: Optional[str] = None,
                 draft_model: Optional[str] = None):
        from mlx_lm import load  # 延迟导入：不推理时不占内存

        self.model_path = model_path
        self.adapter_path = adapter_path
        started = time.perf_counter()
        self.model, self.tokenizer = load(model_path, adapter_path=adapter_path)
        self.load_seconds = round(time.perf_counter() - started, 2)
        self.draft_model = None
        if draft_model:
            from mlx_lm import load as _load
            self.draft_model, _ = _load(draft_model)
        self.requests = 0

    def build_prompt(self, request: Dict[str, Any]) -> str:
        """把请求变成模型输入。支持两种输入形状，便于上层按需选择。"""
        messages: List[Dict[str, str]] = []
        if request.get("system"):
            messages.append({"role": "system", "content": str(request["system"])})
        if request.get("messages"):
            for item in request["messages"]:
                role = item.get("role", "user")
                if role not in ("system", "user", "assistant"):
                    raise ValueError("role 必须是 system/user/assistant")
                messages.append({"role": role, "content": str(item.get("content", ""))})
        elif request.get("prompt") is not None:
            messages.append({"role": "user", "content": str(request["prompt"])})
        else:
            raise ValueError("请求必须带 prompt 或 messages")
        # 这个模型的模板支持 `enable_thinking`：默认会先写一段 `<think>` 推理过程。
        # 对「约 3 秒预算 + 结构化输出」的在线角色，思考段既吃预算又让输出难解析，
        # 所以**默认关掉**；需要 teacher 质量时由请求显式打开。
        enable_thinking = bool(request.get("enable_thinking", False))
        try:
            return self.tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True,
                enable_thinking=enable_thinking)
        except TypeError:
            # 模板不支持这个开关时不要静默按默认跑：如实说出来。
            raise ValueError("这个模型的 chat template 不支持 enable_thinking 开关")

    def generate(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """流式生成并在过程中测「首 token」，最后给引擎自报的吞吐与峰值内存。

        为什么用 `stream_generate` 而不是 `generate`：
        首 token 延迟是产品体感的关键指标（约 3 秒预算里它占大头），
        而一次性 `generate` 只有总时长。自己写一个 `first_token_ms = total * 0.3`
        是编数字；流式拿到第一个响应块的时间才是真的。
        """
        from mlx_lm import stream_generate
        from mlx_lm.sample_utils import make_sampler

        max_tokens = int(request.get("max_tokens", 256))
        if max_tokens <= 0 or max_tokens > 4096:
            raise ValueError("max_tokens 必须在 1..4096")
        temperature = float(request.get("temperature", 0.0))
        if temperature < 0 or temperature > 2:
            raise ValueError("temperature 必须在 0..2")
        # mlx-lm 0.31 的采样接口是 `sampler` 可调用对象，不再接受 `temp=`。
        # temperature=0 时 make_sampler 走贪心（可复现）。
        sampler = make_sampler(temp=temperature)
        prompt = self.build_prompt(request)

        started = time.perf_counter()
        first_token_ms: Optional[float] = None
        pieces: List[str] = []
        last = None
        for response in stream_generate(
                self.model, self.tokenizer, prompt=prompt,
                max_tokens=max_tokens, sampler=sampler,
                draft_model=self.draft_model):
            if first_token_ms is None:
                first_token_ms = round((time.perf_counter() - started) * 1000, 1)
            pieces.append(response.text)
            last = response
        total_ms = round((time.perf_counter() - started) * 1000, 1)
        text = "".join(pieces)
        self.requests += 1
        # 引擎自报的数字优先（它数的是真实 token，不是我按字符估的）；
        # 拿不到时才用 tokenizer 数一遍，并且**注明**是本地数的。
        prompt_tokens = getattr(last, "prompt_tokens", None) if last else None
        completion_tokens = getattr(last, "generation_tokens", None) if last else None
        source = "engine"
        if not isinstance(prompt_tokens, int):
            prompt_tokens = len(self.tokenizer.encode(prompt))
            completion_tokens = len(self.tokenizer.encode(text))
            source = "tokenizer"
        # 峰值内存取**整段生成里最大值**：`last.peak_memory` 有时不含 prefill，
        # 而 `mx.get_peak_memory()` 是 MLX 自进程启动以来的高水位。两个都取，
        # 报大的那个，并在 `memory_source` 里写明数字是怎么来的。
        peak = getattr(last, "peak_memory", None) if last else None
        peak = max([p for p in (peak, _peak_memory_gb() and _peak_memory_gb() * (1024 ** 3))
                    if isinstance(p, (int, float))] or [0]) or None
        memory_source = "mlx-peak" if peak else None
        return {
            "text": text,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "first_token_ms": first_token_ms,
            "total_ms": total_ms,
            "tokens_per_second": (round(completion_tokens / (total_ms / 1000), 2)
                                  if total_ms > 0 and completion_tokens else None),
            "peak_memory_gb": (round(peak / (1024 ** 3), 3) if isinstance(peak, (int, float))
                               else _peak_memory_gb()),
            "memory_source": memory_source,
            "stop_reason": (getattr(last, "finish_reason", None) or
                            ("length" if completion_tokens and completion_tokens >= max_tokens else "stop")),
            "counted_by": source,
        }


def serve(engine: Engine, *, log=sys.stderr) -> int:
    """读一行请求、写一行响应，直到 stdin 关闭。"""
    log.write(json.dumps({
        "event": "ready", "model_path": engine.model_path,
        "adapter_path": engine.adapter_path, "load_seconds": engine.load_seconds,
        "peak_memory_gb": _peak_memory_gb(),
    }, ensure_ascii=False) + "\n")
    log.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            result = engine.generate(request)
            payload = {"id": request_id, "ok": True, **result}
        except ValueError as exc:
            payload = {"id": request_id, "ok": False, "error_type": "bad_request",
                       "message": str(exc)}
        except Exception as exc:  # noqa: BLE001 - 进程级异常要如实上报，不要吞
            payload = {"id": request_id, "ok": False, "error_type": "internal",
                       "message": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Mac 本地 MLX 推理服务（stdio JSONL）")
    parser.add_argument("--model", default=os.environ.get("ROCO_LOCAL_MODEL", DEFAULT_MODEL))
    parser.add_argument("--adapter", default=os.environ.get("ROCO_LOCAL_ADAPTER") or None)
    parser.add_argument("--draft-model", default=os.environ.get("ROCO_LOCAL_DRAFT") or None)
    parser.add_argument("--selftest", action="store_true",
                        help="打印环境与模型路径检查结果后退出，不加载权重")
    args = parser.parse_args(argv)

    if args.selftest:
        exists = os.path.isdir(args.model)
        files = sorted(os.listdir(args.model)) if exists else []
        print(json.dumps({
            "model": args.model, "exists": exists, "files": files[:12],
            "mlx_available": _mlx_available(),
            "peak_memory_gb": None,
        }, ensure_ascii=False, indent=2))
        return 0 if exists else 2

    engine = Engine(args.model, adapter_path=args.adapter, draft_model=args.draft_model)
    return serve(engine)


def _mlx_available() -> bool:
    try:
        import mlx.core  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


if __name__ == "__main__":
    raise SystemExit(main())
