# -*- coding: utf-8 -*-
"""app.py 补测（P5-T1：覆盖率补测）。

用 app.test_client() + monkeypatch 全局单例（work_manager/coze_client/config_loader），
覆盖：管理员登录/配置/Coze 测试/作品导入/列表/更新/删除、公开作品 API、
访问码验证、工作流执行等主路由。
"""

import io
import json
import os
import sys
import uuid
from unittest import mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_mod  # noqa: E402
from modules.novel_creation.agent_client import CozeAgentClient  # noqa: E402
from modules.novel_creation.model_router import ModelRouter  # noqa: E402
from modules.novel_creation.parallel_agent_executor import (  # noqa: E402
    ParallelAgentExecutor,
)
from modules.novel_creation.trae_agent_client import TraeAgentClient  # noqa: E402


def _work(wid="w1", **over):
    base = {
        "id": wid,
        "name": "测试作品",
        "description": "desc",
        "coze_bot_id": "b1",
        "pat_token": "pat",
        "access_code": "",
        "is_public": True,
        "interaction_type": "chat",
        "system_prompt": "sys",
        "parameters": [],
        "coze_meta": {},
        "created_at": "2026-01-01 00:00:00",
        "updated_at": "2026-01-01 00:00:00",
    }
    base.update(over)
    return base


class _FakeWorkManager:
    def __init__(self, works=None):
        self.works = works or [{"id": "w1", "name": "测试作品", "is_public": True,
                                "description": "d", "coze_meta": {}}]

    def list_works(self):
        return self.works

    def get_work(self, wid):
        for w in self.works:
            if w["id"] == wid:
                return _work(wid, **w)
        return None

    def get_work_public(self, wid):
        w = self.get_work(wid)
        return w

    def verify_access_code(self, wid, code):
        w = self.get_work(wid)
        return bool(w and (not w.get("access_code") or w["access_code"] == code))

    def import_from_coze(self, data, pat, access_code=""):
        return {"id": "new1", "name": data.get("name", "未命名")}

    def import_dataset(self, info, pat, access_code=""):
        return {"id": "new2", "name": info.get("name", "知识库")}

    def import_workflow(self, info, pat, ws, access_code=""):
        return {"id": "new3", "name": info.get("name", "工作流")}

    def update_work(self, wid, updates):
        return self.get_work(wid)

    def delete_work(self, wid):
        return True


class _FakeCozeClient:
    COZE_API_BASE = "http://fake"

    def __init__(self):
        self.pat_token = ""

    def test_connection(self, ws=""):
        return {"success": True, "total": 1}

    def get_all_resources(self, ws=""):
        return {"success": True, "total": 2, "bots": [{"id": "b1", "name": "b"}]}

    def get_bot_info(self, bid, is_published=True):
        return {"success": True, "data": {"name": "智能体", "bot_id": bid}}

    def get_dataset_list(self):
        return {"success": True, "items": [{"id": "d1", "name": "知识库1"}]}

    def get_workflow_list(self, ws=""):
        return {"success": True, "items": [{"id": "wf1", "name": "工作流1",
                                            "workflow_id": "wf1"}]}

    def chat(self, **kwargs):
        return {"success": True, "content": "回复", "conversation_id": "c1"}

    def run_workflow(self, wid, params=None, stream=False):
        return {"success": True, "data": "结果"}


@pytest.fixture()
def admin_token():
    # 会话结构升级（C-001/C-004）：value 为 {"role": str, "exp": float}
    import time as _t
    app_mod._admin_sessions["test_admin"] = {"role": "admin", "exp": _t.time() + 3600}
    return "test_admin"


def _auth(token):
    return {"X-Admin-Token": token}


@pytest.fixture()
def fake_wm(monkeypatch):
    wm = _FakeWorkManager()
    monkeypatch.setattr(app_mod, "work_manager", wm)
    return wm


@pytest.fixture()
def fake_cc(monkeypatch):
    cc = _FakeCozeClient()
    monkeypatch.setattr(app_mod, "coze_client", cc)
    return cc


@pytest.fixture()
def fake_cfg(monkeypatch):
    cfg = {"admin_password": "pbkdf2:sha256:1000$salt$hash", "site_name": "StoryForgeAI"}
    loader = mock.Mock()
    loader.load_global_config.return_value = cfg
    loader.update_global_config.side_effect = lambda u: {**cfg, **u}
    monkeypatch.setattr(app_mod, "config_loader", loader)
    return loader


# ---------- Agent 装配 ----------

def test_role_agent_scheduler_wires_agent_components():
    scheduler = app_mod._role_scheduler

    assert isinstance(scheduler.model_router, ModelRouter)
    assert scheduler.model_router._config_loader is app_mod.config_loader
    assert isinstance(scheduler.parallel_executor, ParallelAgentExecutor)
    assert isinstance(scheduler.clients["coze"], CozeAgentClient)
    assert scheduler.clients["coze"]._coze is app_mod.coze_client
    assert isinstance(scheduler.clients["trae"], TraeAgentClient)


def test_admin_page_exposes_global_agent_pool():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "templates", "index.html"), encoding="utf-8") as f:
        template = f.read()
    with open(os.path.join(root, "static", "js", "app.js"), encoding="utf-8") as f:
        script = f.read()

    assert 'data-tab="agents"' in template
    assert 'id="admin-agents-list"' in template
    assert "从 Coze 导入资源" in template
    assert "getGlobalAgents" in script
    assert "/api/agents?project_id=_global&kind=unclassified" in script
    assert "renderAdminAgents" in script


def test_admin_page_exposes_workflow_pool():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(root, "templates", "index.html"), encoding="utf-8") as f:
        template = f.read()
    with open(os.path.join(root, "static", "js", "app.js"), encoding="utf-8") as f:
        script = f.read()

    assert 'data-tab="workflows"' in template
    assert 'id="admin-workflows-list"' in template
    assert "getWorkflows" in script
    assert "/api/workflows?project_id=_global" in script
    assert "renderAdminWorkflows" in script


# ---------- 首页 ----------

class TestIndex:
    def test_index(self):
        r = app_mod.app.test_client().get("/")
        assert r.status_code in (200, 404)


# ---------- 管理员登录 ----------

class TestAdminLogin:
    def test_missing_password(self, fake_cfg):
        # 存储了非空密码，空输入 → 403
        fake_cfg.load_global_config.return_value = {"admin_password": "secret"}
        r = app_mod.app.test_client().post("/api/admin/login", json={"password": ""})
        assert r.status_code == 403

    def test_plain_password_ok(self, fake_cfg):
        fake_cfg.load_global_config.return_value = {"admin_password": "secret"}
        r = app_mod.app.test_client().post("/api/admin/login", json={"password": "secret"})
        assert r.status_code == 200
        assert r.get_json()["data"]["token"]

    def test_plain_password_wrong(self, fake_cfg):
        fake_cfg.load_global_config.return_value = {"admin_password": "secret"}
        r = app_mod.app.test_client().post("/api/admin/login", json={"password": "bad"})
        assert r.status_code == 403

    def test_hashed_password_wrong(self, fake_cfg):
        fake_cfg.load_global_config.return_value = {
            "admin_password": "scrypt:32768:8:1$salt$hash",
        }
        r = app_mod.app.test_client().post("/api/admin/login", json={"password": "bad"})
        assert r.status_code == 403


# ---------- 管理员配置 ----------

class TestAdminConfig:
    def test_get_unauthorized(self):
        r = app_mod.app.test_client().get("/api/admin/config")
        assert r.status_code == 401

    def test_get_ok(self, admin_token, fake_cfg):
        fake_cfg.load_global_config.return_value = {
            "version": "2.0.0", "site_name": "S", "theme": "light",
            "llm_config": {"base_url": "u", "api_key": "SECRET", "model": "m"},
        }
        r = app_mod.app.test_client().get("/api/admin/config", headers=_auth(admin_token))
        assert r.status_code == 200
        d = r.get_json()["data"]
        assert d["site_name"] == "S"
        # api_key 脱敏
        assert "api_key" not in d["llm_config"]

    def test_put_ok(self, admin_token, fake_cfg):
        r = app_mod.app.test_client().put(
            "/api/admin/config", json={"site_name": "新名", "bad_field": "x"},
            headers=_auth(admin_token))
        assert r.status_code == 200


# ---------- Coze 测试 ----------

class TestCozeTest:
    def test_missing_token(self, admin_token):
        r = app_mod.app.test_client().post("/api/admin/coze/test", json={},
                                           headers=_auth(admin_token))
        assert r.status_code == 400

    def test_ok(self, admin_token, fake_cc):
        r = app_mod.app.test_client().post("/api/admin/coze/test",
                                           json={"pat_token": "p", "workspace_id": "w"},
                                           headers=_auth(admin_token))
        assert r.status_code == 200


class TestCozeBots:
    def test_missing_token(self, admin_token):
        r = app_mod.app.test_client().post("/api/admin/coze/bots", json={},
                                           headers=_auth(admin_token))
        assert r.status_code == 400

    def test_ok(self, admin_token, fake_cc):
        r = app_mod.app.test_client().post("/api/admin/coze/bots",
                                           json={"pat_token": "p"},
                                           headers=_auth(admin_token))
        assert r.status_code == 200
        assert r.get_json()["data"]["total"] == 2


class TestCozeDatasets:
    def test_missing_token(self, admin_token):
        r = app_mod.app.test_client().post("/api/admin/coze/datasets", json={},
                                           headers=_auth(admin_token))
        assert r.status_code == 400

    def test_ok(self, admin_token, fake_cc):
        r = app_mod.app.test_client().post("/api/admin/coze/datasets",
                                           json={"pat_token": "p"},
                                           headers=_auth(admin_token))
        assert r.status_code == 200


class TestCozeWorkflows:
    def test_missing_token(self, admin_token):
        r = app_mod.app.test_client().post("/api/admin/coze/workflows", json={},
                                           headers=_auth(admin_token))
        assert r.status_code == 400

    def test_ok(self, admin_token, fake_cc):
        r = app_mod.app.test_client().post("/api/admin/coze/workflows",
                                           json={"pat_token": "p"},
                                           headers=_auth(admin_token))
        assert r.status_code == 200


# ---------- 作品导入 ----------

class TestImportWorks:
    def test_missing_token(self, admin_token):
        r = app_mod.app.test_client().post("/api/admin/works/import", json={},
                                           headers=_auth(admin_token))
        assert r.status_code == 400

    def test_no_bots(self, admin_token):
        r = app_mod.app.test_client().post("/api/admin/works/import",
                                           json={"pat_token": "p"},
                                           headers=_auth(admin_token))
        assert r.status_code == 400

    def test_bot_success(self, admin_token, fake_cc, fake_wm, monkeypatch):
        agent_service = mock.Mock()
        agent_service.import_coze_agent.return_value = {
            "id": "agent-1", "name": "小说角色塑造师",
        }
        monkeypatch.setattr(app_mod, "_agent_service", agent_service)
        fake_wm.import_from_coze = mock.Mock(return_value={"id": "new1", "name": "智能体"})

        r = app_mod.app.test_client().post("/api/admin/works/import",
                                           json={"pat_token": "p", "workspace_id": "ws1",
                                                 "bot_ids": [{"id": "b1", "name": "b"}]},
                                           headers=_auth(admin_token))
        assert r.status_code == 200
        data = r.get_json()["data"]
        assert data["imported"] == 1
        assert data["results"][0] == {
            "success": True, "agent_id": "agent-1",
            "name": "小说角色塑造师", "type": "bot",
        }
        agent_service.import_coze_agent.assert_called_once_with(
            {"name": "智能体", "bot_id": "b1"}, "ws1")
        fake_wm.import_from_coze.assert_not_called()

    def test_workflow_success(self, admin_token, fake_cc, fake_wm, monkeypatch):
        wf_service = mock.Mock()
        wf_service.import_coze_workflow.return_value = {
            "id": "workflow-1", "name": "章节流",
        }
        monkeypatch.setattr(app_mod, "_workflow_service", wf_service)
        fake_wm.import_workflow = mock.Mock(return_value={"id": "old-wf", "name": "w"})

        r = app_mod.app.test_client().post("/api/admin/works/import",
                                           json={"pat_token": "p", "workspace_id": "ws1",
                                                 "bot_ids": [{"id": "wf1", "name": "w",
                                                              "_source_type": "workflow"}]},
                                           headers=_auth(admin_token))
        assert r.status_code == 200
        data = r.get_json()["data"]
        assert data["results"][0] == {
            "success": True, "workflow_id": "workflow-1",
            "name": "章节流", "type": "workflow",
        }
        wf_service.import_coze_workflow.assert_called_once_with(
            {"id": "wf1", "name": "w", "description": "", "icon_url": ""}, "ws1")
        fake_wm.import_workflow.assert_not_called()

    def test_bot_info_fail(self, admin_token, fake_wm):
        cc = _FakeCozeClient()
        cc.get_bot_info = lambda *a, **k: {"success": False, "error": "失败"}
        app_mod.coze_client = cc
        r = app_mod.app.test_client().post("/api/admin/works/import",
                                           json={"pat_token": "p",
                                                 "bot_ids": [{"id": "b1", "name": "b"}]},
                                           headers=_auth(admin_token))
        assert r.status_code == 200
        assert r.get_json()["data"]["imported"] == 0


class TestImportDataset:
    def test_missing_dataset(self, admin_token):
        r = app_mod.app.test_client().post("/api/admin/works/import-dataset",
                                           json={"pat_token": "p"},
                                           headers=_auth(admin_token))
        assert r.status_code == 400

    def test_ok(self, admin_token, fake_cc, fake_wm):
        r = app_mod.app.test_client().post("/api/admin/works/import-dataset",
                                           json={"pat_token": "p", "dataset_id": "d1"},
                                           headers=_auth(admin_token))
        assert r.status_code == 200

    def test_not_found(self, admin_token, fake_wm):
        cc = _FakeCozeClient()
        cc.get_dataset_list = lambda: {"success": True, "items": []}
        app_mod.coze_client = cc
        r = app_mod.app.test_client().post("/api/admin/works/import-dataset",
                                           json={"pat_token": "p", "dataset_id": "nope"},
                                           headers=_auth(admin_token))
        assert r.status_code == 404


class TestImportWorkflow:
    def test_missing_wf(self, admin_token):
        r = app_mod.app.test_client().post("/api/admin/works/import-workflow",
                                           json={"pat_token": "p"},
                                           headers=_auth(admin_token))
        assert r.status_code == 400

    def test_ok(self, admin_token, fake_cc, fake_wm):
        r = app_mod.app.test_client().post("/api/admin/works/import-workflow",
                                           json={"pat_token": "p", "workflow_id": "wf1"},
                                           headers=_auth(admin_token))
        assert r.status_code == 200

    def test_not_found(self, admin_token, fake_wm):
        cc = _FakeCozeClient()
        cc.get_workflow_list = lambda ws="": {"success": True, "items": []}
        app_mod.coze_client = cc
        r = app_mod.app.test_client().post("/api/admin/works/import-workflow",
                                           json={"pat_token": "p", "workflow_id": "nope"},
                                           headers=_auth(admin_token))
        assert r.status_code == 404


# ---------- 工作流管理 API ----------

class TestWorkflowApi:
    def _payload(self, **over):
        base = {
            "name": "章节流", "description": "生成章节",
            "platform": "coze",
            "platform_config": {"workflow_id": f"wf-api-{uuid.uuid4().hex[:8]}",
                                "workspace_id": "ws"},
            "llm_config": {"base_url": "", "api_key": "", "model": "gpt"},
        }
        base.update(over)
        return base

    def test_create_and_list(self):
        client = app_mod.app.test_client()
        r = client.post("/api/workflows", json=self._payload())
        assert r.status_code == 200
        data = r.get_json()["data"]
        assert data["project_id"] == "_global"
        assert data["source"] == "manual"

        r2 = client.get("/api/workflows?project_id=_global&page=1&page_size=10")
        assert r2.status_code == 200
        listed = r2.get_json()["data"]
        assert listed["total"] >= 1
        assert listed["items"][0]["id"] == data["id"]

    def test_get_update_status_delete(self):
        client = app_mod.app.test_client()
        created = client.post("/api/workflows", json=self._payload()).get_json()["data"]
        wid = created["id"]

        r = client.get(f"/api/workflows/{wid}?project_id=_global")
        assert r.get_json()["data"]["name"] == "章节流"

        r = client.put(f"/api/workflows/{wid}?project_id=_global",
                       json={"name": "改名后"})
        assert r.get_json()["data"]["name"] == "改名后"

        r = client.post(f"/api/workflows/{wid}/status?project_id=_global",
                        json={"status": "disabled"})
        assert r.get_json()["data"]["status"] == "disabled"

        r = client.delete(f"/api/workflows/{wid}?project_id=_global&force=true")
        assert r.get_json()["data"] == {"success": True}

    def test_status_rejects_invalid(self):
        client = app_mod.app.test_client()
        created = client.post("/api/workflows", json=self._payload()).get_json()["data"]
        r = client.post(f"/api/workflows/{created['id']}/status?project_id=_global",
                        json={"status": "paused"})
        assert r.status_code == 400


# ---------- 作品管理（admin） ----------

class TestAdminWorks:
    def test_list(self, admin_token, fake_wm):
        r = app_mod.app.test_client().get("/api/admin/works", headers=_auth(admin_token))
        assert r.status_code == 200
        assert len(r.get_json()["data"]["works"]) == 1

    def test_update(self, admin_token, fake_wm):
        r = app_mod.app.test_client().put("/api/admin/works/w1", json={"name": "新"},
                                          headers=_auth(admin_token))
        assert r.status_code == 200

    def test_delete(self, admin_token, fake_wm):
        r = app_mod.app.test_client().delete("/api/admin/works/w1", headers=_auth(admin_token))
        assert r.status_code == 200


# ---------- 公开作品 ----------

class TestPublicWorks:
    def test_list_empty(self, fake_wm):
        app_mod.work_manager.works = []
        r = app_mod.app.test_client().get("/api/works")
        assert r.status_code == 200
        assert r.get_json()["data"]["works"] == []

    def test_list_filters_non_public(self, fake_wm):
        app_mod.work_manager.works = [
            {"id": "p1", "name": "公开", "is_public": True, "description": "d",
             "coze_meta": {}, "access_code": "c"},
            {"id": "p2", "name": "私有", "is_public": False, "description": "d",
             "coze_meta": {}},
        ]
        r = app_mod.app.test_client().get("/api/works")
        works = r.get_json()["data"]["works"]
        assert len(works) == 1
        assert works[0]["has_access_code"] is True

    def test_get_404(self, fake_wm):
        r = app_mod.app.test_client().get("/api/works/nope")
        assert r.status_code == 404

    def test_get_ok(self, fake_wm):
        r = app_mod.app.test_client().get("/api/works/w1")
        assert r.status_code == 200

    def test_get_not_public(self, fake_wm):
        app_mod.work_manager.works = [{"id": "w1", "name": "私有", "is_public": False}]
        r = app_mod.app.test_client().get("/api/works/w1")
        assert r.status_code == 403


# ---------- 访问码验证 ----------

class TestVerifyAccess:
    def test_404(self, fake_wm):
        r = app_mod.app.test_client().post("/api/works/nope/verify", json={})
        assert r.status_code == 404

    def test_ok(self, fake_wm):
        r = app_mod.app.test_client().post("/api/works/w1/verify", json={"access_code": ""})
        assert r.status_code == 200
        assert r.get_json()["data"]["success"] is True

    def test_wrong(self, fake_wm):
        app_mod.work_manager.works = [{"id": "w1", "name": "x", "access_code": "abc"}]
        r = app_mod.app.test_client().post("/api/works/w1/verify",
                                           json={"access_code": "bad"})
        assert r.status_code == 403


# ---------- 聊天（SSE） ----------

class TestChat:
    def test_missing_message(self, fake_wm):
        r = app_mod.app.test_client().post("/api/works/w1/chat", json={})
        # 无访问码默认公开，message 为空 → 400
        assert r.status_code == 400

    def test_no_work(self, fake_wm):
        r = app_mod.app.test_client().post("/api/works/nope/chat",
                                           json={"message": "hi"})
        assert r.status_code == 404

    def test_stream(self, fake_wm, fake_cc):
        app_mod.work_manager.works = [{"id": "w1", "name": "x", "is_public": True}]
        with mock.patch("app.requests.post") as mp:
            # SSE 模拟
            class _Iter:
                def __init__(self):
                    self.lines = [
                        b"event: conversation.message.delta",
                        'data: {"type":"answer","content":"你好"}'.encode("utf-8"),
                        b"event: conversation.chat.completed",
                        b"data: {\"type\":\"conversation_message\",\"data\":"
                        b"{\"conversation_id\":\"c1\"}}",
                    ]

                def __iter__(self):
                    return iter(self.lines)

            class _Resp:
                def __init__(self):
                    self.encoding = "utf-8"
                    self._lines = _Iter()

                def raise_for_status(self):
                    return None

                def iter_lines(self):
                    return self._lines

                def close(self):
                    return None

            mp.return_value = _Resp()
            r = app_mod.app.test_client().post("/api/works/w1/chat",
                                               json={"message": "hi"})
            assert r.status_code == 200
            assert "text/event-stream" in r.headers["Content-Type"]


# ---------- 上传文件 ----------

class TestUpload:
    def test_404(self, fake_wm):
        r = app_mod.app.test_client().post("/api/works/nope/upload", data={})
        assert r.status_code == 404

    def test_no_pat(self, fake_wm):
        app_mod.work_manager.works = [{"id": "w1", "name": "x", "is_public": True,
                                       "pat_token": ""}]
        r = app_mod.app.test_client().post("/api/works/w1/upload",
                                           data={"file": (io.BytesIO(b"x"), "a.png")})
        assert r.status_code == 400


# ---------- 执行工作流 ----------

class TestExecute:
    def test_404(self, fake_wm):
        r = app_mod.app.test_client().post("/api/works/nope/execute", json={})
        assert r.status_code == 404

    def test_missing_config(self, fake_wm):
        app_mod.work_manager.works = [{"id": "w1", "name": "x", "is_public": True,
                                       "pat_token": "", "coze_meta": {}}]
        r = app_mod.app.test_client().post("/api/works/w1/execute", json={})
        assert r.status_code == 400

    def test_wrong_access(self, fake_wm):
        app_mod.work_manager.works = [{"id": "w1", "name": "x", "is_public": True,
                                       "access_code": "abc", "pat_token": "p",
                                       "coze_workflow_id": "wf1"}]
        r = app_mod.app.test_client().post(
            "/api/works/w1/execute", json={}, headers={"X-Access-Code": "bad"})
        assert r.status_code == 403

    def test_sync_ok(self, fake_wm, fake_cc):
        app_mod.work_manager.works = [{"id": "w1", "name": "x", "is_public": True,
                                       "pat_token": "p", "coze_workflow_id": "wf1",
                                       "parameters": [
                                           {"name": "n", "type": "Integer"},
                                           {"name": "arr", "type": "Array"},
                                           {"name": "obj", "type": "Object"},
                                           {"name": "f", "type": "File"},
                                           {"name": "b", "type": "Boolean"},
                                           {"name": "num", "type": "Number"},
                                       ]}]
        with mock.patch("app.requests.post") as mp:
            mp.return_value = mock.Mock(status_code=200,
                                        raise_for_status=lambda: None,
                                        json=lambda: {"code": 0, "data": "结果"})
            r = app_mod.app.test_client().post("/api/works/w1/execute", json={
                "inputs": {"n": "5", "arr": "1,2,3", "obj": '{"a":1}',
                           "f": "fileid", "b": "true", "num": "1.5"},
            })
            assert r.status_code == 200


# ---------- 启动脚本 ----------

class TestStartupScripts:
    @pytest.mark.parametrize("script_name", ["start.bat", "start.sh"])
    def test_installs_dependencies_from_requirements(self, script_name):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        script_path = os.path.join(root, script_name)
        with open(script_path, "r", encoding="utf-8") as script_file:
            script = script_file.read()

        assert "python -m pip install -r requirements.txt" in script
        assert "pip install flask requests flask-cors" not in script
