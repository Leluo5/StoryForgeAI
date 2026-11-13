# -*- coding: utf-8 -*-
"""work_manager.py 补测（P5-T1：覆盖率补测，目标覆盖 import_from_coze/import_dataset/import_workflow/get/update/delete/refresh 等）。

用 tmp_path 隔离数据目录，避免污染真实 data/。
"""

import os
import json
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from work_manager import WorkManager


@pytest.fixture()
def wm(tmp_path):
    return WorkManager(str(tmp_path))


def _bot_info(**over):
    """构造一个完整的 Coze BotInfo 样例。"""
    info = {
        "name": "测试智能体",
        "description": "测试描述",
        "prompt_info": {"prompt": "你是测试助手"},
        "onboarding_info": {"prologue": "你好", "suggested_questions": ["问题1", "问题2"]},
        "model_info": {"response_format": "text", "model_name": "gpt-4"},
        "variables": [
            {"keyword": "var1", "description": "变量1", "enable": True, "default_value": "默认1"},
            {"keyword": "hidden_var", "description": "隐藏变量", "enable": False},
        ],
        "shortcut_commands": [
            {"title": "快捷1", "components": [
                {"name": "comp1", "description": "组件1", "type": "select", "is_hide": False, "default_value": ""},
            ]},
            {"title": "无组件快捷", "components": []},
        ],
        "workflow_info_list": [],
        "plugin_info_list": [],
        "icon_url": "http://example.com/a.png",
        "bot_id": "bot-123",
    }
    info.update(over)
    return info


# ---------- import_from_coze ----------

class TestImportFromCoze:
    def test_import_basic(self, wm):
        work = wm.import_from_coze(_bot_info(), "pat-token", access_code="1234")
        assert work["id"]
        assert work["name"] == "测试智能体"
        assert work["pat_token"] == "pat-token"
        assert work["access_code"] == "1234"
        assert work["interaction_type"] == "mixed"  # 有变量 + 有系统提示词
        assert work["system_prompt"] == "你是测试助手"
        assert work["prologue"] == "你好"
        assert work["suggested_questions"] == ["问题1", "问题2"]
        assert work["model_name"] == "gpt-4"
        assert work["response_format"] == "text"
        assert work["coze_bot_id"] == "bot-123"
        assert work["is_public"] is True
        # 变量转 parameters：隐藏变量被跳过
        names = [p["name"] for p in work["parameters"]]
        assert "var1" in names
        assert "hidden_var" not in names
        # 快捷指令组件也进 parameters
        assert "comp1" in names
        # 持久化验证
        assert wm.get_work(work["id"])["id"] == work["id"]

    def test_import_chat_type(self, wm):
        """无变量、无系统提示词 → chat 类型。"""
        info = _bot_info(variables=[], prompt_info={"prompt": ""})
        work = wm.import_from_coze(info, "pat")
        assert work["interaction_type"] == "chat"

    def test_import_form_type(self, wm):
        """有变量、无系统提示词 → form 类型。"""
        info = _bot_info(prompt_info={"prompt": ""})
        work = wm.import_from_coze(info, "pat")
        assert work["interaction_type"] == "form"

    def test_import_default_name(self, wm):
        work = wm.import_from_coze(_bot_info(name="", description=""), "pat")
        # dict.get(name, "未命名作品") 对空串不触发默认值（Python dict.get 语义），保留空串
        assert work["name"] == ""
        # description 回退到 prologue
        assert work["description"] == "你好"

    def test_import_bad_response_format(self, wm):
        info = _bot_info(model_info={"response_format": "xml", "model_name": "m"})
        work = wm.import_from_coze(info, "pat")
        assert work["response_format"] == "text"  # 非法回退 text


# ---------- import_dataset ----------

class TestImportDataset:
    def test_import_dataset(self, wm):
        work = wm.import_dataset({"name": "知识库A", "description": "知识库描述", "id": "ds-1"}, "pat")
        assert work["name"] == "知识库A"
        assert work["coze_meta"]["type"] == "dataset"
        assert work["coze_meta"]["dataset_id"] == "ds-1"
        assert work["interaction_type"] == "chat"
        assert "知识库A" in work["system_prompt"]
        assert work["description"] == "知识库描述"

    def test_import_dataset_default_desc(self, wm):
        work = wm.import_dataset({"name": "知识库B", "id": "ds-2"}, "pat")
        assert work["description"] == "知识库「知识库B」"


# ---------- import_workflow ----------

class TestImportWorkflow:
    def test_import_workflow(self, wm):
        work = wm.import_workflow({"name": "工作流A", "description": "工作流描述", "id": "wf-1", "icon_url": "http://x/i.png"}, "pat", workspace_id="ws-1")
        assert work["name"] == "工作流A"
        assert work["coze_meta"]["type"] == "workflow"
        assert work["coze_meta"]["workflow_id"] == "wf-1"
        assert work["coze_workflow_id"] == "wf-1"
        assert work["interaction_type"] == "form"
        assert work["llm_config"]["base_url"] == ""
        assert work["description"] == "工作流描述"


# ---------- 查询 / 更新 / 删除 ----------

class TestQueryAndUpdate:
    def test_list_works(self, wm):
        assert wm.list_works() == []
        wm.import_from_coze(_bot_info(), "pat")
        wm.import_dataset({"name": "知识库C"}, "pat")
        works = wm.list_works()
        assert len(works) == 2

    def test_get_work_nonexistent(self, wm):
        assert wm.get_work("nonexistent") is None

    def test_get_work_public(self, wm):
        work = wm.import_from_coze(_bot_info(), "secret-pat")
        pub = wm.get_work_public(work["id"])
        assert pub["id"] == work["id"]
        assert "pat_token" not in pub  # 公开信息不含敏感 token

    def test_get_work_public_nonexistent(self, wm):
        assert wm.get_work_public("nonexistent") is None

    def test_update_work(self, wm):
        work = wm.import_from_coze(_bot_info(), "pat")
        wm.update_work(work["id"], {"name": "改名后", "is_public": False})
        updated = wm.get_work(work["id"])
        assert updated["name"] == "改名后"
        assert updated["is_public"] is False

    def test_update_work_nonexistent(self, wm):
        assert wm.update_work("nonexistent", {"name": "x"}) is None

    def test_delete_work(self, wm):
        work = wm.import_from_coze(_bot_info(), "pat")
        assert wm.delete_work(work["id"]) is True
        assert wm.get_work(work["id"]) is None
        assert wm.delete_work(work["id"]) is False


# ---------- 数据损坏容错 ----------

class TestCorruptData:
    def test_list_works_with_corrupt_json(self, wm):
        work = wm.import_from_coze(_bot_info(), "pat")
        # 写入非法 JSON
        with open(wm._work_filepath(work["id"]), "w", encoding="utf-8") as f:
            f.write("{invalid json")
        # 不抛异常，跳过该文件
        assert wm.list_works() == []

    def test_get_work_with_corrupt_json(self, wm):
        work = wm.import_from_coze(_bot_info(), "pat")
        with open(wm._work_filepath(work["id"]), "w", encoding="utf-8") as f:
            f.write("{invalid")
        assert wm.get_work(work["id"]) is None
