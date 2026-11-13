# -*- coding: utf-8 -*-
"""F8-T12 / F8-15 性能测试：100 节点图谱服务端耗时 ≤ 100ms。

覆盖验收标准 F8-15：
- get_graph（图谱读取 + 节点属性聚合）
- filter_graph（6 维度组合筛选）
- dimension options（维度候选值聚合）

100 节点 + 150 边规模，服务端数据路径耗时逐次断言 < 100ms。
前端渲染 FPS（F8-16）不在本脚本范围（需真实浏览器采样，见 F8-T13）。

使用临时目录隔离 data/。
"""

import os
import statistics
import sys
import tempfile
import time
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.novel_creation.role_store import RoleStore  # noqa: E402
from modules.plot.role_map_service import RoleMapStore  # noqa: E402

THRESHOLD_MS = 100.0  # F8-15 阈值
N_ROLES = 100
N_EDGES = 150

DIMENSIONS = [
    ("nationality", ["中原", "北境", "西域", "东海"]),
    ("faith", ["天道", "魔道", "无"]),
    ("camp", ["正道", "魔道", "中立"]),
    ("race", ["人族", "妖族", "仙族"]),
    ("profession", ["剑客", "术士", "谋士", "医者"]),
    ("age_group", ["少年", "青年", "中年", "老年"]),
]


def _ms(duration_s: float) -> float:
    return duration_s * 1000.0


class RoleMapPerfTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = os.path.join(self.tmp.name, "data", "projects")
        self.role_store = RoleStore(self.data_dir)
        self.map_store = RoleMapStore(self.data_dir, self.role_store)
        self.pid = "perf1"
        self._seed()

    def tearDown(self):
        self.tmp.cleanup()

    def _seed(self):
        """构造 100 角色 + 150 边基准数据。"""
        role_ids = []
        for i in range(N_ROLES):
            dims = {k: vs[i % len(vs)] for k, vs in DIMENSIONS}
            r = self.role_store.create_role(
                self.pid, "角色%03d" % i, identity="主角" if i % 7 == 0 else "配角",
                **dims,
            )
            role_ids.append(r["id"])
        for rid in role_ids:
            self.map_store.add_node(self.pid, rid)
        # 边：环形 + 交叉，共 N_EDGES 条，均落在已入图谱节点上。
        # add_edge 对重复无向边报 400，故用集合去重；步长自增直到凑满。
        seen = set()

        def _key(a, b):
            return tuple(sorted((a, b)))

        created = 0
        step = 1
        while created < N_EDGES and step < 60:
            for i in range(N_ROLES):
                if created >= N_EDGES:
                    break
                a = role_ids[i % N_ROLES]
                b = role_ids[(i * step + 1) % N_ROLES]
                if a == b:
                    b = role_ids[(i + 1) % N_ROLES]
                k = _key(a, b)
                if k in seen:
                    continue
                seen.add(k)
                self.map_store.add_edge(self.pid, a, b, "ally" if i % 2 == 0 else "enemy")
                created += 1
            step += 1
        self._edge_count = created

    # ---------- 耗时工具 ----------

    def _bench(self, fn, runs=20):
        """跑 runs 次，返回中位数耗时（ms），并断言每次均 < 阈值。"""
        samples = []
        for _ in range(runs):
            start = time.perf_counter()
            result = fn()
            samples.append(_ms(time.perf_counter() - start))
            self.assertLess(
                samples[-1], THRESHOLD_MS,
                "%s 单次耗时 %.2fms 超过阈值 %.0fms" % (fn.__name__, samples[-1], THRESHOLD_MS),
            )
        self._last_ms = statistics.median(samples)
        return result

    # ---------- F8-15 数据加载 ----------

    def test_get_graph_under_100ms(self):
        graph = self._bench(lambda: self.map_store.get_graph(self.pid))
        self.assertEqual(len(graph["nodes"]), N_ROLES)
        self.assertEqual(len(graph["edges"]), self._edge_count)
        print("\n[PERF] get_graph 中位 %.2fms (阈值 100ms)" % self._last_ms)

    # ---------- F8-15 筛选 ----------

    def test_filter_graph_under_100ms(self):
        filt = {"nationality": ["中原", "北境"], "race": ["人族"]}
        graph = self._bench(lambda: self.map_store.filter_graph(self.pid, filt))
        # 空 filter 返回全图，组合 filter 收敛子集
        self.assertLessEqual(len(graph["nodes"]), N_ROLES)
        print("\n[PERF] filter_graph 中位 %.2fms (阈值 100ms)" % self._last_ms)

    def test_filter_empty_returns_full_graph_under_100ms(self):
        graph = self._bench(lambda: self.map_store.filter_graph(self.pid, {}))
        self.assertEqual(len(graph["nodes"]), N_ROLES)
        print("\n[PERF] filter_graph(空) 中位 %.2fms (阈值 100ms)" % self._last_ms)

    # ---------- F8-07 维度候选聚合 ----------

    def test_get_filter_options_under_100ms(self):
        options = self._bench(lambda: self.map_store.get_filter_options(self.pid))
        self.assertTrue(options)
        print("\n[PERF] get_filter_options 中位 %.2fms (阈值 100ms)" % self._last_ms)


class RoleMapFrontendPerfTest(unittest.TestCase):
    """F8-16 前端不变量守卫：交互态 60fps 的修复不能被回退。

    FPS 本身需真实浏览器采样（见 F8-T13），此处以源码不变量兜底，
    防止拖拽坐标被改回「每次 move 直接写 fx/fy」导致单帧多次 tick 掉帧。
    """

    @classmethod
    def setUpClass(cls):
        cls.js_path = os.path.join(BASE, "static", "js", "role_map_panel.js")
        with open(cls.js_path, encoding="utf-8") as fh:
            cls.src = fh.read()

    def test_drag_target_throttled_by_raf(self):
        """拖拽 move 回调必须合帧：同帧多次 move 只保留最后一次坐标。"""
        self.assertIn("pending = { node: d, x: event.x, y: event.y }", self.src)
        self.assertIn("if (rafId != null) return;", self.src)

    def test_drag_move_does_not_write_fx_fy_directly(self):
        """move 回调内不得直接写 fx/fy（掉帧根因）。"""
        marker = "if (rafId != null) return;"
        self.assertGreater(self.src.find(marker), -1)
        drag_body = self.src[self.src.find(".on('drag', function"):
                        self.src.find(".on('end', function")]
        self.assertNotIn("d.fx = event.x", drag_body)
        self.assertNotIn("d.fy = event.y", drag_body)

    def test_link_labels_skipped_while_dragging(self):
        """拖拽期跳过边标签中点重排，松手后恢复。"""
        self.assertIn("if (self._draggingNodeId == null) {", self.src)
        self.assertIn("self._draggingNodeId = d.id;", self.src)
        self.assertIn("self._draggingNodeId = null;", self.src)


if __name__ == "__main__":
    unittest.main()