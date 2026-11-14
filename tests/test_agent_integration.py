# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask

from modules.novel_creation.project_store import ProjectStore
from modules.novel_creation.role_store import RoleStore
from modules.novel_creation.routes import create_blueprint
from modules.agent_management.agent_service import AgentService
from modules.agent_management.agent_store import AgentStore


TEMPLATE = [
    {"step_order": i, "name": f"步骤{i}", "platform": "coze",
     "platform_config": {"bot_id": f"bot-{i}"}, "model_config": {}}
    for i in range(1, 12)
]


class _Scheduler:
    def invoke_role_agents(self, *args, **kwargs):
        return {}


class _FlowEngine:
    def trigger_step(self, *args, **kwargs):
        return {}


class _Registry:
    def list_tools(self):
        return []

    def get(self, tool):
        return None


def test_create_project_calls_provisioner(tmp_path):
    calls = []
    project_store = ProjectStore(str(tmp_path / "projects"))
    role_store = RoleStore(str(tmp_path / "projects"))
    bp = create_blueprint(
        role_store, project_store, _Scheduler(), _FlowEngine(),
        tool_registry=_Registry(), project_provisioner=lambda project: calls.append(project["id"]),
    )
    app = Flask(__name__)
    app.register_blueprint(bp)
    resp = app.test_client().post("/api/projects", json={"title": "新作品"})
    assert resp.status_code == 200
    assert calls == [resp.get_json()["data"]["id"]]


def test_create_role_triggers_default_binding_hook(tmp_path):
    project_store = ProjectStore(str(tmp_path / "projects"))
    role_store = RoleStore(str(tmp_path / "projects"))
    bound = []
    role_store.set_lifecycle_hooks(on_create=lambda pid, rid: bound.append((pid, rid)))
    bp = create_blueprint(role_store, project_store, _Scheduler(), _FlowEngine(),
                          tool_registry=_Registry())
    app = Flask(__name__)
    app.register_blueprint(bp)
    project = project_store.create_project("新作品")
    resp = app.test_client().post(f"/api/projects/{project['id']}/roles", json={"name": "林远"})
    assert resp.status_code == 200
    assert bound == [(project["id"], resp.get_json()["data"]["id"])]


def test_project_and_role_end_to_end_auto_provision(tmp_path):
    """核心场景：建作品生成 11 步 Agent，建角色自动绑定 11 条。"""
    project_store = ProjectStore(str(tmp_path / "projects"))
    role_store = RoleStore(str(tmp_path / "projects"))
    store = AgentStore(str(tmp_path / "agents"))
    service = AgentService(store, project_store, role_store, flow_template=TEMPLATE)
    role_store.set_lifecycle_hooks(on_create=service.bind_role_default_flow)
    bp = create_blueprint(
        role_store, project_store, _Scheduler(), _FlowEngine(),
        tool_registry=_Registry(), project_provisioner=service.provision_project_defaults,
    )
    app = Flask(__name__)
    app.register_blueprint(bp)
    client = app.test_client()

    created = client.post("/api/projects", json={"title": "端到端作品"}).get_json()["data"]
    agents = store.list_agents(created["id"])
    assert len([a for a in agents if a["kind"] == "flow_step_agent"]) == 11

    role = client.post(f"/api/projects/{created['id']}/roles",
                       json={"name": "林远"}).get_json()["data"]
    bindings = role_store.get_bindings(created["id"], role["id"])
    assert len(bindings) == 11
    assert all(b["agent_ref_id"] for b in bindings)
