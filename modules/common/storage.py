# -*- coding: utf-8 -*-
"""共享存储基础设施（P3-T1）。

提供跨平台文件锁、临时文件原子写与 JSON 文件存储后端抽象。
对齐架构设计文档 §7.1：JSON 文件存储 + 文件锁（fcntl/msvcrt）+ 崩溃恢复原子写，
并预留 StorageBackend 抽象接口（并发 >= 50 时评估迁移 SQLite，迁移不动领域层）。
"""

from __future__ import annotations

import contextlib
import importlib
import json
import os
import tempfile
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Dict, Iterator, Optional

try:
    fcntl = importlib.import_module("fcntl")  # POSIX
except ImportError:  # pragma: no cover - Windows
    fcntl = None

try:
    msvcrt = importlib.import_module("msvcrt")  # Windows
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None


# 模块级线程锁表：按 lock_path 共享 threading.Lock。
# 背景（P5-T4 发现，Windows）：同一进程内多线程并发访问同一 lock 文件时，
# 若每个 FileLock 实例各持独立 threading.Lock，则多线程会同时进入 msvcrt.locking，
# Windows 对同一文件同一区域重复加锁（即使不同线程）会抛 OSError [Errno 36]
# Resource deadlock avoided。用共享线程锁按 path 互斥，确保同一进程内对同一
# lock 文件的访问是串行的，msvcrt 只被单线程持有（跨进程仍靠文件锁兜底）。
_lock_registry: Dict[str, threading.Lock] = {}
_registry_guard = threading.Lock()


def _shared_thread_lock(lock_path: str) -> threading.Lock:
    """获取按 lock_path 共享的线程锁（进程内互斥同一 lock 文件）。"""
    with _registry_guard:
        lock = _lock_registry.get(lock_path)
        if lock is None:
            lock = threading.Lock()
            _lock_registry[lock_path] = lock
        return lock


def new_id() -> str:
    """生成实体 ID（UUID hex，保证跨文件唯一，对齐数据结构设计 §1.1）。"""
    return uuid.uuid4().hex


def now_iso() -> str:
    """当前时间 ISO 8601（对齐数据结构设计 §五：YYYY-MM-DDTHH:mm:ss）。"""
    return datetime.now().isoformat(timespec="seconds")


class FileLock:
    """跨进程文件锁（fcntl / msvcrt 封装）。

    用于 JSON 文件并发读写防写坏。同一进程内额外用 threading.Lock 防重入。
    """

    def __init__(self, lock_path: str) -> None:
        self.lock_path = lock_path
        # 按 lock_path 共享线程锁：同一进程内多线程对同一 lock 文件互斥，
        # 避免 Windows msvcrt 对同一区域重复加锁报 Errno 36（P5-T4）。
        self._thread_lock = _shared_thread_lock(lock_path)
        self._fh: Optional[Any] = None

    def acquire(self) -> None:
        """阻塞获取文件锁（线程锁 + 跨进程文件锁）。"""
        os.makedirs(os.path.dirname(self.lock_path) or ".", exist_ok=True)
        self._thread_lock.acquire()
        self._fh = open(self.lock_path, "a+", encoding="utf-8")
        if fcntl is not None:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
        elif msvcrt is not None:  # pragma: no cover - Windows
            self._fh.seek(0)
            msvcrt.locking(self._fh.fileno(), msvcrt.LK_LOCK, 1)

    def try_acquire(self, timeout: Optional[float] = None) -> bool:
        """非阻塞尝试获取锁；成功返回 True，超时/占用返回 False。

        用于「写锁未获取」的 409 语义（接口契约 §2.4）：不阻塞主流程，
        拿不到锁立即返回 False，由调用方决定抛错或降级。timeout 为秒，
        None 表示仅尝试一次（非阻塞）。
        """
        if not self._thread_lock.acquire(blocking=False):
            # 线程锁已被本进程占用：非阻塞尝试失败
            return False
        os.makedirs(os.path.dirname(self.lock_path) or ".", exist_ok=True)
        self._fh = open(self.lock_path, "a+", encoding="utf-8")
        try:
            if fcntl is not None:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            elif msvcrt is not None:  # pragma: no cover - Windows
                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_NBLCK, 1)
        except (BlockingIOError, OSError):
            # 文件锁已被其他进程占用：非阻塞尝试失败
            self._fh.close()
            self._fh = None
            self._thread_lock.release()
            return False
        return True

    def release(self) -> None:
        """释放文件锁并关闭句柄。"""
        if self._fh is None:
            return
        try:
            if fcntl is not None:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            elif msvcrt is not None:  # pragma: no cover - Windows
                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
        finally:
            self._fh.close()
            self._fh = None
            self._thread_lock.release()

    def __enter__(self) -> "FileLock":
        self.acquire()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.release()


def atomic_write_json(path: str, data: Any) -> None:
    """临时文件原子写 JSON（崩溃恢复：先写临时文件，再 os.replace 覆盖）。

    Windows 平台 os.replace 无法替换正被其他线程/进程读取的文件
    （PermissionError WinError 5）。读端使用 read_json（无锁读），写端
    并发时可能短暂冲突，故对 os.replace 加轻量重试（默认 5 次 × 20ms）。
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".", suffix=".tmp",
        dir=os.path.dirname(path) or ".",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        _replace_with_retry(tmp_path, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise


def _replace_with_retry(tmp_path: str, path: str, attempts: int = 30, delay: float = 0.05) -> None:
    """os.replace 带重试：Windows 上目标文件被读端打开时短暂重试。

    版本历史：
      - P5-T2 初版：5 次 × 20ms（总窗口 100ms）。P5-T1 全量回归证明**不彻底**
        —— 50 并发创建章节时仍偶发 PermissionError [WinError 5]（BUG-2026-113-01）。
      - P5-T6 本版：30 次 × 50ms（总窗口 1.5s）。读端 read_json 的「打开-读-关闭」
        窗口为微秒~毫秒级；50 并发下同一文件可能被多个线程连续读，占用窗口累积
        （实测单轮偶发 1-7/50 失败）。1.5s 提供 100~1000 倍余量，工程上消除可见竞态。

    技术约束（Windows）：msvcrt.locking 仅提供独占锁、无共享读锁（LOCK_SH 仅
    POSIX），故读端 read_json 无法用共享读锁消除竞态（若读端加独占锁会退化
    P95，重蹈 P5-T2 §4.1 O(N) 查重锁开销覆辙）。Windows 平台的正确缓解即
    写端重试扩大窗口，等待读端短窗口关闭。
    """
    for attempt in range(attempts):
        try:
            os.replace(tmp_path, path)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)


def read_json(path: str, default: Any = None) -> Any:
    """读取 JSON 文件；不存在或损坏时返回 default（不抛异常）。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


class JsonFileStore:
    """单文件 JSON 存储后端（带文件锁 + 原子写）。

    抽象接口：get / set / delete / list，供领域层 store 复用。
    """

    def __init__(self, data_dir: str, lock_dir: Optional[str] = None) -> None:
        self.data_dir = data_dir
        self.lock_dir = lock_dir or os.path.join(data_dir, ".locks")
        os.makedirs(self.data_dir, exist_ok=True)

    def _path(self, entity_id: str) -> str:
        return os.path.join(self.data_dir, f"{entity_id}.json")

    def _lock(self, entity_id: str) -> FileLock:
        return FileLock(os.path.join(self.lock_dir, f"{entity_id}.lock"))

    def get(self, entity_id: str, default: Any = None) -> Any:
        """按实体 id 读取数据，不存在或损坏时返回 default。"""
        with self._lock(entity_id):
            return read_json(self._path(entity_id), default)

    def set(self, entity_id: str, data: Any) -> None:
        """按实体 id 原子写入数据。"""
        with self._lock(entity_id):
            atomic_write_json(self._path(entity_id), data)

    def delete(self, entity_id: str) -> bool:
        """删除实体文件；存在删除返回 True，不存在返回 False。"""
        with self._lock(entity_id):
            try:
                os.unlink(self._path(entity_id))
                return True
            except FileNotFoundError:
                return False

    def list_ids(self) -> list[str]:
        """列出所有实体 id（按 .json 文件后缀识别）。"""
        ids: list[str] = []
        if not os.path.isdir(self.data_dir):
            return ids
        for name in os.listdir(self.data_dir):
            if name.endswith(".json"):
                ids.append(name[: -len(".json")])
        return ids

    def all(self) -> Dict[str, Any]:
        """读取全部实体：{entity_id: data}。"""
        result: Dict[str, Any] = {}
        for entity_id in self.list_ids():
            data = self.get(entity_id)
            if data is not None:
                result[entity_id] = data
        return result


class StorageBackend:
    """存储抽象基类（迁移预留）。

    当前实现为 JSON 文件（JsonFileStore），并发 >= 50 时评估 SQLite 实现，
    领域层只依赖本接口，切换存储无需改动领域层（架构设计文档 §7.1 / §九）。
    """

    def get(self, entity_id: str, default: Any = None) -> Any:
        """读取实体数据（子类实现）。"""
        raise NotImplementedError

    def set(self, entity_id: str, data: Any) -> None:
        """写入实体数据（子类实现）。"""
        raise NotImplementedError

    def delete(self, entity_id: str) -> bool:
        """删除实体数据（子类实现）。"""
        raise NotImplementedError

    def all(self) -> Dict[str, Any]:
        """读取全部实体（子类实现）。"""
        raise NotImplementedError
