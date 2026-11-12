# -*- coding: utf-8 -*-
"""知识库接口契约冒烟测试（契约 §5 + 技术方案 §3）。

用 Flask 测试客户端，覆盖：
- 蓝图已注册（/api/knowledge 可达）。
- POST /api/knowledge 创建条目（契约 §5.1）。
- POST /api/knowledge/<id>/extract-outline（契约 §5.2）。
- GET /api/knowledge/entries 列表 + 四维过滤。
LLM 调用被 monkeypatch 为固定返回，避免外部依赖。
"""

import os
import sys
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

import app as app_module  # noqa: E402


class TestKnowledgeRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 重定向知识库数据目录到临时目录，避免污染真实 data/
        import tempfile
        import shutil
        cls.tmp = tempfile.mkdtemp()
        import modules.knowledge_base.routes as routes
        from modules.knowledge_base.knowledge_store import KnowledgeStore
        routes._store = KnowledgeStore(os.path.join(cls.tmp, "knowledge"))

        # 注入固定 LLM：类型识别 novel，拆文返回固定结构，大纲成功
        def fake_llm(prompt, bot_id=""):
            if "类型识别" in prompt:
                return {"success": True, "content": "novel"}
            if "小说拆文" in prompt:
                return {"success": True, "content": '{"characters":[{"name":"龙"},{"name":"火"}],"plot_lines":[{"event":"觉醒"}],"narrative_style":["热血"],"world_setting":"东方玄幻"}'}
            if "四维" in prompt:
                return {"success": True, "content": '{"chapters":[{"title":"序章","summary":"s","order":1}],"plot_nodes":[{"id":"n1","label":"觉醒","type":"main"}],"character_relations":[{"a":"龙","b":"火","relation":"对立","camp":"a"}],"core_storylines":{"main":"龙火之争","branches":[],"hidden":[]}}'}
            return {"success": True, "content": ""}
        from modules.knowledge_base.knowledge_parser import KnowledgeParser
        from modules.knowledge_base.knowledge_linker import KnowledgeLinker
        routes._parser = KnowledgeParser(llm=fake_llm)
        routes._linker = KnowledgeLinker(llm=fake_llm)
        routes._linker.set_store(routes._store)

        app_module.app.config["TESTING"] = True
        cls.client = app_module.app.test_client()

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_blueprint_registered(self):
        resp = self.client.get("/api/knowledge/entries")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body["code"], 0)
        self.assertIn("items", body["data"])

    def test_create_entry_contract_51(self):
        resp = self.client.post("/api/knowledge", json={
            "type": "auto", "title": "龙火传说", "raw_content": "第一章 龙族觉醒\n第二章 火凤涅槃",
        })
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body["code"], 0)
        self.assertEqual(body["data"]["type"], "novel")
        self.assertIn("id", body["data"])
        self.assertEqual(body["data"]["structured"]["characters"][0]["name"], "龙")

    def test_extract_outline_contract_52(self):
        # 创建条目后提取大纲
        resp = self.client.post("/api/knowledge", json={
            "type": "auto", "title": "龙火传说2", "raw_content": "第一章 龙族觉醒\n第二章 火凤涅槃",
        })
        entry_id = resp.get_json()["data"]["id"]
        resp2 = self.client.post(f"/api/knowledge/{entry_id}/extract-outline")
        self.assertEqual(resp2.status_code, 200)
        body = resp2.get_json()
        self.assertEqual(body["code"], 0)
        self.assertIn("outline", body["data"])
        self.assertEqual(body["data"]["outline"]["core_storylines"]["main"], "龙火之争")

    def test_entries_list_and_filter(self):
        self.client.post("/api/knowledge", json={"type": "auto", "title": "过滤A", "raw_content": "第一章 甲\n第二章 乙"})
        resp = self.client.get("/api/knowledge/entries?type=novel")
        body = resp.get_json()
        self.assertEqual(body["code"], 0)
        self.assertTrue(all(i["type"] == "novel" for i in body["data"]["items"]))
        self.assertGreaterEqual(body["data"]["total"], 1)

    def test_get_entry_detail(self):
        resp = self.client.post("/api/knowledge", json={"type": "auto", "title": "详情", "raw_content": "第一章 内容"})
        entry_id = resp.get_json()["data"]["id"]
        resp2 = self.client.get(f"/api/knowledge/entries/{entry_id}")
        body = resp2.get_json()
        self.assertEqual(body["code"], 0)
        self.assertEqual(body["data"]["title"], "详情")

    def test_delete_entry(self):
        resp = self.client.post("/api/knowledge", json={"type": "auto", "title": "待删", "raw_content": "第一章 内容"})
        entry_id = resp.get_json()["data"]["id"]
        resp2 = self.client.delete(f"/api/knowledge/entries/{entry_id}")
        self.assertEqual(resp2.get_json()["code"], 0)
        resp3 = self.client.get(f"/api/knowledge/entries/{entry_id}")
        self.assertEqual(resp3.status_code, 404)

    def test_detect_type_endpoint(self):
        resp = self.client.post("/api/knowledge/detect-type", json={"raw_content": "任意文本"})
        self.assertEqual(resp.get_json()["data"]["type"], "novel")


if __name__ == "__main__":
    unittest.main(verbosity=2)
