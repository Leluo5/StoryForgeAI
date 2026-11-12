# -*- coding: utf-8 -*-
"""F6 剧情推衍聊天室接口契约单测（§3.1~3.9）。

用 Flask 测试客户端 + monkeypatch 注入 mock LLM，避免真实 Coze 网络调用。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules import story_thread
from modules import routes_story
from modules.story_engine import StoryEngine, init_room
from modules.random_system import RandomSystem


@pytest.fixture()
def client(monkeypatch):
    """构造测试客户端；注入 mock 引擎 + 随机系统，清空注册表。"""
    story_thread._rooms.clear()

    def fake_llm(prompt, bot_id=""):
        if "分支" in prompt or "2-4" in prompt:
            return {"success": True, "content": ["A 追问线索", "B 按兵不动"]}
        return {"success": True, "content": "林远推开房门，发现一封密信。"}

    eng = StoryEngine(llm=fake_llm)
    rs = RandomSystem(event_prob=0.0, enter_prob=0.0)
    monkeypatch.setattr(routes_story, "_engine", eng)
    monkeypatch.setattr(routes_story, "_random", rs)

    from app import app as flask_app
    flask_app.config["TESTING"] = True
    with flask_app.test_client() as c:
        yield c


def _create(client, **over):
    cfg = {
        "name": "雨夜破庙",
        "place": "破庙",
        "background": "主角追寻失落的龙族秘宝",
        "time_node": "深夜",
        "characters": ["林远", "苏晚"],
    }
    cfg.update(over)
    return client.post("/api/story/rooms", json=cfg)


# ---------- 3.1 创建 ----------

class TestCreateRoom:
    def test_create_ok(self, client):
        resp = _create(client)
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["code"] == 0
        assert body["data"]["room_id"]

    def test_create_missing_place(self, client):
        resp = _create(client, place="")
        assert resp.status_code == 400
        assert "场所" in resp.get_json()["message"]


# ---------- 3.2 列出 ----------

class TestListRooms:
    def test_list(self, client):
        rid = _create(client).get_json()["data"]["room_id"]
        resp = client.get("/api/story/rooms")
        body = resp.get_json()
        assert body["code"] == 0
        assert any(r["id"] == rid for r in body["data"]["rooms"])
        assert body["data"]["rooms"][0]["characters_count"] == 2


# ---------- 3.3 详情 ----------

class TestRoomDetail:
    def test_detail(self, client):
        rid = _create(client).get_json()["data"]["room_id"]
        resp = client.get(f"/api/story/rooms/{rid}")
        body = resp.get_json()
        assert body["code"] == 0
        assert body["data"]["place"] == "破庙"

    def test_detail_404(self, client):
        resp = client.get("/api/story/rooms/nope")
        assert resp.status_code == 404


# ---------- 3.4 推衍一步 ----------

class TestAdvanceStepRoute:
    def test_step_paused(self, client):
        rid = _create(client).get_json()["data"]["room_id"]
        resp = client.post(f"/api/story/rooms/{rid}/step", json={})
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["data"]["status"] == "paused"  # 一步一断
        assert body["data"]["step"]["step_no"] == 1
        assert len(body["data"]["step"]["branches"]) >= 2

    def test_step_no_characters(self, client):
        rid = _create(client, characters=[]).get_json()["data"]["room_id"]
        resp = client.post(f"/api/story/rooms/{rid}/step", json={})
        assert resp.status_code == 400


# ---------- 3.5 continue ----------

class TestContinue:
    def test_continue_running(self, client):
        rid = _create(client).get_json()["data"]["room_id"]
        client.post(f"/api/story/rooms/{rid}/step", json={})
        resp = client.post(f"/api/story/rooms/{rid}/continue", json={
            "final_content": "改后正文", "branch_choice": "A 追问线索",
        })
        body = resp.get_json()
        assert body["data"]["status"] == "running"

    def test_continue_edits_history(self, client):
        rid = _create(client).get_json()["data"]["room_id"]
        client.post(f"/api/story/rooms/{rid}/step", json={})
        client.post(f"/api/story/rooms/{rid}/continue", json={"final_content": "改后正文"})
        detail = client.get(f"/api/story/rooms/{rid}").get_json()["data"]
        assert detail["history"][-1]["content"] == "改后正文"


# ---------- 3.7 角色拉入 ----------

class TestCharacters:
    def test_pull(self, client):
        rid = _create(client).get_json()["data"]["room_id"]
        resp = client.post(f"/api/story/rooms/{rid}/characters", json={"characters": ["萧烈"]})
        body = resp.get_json()
        assert "萧烈" in body["data"]["characters"]
        assert body["data"]["random_entered"] is None


# ---------- 3.8 配置编辑 ----------

class TestConfigUpdate:
    def test_update(self, client):
        rid = _create(client).get_json()["data"]["room_id"]
        resp = client.put(f"/api/story/rooms/{rid}", json={"name": "雨夜城楼"})
        assert resp.get_json()["data"]["status"] == "updated"
        detail = client.get(f"/api/story/rooms/{rid}").get_json()["data"]
        assert detail["name"] == "雨夜城楼"


# ---------- 3.9 销毁 ----------

class TestDelete:
    def test_delete(self, client):
        rid = _create(client).get_json()["data"]["room_id"]
        resp = client.delete(f"/api/story/rooms/{rid}")
        assert resp.get_json()["data"]["deleted"] is True
        assert client.get(f"/api/story/rooms/{rid}").status_code == 404
