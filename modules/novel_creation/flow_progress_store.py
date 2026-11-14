# -*- coding: utf-8 -*-
"""每角色 11 步流程进度存储：data/flows/<project_id>/<role_id>.json。"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from ..common.storage import FileLock, atomic_write_json, new_id, now_iso, read_json


class FlowProgressStore:
    """按 (project_id, role_id) 隔离进度与执行锁。"""

    def __init__(self, root_dir: str) -> None:
        self.root_dir = root_dir
        os.makedirs(root_dir, exist_ok=True)

    def _project_dir(self, project_id: str) -> str:
        path = os.path.join(self.root_dir, project_id)
        os.makedirs(path, exist_ok=True)
        os.makedirs(os.path.join(path, ".locks"), exist_ok=True)
        return path

    def _path(self, project_id: str, role_id: str) -> str:
        return os.path.join(self._project_dir(project_id), f"{role_id}.json")

    def lock(self, project_id: str, role_id: str) -> FileLock:
        """返回该角色的执行锁（非阻塞 try_acquire 由调用方决定）。"""
        return FileLock(os.path.join(self._project_dir(project_id), ".locks", f"{role_id}.lock"))

    def get(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """读取进度；不存在返回 idle 空进度。"""
        data = read_json(self._path(project_id, role_id), None)
        if not isinstance(data, dict):
            data = {}
        return self._normalize(project_id, role_id, data)

    def start(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """开始一次新运行。"""
        return self._write(project_id, role_id, {
            "run_id": new_id(),
            "status": "running",
            "current_step": 0,
            "completed_steps": [],
            "steps": [],
            "context": {},
            "started_at": now_iso(),
            "last_error": "",
        })

    def record_step(self, project_id: str, role_id: str, step_order: int,
                    status: str, **details: Any) -> Dict[str, Any]:
        """更新单步状态；done 时写入 completed_steps。

        details 聚合可选字段：output（步骤产出）、error（失败原因）。
        """
        output: Optional[Dict[str, Any]] = details.get("output")
        error = str(details.get("error", ""))
        data = self.get(project_id, role_id)
        data["current_step"] = step_order
        steps = data["steps"]
        step = next((s for s in steps if int(s.get("step_order", 0)) == step_order), None)
        if step is None:
            step = {"step_order": step_order, "status": "pending", "output": {},
                    "started_at": now_iso(), "finished_at": "", "error": ""}
            steps.append(step)
        step["status"] = status
        step["output"] = output or step.get("output") or {}
        step["error"] = error
        if status == "running":
            step["started_at"] = step.get("started_at") or now_iso()
        if status in ("done", "failed"):
            step["finished_at"] = now_iso()
        if status == "done" and step_order not in data["completed_steps"]:
            data["completed_steps"].append(step_order)
            data["completed_steps"].sort()
        data["steps"] = steps
        return self._write(project_id, role_id, data)

    def finish(self, project_id: str, role_id: str, status: str,
               error: str = "") -> Dict[str, Any]:
        """结束运行：done/failed。"""
        data = self.get(project_id, role_id)
        data["status"] = status
        data["last_error"] = error
        return self._write(project_id, role_id, data)

    def reset(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """重置为 idle。"""
        return self._write(project_id, role_id, {
            "run_id": "", "status": "idle", "current_step": 0,
            "completed_steps": [], "steps": [], "context": {},
            "started_at": "", "last_error": "",
        })

    def delete_role(self, project_id: str, role_id: str) -> bool:
        """删除角色进度文件（角色删除级联）。"""
        try:
            os.unlink(self._path(project_id, role_id))
            return True
        except FileNotFoundError:
            return False

    # ---------- 内部 ----------

    def _normalize(self, project_id: str, role_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        data.setdefault("project_id", project_id)
        data.setdefault("role_id", role_id)
        data.setdefault("run_id", "")
        data.setdefault("status", "idle")
        data.setdefault("current_step", 0)
        data.setdefault("completed_steps", [])
        data.setdefault("steps", [])
        data.setdefault("context", {})
        data.setdefault("started_at", "")
        data.setdefault("updated_at", "")
        data.setdefault("last_error", "")
        return data

    def _write(self, project_id: str, role_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        data = self._normalize(project_id, role_id, dict(data))
        data["updated_at"] = now_iso()
        with FileLock(self._path(project_id, role_id) + ".lock"):
            atomic_write_json(self._path(project_id, role_id), data)
        return data
