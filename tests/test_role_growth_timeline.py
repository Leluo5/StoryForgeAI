# -*- coding: utf-8 -*-
"""F8-T10/F8-11 成长线时间线单测。

覆盖：
- 角色过滤：仅返回 role_id 匹配节点，未匹配节点被排除。
- 时间线排序（F8-11 验收标准）：按「树顺序 → 树内节点顺序」稳定排序，
  跨多棵树时先树顺序、后节点顺序，不交错。
- 字段完整性：输出含 id/label/type/order/tree_id/tree_name。
- 异常容错：load_tree 抛错跳过该树；list_trees 抛错返回空列表。

使用 fake plot_store 注入，避免依赖真实剧情树持久化。
"""

import sys
import unittest

BASE = __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0]
sys.path.insert(0, BASE)

from modules.plot.routes_role_map import _collect_growth_nodes  # noqa: E402


class FakePlotStore:
    """最小 plot_store 替身：list_trees / load_tree。"""

    def __init__(self, trees, broken_load=()):
        self._trees = trees
        self._broken_load = set(broken_load)

    def list_trees(self):
        return self._trees

    def load_tree(self, tree_id):
        if tree_id in self._broken_load:
            raise RuntimeError("load fail")
        for t in self._trees:
            if t["id"] == tree_id:
                return t["data"]
        raise KeyError(tree_id)


class GrowthTimelineOrderTest(unittest.TestCase):
    def _single_tree(self, role_nodes):
        return FakePlotStore([{"id": "t1", "name": "主线", "data": {"nodes": role_nodes}}])

    def test_only_matched_role_nodes_returned(self):
        """F8-11：仅返回 role_id 匹配节点。"""
        nodes = [
            {"id": "n1", "label": "觉醒", "type": "plot", "role_id": "r1"},
            {"id": "n2", "label": "他人事件", "type": "plot", "role_id": "r2"},
            {"id": "n3", "label": "对决", "type": "plot", "role_id": "r1"},
        ]
        got = _collect_growth_nodes(self._single_tree(nodes), "r1")
        self.assertEqual([n["id"] for n in got], ["n1", "n3"])

    def test_sort_by_tree_then_node_order(self):
        """F8-11：多树时先按树顺序、再按树内节点顺序排序（不交错）。"""
        # list_trees 顺序：t2（主线）先、t1（支线）后。
        # 关键反例：n2 在 t1 中数组下标为 0（order=0），比 t2 中的 n1（order=1）
        # 数值更小 —— 旧实现按 order 全局排序会交错成 n2,n3,n1；
        # 正确实现必须保持树整体先后：t2 的 n3、n1 全部先出，t1 的 n2 最后。
        store = FakePlotStore([
            {"id": "t2", "name": "主线", "data": {"nodes": [
                {"id": "n3", "label": "决战", "role_id": "r1"},
                {"id": "n1", "label": "起源", "role_id": "r1"},
                {"id": "n0", "label": "无关", "role_id": "r9"},
            ]}},
            {"id": "t1", "name": "支线", "data": {"nodes": [
                {"id": "n2", "label": "支线事件", "role_id": "r1"},
            ]}},
        ])
        got = _collect_growth_nodes(store, "r1")
        ids = [n["id"] for n in got]
        # 树内保持数组相对序（n3 前于 n1），树间不交错
        self.assertEqual(ids, ["n3", "n1", "n2"])
        self.assertEqual([n["tree_id"] for n in got], ["t2", "t2", "t1"])

    def test_within_tree_preserves_array_order(self):
        """F8-11：单树内严格按节点数组顺序输出。"""
        nodes = [
            {"id": "a", "label": "少年", "role_id": "r1"},
            {"id": "b", "label": "青年", "role_id": "r1"},
            {"id": "c", "label": "中年", "role_id": "r1"},
        ]
        got = _collect_growth_nodes(self._single_tree(nodes), "r1")
        self.assertEqual([n["id"] for n in got], ["a", "b", "c"])
        self.assertEqual([n["order"] for n in got], [0, 1, 2])

    def test_output_fields_complete(self):
        """F8-11：输出字段完整。"""
        nodes = [{"id": "n1", "label": "觉醒", "type": "plot", "role_id": "r1"}]
        got = _collect_growth_nodes(self._single_tree(nodes), "r1")
        self.assertEqual(len(got), 1)
        item = got[0]
        for k in ("id", "label", "type", "order", "tree_id", "tree_name"):
            self.assertIn(k, item)
        self.assertEqual(item["tree_name"], "主线")

    def test_unmatched_role_returns_empty(self):
        nodes = [{"id": "n1", "label": "x", "role_id": "r2"}]
        self.assertEqual(_collect_growth_nodes(self._single_tree(nodes), "r1"), [])

    def test_no_role_id_returns_empty(self):
        self.assertEqual(_collect_growth_nodes(FakePlotStore([]), "r1"), [])


class GrowthTimelineResilienceTest(unittest.TestCase):
    def test_broken_tree_skipped(self):
        """单树 load 抛错应跳过，不整体失败。"""
        store = FakePlotStore([
            {"id": "t1", "name": "坏树", "data": {"nodes": [
                {"id": "n1", "label": "x", "role_id": "r1"}]}},
            {"id": "t2", "name": "好树", "data": {"nodes": [
                {"id": "n2", "label": "y", "role_id": "r1"}]}},
        ], broken_load=("t1",))
        got = _collect_growth_nodes(store, "r1")
        self.assertEqual([n["id"] for n in got], ["n2"])

    def test_list_trees_error_returns_empty(self):
        """list_trees 抛错应返回空列表。"""

        class BrokenStore:
            def list_trees(self):
                raise RuntimeError("boom")

        self.assertEqual(_collect_growth_nodes(BrokenStore(), "r1"), [])


if __name__ == "__main__":
    unittest.main()