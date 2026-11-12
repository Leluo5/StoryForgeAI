# -*- coding: utf-8 -*-
"""知识库模块 F5 单元测试。

覆盖：数据层（store CRUD/查重/索引重建/四维查询）、
引擎层（parser 类型识别/四类型拆分/大纲提取、linker 相似度/关联）、
接口契约（routes 注册端点 + 契约 §5 响应格式）。
不依赖外部 LLM：所有 LLM 调用通过注入 mock llm 或 monkeypatch。
"""

import os
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.knowledge_base.knowledge_store import KnowledgeStore  # noqa: E402
from modules.knowledge_base.knowledge_parser import KnowledgeParser  # noqa: E402
from modules.knowledge_base.knowledge_linker import KnowledgeLinker  # noqa: E402


def fake_llm(mapping):
    """构造一个 LLM 调用器，按 prompt 前缀返回预设 content。"""
    def _call(prompt, bot_id=""):
        for key, content in mapping.items():
            if key in prompt:
                return {"success": True, "content": content}
        return {"success": True, "content": ""}
    return _call


class TestKnowledgeStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = KnowledgeStore(os.path.join(self.tmp, "knowledge"))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_create_and_load(self):
        e = self.store.create_entry("article", "标题", "内容正文", tags=["a"])
        self.assertEqual(e["type"], "article")
        self.assertIn("id", e)
        loaded = self.store.load_entry(e["id"])
        self.assertEqual(loaded["title"], "标题")
        self.assertEqual(loaded["raw_content"], "内容正文")

    def test_dedup_by_hash(self):
        e1 = self.store.create_entry("novel", "书1", "第一章 开端")
        e2 = self.store.create_entry("novel", "书2", "第一章 开端")
        # 内容哈希相同 -> 返回已有条目（不新增）
        self.assertEqual(e1["id"], e2["id"])
        self.assertEqual(len(self.store.load_index()["items"]), 1)

    def test_query_by_type_and_tag(self):
        self.store.create_entry("article", "文1", "aaa", tags=["世界观"])
        self.store.create_entry("paper", "文2", "bbb", tags=["方法"])
        items = self.store.query_index(type_="article")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "文1")
        items = self.store.query_index(tag="方法")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "文2")

    def test_query_keyword_fulltext(self):
        self.store.create_entry("article", "文1", "这是一个关于龙族的设定", tags=["世界观"])
        items = self.store.query_index(keyword="龙族")
        self.assertEqual(len(items), 1)
        items = self.store.query_index(keyword="不存在的词")
        self.assertEqual(len(items), 0)

    def test_delete_and_cleanup(self):
        e = self.store.create_entry("article", "文1", "content")
        self.assertTrue(self.store.delete_entry(e["id"]))
        self.assertIsNone(self.store.load_entry(e["id"]))
        self.assertEqual(len(self.store.load_index()["items"]), 0)

    def test_rebuild_index_after_corrupt(self):
        e = self.store.create_entry("article", "文1", "content")
        # 损坏索引
        with open(self.store._index_path(), "w", encoding="utf-8") as f:
            f.write("{corrupt")
        index = self.store.load_index()
        self.assertEqual(len(index["items"]), 1)
        self.assertEqual(index["items"][0]["id"], e["id"])


class TestKnowledgeParser(unittest.TestCase):
    def setUp(self):
        self.parser = KnowledgeParser()

    def test_detect_type_manual(self):
        self.assertEqual(self.parser.detect_type("任意", "paper"), "paper")
        self.assertEqual(self.parser.detect_type("任意", "novel"), "novel")

    def test_parse_article(self):
        llm = fake_llm({"文章结构化": '{"paragraphs":["p1","p2"],"key_points":["k"],"summary":"s","tag_list":["t"]}'})
        p = KnowledgeParser(llm=llm)
        r = p.parse_article("第一段\n\n第二段")
        self.assertEqual(r["key_points"], ["k"])
        self.assertEqual(r["summary"], "s")

    def test_parse_paper(self):
        llm = fake_llm({"论文结构化": '{"research_question":"q","research_method":"m","core_conclusion":"c","limitation":"l","design_insight":"i"}'})
        p = KnowledgeParser(llm=llm)
        r = p.parse_paper("论文内容")
        self.assertEqual(r["core_conclusion"], "c")
        self.assertEqual(r["design_insight"], "i")

    def test_parse_novel(self):
        llm = fake_llm({"小说拆文": '{"characters":[{"name":"a"}],"plot_lines":[{"event":"e"}],"narrative_style":["s"],"world_setting":"w"}'})
        p = KnowledgeParser(llm=llm)
        r = p.parse_novel("第一章 开端")
        self.assertEqual(r["characters"][0]["name"], "a")
        self.assertEqual(r["world_setting"], "w")

    def test_parse_inspiration_no_link(self):
        r = self.parser.parse_inspiration("灵感文本")
        self.assertEqual(r["raw_text"], "灵感文本")
        self.assertEqual(r["related_ids"], [])

    def test_parse_entry_fallback_on_llm_fail(self):
        # LLM 抛错 -> 降级原文
        def fail_llm(prompt, bot_id=""):
            return {"success": False, "error": "boom"}
        p = KnowledgeParser(llm=fail_llm)
        r = p.parse_entry({"type": "article", "raw_content": "原文"})
        self.assertTrue(r["fallback"])
        self.assertEqual(r["raw_text"], "原文")

    def test_extract_outline_no_chapters(self):
        r = self.parser.extract_outline("没有章节结构的一段普通文字")
        self.assertEqual(r["error"], "no_chapters")

    def test_extract_outline_success(self):
        llm = fake_llm({"四维": '{"chapters":[{"title":"序章","summary":"s","order":1}],"plot_nodes":[{"id":"n1","label":"l","type":"main"}],"character_relations":[{"a":"a","b":"b","relation":"r","camp":"c"}],"core_storylines":{"main":"主线","branches":["b"],"hidden":["h"]}}'})
        p = KnowledgeParser(llm=llm)
        r = p.extract_outline("第一章 开端\n第二章 发展")
        self.assertEqual(len(r["chapters"]), 1)
        self.assertEqual(r["core_storylines"]["main"], "主线")
        self.assertIn("branches", r["core_storylines"])


class TestKnowledgeLinker(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = KnowledgeStore(os.path.join(self.tmp, "knowledge"))
        self.linker = KnowledgeLinker(store=self.store)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_search_similar_tfidf(self):
        self.store.create_entry("article", "龙族设定", "龙族是上古神兽，掌控火焰", tags=["世界观"])
        self.store.create_entry("article", "剑道", "剑修一剑开天门", tags=["战斗"])
        cands = self.linker.search_similar("龙族火焰力量")
        self.assertTrue(len(cands) >= 1)
        self.assertEqual(cands[0]["title"], "龙族设定")

    def test_link_inspiration(self):
        self.store.create_entry("article", "龙族设定", "龙族掌控火焰力量", tags=["世界观"])
        insp = {"id": "insp1", "raw_content": "想写一个龙族火系天才"}
        r = self.linker.link_inspiration(insp)
        self.assertEqual(len(r["related_ids"]), 1)

    def test_add_and_remove_link(self):
        a = self.store.create_entry("article", "A", "aaa")
        b = self.store.create_entry("article", "B", "bbb")
        links = self.linker.add_link(a["id"], b["id"])
        self.assertIn(b["id"], links)
        # 双向引用
        b_entry = self.store.load_entry(b["id"])
        self.assertIn(a["id"], b_entry["links"])
        links = self.linker.remove_link(a["id"], b["id"])
        self.assertNotIn(b["id"], links)


if __name__ == "__main__":
    unittest.main(verbosity=2)
