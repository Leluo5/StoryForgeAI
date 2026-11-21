# -*- coding: utf-8 -*-
"""工作流管理 WorkflowService 测试：Coze 导入幂等 + 存量迁移。"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules.workflow_management.workflow_service import WorkflowService
from modules.workflow_management.workflow_store import WorkflowStore


@pytest.fixture()
def svc(tmp_path):
    store = WorkflowStore(str(tmp_path / "workflows"))
    return WorkflowService(store), store


def test_import_coze_workflow_creates_global(svc):
    service, store = svc
    wf = service.import_coze_workflow({
        "id": "wf-001", "name": "章节生成", "description": "生成章节",
    }, "workspace-1")
    assert wf["project_id"] == "_global"
    assert wf["status"] == "active"
    assert wf["source"] == "coze_import"
    assert wf["platform_config"] == {"workflow_id": "wf-001", "workspace_id": "workspace-1"}
    assert "pat_token" not in wf


def test_import_coze_workflow_is_idempotent(svc):
    service, store = svc
    first = service.import_coze_workflow({"id": "wf-001", "name": "A"}, "ws")
    second = service.import_coze_workflow({"id": "wf-001", "name": "B"}, "ws")
    items = store.list_workflows("_global")
    assert len(items) == 1
    assert second["id"] == first["id"]
    assert second["name"] == "B"
    assert second["version_no"] == 2


def test_import_coze_workflow_missing_id(svc):
    service, _ = svc
    with pytest.raises(AppError) as ei:
        service.import_coze_workflow({"name": "无 id"}, "ws")
    assert ei.value.code == 400


class _FakeWorkManager:
    def __init__(self, works):
        self.works = works

    def list_works(self):
        return self.works


def test_migrate_only_workflow_type_and_idempotent(svc):
    service, store = svc
    wm = _FakeWorkManager([
        {"id": "w1", "name": "章节流", "coze_workflow_id": "wf-1",
         "coze_meta": {"type": "workflow"}},
        {"id": "w2", "name": "Bot作品", "coze_bot_id": "b1",
         "coze_meta": {"type": "bot"}},
        {"id": "w3", "name": "无meta", "coze_workflow_id": ""},
    ])
    result = service.migrate_from_work_manager(wm)
    assert result["migrated"] == 1
    assert result["skipped"] == 2
    assert result["total"] == 3

    # 幂等：再次迁移不新增
    again = service.migrate_from_work_manager(wm)
    assert again["migrated"] == 0
    assert len(store.list_workflows("_global")) == 1
