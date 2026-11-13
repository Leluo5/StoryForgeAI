# -*- coding: utf-8 -*-
"""F9-T3 角色形象生成工具真实实现单测。

覆盖：
- 特征签名确定性（同特征同签名，不同特征不同签名）。
- 哈希幂等（同特征 → 同 hash）。
- 特征全空 → 占位，不调 AI。
- 缓存命中 → 不重复调 AI（幂等），返回既有 avatar 路径。
- 未命中 → 调文生图 → 下载落盘 → 写回 role.avatar。
- AI 失败 → bad_gateway（保留旧头像）。
- 下载失败 → bad_gateway。

mock：注入 fake role_store / fake coze_client / mock requests.get；临时 data_root。
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.common.errors import AppError  # noqa: E402
from modules.novel_creation.tool_registry import (  # noqa: E402
    _avatar_hash,
    _feature_signature,
    _gen_character_image_handler,
)


class FakeRoleStore:
    """最小 role_store 替身：记录 update_role 调用。"""

    def __init__(self):
        self.roles = {}
        self.updates = []

    def set(self, pid, role_id, role):
        self.roles[(pid, role_id)] = role

    def update_role(self, pid, role_id, **fields):
        self.updates.append((pid, role_id, fields))
        r = self.roles[(pid, role_id)]
        r.update(fields)
        return r


class FakeCozeClient:
    def __init__(self, ok=True, image_url="http://img/x.png", error=""):
        self.ok = ok
        self.image_url = image_url
        self.error = error
        self.calls = []

    def generate_character_image(self, workflow_id, prompt):
        self.calls.append((workflow_id, prompt))
        if not self.ok:
            return {"success": False, "error": self.error}
        return {"success": True, "image_url": self.image_url}


def _mk_role(features=None, gender="男", name="林风眠"):
    vf = {"hair_style": "", "hair_color": "", "face_features": "", "outfit_style": "", "expression": ""}
    if features:
        vf.update(features)
    return {"id": "r1", "name": name, "gender": gender, "visual_features": vf, "avatar": ""}


class FeatureSignatureTest(unittest.TestCase):
    def test_same_features_same_signature(self):
        r1 = _mk_role({"hair_style": "长发", "hair_color": "黑"})
        r2 = _mk_role({"hair_style": "长发", "hair_color": "黑"})
        self.assertEqual(_feature_signature(r1), _feature_signature(r2))

    def test_diff_features_diff_signature(self):
        r1 = _mk_role({"hair_style": "长发", "hair_color": "黑"})
        r2 = _mk_role({"hair_style": "短发", "hair_color": "黑"})
        self.assertNotEqual(_feature_signature(r1), _feature_signature(r2))

    def test_hash_deterministic(self):
        sig = _feature_signature(_mk_role({"outfit_style": "侠客"}))
        self.assertEqual(_avatar_hash(sig), _avatar_hash(sig))
        self.assertEqual(len(_avatar_hash(sig)), 16)


class GenCharacterImageHandlerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_root = self.tmp.name
        self.pid = "proj1"

    def tearDown(self):
        self.tmp.cleanup()

    def _handler(self, role, role_store, coze, workflow="wf1"):
        return _gen_character_image_handler(
            {"_role_store": role_store, "_coze_client": coze, "_data_root": self.data_root, "workflow_id": workflow},
            {"role": role, "role_id": role["id"], "project_id": self.pid},
        )

    def test_empty_features_placeholder(self):
        role = _mk_role()
        rs = FakeRoleStore()
        coze = FakeCozeClient()
        res = self._handler(role, rs, coze)
        self.assertTrue(res["placeholder"])
        self.assertEqual(res["avatar"], "")
        self.assertEqual(coze.calls, [])  # 未调 AI

    def test_cache_hit_no_ai_call(self):
        role = _mk_role({"hair_style": "长发", "hair_color": "黑", "outfit_style": "侠客"})
        rs = FakeRoleStore()
        rs.set(self.pid, role["id"], role)
        coze = FakeCozeClient()
        sig = _feature_signature(role)
        h = _avatar_hash(sig)
        # 预置缓存文件
        os.makedirs(os.path.join(self.data_root, "avatars", self.pid), exist_ok=True)
        with open(os.path.join(self.data_root, "avatars", self.pid, f"{h}.png"), "wb") as f:
            f.write(b"PNG-CACHED")
        res = self._handler(role, rs, coze)
        self.assertTrue(res["cached"])
        self.assertEqual(coze.calls, [])  # 缓存命中不调 AI
        self.assertEqual(res["avatar"], f"/api/role-map/avatar/{h}")

    def test_generate_and_download_persist(self):
        role = _mk_role({"hair_style": "马尾", "hair_color": "红", "face_features": "冷峻", "outfit_style": "军装", "expression": "冷傲"})
        rs = FakeRoleStore()
        rs.set(self.pid, role["id"], role)
        coze = FakeCozeClient(image_url="http://img/gen.png")
        with mock.patch("modules.novel_creation.tool_registry.requests.get") as mget:
            mget.return_value.status_code = 200
            mget.return_value.content = b"PNG-GEN"
            mget.return_value.raise_for_status.return_value = None
            res = self._handler(role, rs, coze)
        self.assertFalse(res["cached"])
        self.assertEqual(coze.calls[0][0], "wf1")  # 工作流 id 透传
        self.assertIn("二次元插画风", coze.calls[0][1])  # prompt 确定性构造
        # 落盘
        h = _avatar_hash(_feature_signature(role))
        p = os.path.join(self.data_root, "avatars", self.pid, f"{h}.png")
        self.assertTrue(os.path.exists(p))
        with open(p, "rb") as f:
            self.assertEqual(f.read(), b"PNG-GEN")
        # 写回 avatar
        self.assertTrue(any(u[1] == role["id"] and u[2].get("avatar") == res["avatar"] for u in rs.updates))

    def test_ai_failure_bad_gateway(self):
        role = _mk_role({"outfit_style": "道袍"})
        rs = FakeRoleStore()
        coze = FakeCozeClient(ok=False, error="coze fail")
        with self.assertRaises(AppError) as ctx:
            self._handler(role, rs, coze)
        self.assertEqual(ctx.exception.code, 502)

    def test_download_failure_bad_gateway(self):
        role = _mk_role({"outfit_style": "宫装"})
        rs = FakeRoleStore()
        coze = FakeCozeClient(image_url="http://img/bad.png")
        with mock.patch("modules.novel_creation.tool_registry.requests.get") as mget:
            mget.return_value.raise_for_status.side_effect = Exception("net down")
            with self.assertRaises(AppError) as ctx:
                self._handler(role, rs, coze)
        self.assertEqual(ctx.exception.code, 502)


if __name__ == "__main__":
    unittest.main()
