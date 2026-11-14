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
        return [{"name": "gen_outline", "role_link": True},
                {"name": "gen_chapter", "role_link": True}]


TEMPLATE = [
    {"step_order": i, "name": f"步骤{i}", "desc": f"描述{i}", "platform": "coze",
     "platform_config": {"bot_id": f"bot-{i}"}, "model_config": {"model": "m1"}}
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
    return service, store, project_store, role_store


def test_provision_creates_11_flow_and_tool_agents(env):
    service, store, project_store, _ = env
    project = project_store.create_project("测试作品")
    result = service.provision_project_defaults(project)
    assert len(result["created"]["flow_agents"]) == 11
    assert len(result["created"]["tool_agents"]) == 2
    agents = store.list_agents(project["id"])
    assert len([a for a in agents if a["kind"] == "flow_step_agent"]) == 11
    assert len([a for a in agents if a["kind"] == "tool_agent"]) == 2
    assert sum(1 for a in agents if a["kind"] == "tool_agent" and a["is_default"]) == 2


def test_provision_is_idempotent(env):
    service, store, project_store, _ = env
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    second = service.provision_project_defaults(project)
    assert second["created"]["flow_agents"] == []
    assert second["created"]["tool_agents"] == []
    assert len(store.list_agents(project["id"])) == 13


def test_bind_role_default_flow_creates_11_bindings(env):
    service, store, project_store, role_store = env
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    role = role_store.create_role(project["id"], "林远")
    created = service.bind_role_default_flow(project["id"], role["id"])
    assert len(created) == 11
    bindings = role_store.get_bindings(project["id"], role["id"])
    assert [b["step_order"] for b in bindings] == list(range(1, 12))
    assert all(b["agent_ref_id"] for b in bindings)
    assert all(b["agent_id"].startswith("bot-") for b in bindings)


def test_bind_does_not_overwrite_custom_step(env):
    service, store, project_store, role_store = env
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    role = role_store.create_role(project["id"], "林远")
    service.bind_role_default_flow(project["id"], role["id"])
    binding = role_store.get_bindings(project["id"], role["id"])[0]
    custom = store.create_agent(project["id"], {
        "project_id": project["id"], "kind": "role_agent",
        "name": "自定义", "role_id": role["id"],
    })
    role_store.update_binding(project["id"], binding["id"], agent_ref_id=custom["id"])
    service.bind_role_default_flow(project["id"], role["id"])
    again = role_store.get_bindings(project["id"], role["id"])[0]
    assert again["agent_ref_id"] == custom["id"]
