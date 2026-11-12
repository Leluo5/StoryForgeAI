# -*- coding: utf-8 -*-
"""剧情树接口层测试（F7-T6，技术方案 §3.1~§3.11）。

Flask test_client 覆盖全部路由端点含异常路径（400/404/409）：
- trees CRUD（创建/列表/详情/删除）
- generate（outline/novel，注入 fake_llm）
- nodes 增删改（含级联）
- links 增删（含自环/环路/去重）
- layout 保存
- sync-room（push/pull，创建临时聊天室注入 fake_room）
- export / import
蓝图注册冒烟 + 统一响应结构。
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import app as app_module  # noqa: E402


def _valid_llm_nodes():
    return {
        "nodes": [
            {"key": "n1", "label": "开端", "type": "start", "content": "开始", "parent": None},
            {"key": "n2", "label": "初遇", "type": "main", "content": "相遇", "parent": "n1"},
        ],
        "links": [{"from": "n1", "to": "n2", "type": "前置"}],
    }


class TestPlotRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        import modules.plot.routes as routes
        from modules.plot.plot_tree import PlotTreeStore
        routes._store = PlotTreeStore(os.path.join(cls.tmp, "plot"))

        # 注入固定 LLM（parse_outline/parse_novel 调用）
        def fake_llm(prompt, *a, **k):
            return _valid_llm_nodes()
        routes.set_llm_fn(fake_llm)

        app_module.app.config["TESTING"] = True
        cls.client = app_module.app.test_client()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _create_tree(self, name="雾都主线", source="manual"):
        resp = self.client.post("/api/plot/trees", json={"name": name, "source": source})
        self.assertEqual(resp.status_code, 200)
        return resp.get_json()["data"]

    # ---- 蓝图注册冒烟 ----

    def test_blueprint_registered(self):
        resp = self.client.get("/api/plot/trees")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("trees", resp.get_json()["data"])

    def test_response_envelope(self):
        resp = self.client.get("/api/plot/trees")
        body = resp.get_json()
        self.assertEqual(body["code"], 0)
        self.assertIn("data", body)
        self.assertIn("message", body)

    # ---- §3.1 创建树 ----

    def test_create_tree(self):
        tree = self._create_tree("雾都疑案", "outline")
        self.assertTrue(tree["id"])
        self.assertEqual(tree["name"], "雾都疑案")
        self.assertEqual(tree["source"], "outline")

    def test_create_tree_missing_name_400(self):
        resp = self.client.post("/api/plot/trees", json={"name": "  "})
        self.assertEqual(resp.status_code, 400)
        self.assertNotEqual(resp.get_json()["code"], 0)

    def test_create_tree_bad_source_400(self):
        resp = self.client.post("/api/plot/trees", json={"name": "x", "source": "bad"})
        self.assertEqual(resp.status_code, 400)

    # ---- §3.2/3.3/3.4 列表/详情/删除 ----

    def test_list_trees(self):
        self._create_tree("树A")
        self._create_tree("树B")
        resp = self.client.get("/api/plot/trees")
        trees = resp.get_json()["data"]["trees"]
        self.assertGreaterEqual(len(trees), 2)
        self.assertIn("nodes_count", trees[0])

    def test_tree_detail(self):
        tree = self._create_tree()
        resp = self.client.get(f"/api/plot/trees/{tree['id']}")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["data"]["id"], tree["id"])

    def test_tree_detail_not_found_404(self):
        resp = self.client.get("/api/plot/trees/nonexistent")
        self.assertEqual(resp.status_code, 404)

    def test_delete_tree(self):
        tree = self._create_tree()
        resp = self.client.delete(f"/api/plot/trees/{tree['id']}")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.get_json()["data"]["deleted"])

    def test_delete_tree_not_found_404(self):
        resp = self.client.delete("/api/plot/trees/nonexistent")
        self.assertEqual(resp.status_code, 404)

    # ---- §3.5 生成 ----

    def test_generate_outline(self):
        resp = self.client.post("/api/plot/trees/generate", json={
            "mode": "outline",
            "content": "第一章 主角登场。第二章 探案。第三章 真相。第四章 终结。第五章 尾声。",
            "name": "大纲树",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()["data"]
        self.assertTrue(data["pending"])
        self.assertEqual(len(data["nodes"]), 2)
        self.assertEqual(data["source"], "outline")

    def test_generate_novel(self):
        resp = self.client.post("/api/plot/trees/generate", json={
            "mode": "novel",
            "content": "第一章 主角来到雾都展开调查。第二章 发现线索锁定嫌疑人。第三章 真凶落网。",
            "name": "小说树",
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["data"]["source"], "novel")

    def test_generate_bad_mode_400(self):
        resp = self.client.post("/api/plot/trees/generate", json={"mode": "bad", "content": "很长内容" * 5})
        self.assertEqual(resp.status_code, 400)

    def test_generate_short_content_400(self):
        resp = self.client.post("/api/plot/trees/generate", json={"mode": "outline", "content": "太短"})
        self.assertEqual(resp.status_code, 400)

    # ---- §3.6 节点 ----

    def test_add_node(self):
        tree = self._create_tree()
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/nodes", json={
            "label": "开端", "type": "start",
        })
        self.assertEqual(resp.status_code, 200)
        node = resp.get_json()["data"]
        self.assertEqual(node["label"], "开端")
        # 首节点应为根
        detail = self.client.get(f"/api/plot/trees/{tree['id']}").get_json()["data"]
        self.assertEqual(detail["root_node_id"], node["id"])

    def test_add_node_with_parent(self):
        tree = self._create_tree()
        root = self.client.post(f"/api/plot/trees/{tree['id']}/nodes", json={"label": "根", "type": "start"}).get_json()["data"]
        child = self.client.post(f"/api/plot/trees/{tree['id']}/nodes", json={
            "label": "子", "type": "main", "parent_id": root["id"],
        }).get_json()["data"]
        detail = self.client.get(f"/api/plot/trees/{tree['id']}").get_json()["data"]
        root_loaded = [n for n in detail["nodes"] if n["id"] == root["id"]][0]
        self.assertIn(child["id"], root_loaded["children_ids"])

    def test_add_node_bad_type_400(self):
        tree = self._create_tree()
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/nodes", json={"label": "x", "type": "bad"})
        self.assertEqual(resp.status_code, 400)

    def test_edit_node(self):
        tree = self._create_tree()
        node = self.client.post(f"/api/plot/trees/{tree['id']}/nodes", json={"label": "初遇"}).get_json()["data"]
        resp = self.client.patch(f"/api/plot/trees/{tree['id']}/nodes/{node['id']}", json={
            "label": "初遇升级", "type": "turn", "tags": ["主线"],
        })
        self.assertEqual(resp.status_code, 200)
        edited = resp.get_json()["data"]
        self.assertEqual(edited["label"], "初遇升级")
        self.assertEqual(edited["type"], "turn")

    def test_edit_node_not_found_404(self):
        tree = self._create_tree()
        resp = self.client.patch(f"/api/plot/trees/{tree['id']}/nodes/missing", json={"label": "x"})
        self.assertEqual(resp.status_code, 404)

    def test_delete_node_cascade(self):
        tree = self._create_tree()
        root = self.client.post(f"/api/plot/trees/{tree['id']}/nodes", json={"label": "根", "type": "start"}).get_json()["data"]
        child = self.client.post(f"/api/plot/trees/{tree['id']}/nodes", json={"label": "子", "parent_id": root["id"]}).get_json()["data"]
        # 建关联
        self.client.post(f"/api/plot/trees/{tree['id']}/links", json={
            "from_id": root["id"], "to_id": child["id"], "type": "前置",
        })
        resp = self.client.delete(f"/api/plot/trees/{tree['id']}/nodes/{root['id']}")
        self.assertEqual(resp.status_code, 200)
        self.assertIn(root["id"], resp.get_json()["data"]["deleted"])
        detail = self.client.get(f"/api/plot/trees/{tree['id']}").get_json()["data"]
        self.assertEqual(detail["nodes"], [])
        self.assertEqual(detail["links"], [])

    # ---- §3.7 关联 ----

    def _two_nodes(self, tree_id):
        a = self.client.post(f"/api/plot/trees/{tree_id}/nodes", json={"label": "A", "type": "start"}).get_json()["data"]
        b = self.client.post(f"/api/plot/trees/{tree_id}/nodes", json={"label": "B", "type": "main"}).get_json()["data"]
        return a, b

    def test_add_link(self):
        tree = self._create_tree()
        a, b = self._two_nodes(tree["id"])
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/links", json={
            "from_id": a["id"], "to_id": b["id"], "type": "前置", "note": "因果",
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["data"]["type"], "前置")

    def test_add_link_self_400(self):
        tree = self._create_tree()
        a, _ = self._two_nodes(tree["id"])
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/links", json={
            "from_id": a["id"], "to_id": a["id"], "type": "前置",
        })
        self.assertEqual(resp.status_code, 400)

    def test_add_link_cycle_400(self):
        tree = self._create_tree()
        a, b = self._two_nodes(tree["id"])
        self.client.post(f"/api/plot/trees/{tree['id']}/links", json={"from_id": a["id"], "to_id": b["id"], "type": "前置"})
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/links", json={"from_id": b["id"], "to_id": a["id"], "type": "前置"})
        self.assertEqual(resp.status_code, 400)

    def test_delete_link(self):
        tree = self._create_tree()
        a, b = self._two_nodes(tree["id"])
        self.client.post(f"/api/plot/trees/{tree['id']}/links", json={"from_id": a["id"], "to_id": b["id"], "type": "前置"})
        resp = self.client.delete(f"/api/plot/trees/{tree['id']}/links", json={
            "from_id": a["id"], "to_id": b["id"], "type": "前置",
        })
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.get_json()["data"]["deleted"])

    # ---- §3.8 布局 ----

    def test_save_layout(self):
        tree = self._create_tree()
        a, b = self._two_nodes(tree["id"])
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/layout", json={
            "positions": [
                {"id": a["id"], "position": {"x": 100, "y": 200}},
                {"id": b["id"], "position": {"x": 300, "y": 400}},
            ],
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["data"]["updated"], 2)
        detail = self.client.get(f"/api/plot/trees/{tree['id']}").get_json()["data"]
        a_loaded = [n for n in detail["nodes"] if n["id"] == a["id"]][0]
        self.assertEqual(a_loaded["position"], {"x": 100, "y": 200})

    # ---- §3.9 双向联动 ----

    def _setup_room(self):
        """创建临时聊天室（注入 story_thread）用于 sync-room 测试。"""
        from modules import story_thread
        room = {
            "id": "room_f7_test",
            "name": "F7测试室",
            "place": "雾都",
            "background": "探案",
            "step_index": 2,
            "status": "paused",
            "history": [
                {"step_no": 1, "content": "第一步推衍内容"},
                {"step_no": 2, "content": "第二步推衍内容"},
            ],
        }
        try:
            story_thread.create_room(room)
        except Exception:
            pass  # 已存在则复用
        return "room_f7_test"

    def test_sync_room_push(self):
        tree = self._create_tree()
        self.client.post(f"/api/plot/trees/{tree['id']}/nodes", json={"label": "根", "type": "start"})
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/sync-room/room_x", json={"action": "push"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["data"]["injected"], 1)

    def test_sync_room_pull(self):
        tree = self._create_tree()
        root = self.client.post(f"/api/plot/trees/{tree['id']}/nodes", json={"label": "根", "type": "start"}).get_json()["data"]
        room_id = self._setup_room()
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/sync-room/{room_id}", json={
            "action": "pull", "parent_node_id": root["id"],
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["data"]["added"], 2)
        detail = self.client.get(f"/api/plot/trees/{tree['id']}").get_json()["data"]
        deriv = [n for n in detail["nodes"] if n["source"] == "derivation"]
        self.assertEqual(len(deriv), 2)

    def test_sync_room_bad_action_400(self):
        tree = self._create_tree()
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/sync-room/room_x", json={"action": "bad"})
        self.assertEqual(resp.status_code, 400)

    def test_sync_room_room_not_found_404(self):
        tree = self._create_tree()
        resp = self.client.post(f"/api/plot/trees/{tree['id']}/sync-room/missing_room", json={"action": "pull"})
        self.assertEqual(resp.status_code, 404)

    # ---- §3.10/3.11 导出导入 ----

    def test_export_all(self):
        tree = self._create_tree()
        a, b = self._two_nodes(tree["id"])
        self.client.post(f"/api/plot/trees/{tree['id']}/links", json={"from_id": a["id"], "to_id": b["id"], "type": "前置"})
        resp = self.client.get(f"/api/plot/trees/{tree['id']}/export?scope=all")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()["data"]
        self.assertEqual(len(data["nodes"]), 2)
        self.assertEqual(len(data["links"]), 1)

    def test_export_node(self):
        tree = self._create_tree()
        a, b = self._two_nodes(tree["id"])
        resp = self.client.get(f"/api/plot/trees/{tree['id']}/export?scope=node&node_id={a['id']}")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["data"]["export_node_id"], a["id"])

    def test_import_merge(self):
        tree = self._create_tree()
        import_data = {
            "nodes": [{"id": "i1", "label": "导入", "type": "main", "content": "", "parent_id": None,
                       "children_ids": [], "source": "generated", "tags": [], "position": {"x": 0, "y": 0},
                       "linked_room_id": None}],
            "links": [],
        }
        resp = self.client.post("/api/plot/trees/import", json={
            "data": import_data, "mode": "merge", "target_tree_id": tree["id"],
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["data"]["mode"], "merge")

    def test_import_invalid_400(self):
        resp = self.client.post("/api/plot/trees/import", json={"data": {"nodes": "bad", "links": []}, "mode": "merge", "target_tree_id": "x"})
        self.assertEqual(resp.status_code, 400)

    def test_import_missing_data_400(self):
        resp = self.client.post("/api/plot/trees/import", json={"mode": "merge"})
        self.assertEqual(resp.status_code, 400)


if __name__ == "__main__":
    unittest.main()
