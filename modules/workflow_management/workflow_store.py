# -*- coding: utf-8 -*-
"""单工作流文件存储：CRUD、启用/禁用、版本快照。"""

from __future__ import annotations

import copy
import os
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, conflict, not_found
from ..common.storage import FileLock, atomic_write_json, new_id, now_iso, read_json
from .types import (
    MAX_VERSIONS, SOURCES, UPDATE_WHITELIST, WORKFLOW_STATUSES,
    validate_llm_config, validate_platform_config, validate_status,
)


class WorkflowStore:
    """data/workflows/<project_id>/<workflow_id>.json 存储。"""

    def __init__(self, root_dir: str) -> None:
        self.root_dir = root_dir
        os.makedirs(root_dir, exist_ok=True)

    # ---------- 路径与锁 ----------

    def _project_dir(self, project_id: str) -> str:
        path = os.path.join(self.root_dir, project_id)
        os.makedirs(path, exist_ok=True)
        os.makedirs(os.path.join(path, ".locks"), exist_ok=True)
        return path

    def _path(self, project_id: str, workflow_id: str) -> str:
        return os.path.join(self._project_dir(project_id), f"{workflow_id}.json")

    def _lock(self, project_id: str, workflow_id: str) -> FileLock:
        return FileLock(os.path.join(self._project_dir(project_id), ".locks",
                                     f"{workflow_id}.lock"))

    # ---------- Workflow CRUD ----------

    def list_workflows(self, project_id: str, status: Optional[str] = None,
                       keyword: Optional[str] = None) -> List[Dict[str, Any]]:
        """列出项目全部工作流（不含 versions），按 updated_at 倒序。"""
        directory = self._project_dir(project_id)
        workflows: List[Dict[str, Any]] = []
        for name in os.listdir(directory):
            if not name.endswith(".json") or name.startswith("_"):
                continue
            data = read_json(os.path.join(directory, name), None)
            if not isinstance(data, dict) or not data.get("id"):
                continue
            data.pop("versions", None)
            if status and data.get("status") != status:
                continue
            if keyword:
                kw = keyword.lower()
                if kw not in (data.get("name") or "").lower() \
                        and kw not in (data.get("description") or "").lower():
                    continue
            workflows.append(data)
        return sorted(workflows, key=lambda w: w.get("updated_at") or "", reverse=True)

    def get_workflow(self, project_id: str, workflow_id: str,
                     include_versions: bool = False) -> Dict[str, Any]:
        """读取工作流；默认剥离 versions。"""
        data = read_json(self._path(project_id, workflow_id), None)
        if not isinstance(data, dict) or not data.get("id"):
            raise not_found(f"工作流不存在: {workflow_id}")
        if not include_versions:
            data = copy.deepcopy(data)
            data.pop("versions", None)
        return data

    def create_workflow(self, project_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """创建工作流，写版本 1 快照并做唯一性校验。"""
        name = payload.get("name")
        if not name or not str(name).strip():
            raise bad_request("name 不能为空")
        platform = payload.get("platform") or "coze"
        platform_config = validate_platform_config(platform, payload.get("platform_config"))
        llm_config = validate_llm_config(payload.get("llm_config"))
        status = validate_status(payload.get("status") or "active")
        source = payload.get("source") or "manual"
        if source not in SOURCES:
            raise bad_request("source 须为 manual/coze_import")
        now = now_iso()
        workflow = {
            "id": new_id(),
            "project_id": project_id,
            "name": str(name).strip(),
            "description": payload.get("description") or "",
            "status": status,
            "platform": platform,
            "platform_config": platform_config,
            "params": list(payload.get("params") or []),
            "llm_config": llm_config,
            "source": source,
            "icon_url": payload.get("icon_url") or "",
            "version_no": 1,
            "versions": [],
            "created_at": now,
            "updated_at": now,
            "archived_at": None,
        }
        workflow["versions"].append(self._snapshot(workflow, "create", payload.get("note", "")))
        with self._lock(project_id, workflow["id"]):
            self._check_unique(project_id, workflow)
            atomic_write_json(self._path(project_id, workflow["id"]), workflow)
        return self.get_workflow(project_id, workflow["id"], include_versions=True)

    def update_workflow(self, project_id: str, workflow_id: str,
                        updates: Dict[str, Any], note: str = "") -> Dict[str, Any]:
        """白名单更新并写版本快照。"""
        with self._lock(project_id, workflow_id):
            workflow = self._load_full(project_id, workflow_id)
            for key in updates:
                if key not in UPDATE_WHITELIST:
                    raise bad_request(f"非法工作流字段: {key}")
            merged = copy.deepcopy(workflow)
            merged.update(updates)
            if "status" in updates:
                merged["status"] = validate_status(merged["status"])
            if "source" in updates and merged["source"] not in SOURCES:
                raise bad_request("source 须为 manual/coze_import")
            if "platform_config" in updates:
                merged["platform_config"] = validate_platform_config(
                    merged.get("platform") or "coze", merged.get("platform_config"))
            if "llm_config" in updates:
                merged["llm_config"] = validate_llm_config(merged.get("llm_config"))
            self._check_unique(project_id, merged, exclude_id=workflow_id)
            merged["version_no"] = int(workflow.get("version_no", 1)) + 1
            merged["updated_at"] = now_iso()
            merged["versions"] = list(workflow.get("versions") or [])
            merged["versions"].append(self._snapshot(merged, "update", note))
            merged["versions"] = merged["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, workflow_id), merged)
        return self.get_workflow(project_id, workflow_id)

    def set_status(self, project_id: str, workflow_id: str, status: str) -> Dict[str, Any]:
        """启用/禁用切换，写版本快照。"""
        status = validate_status(status)
        if status == "archived":
            raise bad_request("请使用 archive 接口归档")
        with self._lock(project_id, workflow_id):
            workflow = self._load_full(project_id, workflow_id)
            workflow["status"] = status
            workflow["version_no"] = int(workflow.get("version_no", 1)) + 1
            workflow["updated_at"] = now_iso()
            workflow["versions"] = list(workflow.get("versions") or [])
            workflow["versions"].append(self._snapshot(workflow, "status", f"status->{status}"))
            workflow["versions"] = workflow["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, workflow_id), workflow)
        return self.get_workflow(project_id, workflow_id)

    def archive_workflow(self, project_id: str, workflow_id: str) -> Dict[str, Any]:
        """归档并写快照。"""
        with self._lock(project_id, workflow_id):
            workflow = self._load_full(project_id, workflow_id)
            workflow["status"] = "archived"
            workflow["archived_at"] = now_iso()
            workflow["version_no"] = int(workflow.get("version_no", 1)) + 1
            workflow["updated_at"] = workflow["archived_at"]
            workflow["versions"] = list(workflow.get("versions") or [])
            workflow["versions"].append(self._snapshot(workflow, "archive", ""))
            workflow["versions"] = workflow["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, workflow_id), workflow)
        return self.get_workflow(project_id, workflow_id)

    def restore_workflow(self, project_id: str, workflow_id: str) -> Dict[str, Any]:
        """恢复为 active 并写快照。"""
        with self._lock(project_id, workflow_id):
            workflow = self._load_full(project_id, workflow_id)
            workflow["status"] = "active"
            workflow["archived_at"] = None
            workflow["version_no"] = int(workflow.get("version_no", 1)) + 1
            workflow["updated_at"] = now_iso()
            workflow["versions"] = list(workflow.get("versions") or [])
            workflow["versions"].append(self._snapshot(workflow, "restore", ""))
            workflow["versions"] = workflow["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, workflow_id), workflow)
        return self.get_workflow(project_id, workflow_id)

    def delete_workflow(self, project_id: str, workflow_id: str, force: bool = False) -> bool:
        """硬删除；默认要求已归档，force 可强制。"""
        with self._lock(project_id, workflow_id):
            workflow = self._load_full(project_id, workflow_id)
            if workflow.get("status") != "archived" and not force:
                raise conflict("工作流未归档，需先归档或 force=true")
            try:
                os.unlink(self._path(project_id, workflow_id))
            except FileNotFoundError:
                return False
        return True

    def get_versions(self, project_id: str, workflow_id: str) -> List[Dict[str, Any]]:
        """返回版本列表（不含 snapshot 内容，仅摘要）。"""
        versions = self._load_full(project_id, workflow_id).get("versions") or []
        return [{k: v for k, v in item.items() if k != "snapshot"} for item in versions]

    def rollback(self, project_id: str, workflow_id: str, version_no: int) -> Dict[str, Any]:
        """回滚到指定版本，生成新版本号。"""
        with self._lock(project_id, workflow_id):
            workflow = self._load_full(project_id, workflow_id)
            target = next((v for v in workflow.get("versions", [])
                           if int(v.get("version_no", 0)) == int(version_no)), None)
            if target is None:
                raise not_found(f"版本不存在: {version_no}")
            snapshot = copy.deepcopy(target["snapshot"])
            versions = list(workflow.get("versions") or [])
            next_version = int(workflow.get("version_no", 1)) + 1
            workflow.update(snapshot)
            workflow["version_no"] = next_version
            workflow["updated_at"] = now_iso()
            workflow["versions"] = versions
            workflow["versions"].append(self._snapshot(
                workflow, "rollback", f"rollback to {version_no}"))
            workflow["versions"] = workflow["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, workflow_id), workflow)
        return self.get_workflow(project_id, workflow_id)

    # ---------- 内部 ----------

    def _load_full(self, project_id: str, workflow_id: str) -> Dict[str, Any]:
        data = read_json(self._path(project_id, workflow_id), None)
        if not isinstance(data, dict) or not data.get("id"):
            raise not_found(f"工作流不存在: {workflow_id}")
        return data

    def _snapshot(self, workflow: Dict[str, Any], change_type: str, note: str) -> Dict[str, Any]:
        snapshot = {k: copy.deepcopy(v) for k, v in workflow.items()
                    if k not in ("versions",)}
        return {
            "version_no": workflow.get("version_no", 1),
            "change_type": change_type,
            "note": note,
            "created_at": now_iso(),
            "snapshot": snapshot,
        }

    def _check_unique(self, project_id: str, workflow: Dict[str, Any],
                      exclude_id: Optional[str] = None) -> None:
        """按 platform_config.workflow_id 唯一性校验（非空时）。"""
        wid = (workflow.get("platform_config") or {}).get("workflow_id")
        if not wid:
            return
        for other in self.list_workflows(project_id):
            if other["id"] == exclude_id:
                continue
            other_wid = (other.get("platform_config") or {}).get("workflow_id")
            if other_wid == wid:
                raise conflict(f"workflow_id={wid} 已存在工作流")
