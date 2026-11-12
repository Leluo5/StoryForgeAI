# -*- coding: utf-8 -*-
"""知识库正文 Markdown 能力单元测试（F5 语法升级）。

覆盖：
- normalize_body：章节标题/编号列表/空行压缩/标题前缀幂等。
- render_body_html：标题/列表/表格/代码块/换行渲染；XSS 底线（script/on*/javascript）。
"""

import os
import sys
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.knowledge_base.knowledge_markdown import (  # noqa: E402
    normalize_body,
    render_body_html,
)


class TestNormalizeBody(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(normalize_body(""), "")
        self.assertEqual(normalize_body(None), "")

    def test_chapter_heading(self):
        out = normalize_body("第一章 开端\n内容段落")
        lines = out.split("\n")
        self.assertEqual(lines[0], "## 第一章 开端")
        self.assertEqual(lines[1], "内容段落")

    def test_numbered_list(self):
        out = normalize_body("1. 第一点\n2. 第二点")
        self.assertEqual(out.split("\n"), ["- 1. 第一点", "- 2. 第二点"])

    def test_existing_heading_untouched(self):
        out = normalize_body("# 已有标题\n正文")
        self.assertEqual(out.split("\n")[0], "# 已有标题")

    def test_collapse_blank_lines(self):
        out = normalize_body("a\n\n\n\nb")
        self.assertEqual(out, "a\n\nb")

    def test_idempotent_on_plain_text(self):
        # 纯文本段落是合法 Markdown，规范化后不应改变语义主体
        out = normalize_body("普通段落一句话")
        self.assertEqual(out, "普通段落一句话")


class TestRenderBodyHtml(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(render_body_html(""), "")
        self.assertEqual(render_body_html(None), "")

    def test_heading_and_list(self):
        html = render_body_html("## 标题\n\n- 项1\n- 项2")
        self.assertIn("<h2>标题</h2>", html)
        self.assertIn("<li>项1</li>", html)

    def test_table_and_code_block(self):
        html = render_body_html("|a|b|\n|-|-|\n|1|2|\n\n```python\nprint(1)\n```")
        self.assertIn("<table>", html)
        # 围栏代码块：language-* class 包裹在 <pre><code> 内
        self.assertIn("language-python", html)
        self.assertIn("print(1)", html)

    def test_nl2br(self):
        html = render_body_html("行1\n行2")
        self.assertIn("<br", html)

    def test_xss_script_removed(self):
        html = render_body_html("hi<script>alert(1)</script>")
        self.assertNotIn("<script>", html)
        self.assertNotIn("alert(1)", html)

    def test_xss_event_attr_removed(self):
        html = render_body_html('<a href="#" onclick="alert(1)">x</a>')
        self.assertNotIn("onclick", html)

    def test_xss_javascript_href_neutralized(self):
        html = render_body_html('[x](javascript:alert(1))')
        self.assertNotIn("javascript:alert", html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
