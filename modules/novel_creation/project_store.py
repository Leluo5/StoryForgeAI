# -*- coding: utf-8 -*-
"""项目存储（P3-T1）：Project + Chapter + ToolCallRecord。

对齐数据结构设计 §2.3（Project）/ §2.4（Chapter）/ §2.5（ToolCallRecord）。
存储形态：data/projects/<project_id>.json 聚合根（对齐架构设计文档 §7.2），
单项目一文件，文件锁 + 原子写防并发写坏。角色/绑定/会话字段由 RoleStore 管理，
本模块只负责项目、章节、工具调用记录。

边界：不 import 角色存储；项目删除时由路由层协调级联。
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, conflict, not_found
from ..common.storage import FileLock, atomic_write_json, new_id, now_iso, read_json

# 章节状态白名单（数据结构设计 §2.4）
_CHAPTER_STATUSES = {"draft", "completed", "published"}
# 项目状态白名单（数据结构设计 §2.3）
_PROJECT_STATUSES = {"active", "archived"}


def _now() -> str:
    return now_iso()


class ProjectStore:
    """项目聚合根存储。

    data/projects/<project_id>.json 结构：
    {
      "id", "title", "description", "genre", "status", "author",
      "created_at", "updated_at",
      "chapters": [Chapter, ...],
      "tool_calls": [ToolCallRecord, ...],
      "roles": [...], "role_bindings": [...], "agent_sessions": [...]
    }
    """

    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)

    def _path(self, project_id: str) -> str:
        return os.path.join(self.data_dir, f"{project_id}.json")

    def _lock(self, project_id: str) -> FileLock:
        return FileLock(os.path.join(self.data_dir, ".locks", f"{project_id}.lock"))

    def collab_lock(self, project_id: str) -> FileLock:
        """协同编排专用写锁（独立锁文件，与常规项目锁分开）。

        多角色协同接口持锁期间会经调度器触发角色 Agent 调用，其内部审计
        （append_tool_call）又需拿常规项目锁；若复用同一把锁会重入死锁，
        故协同用独立锁路径实现「409 写锁未获取」（接口契约 §2.4）。
        """
        return FileLock(os.path.join(self.data_dir, ".locks", f"{project_id}.collab.lock"))

    def _load(self, project_id: str) -> Dict[str, Any]:
        data = read_json(self._path(project_id), {})
        if not isinstance(data, dict):
            return {}
        data.setdefault("chapters", [])
        data.setdefault("tool_calls", [])
        data.setdefault("roles", [])
        data.setdefault("role_bindings", [])
        data.setdefault("agent_sessions", [])
        # 协同模式开关（数据结构设计 §2.3：默认 false）
        data.setdefault("collab_enabled", False)
        return data

    def _save(self, project_id: str, data: Dict[str, Any]) -> None:
        atomic_write_json(self._path(project_id), data)

    # ---------- Project ----------

    def create_project(self, title: str, **kwargs: Any) -> Dict[str, Any]:
        """创建项目。title 必填。"""
        if not title or not str(title).strip():
            raise bad_request("项目标题不能为空")
        now = _now()
        project_id = new_id()
        project: Dict[str, Any] = {
            "id": project_id,
            "title": str(title).strip(),
            "description": kwargs.get("description") or "",
            "genre": kwargs.get("genre") or "",
            "status": kwargs.get("status") or "active",
            "author": kwargs.get("author") or "",
            "collab_enabled": bool(kwargs.get("collab_enabled", False)),
            "created_at": now,
            "updated_at": now,
            "chapters": [],
            "tool_calls": [],
            "roles": [],
            "role_bindings": [],
            "agent_sessions": [],
        }
        if project["status"] not in _PROJECT_STATUSES:
            pstatus = project["status"]
            raise bad_request(f"非法项目状态: {pstatus}")
        with self._lock(project_id):
            # 同名项目查重（接口契约 §2.1：409 同名项目已存在）
            existing = self._load(project_id)
            if existing.get("id"):
                ptitle = project["title"]
                raise conflict(f"项目已存在: {ptitle}")
            for name in os.listdir(self.data_dir):
                if not name.endswith(".json") or name.startswith("."):
                    continue
                other_id = name[: -len(".json")]
                # 标题查重只读不写：_save 用原子写 os.replace，read_json 读到
                # 的永远是完整一致文件，无需逐文件加锁（加锁是 O(N) 打开开销，
                # 项目数大时拖慢 P95；读一致性由原子写保证）。
                other = self._load(other_id)
                if other.get("title") == project["title"]:
                    ptitle = project["title"]
                    raise conflict(f"项目已存在: {ptitle}")
            self._save(project_id, project)
        return project

    def get_project(self, project_id: str) -> Dict[str, Any]:
        """读取项目聚合根，不存在抛 404。"""
        with self._lock(project_id):
            data = self._load(project_id)
            if not data.get("id"):
                raise not_found(f"项目不存在: {project_id}")
            return data

    def list_projects(self) -> List[Dict[str, Any]]:
        """列出全部项目（不含章节/工具调用，仅摘要，避免大文件拖慢列表）。"""
        projects: List[Dict[str, Any]] = []
        if not os.path.isdir(self.data_dir):
            return projects
        for name in os.listdir(self.data_dir):
            if not name.endswith(".json") or name.startswith("."):
                continue
            project_id = name[: -len(".json")]
            with self._lock(project_id):
                data = self._load(project_id)
            if data.get("id"):
                projects.append({k: v for k, v in data.items()
                                 if k not in ("chapters", "tool_calls",
                                              "roles", "role_bindings",
                                              "agent_sessions")})
        return projects

    def find_project_by_role(self, role_id: str) -> Optional[Dict[str, Any]]:
        """按角色 id 反查所属项目（角色接口路径无 project_id，需定位聚合根）。

        遍历 data/projects/*.json，返回含该角色 id 的项目（含 roles/绑定/会话）。
        找不到返回 None；多项目共享同一 role_id 时返回最先命中的（角色 id 全局唯一，
        正常不应出现，取首个并记录）。
        """
        if not role_id or not os.path.isdir(self.data_dir):
            return None
        for name in os.listdir(self.data_dir):
            if not name.endswith(".json") or name.startswith("."):
                continue
            project_id = name[: -len(".json")]
            with self._lock(project_id):
                data = self._load(project_id)
            if any(r.get("id") == role_id for r in data.get("roles", [])):
                return data
        return None

    def update_project(self, project_id: str, **updates: Any) -> Dict[str, Any]:
        """更新项目基础字段。"""
        allowed = {"title", "description", "genre", "status", "author", "collab_enabled"}
        with self._lock(project_id):
            data = self._load(project_id)
            if not data.get("id"):
                raise not_found(f"项目不存在: {project_id}")
            for key, value in updates.items():
                if key not in allowed:
                    raise bad_request(f"非法项目字段: {key}")
                if key == "collab_enabled" and not isinstance(value, bool):
                    raise bad_request("collab_enabled 须为布尔值")
                data[key] = value
            if data["status"] not in _PROJECT_STATUSES:
                dstatus = data["status"]
                raise bad_request(f"非法项目状态: {dstatus}")
            data["updated_at"] = _now()
            self._save(project_id, data)
            return data

    # ---------- Collab 协同开关 ----------

    def get_collab_enabled(self, project_id: str) -> bool:
        """读取项目协同模式开关（数据结构设计 §2.3）。"""
        with self._lock(project_id):
            data = self._load(project_id)
            if not data.get("id"):
                raise not_found(f"项目不存在: {project_id}")
            return bool(data.get("collab_enabled", False))

    def set_collab_enabled(self, project_id: str, enabled: bool) -> Dict[str, Any]:
        """设置项目协同模式开关。"""
        if not isinstance(enabled, bool):
            raise bad_request("enabled 须为布尔值")
        with self._lock(project_id):
            data = self._load(project_id)
            if not data.get("id"):
                raise not_found(f"项目不存在: {project_id}")
            data["collab_enabled"] = enabled
            data["updated_at"] = _now()
            self._save(project_id, data)
            return data

    def delete_project(self, project_id: str) -> None:
        """删除项目（级联：章节/工具调用/角色均随聚合根移除）。"""
        with self._lock(project_id):
            if not os.path.exists(self._path(project_id)):
                raise not_found(f"项目不存在: {project_id}")
            os.unlink(self._path(project_id))

    # ---------- Chapter ----------

    def create_chapter(
        self, project_id: str, title: str, content: str = "", order: Optional[int] = None,
    ) -> Dict[str, Any]:
        """创建章节。order 同项目唯一（数据结构设计 §2.4 约束）。

        order 缺省（None）时自动取当前最大序号 + 1，保证章节按创建顺序递增。
        """
        if not title or not str(title).strip():
            raise bad_request("章节标题不能为空")
        now = _now()
        chapter_id = new_id()
        with self._lock(project_id):
            data = self._load(project_id)
            if not data.get("id"):
                raise not_found(f"项目不存在: {project_id}")
            if order is None:
                order = max((c["order"] for c in data["chapters"]), default=-1) + 1
            if not isinstance(order, int) or isinstance(order, bool) or order < 0:
                raise bad_request("order 须为非负整数")
            if any(c["order"] == order for c in data["chapters"]):
                raise bad_request(f"章节顺序 order={order} 已存在")
            chapter: Dict[str, Any] = {
                "id": chapter_id,
                "project_id": project_id,
                "title": str(title).strip(),
                "content": content,
                "order": order,
                "status": "draft",
                "role_ids": [],        # F8：章节出场角色（角色版图联动）
                "flagged_role_ids": [],  # F8：因角色删除被标红的角色
                "created_at": now,
                "updated_at": now,
            }
            data["chapters"].append(chapter)
            self._save(project_id, data)
        return chapter

    def list_chapters(self, project_id: str) -> List[Dict[str, Any]]:
        """按 order 升序列章节。"""
        with self._lock(project_id):
            data = self._load(project_id)
        return sorted(data.get("chapters", []), key=lambda c: c["order"])

    def get_chapter(self, project_id: str, chapter_id: str) -> Dict[str, Any]:
        """按 id 取章节，不存在抛 404。"""
        with self._lock(project_id):
            for chapter in self._load(project_id).get("chapters", []):
                if chapter["id"] == chapter_id:
                    return chapter
        raise not_found(f"章节不存在: {chapter_id}")

    def update_chapter(
        self, project_id: str, chapter_id: str, **updates: Any,
    ) -> Dict[str, Any]:
        """更新章节字段（含内容/状态/顺序）。状态变更需合法。"""
        allowed = {"title", "content", "order", "status", "role_ids", "flagged_role_ids"}
        with self._lock(project_id):
            data = self._load(project_id)
            for chapter in data.get("chapters", []):
                if chapter["id"] != chapter_id:
                    continue
                for key, value in updates.items():
                    if key not in allowed:
                        raise bad_request(f"非法章节字段: {key}")
                    chapter[key] = value
                if chapter["status"] not in _CHAPTER_STATUSES:
                    cstatus = chapter["status"]
                    raise bad_request(f"非法章节状态: {cstatus}")
                if (
                    not isinstance(chapter["order"], int)
                    or isinstance(chapter["order"], bool)
                    or chapter["order"] < 0
                ):
                    raise bad_request("order 须为非负整数")
                chapter["updated_at"] = _now()
                self._save(project_id, data)
                return chapter
        raise not_found(f"章节不存在: {chapter_id}")

    def flag_chapters_by_role(
        self, project_id: str, role_id: str,
    ) -> List[str]:
        """标红章节：把角色加入所有出场该角色的章节的 flagged_role_ids（F8-T3）。

        章节出场判定：chapter.role_ids 含 role_id。幂等（已在列表则不重复）。
        返回被标红的章节 id 列表（前端据此显示标红提示）。
        """
        with self._lock(project_id):
            data = self._load(project_id)
            flagged: List[str] = []
            for chapter in data.get("chapters", []):
                role_ids = chapter.get("role_ids", [])
                if role_id not in role_ids:
                    continue
                flagged_list = chapter.setdefault("flagged_role_ids", [])
                if role_id not in flagged_list:
                    flagged_list.append(role_id)
                    chapter["updated_at"] = _now()
                flagged.append(chapter["id"])
            if flagged:
                self._save(project_id, data)
            return flagged

    def delete_chapter(self, project_id: str, chapter_id: str) -> None:
        """删除章节，不存在抛 404。"""
        with self._lock(project_id):
            data = self._load(project_id)
            before = len(data.get("chapters", []))
            data["chapters"] = [c for c in data["chapters"] if c["id"] != chapter_id]
            if len(data["chapters"]) == before:
                raise not_found(f"章节不存在: {chapter_id}")
            self._save(project_id, data)

    # ---------- ToolCallRecord ----------

    def append_tool_call(
        self, project_id: str, tool_name: str, request: Dict[str, Any],
        response: Dict[str, Any], **extra: Any,
    ) -> Dict[str, Any]:
        """记录工具调用（数据结构设计 §2.5）。

        extra 聚合可选字段：status（success/failed/pending）、
        role_id（联动角色，数据结构设计 §2.5）。
        """
        status = extra.get("status", "success")
        role_id = extra.get("role_id")
        if status not in {"success", "failed", "pending"}:
            raise bad_request("工具调用状态须为 success/failed/pending")
        record: Dict[str, Any] = {
            "id": new_id(),
            "project_id": project_id,
            "tool_name": tool_name,
            "role_id": role_id,
            "request": request,
            "response": response,
            "status": status,
            "created_at": _now(),
        }
        with self._lock(project_id):
            data = self._load(project_id)
            if not data.get("id"):
                raise not_found(f"项目不存在: {project_id}")
            data["tool_calls"].append(record)
            self._save(project_id, data)
        return record

    def list_tool_calls(
        self, project_id: str, tool_name: Optional[str] = None, limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """按项目列工具调用（可选按 tool_name 过滤），按时间倒序。"""
        with self._lock(project_id):
            records = list(self._load(project_id).get("tool_calls", []))
        if tool_name:
            records = [r for r in records if r["tool_name"] == tool_name]
        records.sort(key=lambda r: r.get("created_at", ""), reverse=True)
        return records[:limit]
