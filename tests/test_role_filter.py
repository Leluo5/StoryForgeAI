# -*- coding: utf-8 -*-
"""F8-T5 筛选服务单测。

覆盖：
- 维度候选值：从图谱节点属性聚合去重、排除空值、排序。
- 组合过滤：多维度 AND、单维度多值 OR、空过滤返回全图。
- 边保留仅当两端命中（无悬空边）。
- 结果含 matched_count/total_count。

使用临时目录隔离 data/。
"""

import os
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.novel_creation.role_store import RoleStore  # noqa: E402
from modules.plot.role_map_service import RoleMapStore  # noqa: E402


class RoleFilterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = os.path.join(self.tmp.name, "data", "projects")
        self.role_store = RoleStore(self.data_dir)
        self.map_store = RoleMapStore(self.data_dir, self.role_store)
        self.pid = "p1"
        # 4 角色，不同维度值
        self.a = self.role_store.create_role(
            self.pid, "林风眠", identity="主角",
            nationality="中原", camp="正道", race="人族", profession="剑客", age_group="青年",
        )
        self.b = self.role_store.create_role(
            self.pid, "沈雪落", identity="配角",
            nationality="北境", camp="魔道", race="妖族", profession="术士", age_group="少年",
        )
        self.c = self.role_store.create_role(
            self.pid, "顾惊蛰", identity="反派",
            nationality="中原", camp="魔道", race="人族", profession="谋士", age_group="中年",
        )
        self.d = self.role_store.create_role(
            self.pid, "江问天", identity="主角",
            nationality="西域", camp="中立", race="仙族", profession="武者", age_group="青年",
        )
        for r in (self.a, self.b, self.c, self.d):
            self.map_store.add_node(self.pid, r["id"])
        # 关联：A-B, B-C, C-D, A-D
        self.map_store.add_edge(self.pid, self.a["id"], self.b["id"], "ally")
        self.map_store.add_edge(self.pid, self.b["id"], self.c["id"], "enemy")
        self.map_store.add_edge(self.pid, self.c["id"], self.d["id"], "ally")
        self.map_store.add_edge(self.pid, self.a["id"], self.d["id"], "enemy")

    def tearDown(self):
        self.tmp.cleanup()

    def _ids(self, nodes):
        return {n["id"] for n in nodes}

    # ---- 维度候选值 ----

    def test_get_filter_options_aggregates(self):
        options = self.map_store.get_filter_options(self.pid)
        self.assertEqual(options["nationality"], sorted(["中原", "北境", "西域"]))
        self.assertEqual(options["camp"], sorted(["正道", "魔道", "中立"]))
        self.assertEqual(options["race"], sorted(["人族", "妖族", "仙族"]))
        self.assertEqual(options["age_group"], sorted(["少年", "青年", "中年"]))
        # 全部 6 维度都在
        for dim in ["nationality", "faith", "camp", "race", "profession", "age_group"]:
            self.assertIn(dim, options)

    def test_get_filter_options_excludes_empty(self):
        """无候选值的维度返回空数组。"""
        self.role_store.update_role(self.pid, self.a["id"], faith="天道")
        options = self.map_store.get_filter_options(self.pid)
        self.assertIn("天道", options["faith"])

    # ---- 组合过滤 ----

    def test_filter_single_dimension_or(self):
        """单维度多值 = OR。"""
        result = self.map_store.filter_graph(self.pid, {"camp": ["正道", "魔道"]})
        # A(正道), B/C(魔道) 命中；D(中立) 不命中
        self.assertEqual(result["matched_count"], 3)
        ids = self._ids(result["nodes"])
        self.assertEqual(ids, {self.a["id"], self.b["id"], self.c["id"]})

    def test_filter_multi_dimension_and(self):
        """多维度 = AND。"""
        result = self.map_store.filter_graph(
            self.pid, {"nationality": ["中原"], "camp": ["魔道"]},
        )
        # C 中原+魔道 命中；A 中原但正道 不命中；B 魔道但北境 不命中
        self.assertEqual(result["matched_count"], 1)
        self.assertEqual(self._ids(result["nodes"]), {self.c["id"]})

    def test_filter_empty_returns_all(self):
        """空过滤 / None → 全图。"""
        result = self.map_store.filter_graph(self.pid)
        self.assertEqual(result["matched_count"], 4)
        self.assertEqual(result["total_count"], 4)
        self.assertEqual(len(result["edges"]), 4)
        # 显式空 dict 同效
        result2 = self.map_store.filter_graph(self.pid, {})
        self.assertEqual(result2["matched_count"], 4)

    def test_filter_edges_only_between_matched(self):
        """边保留仅当两端命中。"""
        result = self.map_store.filter_graph(self.pid, {"camp": ["魔道"]})
        # B-C 两端都魔道 → 保留；A-B/A-D/C-D 有一端不命中 → 滤
        self.assertEqual(result["matched_count"], 2)  # B,C
        self.assertEqual(len(result["edges"]), 1)  # B-C
        self.assertEqual(result["edges"][0]["source"], self.b["id"])
        self.assertEqual(result["edges"][0]["target"], self.c["id"])

    def test_filter_no_match(self):
        result = self.map_store.filter_graph(self.pid, {"race": ["龙族"]})
        self.assertEqual(result["matched_count"], 0)
        self.assertEqual(result["nodes"], [])
        self.assertEqual(result["edges"], [])

    def test_filter_str_value(self):
        """单值字符串也接受。"""
        result = self.map_store.filter_graph(self.pid, {"camp": "魔道"})
        self.assertEqual(result["matched_count"], 2)


if __name__ == "__main__":
    unittest.main()
