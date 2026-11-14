# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.agent_management.agent_service import AgentService
from modules.agent_management.agent_store import AgentStore
from modules.novel_creation.project_store import ProjectStore
from modules.novel_creation.role_store import RoleStore


class _Registry:
    def list_tools(self):
        return [{"name": "gen_outline"}]


TEMPLATE = [
    {"step_order": i, "name": f"步骤{i}", "platform": "coze",
     "platform_config": {"bot_id": f"bot-{i}"}, "model_config": {}}
    for i in range(1, 12)
]


@pytest.fixture()
def env(tmp_path):
    data = tmp_path / "projects"
    store = AgentStore(str(tmp_path / "agents"))
    project_store = ProjectStore(str(data))
    role_store = RoleStore(str(data))
    service = AgentService(store, project_store, role_store,
                           tool_registry=_Registry(), flow_template=TEMPLATE)
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    return service, store, project_store, role_store, project


def _tool_agents(store, project_id):
    return [a for a in store.list_agents(project_id) if a["kind"] == "tool_agent"]


def test_switch_tool_default_is_exclusive(env):
    service, store, _, _, project = env
    agents = _tool_agents(store, project["id"])
    old = next(a for a in agents if a["is_default"])
    new = store.create_agent(project["id"], {
        "project_id": project["id"], "kind": "tool_agent",
        "name": "候选B", "tool_name": "gen_outline",
    })
    switched = service.switch_tool_default(project["id"], "gen_outline", new["id"])
    assert switched["is_default"] is True
    assert store.get_agent(project["id"], old["id"])["is_default"] is False
    assert service.resolve_default_tool_agent(project["id"], "gen_outline")["id"] == new["id"]


def test_migrate_role_bindings_dry_run_then_write(env):
    service, store, project_store, role_store, project = env
    role = role_store.create_role(project["id"], "林远")
    legacy = role_store.create_binding(project["id"], role["id"], "legacy-bot", step_order=1)

    dry = service.migrate_role_bindings(project_store.data_dir, dry_run=True)
    assert dry["migrated"] == 1
    assert dry["created_agents"] == 1
    assert role_store.get_bindings(project["id"], role["id"])[0].get("agent_ref_id") is None

    done = service.migrate_role_bindings(project_store.data_dir, dry_run=False)
    assert done["migrated"] == 1
    bindings = role_store.get_bindings(project["id"], role["id"])
    migrated = next(b for b in bindings if b["id"] == legacy["id"])
    assert migrated["agent_ref_id"]
    assert store.get_agent(project["id"], migrated["agent_ref_id"])["kind"] == "role_agent"

    again = service.migrate_role_bindings(project_store.data_dir, dry_run=False)
    assert again["migrated"] == 0
    assert again["skipped"] >= 1
