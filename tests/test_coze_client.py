# -*- coding: utf-8 -*-
"""coze_client.py 补测（P5-T1：覆盖率补测）。

mock requests，不发起真实网络。覆盖：
get_all_resources / get_bot_list / get_bot_info / test_connection /
get_dataset_list / get_workflow_list / convert_to_agent_config /
run_workflow / chat / upload_file。
"""

import io
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from coze_client import ChatOptions, CozeClient  # noqa: E402


def _resp(payload, status=200):
    """构造 requests.Response 风格 mock 对象。"""
    r = mock.Mock()
    r.json.return_value = payload
    r.raise_for_status.return_value = None
    r.status_code = status
    return r


class _FakeStreamResp:
    def __init__(self):
        self.status_code = 200

    def raise_for_status(self):
        return None


# ---------- get_bot_list / get_bot_info ----------

class TestBotList:
    def test_success(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({"code": 0, "data": {"items": [{"id": "b1"}], "total": 1}})
            res = client.get_bot_list("ws1")
        assert res["success"] is True
        assert len(res["bots"]) == 1
        assert res["total"] == 1
        # 断言请求带 workspace_id
        assert m.call_args.kwargs["params"]["workspace_id"] == "ws1"

    def test_failure_code(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({"code": 1, "msg": "token 无效"})
            res = client.get_bot_list()
        assert res["success"] is False
        assert res["error"] == "token 无效"

    def test_exception(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.side_effect = RuntimeError("网络错误")
            res = client.get_bot_list()
        assert res["success"] is False
        assert "网络错误" in res["error"]


class TestBotInfo:
    def test_success(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({"code": 0, "data": {"bot_id": "b1"}})
            res = client.get_bot_info("b1", is_published=True)
        assert res["success"] is True
        assert res["data"]["bot_id"] == "b1"

    def test_failure(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({"code": 1, "msg": "不存在"})
            res = client.get_bot_info("b1")
        assert res["success"] is False
        assert res["error"] == "不存在"


# ---------- get_dataset_list ----------

class TestDatasetList:
    def test_success(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({"code": 0, "data": [{"id": "d1"}]})
            res = client.get_dataset_list()
        assert res["success"] is True
        assert res["items"] == [{"id": "d1"}]

    def test_failure(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({"code": 1, "msg": "失败"})
            res = client.get_dataset_list()
        assert res["success"] is False


# ---------- get_workflow_list ----------

class TestWorkflowList:
    def test_success_nested_dict(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({
                "code": 0,
                "data": {"items": {"has_more": False, "items": [
                    {"workflow_id": "w1", "workflow_name": "工作流1"},
                ]}},
            })
            res = client.get_workflow_list("ws1")
        assert res["success"] is True
        assert res["items"][0]["id"] == "w1"
        assert res["items"][0]["name"] == "工作流1"

    def test_success_flat_list(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({"code": 0, "data": [
                {"workflow_id": "w2", "workflow_name": "工作流2"},
            ]})
            res = client.get_workflow_list()
        assert res["items"][0]["id"] == "w2"

    def test_success_no_workspace_param(self):
        # 无 workspace_id 时不应带 workspace_id 参数
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({"code": 0, "data": []})
            client.get_workflow_list()
        assert "workspace_id" not in m.call_args.kwargs["params"]

    def test_failure(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.get") as m:
            m.return_value = _resp({"code": 1, "msg": "失败"})
            res = client.get_workflow_list()
        assert res["success"] is False


# ---------- get_all_resources / test_connection ----------

class TestAllResources:
    def test_both_sources(self):
        client = CozeClient("pat")
        with mock.patch.object(client, "get_bot_list") as gb, \
                mock.patch.object(client, "get_workflow_list") as gw:
            gb.return_value = {"success": True, "bots": [{"id": "b1"}], "total": 1}
            gw.return_value = {"success": True, "items": [{"id": "w1"}]}
            res = client.get_all_resources("ws1")
        assert res["success"] is True
        assert res["total"] == 2
        # 去重 _source_type 标记
        types = {it["_source_type"] for it in res["bots"]}
        assert types == {"bot", "workflow"}

    def test_bots_failure_still_workflows(self):
        client = CozeClient("pat")
        with mock.patch.object(client, "get_bot_list") as gb, \
                mock.patch.object(client, "get_workflow_list") as gw:
            gb.return_value = {"success": False, "error": "x"}
            gw.return_value = {"success": True, "items": [{"id": "w1"}]}
            res = client.get_all_resources()
        assert res["total"] == 1

    def test_bots_raises(self):
        client = CozeClient("pat")
        with mock.patch.object(client, "get_bot_list") as gb, \
                mock.patch.object(client, "get_workflow_list") as gw:
            gb.side_effect = RuntimeError("boom")
            gw.return_value = {"success": True, "items": []}
            res = client.get_all_resources()
        assert res["success"] is True

    def test_test_connection(self):
        client = CozeClient("pat")
        with mock.patch.object(client, "get_all_resources") as ga:
            ga.return_value = {"success": True, "total": 0}
            assert client.test_connection("ws1")["success"] is True


# ---------- convert_to_agent_config ----------

class TestConvertToAgentConfig:
    def _bot(self):
        return {
            "name": "测试智能体",
            "description": "desc",
            "icon_url": "http://icon.png",
            "bot_id": "b1",
            "prompt_info": {"prompt": "系统提示"},
            "onboarding_info": {
                "prologue": "开场白",
                "suggested_questions": ["q1", "q2"],
            },
            "model_info": {"response_format": "json", "model_name": "gpt-4"},
            "variables": [
                {"keyword": "var1", "description": "变量1", "enable": True, "default_value": "dv"},
                {"keyword": "var2", "enable": False},  # 禁用跳过
            ],
            "shortcut_commands": [
                {"components": [{"name": "comp1", "description": "组件1", "type": "text",
                                 "is_hide": False, "default_value": "cd"}]},
            ],
            "workflow_info_list": [{"id": "wf1"}],
            "plugin_info_list": [{"id": "pl1"}],
            "bot_mode": 1,
        }

    def test_full_config(self):
        client = CozeClient("pat")
        cfg = client.convert_to_agent_config(self._bot())
        assert cfg["name"] == "测试智能体"
        assert cfg["system_prompt"] == "系统提示"
        assert cfg["interaction_type"] == "mixed"
        assert cfg["output_format"]["type"] == "json"
        # 变量 + 快捷指令组件合并
        names = [p["name"] for p in cfg["parameters"]]
        assert "var1" in names
        assert "var2" not in names  # 禁用跳过
        assert "comp1" in names
        assert cfg["coze_meta"]["bot_mode"] == 1
        assert cfg["api_config"]["bot_id"] == "b1"
        # 敏感字段不落盘
        assert cfg["api_config"]["api_key"] == ""

    def test_chat_only_no_params(self):
        client = CozeClient("pat")
        cfg = client.convert_to_agent_config({"name": "n", "variables": []})
        assert cfg["interaction_type"] == "chat"
        assert cfg["parameters"] == []
        assert cfg["name"] == "n"

    def test_form_only_no_prompt(self):
        client = CozeClient("pat")
        cfg = client.convert_to_agent_config({
            "name": "n",
            "variables": [{"keyword": "v", "description": "d", "enable": True}],
        })
        assert cfg["interaction_type"] == "form"


# ---------- run_workflow ----------

class TestRunWorkflow:
    def test_stream(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as m:
            m.return_value = _FakeStreamResp()
            res = client.run_workflow("w1", stream=True)
        assert res["success"] is True
        assert res["data"] == ""
        assert res["response"] is m.return_value

    def test_non_stream_success(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as m:
            m.return_value = _resp({"code": 0, "data": "结果", "debug_url": "http://d"})
            res = client.run_workflow("w1", {"a": 1})
        assert res["success"] is True
        assert res["data"] == "结果"

    def test_non_stream_failure(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as m:
            m.return_value = _resp({"code": 1, "msg": "执行失败"})
            res = client.run_workflow("w1")
        assert res["success"] is False
        assert res["error"] == "执行失败"

    def test_exception(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as m:
            m.side_effect = RuntimeError("boom")
            res = client.run_workflow("w1")
        assert res["success"] is False


# ---------- chat ----------

class TestChat:
    def test_validation_no_bot(self):
        client = CozeClient("pat")
        res = client.chat("", "msg")
        assert res["success"] is False

    def test_validation_no_message(self):
        client = CozeClient("pat")
        res = client.chat("b1", "")
        assert res["success"] is False

    def test_success_completed(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as mp, \
                mock.patch("coze_client.requests.get") as mg:
            mp.return_value = _resp({"code": 0, "data": {"id": "c1", "conversation_id": "conv1"}})
            mg.return_value = _resp({"code": 0, "data": {
                "status": "completed",
                "messages": [{"role": "assistant", "type": "answer", "content": "你好"}],
            }})
            res = client.chat("b1", "你好", "r1:a1", {"x": 1})
        assert res["success"] is True
        assert res["content"] == "你好"
        assert res["conversation_id"] == "conv1"

    def test_accepts_model_kwarg(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as mp, \
                mock.patch("coze_client.requests.get") as mg:
            mp.return_value = _resp({"code": 0, "data": {"id": "c1"}})
            mg.return_value = _resp({"code": 0, "data": {
                "status": "completed",
                "messages": [{"role": "assistant", "type": "answer", "content": "你好"}],
            }})
            res = client.chat("b1", "msg", model="gpt-4o")
        assert res["success"] is True
        assert mp.call_args.kwargs["json"]["model"] == "gpt-4o"

    def test_create_failure(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as mp:
            mp.return_value = _resp({"code": 1, "msg": "创建失败"})
            res = client.chat("b1", "msg")
        assert res["success"] is False
        assert res["error"] == "创建失败"

    def test_no_chat_id(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as mp:
            mp.return_value = _resp({"code": 0, "data": {}})
            res = client.chat("b1", "msg")
        assert res["success"] is False
        assert "chat_id" in res["error"]

    def test_status_failed(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as mp, \
                mock.patch("coze_client.requests.get") as mg:
            mp.return_value = _resp({"code": 0, "data": {"id": "c1"}})
            mg.return_value = _resp({"code": 0, "data": {
                "status": "failed",
                "last_error": {"msg": "执行失败"},
            }})
            res = client.chat("b1", "msg")
        assert res["success"] is False
        assert res["error"] == "执行失败"

    def test_status_requires_action(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as mp, \
                mock.patch("coze_client.requests.get") as mg:
            mp.return_value = _resp({"code": 0, "data": {"id": "c1"}})
            mg.return_value = _resp({"code": 0, "data": {"status": "requires_action"}})
            res = client.chat("b1", "msg")
        assert res["success"] is False

    def test_timeout_loop(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as mp, \
                mock.patch("coze_client.requests.get") as mg:
            mp.return_value = _resp({"code": 0, "data": {"id": "c1"}})
            mg.return_value = _resp({"code": 0, "data": {"status": "in_progress"}})
            res = client.chat("b1", "msg")
        assert res["success"] is False
        assert res["error"] == "查询超时"

    def test_options_dict(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as mp, \
                mock.patch("coze_client.requests.get") as mg:
            mp.return_value = _resp({"code": 0, "data": {"id": "c1"}})
            mg.return_value = _resp({"code": 0, "data": {
                "status": "completed",
                "messages": [{"role": "assistant", "type": "answer", "content": "c"}],
            }})
            res = client.chat("b1", "msg", options={"user_id": "u2", "max_poll": 3})
        assert res["success"] is True

    def test_options_object(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as mp, \
                mock.patch("coze_client.requests.get") as mg:
            mp.return_value = _resp({"code": 0, "data": {"id": "c1"}})
            mg.return_value = _resp({"code": 0, "data": {
                "status": "completed",
                "messages": [],
            }})
            res = client.chat("b1", "msg", options=ChatOptions(max_poll=2))
        assert res["success"] is True
        assert res["content"] == ""


# ---------- upload_file ----------

class TestUploadFile:
    def test_upload_path(self, tmp_path):
        client = CozeClient("pat")
        p = tmp_path / "a.png"
        p.write_bytes(b"data")
        with mock.patch("coze_client.requests.post") as m:
            m.return_value = _resp({"code": 0, "data": {"id": "f1", "file_name": "a.png"}})
            res = client.upload_file(str(p))
        assert res["success"] is True
        assert res["file_id"] == "f1"

    def test_upload_fileobj(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as m:
            m.return_value = _resp({"code": 0, "data": {"id": "f1", "file_name": "a.png"}})
            res = client.upload_file(io.BytesIO(b"data"), "a.png", "image/png")
        assert res["success"] is True
        assert res["file_id"] == "f1"

    def test_upload_failure(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as m:
            m.return_value = _resp({"code": 1, "msg": "上传失败"})
            res = client.upload_file(io.BytesIO(b"data"), "a.png")
        assert res["success"] is False

    def test_upload_exception(self):
        client = CozeClient("pat")
        with mock.patch("coze_client.requests.post") as m:
            m.side_effect = RuntimeError("boom")
            res = client.upload_file(io.BytesIO(b"data"), "a.png")
        assert res["success"] is False
