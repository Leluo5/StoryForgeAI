# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.novel_creation.role_store import RoleStore


def test_binding_supports_agent_ref_id(tmp_path):
    store = RoleStore(str(tmp_path))
    role = store.create_role("p1", "林远")
    binding = store.create_binding(
        "p1", role["id"], "bot-1", step_order=1, agent_ref_id="agent-1",
        model="gpt-4o", agent_env="coze",
    )
    assert binding["agent_ref_id"] == "agent-1"
    updated = store.update_binding("p1", binding["id"], agent_ref_id="agent-2")
    assert updated["agent_ref_id"] == "agent-2"


def test_create_and_delete_role_trigger_hooks(tmp_path):
    store = RoleStore(str(tmp_path))
    created = []
    deleted = []
    store.set_lifecycle_hooks(
        on_create=lambda pid, rid: created.append((pid, rid)),
        on_delete=lambda pid, rid: deleted.append((pid, rid)),
    )
    role = store.create_role("p1", "林远")
    assert created == [("p1", role["id"])]
    store.delete_role("p1", role["id"])
    assert deleted == [("p1", role["id"])]


def test_hook_failure_does_not_block_role_creation(tmp_path):
    store = RoleStore(str(tmp_path))
    store.set_lifecycle_hooks(on_create=lambda pid, rid: (_ for _ in ()).throw(RuntimeError("boom")))
    role = store.create_role("p1", "林远")
    assert store.get_role("p1", role["id"])["name"] == "林远"
