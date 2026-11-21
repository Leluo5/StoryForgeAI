# -*- coding: utf-8 -*-
"""工作流管理 WorkflowStore CRUD 测试（tmp_path 隔离）。"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules.workflow_management.workflow_store import WorkflowStore


@pytest.fixture()
def store(tmp_path):
    return WorkflowStore(str(tmp_path / "workflows"))


def _payload(**over):
    base = {
        "name": "章节生成工作流",
        "description": "根据大纲生成章节",
        "platform": "coze",
        "platform_config": {"workflow_id": "wf-001", "workspace_id": "ws-1"},
        "params": [],
        "llm_config": {"base_url": "", "api_key": "", "model": "gpt"},
    }
    base.update(over)
    return base


def test_create_and_get(store):
    wf = store.create_workflow("_global", _payload())
    assert wf["project_id"] == "_global"
    assert wf["status"] == "active"
    assert wf["source"] == "manual"
    assert wf["version_no"] == 1
    assert wf["platform_config"]["workflow_id"] == "wf-001"
    assert "versions" in wf and len(wf["versions"]) == 1  # create 返回版本快照

    got = store.get_workflow("_global", wf["id"])
    assert got["id"] == wf["id"]
    assert got["name"] == "章节生成工作流"
    assert "versions" not in got  # 默认剥离

    listed = store.list_workflows("_global")[0]
    assert "versions" not in listed


def test_create_requires_name(store):
    with pytest.raises(AppError) as ei:
        store.create_workflow("_global", _payload(name=""))
    assert ei.value.code == 400


def test_create_unique_workflow_id_conflict(store):
    store.create_workflow("_global", _payload())
    with pytest.raises(AppError) as ei:
        store.create_workflow("_global", _payload(name="另一个", platform_config={
            "workflow_id": "wf-001", "workspace_id": "ws-1"}))
    assert ei.value.code == 409


def test_list_filters_status_and_keyword(store):
    a = store.create_workflow("_global", _payload(name="章节生成", platform_config={
        "workflow_id": "wf-a", "workspace_id": "ws-1"}))
    b = store.create_workflow("_global", _payload(name="角色图谱", platform_config={
        "workflow_id": "wf-b", "workspace_id": "ws-1"}))
    store.set_status("_global", a["id"], "disabled")

    all_items = store.list_workflows("_global")
    assert len(all_items) == 2

    disabled = store.list_workflows("_global", status="disabled")
    assert [w["id"] for w in disabled] == [a["id"]]

    by_keyword = store.list_workflows("_global", keyword="图谱")
    assert [w["id"] for w in by_keyword] == [b["id"]]


def test_update_whitelist_and_bump_version(store):
    wf = store.create_workflow("_global", _payload())
    updated = store.update_workflow("_global", wf["id"],
                                    {"name": "改名", "description": "新描述"})
    assert updated["name"] == "改名"
    assert updated["version_no"] == 2


def test_update_rejects_illegal_field(store):
    wf = store.create_workflow("_global", _payload())
    with pytest.raises(AppError) as ei:
        store.update_workflow("_global", wf["id"], {"pat_token": "secret"})
    assert ei.value.code == 400


def test_set_status_active_disabled(store):
    wf = store.create_workflow("_global", _payload())
    disabled = store.set_status("_global", wf["id"], "disabled")
    assert disabled["status"] == "disabled"
    active = store.set_status("_global", wf["id"], "active")
    assert active["status"] == "active"


def test_archive_restore_delete(store):
    wf = store.create_workflow("_global", _payload())
    archived = store.archive_workflow("_global", wf["id"])
    assert archived["status"] == "archived"
    assert archived["archived_at"]

    # 已归档可直接删除
    assert store.delete_workflow("_global", wf["id"]) is True
    with pytest.raises(AppError) as ei:
        store.get_workflow("_global", wf["id"])
    assert ei.value.code == 404


def test_delete_unarchived_requires_force(store):
    wf = store.create_workflow("_global", _payload())
    # 未归档 force=False 删除抛 409
    with pytest.raises(AppError) as ei:
        store.delete_workflow("_global", wf["id"])
    assert ei.value.code == 409

    # force=True 可强制删除
    assert store.delete_workflow("_global", wf["id"], force=True) is True
    with pytest.raises(AppError) as ei:
        store.get_workflow("_global", wf["id"])
    assert ei.value.code == 404


def test_restore_workflow_reactivates(store):
    wf = store.create_workflow("_global", _payload())
    store.archive_workflow("_global", wf["id"])
    restored = store.restore_workflow("_global", wf["id"])
    assert restored["status"] == "active"
    assert restored["archived_at"] is None


def test_get_workflow_not_found(store):
    with pytest.raises(AppError) as ei:
        store.get_workflow("_global", "nope")
    assert ei.value.code == 404


def test_versions_and_rollback(store):
    wf = store.create_workflow("_global", _payload())
    store.update_workflow("_global", wf["id"], {"name": "版本2"})
    versions = store.get_versions("_global", wf["id"])
    assert len(versions) == 2

    rolled = store.rollback("_global", wf["id"], 1)
    assert rolled["name"] == "章节生成工作流"
    assert rolled["version_no"] == 3


def test_version_cap_at_50(store):
    wf = store.create_workflow("_global", _payload())
    for i in range(60):
        store.update_workflow("_global", wf["id"], {"name": f"v{i}"})
    versions = store.get_versions("_global", wf["id"])
    assert len(versions) <= 50
