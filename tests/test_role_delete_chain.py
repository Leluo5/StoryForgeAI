# -*- coding: utf-8 -*-
"""F8-T3 角色删除全链路单测。

覆盖：
- 标红章节：角色出场章节 flagged_role_ids 追加；未出场章节不受影响；幂等。
- 清关联：图谱边移除 + 其他角色 relations 双向清理。
- 删 Role：roles 数组移除 + role_bindings/agent_sessions 级联删。
- 移出图谱：role_map.nodes 移除。
- 清独立剧情：plot_tree 中 role_id 匹配节点删除（含级联后代）。
- 原子失败：角色不存在 → 404，不做任何变更。

使用临时目录隔离 data/。
"""

import os
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.common.errors import AppError  # noqa: E402
from modules.novel_creation.project_store import ProjectStore  # noqa: E402
from modules.novel_creation.role_store import RoleStore  # noqa: E402
from modules.plot.plot_tree import PlotTreeStore  # noqa: E402
from modules.plot.role_map_service import RoleMapStore  # noqa: E402


class DeleteRoleChainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = self.tmp.name
        self.data_dir = os.path.join(base, "data", "projects")
        self.plot_dir = os.path.join(base, "data", "plot_trees")
        self.project_store = ProjectStore(self.data_dir)
        self.role_store = RoleStore(self.data_dir)
        self.plot_store = PlotTreeStore(self.plot_dir)
        self.map_store = RoleMapStore(
            self.data_dir, self.role_store,
            self.project_store, self.plot_store,
        )
        self.pid = "p1"
        # 创建项目，用返回的真实 id（项目文件 = <project_id>.json，角色同文件）
        proj = self.project_store.create_project("测试项目")
        self.pid = proj["id"]
        # 建 3 角色 A/B/C
        self.a = self.role_store.create_role(self.pid, "林风眠", identity="主角")
        self.b = self.role_store.create_role(self.pid, "沈雪落", identity="配角")
        self.c = self.role_store.create_role(self.pid, "顾惊蛰", identity="反派")
        # 全部加入图谱
        for r in (self.a, self.b, self.c):
            self.map_store.add_node(self.pid, r["id"])
        # A-B 关联（双向），B-C 关联
        self.map_store.add_edge(self.pid, self.a["id"], self.b["id"], "ally")
        self.map_store.add_edge(self.pid, self.b["id"], self.c["id"], "enemy")

    def tearDown(self):
        self.tmp.cleanup()

    def _add_chapter_with_roles(self, title, role_ids):
        ch = self.project_store.create_chapter(self.pid, title, order=None)
        self.project_store.update_chapter(
            self.pid, ch["id"], role_ids=role_ids,
        )
        return ch

    def test_delete_role_chain_full(self):
        """全链路：标红 + 清关联 + 删角色 + 移出图谱。"""
        ch = self._add_chapter_with_roles("第一章", [self.a["id"], self.b["id"]])
        ch2 = self._add_chapter_with_roles("第二章", [self.c["id"]])

        result = self.map_store.delete_role_chain(self.pid, self.b["id"])

        # 标红章节
        self.assertIn(ch["id"], result["flagged_chapters"])
        self.assertNotIn(ch2["id"], result["flagged_chapters"])
        # 章节标红字段
        ch_after = self.project_store.get_chapter(self.pid, ch["id"])
        self.assertIn(self.b["id"], ch_after["flagged_role_ids"])
        ch2_after = self.project_store.get_chapter(self.pid, ch2["id"])
        self.assertEqual(ch2_after["flagged_role_ids"], [])

        # 清关联：B 相关边全删，剩余 A-C? 无直接边 → 0 边
        self.assertEqual(result["removed_edges"], 2)
        rm = self.map_store.get_role_map(self.pid)
        self.assertEqual(rm["edges"], [])

        # 删角色 + 级联
        self.assertEqual(result["deleted_role"], self.b["id"])
        with self.assertRaises(AppError) as ctx:
            self.role_store.get_role(self.pid, self.b["id"])
        self.assertEqual(ctx.exception.code, 404)
        # A/C 的 relations 双向清理
        a = self.role_store.get_role(self.pid, self.a["id"])
        c = self.role_store.get_role(self.pid, self.c["id"])
        self.assertEqual(a["relations"], [])
        self.assertEqual(c["relations"], [])

        # 移出图谱
        self.assertNotIn(self.b["id"], rm["nodes"])

    def test_delete_role_chain_clears_plot_nodes(self):
        """清独立剧情：role_id 匹配节点删除。"""
        # 建剧情树，A 角色关联 2 节点（父子）
        tree = self.plot_store.create_tree("主线", source="manual")
        parent = self.plot_store.add_node(
            tree, "A出场", role_id=self.a["id"],
        )
        child = self.plot_store.add_node(
            tree, "A子节点", parent_id=parent["id"], role_id=self.a["id"],
        )
        # B 关联节点（不应被删）
        b_node = self.plot_store.add_node(tree, "B出场", role_id=self.b["id"])

        result = self.map_store.delete_role_chain(self.pid, self.a["id"])

        self.assertIn(parent["id"], result["plot_nodes_deleted"])
        self.assertIn(child["id"], result["plot_nodes_deleted"])
        # 树中剩余仅 B 节点
        tree_after = self.plot_store.load_tree(tree["id"])
        remaining = [n["id"] for n in tree_after["nodes"]]
        self.assertNotIn(parent["id"], remaining)
        self.assertNotIn(child["id"], remaining)
        self.assertIn(b_node["id"], remaining)

    def test_delete_role_not_found_no_changes(self):
        """角色不存在 → 404，不做任何变更。"""
        with self.assertRaises(AppError) as ctx:
            self.map_store.delete_role_chain(self.pid, "nonexistent")
        self.assertEqual(ctx.exception.code, 404)
        # 图谱与角色均未变
        self.assertEqual(len(self.map_store.get_role_map(self.pid)["nodes"]), 3)
        self.assertEqual(len(self.role_store.list_roles(self.pid)), 3)

    def test_delete_role_chain_idempotent_flag(self):
        """重复删除同一角色（第二次）→ 404（角色已不存在）。"""
        self.map_store.delete_role_chain(self.pid, self.c["id"])
        with self.assertRaises(AppError) as ctx:
            self.map_store.delete_role_chain(self.pid, self.c["id"])
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
