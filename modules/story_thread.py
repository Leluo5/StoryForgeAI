# -*- coding: utf-8 -*-
"""F6 多线程隔离：聊天室会话注册表 + 实例级读写锁 + 房间容量上限。

对齐 F6 技术方案 §4.4 与硬约束：
- with_room(room_id, mode) 上下文管理器，按 room_id 独立加锁（threading.RLock）；
- MAX_ROOMS = 10 容量上限（DoD #10），超出抛 409「聊天室容量已满」；
- 会话数据全部内存态（不持久化），进程内多线程互不干扰（F6 指标「多线程隔离 100%」）。
"""

from __future__ import annotations

import threading
from typing import Any, Callable, Dict, Optional

from .common.errors import AppError, not_found

# 容量上限（F6 技术方案 §4.4 硬约束）
MAX_ROOMS = 10

# 全局会话注册表：room_id -> {"room": story_room, "lock": RLock, "status": ...}
_rooms: Dict[str, Dict[str, Any]] = {}
_registry_lock = threading.Lock()


def get_room(room_id: str) -> Optional[Dict[str, Any]]:
    """按 id 取房间；不存在返回 None（调用方决定 404）。"""
    with _registry_lock:
        entry = _rooms.get(room_id)
    return entry["room"] if entry else None


def list_rooms() -> list:
    """列出全部房间摘要（F6 §3.2）：id/name/step_index/status/characters_count。"""
    with _registry_lock:
        entries = list(_rooms.values())
    result = []
    for e in entries:
        room = e["room"]
        result.append({
            "id": room.get("id"),
            "name": room.get("name", ""),
            "step_index": room.get("step_index", 0),
            "status": room.get("status", "idle"),
            "characters_count": len(room.get("characters") or []),
        })
    return result


def has_capacity() -> bool:
    """是否还能创建新房间（容量上限判断）。"""
    with _registry_lock:
        return len(_rooms) < MAX_ROOMS


def create_room(room: Dict[str, Any]) -> Dict[str, Any]:
    """注册新房间；容量满抛 409。"""
    with _registry_lock:
        if len(_rooms) >= MAX_ROOMS:
            raise AppError(409, "聊天室容量已满", f"当前最多同时 {MAX_ROOMS} 个聊天室")
        room_id = room["id"]
        if room_id in _rooms:
            raise AppError(409, "聊天室已存在", room_id)
        _rooms[room_id] = {"room": room, "lock": threading.RLock()}
    return room


def drop_room(room_id: str) -> bool:
    """销毁房间（F6 §3.7 结束/销毁），返回是否成功。"""
    with _registry_lock:
        entry = _rooms.pop(room_id, None)
    return entry is not None


def with_room(room_id: str, mode: str = "r"):
    """实例级锁上下文管理器。

    mode="r" 读锁，mode="w" 写锁（同一房间串行，不同房间并行）。
    房间不存在抛 404。
    """
    entry = None
    with _registry_lock:
        entry = _rooms.get(room_id)
    if entry is None:
        raise not_found("聊天室不存在", room_id)

    lock = entry["lock"]

    class _Ctx:
        def __enter__(self):
            lock.acquire()
            return entry["room"]

        def __exit__(self, *exc):
            lock.release()
            return False

    return _Ctx()
