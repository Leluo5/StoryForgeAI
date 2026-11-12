# -*- coding: utf-8 -*-
"""全文检索倒排索引单元测试（F5 检索增强）。

覆盖：
- 建倒排后可命中 / 不可命中（候选预筛 + 精排，结果与改造前一致）。
- 增量更新：save 后旧词失效、新词生效（索引同步）。
- 删除：从倒排移除（不再被候选命中）。
- rebuild_search_index：全量重建正确（损坏/缺失兜底）。
- 候选集为超集：_search_candidate_ids 不误杀任何 _match_keyword 命中。
- 索引损坏时回退全量扫描（语义不变）。
"""

import os
import shutil
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.knowledge_base.knowledge_store import KnowledgeStore  # noqa: E402


class TestKnowledgeSearchIndex(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = KnowledgeStore(os.path.join(self.tmp, "knowledge"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- 基础命中 / 不命中 ----

    def test_search_hit_and_miss(self):
        self.store.create_entry("article", "龙族设定", "龙族掌控火焰力量", tags=["世界观"])
        self.store.create_entry("article", "剑道", "剑修一剑开天门", tags=["战斗"])
        # 命中：关键词在 title/正文/tags
        self.assertEqual(len(self.store.query_index(keyword="龙族")), 1)
        self.assertEqual(len(self.store.query_index(keyword="火焰")), 1)
        self.assertEqual(len(self.store.query_index(keyword="世界观")), 1)
        # 不命中
        self.assertEqual(len(self.store.query_index(keyword="不存在词汇")), 0)

    def test_search_matches_fulltext_before_index(self):
        """倒排检索结果须与全量扫描（_match_keyword 语义）完全一致。"""
        entries = [
            ("article", "修仙", "炼气筑基金丹，飞升渡劫", ["玄幻"]),
            ("paper", "机器学习", "transformer 注意力机制", ["AI"]),
            ("novel", "雾都疑案", "侦探林远追查连环案", ["悬疑", "侦探"]),
        ]
        for t, title, body, tags in entries:
            self.store.create_entry(t, title, body, tags=tags)
        for kw in ["修仙", "渡劫", "transformer", "注意力", "林远", "侦探", "玄", "不存在的词"]:
            # 直接全量精排（绕索引）作基准
            index = self.store.load_index()
            expected = {
                m["id"]
                for m in index["items"]
                if self.store._match_keyword(self.store.load_entry(m["id"]), kw)
            }
            got = {m["id"] for m in self.store.query_index(keyword=kw)}
            self.assertEqual(got, expected, f"关键词 {kw!r} 结果不一致")

    # ---- 增量更新 ----

    def test_save_updates_index(self):
        e = self.store.create_entry("article", "标题", "旧内容 alpha", tags=["旧标签"])
        self.assertEqual(len(self.store.query_index(keyword="alpha")), 1)
        self.assertEqual(len(self.store.query_index(keyword="旧标签")), 1)
        # 更新正文 + 标签
        e["raw_content"] = "新内容 beta"
        e["tags"] = ["新标签"]
        self.store.save_entry(e)
        # 旧词失效
        self.assertEqual(len(self.store.query_index(keyword="alpha")), 0)
        self.assertEqual(len(self.store.query_index(keyword="旧标签")), 0)
        # 新词生效
        self.assertEqual(len(self.store.query_index(keyword="beta")), 1)
        self.assertEqual(len(self.store.query_index(keyword="新标签")), 1)

    # ---- 删除 ----

    def test_delete_removes_from_index(self):
        e = self.store.create_entry("article", "标题", "可检索内容")
        self.assertEqual(len(self.store.query_index(keyword="可检索")), 1)
        self.store.delete_entry(e["id"])
        self.assertEqual(len(self.store.query_index(keyword="可检索")), 0)
        # 倒排中已无该条目引用
        idx = self.store._load_search_index()
        self.assertNotIn(e["id"], idx["entry_tokens"])
        for posting in idx["postings"].values():
            self.assertNotIn(e["id"], posting["entries"])

    # ---- 重建 ----

    def test_rebuild_search_index(self):
        self.store.create_entry("article", "龙族", "龙族火焰力量", tags=["世界观"])
        self.store.create_entry("paper", "注意力", "transformer 注意力", tags=["AI"])
        idx = self.store.rebuild_search_index()
        self.assertEqual(len(idx["entry_tokens"]), 2)
        # 重建后检索仍正确
        self.assertEqual(len(self.store.query_index(keyword="龙族")), 1)
        self.assertEqual(len(self.store.query_index(keyword="注意力")), 1)

    def test_corrupt_index_falls_back_full_scan(self):
        """倒排损坏时 _search_candidate_ids 返回 None → 全量扫描，语义不变。"""
        self.store.create_entry("article", "龙族", "龙族火焰力量", tags=["世界观"])
        with open(self.store._search_index_path(), "w", encoding="utf-8") as f:
            f.write("{corrupt")
        # 仍能命中（回退全量）
        self.assertEqual(len(self.store.query_index(keyword="龙族")), 1)
        self.assertEqual(len(self.store.query_index(keyword="不存在")), 0)
        # 重建后可恢复索引
        self.store.rebuild_search_index()
        self.assertEqual(len(self.store._load_search_index()["entry_tokens"]), 1)

    # ---- 候选集为超集 ----

    def test_candidate_ids_superset(self):
        """候选集必须包含所有 _match_keyword 命中（不误杀），可含多余但不过滤。"""
        self.store.create_entry("article", "龙族设定", "龙族掌控火焰", tags=["世界观"])
        self.store.create_entry("article", "剑道", "剑修一剑开天门", tags=["战斗"])
        for kw in ["龙族", "火焰", "剑", "不存在的"]:
            candidates = self.store._search_candidate_ids(kw)
            if candidates is None:
                continue
            expected = {
                m["id"]
                for m in self.store.load_index()["items"]
                if self.store._match_keyword(self.store.load_entry(m["id"]), kw)
            }
            self.assertTrue(expected.issubset(set(candidates)), f"候选集漏掉命中: {kw}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
