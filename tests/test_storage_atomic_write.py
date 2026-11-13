# -*- coding: utf-8 -*-
"""BUG-2026-113-01 防复发单测：Windows 原子写竞态（os.replace PermissionError）。

背景：P5-T2 曾以 5×20ms 重试修复，P5-T1 全量回归证明不彻底（50 并发创建章节
仍偶发 PermissionError [WinError 5]，HTTP 500）。P5-T6 将重试窗口扩至 30×50ms。

本测试不依赖真实多线程（避免 flaky），改用 monkeypatch 模拟 os.replace 在
读端打开窗口内抛 PermissionError，验证：
  1. 读端窗口短于重试总窗口 → 重试成功，最终替换完成（竞态被吸收）。
  2. 读端窗口持续超过重试总窗口 → 抛 PermissionError（不吞错、不静默丢数据）。
  3. 竞态窗口内读端能读到旧数据（替换前一致性）或新数据（替换后），不读到半写文件。
"""

import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common import storage as storage_mod
from modules.common.storage import atomic_write_json, read_json


def _simulate_replace_with_reader(monkeypatch, fail_times, delay=0.01):
    """模拟 Windows 读-写竞态：前 fail_times 次 os.replace 抛 PermissionError。

    每次失败前短暂 sleep，模拟读端「打开-读-关闭」占用窗口。
    """
    calls = {"n": 0}
    real_replace = os.replace  # 保存真实实现，避免 monkeypatch 后递归

    def fake_replace(src, dst):
        calls["n"] += 1
        if calls["n"] <= fail_times:
            time.sleep(delay)  # 模拟读端占用窗口
            raise PermissionError(5, "拒绝访问。")  # WinError 5
        return real_replace(src, dst)

    monkeypatch.setattr(storage_mod.os, "replace", fake_replace)
    return calls


class TestWindowsAtomicWriteRace:
    def test_replace_retries_short_reader_window(self, tmp_path, monkeypatch):
        """读端窗口短于重试总窗口 → 重试成功，竞态被吸收。"""
        target = tmp_path / "data.json"
        calls = _simulate_replace_with_reader(monkeypatch, fail_times=3, delay=0.005)
        atomic_write_json(str(target), {"k": "v"})
        assert calls["n"] == 4  # 3 次失败 + 1 次成功
        assert read_json(str(target)) == {"k": "v"}

    def test_replace_raises_when_reader_window_exceeds_retry(self, tmp_path, monkeypatch):
        """读端窗口持续超过重试总窗口 → 抛 PermissionError（不静默吞错）。"""
        target = tmp_path / "data.json"
        # 写初始数据
        atomic_write_json(str(target), {"k": "old"})
        # 让替换永远失败（失败次数 > 重试总次数 30）
        calls = _simulate_replace_with_reader(monkeypatch, fail_times=10**9, delay=0.0001)
        with pytest.raises(PermissionError):
            atomic_write_json(str(target), {"k": "new"})
        assert calls["n"] == 30  # 恰好用尽重试次数
        # 失败后旧数据完好（原子写不破坏原文件）
        assert read_json(str(target)) == {"k": "old"}

    def test_concurrent_read_never_sees_partial_json(self, tmp_path, monkeypatch):
        """竞态窗口内并发读：只读到完整旧值或完整新值，绝不读到半写内容。

        模拟在替换成功瞬间（替换前旧、替换后新）读取，两个值都必须是合法完整 JSON。
        """
        target = tmp_path / "data.json"
        atomic_write_json(str(target), {"k": "old"})
        real_replace = os.replace

        def fake_replace(src, dst):
            # 替换前：读端看到的必须是完整旧值
            assert json.loads(open(str(target), encoding="utf-8").read()) == {"k": "old"}
            real_replace(src, dst)
            # 替换后：读端看到的必须是完整新值
            assert json.loads(open(str(target), encoding="utf-8").read()) == {"k": "new"}
            return None

        monkeypatch.setattr(storage_mod.os, "replace", fake_replace)
        atomic_write_json(str(target), {"k": "new"})
        assert read_json(str(target)) == {"k": "new"}
