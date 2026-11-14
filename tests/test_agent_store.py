# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.agent_management.agent_store import AgentStore
from modules.common.errors import AppError


@pytest.fixture()
def store(tmp_path):
    return AgentStore(str(tmp_path / "agents"))


def _payload(**overrides):
    data = {
        "project_id": "p1", "kind": "role_agent", "name": "角色甲",
        "role_id": "r1", "platform": "coze",
        "platform_config": {"bot_id": "bot-1", "workspace_id": ""},
        "model_config": {"temperature": 0.5},
    }
    data.update(overrides)
    return data


def test_create_read_update_delete(store):
    agent = store.create_agent("p1", _payload())
    assert agent["id"]
    assert agent["status"] == "active"
    assert agent["model_config"]["temperature"] == 0.5
    assert agent["version_no"] == 1
    assert len(agent["versions"]) == 1

    got = store.get_agent("p1", agent["id"])
    assert got["name"] == "角色甲"
    assert "versions" not in got

    updated = store.update_agent("p1", agent["id"], {"name": "角色乙"}, note="改名")
    assert updated["name"] == "角色乙"
    assert updated["version_no"] == 2
    assert len(store.get_agent("p1", agent["id"], include_versions=True)["versions"]) == 2

    assert store.delete_agent("p1", agent["id"], force=True) is True
    with pytest.raises(AppError):
        store.get_agent("p1", agent["id"])


def test_archive_restore_and_delete_requires_archive(store):
    agent = store.create_agent("p1", _payload())
    with pytest.raises(AppError) as ei:
        store.delete_agent("p1", agent["id"])
    assert ei.value.code == 409

    archived = store.archive_agent("p1", agent["id"])
    assert archived["status"] == "archived"
    assert archived["archived_at"]

    restored = store.restore_agent("p1", agent["id"])
    assert restored["status"] == "active"
    assert restored["archived_at"] is None


def test_version_limit_trims_oldest(store):
    agent = store.create_agent("p1", _payload())
    for i in range(60):
        store.update_agent("p1", agent["id"], {"description": str(i)})
    versions = store.get_agent("p1", agent["id"], include_versions=True)["versions"]
    assert len(versions) == 50
    assert versions[-1]["snapshot"]["description"] == "59"


def test_credentials_never_persisted(store):
    agent = store.create_agent("p1", _payload(platform_config={"bot_id": "b", "token": "secret"}))
    raw = open(store._path("p1", agent["id"]), "r", encoding="utf-8").read()
    assert "secret" not in raw
    assert "token" not in agent["platform_config"]


def test_duplicate_flow_step_rejected(store):
    store.create_agent("p1", _payload(kind="flow_step_agent", role_id=None, step_order=1))
    with pytest.raises(AppError) as ei:
        store.create_agent("p1", _payload(kind="flow_step_agent", role_id=None, step_order=1))
    assert ei.value.code == 409
