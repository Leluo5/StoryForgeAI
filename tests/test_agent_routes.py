# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask

from modules.agent_management.agent_service import AgentService
from modules.agent_management.agent_store import AgentStore
from modules.agent_management.routes import create_blueprint
from modules.novel_creation.flow_progress_store import FlowProgressStore
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
    progress = FlowProgressStore(str(tmp_path / "flows"))
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(service, progress))
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    return app.test_client(), service, project_store, role_store, project


def test_agent_crud_and_lifecycle(env):
    client, _, _, _, project = env
    created = client.post("/api/agents", json={
        "project_id": project["id"], "kind": "role_agent",
        "name": "自定义角色Agent", "role_id": "r1",
    })
    assert created.status_code == 200
    agent = created.get_json()["data"]
    aid = agent["id"]

    listed = client.get(f"/api/agents?project_id={project['id']}&kind=role_agent")
    assert listed.get_json()["data"]["total"] == 1

    updated = client.put(f"/api/agents/{aid}?project_id={project['id']}", json={"name": "改名"})
    assert updated.get_json()["data"]["name"] == "改名"

    conflict = client.delete(f"/api/agents/{aid}?project_id={project['id']}")
    assert conflict.status_code == 409
    assert client.post(f"/api/agents/{aid}/archive?project_id={project['id']}").status_code == 200
    assert client.delete(f"/api/agents/{aid}?project_id={project['id']}").status_code == 200


def test_groups_and_tool_switch(env):
    client, service, _, _, project = env
    tree = client.get(f"/api/agents/groups?project_id={project['id']}").get_json()["data"]
    assert tree["key"] == f"project:{project['id']}"

    tools = client.get(f"/api/agents/tools?project_id={project['id']}").get_json()["data"]
    tool_name = tools[0]["tool_name"]
    new_agent = service.store.create_agent(project["id"], {
        "project_id": project["id"], "kind": "tool_agent",
        "name": "候选B", "tool_name": tool_name,
    })
    switched = client.post(f"/api/agents/tools/{tool_name}/switch", json={
        "project_id": project["id"], "agent_id": new_agent["id"],
    })
    assert switched.get_json()["data"]["is_default"] is True


def test_role_reset_default_and_progress(env):
    client, _, _, role_store, project = env
    role = role_store.create_role(project["id"], "林远")
    reset = client.post(f"/api/roles/{role['id']}/agents/reset-default", json={"mode": "fill"})
    assert reset.status_code == 200
    assert len(role_store.get_bindings(project["id"], role["id"])) == 11

    progress = client.get(f"/api/roles/{role['id']}/flow-progress")
    assert progress.get_json()["data"]["status"] == "idle"
    reset_progress = client.post(f"/api/roles/{role['id']}/flow-progress/reset")
    assert reset_progress.status_code == 200


def test_provision_and_migration_endpoints(env):
    client, service, project_store, _, project = env
    provision = client.post(f"/api/agents/projects/{project['id']}/provision")
    assert provision.status_code == 200
    migration = client.post("/api/agents/migrations/role-bindings", json={"dry_run": True})
    assert migration.status_code == 200
    assert migration.get_json()["data"]["dry_run"] is True
