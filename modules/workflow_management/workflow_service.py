# -*- coding: utf-8 -*-
"""工作流业务编排：CRUD 透传、Coze 导入幂等、存量迁移。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..common.errors import bad_request
from .types import GLOBAL_WORKFLOW_PROJECT_ID
from .workflow_store import WorkflowStore


class WorkflowService:
    """封装工作流存储，提供导入幂等与迁移逻辑。"""

    def __init__(self, store: WorkflowStore) -> None:
        self.store = store

    # ---------- CRUD 透传 ----------

    def list_workflows(self, project_id: str, status: Optional[str] = None,
                       keyword: Optional[str] = None) -> List[Dict[str, Any]]:
        """列出项目下的工作流，支持按状态与关键字过滤。"""
        return self.store.list_workflows(project_id, status=status, keyword=keyword)

    def get_workflow(self, project_id: str, workflow_id: str,
                     include_versions: bool = False) -> Dict[str, Any]:
        """获取工作流详情，可选一并返回版本列表。"""
        return self.store.get_workflow(project_id, workflow_id, include_versions)

    def create_workflow(self, project_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """创建并返回工作流。"""
        return self.store.create_workflow(project_id, payload)

    def update_workflow(self, project_id: str, workflow_id: str,
                        updates: Dict[str, Any], note: str = "") -> Dict[str, Any]:
        """更新工作流信息，并记录变更备注。"""
        return self.store.update_workflow(project_id, workflow_id, updates, note=note)

    def set_status(self, project_id: str, workflow_id: str, status: str) -> Dict[str, Any]:
        """设置工作流状态（启用/禁用）。"""
        return self.store.set_status(project_id, workflow_id, status)

    def archive_workflow(self, project_id: str, workflow_id: str) -> Dict[str, Any]:
        """归档工作流。"""
        return self.store.archive_workflow(project_id, workflow_id)

    def restore_workflow(self, project_id: str, workflow_id: str) -> Dict[str, Any]:
        """恢复已归档的工作流。"""
        return self.store.restore_workflow(project_id, workflow_id)

    def delete_workflow(self, project_id: str, workflow_id: str,
                        force: bool = False) -> bool:
        """删除工作流，force 为真时强制删除。"""
        return self.store.delete_workflow(project_id, workflow_id, force=force)

    def get_versions(self, project_id: str, workflow_id: str) -> List[Dict[str, Any]]:
        """获取工作流的版本列表。"""
        return self.store.get_versions(project_id, workflow_id)

    def rollback(self, project_id: str, workflow_id: str, version_no: int) -> Dict[str, Any]:
        """把工作流回滚到指定版本。"""
        return self.store.rollback(project_id, workflow_id, version_no)

    # ---------- Coze 导入 ----------

    def import_coze_workflow(self, wf_info: Dict[str, Any],
                             workspace_id: str = "") -> Dict[str, Any]:
        """从 Coze 元信息导入/同步工作流到全局未分类池，按 workflow_id 幂等。"""
        workflow_id = wf_info.get("id") or wf_info.get("workflow_id")
        if not workflow_id:
            raise bad_request("Coze 工作流缺少 workflow_id")
        name = wf_info.get("name") or wf_info.get("workflow_name") or ""
        if not name:
            raise bad_request("Coze 工作流缺少 name")
        description = wf_info.get("description") or ""
        icon_url = wf_info.get("icon_url") or ""
        platform_config = {
            "workflow_id": str(workflow_id),
            "workspace_id": str(workspace_id or ""),
        }
        existing = self._find_by_workflow_id(GLOBAL_WORKFLOW_PROJECT_ID, str(workflow_id))
        if existing is not None:
            return self.update_workflow(
                GLOBAL_WORKFLOW_PROJECT_ID, existing["id"],
                {
                    "name": name,
                    "description": description,
                    "platform_config": platform_config,
                    "source": "coze_import",
                    "icon_url": icon_url,
                },
                note="同步 Coze 工作流元信息",
            )
        return self.create_workflow(GLOBAL_WORKFLOW_PROJECT_ID, {
            "name": name,
            "description": description,
            "status": "active",
            "platform": "coze",
            "platform_config": platform_config,
            "params": list(wf_info.get("params") or []),
            "llm_config": wf_info.get("llm_config") or {},
            "source": "coze_import",
            "icon_url": icon_url,
        })

    # ---------- 存量迁移 ----------

    def migrate_from_work_manager(self, work_manager: Any) -> Dict[str, Any]:
        """把 work_manager 中 coze 工作流作品幂等迁移进全局池。"""
        works = work_manager.list_works() or []
        migrated = 0
        skipped = 0
        for work in works:
            if not isinstance(work, dict):
                skipped += 1
                continue
            coze_meta = work.get("coze_meta") or {}
            workflow_id = work.get("coze_workflow_id") or coze_meta.get("workflow_id")
            if coze_meta.get("type") != "workflow" or not workflow_id:
                skipped += 1
                continue
            existed = self._find_by_workflow_id(GLOBAL_WORKFLOW_PROJECT_ID, str(workflow_id))
            self.import_coze_workflow({
                "id": workflow_id,
                "name": work.get("name") or "",
                "description": work.get("description") or "",
                "icon_url": work.get("icon_url") or "",
            }, coze_meta.get("workspace_id") or "")
            if existed is None:
                migrated += 1
        return {"migrated": migrated, "skipped": skipped, "total": len(works)}

    # ---------- 内部 ----------

    def _find_by_workflow_id(self, project_id: str, workflow_id: str) -> Optional[Dict[str, Any]]:
        for wf in self.store.list_workflows(project_id):
            if (wf.get("platform_config") or {}).get("workflow_id") == workflow_id:
                return wf
        return None
