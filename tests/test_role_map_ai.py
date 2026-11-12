# -*- coding: utf-8 -*-
"""F8-T4 AI 角色抽取服务单测。

覆盖（对齐任务规划 F8-T4 完成标准「mock coze 解析正确」）：
- build_extract_prompt 提示词结构
- _parse_llm_json：剥离围栏 / 二次编码 / 非 dict 拒绝
- _parse_result：characters 规范化 / 同名去重 / 关系对端缺失丢弃 / 无向边去重 / 自关联丢弃
- extract_roles：mock llm 返回固定 JSON → 解析正确；进度推进（extract→preview）；失败置 failed
- commit_extracted：写库（Role 创建/复用 + 图谱节点 + 边 + ai_generated=true）

依赖注入：llm_fn mock；RoleMapStore/RoleStore 用临时目录实例。
"""

import json
import os
import tempfile
import unittest

from modules.common.errors import AppError
from modules.novel_creation.role_store import RoleStore
from modules.plot.role_map_ai import RoleMapAIExtractor, build_extract_prompt, _parse_llm_json
from modules.plot.role_map_service import RoleMapStore


def _sample_llm_response():
    """固定 LLM 返回（模拟 coze run_workflow 解析后数据）。"""
    return {
        "characters": [
            {"name": "林风眠", "identity": "主角", "nationality": "中原", "faith": "天道",
             "camp": "正道", "race": "人族", "profession": "剑客", "age": 28, "gender": "男",
             "attributes": {"personality": "冷静", "background": "出身名门"}},
            {"name": "苏雪落", "identity": "配角", "nationality": "北境", "faith": "无",
             "camp": "魔道", "race": "妖族", "profession": "术士", "age": 22, "gender": "女",
             "attributes": {"personality": "热血", "background": "流浪孤儿"}},
            {"name": "顾惊蛰", "identity": "反派", "nationality": "中原", "faith": "魔",
             "camp": "魔道", "race": "人族", "profession": "刺客", "age": 35, "gender": "男",
             "attributes": {}},
        ],
        "relations": [
            {"from": "林风眠", "to": "苏雪落", "relation_type": "盟友", "note": "生死之交"},
            {"from": "苏雪落", "to": "顾惊蛰", "relation_type": "敌对", "note": ""},
            {"from": "林风眠", "to": "顾惊蛰", "relation_type": "敌对", "note": ""},
        ],
    }


class TestBuildPrompt(unittest.TestCase):
    def test_prompt_structure(self):
        prompt = build_extract_prompt("第一章内容", "第一章")
        self.assertIn("characters", prompt)
        self.assertIn("relations", prompt)
        self.assertIn("第一章", prompt)
        self.assertIn("第一章内容", prompt)

    def test_prompt_default_label(self):
        prompt = build_extract_prompt("内容")
        self.assertIn("全文", prompt)


class TestParseLLMJson(unittest.TestCase):
    def test_parse_plain_json(self):
        self.assertEqual(_parse_llm_json('{"a": 1}'), {"a": 1})

    def test_parse_fenced_json(self):
        text = '```json\n{"a": 1}\n```'
        self.assertEqual(_parse_llm_json(text), {"a": 1})

    def test_parse_fenced_no_lang(self):
        text = '```\n{"a": 1}\n```'
        self.assertEqual(_parse_llm_json(text), {"a": 1})

    def test_parse_double_encoded(self):
        text = json.dumps('{"a": 1}')
        self.assertEqual(_parse_llm_json(text), {"a": 1})

    def test_parse_dict_passthrough(self):
        self.assertEqual(_parse_llm_json({"a": 1}), {"a": 1})

    def test_parse_invalid_rejected(self):
        with self.assertRaises(AppError):
            _parse_llm_json("not json at all")
        with self.assertRaises(AppError):
            _parse_llm_json("[1, 2, 3]")


class TestParseResult(unittest.TestCase):
    def setUp(self):
        self.extractor = RoleMapAIExtractor(None, None)

    def test_characters_normalized(self):
        chars, rels = self.extractor._parse_result(_sample_llm_response())
        self.assertEqual(len(chars), 3)
        c0 = chars[0]
        self.assertEqual(c0["name"], "林风眠")
        self.assertEqual(c0["age"], 28)
        self.assertEqual(c0["attributes"]["personality"], "冷静")
        self.assertTrue(c0["attributes"]["extracted"])

    def test_duplicate_name_dedup(self):
        data = _sample_llm_response()
        data["characters"].append(dict(data["characters"][0], identity="副本"))
        chars, _ = self.extractor._parse_result(data)
        self.assertEqual(len(chars), 3)  # 同名去重

    def test_relation_missing_endpoint_dropped(self):
        data = _sample_llm_response()
        data["relations"].append({"from": "不存在", "to": "林风眠", "relation_type": "x"})
        chars, rels = self.extractor._parse_result(data)
        self.assertEqual(len(rels), 3)  # 3 条合法，1 条对端缺失丢弃

    def test_relation_self_dropped(self):
        data = _sample_llm_response()
        data["relations"].append({"from": "林风眠", "to": "林风眠", "relation_type": "self"})
        chars, rels = self.extractor._parse_result(data)
        self.assertEqual(len(rels), 3)

    def test_relation_undirected_dedup(self):
        data = _sample_llm_response()
        # A-B 已有；再加 B-A 应去重
        data["relations"].append({"from": "苏雪落", "to": "林风眠", "relation_type": "盟友"})
        chars, rels = self.extractor._parse_result(data)
        self.assertEqual(len(rels), 3)

    def test_no_characters_rejected(self):
        with self.assertRaises(AppError):
            self.extractor._parse_result({"characters": [], "relations": []})
        with self.assertRaises(AppError):
            self.extractor._parse_result({"characters": "bad", "relations": []})

    def test_invalid_age_normalized(self):
        data = _sample_llm_response()
        data["characters"][0]["age"] = "not-a-number"
        chars, _ = self.extractor._parse_result(data)
        self.assertIsNone(chars[0]["age"])


class TestExtractRoles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.role_store = RoleStore(self.tmp)
        self.map_store = RoleMapStore(self.tmp, role_store=self.role_store)
        self.project_id = "p_extract"

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _llm_ok(self, prompt):
        return _sample_llm_response()

    def test_extract_parses_correctly(self):
        extractor = RoleMapAIExtractor(self.map_store, self.role_store, llm_fn=self._llm_ok)
        result = extractor.extract_roles(self.project_id, "小说内容" * 20, "all")
        self.assertEqual(len(result["characters"]), 3)
        self.assertEqual(len(result["relations"]), 3)
        self.assertEqual(result["source"], "all")
        self.assertIn("extracted_at", result)
        # 进度应为 preview（90%）
        progress = extractor.get_progress(self.project_id)
        self.assertEqual(progress["stage"], "preview")
        self.assertEqual(progress["percent"], 90)
        self.assertFalse(progress["done"])

    def test_extract_empty_source_rejected(self):
        extractor = RoleMapAIExtractor(self.map_store, self.role_store, llm_fn=self._llm_ok)
        with self.assertRaises(AppError):
            extractor.extract_roles(self.project_id, "   ", "all")

    def test_extract_llm_failure_sets_failed(self):
        def _llm_fail(prompt):
            raise RuntimeError("coze down")
        extractor = RoleMapAIExtractor(self.map_store, self.role_store, llm_fn=_llm_fail)
        with self.assertRaises(RuntimeError):
            extractor.extract_roles(self.project_id, "小说内容" * 20, "all")
        progress = extractor.get_progress(self.project_id)
        self.assertEqual(progress["stage"], "failed")
        self.assertEqual(progress["percent"], 0)

    def test_extract_progress_stages(self):
        """验证进度阶段推进：extract(10) → extract(60) → preview(90)。"""
        stages = []

        class TrackingStore(RoleMapStore):
            def set_ai_progress(self, pid, stage, percent):
                stages.append((stage, percent))
                return super().set_ai_progress(pid, stage, percent)

        tracking = TrackingStore(self.tmp, role_store=self.role_store)
        extractor = RoleMapAIExtractor(tracking, self.role_store, llm_fn=self._llm_ok)
        extractor.extract_roles(self.project_id, "小说内容" * 20, "all")
        self.assertEqual(stages[0], ("extract", 10))
        self.assertEqual(stages[1], ("extract", 60))
        self.assertEqual(stages[2], ("preview", 90))


class TestCommitExtracted(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.role_store = RoleStore(self.tmp)
        self.map_store = RoleMapStore(self.tmp, role_store=self.role_store)
        self.project_id = "p_commit"
        self.extractor = RoleMapAIExtractor(self.map_store, self.role_store, llm_fn=lambda p: _sample_llm_response())
        # 先抽取
        self.result = self.extractor.extract_roles(self.project_id, "小说内容" * 20, "all")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_commit_creates_roles_and_graph(self):
        commit = self.extractor.commit_extracted(
            self.project_id, self.result["characters"], self.result["relations"])
        self.assertEqual(len(commit["created_roles"]), 3)
        self.assertEqual(commit["edges_added"], 3)
        self.assertTrue(commit["ai_generated"])
        self.assertIsNotNone(commit["generated_at"])
        self.assertEqual(commit["role_count"], 3)

        # 图谱校验：3 节点 3 边
        graph = self.map_store.get_graph(self.project_id)
        self.assertEqual(len(graph["nodes"]), 3)
        self.assertEqual(len(graph["edges"]), 3)
        # Role 实体校验
        roles = self.role_store.list_roles(self.project_id)
        self.assertEqual(len(roles), 3)
        lin = next(r for r in roles if r["name"] == "林风眠")
        self.assertEqual(lin["identity"], "主角")
        self.assertEqual(lin["age"], 28)
        self.assertEqual(lin["attributes"]["personality"], "冷静")
        # 双向关联一致：林风眠 relations 应含苏雪落与顾惊蛰
        lin_relations = {r["target_role_id"] for r in lin["relations"]}
        su = next(r for r in roles if r["name"] == "苏雪落")
        self.assertIn(su["id"], lin_relations)

    def test_commit_reuses_existing_role(self):
        # 预建同名角色，提交时应复用而非新建
        existing = self.role_store.create_role(self.project_id, "林风眠")
        commit = self.extractor.commit_extracted(
            self.project_id, self.result["characters"], self.result["relations"])
        self.assertIn("林风眠", commit["reused_roles"])
        self.assertEqual(len(commit["created_roles"]), 2)  # 其余 2 个新建
        # 复用角色被更新（identity 从 "" 更新为 主角）
        updated = self.role_store.get_role(self.project_id, existing["id"])
        self.assertEqual(updated["identity"], "主角")

    def test_commit_empty_rejected(self):
        with self.assertRaises(AppError):
            self.extractor.commit_extracted(self.project_id, [], [])
        with self.assertRaises(AppError):
            self.extractor.commit_extracted(self.project_id, "bad", [])

    def test_commit_progress_done(self):
        self.extractor.commit_extracted(
            self.project_id, self.result["characters"], self.result["relations"])
        progress = self.extractor.get_progress(self.project_id)
        self.assertEqual(progress["stage"], "done")
        self.assertTrue(progress["done"])
        self.assertEqual(progress["percent"], 100)


if __name__ == "__main__":
    unittest.main()
