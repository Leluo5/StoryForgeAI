# -*- coding: utf-8 -*-
"""剧情树引擎测试（F7-T1/T3/T4/T5）。

覆盖：存储 CRUD、树操作（增删改/级联/自环/环路）、双向联动（push/pull/去重）、
导入导出（export 全量/单节点、import 合法/非法结构）。
使用临时目录隔离 data/，不污染真实数据。
"""

import os
import sys
import tempfile
import unittest

# 确保项目根可导入
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules.plot.plot_tree import PlotTreeStore


class PlotTreeEngineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = PlotTreeStore(os.path.join(self.tmp.name, "data", "plot"))
        self.tree = self.store.create_tree("雾都疑案主线", "manual")

    def tearDown(self):
        self.tmp.cleanup()

    # ---- F7-T1 存储 CRUD ----

    def test_create_tree_defaults(self):
        self.assertTrue(self.tree["id"])
        self.assertEqual(self.tree["name"], "雾都疑案主线")
        self.assertEqual(self.tree["source"], "manual")
        self.assertEqual(self.tree["nodes"], [])
        self.assertEqual(self.tree["links"], [])
        self.assertIsNone(self.tree["root_node_id"])

    def test_create_tree_empty_name_400(self):
        with self.assertRaises(AppError) as ctx:
            self.store.create_tree("   ")
        self.assertEqual(ctx.exception.code, 400)

    def test_create_tree_bad_source_400(self):
        with self.assertRaises(AppError) as ctx:
            self.store.create_tree("t", "bad_source")
        self.assertEqual(ctx.exception.code, 400)

    def test_load_tree_roundtrip(self):
        loaded = self.store.load_tree(self.tree["id"])
        self.assertEqual(loaded["id"], self.tree["id"])
        self.assertEqual(loaded["name"], "雾都疑案主线")

    def test_load_tree_not_found_404(self):
        with self.assertRaises(AppError) as ctx:
            self.store.load_tree("nonexistent")
        self.assertEqual(ctx.exception.code, 404)

    def test_save_tree_updates_timestamp(self):
        loaded = self.store.load_tree(self.tree["id"])
        old_updated = loaded["updated_at"]
        self.store.add_node(self.tree, "开端", "start")
        reloaded = self.store.load_tree(self.tree["id"])
        # now_iso 秒级精度，同秒写可能相等；断言不早于原时间即可
        self.assertGreaterEqual(reloaded["updated_at"], old_updated)

    def test_delete_tree(self):
        self.assertTrue(self.store.delete_tree(self.tree["id"]))
        self.assertFalse(self.store.delete_tree(self.tree["id"]))

    def test_list_trees(self):
        self.store.create_tree("另一棵", "outline")
        trees = self.store.list_trees()
        self.assertEqual(len(trees), 2)
        self.assertIn("nodes_count", trees[0])
        self.assertIn("updated_at", trees[0])

    # ---- F7-T3 树操作 ----

    def test_add_node_first_becomes_root(self):
        node = self.store.add_node(self.tree, "开端", "start")
        loaded = self.store.load_tree(self.tree["id"])
        self.assertEqual(loaded["root_node_id"], node["id"])
        self.assertEqual(len(loaded["nodes"]), 1)

    def test_add_node_with_parent(self):
        root = self.store.add_node(self.tree, "开端", "start")
        child = self.store.add_node(self.tree, "初遇", "main", parent_id=root["id"])
        loaded = self.store.load_tree(self.tree["id"])
        root_loaded = self.store.get_node(loaded, root["id"])
        self.assertIn(child["id"], root_loaded["children_ids"])

    def test_add_node_bad_type_400(self):
        with self.assertRaises(AppError) as ctx:
            self.store.add_node(self.tree, "x", "bad_type")
        self.assertEqual(ctx.exception.code, 400)

    def test_add_node_bad_parent_404(self):
        with self.assertRaises(AppError) as ctx:
            self.store.add_node(self.tree, "x", "main", parent_id="missing")
        self.assertEqual(ctx.exception.code, 404)

    def test_edit_node(self):
        node = self.store.add_node(self.tree, "初遇", "main")
        edited = self.store.edit_node(self.tree, node["id"], {"label": "初遇升级", "type": "turn", "tags": ["主线"]})
        self.assertEqual(edited["label"], "初遇升级")
        self.assertEqual(edited["type"], "turn")
        self.assertEqual(edited["tags"], ["主线"])

    def test_edit_node_empty_label_400(self):
        node = self.store.add_node(self.tree, "初遇")
        with self.assertRaises(AppError) as ctx:
            self.store.edit_node(self.tree, node["id"], {"label": "  "})
        self.assertEqual(ctx.exception.code, 400)

    def test_edit_node_not_found_404(self):
        with self.assertRaises(AppError) as ctx:
            self.store.edit_node(self.tree, "missing", {"label": "x"})
        self.assertEqual(ctx.exception.code, 404)

    def test_delete_node_cascade(self):
        root = self.store.add_node(self.tree, "开端", "start")
        child = self.store.add_node(self.tree, "初遇", "main", parent_id=root["id"])
        grandchild = self.store.add_node(self.tree, "真相", "turn", parent_id=child["id"])
        # 建立关联
        self.store.add_link(self.tree, child["id"], grandchild["id"], "前置")
        result = self.store.delete_node(self.tree, root["id"])
        loaded = self.store.load_tree(self.tree["id"])
        self.assertEqual(loaded["nodes"], [])
        self.assertEqual(loaded["links"], [])
        self.assertIsNone(loaded["root_node_id"])
        self.assertIn(root["id"], result["deleted"])
        self.assertIn(child["id"], result["deleted"])
        self.assertIn(grandchild["id"], result["deleted"])

    def test_delete_node_not_found_404(self):
        with self.assertRaises(AppError) as ctx:
            self.store.delete_node(self.tree, "missing")
        self.assertEqual(ctx.exception.code, 404)

    def test_add_link_self_loop_400(self):
        node = self.store.add_node(self.tree, "开端", "start")
        with self.assertRaises(AppError) as ctx:
            self.store.add_link(self.tree, node["id"], node["id"], "前置")
        self.assertEqual(ctx.exception.code, 400)

    def test_add_link_cycle_400(self):
        a = self.store.add_node(self.tree, "A", "start")
        b = self.store.add_node(self.tree, "B", "main")
        self.store.add_link(self.tree, a["id"], b["id"], "前置")
        # 再连 b→a 会成环
        with self.assertRaises(AppError) as ctx:
            self.store.add_link(self.tree, b["id"], a["id"], "前置")
        self.assertEqual(ctx.exception.code, 400)

    def test_add_link_nonlinear_allows_cycle(self):
        a = self.store.add_node(self.tree, "A", "start")
        b = self.store.add_node(self.tree, "B", "main")
        self.store.add_link(self.tree, a["id"], b["id"], "前置")
        # 非线性允许回环
        link = self.store.add_link(self.tree, b["id"], a["id"], "非线性")
        self.assertEqual(link["type"], "非线性")

    def test_add_link_duplicate_409(self):
        a = self.store.add_node(self.tree, "A", "start")
        b = self.store.add_node(self.tree, "B", "main")
        self.store.add_link(self.tree, a["id"], b["id"], "前置")
        with self.assertRaises(AppError) as ctx:
            self.store.add_link(self.tree, a["id"], b["id"], "前置")
        self.assertEqual(ctx.exception.code, 409)

    def test_add_link_bad_type_400(self):
        a = self.store.add_node(self.tree, "A", "start")
        b = self.store.add_node(self.tree, "B", "main")
        with self.assertRaises(AppError) as ctx:
            self.store.add_link(self.tree, a["id"], b["id"], "bad")
        self.assertEqual(ctx.exception.code, 400)

    def test_delete_link(self):
        a = self.store.add_node(self.tree, "A", "start")
        b = self.store.add_node(self.tree, "B", "main")
        self.store.add_link(self.tree, a["id"], b["id"], "前置")
        self.assertTrue(self.store.delete_link(self.tree, a["id"], b["id"], "前置"))
        self.assertFalse(self.store.delete_link(self.tree, a["id"], b["id"], "前置"))

    def test_save_layout(self):
        n1 = self.store.add_node(self.tree, "A", "start")
        n2 = self.store.add_node(self.tree, "B", "main")
        count = self.store.save_layout(self.tree, [
            {"id": n1["id"], "position": {"x": 500, "y": 300}},
            {"id": n2["id"], "position": {"x": 700, "y": 400}},
        ])
        self.assertEqual(count, 2)
        loaded = self.store.load_tree(self.tree["id"])
        self.assertEqual(self.store.get_node(loaded, n1["id"])["position"], {"x": 500, "y": 300})

    # ---- F7-T4 双向联动 ----

    def test_push_to_room_default_context(self):
        root = self.store.add_node(self.tree, "开端", "start")
        self.store.add_node(self.tree, "初遇", "main", parent_id=root["id"])
        result = self.store.push_to_room(self.tree, "room_001")
        self.assertEqual(result["injected"], 2)  # 根 + 直接子节点
        self.assertEqual(result["context_nodes"][0]["id"], root["id"])

    def test_push_to_room_empty_tree_409(self):
        with self.assertRaises(AppError) as ctx:
            self.store.push_to_room(self.tree, "room_001")
        self.assertEqual(ctx.exception.code, 409)

    def test_push_to_room_no_room_400(self):
        self.store.add_node(self.tree, "A", "start")
        with self.assertRaises(AppError) as ctx:
            self.store.push_to_room(self.tree, "")
        self.assertEqual(ctx.exception.code, 400)

    def test_push_to_room_specific_nodes(self):
        a = self.store.add_node(self.tree, "A", "start")
        b = self.store.add_node(self.tree, "B", "main")
        result = self.store.push_to_room(self.tree, "room_001", [b["id"]])
        self.assertEqual(result["injected"], 1)
        self.assertEqual(result["context_nodes"][0]["id"], b["id"])

    def test_pull_from_room_new_nodes(self):
        root = self.store.add_node(self.tree, "开端", "start")
        steps = [
            {"id": "s1", "label": "推衍一", "content": "内容一"},
            {"id": "s2", "label": "推衍二", "content": "内容二"},
        ]
        result = self.store.pull_from_room(self.tree, "room_001", steps, parent_node_id=root["id"])
        self.assertEqual(result["added"], 2)
        loaded = self.store.load_tree(self.tree["id"])
        new_nodes = [n for n in loaded["nodes"] if n["source"] == "derivation"]
        self.assertEqual(len(new_nodes), 2)
        self.assertTrue(all(n["linked_room_id"] == "room_001" for n in new_nodes))
        # 挂到根下
        root_loaded = self.store.get_node(loaded, root["id"])
        self.assertEqual(len(root_loaded["children_ids"]), 2)

    def test_pull_from_room_dedup(self):
        root = self.store.add_node(self.tree, "开端", "start")
        steps = [{"id": "s1", "label": "推衍一", "content": "内容一"}]
        self.store.pull_from_room(self.tree, "room_001", steps, parent_node_id=root["id"])
        # 重复回写同步骤应去重
        result = self.store.pull_from_room(self.tree, "room_001", steps, parent_node_id=root["id"])
        self.assertEqual(result["added"], 0)
        loaded = self.store.load_tree(self.tree["id"])
        derivation_count = len([n for n in loaded["nodes"] if n["source"] == "derivation"])
        self.assertEqual(derivation_count, 1)

    def test_pull_from_room_empty_409(self):
        with self.assertRaises(AppError) as ctx:
            self.store.pull_from_room(self.tree, "room_001", [])
        self.assertEqual(ctx.exception.code, 409)

    def test_pull_from_room_no_room_400(self):
        with self.assertRaises(AppError) as ctx:
            self.store.pull_from_room(self.tree, "", [{"id": "s1", "label": "x"}])
        self.assertEqual(ctx.exception.code, 400)

    # ---- F7-T5 导入导出 ----

    def test_export_all(self):
        root = self.store.add_node(self.tree, "开端", "start")
        child = self.store.add_node(self.tree, "初遇", "main", parent_id=root["id"])
        self.store.add_link(self.tree, root["id"], child["id"], "前置")
        exported = self.store.export_tree(self.tree, "all")
        self.assertEqual(len(exported["nodes"]), 2)
        self.assertEqual(len(exported["links"]), 1)
        self.assertIn("created_at", exported)

    def test_export_node_subchain(self):
        root = self.store.add_node(self.tree, "开端", "start")
        child = self.store.add_node(self.tree, "初遇", "main", parent_id=root["id"])
        sibling = self.store.add_node(self.tree, "分支", "branch", parent_id=root["id"])
        self.store.add_link(self.tree, root["id"], child["id"], "前置")
        exported = self.store.export_tree(self.tree, "node", root["id"])
        # 导出根及其全部后代（含 sibling）
        self.assertEqual(len(exported["nodes"]), 3)
        self.assertEqual(exported["export_node_id"], root["id"])

    def test_export_node_no_node_id_400(self):
        self.store.add_node(self.tree, "A", "start")
        with self.assertRaises(AppError) as ctx:
            self.store.export_tree(self.tree, "node")
        self.assertEqual(ctx.exception.code, 400)

    def test_import_merge(self):
        root = self.store.add_node(self.tree, "开端", "start")
        # merge 导入纯新增节点（不带原 root，避免重复追加）
        import_data = {
            "nodes": [
                {"id": "n_new", "label": "导入节点", "type": "main", "content": "",
                 "parent_id": None, "children_ids": [], "source": "generated", "tags": [],
                 "position": {"x": 0, "y": 0}, "linked_room_id": None},
            ],
            "links": [],
            "root_node_id": "n_new",
        }
        result = self.store.import_tree(import_data, "merge", target_tree_id=self.tree["id"])
        self.assertEqual(result["mode"], "merge")
        loaded = self.store.load_tree(self.tree["id"])
        self.assertEqual(len(loaded["nodes"]), 2)
        self.assertNotEqual(loaded["nodes"][1]["id"], "n_new")  # 合并后 id 重映射

    def test_import_replace(self):
        self.store.add_node(self.tree, "开端", "start")
        import_data = {
            "nodes": [{"id": "i1", "label": "导入根", "type": "start", "content": "", "parent_id": None,
                       "children_ids": [], "source": "generated", "tags": [], "position": {"x": 1, "y": 1},
                       "linked_room_id": None}],
            "links": [],
            "root_node_id": "i1",
        }
        result = self.store.import_tree(import_data, "replace", target_tree_id=self.tree["id"])
        self.assertEqual(result["mode"], "replace")
        loaded = self.store.load_tree(self.tree["id"])
        self.assertEqual(len(loaded["nodes"]), 1)
        self.assertEqual(loaded["nodes"][0]["label"], "导入根")
        self.assertNotEqual(loaded["nodes"][0]["id"], "i1")  # id 已重映射

    def test_import_invalid_structure_400(self):
        with self.assertRaises(AppError) as ctx:
            self.store.import_tree({"nodes": "bad", "links": []}, "merge", target_tree_id=self.tree["id"])
        self.assertEqual(ctx.exception.code, 400)

    def test_import_invalid_link_ref_400(self):
        with self.assertRaises(AppError) as ctx:
            self.store.import_tree(
                {"nodes": [{"id": "n1", "label": "A", "type": "main"}],
                 "links": [{"from": "n1", "to": "missing", "type": "前置"}]},
                "merge", target_tree_id=self.tree["id"],
            )
        self.assertEqual(ctx.exception.code, 400)

    def test_import_bad_mode_400(self):
        with self.assertRaises(AppError) as ctx:
            self.store.import_tree({"nodes": [], "links": []}, "bad", target_tree_id=self.tree["id"])
        self.assertEqual(ctx.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
