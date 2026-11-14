# -*- coding: utf-8 -*-
"""P5-T5a 版图角色详情体验优化：前端不变量守卫。

真实闪烁、乱序响应与渲染耗时需真实浏览器采样（见验收报告）；
此处以源码不变量兜底，防止「一次性提交」「请求代次隔离」被回退。

沿用 tests/test_role_map_perf.py 的 RoleMapFrontendPerfTest 模式。
"""

import os
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_PATH = os.path.join(BASE, "static", "js", "role_map_panel.js")


class RoleDetailInvariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(JS_PATH, encoding="utf-8") as fh:
            cls.src = fh.read()

    def _method_body(self, signature, end_marker):
        start = self.src.find(signature)
        self.assertGreater(start, -1, "未找到方法 %s" % signature)
        end = self.src.find(end_marker, start + len(signature))
        self.assertGreater(end, start, "未找到 %s 的结束标记" % signature)
        return self.src[start:end]

    def _open_detail_body(self):
        return self._method_body(
            "        _openRoleDetail(d) {",
            "\n        _closeRoleDetail() {",
        )

    def test_open_detail_increments_generation(self):
        """打开详情必须递增代次，旧请求才能被判为过期。"""
        self.assertIn("const seq = ++this._detailSeq;", self._open_detail_body())

    def test_open_detail_does_not_close_before_build(self):
        """不得先关闭旧详情再构建新面板，否则产生空白帧。"""
        self.assertNotIn("this._closeRoleDetail();", self._open_detail_body())

    def test_open_detail_swaps_panel_in_place(self):
        """新面板必须原地替换旧面板。"""
        self.assertIn("replaceChild(panel, prev)", self._open_detail_body())

    def test_open_detail_passes_generation_to_loader(self):
        """成长线加载必须携带角色 ID 与代次。"""
        self.assertIn("this._loadGrowth(roleId, seq)", self._open_detail_body())

    def test_close_detail_invalidates_generation(self):
        """关闭详情必须使在途请求失效。"""
        body = self._method_body(
            "        _closeRoleDetail() {",
            "\n        // ---------- F8-T10",
        )
        self.assertIn("this._detailSeq += 1;", body)
        self.assertIn("this._detailRoleId = null;", body)

    def test_loader_guards_role_generation_and_container(self):
        """写 DOM 前必须同时校验角色、代次与容器。"""
        body = self._method_body(
            "        async _loadGrowth(roleId, seq) {",
            "\n        _renderGrowthTimeline(box, nodes) {",
        )
        self.assertIn("seq === self._detailSeq", body)
        self.assertIn("roleId === self._detailRoleId", body)
        self.assertIn("self._detailGrowthBox === box", body)


if __name__ == "__main__":
    unittest.main()
