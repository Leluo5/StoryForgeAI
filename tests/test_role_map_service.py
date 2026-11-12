# -*- coding: utf-8 -*-
"""F8-T2 图谱服务层单测。

覆盖：
- 图谱元数据默认值（nodes/edges/ai_generated/ai_progress/generated_at）。
- 节点增删（幂等/校验/移除清边）。
- 边增删：双向关联一致（A.relations 含 B ↔ B.relations 含 A）、去重、自关联防护、
  悬空边过滤、非图谱角色拒绝。
- 图谱节点单一数据源（节点属性从 Role 实时读取）。
- AI 进度更新（done 置 ai_generated=true + generated_at）。

使用临时目录隔离 data/，不污染真实数据。
"""

import os
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.common.errors import AppError  # noqa: E402
from modules.novel_creation.role_store import RoleStore  # noqa: E402
from modules.plot.role_map_service import RoleMapStore  # noqa: E402


class RoleMapStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = os.path.join(self.tmp.name, "data", "projects")
        self.role_store = RoleStore(self.data_dir)
        self.map_store = RoleMapStore(self.data_dir, self.role_store)
        self.pid = "p1"
        # 建 3 个角色（A/B/C）
        self.a = self.role_store.create_role(self.pid, "林风眠", identity="主角")
        self.b = self.role_store.create_role(self.pid, "沈雪落", identity="配角")
        self.c = self.role_store.create_role(self.pid, "顾惊蛰", identity="反派")

    def tearDown(self):
        self.tmp.cleanup()

    def _add_all(self):
        """把 A/B/C 全部加入图谱。"""
        for r in (self.a, self.b, self.c):
            self.map_store.add_node(self.pid, r["id"])

    # ---- 默认值 ----

    def test_default_role_map(self):
        rm = self.map_store.get_role_map(self.pid)
        self.assertEqual(rm["nodes"], [])
        self.assertEqual(rm["edges"], [])
        self.assertFalse(rm["ai_generated"])
        self.assertEqual(rm["ai_progress"]["stage"], "idle")
        self.assertIsNone(rm["generated_at"])

    # ---- 节点 ----

    def test_add_node_idempotent(self):
        self.map_store.add_node(self.pid, self.a["id"])
        self.map_store.add_node(self.pid, self.a["id"])  # 重复添加不报错
        self.assertEqual(self.map_store.get_role_map(self.pid)["nodes"], [self.a["id"]])

    def test_add_node_not_found(self):
        with self.assertRaises(AppError) as ctx:
            self.map_store.add_node(self.pid, "nonexistent")
        self.assertEqual(ctx.exception.code, 404)

    def test_remove_node_clears_edges(self):
        self._add_all()
        self.map_store.add_edge(self.pid, self.a["id"], self.b["id"], "ally")
        self.map_store.remove_node(self.pid, self.a["id"])
        rm = self.map_store.get_role_map(self.pid)
        self.assertNotIn(self.a["id"], rm["nodes"])
        self.assertEqual(rm["edges"], [])  # 关联边已清理

    def test_remove_node_not_in_graph(self):
        with self.assertRaises(AppError) as ctx:
            self.map_store.remove_node(self.pid, self.b["id"])
        self.assertEqual(ctx.exception.code, 404)

    # ---- 边增删：双向一致 ----

    def test_add_edge_bidirectional(self):
        """建关联：A.relations 含 B，B.relations 必含 A。"""
        self._add_all()
        self.map_store.add_edge(self.pid, self.a["id"], self.b["id"], "ally", note="战友")
        a = self.role_store.get_role(self.pid, self.a["id"])
        b = self.role_store.get_role(self.pid, self.b["id"])
        rel_a = [r["target_role_id"] for r in a["relations"]]
        rel_b = [r["target_role_id"] for r in b["relations"]]
        self.assertIn(self.b["id"], rel_a)
        self.assertIn(self.a["id"], rel_b)
        self.assertEqual(a["relations"][0]["relation_type"], "ally")

    def test_add_edge_self_loop_forbidden(self):
        """禁止自关联。"""
        self._add_all()
        with self.assertRaises(AppError) as ctx:
            self.map_store.add_edge(self.pid, self.a["id"], self.a["id"])
        self.assertEqual(ctx.exception.code, 400)

    def test_add_edge_duplicate_conflict(self):
        """重复无向边（A-B 与 B-A 同键）→ 400。"""
        self._add_all()
        self.map_store.add_edge(self.pid, self.a["id"], self.b["id"])
        with self.assertRaises(AppError) as ctx:
            self.map_store.add_edge(self.pid, self.b["id"], self.a["id"])
        self.assertEqual(ctx.exception.code, 400)

    def test_add_edge_role_not_in_graph(self):
        """非图谱角色建关联 → 400。"""
        self._add_all()
        # C 已加入图谱，A-C 建关联应成功（验证测试前提）
        self.map_store.add_edge(self.pid, self.a["id"], self.c["id"], "enemy")
        # 新建 D 角色但不加入图谱 → 建关联应 400
        d = self.role_store.create_role(self.pid, "江问天")
        with self.assertRaises(AppError) as ctx:
            self.map_store.add_edge(self.pid, self.a["id"], d["id"])
        self.assertEqual(ctx.exception.code, 400)

    def test_remove_edge_bidirectional(self):
        """删关联：双向清理。"""
        self._add_all()
        self.map_store.add_edge(self.pid, self.a["id"], self.b["id"], "ally")
        self.map_store.remove_edge(self.pid, self.a["id"], self.b["id"])
        a = self.role_store.get_role(self.pid, self.a["id"])
        b = self.role_store.get_role(self.pid, self.b["id"])
        self.assertEqual(a["relations"], [])
        self.assertEqual(b["relations"], [])
        self.assertEqual(self.map_store.get_role_map(self.pid)["edges"], [])

    def test_remove_edge_not_found(self):
        with self.assertRaises(AppError) as ctx:
            self.map_store.remove_edge(self.pid, self.a["id"], self.b["id"])
        self.assertEqual(ctx.exception.code, 404)

    # ---- 图谱读取：单源 ----

    def test_get_graph_nodes_from_role(self):
        """节点属性实时从 Role 读取（单一数据源）。"""
        self._add_all()
        self.role_store.update_role(self.pid, self.a["id"], nationality="中原", camp="正道")
        graph = self.map_store.get_graph(self.pid)
        node_a = next(n for n in graph["nodes"] if n["id"] == self.a["id"])
        self.assertEqual(node_a["name"], "林风眠")
        self.assertEqual(node_a["nationality"], "中原")
        self.assertEqual(node_a["camp"], "正道")

    def test_get_graph_filters_dangling_edges(self):
        """悬空边（节点不在图谱）被过滤。"""
        self._add_all()
        self.map_store.add_edge(self.pid, self.a["id"], self.b["id"])
        self.map_store.remove_node(self.pid, self.b["id"])
        graph = self.map_store.get_graph(self.pid)
        self.assertEqual(graph["edges"], [])  # B 移出图谱，边悬空被滤

    def test_get_graph_multiple_edges(self):
        self._add_all()
        self.map_store.add_edge(self.pid, self.a["id"], self.b["id"], "ally")
        self.map_store.add_edge(self.pid, self.b["id"], self.c["id"], "enemy")
        graph = self.map_store.get_graph(self.pid)
        self.assertEqual(len(graph["nodes"]), 3)
        self.assertEqual(len(graph["edges"]), 2)

    # ---- AI 进度 ----

    def test_set_ai_progress_done(self):
        self.map_store.set_ai_progress(self.pid, "extract", 30)
        rm = self.map_store.get_role_map(self.pid)
        self.assertEqual(rm["ai_progress"], {"stage": "extract", "percent": 30})
        self.assertFalse(rm["ai_generated"])
        # done → ai_generated=true + generated_at
        self.map_store.set_ai_progress(self.pid, "done", 100)
        rm = self.map_store.get_role_map(self.pid)
        self.assertTrue(rm["ai_generated"])
        self.assertIsNotNone(rm["generated_at"])


if __name__ == "__main__":
    unittest.main()
