# -*- coding: utf-8 -*-
"""剧情树生成解析器测试（F7-T2）。

覆盖：parse_outline / parse_novel 两种模式、来源过短 400、待确认态、
mock LLM 产出树结构、LLM 返回非法结构 409。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules.plot.plot_parser import parse_novel, parse_outline


def _mock_llm(result):
    def fn(prompt):
        return result
    return fn


def _valid_llm_result():
    return {
        "nodes": [
            {"key": "n1", "label": "开端", "type": "start", "content": "故事开始", "parent": None},
            {"key": "n2", "label": "初遇", "type": "main", "content": "主角相遇", "parent": "n1"},
            {"key": "n3", "label": "冲突", "type": "turn", "content": "冲突升级", "parent": "n2"},
        ],
        "links": [
            {"from": "n1", "to": "n2", "type": "前置"},
            {"from": "n2", "to": "n3", "type": "前置"},
        ],
    }


class PlotParserTest(unittest.TestCase):
    def test_parse_outline_success(self):
        outline = "第一章 雾都初雨，主角登场。第二章 深夜探案，真相渐显。第三章 真相揭晓，悬念终结。"
        tree = parse_outline(outline, "雾都主线", _mock_llm(_valid_llm_result()))
        self.assertEqual(tree["source"], "outline")
        self.assertEqual(len(tree["nodes"]), 3)
        self.assertEqual(len(tree["links"]), 2)
        self.assertTrue(tree["pending"])
        # 根为 start 类型节点
        self.assertTrue(tree["root_node_id"])
        root = [n for n in tree["nodes"] if n["id"] == tree["root_node_id"]][0]
        self.assertEqual(root["type"], "start")
        # 父指针回填
        n2 = [n for n in tree["nodes"] if n["label"] == "初遇"][0]
        self.assertEqual(n2["parent_id"], root["id"])

    def test_parse_outline_too_short_400(self):
        with self.assertRaises(AppError) as ctx:
            parse_outline("太短了", "t", _mock_llm(_valid_llm_result()))
        self.assertEqual(ctx.exception.code, 400)

    def test_parse_outline_empty_400(self):
        with self.assertRaises(AppError) as ctx:
            parse_outline("", "t", _mock_llm(_valid_llm_result()))
        self.assertEqual(ctx.exception.code, 400)

    def test_parse_outline_llm_bad_409(self):
        with self.assertRaises(AppError) as ctx:
            parse_outline("这是一个足够长的大纲内容，包含多个章节和情节概要用于测试生成剧情树结构。",
                          "t", _mock_llm({"foo": "bar"}))
        self.assertEqual(ctx.exception.code, 409)

    def test_parse_novel_success(self):
        novel = "第一章：主角来到雾都，展开调查。第二章：发现线索，锁定嫌疑人。第三章：真凶落网，真相大白。"
        tree = parse_novel(novel, "小说主线", _mock_llm(_valid_llm_result()))
        self.assertEqual(tree["source"], "novel")
        self.assertEqual(len(tree["nodes"]), 3)
        self.assertTrue(tree["pending"])

    def test_parse_novel_too_short_400(self):
        with self.assertRaises(AppError) as ctx:
            parse_novel("太短", "t", _mock_llm(_valid_llm_result()))
        self.assertEqual(ctx.exception.code, 400)

    def test_parse_novel_llm_bad_409(self):
        with self.assertRaises(AppError) as ctx:
            parse_novel("这是一个足够长的小说拆文内容，包含多个章节和情节用于测试生成剧情树结构。",
                        "t", _mock_llm({"nodes": "bad"}))
        self.assertEqual(ctx.exception.code, 409)

    def test_parse_outline_default_llm_not_implemented(self):
        # 未注入 llm_fn 时默认占位应抛 NotImplementedError（生产由路由注入）
        with self.assertRaises(NotImplementedError):
            parse_outline("这是一个足够长的大纲内容，包含多个章节和情节概要用于测试生成剧情树结构。")


if __name__ == "__main__":
    unittest.main()
