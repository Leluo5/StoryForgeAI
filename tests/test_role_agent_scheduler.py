# -*- coding: utf-8 -*-
"""role_agent_scheduler.py 补测（P5-T1：覆盖率补测）。

覆盖 merge_result / _build_sys_prompt / _invoke_agent 成功与失败路径 /
_compose_user_message / _extract_output / invoke_role_agents 命中与未命中。
用 mock role_store / project_store / agent_client / executor。
"""

import os
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError, bad_gateway, bad_request, server_error
from modules.novel_creation.role_agent_scheduler import RoleAgentScheduler, merge_result


class _FakeRoleStore:
    def __init__(self):
        self.memory = {}

    def get_memory(self, project_id, role_id, agent_id):
        return self.memory.get((role_id, agent_id), {})

    def set_memory(self, project_id, role_id, agent_id, memory_state):
        self.memory[(role_id, agent_id)] = memory_state

    def get_bindings(self, project_id, role_id, enabled=None):
        bindings = self._bindings
        if enabled is not None:
            bindings = [b for b in bindings if b["enabled"] is enabled]
        return sorted(bindings, key=lambda b: b["step_order"])

    def set_bindings(self, bindings):
        self._bindings = bindings


class _FakeProjectStore:
    def __init__(self):
        self.calls = []

    def append_tool_call(self, project_id, tool_name, request, response, status):
        self.calls.append((tool_name, request, response, status))


class _FakeAgentClient:
    def __init__(self, result=None, exc=None):
        self.result = result
        self.exc = exc
        self.chat_calls = []

    def chat(self, bot_id, user_message, conversation_id, parameters):
        self.chat_calls.append((bot_id, user_message, conversation_id))
        if self.exc:
            raise self.exc
        return self.result


def _make(bindings=None, agent_result=None, agent_exc=None):
    rs = _FakeRoleStore()
    rs.set_bindings(bindings or [])
    ps = _FakeProjectStore()
    ac = _FakeAgentClient(result=agent_result, exc=agent_exc)
    scheduler = RoleAgentScheduler(rs, ps, ac, executor=ThreadPoolExecutor(max_workers=2))
    return scheduler, rs, ps, ac


@pytest.fixture
def scheduler():
    sched, _rs, _ps, _ac = _make()
    return sched


# ---------- merge_result ----------

class TestMergeResult:
    def test_base_non_dict(self):
        assert merge_result(None, {"a": 1}) == {"a": 1}

    def test_result_non_dict(self):
        assert merge_result({"a": 1}, None) == {"a": 1}

    def test_shallow_override(self):
        merged = merge_result({"a": 1, "b": 2}, {"b": 3, "c": 4})
        assert merged == {"a": 1, "b": 3, "c": 4}

    def test_nested_dict_merged_one_level(self):
        merged = merge_result(
            {"meta": {"x": 1, "y": 2}},
            {"meta": {"y": 9, "z": 3}},
        )
        assert merged["meta"] == {"x": 1, "y": 9, "z": 3}

    def test_nested_dict_override_whole_if_not_dict(self):
        merged = merge_result({"meta": {"x": 1}}, {"meta": "flat"})
        assert merged["meta"] == "flat"


# ---------- 内部方法 ----------

class TestInternals:
    def test_build_sys_prompt(self, scheduler):
        assert scheduler._build_sys_prompt("r1") == "你扮演角色r1，保持身份一致"

    def test_compose_user_message_full(self, scheduler):
        msg = scheduler._compose_user_message("sys", {"mood": "平静"}, {"role": "林远"})
        assert "sys" in msg
        assert "【记忆】" in msg
        assert "【上下文】" in msg

    def test_compose_user_message_empty(self, scheduler):
        msg = scheduler._compose_user_message("sys", {}, {})
        assert msg == "sys"

    def test_extract_output_dict_content(self, scheduler):
        assert scheduler._extract_output({"content": {"a": 1}}) == {"a": 1}

    def test_extract_output_str_content(self, scheduler):
        assert scheduler._extract_output({"content": "文本"}) == {"content": "文本"}

    def test_extract_output_no_content(self, scheduler):
        out = scheduler._extract_output({"success": True, "a": 1, "error": "e", "debug_url": "u"})
        assert out == {"a": 1}

    def test_safe_json_fallback(self, scheduler):
        # 不可序列化对象
        assert scheduler._safe_json(object())  # 返回 str(obj)，不抛异常


# ---------- _invoke_agent ----------

class TestInvokeAgent:
    def test_success(self):
        sched, rs, ps, ac = _make(
            agent_result={"success": True, "content": {"mood": "平静"}, "conversation_id": "c1"}
        )
        out = sched._invoke_agent("p1", "r1", "a1", {"step_order": 3}, {"role": "林远"})
        assert out == {"mood": "平静"}
        # 记忆写回
        assert rs.memory[("r1", "a1")] == {"mood": "平静"}
        # 审计成功记录
        assert ps.calls[-1][3] == "success"

    def test_success_str_content(self):
        sched, rs, ps, ac = _make(
            agent_result={"success": True, "content": "返回文本"}
        )
        out = sched._invoke_agent("p1", "r1", "a1", {"step_order": 1}, {})
        assert out == {"content": "返回文本"}

    def test_agent_exception(self):
        sched, rs, ps, ac = _make(agent_exc=RuntimeError("上游挂了"))
        with pytest.raises(AppError) as ei:
            sched._invoke_agent("p1", "r1", "a1", {"step_order": 1}, {})
        assert ei.value.code == 500
        # 审计失败记录
        assert ps.calls[-1][3] == "failed"

    def test_agent_returns_failure(self):
        sched, rs, ps, ac = _make(
            agent_result={"success": False, "error": "权限不足"}
        )
        with pytest.raises(AppError) as ei:
            sched._invoke_agent("p1", "r1", "a1", {"step_order": 1}, {})
        assert ei.value.code == 502
        assert ps.calls[-1][3] == "failed"

    def test_agent_returns_non_dict(self):
        sched, rs, ps, ac = _make(agent_result="纯字符串")
        with pytest.raises(AppError) as ei:
            sched._invoke_agent("p1", "r1", "a1", {"step_order": 1}, {})
        assert ei.value.code == 502


# ---------- invoke_role_agents 主入口 ----------

class TestInvokeRoleAgents:
    def test_no_bindings_returns_context_copy(self):
        sched, rs, ps, ac = _make(bindings=[])
        ctx = {"role": "林远"}
        result = sched.invoke_role_agents("p1", "r1", 5, ctx)
        assert result == ctx
        assert result is not ctx  # 浅拷贝

    def test_binding_beyond_step_not_hit(self):
        sched, rs, ps, ac = _make(
            bindings=[{"agent_id": "a1", "step_order": 7, "enabled": True}],
            agent_result={"success": True, "content": {"x": 1}},
        )
        result = sched.invoke_role_agents("p1", "r1", 3, {"role": "林远"})
        assert result == {"role": "林远"}
        assert ac.chat_calls == []  # 未命中不调用

    def test_multiple_hits_merge_context(self):
        sched, rs, ps, ac = _make(
            bindings=[
                {"agent_id": "a1", "step_order": 1, "enabled": True},
                {"agent_id": "a2", "step_order": 2, "enabled": True},
            ],
            agent_result={"success": True, "content": {"mood": "平静"}},
        )
        result = sched.invoke_role_agents("p1", "r1", 2, {"role": "林远"})
        assert result["mood"] == "平静"
        # 两个绑定都命中
        assert len(ac.chat_calls) == 2

    def test_invalid_step_order(self):
        sched, rs, ps, ac = _make()
        with pytest.raises(AppError) as ei:
            sched.invoke_role_agents("p1", "r1", 12, {})
        assert ei.value.code == 400

    def test_empty_agent_id_skipped(self):
        sched, rs, ps, ac = _make(
            bindings=[{"agent_id": "", "step_order": 1, "enabled": True}],
        )
        result = sched.invoke_role_agents("p1", "r1", 1, {"role": "林远"})
        assert result == {"role": "林远"}
        assert ac.chat_calls == []
