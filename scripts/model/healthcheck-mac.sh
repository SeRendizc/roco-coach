#!/usr/bin/env bash
# 一键健康检查：manifest 校验 + 网关健康 + **真的**跑一次生成并报延迟/内存。
#
# 为什么要真跑一次：只看进程在不在，无法发现「权重加载了但推理退化」。
# 这里用最短的探针（几个 token），并把首 token / 总延迟 / 吞吐 / 峰值内存一起报出来。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"
GW_PORT="${ROCO_LOCAL_PORT:-8766}"
URL="http://127.0.0.1:${GW_PORT}"
FAIL=0

echo "== manifest =="
node scripts/model/verify-manifest.mjs || FAIL=1

echo "== 网关 =="
if ! curl -fsS "${URL}/healthz" >/dev/null 2>&1; then
  echo "  网关不可用：${URL}（先跑 bash scripts/model/start-mac.sh）"; FAIL=1
else
  curl -fsS "${URL}/healthz" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  ok', d['ok'], '| ready', d['ready'], '| 并发', d['concurrency'])
print('  最近一次：首 token', d['latest']['first_token_ms'], 'ms；总', d['latest']['total_ms'],
      'ms；', d['latest']['tokens_per_second'], 'tok/s；峰值内存', d['latest']['peak_memory_gb'], 'GB')
print('  p50/p95 总延迟', d['p50_total_ms'], '/', d['p95_total_ms'], 'ms')
print('  计数', d['counters'])
"
fi

echo "== 真实生成探针 =="
if [ "$FAIL" = "0" ]; then
  python3 - "${URL}" <<'PY'
import json, sys, time, urllib.request
url = sys.argv[1] + "/v1/chat/completions"
body = json.dumps({
    "messages": [{"role": "user", "content": "只回答四个字：规则为准。"}],
    "max_tokens": 32, "temperature": 0,
}).encode()
started = time.perf_counter()
req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.load(resp)
except Exception as exc:
    print(f"  探针失败：{exc}")
    raise SystemExit(1)
wall = (time.perf_counter() - started) * 1000
x = payload.get("x_roco", {})
print("  首 token", x.get("first_token_ms"), "ms；总", x.get("total_ms"),
      "ms；墙钟", round(wall, 1), "ms；", x.get("tokens_per_second"), "tok/s；峰值内存",
      x.get("peak_memory_gb"), "GB")
print("  文本：", payload["choices"][0]["message"]["content"].strip()[:80])
print("  usage：", payload.get("usage"))
PY
fi
echo "== 结论 =="
[ "$FAIL" = "0" ] && echo "Mac 本地模型：健康" || echo "Mac 本地模型：有问题（见上）"
exit $FAIL
