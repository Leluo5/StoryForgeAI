# -*- coding: utf-8 -*-
"""P5-T5b 命令面板：前端不变量守卫。

真实渲染耗时、闪烁与状态同步需真实浏览器采样（见验收报告）；
此处以源码不变量兜底，防止「零网络首屏」「一次性提交」「快捷键」被回退。
"""

import os
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PANEL = os.path.join(BASE, "static", "js", "tool_panel.js")
ROLE_MAP = os.path.join(BASE, "static", "js", "role_map_panel.js")
INDEX = os.path.join(BASE, "templates", "index.html")
APP = os.path.join(BASE, "static", "js", "app.js")

REGISTERED_TOOLS = [
    "gen_outline", "gen_chapter", "gen_character_image", "gen_world_map",
    "emotion_analysis", "consistency_check", "create_version", "gen_novel",
    "gen_audiobook", "run_70_workflow", "export_novel",
]
ROUTE_TOOLS = ["new_project", "open_project", "open_settings"]


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class CommandPaletteInvariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = _read(PANEL)

    def test_component_is_iife_with_global(self):
        self.assertIn("(function (global) {", self.src)
        self.assertIn("global.StoryForgeCommandPalette = factory;", self.src)

    def test_all_registered_tools_present(self):
        for name in REGISTERED_TOOLS:
            self.assertIn("'" + name + "'", self.src, "缺少工具命令 %s" % name)

    def test_route_tools_present(self):
        for name in ROUTE_TOOLS:
            self.assertIn("'" + name + "'", self.src, "缺少路由命令 %s" % name)

    def test_shortcut_ctrl_cmd_k(self):
        self.assertIn("ctrlKey", self.src)
        self.assertIn("metaKey", self.src)
        self.assertIn("preventDefault()", self.src)
        self.assertIn("isComposing", self.src)

    def test_list_commit_is_atomic(self):
        self.assertIn("replaceChildren", self.src)
        self.assertNotIn(".innerHTML =", self.src)

    def test_agent_endpoints_and_active_filter(self):
        self.assertIn("/api/agents/tools", self.src)
        self.assertIn("/switch", self.src)
        self.assertIn("status === 'active'", self.src)

    def test_render_metric_exposed(self):
        self.assertIn("lastRenderMs", self.src)
        self.assertIn("getLastRenderMs", self.src)
        self.assertIn("performance.now()", self.src)

    def test_active_role_sync(self):
        self.assertIn("storyforge:active-role:", self.src)
        self.assertIn("storyforge:active-role-changed", self.src)
        self.assertIn("localStorage", self.src)

    def test_open_has_no_blocking_fetch(self):
        start = self.src.find("        open() {")
        self.assertGreater(start, -1, "未找到 open()")
        end = self.src.find("\n        close()", start)
        self.assertGreater(end, start, "未找到 close()")
        body = self.src[start:end]
        self.assertNotIn("await ", body, "open() 不得等待网络")
        self.assertIn("_prefetch()", body, "open() 应异步预取角色与 Agent")


class RoleMapOpenDetailInvariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = _read(ROLE_MAP)

    def test_factory_exposes_open_detail(self):
        self.assertIn("openDetail(opts)", self.src)

    def test_mount_supports_open_role_id(self):
        self.assertIn("this.openRoleId = opts.openRoleId || null;", self.src)
        self.assertIn("this._openRoleDetail(node)", self.src)


class HomeContextInvariantTest(unittest.TestCase):
    def test_show_home_clears_current_work_context(self):
        src = _read(APP)
        start = src.find("    async function showHome() {")
        self.assertGreater(start, -1, "未找到 showHome()")
        end = src.find("\n    }", start)
        self.assertGreater(end, start, "未找到 showHome() 结束位置")
        body = src[start:end]
        self.assertIn("state.currentWorkId = null;", body)
        self.assertIn("state.currentWork = null;", body, "返回首页必须清空旧作品上下文")


class IndexEntryInvariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = _read(INDEX)

    def test_entry_container_and_script(self):
        self.assertIn('id="command-palette-entry"', self.src)
        self.assertIn("/static/js/tool_panel.js", self.src)
        self.assertIn("StoryForgeCommandPalette.createButton", self.src)


if __name__ == "__main__":
    unittest.main()
