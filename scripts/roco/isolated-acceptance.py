#!/usr/bin/env python3
"""隔离验收工具：自起一个 Python 规则服务，跑最小链路，留机器可读读数。

为什么要有它
------------
Python 战斗服务曾经在**就绪之前**就退出（`coverage.py` 缺 8 个导出，
`service.py` 在 import 期就 ImportError），而外层 Node 壳仍然 200 —— 只看外壳
会误判「服务是好的」。本工具从**独立进程 + 独立端口**这一侧复跑最小链路
（health → battle_new → legal → advance → 技能详情），把每一步的 HTTP 状态、
合法动作数、事件种类、快照指纹写进一份 JSON；缺什么就报什么，**失败不写成通过**。

用法
----
    # 正常一轮（自起服务，端口 0 = 系统分配；应 exit=0）
    python3 scripts/roco/isolated-acceptance.py

    # 反例方向（负向控制）：在**临时副本**里注入故障，脚本必须非 0 退出
    python3 scripts/roco/isolated-acceptance.py --fault-inject missing-export
    python3 scripts/roco/isolated-acceptance.py --fault-inject missing-capability

读数是 `reports/roco/product-execution/harness/last-run.json`；
`--fault-inject` 另写 `reports/roco/product-execution/harness/fault-inject-<name>.json`
（内含子进程的完整 last-run + 共享源码 sha256 注入前后未变）。

退出码（**正反两个方向刻意相反**，这样两条命令都能直接当闸用）
--------------------------------------------------------------
  正向（默认）：`0` = 六步全绿；`1` = 有步骤红；`2` = 服务没就绪/工具前置条件不满足。
  反例（`--fault-inject`）：**非 0 = 期望结果**（注入的故障被抓住，退出码就是被注入
    子进程那个）；`0` = 注入之后竟然还通过 ⇒ 负向控制失败；`3` = 子进程红了但不是
    这次注入造成的；`4` = 注入工具自身故障。

边界（不许夸大）
----------------
  · **只证明隔离实例**：本工具从不碰玩家常驻版本（8765），也不重启/不杀任何
    不是它自己起的进程（`finally` 里只 terminate 自己 Popen 出来的那个 pid）。
  · 只覆盖「服务起得来 + 最小链路能跑通 + 一条技能档位读数」；不证明整局、
    不证明 Node 外壳、不证明浏览器、不证明数据正确性。
  · `--fault-inject` 只在 `mkdtemp()` 出来的副本里改文件，**绝不改共享源码**
    （注入前后对原文件做 sha256 比对，结果写进证据 JSON）。

只用标准库：与 `roco/` 引擎同样的可移植性纪律。
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib import error as urlerror
from urllib import request as urlrequest

# ── 常量 ────────────────────────────────────────────────────────────────

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT_FROM_SCRIPT = os.path.dirname(os.path.dirname(HERE))

DEFAULT_OUT_REL = os.path.join("reports", "roco", "product-execution", "harness", "last-run.json")
EVIDENCE_DIR_REL = os.path.join("reports", "roco", "product-execution", "harness")

READY_PREFIX = "ROCO_SERVICE_READY "
FAILED_PREFIX = "ROCO_SERVICE_FAILED "

#: 标准 PVP 六宠（v3）。名字取自 `tests/test_six_pet_battle.py` 的 TEAM_A / TEAM_B，
#: id 一律**从服务自己查**（`/rules/query kind=pet`），不在本文件里抄 id 字面量。
RULESET_CONFIG_V3 = "mobile_s4_candidate_v3"
TEAM_A_NAMES = ("寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬")
TEAM_B_NAMES = ("秩序鱿墨", "画间沉铁兽", "月使鹭纳", "迷迷箱怪", "权杖-V", "卡卡虫")
DEFAULT_SEED = 11
DEFAULT_STRATEGY = "greedy_damage"

#: 技能详情那一步查的技能：`破罐破摔`（`skill_000724`）。
#: 它的档位**依赖能力位 `cond_self_debuff_power`**：那个能力位缺了，档位就从
#: SIMULATABLE_UNVERIFIED 掉到 PARTIAL（见 `--fault-inject missing-capability`）。
#: 所以这一条读数同时是「服务能答技能详情」和「能力位在位」的证据。
SKILL_ID = "skill_000724"
SKILL_EXPECT_NAME = "破罐破摔"

#: 已知基线（2026-09-30 实测）：v3 六宠第 1 回合玩家侧 12 个合法动作；
#: seed=11 首手 `skill_000576`（龙血）推进一回合产出这三类事件。
DEFAULT_EXPECT_LEGAL = 12
DEFAULT_EXPECT_EVENTS = "turn_start,defense,damage"

    # 反例方向：**临时副本**里注入的故障。`expect` 是「应当看到的失败签名」，
    #: 不是「看到任何失败都算」——一个因为别的原因红掉的负向控制是假证据。
    #:
    #: `--fault-inject` 自己的退出码（刻意与「正向验收」反向，这样它可以直接当闸用）：
    #:   非 0（= 被注入子进程的退出码）  注入的故障被抓住 ⇒ 反例方向成立，这是**期望**结果
    #:   0                              注入之后脚本仍然通过 ⇒ 负向控制失败，工具在撒谎
    #:   3                              子进程红了，但原因不是这次注入 ⇒ 负向控制不成立
    #:   4                              注入工具自身故障（锚点找不到 / 共享源码被动过 / 超时）
FAULTS: Dict[str, Dict[str, str]] = {
    "missing-export": {
        "file": os.path.join("roco_env", "coverage.py"),
        "old": "def classify_skill_declared(",
        "new": "def classify_skill_declared_disabled_by_fault_injection(",
        "what": ("复刻 b5a8d51 缺导出：coverage.classify_skill_declared 不在位 "
                 "⇒ service 在就绪行之前 ImportError 退出"),
        "expect": "service_not_ready",
    },
    "missing-capability": {
        "file": os.path.join("roco_env", "coverage.py"),
        "old": (
            "        for _name, _attr in _CAPABILITY_ATTR.items():\n"
            "            if _name not in base:\n"
            "                base[_name] = bool(getattr(cfg, _attr, False))\n"
            "        return base"
        ),
        "new": (
            "        for _name, _attr in _CAPABILITY_ATTR.items():\n"
            "            if _name not in base:\n"
            "                base[_name] = bool(getattr(cfg, _attr, False))\n"
            "        # FAULT-INJECT(missing-capability)：缺能力位（只在这个临时副本里）\n"
            "        base.pop(\"cond_self_debuff_power\", None)\n"
            "        return base"
        ),
        "what": ("缺能力位：declared_capabilities_of 的读数里摘掉 cond_self_debuff_power "
                 "⇒ skill_000724 档位 SIMULATABLE_UNVERIFIED → PARTIAL，技能详情那步必须红"),
        "expect": "step_failed:skill_detail",
    },
}


# ── 小工具 ──────────────────────────────────────────────────────────────


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def _sha256_file(path: str) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _git_info(repo: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {"branch": None, "head": None, "dirty": None, "error": None}

    def _run(*args: str) -> Optional[str]:
        try:
            proc = subprocess.run(["git", "-C", repo, *args], stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, timeout=15)
        except (OSError, subprocess.SubprocessError) as exc:
            out["error"] = f"{type(exc).__name__}: {exc}"
            return None
        if proc.returncode != 0:
            return None
        return proc.stdout.strip()

    out["branch"] = _run("rev-parse", "--abbrev-ref", "HEAD")
    out["head"] = _run("rev-parse", "HEAD")
    dirty = _run("status", "--porcelain")
    out["dirty"] = dirty.splitlines() if dirty else []
    return out


class Checks:
    """一步之内的判据集合。**每一条都留读数**，不做「默认通过」。"""

    def __init__(self) -> None:
        self.items: List[Dict[str, Any]] = []

    def add(self, name: str, ok: bool, detail: Any = None) -> bool:
        self.items.append({"name": name, "ok": bool(ok), "detail": detail})
        return bool(ok)

    def failed(self) -> List[Dict[str, Any]]:
        return [i for i in self.items if not i["ok"]]

    @property
    def ok(self) -> bool:
        return bool(self.items) and all(i["ok"] for i in self.items)


def _tail(text: str, lines: int = 12, width: int = 400) -> List[str]:
    rows = [ln[:width] for ln in (text or "").splitlines() if ln.strip()]
    return rows[-lines:]


# ── HTTP ────────────────────────────────────────────────────────────────


def http_json(base: str, path: str, body: Optional[Dict[str, Any]] = None, *,
              timeout: float = 30.0) -> Dict[str, Any]:
    """一次 JSON 往返。**任何失败都返回读数**（status 可能是 None），不抛。"""
    url = base + path
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urlrequest.Request(
        url, data=data, method="POST" if body is not None else "GET",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    started = time.perf_counter()
    status: Optional[int] = None
    raw = ""
    error: Optional[str] = None
    try:
        with urlrequest.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - 本机回环
            status = int(resp.status)
            raw = resp.read().decode("utf-8", "replace")
    except urlerror.HTTPError as exc:
        status = int(exc.code)
        raw = exc.read().decode("utf-8", "replace")
    except Exception as exc:  # URLError / timeout / 连接被拒
        error = f"{type(exc).__name__}: {exc}"
    latency_ms = round((time.perf_counter() - started) * 1000.0, 1)

    env: Optional[Dict[str, Any]] = None
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                env = parsed
            else:
                error = error or f"回执不是 JSON 对象：{type(parsed).__name__}"
        except ValueError:
            error = error or f"回执不是 JSON：{raw[:200]!r}"
    elif error is None:
        error = "回执为空"

    return {
        "url": url,
        "method": "POST" if body is not None else "GET",
        "request_sha256": _sha256_bytes(data) if data is not None else None,
        "status": status,
        "env": env,
        "error": error,
        "latency_ms": latency_ms,
    }


def _envelope_ok(res: Dict[str, Any]) -> bool:
    env = res.get("env") or {}
    return res.get("status") == 200 and env.get("ok") is True and env.get("error_type") in (None, "")


# ── 服务进程（只碰自己起的那个） ─────────────────────────────────────────


class ServiceProcess:
    """自起的 `python3 -m roco_env.service`。stop() 只 kill 自己的 pid。"""

    def __init__(self, argv: List[str], cwd: str, env: Dict[str, str], log_path: str) -> None:
        self.argv = argv
        self.cwd = cwd
        self.env = env
        self.log_path = log_path
        self.proc: Optional[subprocess.Popen] = None
        self.pid: Optional[int] = None
        self.ready: Optional[Dict[str, Any]] = None
        self.failed: Optional[Dict[str, Any]] = None
        self.not_ready: Optional[Dict[str, Any]] = None
        self.ready_raw: Optional[str] = None
        self._pos = 0
        self._open_error: Optional[str] = None

    def start(self) -> None:
        log = open(self.log_path, "w", encoding="utf-8")
        try:
            self.proc = subprocess.Popen(
                self.argv, cwd=self.cwd, env=self.env,
                stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                text=True,
            )
        finally:
            log.close()
        self.pid = self.proc.pid

    def _scan(self) -> None:
        try:
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as fh:
                fh.seek(self._pos)
                chunk = fh.read()
                self._pos = fh.tell()
        except OSError as exc:
            self._open_error = f"{type(exc).__name__}: {exc}"
            return
        for line in chunk.splitlines():
            line = line.strip()
            if self.ready is None and line.startswith(READY_PREFIX):
                self.ready_raw = line
                try:
                    self.ready = json.loads(line[len(READY_PREFIX):])
                except ValueError as exc:
                    self.failed = {"error_type": "ready_line_not_json", "error": str(exc)}
            elif self.failed is None and line.startswith(FAILED_PREFIX):
                try:
                    self.failed = json.loads(line[len(FAILED_PREFIX):])
                except ValueError as exc:
                    self.failed = {"error_type": "failed_line_not_json", "error": str(exc)}

    def wait_ready(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while True:
            self._scan()
            if self.ready is not None or self.failed is not None:
                return
            if self.proc is not None and self.proc.poll() is not None:
                self._scan()
                if self.ready is None:
                    self.not_ready = {
                        "error_type": "service_exited_before_ready",
                        "error": "服务进程在写出 ROCO_SERVICE_READY 之前就退出了（import 期炸掉会这样）",
                        "exit_code": self.proc.returncode,
                    }
                return
            if time.monotonic() >= deadline:
                self.not_ready = {
                    "error_type": "ready_timeout",
                    "error": f"等 {timeout}s 没有等到 {READY_PREFIX.strip()} 行",
                    "exit_code": None,
                }
                return
            time.sleep(0.05)

    def stop(self) -> Optional[int]:
        """只 terminate 自己 Popen 出来的进程；绝不按端口/名字去杀别的进程。"""
        if self.proc is None:
            return None
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        self._scan()
        return self.proc.returncode

    def log_lines(self, n: int = 12) -> List[str]:
        try:
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as fh:
                return _tail(fh.read(), n)
        except OSError:
            return []


# ── 验收链路 ────────────────────────────────────────────────────────────


def _skipped(name: str, why: str, path: Optional[str] = None) -> Dict[str, Any]:
    return {
        "name": name, "path": path, "method": None, "http_status": None,
        "ok": False, "status": "skipped", "skipped_because": why,
        "checks": [], "reading": {}, "error": None,
    }


def _step(name: str, path: str, res: Dict[str, Any], checks: Checks,
          reading: Dict[str, Any]) -> Dict[str, Any]:
    ok = _envelope_ok(res) and checks.ok
    env = res.get("env") or {}
    return {
        "name": name,
        "path": path,
        "method": res.get("method"),
        "http_status": res.get("status"),
        "ok": ok,
        "status": "passed" if ok else "failed",
        "latency_ms": res.get("latency_ms"),
        "request_sha256": res.get("request_sha256"),
        "error_type": env.get("error_type"),
        "error": env.get("error") or res.get("error"),
        "checks": checks.items,
        "reading": reading,
    }


def _pet_ids_by_name(ctx: Dict[str, Any]) -> Tuple[Dict[str, Any], Optional[Tuple[List[str], List[str]]]]:
    """12 只精灵的 id 从服务自己查（不在脚本里抄 id）。同名多形态：取第一个并如实记录。"""
    checks = Checks()
    base_body = {"ruleset_id": ctx["ruleset_id"], "state_version": 0, "kind": "pet"}
    resolved: Dict[str, str] = {}
    ambiguous: Dict[str, Any] = {}
    sub_statuses: Dict[str, int] = {}
    failures: List[Dict[str, Any]] = []
    for name in list(TEAM_A_NAMES) + list(TEAM_B_NAMES):
        res = http_json(ctx["base"], "/rules/query", dict(base_body, name=name), timeout=ctx["timeout"])
        sub_statuses[str(res["status"])] = sub_statuses.get(str(res["status"]), 0) + 1
        env = res.get("env") or {}
        result = env.get("result") if isinstance(env.get("result"), dict) else None
        pet_id: Optional[str] = None
        if res["status"] == 200 and env.get("ok") is True and result:
            if result.get("ambiguous") and isinstance(result.get("matches"), list) and result["matches"]:
                pet_id = result["matches"][0].get("pet_id")
                ambiguous[name] = {"candidates": len(result["matches"]), "picked": pet_id}
            else:
                pet_id = result.get("pet_id")
        if not pet_id:
            failures.append({"name": name, "http_status": res["status"],
                             "error": env.get("error") or res.get("error")})
        else:
            resolved[name] = pet_id
    checks.add("12 个名字都在 /rules/query kind=pet 查到 pet_id", len(resolved) == 12,
               {"resolved": len(resolved), "failures": failures})
    checks.add("团队内 id 互不重复", len(set(resolved.values())) == len(resolved),
               {"distinct": len(set(resolved.values())), "total": len(resolved)})
    reading = {
        "names": len(resolved), "sub_statuses": sub_statuses,
        "pet_ids": {n: resolved.get(n) for n in list(TEAM_A_NAMES) + list(TEAM_B_NAMES)},
        "ambiguous_names": ambiguous,
        "rule": "同名多形态取第一个（与 tests/test_six_pet_battle.py 的 IDS_B 同口径），歧义如实记录不静默",
    }
    teams = None
    if len(resolved) == 12:
        teams = ([resolved[n] for n in TEAM_A_NAMES], [resolved[n] for n in TEAM_B_NAMES])
    http_status = 200 if not failures else next(
        (f["http_status"] for f in failures if f["http_status"] is not None), None)
    step = {
        "name": "fixtures_pet_ids", "path": "/rules/query", "method": "POST",
        "http_status": http_status, "ok": checks.ok,
        "status": "passed" if checks.ok else "failed", "checks": checks.items,
        "reading": reading, "error": None if checks.ok else "有名字查不到 pet_id",
        "latency_ms": None, "request_sha256": None, "error_type": None,
    }
    return step, teams


def run_acceptance(args: argparse.Namespace, repo: str, src: str, out_path: str) -> int:
    started_at = _now()
    # 并发写域的现实：本仓有多个执行者同时改代码。把服务**启动前**的源码指纹记下来，
    # 收尾时再读一次；两次不一致 = 这次读数对应的不是同一个源码版本（必须说清，不能假装）。
    coverage_path = os.path.join(src, "roco_env", "coverage.py")
    coverage_sha_at_start = _sha256_file(coverage_path)
    tmp_log_dir = tempfile.mkdtemp(prefix="roco-acceptance-")
    log_path = os.path.join(tmp_log_dir, "service.log")

    host = args.host
    port = args.port
    argv = [sys.executable, "-m", "roco_env.service",
            "--host", host, "--port", str(port), "--repo-root", repo,
            "--parent-pid", str(os.getpid())]
    env = dict(os.environ)
    prev_pythonpath = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = src + (os.pathsep + prev_pythonpath if prev_pythonpath else "")
    env.pop("ROCO_ACCEPTANCE_SRC", None)  # 不让子进程/副本把 --src 顶掉

    svc = ServiceProcess(argv, cwd=repo, env=env, log_path=log_path)
    steps: List[Dict[str, Any]] = []
    service_info: Dict[str, Any] = {
        "argv": argv, "src": src, "repo_root": repo, "requested_port": port,
        "pid": None, "port": None, "host": None, "ready": False,
        "ready_raw": None, "ready_line": None, "startup_error": None,
        "exit_code": None, "log_tail": [],
    }
    ctx: Dict[str, Any] = {"base": "", "ruleset_id": None, "timeout": args.http_timeout}
    exit_code = 2
    try:
        svc.start()
        service_info["pid"] = svc.pid
        svc.wait_ready(args.ready_timeout)
        service_info["ready"] = svc.ready is not None
        service_info["ready_raw"] = svc.ready_raw
        service_info["ready_line"] = svc.ready
        if svc.ready is not None:
            service_info["port"] = svc.ready.get("port")
            service_info["host"] = svc.ready.get("host")
            ctx["ruleset_id"] = svc.ready.get("ruleset_id")
            ctx["base"] = "http://%s:%s" % (svc.ready.get("host") or host, svc.ready.get("port"))
            if not svc.ready.get("ruleset_ok", False):
                service_info["startup_error"] = {
                    "error_type": "ruleset_unsupported",
                    "error": "就绪行说本服务声明的规则集加载失败：%s" % svc.ready.get("ruleset_error"),
                }
        else:
            service_info["startup_error"] = svc.failed or svc.not_ready

        ready_ok = (svc.ready is not None
                    and bool(svc.ready.get("ruleset_ok", False))
                    and bool(ctx["base"]))
        if not ready_ok:
            for name in ("health", "fixtures_pet_ids", "battle_new", "battle_legal",
                         "battle_advance", "skill_detail"):
                steps.append(_skipped(name, "服务没有就绪（ROCO_SERVICE_READY 未出现或规则集未加载）"))
            exit_code = 2
        else:
            exit_code = _run_steps(ctx, args, steps)

        service_info["exit_code"] = svc.stop()
    except Exception as exc:  # 工具自身的意外：也要留读数再退出
        service_info["startup_error"] = service_info.get("startup_error") or {
            "error_type": "harness_exception", "error": f"{type(exc).__name__}: {exc}"}
        steps.append({"name": "harness", "path": None, "method": None, "http_status": None,
                      "ok": False, "status": "failed", "checks": [],
                      "reading": {}, "error": f"{type(exc).__name__}: {exc}",
                      "error_type": "harness_exception"})
        exit_code = 2
    finally:
        if svc.proc is not None and svc.proc.poll() is None:
            svc.stop()
        if service_info["exit_code"] is None and svc.proc is not None:
            service_info["exit_code"] = svc.proc.returncode
        service_info["log_tail"] = svc.log_lines(15)
        shutil.rmtree(tmp_log_dir, ignore_errors=True)

    failing = [s["name"] for s in steps if s.get("status") == "failed"]
    coverage_sha_at_end = _sha256_file(coverage_path)
    record = {
        "tool": os.path.relpath(os.path.abspath(__file__), repo),
        "tool_version": 1,
        "generated_at": started_at,
        "finished_at": _now(),
        "git": _git_info(repo),
        "src": src,
        "src_is_repo_default": os.path.abspath(src) == os.path.abspath(os.path.join(repo, "roco", "src")),
        "repo_root": repo,
        "coverage_file_sha256": coverage_sha_at_start,
        "coverage_file_sha256_at_end": coverage_sha_at_end,
        "source_stable_during_run": coverage_sha_at_start == coverage_sha_at_end,
        "fault_inject": args.fault_inject,
        "ruleset_config_id": RULESET_CONFIG_V3,
        "seed": args.seed,
        "strategy": args.strategy,
        "service": service_info,
        "port": service_info["port"],
        "snapshot_fingerprint": (service_info["ready_line"] or {}).get("snapshot_fingerprint"),
        "steps": steps,
        "legal_actions": _first_reading(steps, "battle_new", "legal_count"),
        "event_kinds": _first_reading(steps, "battle_advance", "event_kinds"),
        "skill_tier": _first_reading(steps, "skill_detail", "support_tier"),
        "summary": {
            "steps_total": len(steps),
            "steps_passed": sum(1 for s in steps if s.get("status") == "passed"),
            "steps_failed": len(failing),
            "steps_skipped": sum(1 for s in steps if s.get("status") == "skipped"),
            "failed_steps": failing,
        },
        "ok": exit_code == 0,
        "exit_code": exit_code,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp_out = out_path + ".tmp"
    with open(tmp_out, "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2, sort_keys=False)
        fh.write("\n")
    os.replace(tmp_out, out_path)
    if not args.quiet:
        _print_report(record, out_path)
    return exit_code


def _first_reading(steps: List[Dict[str, Any]], step_name: str, key: str) -> Any:
    for step in steps:
        if step.get("name") == step_name:
            return (step.get("reading") or {}).get(key)
    return None


def _run_steps(ctx: Dict[str, Any], args: argparse.Namespace, steps: List[Dict[str, Any]]) -> int:
    """五步链路。任何一步红 ⇒ 后面标 skipped 并返回非 0。"""
    base = ctx["base"]
    ruleset_id = ctx["ruleset_id"]

    # ── 1. /health ──────────────────────────────────────────────────────
    res = http_json(base, "/health", timeout=ctx["timeout"])
    env, result = res.get("env") or {}, ((res.get("env") or {}).get("result") or {})
    checks = Checks()
    checks.add("HTTP 200", res["status"] == 200, res["status"])
    checks.add("信封 ok=true 且 error_type 为空", _envelope_ok(res),
               {"ok": env.get("ok"), "error_type": env.get("error_type"), "error": env.get("error")})
    checks.add("规则集已加载", result.get("loaded") is True, result.get("loaded"))
    fingerprint = env.get("snapshot_fingerprint")
    checks.add("snapshot_fingerprint 是 64 位小写 hex",
               isinstance(fingerprint, str) and len(fingerprint) == 64
               and all(c in "0123456789abcdef" for c in fingerprint), fingerprint)
    checks.add("ruleset_id 非空", bool(env.get("ruleset_id")), env.get("ruleset_id"))
    checks.add("capabilities 非空", bool(result.get("capabilities")), 
               len(result.get("capabilities") or {}))
    counts = result.get("counts") or {}
    counts_ok = all(isinstance(counts.get(k), int) and counts.get(k) > 0 for k in ("pets", "skills"))
    checks.add("冻结快照规模 pets/skills 都 > 0", counts_ok, counts)
    steps.append(_step("health", "/health", res, checks, {
        "loaded": result.get("loaded"),
        "ruleset_id": env.get("ruleset_id"),
        "snapshot_fingerprint": fingerprint,
        "counts": counts,
        "capabilities": len(result.get("capabilities") or {}),
        "engine_modules": result.get("engine_modules"),
        "service_pid": result.get("pid"),
    }))
    if steps[-1]["status"] != "passed":
        for name in ("fixtures_pet_ids", "battle_new", "battle_legal", "battle_advance", "skill_detail"):
            steps.append(_skipped(name, "health 未通过"))
        return 1

    # ── 2. 夹具：12 只精灵 id（/rules/query kind=pet） ───────────────────
    fixture_step, teams = _pet_ids_by_name(ctx)
    steps.append(fixture_step)
    if teams is None:
        for name in ("battle_new", "battle_legal", "battle_advance", "skill_detail"):
            steps.append(_skipped(name, "精灵 id 没凑齐 12 个"))
        return 1
    team_a, team_b = teams

    # ── 3. /battle/new（v3 六宠） ───────────────────────────────────────
    body_new = {"ruleset_id": ruleset_id, "state_version": 0, "team": team_a, "enemy_team": team_b,
                "seed": args.seed, "strategy": args.strategy,
                "ruleset_config_id": RULESET_CONFIG_V3}
    res = http_json(base, "/battle/new", body_new, timeout=ctx["timeout"])
    env, result = res.get("env") or {}, ((res.get("env") or {}).get("result") or {})
    legal_player = ((result.get("legal") or {}).get("player") or [])
    state = result.get("state") or {}
    public = result.get("public") or {}
    legal_count = len(legal_player)
    kinds = [a.get("kind") for a in legal_player]
    checks = Checks()
    checks.add("HTTP 200", res["status"] == 200, res["status"])
    checks.add("信封 ok=true 且 error_type 为空", _envelope_ok(res),
               {"ok": env.get("ok"), "error_type": env.get("error_type"), "error": env.get("error")})
    checks.add("trust_domain=local_sim（私有域显式声明）", result.get("trust_domain") == "local_sim",
               result.get("trust_domain"))
    checks.add("每方 6 只", len((state.get("player") or {}).get("pets") or []) == 6
               and len((state.get("enemy") or {}).get("pets") or []) == 6,
               {"player": len((state.get("player") or {}).get("pets") or []),
                "enemy": len((state.get("enemy") or {}).get("pets") or [])})
    checks.add("phase=battle 且 turn=1", result.get("phase") == "battle" and result.get("turn") == 1,
               {"phase": result.get("phase"), "turn": result.get("turn")})
    checks.add("私有状态里有真实 seed", isinstance(state.get("seed"), int), state.get("seed"))
    checks.add("公开面里没有 seed（信任域边界）", "seed" not in json.dumps(public, ensure_ascii=False),
               sorted(public.keys())[:12])
    checks.add("玩家侧合法动作 ≥1", legal_count >= 1, legal_count)
    checks.add("每个合法动作都有非空 label 与 kind",
               bool(legal_player) and all(a.get("label") and a.get("kind") for a in legal_player),
               [{"kind": a.get("kind"), "label": a.get("label")} for a in legal_player[:4]])
    if args.expect_legal > 0:
        checks.add("合法动作数 == 基线 %d" % args.expect_legal, legal_count == args.expect_legal,
                   {"expected": args.expect_legal, "actual": legal_count})
    checks.add("state_version 是 int", isinstance(result.get("state_version"), int),
               result.get("state_version"))
    steps.append(_step("battle_new", "/battle/new", res, checks, {
        "legal_count": legal_count,
        "legal_kinds": kinds,
        "first_action": {k: v for k, v in (legal_player[0] or {}).items()
                         if k in ("kind", "skill_id", "target_index", "label")} if legal_player else None,
        "phase": result.get("phase"),
        "turn": result.get("turn"),
        "state_version": result.get("state_version"),
        "pets": {"player": len((state.get("player") or {}).get("pets") or []),
                 "enemy": len((state.get("enemy") or {}).get("pets") or [])},
        "ruleset_config_id": state.get("ruleset_config_id"),
        "unverified_overrides": len(state.get("unverified_overrides") or []),
    }))
    if steps[-1]["status"] != "passed":
        for name in ("battle_legal", "battle_advance", "skill_detail"):
            steps.append(_skipped(name, "battle_new 未通过"))
        return 1
    state_version = result["state_version"]
    private_state = state

    # ── 4. /battle/legal（同一份私有状态） ──────────────────────────────
    res = http_json(base, "/battle/legal",
                    {"ruleset_id": ruleset_id, "state_version": state_version,
                     "state": private_state, "strategy": args.strategy}, timeout=ctx["timeout"])
    env, result_l = res.get("env") or {}, ((res.get("env") or {}).get("result") or {})
    legal_l = ((result_l.get("legal") or {}).get("player") or [])
    kinds_l = [a.get("kind") for a in legal_l]
    checks = Checks()
    checks.add("HTTP 200", res["status"] == 200, res["status"])
    checks.add("信封 ok=true 且 error_type 为空", _envelope_ok(res),
               {"ok": env.get("ok"), "error_type": env.get("error_type"), "error": env.get("error")})
    checks.add("合法动作数与 /battle/new 一致（同一状态同一读数）",
               len(legal_l) == legal_count, {"battle_new": legal_count, "battle_legal": len(legal_l)})
    checks.add("合法动作种类多重集一致", sorted(kinds_l) == sorted(kinds),
               {"battle_new": sorted(kinds), "battle_legal": sorted(kinds_l)})
    checks.add("state_version 与请求一致", result_l.get("state_version") == state_version,
               {"request": state_version, "response": result_l.get("state_version")})
    steps.append(_step("battle_legal", "/battle/legal", res, checks, {
        "legal_count": len(legal_l), "legal_kinds": kinds_l,
        "state_version": result_l.get("state_version"), "phase": result_l.get("phase"),
    }))
    if steps[-1]["status"] != "passed":
        for name in ("battle_advance", "skill_detail"):
            steps.append(_skipped(name, "battle_legal 未通过"))
        return 1

    # ── 5. /battle/advance（优先用技能动作） ────────────────────────────
    preferred = ([a for a in legal_l if a.get("kind") == "skill"]
                 or [a for a in legal_l if a.get("kind") == "switch"] or legal_l)
    action = {k: v for k, v in preferred[0].items()
              if k in ("kind", "skill_id", "target_index", "item_id")}
    res = http_json(base, "/battle/advance",
                    {"ruleset_id": ruleset_id, "state_version": state_version,
                     "state": private_state, "action": action, "strategy": args.strategy},
                    timeout=ctx["timeout"])
    env, result_a = res.get("env") or {}, ((res.get("env") or {}).get("result") or {})
    events = result_a.get("events") or []
    event_kinds = [e.get("kind") for e in events if isinstance(e, dict)]
    expect_events = tuple(e.strip() for e in (args.expect_events or "").split(",") if e.strip())
    checks = Checks()
    checks.add("HTTP 200", res["status"] == 200, res["status"])
    checks.add("信封 ok=true 且 error_type 为空", _envelope_ok(res),
               {"ok": env.get("ok"), "error_type": env.get("error_type"), "error": env.get("error")})
    checks.add("events 是非空数组", bool(events) and isinstance(events, list), len(events))
    checks.add("每个事件都有非空 kind",
               bool(events) and all(isinstance(e, dict) and e.get("kind") for e in events), event_kinds)
    if expect_events:
        missing = [k for k in expect_events if k not in event_kinds]
        checks.add("事件含基线 %s" % ",".join(expect_events), not missing,
                   {"missing": missing, "actual": event_kinds})
    checks.add("推进真的发生了（state_version 前进 或 对局已出结果）",
               (isinstance(result_a.get("state_version"), int)
                and result_a["state_version"] > state_version)
               or result_a.get("result") is not None,
               {"before": state_version, "after": result_a.get("state_version"),
                "battle_result": result_a.get("result")})
    checks.add("phase 是非空字符串", isinstance(result_a.get("phase"), str)
               and bool(result_a.get("phase")), result_a.get("phase"))
    steps.append(_step("battle_advance", "/battle/advance", res, checks, {
        "action": action, "event_kinds": event_kinds, "events_count": len(events),
        "phase": result_a.get("phase"), "turn": result_a.get("turn"),
        "state_version_before": state_version, "state_version_after": result_a.get("state_version"),
        "battle_result": result_a.get("result"),
    }))
    if steps[-1]["status"] != "passed":
        if not args.no_skill_detail:
            steps.append(_skipped("skill_detail", "battle_advance 未通过"))
        return 1

    # ── 6. 技能详情（可选；能力位在位与否的证据） ────────────────────────
    if args.no_skill_detail:
        steps.append(_skipped("skill_detail", "--no-skill-detail"))
        return 0
    res = http_json(base, "/rules/query",
                    {"ruleset_id": ruleset_id, "state_version": 0, "kind": "skill",
                     "skill_id": args.skill_id, "with_tier": True}, timeout=ctx["timeout"])
    env, result_s = res.get("env") or {}, ((res.get("env") or {}).get("result") or {})
    mech = result_s.get("mechanics") if isinstance(result_s.get("mechanics"), dict) else {}
    unparsed = result_s.get("support_unparsed")
    tier = result_s.get("support_tier")
    checks = Checks()
    checks.add("HTTP 200", res["status"] == 200, res["status"])
    checks.add("信封 ok=true 且 error_type 为空", _envelope_ok(res),
               {"ok": env.get("ok"), "error_type": env.get("error_type"), "error": env.get("error")})
    checks.add("record=skill 且 skill_id 对得上",
               result_s.get("record") == "skill" and result_s.get("skill_id") == args.skill_id,
               {"record": result_s.get("record"), "skill_id": result_s.get("skill_id")})
    checks.add("mechanics.resolved=true（机制真的被算出来，不是只有名字）",
               mech.get("resolved") is True, mech)
    checks.add("support_tier 是非空字符串", isinstance(tier, str) and bool(tier), tier)
    checks.add("support_unparsed 为空（描述被完整读出）",
               isinstance(unparsed, list) and not unparsed, unparsed)
    checks.add("support_why 非空", bool(result_s.get("support_why")), result_s.get("support_why"))
    if args.expect_tier:
        checks.add("support_tier == 基线 %s" % args.expect_tier, tier == args.expect_tier,
                   {"expected": args.expect_tier, "actual": tier})
    steps.append(_step("skill_detail", "/rules/query", res, checks, {
        "skill_id": result_s.get("skill_id"), "name": result_s.get("name"),
        "support_tier": tier, "support_why": result_s.get("support_why"),
        "support_unparsed": unparsed, "mechanics": mech,
        "power_status": result_s.get("power_status"),
        "unsupported": env.get("unsupported"),
    }))
    return 0 if steps[-1]["status"] == "passed" else 1


def _print_report(record: Dict[str, Any], out_path: str) -> None:
    svc = record["service"]
    print("[acceptance] src=%s" % record["src"])
    print("[acceptance] service pid=%s ready=%s port=%s fingerprint=%s"
          % (svc["pid"], svc["ready"], record["port"], record["snapshot_fingerprint"]))
    if record.get("source_stable_during_run") is False:
        print("[acceptance] WARN 源码在本次运行期间被改动过：coverage.py %s → %s"
              " ⇒ 这份读数不对应单一源码版本（并发写域）"
              % ((record.get("coverage_file_sha256") or "")[:12],
                 (record.get("coverage_file_sha256_at_end") or "")[:12]))
    if svc.get("startup_error"):
        print("[acceptance] startup_error=%s" % json.dumps(svc["startup_error"], ensure_ascii=False))
    for step in record["steps"]:
        line = "[acceptance] %-18s %-8s http=%-4s ok=%s" % (
            step["name"], step.get("status"), step.get("http_status"), step.get("ok"))
        extra = ""
        if step["name"] == "battle_new" and step.get("reading"):
            extra = " legal=%s first=%s" % (step["reading"].get("legal_count"),
                                            (step["reading"].get("first_action") or {}).get("label"))
        if step["name"] == "battle_advance" and step.get("reading"):
            extra = " events=%s" % (step["reading"].get("event_kinds"),)
        if step["name"] == "skill_detail" and step.get("reading"):
            extra = " tier=%s" % (step["reading"].get("support_tier"),)
        if step.get("skipped_because"):
            extra = " (%s)" % step["skipped_because"]
        print(line + extra)
        for bad in step.get("checks", []):
            if not bad["ok"]:
                print("[acceptance]   ✗ %s -> %s" % (bad["name"], json.dumps(bad["detail"], ensure_ascii=False)[:300]))
    print("[acceptance] %s  exit_code=%s  %s"
          % ("PASS" if record["ok"] else "FAIL", record["exit_code"],
             json.dumps(record["summary"], ensure_ascii=False)))
    print("[acceptance] last-run -> %s" % out_path)


# ── --fault-inject（负向控制） ───────────────────────────────────────────


def _failure_signature(child: Optional[Dict[str, Any]], rc: int) -> str:
    if not isinstance(child, dict):
        return "no_last_run:exit=%s" % rc
    if not (child.get("service") or {}).get("ready"):
        return "service_not_ready"
    for step in child.get("steps") or []:
        if step.get("status") == "failed":
            return "step_failed:%s" % step.get("name")
    return "unexpected_no_failure:exit=%s" % rc


def run_fault_injection(args: argparse.Namespace, repo: str, src: str) -> int:
    fault = FAULTS[args.fault_inject]
    harness_dir = os.path.join(repo, EVIDENCE_DIR_REL)
    out_path = os.path.join(harness_dir, "fault-inject-%s.json" % args.fault_inject)
    tmp = tempfile.mkdtemp(prefix="roco-fault-inject-")
    evidence: Dict[str, Any] = {
        "tool": os.path.relpath(os.path.abspath(__file__), repo),
        "generated_at": _now(),
        "fault": args.fault_inject,
        "fault_what": fault["what"],
        "fault_file": fault["file"],
        "expected_failure": fault["expect"],
        "tmp_copy": tmp,
        "shared_source_untouched": None,
        "injection": None,
        "child": None,
        "child_last_run": None,
        "observed_failure": None,
        "negative_control_ok": False,
        "expected_nonzero_exit": True,
        "ok": False,
        "exit_code": None,
        "notes": [],
    }
    rc = 4
    try:
        dst_src = os.path.join(tmp, "roco", "src")
        shutil.copytree(src, dst_src, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        # 引擎的 `_repo_root()`（`data.py` / `rule_config.py`）是按**文件位置**推的 3 层
        # `..`，`--repo-root` 管不到它 —— 所以副本必须自己有一个 `data/`，否则
        # import 期 `rule_config.rule_configs_dir()` 就找不到 `data/roco/rulesets`。
        # 用**只读软链**指向真数据：这样正反两次跑的差异只有代码，数据是同一份快照；
        # 清理时 rmtree 只删链接本身，不会碰真数据。
        data_link = os.path.join(tmp, "data")
        os.symlink(os.path.join(repo, "data"), data_link)
        evidence["injected_tree"] = {"src": dst_src, "data_symlink": data_link,
                                     "data_target": os.path.join(repo, "data")}
        target = os.path.join(dst_src, fault["file"])
        shared_path = os.path.join(src, fault["file"])
        before = _sha256_file(shared_path)
        with open(target, "r", encoding="utf-8") as fh:
            text = fh.read()
        hits = text.count(fault["old"])
        evidence["injection"] = {
            "target": target, "anchor_occurrences": hits,
            "anchor_sha256": _sha256_bytes(fault["old"].encode("utf-8")),
            "applied": hits == 1,
        }
        if hits != 1:
            evidence["notes"].append(
                "注入锚点在副本里出现 %d 次（要求恰好 1 次）⇒ 负向控制作废，按工具故障退出" % hits)
            rc = 4
        else:
            with open(target, "w", encoding="utf-8") as fh:
                fh.write(text.replace(fault["old"], fault["new"]))
            child_out = os.path.join(tmp, "child-last-run.json")
            cmd = [sys.executable, os.path.abspath(__file__),
                   "--src", dst_src, "--repo-root", repo, "--out", child_out, "--quiet"]
            child_env = dict(os.environ)
            child_env.pop("ROCO_ACCEPTANCE_SRC", None)
            proc = subprocess.run(cmd, cwd=repo, env=child_env, text=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  timeout=args.ready_timeout + args.http_timeout * 8 + 60)
            child_json: Optional[Dict[str, Any]] = None
            if os.path.exists(child_out):
                try:
                    with open(child_out, "r", encoding="utf-8") as fh:
                        child_json = json.load(fh)
                except (OSError, ValueError) as exc:
                    evidence["notes"].append("子进程 last-run.json 读不了：%s" % exc)
            evidence["child"] = {
                "argv": cmd, "exit_code": proc.returncode,
                "stdout_tail": _tail(proc.stdout, 20),
            }
            evidence["child_last_run"] = child_json
            signature = _failure_signature(child_json, proc.returncode)
            evidence["observed_failure"] = signature
            # 两条硬判据：子进程必须非 0，且**失败原因**必须是这次注入的那个。
            if proc.returncode == 0:
                evidence["notes"].append("注入之后脚本仍然 exit=0 ⇒ 负向控制失败（工具会误报通过）")
                rc = 1
            elif signature != fault["expect"]:
                evidence["notes"].append(
                    "子进程非 0，但失败签名是 %s（期望 %s）⇒ 不是这次注入造成的，负向控制不成立"
                    % (signature, fault["expect"]))
                rc = 3
            else:
                evidence["negative_control_ok"] = True
                # 期望结果：把被注入子进程的**非 0** 退出码原样传出去
                rc = proc.returncode if proc.returncode > 0 else 2
        evidence["shared_source_untouched"] = (
            before is not None and _sha256_file(shared_path) == before)
        if not evidence["shared_source_untouched"]:
            evidence["notes"].append("共享源码 sha256 变了 ⇒ 违反「只改临时副本」，负向控制作废")
            evidence["negative_control_ok"] = False
            rc = 4
    except subprocess.TimeoutExpired as exc:
        evidence["notes"].append("子进程超时：%s" % exc)
        rc = 4
    except Exception as exc:
        evidence["notes"].append("注入工具异常：%s: %s" % (type(exc).__name__, exc))
        rc = 4
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        evidence["tmp_copy_removed"] = not os.path.exists(tmp)

    evidence["ok"] = evidence["negative_control_ok"]
    evidence["exit_code"] = rc
    os.makedirs(harness_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(evidence, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    child = evidence.get("child") or {}
    child_run = evidence.get("child_last_run") or {}
    child_summary = (child_run.get("summary") or {}) if isinstance(child_run, dict) else {}
    print("[fault-inject] %s: %s" % (args.fault_inject, fault["what"]))
    print("[fault-inject] expected=%s observed=%s child_exit=%s shared_source_untouched=%s"
          % (evidence["expected_failure"], evidence["observed_failure"],
             child.get("exit_code"), evidence["shared_source_untouched"]))
    if child_summary:
        print("[fault-inject] child failed_steps=%s exit_code=%s"
              % (child_summary.get("failed_steps"), child_run.get("exit_code")))
    for note in evidence["notes"]:
        print("[fault-inject] note: %s" % note)
    print("[fault-inject] %s  exit_code=%s  evidence -> %s"
          % ("PASS（反例方向成立：注入后非 0 退出）" if evidence["ok"]
             else "FAIL（负向控制不成立）", rc, out_path))
    return rc


# ── 入口 ────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="隔离验收：自起 roco_env 服务（自有端口）跑最小链路，写机器可读读数")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认只本机）")
    parser.add_argument("--port", type=int, default=0, help="端口；0 = 系统分配并从就绪行读回（默认）")
    parser.add_argument("--src", default=None,
                        help="引擎源码目录（默认 $ROCO_ACCEPTANCE_SRC 或 <repo>/roco/src）")
    parser.add_argument("--repo-root", default=None, help="仓库根（默认按本文件位置推断）")
    parser.add_argument("--out", default=DEFAULT_OUT_REL,
                        help="读数 JSON（相对路径按仓库根解析；默认 %s）" % DEFAULT_OUT_REL)
    parser.add_argument("--ready-timeout", type=float, default=30.0, help="等 ROCO_SERVICE_READY 的秒数")
    parser.add_argument("--http-timeout", type=float, default=30.0, help="单次 HTTP 超时秒数")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="对局 seed（默认 %d）" % DEFAULT_SEED)
    parser.add_argument("--strategy", default=DEFAULT_STRATEGY, help="对手策略名（默认 %s）" % DEFAULT_STRATEGY)
    parser.add_argument("--expect-legal", type=int, default=DEFAULT_EXPECT_LEGAL,
                        help="玩家侧合法动作数基线；0 = 只要求 ≥1（默认 %d）" % DEFAULT_EXPECT_LEGAL)
    parser.add_argument("--expect-events", default=DEFAULT_EXPECT_EVENTS,
                        help="推进一回合必须出现的事件 kind（逗号分隔；空串 = 不查）")
    parser.add_argument("--skill-id", default=SKILL_ID, help="技能详情查的技能 id（默认 %s）" % SKILL_ID)
    parser.add_argument("--expect-tier", default="SIMULATABLE_UNVERIFIED",
                        help="技能档位基线；空串 = 不查（默认 SIMULATABLE_UNVERIFIED）")
    parser.add_argument("--no-skill-detail", action="store_true", help="跳过技能详情那一步")
    parser.add_argument("--fault-inject", choices=sorted(FAULTS), default=None,
                        help="负向控制：在临时副本里注入故障，断言本脚本非 0 退出")
    parser.add_argument("--quiet", action="store_true", help="不打人类可读摘要（只写 JSON）")
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    repo = os.path.abspath(args.repo_root or REPO_ROOT_FROM_SCRIPT)
    src = os.path.abspath(args.src or os.environ.get("ROCO_ACCEPTANCE_SRC")
                          or os.path.join(repo, "roco", "src"))
    if not os.path.isdir(os.path.join(src, "roco_env")):
        print("[acceptance] FAIL 找不到引擎包：%s" % os.path.join(src, "roco_env"), file=sys.stderr)
        return 2
    if not os.path.isdir(os.path.join(repo, "data", "roco", "normalized")):
        print("[acceptance] FAIL 仓库根下没有 data/roco/normalized：%s" % repo, file=sys.stderr)
        return 2
    if args.fault_inject:
        return run_fault_injection(args, repo, src)
    out_path = args.out if os.path.isabs(args.out) else os.path.join(repo, args.out)
    return run_acceptance(args, repo, src, out_path)


if __name__ == "__main__":
    raise SystemExit(main())
