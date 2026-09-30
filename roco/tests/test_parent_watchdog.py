"""`--parent-pid` 看门狗：**存活探测**的行为判据（P0 · 2026-09-30）。

为什么需要这个文件
------------------
`_watch_parent()` 的成败全压在 `service._parent_is_alive()` 上：

  · 它必须**分平台** —— Windows 上 `os.kill(pid, 0)` 不是探测，而是
    `GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid)`（`sig=0` 的值就是 CTRL_C 的 0）
    ⇒ 向同 console 的进程组广播 Ctrl+C ⇒ 整树 `0xC000013A` 退出（P0，见 `service.py` 的注释与
    `reports/roco/product-execution/02/plan02-p0-watch-parent.md` 的 A/B 与服务级读数）；
  · 它必须**真的能分辨生死** —— 恒真 ⇒ 父进程死了也不退（留孤儿监听）；
    恒假 ⇒ 服务一起来就自杀。

本文件钉的是**第二条**：两条断言取自**真实进程**，任一侧写死都会红（不是恒真断言）。
第一条（"Windows 上不再广播 Ctrl+C"）**测不到** —— 那要跨进程 console 实验，
证据在 `plan02-p0-watch-parent.md` 的 A/B 与 Windows 服务级读数里（本文件不假装测了它）。

⚠ 改前为什么会红：`_parent_is_alive` 这个名字当时**不存在**（探测内联在 `_watch_parent` 里）
⇒ 本文件在改前的树上跑是 `AttributeError`（见证据件 §5 的"改前会红"读数）。
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from roco_env import service as service_mod  # noqa: E402


class ParentAliveProbeTest(unittest.TestCase):
    """探测器的正/反两条：**都取自真实进程**（不是 mock）。"""

    def test_live_process_is_reported_alive(self):
        """自己的 pid **一定活着** ⇒ 必须报 True（写死 False 会红）。"""
        self.assertTrue(service_mod._parent_is_alive(os.getpid()),
                        "对活着的进程（本测试进程）必须报存活")

    def test_finished_process_is_reported_dead(self):
        """起一个子进程并等它结束 ⇒ 那个 pid 必须报 False（写死 True 会红）。"""
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        self.assertFalse(service_mod._parent_is_alive(child.pid),
                         f"已结束的子进程 pid={child.pid} 必须报已死")

    def test_probe_does_not_kill_the_probe_target(self):
        """探测**不能有副作用**：反复探一个活着的子进程，它必须照样活着、还能正常退出。

        ⚠ 这条在 POSIX 上钉的是"`os.kill(pid,0)` 只是探测"；在 Windows 上钉的是
        "WinAPI 那条路不开控制台事件" —— 真正的跨进程 console 证明仍在 A/B 读数里。
        """
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            for _ in range(3):
                self.assertTrue(service_mod._parent_is_alive(child.pid),
                                "子进程还活着，探测却报已死")
            self.assertIsNone(child.poll(), "被探测的子进程不该退出")
        finally:
            child.kill()
            child.wait()


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
