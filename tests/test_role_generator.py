# -*- coding: utf-8 -*-
"""F8-T1 角色数据模型扩展单测。

覆盖：
1. 字段池配置加载：config/role_map_pools.json 存在且结构完整；缺文件/损坏 → 默认池兜底。
2. 随机生成函数：seed 复现（同一 seed 产出相同结果）、字段齐全、范围合法。
3. 年龄段归档：边界映射（16/25/26/45/46/60/61/70）+ 越界/None → ""。
4. 随机生成结果可写入 RoleStore（create_role 接受生成器 payload）。
使用临时目录隔离 data/，不污染真实数据。
"""

import json
import os
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.novel_creation.role_generator import (  # noqa: E402
    _AGE_GROUPS,
    classify_age_group,
    generate_random_role,
    load_pools,
)
from modules.novel_creation.role_store import RoleStore  # noqa: E402


class RoleMapPoolsTest(unittest.TestCase):
    """字段池配置加载。"""

    def test_pools_file_exists_and_complete(self):
        """config/role_map_pools.json 存在且含全部必需键。"""
        path = os.path.join(BASE, "config", "role_map_pools.json")
        self.assertTrue(os.path.exists(path), "字段池配置文件缺失")
        pools = load_pools()
        for key in ["name_pool", "identity_pool", "nationality_pool", "faith_pool",
                    "camp_pool", "race_pool", "profession_pool", "personality_pool",
                    "background_pool", "attribute_ranges"]:
            self.assertIn(key, pools, f"字段池缺少键: {key}")
        ranges = pools["attribute_ranges"]
        self.assertIn("age", ranges)
        self.assertIn("gender_pool", ranges)
        self.assertLessEqual(ranges["age"]["min"], ranges["age"]["max"])

    def test_load_pools_missing_file_fallback(self):
        """文件缺失 → 默认池兜底（不抛异常）。"""
        pools = load_pools(os.path.join(tempfile.gettempdir(), "no_such_pools_xyz.json"))
        self.assertIn("identity_pool", pools)

    def test_load_pools_bad_json_fallback(self):
        """损坏 JSON → 默认池兜底（不抛异常）。"""
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                         encoding="utf-8") as f:
            f.write("{bad json")
            bad_path = f.name
        try:
            pools = load_pools(bad_path)
            self.assertIn("identity_pool", pools)
        finally:
            os.unlink(bad_path)


class AgeGroupTest(unittest.TestCase):
    """年龄段归档边界。"""

    def test_boundaries(self):
        """边界值映射（左闭右闭）。"""
        cases = [
            (16, "少年"), (25, "少年"),
            (26, "青年"), (45, "青年"),
            (46, "中年"), (60, "中年"),
            (61, "老年"), (70, "老年"),
        ]
        for age, expected in cases:
            self.assertEqual(classify_age_group(age), expected,
                             f"age={age} 应归档为 {expected}")

    def test_out_of_range_and_none(self):
        """越界 / None / 非数字 → ""。"""
        for bad in [None, 15, 71, -5, "abc", "", True]:
            self.assertEqual(classify_age_group(bad), "", f"{bad!r} 应返回空串")

    def test_age_groups_non_overlapping(self):
        """年龄组分段不重叠、按序递增。"""
        for i in range(len(_AGE_GROUPS) - 1):
            self.assertLess(_AGE_GROUPS[i]["max"], _AGE_GROUPS[i + 1]["min"])


class RandomRoleTest(unittest.TestCase):
    """随机生成函数。"""

    def test_seed_reproducible(self):
        """同一 seed 产出完全相同结果。"""
        a = generate_random_role(seed=42)
        b = generate_random_role(seed=42)
        self.assertEqual(a, b)

    def test_different_seed_differ(self):
        """不同 seed 大概率产出不同（同一字段池 + 多个可随机字段）。"""
        a = generate_random_role(seed=1)
        b = generate_random_role(seed=2)
        # 至少一个字段不同（name/age/gender/identity...）
        self.assertNotEqual(a, b)

    def test_fields_complete(self):
        """返回字段与 _ROLE_EXTRA_DEFAULTS 对齐，且范围合法。"""
        role = generate_random_role(seed=7)
        for key in ["identity", "nationality", "faith", "camp", "race",
                    "profession", "age_group", "attributes", "relations"]:
            self.assertIn(key, role)
        self.assertIn("name", role)
        self.assertIsInstance(role["age"], int)
        self.assertIn(role["gender"], ["男", "女"])
        self.assertIsInstance(role["attributes"], dict)
        self.assertIn("personality", role["attributes"])
        self.assertIsInstance(role["relations"], list)

    def test_age_group_matches_age(self):
        """age_group 与 age 归档一致。"""
        role = generate_random_role(seed=3)
        self.assertEqual(role["age_group"], classify_age_group(role["age"]))

    def test_override_name_and_age_rearchive(self):
        """overrides 覆盖 name/age 后重新归档 age_group。"""
        role = generate_random_role(seed=5, overrides={"name": "指定名", "age": 20})
        self.assertEqual(role["name"], "指定名")
        self.assertEqual(role["age"], 20)
        self.assertEqual(role["age_group"], "少年")

    def test_persist_to_role_store(self):
        """生成结果可直接写入 RoleStore（F8-T1 存储读写打通）。"""
        with tempfile.TemporaryDirectory() as tmp:
            store = RoleStore(os.path.join(tmp, "data", "projects"))
            draft = generate_random_role(seed=11)
            role = store.create_role("p1", draft["name"], **{
                k: v for k, v in draft.items() if k != "name"
            })
            self.assertEqual(role["name"], draft["name"])
            # 扩展字段已落库
            self.assertEqual(role["identity"], draft["identity"])
            self.assertEqual(role["age_group"], draft["age_group"])
            self.assertEqual(role["relations"], [])
            # 读回验证
            got = store.get_role("p1", role["id"])
            self.assertEqual(got["identity"], draft["identity"])
            self.assertEqual(got["attributes"], draft["attributes"])


if __name__ == "__main__":
    unittest.main()
