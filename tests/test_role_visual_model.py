# -*- coding: utf-8 -*-
"""F9-T1 Role 形象特征模型扩展单测。

覆盖：
- 新建角色默认 visual_features 结构化对象（五维度空串）与 avatar 空串。
- 创建时传入 visual_features/avatar 持久化正确。
- update_role 白名单允许写入 visual_features/avatar。
- 更新后重新加载（磁盘持久化）字段保留。
- 未知字段（非白名单）拒绝。

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


class RoleVisualModelTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = os.path.join(self.tmp.name, "data", "projects")
        self.store = RoleStore(self.data_dir)
        self.pid = "pv1"

    def tearDown(self):
        self.tmp.cleanup()

    def test_new_role_default_visual_fields(self):
        role = self.store.create_role(self.pid, "林风眠")
        vf = role["visual_features"]
        self.assertIsInstance(vf, dict)
        # 五维度全为空串
        for k in ("hair_style", "hair_color", "face_features", "outfit_style", "expression"):
            self.assertEqual(vf[k], "")
        self.assertEqual(role["avatar"], "")

    def test_create_role_with_visual_features_persist(self):
        vf = {
            "hair_style": "长发",
            "hair_color": "黑",
            "face_features": "剑眉星目",
            "outfit_style": "侠客",
            "expression": "坚毅",
        }
        role = self.store.create_role(self.pid, "沈雪落", visual_features=vf, avatar="/api/role-map/avatar/abc123")
        self.assertEqual(role["visual_features"], vf)
        self.assertEqual(role["avatar"], "/api/role-map/avatar/abc123")
        # 重新加载持久化验证
        got = self.store.get_role(self.pid, role["id"])
        self.assertEqual(got["visual_features"], vf)
        self.assertEqual(got["avatar"], "/api/role-map/avatar/abc123")

    def test_update_role_visual_features_whitelist(self):
        role = self.store.create_role(self.pid, "顾惊蛰")
        new_vf = {"hair_style": "马尾", "hair_color": "红", "face_features": "冷峻", "outfit_style": "军装", "expression": "冷傲"}
        updated = self.store.update_role(self.pid, role["id"], visual_features=new_vf, avatar="/api/role-map/avatar/def456")
        self.assertEqual(updated["visual_features"], new_vf)
        self.assertEqual(updated["avatar"], "/api/role-map/avatar/def456")
        # 磁盘持久化
        got = self.store.get_role(self.pid, role["id"])
        self.assertEqual(got["visual_features"]["hair_style"], "马尾")
        self.assertEqual(got["avatar"], "/api/role-map/avatar/def456")

    def test_update_role_unknown_field_rejected(self):
        role = self.store.create_role(self.pid, "白疏影")
        with self.assertRaises(AppError):
            self.store.update_role(self.pid, role["id"], portrait="/tmp/x.png")


if __name__ == "__main__":
    unittest.main()
