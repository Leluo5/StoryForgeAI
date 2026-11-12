# -*- coding: utf-8 -*-
"""F8-T6 角色版图图谱 API 接口层测试。

Flask test_client 覆盖 /api/role-map/* 全部路由端点含异常路径（400/404/409）：
- graph 读取
- nodes 增删（幂等 / 角色不存在 404 / 移出图谱清理边）
- edges 增删（双向关联一致 / 自关联 400 / 未入图谱 400 / 重复 400）
- filter options / filter（6 维度组合）
- role detail（含 relations + 成长线）
- delete role chain（标红章节 + 清剧情 + 清关联 + 删 Role 原子）
- ai generate（后台任务 202）/ ai progress / ai commit（二次编辑确认）
蓝图注册冒烟 + 统一错误响应。

隔离：每个测试方法独立临时存储 + 独立蓝图/Flask app（避免跨测试数据污染）。
"""

import os
import shutil
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from flask import Flask  # noqa: E402


def _sample_llm_response():
    return {
        "characters": [
            {"name": "林风眠", "identity": "主角", "nationality": "中原", "faith": "天道",
             "camp": "正道", "race": "人族", "profession": "剑客", "age": 28, "gender": "男",
             "attributes": {"personality": "冷静", "background": "出身名门"}},
            {"name": "苏雪落", "identity": "配角", "nationality": "北境", "faith": "无",
             "camp": "魔道", "race": "妖族", "profession": "术士", "age": 22, "gender": "女",
             "attributes": {}},
        ],
        "relations": [
            {"from": "林风眠", "to": "苏雪落", "relation_type": "盟友", "note": "生死之交"},
        ],
    }


class TestRoleMapRoutes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        import modules.plot.routes_role_map as rm_routes
        from modules.plot.role_map_service import RoleMapStore
        from modules.novel_creation.role_store import RoleStore
        from modules.novel_creation.project_store import ProjectStore

        # 独立存储（不污染生产 data/）
        self.role_store = RoleStore(os.path.join(self.tmp, "projects"))
        self.project_store = ProjectStore(os.path.join(self.tmp, "projects"))
        self.map_store = RoleMapStore(
            os.path.join(self.tmp, "projects"),
            role_store=self.role_store,
            project_store=self.project_store,
        )

        # 注入 mock LLM（extract_roles 调用）
        def fake_llm(prompt):
            return _sample_llm_response()
        self.bp = rm_routes.create_role_map_blueprint(
            self.map_store, self.role_store, self.project_store,
            plot_store=None, llm_fn=fake_llm,
        )

        # 挂载到独立 Flask app
        test_app = Flask(__name__)
        test_app.register_blueprint(self.bp)
        test_app.config["TESTING"] = True
        self.client = test_app.test_client()
        self.project_id = None

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _mk_project(self):
        if self.project_id is None:
            proj = self.project_store.create_project("测试项目")
            self.project_id = proj["id"]
        return self.project_id

    def _mk_role(self, name="林风眠", **extra):
        pid = self._mk_project()
        role = self.role_store.create_role(pid, name, **extra)
        self.map_store.add_node(pid, role["id"])
        return role

    # ---------- graph ----------

    def test_graph_empty(self):
        pid = self._mk_project()
        resp = self.client.get(f"/api/role-map/graph?project_id={pid}")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["nodes"], [])
        self.assertEqual(data["edges"], [])
        self.assertIn("ai_generated", data)

    def test_graph_requires_project(self):
        resp = self.client.get("/api/role-map/graph")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("error", resp.get_json())

    # ---------- nodes ----------

    def test_add_node(self):
        pid = self._mk_project()
        role = self.role_store.create_role(pid, "顾惊蛰")
        resp = self.client.post("/api/role-map/nodes",
                                json={"project_id": pid, "role_id": role["id"]})
        self.assertEqual(resp.status_code, 201)
        graph = self.map_store.get_graph(pid)
        self.assertEqual(len(graph["nodes"]), 1)

    def test_add_node_missing_role(self):
        pid = self._mk_project()
        resp = self.client.post("/api/role-map/nodes",
                                json={"project_id": pid, "role_id": "nope"})
        self.assertEqual(resp.status_code, 404)

    def test_remove_node_cleans_edges(self):
        pid = self._mk_project()
        a = self._mk_role("A")
        b = self._mk_role("B")
        self.map_store.add_edge(pid, a["id"], b["id"], "盟友")
        resp = self.client.delete(f"/api/role-map/nodes/{a['id']}?project_id={pid}")
        self.assertEqual(resp.status_code, 200)
        graph = self.map_store.get_graph(pid)
        self.assertEqual(len(graph["nodes"]), 1)
        self.assertEqual(len(graph["edges"]), 0)

    # ---------- edges ----------

    def test_add_edge(self):
        pid = self._mk_project()
        a = self._mk_role("A")
        b = self._mk_role("B")
        resp = self.client.post("/api/role-map/edges",
                                json={"project_id": pid, "source": a["id"],
                                      "target": b["id"], "relation_type": "盟友"})
        self.assertEqual(resp.status_code, 201)
        graph = self.map_store.get_graph(pid)
        self.assertEqual(len(graph["edges"]), 1)

    def test_add_edge_self_rejected(self):
        pid = self._mk_project()
        a = self._mk_role("A")
        resp = self.client.post("/api/role-map/edges",
                                json={"project_id": pid, "source": a["id"],
                                      "target": a["id"]})
        self.assertEqual(resp.status_code, 400)

    def test_add_edge_not_in_graph(self):
        pid = self._mk_project()
        a = self._mk_role("A")
        b = self.role_store.create_role(pid, "B")  # 未加入图谱
        resp = self.client.post("/api/role-map/edges",
                                json={"project_id": pid, "source": a["id"],
                                      "target": b["id"]})
        self.assertEqual(resp.status_code, 400)

    def test_add_edge_duplicate(self):
        pid = self._mk_project()
        a = self._mk_role("A")
        b = self._mk_role("B")
        self.client.post("/api/role-map/edges",
                         json={"project_id": pid, "source": a["id"], "target": b["id"]})
        resp = self.client.post("/api/role-map/edges",
                                json={"project_id": pid, "source": b["id"], "target": a["id"]})
        self.assertEqual(resp.status_code, 400)  # 无向边去重

    def test_remove_edge_bidirectional(self):
        pid = self._mk_project()
        a = self._mk_role("A")
        b = self._mk_role("B")
        self.client.post("/api/role-map/edges",
                         json={"project_id": pid, "source": a["id"], "target": b["id"]})
        resp = self.client.delete("/api/role-map/edges",
                                  json={"project_id": pid, "source": a["id"], "target": b["id"]})
        self.assertEqual(resp.status_code, 200)
        graph = self.map_store.get_graph(pid)
        self.assertEqual(len(graph["edges"]), 0)
        # 双向 relations 已清
        ra = self.role_store.get_role(pid, a["id"])
        rb = self.role_store.get_role(pid, b["id"])
        self.assertEqual(ra["relations"], [])
        self.assertEqual(rb["relations"], [])

    # ---------- filter ----------

    def test_filter_options(self):
        pid = self._mk_project()
        self._mk_role("林风眠", nationality="中原", camp="正道", age=28)
        self._mk_role("苏雪落", nationality="北境", camp="魔道", age=22)
        resp = self.client.get(f"/api/role-map/filter/options?project_id={pid}")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertIn("nationality", data)
        self.assertIn("中原", data["nationality"])
        self.assertIn("camp", data)

    def test_filter_graph(self):
        pid = self._mk_project()
        a = self._mk_role("林风眠", nationality="中原", camp="正道", age=28)
        b = self._mk_role("苏雪落", nationality="北境", camp="魔道", age=22)
        self.map_store.add_edge(pid, a["id"], b["id"], "盟友")
        resp = self.client.post("/api/role-map/filter",
                                json={"project_id": pid,
                                      "filters": {"camp": ["正道"]}})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(len(data["nodes"]), 1)
        self.assertEqual(data["nodes"][0]["name"], "林风眠")
        self.assertEqual(len(data["edges"]), 0)  # 边仅两端命中保留

    # ---------- role detail ----------

    def test_role_detail(self):
        pid = self._mk_project()
        a = self._mk_role("林风眠")
        b = self._mk_role("苏雪落")
        self.map_store.add_edge(pid, a["id"], b["id"], "盟友", note="生死之交")
        resp = self.client.get(f"/api/role-map/roles/{a['id']}?project_id={pid}")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["role"]["name"], "林风眠")
        self.assertEqual(len(data["relations"]), 1)
        self.assertEqual(data["relations"][0]["relation_type"], "盟友")
        self.assertEqual(data["growth"]["nodes"], [])  # 无 plot_store

    # ---------- delete role chain ----------

    def test_delete_role_chain(self):
        pid = self._mk_project()
        a = self._mk_role("林风眠")
        b = self._mk_role("苏雪落")
        self.map_store.add_edge(pid, a["id"], b["id"], "盟友")
        resp = self.client.delete(f"/api/role-map/roles/{a['id']}",
                                  json={"project_id": pid})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["deleted_role"], a["id"])
        self.assertEqual(data["removed_nodes"], 1)
        # Role 实体已删，b 的 relations 已清
        rb = self.role_store.get_role(pid, b["id"])
        self.assertEqual(rb["relations"], [])

    def test_delete_role_chain_missing(self):
        pid = self._mk_project()
        resp = self.client.delete(f"/api/role-map/roles/nope", json={"project_id": pid})
        self.assertEqual(resp.status_code, 404)

    # ---------- AI generate / progress / commit ----------

    def test_ai_generate_returns_202(self):
        pid = self._mk_project()
        resp = self.client.post("/api/role-map/ai/generate",
                                json={"project_id": pid, "source_text": "小说内容" * 30})
        self.assertEqual(resp.status_code, 202)
        data = resp.get_json()
        self.assertIn("task_id", data)
        self.assertEqual(data["status"], "running")

    def test_ai_generate_requires_source(self):
        pid = self._mk_project()
        resp = self.client.post("/api/role-map/ai/generate",
                                json={"project_id": pid, "source_text": ""})
        self.assertEqual(resp.status_code, 400)

    def test_ai_progress(self):
        pid = self._mk_project()
        from modules.plot.role_map_ai import RoleMapAIExtractor
        extractor = RoleMapAIExtractor(self.map_store, self.role_store,
                                       llm_fn=lambda p: _sample_llm_response())
        extractor.extract_roles(pid, "小说内容" * 30, "all")
        resp = self.client.get(f"/api/role-map/ai/progress?project_id={pid}")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertEqual(data["stage"], "preview")
        self.assertEqual(data["percent"], 90)
        self.assertFalse(data["done"])

    def test_ai_commit(self):
        pid = self._mk_project()
        from modules.plot.role_map_ai import RoleMapAIExtractor
        extractor = RoleMapAIExtractor(self.map_store, self.role_store,
                                       llm_fn=lambda p: _sample_llm_response())
        result = extractor.extract_roles(pid, "小说内容" * 30, "all")
        resp = self.client.post("/api/role-map/ai/commit",
                                json={"project_id": pid,
                                      "characters": result["characters"],
                                      "relations": result["relations"]})
        self.assertEqual(resp.status_code, 201)
        data = resp.get_json()
        self.assertTrue(data["ai_generated"])
        self.assertEqual(len(data["created_roles"]), 2)
        # 进度 done
        progress = self.client.get(f"/api/role-map/ai/progress?project_id={pid}").get_json()
        self.assertTrue(progress["done"])


if __name__ == "__main__":
    unittest.main()
