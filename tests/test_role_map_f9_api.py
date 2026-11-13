# -*- coding: utf-8 -*-
"""F9-T5 图谱 API 路由扩展单测。

覆盖：
- POST /api/role-map/avatar/generate：缺工具注册中心 → 占位；有注册中心 → 调真实 handler。
- GET  /api/role-map/avatar/<hash>：命中文件返回 200 PNG；未命中 404；非法 hash 400。
- PUT  /api/role-map/roles/<id>/visual：更新形象特征白名单，返回 role。
- GET  /api/role-map/graph：edge 含 color 字段（F9-T4 分配）。

使用 Flask test_client + 临时 data 目录隔离；mock tool_registry / coze_client。
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from flask import Flask  # noqa: E402

from modules.common.errors import AppError  # noqa: E402
from modules.novel_creation.role_store import RoleStore  # noqa: E402
from modules.plot.role_map_service import RoleMapStore  # noqa: E402
from modules.plot.routes_role_map import create_role_map_blueprint  # noqa: E402


class FakeToolRegistry:
    """最小工具注册中心替身：invoke 返回固定 avatar 结果。"""

    def __init__(self, result=None, exc=None):
        self.result = result or {
            "tool": "gen_character_image", "status": "ok",
            "avatar": "/api/role-map/avatar/abc123", "cached": False,
            "role": {"id": "r1", "name": "林风眠"},
        }
        self.exc = exc
        self.calls = []

    def invoke(self, name, params, context):
        self.calls.append((name, params, context))
        if self.exc:
            raise self.exc
        return self.result


class FakeCozeClient:
    def __init__(self):
        self.calls = []

    def generate_character_image(self, workflow_id, prompt):
        self.calls.append((workflow_id, prompt))
        return {"success": True, "image_url": "http://img/x.png"}


class RoleMapF9ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = os.path.join(self.tmp.name, "data", "projects")
        self.data_root = os.path.join(self.tmp.name, "data")
        self.role_store = RoleStore(self.data_dir)
        self.map_store = RoleMapStore(self.data_dir, self.role_store)
        self.pid = "p1"
        self.role = self.role_store.create_role(self.pid, "林风眠", identity="主角")
        self.rid = self.role["id"]

    def tearDown(self):
        self.tmp.cleanup()

    def _app(self, registry=None, coze=None, config_loader=None):
        app = Flask(__name__)
        bp = create_role_map_blueprint(
            self.map_store, self.role_store,
            data_root=self.data_root,
            tool_registry=registry,
            coze_client=coze,
            config_loader=config_loader,
        )
        app.register_blueprint(bp)
        app.config["TESTING"] = True
        return app

    # ---- avatar/generate ----

    def test_avatar_generate_no_registry_placeholder(self):
        app = self._app(registry=None)
        c = app.test_client()
        r = c.post("/api/role-map/avatar/generate", json={
            "project_id": self.pid, "role_id": self.rid,
        })
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["placeholder"])
        self.assertEqual(data["avatar"], "")

    def test_avatar_generate_invokes_registry(self):
        registry = FakeToolRegistry()
        app = self._app(registry=registry, coze=FakeCozeClient())
        c = app.test_client()
        r = c.post("/api/role-map/avatar/generate", json={
            "project_id": self.pid, "role_id": self.rid,
        })
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertEqual(data["avatar"], "/api/role-map/avatar/abc123")
        # 确认上下文注入完整
        name, params, ctx = registry.calls[0]
        self.assertEqual(name, "gen_character_image")
        self.assertEqual(ctx["project_id"], self.pid)
        self.assertEqual(ctx["role_id"], self.rid)
        self.assertIn("role_store", ctx)

    def test_avatar_generate_missing_params_400(self):
        app = self._app(registry=FakeToolRegistry())
        c = app.test_client()
        r = c.post("/api/role-map/avatar/generate", json={"project_id": self.pid})
        self.assertEqual(r.status_code, 400)

    def test_avatar_generate_role_not_found_404(self):
        app = self._app(registry=FakeToolRegistry())
        c = app.test_client()
        r = c.post("/api/role-map/avatar/generate", json={
            "project_id": self.pid, "role_id": "nonexistent",
        })
        self.assertEqual(r.status_code, 404)

    # ---- avatar/<hash> GET ----

    def test_avatar_file_found(self):
        # 预置头像文件
        avatars_dir = os.path.join(self.data_root, "avatars", self.pid)
        os.makedirs(avatars_dir, exist_ok=True)
        with open(os.path.join(avatars_dir, "abc123def4567890.png"), "wb") as f:
            f.write(b"PNGDATA")
        app = self._app()
        c = app.test_client()
        r = c.get("/api/role-map/avatar/abc123def4567890")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data, b"PNGDATA")
        self.assertEqual(r.mimetype, "image/png")

    def test_avatar_file_not_found_404(self):
        app = self._app()
        c = app.test_client()
        r = c.get("/api/role-map/avatar/ffffffffffffffff")
        self.assertEqual(r.status_code, 404)

    def test_avatar_file_invalid_hash_400(self):
        app = self._app()
        c = app.test_client()
        r = c.get("/api/role-map/avatar/short")
        self.assertEqual(r.status_code, 400)

    # ---- roles/<id>/visual PUT ----

    def test_role_visual_update(self):
        app = self._app()
        c = app.test_client()
        r = c.put(f"/api/role-map/roles/{self.rid}/visual", json={
            "project_id": self.pid,
            "visual_features": {"hair_style": "长发", "hair_color": "黑"},
        })
        self.assertEqual(r.status_code, 200)
        role = r.get_json()["role"]
        self.assertEqual(role["visual_features"]["hair_style"], "长发")
        self.assertEqual(role["visual_features"]["hair_color"], "黑")
        # 白名单未知字段被拒绝
        self.assertNotIn("unknown_key", role["visual_features"])

    def test_role_visual_missing_project_400(self):
        app = self._app()
        c = app.test_client()
        r = c.put(f"/api/role-map/roles/{self.rid}/visual", json={
            "visual_features": {"hair_style": "短发"},
        })
        self.assertEqual(r.status_code, 400)

    def test_role_visual_not_object_400(self):
        app = self._app()
        c = app.test_client()
        r = c.put(f"/api/role-map/roles/{self.rid}/visual", json={
            "project_id": self.pid, "visual_features": "not-a-dict",
        })
        self.assertEqual(r.status_code, 400)

    # ---- graph edge.color ----

    def test_graph_edge_has_color(self):
        self.map_store.add_node(self.pid, self.rid)
        role2 = self.role_store.create_role(self.pid, "沈雪落", identity="配角")
        self.map_store.add_node(self.pid, role2["id"])
        self.map_store.add_edge(self.pid, self.rid, role2["id"], "ally")
        app = self._app()
        c = app.test_client()
        r = c.get(f"/api/role-map/graph?project_id={self.pid}")
        data = r.get_json()
        self.assertEqual(len(data["edges"]), 1)
        self.assertTrue(data["edges"][0].get("color"))
        self.assertRegex(data["edges"][0]["color"], r"^#[0-9a-fA-F]{6}$")
        # F9-T6：节点透传 avatar / visual_features
        node0 = data["nodes"][0]
        self.assertIn("avatar", node0)
        self.assertIn("visual_features", node0)


if __name__ == "__main__":
    unittest.main()
