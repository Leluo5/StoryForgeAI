# -*- coding: utf-8 -*-
"""角色存储（P3-T1）：Role + RoleAgentBinding + AgentSession。

对齐数据结构设计 §2.1（Role）/ §2.2（RoleAgentBinding）/ §2.6（AgentSession），
并预置 F8 角色版图扩展字段（§3.1：identity/nationality/faith/camp/race/profession/
age_group/attributes/relations）。存储形态：data/projects/<project_id>.json 聚合根内嵌
角色数组（对齐架构设计文档 §7.2），单项目一文件，文件锁 + 原子写防并发写坏。

边界：本模块不 import 知识库模块任何符号；知识条目经 RoleContextDTO 只读注入。
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, not_found
from ..common.storage import FileLock, atomic_write_json, new_id, now_iso, read_json

# F8 角色版图扩展字段（默认值），与数据结构设计 §2.1 合并。
# 知识库角色同步（F5 → P3）新增顶层字段：personality/background/appearance。
# 知识库 characters[] 的「性格」映射到 personality；outline.character_relations 聚合
# 映射到 background（人物关系描述）；appearance 无直接来源，导入时标红待补。
_ROLE_EXTRA_DEFAULTS: Dict[str, Any] = {
    "identity": "",
    "nationality": "",
    "faith": "",
    "camp": "",
    "race": "",
    "profession": "",
    "age_group": "",
    "attributes": {},
    "relations": [],
    "personality": "",
    "background": "",
    "appearance": "",
}

# 角色状态白名单（数据结构设计 §2.1）
_ROLE_STATUSES = {"active", "archived"}
# 章节/绑定状态白名单
_BINDING_ENABLED = {True, False}


def _now() -> str:
    return now_iso()


class RoleStore:
    """角色存储（聚合于项目文件内）。

    data/projects/<project_id>.json 结构：
    {
      "id": project_id, "title": ..., ...,
      "roles": [Role, ...],
      "role_bindings": [RoleAgentBinding, ...],
      "agent_sessions": [AgentSession, ...],
      ...
    }
    """

    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)

    def _path(self, project_id: str) -> str:
        return os.path.join(self.data_dir, f"{project_id}.json")

    def _lock(self, project_id: str) -> FileLock:
        return FileLock(os.path.join(self.data_dir, ".locks", f"{project_id}.lock"))

    def _load(self, project_id: str) -> Dict[str, Any]:
        data = read_json(self._path(project_id), {})
        if not isinstance(data, dict):
            return {}
        data.setdefault("roles", [])
        data.setdefault("role_bindings", [])
        data.setdefault("agent_sessions", [])
        return data

    def _save(self, project_id: str, data: Dict[str, Any]) -> None:
        atomic_write_json(self._path(project_id), data)

    # ---------- Role CRUD ----------

    def create_role(self, project_id: str, name: str, **kwargs: Any) -> Dict[str, Any]:
        """创建角色。name 必填；可覆盖 F8 扩展字段与基础字段。"""
        if not name or not str(name).strip():
            raise bad_request("角色名不能为空")
        now = _now()
        role: Dict[str, Any] = {
            "id": new_id(),
            "project_id": project_id,
            "name": str(name).strip(),
            "age": kwargs.get("age"),
            "gender": kwargs.get("gender"),
            "status": kwargs.get("status") or "active",
            "memory_summary": kwargs.get("memory_summary") or {},
            "created_at": kwargs.get("created_at") or now,
            "updated_at": now,
        }
        # F8 扩展字段
        for key, default in _ROLE_EXTRA_DEFAULTS.items():
            role[key] = kwargs.get(key, default)
        if role["status"] not in _ROLE_STATUSES:
            raise bad_request(f"非法角色状态: {role['status']}")

        with self._lock(project_id):
            data = self._load(project_id)
            data["roles"].append(role)
            self._save(project_id, data)
        return role

    def list_roles(self, project_id: str) -> List[Dict[str, Any]]:
        """按项目列角色（数据结构设计 §四：Role.project_id 索引）。"""
        with self._lock(project_id):
            return list(self._load(project_id)["roles"])

    def get_role(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """按 id 取角色，不存在抛 404。"""
        with self._lock(project_id):
            for role in self._load(project_id)["roles"]:
                if role["id"] == role_id:
                    return role
        raise not_found(f"角色不存在: {role_id}")

    def update_role(self, project_id: str, role_id: str, **updates: Any) -> Dict[str, Any]:
        """更新角色字段。仅允许白名单字段；状态变更需合法。"""
        allowed = {
            "name", "age", "gender", "status", "memory_summary",
            *_ROLE_EXTRA_DEFAULTS.keys(),
        }
        with self._lock(project_id):
            data = self._load(project_id)
            for role in data["roles"]:
                if role["id"] != role_id:
                    continue
                for key, value in updates.items():
                    if key not in allowed:
                        raise bad_request(f"非法角色字段: {key}")
                    role[key] = value
                if role["status"] not in _ROLE_STATUSES:
                    raise bad_request(f"非法角色状态: {role['status']}")
                role["updated_at"] = _now()
                self._save(project_id, data)
                return role
        raise not_found(f"角色不存在: {role_id}")

    def delete_role(self, project_id: str, role_id: str) -> None:
        """删除角色并级联删绑定/会话（数据结构设计 §五 引用完整性）。"""
        with self._lock(project_id):
            data = self._load(project_id)
            before = len(data["roles"])
            data["roles"] = [r for r in data["roles"] if r["id"] != role_id]
            if len(data["roles"]) == before:
                raise not_found(f"角色不存在: {role_id}")
            data["role_bindings"] = [b for b in data["role_bindings"] if b["role_id"] != role_id]
            data["agent_sessions"] = [s for s in data["agent_sessions"] if s["role_id"] != role_id]
            self._save(project_id, data)

    # ---------- RoleAgentBinding ----------

    def create_binding(
        self, project_id: str, role_id: str, agent_id: str,
        step_order: int, **extra: Any,
    ) -> Dict[str, Any]:
        """创建角色 Agent 绑定。step_order 同角色唯一（数据结构设计 §2.2 约束）。

        extra 聚合可选字段：workflow_id/enabled。
        """
        workflow_id = extra.get("workflow_id")
        enabled = extra.get("enabled", True)
        if not agent_id:
            raise bad_request("agent_id 不能为空")
        if not isinstance(step_order, int) or isinstance(step_order, bool) \
                or not (1 <= step_order <= 11):
            raise bad_request("step_order 须为 1-11 整数")
        if enabled not in _BINDING_ENABLED:
            raise bad_request("enabled 须为布尔值")
        binding: Dict[str, Any] = {
            "id": new_id(),
            "role_id": role_id,
            "agent_id": agent_id,
            "step_order": step_order,
            "workflow_id": workflow_id,
            "enabled": enabled,
            "created_at": _now(),
        }
        with self._lock(project_id):
            data = self._load(project_id)
            if any(b["role_id"] == role_id and b["step_order"] == step_order
                   for b in data["role_bindings"]):
                raise bad_request(f"该角色 step_order={step_order} 已存在绑定")
            data["role_bindings"].append(binding)
            self._save(project_id, data)
        return binding

    def get_bindings(
        self, project_id: str, role_id: str, enabled: Optional[bool] = None,
    ) -> List[Dict[str, Any]]:
        """按角色列绑定（enabled 过滤可选），按 step_order 排序（调度器依据）。"""
        with self._lock(project_id):
            bindings = [
                b for b in self._load(project_id)["role_bindings"]
                if b["role_id"] == role_id
            ]
        if enabled is not None:
            bindings = [b for b in bindings if b["enabled"] is enabled]
        return sorted(bindings, key=lambda b: b["step_order"])

    def update_binding(
        self, project_id: str, binding_id: str, **updates: Any,
    ) -> Dict[str, Any]:
        """更新绑定字段（白名单校验），不存在抛 404。"""
        allowed = {"agent_id", "step_order", "workflow_id", "enabled"}
        with self._lock(project_id):
            data = self._load(project_id)
            for binding in data["role_bindings"]:
                if binding["id"] != binding_id:
                    continue
                for key, value in updates.items():
                    if key not in allowed:
                        raise bad_request(f"非法绑定字段: {key}")
                    binding[key] = value
                if binding["enabled"] not in _BINDING_ENABLED:
                    raise bad_request("enabled 须为布尔值")
                self._save(project_id, data)
                return binding
        raise not_found(f"绑定不存在: {binding_id}")

    def delete_binding(self, project_id: str, binding_id: str) -> None:
        """删除绑定，不存在抛 404。"""
        with self._lock(project_id):
            data = self._load(project_id)
            before = len(data["role_bindings"])
            data["role_bindings"] = [b for b in data["role_bindings"] if b["id"] != binding_id]
            if len(data["role_bindings"]) == before:
                raise not_found(f"绑定不存在: {binding_id}")
            self._save(project_id, data)

    # ---------- AgentSession（记忆命名空间） ----------

    def _session_key(self, role_id: str, agent_id: str) -> str:
        return f"{role_id}:{agent_id}"

    def get_session(self, project_id: str, role_id: str, agent_id: str) -> Dict[str, Any]:
        """按 (role_id, agent_id) 唯一恢复会话（数据结构设计 §2.6 约束）。"""
        key = self._session_key(role_id, agent_id)
        with self._lock(project_id):
            for session in self._load(project_id)["agent_sessions"]:
                if session["conversation_id"] == key:
                    return session
        # 不存在则返回空会话（不落盘，调度器按需 set_memory）
        return {
            "role_id": role_id,
            "agent_id": agent_id,
            "conversation_id": key,
            "memory_state": {},
            "updated_at": _now(),
        }

    def get_memory(self, project_id: str, role_id: str, agent_id: str) -> Dict[str, Any]:
        """读取记忆状态（调度器恢复记忆用）。"""
        return self.get_session(project_id, role_id, agent_id).get("memory_state", {})

    def set_memory(
        self, project_id: str, role_id: str, agent_id: str, memory_state: Dict[str, Any],
    ) -> Dict[str, Any]:
        """写回记忆状态（role_id 命名空间），upsert 语义。"""
        key = self._session_key(role_id, agent_id)
        with self._lock(project_id):
            data = self._load(project_id)
            for session in data["agent_sessions"]:
                if session["conversation_id"] == key:
                    session["memory_state"] = memory_state
                    session["updated_at"] = _now()
                    self._save(project_id, data)
                    return session
            session = {
                "role_id": role_id,
                "agent_id": agent_id,
                "conversation_id": key,
                "memory_state": memory_state,
                "updated_at": _now(),
            }
            data["agent_sessions"].append(session)
            self._save(project_id, data)
            return session
