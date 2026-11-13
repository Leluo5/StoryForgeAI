# -*- coding: utf-8 -*-
"""F9-T2 Coze 文生图客户端单测。

覆盖 generate_character_image：
- 复用 run_workflow 且传 prompt 参数。
- dict data 提取 image_url（image_url/url/image 三形态）。
- JSON 字符串 data 提取 image_url。
- 裸字符串 data 回退为 image_url。
- run_workflow 失败 → success=False。
- 无可用 image_url → success=False。

mock run_workflow，不发起真实网络请求。
"""

import os
import sys
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from coze_client import CozeClient  # noqa: E402


class GenerateCharacterImageTest(unittest.TestCase):
    def setUp(self):
        self.client = CozeClient("test-pat")
        self.wf = "wf_img_001"

    def _run_ok(self, data):
        """构造返回 success=True 且 data 为给定值的 run_workflow mock。"""
        return lambda wf_id, params: {"success": True, "data": data, "debug_url": ""}

    def test_dict_data_image_url(self):
        self.client.run_workflow = self._run_ok({"image_url": "http://img/a.png"})
        res = self.client.generate_character_image(self.wf, "长发黑发侠客")
        self.assertTrue(res["success"])
        self.assertEqual(res["image_url"], "http://img/a.png")

    def test_dict_data_url_fallback(self):
        self.client.run_workflow = self._run_ok({"url": "http://img/b.png"})
        res = self.client.generate_character_image(self.wf, "p")
        self.assertTrue(res["success"])
        self.assertEqual(res["image_url"], "http://img/b.png")

    def test_json_string_data(self):
        self.client.run_workflow = self._run_ok('{"image_url": "http://img/c.png"}')
        res = self.client.generate_character_image(self.wf, "p")
        self.assertTrue(res["success"])
        self.assertEqual(res["image_url"], "http://img/c.png")

    def test_plain_string_data(self):
        self.client.run_workflow = self._run_ok("http://img/d.png")
        res = self.client.generate_character_image(self.wf, "p")
        self.assertTrue(res["success"])
        self.assertEqual(res["image_url"], "http://img/d.png")

    def test_run_failure(self):
        self.client.run_workflow = lambda wf_id, params: {"success": False, "error": "coze down"}
        res = self.client.generate_character_image(self.wf, "p")
        self.assertFalse(res["success"])
        self.assertEqual(res["error"], "coze down")

    def test_missing_image_url(self):
        self.client.run_workflow = self._run_ok({"no_url": "x"})
        res = self.client.generate_character_image(self.wf, "p")
        self.assertFalse(res["success"])
        self.assertIn("image_url", res["error"])


if __name__ == "__main__":
    unittest.main()
