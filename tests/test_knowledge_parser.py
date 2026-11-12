# -*- coding: utf-8 -*-
"""知识库拆分引擎分块合并单元测试（F5 §4.6 超大文本适配）。

覆盖：
- 单块路径与直接调 parse_* 等价（零回归）。
- 超长文本分块逐块送 LLM，结果合并（不截断丢内容，DoD #14）。
- article/paper/novel 三种合并器正确性（数组拼接、去重、字符串拼接）。
- LLM 失败仍降级原文存储（§5 拆分失败）。
"""

import os
import sys
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.knowledge_base.knowledge_parser import KnowledgeParser  # noqa: E402
from modules.knowledge_base.knowledge_parser import _STRUCT_PROMPT_LIMIT  # noqa: E402


class _FakeLLM:
    """按块号返回结构化结果，记录每次收到的文本，供断言分块发生。"""

    def __init__(self, kind="article"):
        self.kind = kind
        self.calls = []  # 每次收到的 prompt 文本

    def __call__(self, prompt, bot_id=""):
        self.calls.append(prompt)
        if self.kind == "article":
            return {"success": True, "content": '{"paragraphs":["p"],"key_points":["k"],"summary":"s","tag_list":["t"]}'}
        if self.kind == "paper":
            return {"success": True, "content": '{"research_question":"rq","research_method":"rm","core_conclusion":"cc","limitation":"li","design_insight":"di"}'}
        if self.kind == "novel":
            return {"success": True, "content": '{"characters":[{"name":"c"}],"plot_lines":[{"event":"e"}],"narrative_style":["n"],"world_setting":"w"}'}
        return {"success": True, "content": ""}


class TestParserChunking(unittest.TestCase):
    def test_single_chunk_equals_direct_parse(self):
        """长度 ≤ 上限时，parse_entry 结果与直接调 parse_article 一致。"""
        llm = _FakeLLM("article")
        parser = KnowledgeParser(llm=llm)
        short = "短文本" * 10
        entry = {"type": "article", "raw_content": short}
        chunked = parser.parse_entry(entry)
        chunked_calls = len(llm.calls)  # 记录 parse_entry 的调用次数
        direct = parser.parse_article(short)
        self.assertEqual(chunked, direct)
        # 单块只调了一次 LLM，且文本未截断
        self.assertEqual(chunked_calls, 1)
        self.assertIn(short[:20], llm.calls[0])

    def test_long_article_split_and_merge(self):
        """超长文章分块：每块 ≤ 上限，合并后不丢 key_points/summary。"""
        llm = _FakeLLM("article")
        parser = KnowledgeParser(llm=llm, chunk_size=_STRUCT_PROMPT_LIMIT)
        long_text = "这是一段很长的文章内容。" * 4000  # 远大于 6000
        result = parser.parse_entry({"type": "article", "raw_content": long_text})
        # 应发生多次 LLM 调用（分块）
        self.assertGreater(len(llm.calls), 1)
        # 合并：summary 拼接（每次块都返回 "s"），数组拼接
        self.assertEqual(len(result["key_points"]), len(llm.calls))
        self.assertEqual(result["summary"], " ".join(["s"] * len(llm.calls)))
        self.assertEqual(result["tag_list"], ["t"])

    def test_long_novel_merge_dedup(self):
        """超长小说分块：characters/narrative_style 去重，plot_lines 拼接。"""
        llm = _FakeLLM("novel")
        parser = KnowledgeParser(llm=llm, chunk_size=_STRUCT_PROMPT_LIMIT)
        long_text = "章节内容。" * 4000
        result = parser.parse_entry({"type": "novel", "raw_content": long_text})
        self.assertGreater(len(llm.calls), 1)
        # 去重后每类只留一份
        self.assertEqual(len(result["characters"]), 1)
        self.assertEqual(len(result["narrative_style"]), 1)
        # plot_lines 拼接
        self.assertEqual(len(result["plot_lines"]), len(llm.calls))

    def test_long_paper_merge_join(self):
        """超长论文分块：五要素按块拼接。"""
        llm = _FakeLLM("paper")
        parser = KnowledgeParser(llm=llm, chunk_size=_STRUCT_PROMPT_LIMIT)
        long_text = "论文正文。" * 4000
        result = parser.parse_entry({"type": "paper", "raw_content": long_text})
        self.assertGreater(len(llm.calls), 1)
        self.assertEqual(result["research_question"], "\n".join(["rq"] * len(llm.calls)))

    def test_llm_failure_falls_back(self):
        """LLM 失败降级原文存储。"""
        def failing(prompt, bot_id=""):
            return {"success": False, "error": "timeout"}
        parser = KnowledgeParser(llm=failing)
        result = parser.parse_entry({"type": "article", "raw_content": "内容"})
        self.assertTrue(result.get("fallback"))
        self.assertEqual(result.get("raw_text"), "内容")


if __name__ == "__main__":
    unittest.main(verbosity=2)
