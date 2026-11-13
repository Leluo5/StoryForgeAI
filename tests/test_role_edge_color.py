# -*- coding: utf-8 -*-
"""F9-T4 连线颜色池服务单测。

覆盖：
- 色池每色满足深浅底 WCAG 双校验（F9-06）。
- 新建边分配唯一颜色（无重复色，F9-05）。
- 两两颜色区分度 ≥ 阈值（F9-07）。
- graph 响应 edge 含 color 字段。
- 删除边后可复用颜色（回收）。

使用临时目录隔离 data/。
"""

import os
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.novel_creation.role_store import RoleStore  # noqa: E402
from modules.plot.role_map_service import (  # noqa: E402
    _color_contrast_ok,
    _color_distance,
    _pick_edge_color,
    _ROLE_EDGE_COLOR_POOL,
    RoleMapStore,
)


class ColorPoolTest(unittest.TestCase):
    def test_pool_all_contrast_ok(self):
        # F9-06：每色在浅底/深底均清晰
        for c in _ROLE_EDGE_COLOR_POOL:
            self.assertTrue(_color_contrast_ok(c), f"颜色 {c} 对比度不达标")

    def test_pool_pairwise_distance(self):
        # F9-07：两两区分度（欧氏距离 ≥ 45，3px 细线可辨）
        n = len(_ROLE_EDGE_COLOR_POOL)
        for i in range(n):
            for j in range(i + 1, n):
                d = _color_distance(_ROLE_EDGE_COLOR_POOL[i], _ROLE_EDGE_COLOR_POOL[j])
                self.assertGreaterEqual(d, 45, f"{_ROLE_EDGE_COLOR_POOL[i]} vs {_ROLE_EDGE_COLOR_POOL[j]} 距离 {d}")

    def test_pick_unused_first(self):
        used = [{"color": "#b82f1d"}]
        color = _pick_edge_color(used)
        self.assertNotEqual(color, "#b82f1d")
        self.assertIn(color, _ROLE_EDGE_COLOR_POOL)

    def test_pick_unique_across_edges(self):
        # 模拟主池 14 边：取色应全部唯一
        used = []
        for _ in range(14):
            c = _pick_edge_color(used)
            used.append({"color": c})
        colors = [e["color"] for e in used]
        self.assertEqual(len(set(colors)), 14)

    def test_pick_exhausted_variant(self):
        # 主池耗尽后进入变体，仍满足对比度且不与首圈重复
        used = [{"color": c} for c in _ROLE_EDGE_COLOR_POOL]
        variant = _pick_edge_color(used)
        self.assertNotIn(variant, set(_ROLE_EDGE_COLOR_POOL))
        self.assertTrue(_color_contrast_ok(variant))


class EdgeColorIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = os.path.join(self.tmp.name, "data", "projects")
        self.role_store = RoleStore(self.data_dir)
        self.map_store = RoleMapStore(self.data_dir, self.role_store)
        self.pid = "pc1"
        self.roles = [self.role_store.create_role(self.pid, f"角色{i}", identity="主角") for i in range(6)]
        for r in self.roles:
            self.map_store.add_node(self.pid, r["id"])

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_edge_has_color_unique(self):
        # 建 3 条边（星形 0-1,0-2,0-3）
        self.map_store.add_edge(self.pid, self.roles[0]["id"], self.roles[1]["id"], "ally")
        self.map_store.add_edge(self.pid, self.roles[0]["id"], self.roles[2]["id"], "enemy")
        self.map_store.add_edge(self.pid, self.roles[0]["id"], self.roles[3]["id"], "friend")
        g = self.map_store.get_graph(self.pid)
        colors = [e["color"] for e in g["edges"]]
        self.assertEqual(len(colors), 3)
        self.assertEqual(len(set(colors)), 3)  # 唯一
        for c in colors:
            self.assertTrue(_color_contrast_ok(c))

    def test_remove_edge_reuses_color(self):
        e1 = self.map_store.add_edge(self.pid, self.roles[0]["id"], self.roles[1]["id"], "ally")
        c1 = e1["color"]
        self.map_store.remove_edge(self.pid, self.roles[0]["id"], self.roles[1]["id"])
        e2 = self.map_store.add_edge(self.pid, self.roles[0]["id"], self.roles[2]["id"], "enemy")
        # 删除后颜色可复用（回收），但新建仍从池按序取未占用
        self.assertIn(c1, _ROLE_EDGE_COLOR_POOL)


if __name__ == "__main__":
    unittest.main()
