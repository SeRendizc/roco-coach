#!/usr/bin/env bash
# Mac 本地小模型：一键 setup（幂等）。
#
# 做什么
#   1. 建/复用 `.venv-mlx`（Python 3.12 + mlx-lm 固定版本）；
#   2. 按 `models/registry.json` 下载缺失的权重到 `.models/mlx/<name>`；
#   3. 用 SHA256 校验每一个文件（权重不入库，靠这一步证明「是同一份东西」）。
#
# 不做
#   - 不下载 manifest 里没有登记的模型（避免「顺手多拉几个大 checkpoint」）；
#   - 不写任何密钥、不登录、不接受许可证（登记的模型都是 apache-2.0，无需同意）；
#   - 不改仓库外的目录（uv 缓存与 HF 缓存都指向仓库内的 tmp/ 与 .models/）。
#
# 用法::
#
#     bash scripts/model/setup-mac.sh              # 建环境 + 补齐权重 + 校验
#     bash scripts/model/setup-mac.sh --check-only # 只校验，不下载（CI/断网可用）
#     bash scripts/model/setup-mac.sh --force-env  # 重建 venv
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"

VENV="${ROOT}/.venv-mlx"
MODELS_DIR="${ROOT}/.models/mlx"
MANIFEST="${ROOT}/models/registry.json"
PY_VERSION="3.12"
MLX_LM_VERSION="0.31.3"

CHECK_ONLY=0
FORCE_ENV=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --force-env) FORCE_ENV=1 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

# 仓库内的缓存目录：沙箱与干净机器上都不该依赖 $HOME 可写。
export UV_CACHE_DIR="${UV_CACHE_DIR:-${ROOT}/tmp/uv-cache}"
export HF_HOME="${HF_HOME:-${ROOT}/.models/hf}"
export UV_PYTHON_DOWNLOADS="${UV_PYTHON_DOWNLOADS:-never}"
mkdir -p "$UV_CACHE_DIR" "$HF_HOME" "${MODELS_DIR}"

# 这台机器上 `no_proxy` 含 `[::1]`，httpx 解析端口时会报 `Invalid port: ':1]'`。
# 下载走代理、回环不走代理，所以这里给一个干净的值。
export no_proxy="${no_proxy_clean:-localhost,127.0.0.1,::1}"
export NO_PROXY="$no_proxy"

if ! command -v uv >/dev/null 2>&1; then
  echo "缺少 uv（https://docs.astral.sh/uv/）。安装：brew install uv" >&2
  exit 3
fi

echo "== 1/3 运行时 =="
if [ "$FORCE_ENV" = "1" ] && [ -d "${VENV}" ]; then rm -rf "${VENV}"; fi
if [ ! -x "${VENV}/bin/python" ]; then
  if [ "$CHECK_ONLY" = "1" ]; then echo "缺少 ${VENV}（--check-only 不建环境）" >&2; exit 3; fi
  uv venv --python "$PY_VERSION" "${VENV}"
fi
if [ "$CHECK_ONLY" != "1" ]; then
  uv pip install --python "${VENV}/bin/python" "mlx-lm==$MLX_LM_VERSION"
fi
"${VENV}/bin/python" - <<'PY'
import importlib.metadata as md
import mlx.core as mx
print(f"  mlx backend = {mx.default_device()}；mlx-lm {md.version('mlx-lm')}")
PY

echo "== 2/3 权重 =="
if [ "$CHECK_ONLY" != "1" ]; then
  "${VENV}/bin/python" - "${MANIFEST}" "${MODELS_DIR}" <<'PY'
import json, os, subprocess, sys
manifest_path, models_dir = sys.argv[1], sys.argv[2]
manifest = json.load(open(manifest_path, encoding="utf-8"))
hub = os.path.join(os.environ["HF_HOME"], "..", "hf")  # 仅用于打印
for entry in manifest["models"]:
    target = os.path.join(models_dir, os.path.basename(entry["local_dir"]))
    expected = entry["files"]
    present = os.path.isdir(target) and all(
        os.path.exists(os.path.join(target, name)) for name in expected)
    if present:
        print(f"  {entry['model_id']} 已存在，跳过下载")
        continue
    print(f"  下载 {entry['model_id']}（revision {entry['revision']}，"
          f"{entry['download_bytes'] / 1e9:.2f} GB）→ {entry['local_dir']}")
    subprocess.run([sys.executable, "-m", "huggingface_hub.commands.huggingface_cli",
                    "download", entry["model_id"], "--local-dir", target,
                    "--revision", entry["revision"]], check=True)
PY
fi

echo "== 3/3 校验 =="
node "${ROOT}/scripts/model/verify-manifest.mjs"

cat <<'MSG'

setup 完成。下一步：
  bash scripts/model/start-mac.sh          # 常驻推理服务
  bash scripts/model/healthcheck-mac.sh    # 健康检查 + 延迟/内存实测
  bash scripts/model/stop-mac.sh           # 停掉
MSG
