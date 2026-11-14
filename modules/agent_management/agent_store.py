# -*- coding: utf-8 -*-
"""单 Agent 文件存储：CRUD、版本快照、分组覆盖层、工具默认切换。"""

from __future__ import annotations

import copy
import os
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, conflict, not_found
from ..common.storage import FileLock, atomic_write_json, new_id, now_iso, read_json
from .types import (
    MAX_VERSIONS, STATUSES,
    validate_agent_identity, validate_model_config, validate_platform_config,
)


class AgentStore:
    """data/agents/<project_id>/<agent_id>.json 存储。"""

    def __init__(self, root_dir: str) -> None:
        self.root_dir = root_dir
        os.makedirs(root_dir, exist_ok=True)

    # ---------- 路径与锁 ----------

    def _project_dir(self, project_id: str) -> str:
        path = os.path.join(self.root_dir, project_id)
        os.makedirs(path, exist_ok=True)
        os.makedirs(os.path.join(path, ".locks"), exist_ok=True)
        return path

    def _path(self, project_id: str, agent_id: str) -> str:
        return os.path.join(self._project_dir(project_id), f"{agent_id}.json")

    def _lock(self, project_id: str, agent_id: str) -> FileLock:
        return FileLock(os.path.join(self._project_dir(project_id), ".locks", f"{agent_id}.lock"))

    def _groups_path(self, project_id: str) -> str:
        return os.path.join(self._project_dir(project_id), "_groups.json")

    def _groups_lock(self, project_id: str) -> FileLock:
        return FileLock(os.path.join(self._project_dir(project_id), ".locks", "_groups.lock"))

    # ---------- Agent CRUD ----------

    def list_agents(self, project_id: str) -> List[Dict[str, Any]]:
        """列出项目全部 Agent（不含 versions，_groups.json 除外）。"""
        directory = self._project_dir(project_id)
        agents: List[Dict[str, Any]] = []
        for name in os.listdir(directory):
            if not name.endswith(".json") or name.startswith("_"):
                continue
            data = read_json(os.path.join(directory, name), None)
            if not isinstance(data, dict) or not data.get("id"):
                continue
            data.pop("versions", None)
            agents.append(data)
        return sorted(agents, key=lambda a: (a.get("kind", ""), a.get("step_order") or 0,
                                             a.get("name", "")))

    def get_agent(self, project_id: str, agent_id: str,
                  include_versions: bool = False) -> Dict[str, Any]:
        """读取 Agent；默认剥离 versions。"""
        data = read_json(self._path(project_id, agent_id), None)
        if not isinstance(data, dict) or not data.get("id"):
            raise not_found(f"Agent 不存在: {agent_id}")
        if not include_versions:
            data = copy.deepcopy(data)
            data.pop("versions", None)
        return data

    def create_agent(self, project_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """创建 Agent，写版本 1 快照并做唯一性校验。"""
        kind = payload.get("kind", "")
        name = payload.get("name")
        if not name or not str(name).strip():
            raise bad_request("name 不能为空")
        validate_agent_identity(kind, payload)
        platform = payload.get("platform") or "coze"
        platform_config = validate_platform_config(platform, payload.get("platform_config"))
        model_config = validate_model_config(payload.get("model_config"))
        now = now_iso()
        agent = {
            "id": new_id(),
            "project_id": project_id,
            "kind": kind,
            "name": str(name).strip(),
            "description": payload.get("description") or "",
            "role_id": payload.get("role_id"),
            "tool_name": payload.get("tool_name"),
            "step_order": payload.get("step_order"),
            "scope": payload.get("scope") or ("role" if kind == "role_agent" else "project"),
            "platform": platform,
            "platform_config": platform_config,
            "credential_source": "global",
            "model_config": model_config,
            "status": payload.get("status") or "active",
            "is_default": bool(payload.get("is_default", False)),
            "source": payload.get("source") or "manual",
            "tags": list(payload.get("tags") or []),
            "manual_group_key": payload.get("manual_group_key"),
            "version_no": 1,
            "versions": [],
            "created_at": now,
            "updated_at": now,
            "archived_at": None,
        }
        if agent["status"] not in STATUSES:
            raise bad_request("status 须为 active/disabled/archived")
        agent["versions"].append(self._snapshot(agent, "create", payload.get("note", "")))
        with self._lock(project_id, agent["id"]):
            self._check_unique(project_id, agent)
            atomic_write_json(self._path(project_id, agent["id"]), agent)
        return self.get_agent(project_id, agent["id"], include_versions=True)

    def update_agent(self, project_id: str, agent_id: str, updates: Dict[str, Any],
                     note: str = "") -> Dict[str, Any]:
        """白名单更新并写版本快照。"""
        allowed = {
            "name", "description", "platform", "platform_config", "model_config",
            "status", "is_default", "tags", "manual_group_key", "role_id",
            "tool_name", "step_order", "scope",
        }
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            for key, value in updates.items():
                if key not in allowed:
                    raise bad_request(f"非法 Agent 字段: {key}")
            merged = copy.deepcopy(agent)
            merged.update(updates)
            validate_agent_identity(merged["kind"], merged)
            merged["platform_config"] = validate_platform_config(
                merged.get("platform") or "coze", merged.get("platform_config")
            )
            merged["model_config"] = validate_model_config(merged.get("model_config"))
            if merged["status"] not in STATUSES:
                raise bad_request("status 须为 active/disabled/archived")
            self._check_unique(project_id, merged, exclude_id=agent_id)
            merged["version_no"] = int(agent.get("version_no", 1)) + 1
            merged["updated_at"] = now_iso()
            merged["versions"] = list(agent.get("versions") or [])
            merged["versions"].append(self._snapshot(merged, "update", note))
            merged["versions"] = merged["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, agent_id), merged)
        return self.get_agent(project_id, agent_id)

    def archive_agent(self, project_id: str, agent_id: str) -> Dict[str, Any]:
        """归档并写快照。"""
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            agent["status"] = "archived"
            agent["archived_at"] = now_iso()
            agent["version_no"] = int(agent.get("version_no", 1)) + 1
            agent["updated_at"] = agent["archived_at"]
            agent["versions"] = list(agent.get("versions") or [])
            agent["versions"].append(self._snapshot(agent, "archive", ""))
            agent["versions"] = agent["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, agent_id), agent)
        return self.get_agent(project_id, agent_id)

    def restore_agent(self, project_id: str, agent_id: str) -> Dict[str, Any]:
        """恢复为 active 并写快照。"""
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            agent["status"] = "active"
            agent["archived_at"] = None
            agent["version_no"] = int(agent.get("version_no", 1)) + 1
            agent["updated_at"] = now_iso()
            agent["versions"] = list(agent.get("versions") or [])
            agent["versions"].append(self._snapshot(agent, "restore", ""))
            agent["versions"] = agent["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, agent_id), agent)
        return self.get_agent(project_id, agent_id)

    def delete_agent(self, project_id: str, agent_id: str, force: bool = False) -> bool:
        """硬删除；默认要求已归档，force 可强制。"""
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            if agent.get("status") != "archived" and not force:
                raise conflict("Agent 未归档，需先归档或 force=true")
            try:
                os.unlink(self._path(project_id, agent_id))
            except FileNotFoundError:
                return False
        return True

    def get_versions(self, project_id: str, agent_id: str) -> List[Dict[str, Any]]:
        """返回版本列表（不含 snapshot 内容，仅摘要）。"""
        versions = self._load_full(project_id, agent_id).get("versions") or []
        return [{k: v for k, v in item.items() if k != "snapshot"} for item in versions]

    def rollback(self, project_id: str, agent_id: str, version_no: int) -> Dict[str, Any]:
        """回滚到指定版本，生成新版本号。"""
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            target = next((v for v in agent.get("versions", [])
                           if int(v.get("version_no", 0)) == int(version_no)), None)
            if target is None:
                raise not_found(f"版本不存在: {version_no}")
            snapshot = copy.deepcopy(target["snapshot"])
            versions = list(agent.get("versions") or [])
            next_version = int(agent.get("version_no", 1)) + 1
            agent.update(snapshot)
            agent["version_no"] = next_version
            agent["updated_at"] = now_iso()
            agent["versions"] = versions
            agent["versions"].append(self._snapshot(agent, "rollback", f"rollback to {version_no}"))
            agent["versions"] = agent["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, agent_id), agent)
        return self.get_agent(project_id, agent_id)

    # ---------- 内部 ----------

    def _load_full(self, project_id: str, agent_id: str) -> Dict[str, Any]:
        data = read_json(self._path(project_id, agent_id), None)
        if not isinstance(data, dict) or not data.get("id"):
            raise not_found(f"Agent 不存在: {agent_id}")
        return data

    def _snapshot(self, agent: Dict[str, Any], change_type: str, note: str) -> Dict[str, Any]:
        snapshot = {k: copy.deepcopy(v) for k, v in agent.items()
                    if k not in ("versions",)}
        return {
            "version_no": agent.get("version_no", 1),
            "change_type": change_type,
            "note": note,
            "created_at": now_iso(),
            "snapshot": snapshot,
        }

    def _check_unique(self, project_id: str, agent: Dict[str, Any],
                      exclude_id: Optional[str] = None) -> None:
        for other in self.list_agents(project_id):
            if other["id"] == exclude_id:
                continue
            if agent["kind"] == "flow_step_agent" and other["kind"] == "flow_step_agent" \
                    and other.get("step_order") == agent.get("step_order"):
                raise conflict(f"step_order={agent.get('step_order')} 已存在流程 Agent")
            if agent["kind"] == "tool_agent" and other["kind"] == "tool_agent" \
                    and other.get("tool_name") == agent.get("tool_name") \
                    and other.get("is_default") and agent.get("is_default"):
                raise conflict(f"工具 {agent.get('tool_name')} 已存在默认 Agent")

    # ---------- 分组覆盖层 ----------

    def load_group_overrides(self, project_id: str) -> Dict[str, Any]:
        """读取 _groups.json；不存在返回空覆盖层。"""
        data = read_json(self._groups_path(project_id), None)
        if not isinstance(data, dict):
            data = {}
        data.setdefault("project_id", project_id)
        data.setdefault("schema_version", 1)
        data.setdefault("overrides", [])
        data.setdefault("manual_groups", [])
        return data

    def save_group_overrides(self, project_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """原子写 _groups.json。"""
        data = dict(data)
        data["project_id"] = project_id
        data["updated_at"] = now_iso()
        with self._groups_lock(project_id):
            atomic_write_json(self._groups_path(project_id), data)
        return data

    def upsert_override(self, project_id: str, key: str, **fields: Any) -> Dict[str, Any]:
        """upsert 分组覆盖：name/sort_order/hidden。"""
        if not key:
            raise bad_request("key 不能为空")
        data = self.load_group_overrides(project_id)
        item = next((o for o in data["overrides"] if o.get("key") == key), None)
        if item is None:
            item = {"key": key, "name": "", "sort_order": 0, "hidden": False}
            data["overrides"].append(item)
        for name in ("name", "sort_order", "hidden"):
            if name in fields:
                item[name] = fields[name]
        self.save_group_overrides(project_id, data)
        return item

    def delete_override(self, project_id: str, key: str) -> bool:
        """删除覆盖；不存在返回 False。"""
        data = self.load_group_overrides(project_id)
        before = len(data["overrides"])
        data["overrides"] = [o for o in data["overrides"] if o.get("key") != key]
        if len(data["overrides"]) == before:
            return False
        self.save_group_overrides(project_id, data)
        return True

    def create_manual_group(self, project_id: str, parent_key: str, name: str,
                            sort_order: int = 0) -> Dict[str, Any]:
        """新建手工分组。"""
        if not name or not str(name).strip():
            raise bad_request("分组名不能为空")
        data = self.load_group_overrides(project_id)
        group = {
            "id": f"manual:{new_id()}",
            "parent_key": parent_key,
            "name": str(name).strip(),
            "sort_order": int(sort_order),
        }
        data["manual_groups"].append(group)
        self.save_group_overrides(project_id, data)
        return group

    def delete_manual_group(self, project_id: str, group_id: str) -> bool:
        """删除手工分组；组内 Agent 回落自动分组。"""
        data = self.load_group_overrides(project_id)
        before = len(data["manual_groups"])
        data["manual_groups"] = [g for g in data["manual_groups"] if g.get("id") != group_id]
        if len(data["manual_groups"]) == before:
            return False
        self.save_group_overrides(project_id, data)
        for agent in self.list_agents(project_id):
            if agent.get("manual_group_key") == group_id:
                self.update_agent(project_id, agent["id"], {"manual_group_key": None})
        return True
