# -*- coding: utf-8 -*-
"""modules/novel_creation/routes.py 补测（P5-T1：覆盖率补测）。

独立 Flask app + 真实 RoleStore/ProjectStore（临时目录）+
mock scheduler/flow_engine/import_engine/tool_registry，覆盖：
- 2.1/2.2/2.3 项目/章节接口（含 400/403/404）
- 3.1/3.2/3.3/3.4/3.5 角色/绑定接口（含 400/404/409）
- 2.4 多角色协同（含 400/404/409）
- 4.1 工具调用（同步/长任务/未注册/角色联动/失败审计）
- §5 知识库角色同步导入（含 400）
"""

import os
import sys
import tempfile
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from flask import Flask, jsonify  # noqa: E402

from modules.common.errors import AppError  # noqa: E402
from modules.novel_creation.project_store import ProjectStore  # noqa: E402
from modules.novel_creation.role_store import RoleStore  # noqa: E402
from modules.novel_creation.routes import create_blueprint  # noqa: E402


@pytest.fixture()
def env(tmp_path):
    role_store = RoleStore(str(tmp_path / "projects"))
    project_store = ProjectStore(str(tmp_path / "projects"))
    scheduler = SimpleNamespace(
        invoke_role_agents=lambda pid, rid, so, ctx: {"role_id": rid, "step": so, **ctx},
    )
    flow_engine = SimpleNamespace(
        trigger_step=lambda pid, rid, so, ctx: {"role_id": rid, "step": so, **ctx},
    )
    import_engine = SimpleNamespace(
        list_candidate_roles=lambda pid, keyword=None: [{"entry_id": "e1", "name": "甲"}],
        import_roles=lambda pid, cands, preview=False: {"total": 1, "success": 1},
        get_import_history=lambda pid: [{"ts": "2026-01-01"}],
    )

    class _Reg:
        def get(self, tool):
            if tool == "gen_idea":
                return SimpleNamespace(
                    role_link=True, long_task=False,
                    handler=lambda params, ctx: {"idea": params.get("n", 1)},
                )
            if tool == "gen_novel":
                return SimpleNamespace(
                    role_link=False, long_task=True,
                    handler=lambda params, ctx: {"queued": True},
                )
            if tool == "fail_tool":
                return SimpleNamespace(
                    role_link=False, long_task=False,
                    handler=lambda params, ctx: (_ for _ in ()).throw(RuntimeError("boom")),
                )
            return None

    tool_registry = _Reg()

    bp = create_blueprint(
        role_store, project_store, scheduler, flow_engine,
        tool_registry=tool_registry, import_engine=import_engine,
    )
    app = Flask(__name__)
    app.register_blueprint(bp)

    @app.errorhandler(Exception)
    def _on_error(e):
        if isinstance(e, AppError):
            return jsonify({"code": e.status_code, "data": None, "message": str(e)}), e.status_code
        # 非 AppError（如 RuntimeError）统一 500，匹配应用层错误处理器
        return jsonify({"code": 500, "data": None, "message": "服务器内部错误"}), 500

    app.config["TESTING"] = True
    return SimpleNamespace(
        client=app.test_client(),
        role_store=role_store,
        project_store=project_store,
    )


def _mk_project(env, title="测试项目"):
    r = env.client.post("/api/projects", json={"title": title})
    assert r.status_code == 200
    return r.get_json()["data"]["id"]


def _mk_role(env, pid, name="林风眠"):
    r = env.client.post(f"/api/projects/{pid}/roles", json={"name": name})
    assert r.status_code == 200
    return r.get_json()["data"]["id"]


# ---------- 2.1 创建项目 ----------

class TestCreateProject:
    def test_ok(self, env):
        r = env.client.post("/api/projects", json={"title": "书名", "genre": "玄幻"})
        assert r.status_code == 200
        d = r.get_json()["data"]
        assert d["title"] == "书名"
        assert d["current_step"] == 1

    def test_missing_title(self, env):
        r = env.client.post("/api/projects", json={})
        assert r.status_code == 400

    def test_blank_title(self, env):
        r = env.client.post("/api/projects", json={"title": "   "})
        assert r.status_code == 400


# ---------- 2.2 列出项目 ----------

class TestListProjects:
    def test_empty(self, env):
        r = env.client.get("/api/projects")
        assert r.status_code == 200
        assert r.get_json()["data"]["total"] == 0

    def test_pagination(self, env):
        _mk_project(env, "A")
        _mk_project(env, "B")
        r = env.client.get("/api/projects?page=1&page_size=1")
        d = r.get_json()["data"]
        assert d["total"] == 2
        assert len(d["items"]) == 1

    def test_invalid_page(self, env):
        r = env.client.get("/api/projects?page=abc")
        assert r.status_code == 400


# ---------- 2.3 生成章节 ----------

class TestCreateChapter:
    def test_ok(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/chapters",
                            json={"title": "第一章", "content": "正文"})
        assert r.status_code == 200
        # 首个章节 order 从 0 开始（max 空默认 -1 + 1）
        assert r.get_json()["data"]["order"] == 0

    def test_missing_content(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/chapters", json={"title": "x"})
        assert r.status_code == 400

    def test_project_404(self, env):
        r = env.client.post("/api/projects/nope/chapters",
                            json={"content": "正文"})
        assert r.status_code == 404

    def test_role_not_in_project(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/chapters",
                            json={"content": "正文", "author_role_id": "other"})
        assert r.status_code == 403


# ---------- 3.1 创建角色 ----------

class TestCreateRole:
    def test_ok(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/roles", json={"name": "苏晚", "age": 22})
        assert r.status_code == 200
        assert r.get_json()["data"]["name"] == "苏晚"

    def test_missing_name(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/roles", json={})
        assert r.status_code == 400

    def test_project_404(self, env):
        r = env.client.post("/api/projects/nope/roles", json={"name": "x"})
        assert r.status_code == 404


# ---------- 3.2 绑定角色 Agent ----------

class TestBindAgent:
    def test_ok(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        r = env.client.post(f"/api/roles/{rid}/agents",
                            json={"agent_id": "a1", "step_order": 3})
        assert r.status_code == 200
        assert r.get_json()["data"]["step_order"] == 3

    def test_role_404(self, env):
        r = env.client.post("/api/roles/nope/agents",
                            json={"agent_id": "a1", "step_order": 3})
        assert r.status_code == 404

    def test_missing_agent(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        r = env.client.post(f"/api/roles/{rid}/agents", json={"step_order": 3})
        assert r.status_code == 400

    def test_invalid_step(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        r = env.client.post(f"/api/roles/{rid}/agents",
                            json={"agent_id": "a1", "step_order": 99})
        assert r.status_code == 400

    def test_duplicate_step(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        env.client.post(f"/api/roles/{rid}/agents",
                        json={"agent_id": "a1", "step_order": 3})
        r = env.client.post(f"/api/roles/{rid}/agents",
                            json={"agent_id": "a2", "step_order": 3})
        assert r.status_code == 400


# ---------- 3.3 更新绑定 ----------

class TestUpdateAgent:
    def test_ok(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        bid = env.client.post(f"/api/roles/{rid}/agents",
                              json={"agent_id": "a1", "step_order": 3}).get_json()["data"]["binding_id"]
        r = env.client.put(f"/api/roles/{rid}/agents/{bid}", json={"enabled": False})
        assert r.status_code == 200
        assert r.get_json()["data"]["enabled"] is False

    def test_no_updates(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        bid = env.client.post(f"/api/roles/{rid}/agents",
                              json={"agent_id": "a1", "step_order": 3}).get_json()["data"]["binding_id"]
        r = env.client.put(f"/api/roles/{rid}/agents/{bid}", json={"foo": 1})
        assert r.status_code == 400

    def test_invalid_step(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        bid = env.client.post(f"/api/roles/{rid}/agents",
                              json={"agent_id": "a1", "step_order": 3}).get_json()["data"]["binding_id"]
        r = env.client.put(f"/api/roles/{rid}/agents/{bid}", json={"step_order": 99})
        assert r.status_code == 400

    def test_invalid_enabled(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        bid = env.client.post(f"/api/roles/{rid}/agents",
                              json={"agent_id": "a1", "step_order": 3}).get_json()["data"]["binding_id"]
        r = env.client.put(f"/api/roles/{rid}/agents/{bid}", json={"enabled": "yes"})
        assert r.status_code == 400

    def test_binding_404(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        r = env.client.put(f"/api/roles/{rid}/agents/nope", json={"enabled": False})
        assert r.status_code == 404


# ---------- 3.4 按预设流程调用 ----------

class TestInvokeAgent:
    def test_ok(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        env.client.post(f"/api/roles/{rid}/agents",
                        json={"agent_id": "a1", "step_order": 3})
        r = env.client.post(f"/api/roles/{rid}/agents/invoke",
                            json={"step_order": 3, "context": {"k": "v"}})
        assert r.status_code == 200
        assert r.get_json()["data"]["merged_context"]["k"] == "v"

    def test_invalid_step(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        r = env.client.post(f"/api/roles/{rid}/agents/invoke", json={"step_order": 99})
        assert r.status_code == 400

    def test_context_not_dict(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        r = env.client.post(f"/api/roles/{rid}/agents/invoke",
                            json={"step_order": 1, "context": "x"})
        assert r.status_code == 400

    def test_no_hit_409(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        r = env.client.post(f"/api/roles/{rid}/agents/invoke", json={"step_order": 1})
        assert r.status_code == 409

    def test_role_404(self, env):
        r = env.client.post("/api/roles/nope/agents/invoke", json={"step_order": 1})
        assert r.status_code == 404


# ---------- 3.5 列出角色 Agent ----------

class TestListAgents:
    def test_ok_all(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        env.client.post(f"/api/roles/{rid}/agents", json={"agent_id": "a1", "step_order": 3})
        r = env.client.get(f"/api/roles/{rid}/agents")
        assert r.status_code == 200
        assert len(r.get_json()["data"]["bindings"]) == 1

    def test_filter_true(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        env.client.post(f"/api/roles/{rid}/agents", json={"agent_id": "a1", "step_order": 3})
        r = env.client.get(f"/api/roles/{rid}/agents?enabled=true")
        assert len(r.get_json()["data"]["bindings"]) == 1

    def test_filter_invalid(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        r = env.client.get(f"/api/roles/{rid}/agents?enabled=yes")
        assert r.status_code == 400

    def test_role_404(self, env):
        r = env.client.get("/api/roles/nope/agents")
        assert r.status_code == 404


# ---------- 2.4 多角色协同 ----------

class TestCollab:
    def test_ok(self, env):
        pid = _mk_project(env)
        env.project_store.set_collab_enabled(pid, True)
        r1 = _mk_role(env, pid, "甲")
        r2 = _mk_role(env, pid, "乙")
        r = env.client.post(f"/api/projects/{pid}/collab",
                            json={"roles": [r1, r2], "step_order": 3})
        assert r.status_code == 200
        d = r.get_json()["data"]
        assert "merged_context" in d
        assert "conflicts" in d

    def test_empty_roles(self, env):
        pid = _mk_project(env)
        env.project_store.set_collab_enabled(pid, True)
        r = env.client.post(f"/api/projects/{pid}/collab",
                            json={"roles": [], "step_order": 3})
        assert r.status_code == 400

    def test_non_string_role(self, env):
        pid = _mk_project(env)
        env.project_store.set_collab_enabled(pid, True)
        r = env.client.post(f"/api/projects/{pid}/collab",
                            json={"roles": [123], "step_order": 3})
        assert r.status_code == 400

    def test_collab_disabled_409(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/collab",
                            json={"roles": ["r"], "step_order": 3})
        assert r.status_code == 409

    def test_project_404(self, env):
        # 项目不存在：路由内 get_project 抛 404（不预先 set_collab_enabled）
        r = env.client.post("/api/projects/nope/collab",
                            json={"roles": ["r"], "step_order": 3})
        assert r.status_code == 404

    def test_role_404(self, env):
        pid = _mk_project(env)
        env.project_store.set_collab_enabled(pid, True)
        r = env.client.post(f"/api/projects/{pid}/collab",
                            json={"roles": ["nope"], "step_order": 3})
        assert r.status_code == 404


# ---------- 4.1 调用写作工具 ----------

class TestInvokeTool:
    def test_sync_ok(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/tools/gen_idea",
                            json={"params": {"n": 3}})
        assert r.status_code == 200
        assert r.get_json()["data"]["result"]["idea"] == 3

    def test_unregistered(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/tools/nope", json={})
        assert r.status_code == 404

    def test_project_404(self, env):
        r = env.client.post("/api/projects/nope/tools/gen_idea", json={})
        assert r.status_code == 404

    def test_long_task(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/tools/gen_novel", json={})
        assert r.status_code == 200
        d = r.get_json()["data"]
        assert d["status"] == "queued"
        assert d["task_id"]

    def test_role_link(self, env):
        pid = _mk_project(env)
        rid = _mk_role(env, pid)
        r = env.client.post(f"/api/projects/{pid}/tools/gen_idea",
                            json={"params": {}, "role_id": rid})
        assert r.status_code == 200

    def test_role_404(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/tools/gen_idea",
                            json={"params": {}, "role_id": "nope"})
        assert r.status_code == 404

    def test_failed_audit(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/tools/fail_tool", json={})
        assert r.status_code == 500

    def test_params_not_dict(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/tools/gen_idea",
                            json={"params": "x"})
        assert r.status_code == 400

    def test_role_id_not_str(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/tools/gen_idea",
                            json={"role_id": 5})
        assert r.status_code == 400


# ---------- §5 知识库角色同步导入 ----------

class TestKbRoles:
    def test_candidates(self, env):
        pid = _mk_project(env)
        r = env.client.get(f"/api/projects/{pid}/kb-roles/candidates")
        assert r.status_code == 200
        assert r.get_json()["data"]["items"][0]["name"] == "甲"

    def test_candidates_keyword(self, env):
        pid = _mk_project(env)
        r = env.client.get(f"/api/projects/{pid}/kb-roles/candidates?keyword=剑")
        assert r.status_code == 200

    def test_import_preview(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/kb-roles/import",
                            json={"candidates": [{"name": "甲"}], "preview": True})
        assert r.status_code == 200

    def test_import_not_list(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/kb-roles/import",
                            json={"candidates": "x"})
        assert r.status_code == 400

    def test_import_preview_not_bool(self, env):
        pid = _mk_project(env)
        r = env.client.post(f"/api/projects/{pid}/kb-roles/import",
                            json={"candidates": [{"name": "甲"}], "preview": "yes"})
        assert r.status_code == 400

    def test_history(self, env):
        pid = _mk_project(env)
        r = env.client.get(f"/api/projects/{pid}/kb-roles/history")
        assert r.status_code == 200
        assert len(r.get_json()["data"]["items"]) == 1
