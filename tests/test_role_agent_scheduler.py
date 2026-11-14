# -*- coding: utf-8 -*-
"""role_agent_scheduler.py 补测（P5-T1：覆盖率补测）。

覆盖 merge_result / _build_sys_prompt / _invoke_agent 成功与失败路径 /
_compose_user_message / _extract_output / invoke_role_agents 命中与未命中。
用 mock role_store / project_store / agent_client / executor。
"""

import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError, bad_gateway, bad_request, server_error
from modules.novel_creation.parallel_agent_executor import ExecuteResult, PerAgentResult
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


def _make(bindings=None, agent_result=None, agent_exc=None, **scheduler_kwargs):
    rs = _FakeRoleStore()
    rs.set_bindings(bindings or [])
    ps = _FakeProjectStore()
    ac = _FakeAgentClient(result=agent_result, exc=agent_exc)
    scheduler = RoleAgentScheduler(
        rs, ps, ac, executor=ThreadPoolExecutor(max_workers=2), **scheduler_kwargs,
    )
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


# ---------- Task 8：DAG 并行、模型路由、双环境与降级 ----------

class _CallbackAgentClient:
    def __init__(self, handler):
        self.handler = handler
        self.chat_calls = []

    def chat(self, bot_id, user_message, conversation_id, parameters, **kwargs):
        self.chat_calls.append({
            "bot_id": bot_id,
            "user_message": user_message,
            "conversation_id": conversation_id,
            "parameters": parameters,
            "kwargs": kwargs,
        })
        return self.handler(bot_id)


class _RecordingModelRouter:
    def __init__(self, resolved_model):
        self.resolved_model = resolved_model
        self.calls = []

    def resolve(self, scene, override=None):
        self.calls.append((scene, override))
        return self.resolved_model


class _StubParallelExecutor:
    def execute(self, tasks, context):
        self.tasks = tasks
        self.context = context
        return ExecuteResult(
            merged={"meta": {"y": 9}},
            per_agent=[PerAgentResult(
                task_id=tasks[0].task_id,
                ok=True,
                output={"meta": {"y": 9}},
            )],
        )


class _AuditFailProjectStore(_FakeProjectStore):
    def append_tool_call(self, project_id, tool_name, request, response, status):
        super().append_tool_call(project_id, tool_name, request, response, status)
        if status == "degraded":
            raise RuntimeError("审计存储不可用")


def test_depends_on_builds_layers_and_same_layer_runs_in_parallel():
    child_barrier = threading.Barrier(2)
    completed = set()
    lock = threading.Lock()

    def respond(bot_id):
        if bot_id in {"child-a", "child-b"}:
            assert "root" in completed
            child_barrier.wait(timeout=1)
        if bot_id == "final":
            assert {"child-a", "child-b"}.issubset(completed)
        with lock:
            completed.add(bot_id)
        return {"success": True, "content": {bot_id: True}}

    client = _CallbackAgentClient(respond)
    sched, _rs, _ps, _original = _make(
        bindings=[
            {"id": "root", "agent_id": "root", "step_order": 1, "enabled": True},
            {"id": "child-a", "agent_id": "child-a", "step_order": 2,
             "enabled": True, "depends_on": ["root"]},
            {"id": "child-b", "agent_id": "child-b", "step_order": 3,
             "enabled": True, "depends_on": ["root"]},
            {"id": "final", "agent_id": "final", "step_order": 4,
             "enabled": True, "depends_on": ["child-a", "child-b"]},
        ],
        clients={"coze": client},
        timeout=2,
        max_retries=0,
        backoff=0,
    )

    result = sched.invoke_role_agents("p1", "r1", 4, {"base": 1})

    assert completed == {"root", "child-a", "child-b", "final"}
    assert result["root"] is True
    assert result["child-a"] is True
    assert result["child-b"] is True
    assert result["final"] is True


def test_multiple_hits_merge_outputs_and_empty_agent_id_is_skipped():
    client = _CallbackAgentClient(
        lambda bot_id: {"success": True, "content": {"results": {bot_id: "done"}}},
    )
    sched, _rs, _ps, _original = _make(
        bindings=[
            {"agent_id": "a1", "step_order": 1, "enabled": True},
            {"agent_id": "", "step_order": 2, "enabled": True},
            {"agent_id": "a2", "step_order": 3, "enabled": True},
        ],
        clients={"coze": client},
        max_retries=0,
        backoff=0,
    )

    result = sched.invoke_role_agents("p1", "r1", 3, {"role": "林远"})

    assert result == {
        "role": "林远",
        "results": {"a1": "done", "a2": "done"},
    }
    assert sorted(call["bot_id"] for call in client.chat_calls) == ["a1", "a2"]


def test_model_router_uses_role_agent_scene_override_and_resolved_model():
    router = _RecordingModelRouter("resolved-model")
    client = _CallbackAgentClient(
        lambda _bot_id: {"success": True, "content": {"ok": True}},
    )
    sched, _rs, _ps, _original = _make(
        bindings=[{
            "agent_id": "a1", "step_order": 1, "enabled": True,
            "model": "binding-model",
        }],
        clients={"coze": client},
        model_router=router,
        max_retries=0,
        backoff=0,
    )

    result = sched.invoke_role_agents("p1", "r1", 1, {})

    assert result["ok"] is True
    assert router.calls == [("role_agent_invoke", "binding-model")]
    assert client.chat_calls[0]["kwargs"] == {"model": "resolved-model"}


def test_binding_model_reaches_client_without_model_router():
    client = _CallbackAgentClient(
        lambda _bot_id: {"success": True, "content": {"ok": True}},
    )
    sched, _rs, _ps, _original = _make(
        bindings=[{
            "agent_id": "a1", "step_order": 1, "enabled": True,
            "model": "binding-model",
        }],
        clients={"coze": client},
        max_retries=0,
        backoff=0,
    )

    result = sched.invoke_role_agents("p1", "r1", 1, {})

    assert result["ok"] is True
    assert client.chat_calls[0]["kwargs"] == {"model": "binding-model"}


def test_agent_env_selects_injected_clients_and_trae_stub_degrades():
    coze = _CallbackAgentClient(
        lambda _bot_id: {"success": True, "content": {"coze": "ok"}},
    )

    def trae_unavailable(_bot_id):
        raise NotImplementedError("Trae 通道协议尚未定义")

    trae = _CallbackAgentClient(trae_unavailable)
    sched, _rs, ps, original = _make(
        bindings=[
            {"id": "b-coze", "agent_id": "a-coze", "step_order": 1,
             "enabled": True, "agent_env": "coze"},
            {"id": "b-trae", "agent_id": "a-trae", "step_order": 2,
             "enabled": True, "agent_env": "trae"},
        ],
        clients={"coze": coze, "trae": trae},
        max_retries=0,
        backoff=0,
    )

    result = sched.invoke_role_agents("p1", "r1", 2, {"base": 1})

    assert result == {"base": 1, "coze": "ok"}
    assert "degraded" not in result
    assert len(coze.chat_calls) == 1
    assert len(trae.chat_calls) == 1
    assert original.chat_calls == []
    assert any(call[3] == "degraded" for call in ps.calls)


def test_final_failure_degrades_without_blocking_next_layer_or_audit_failure():
    calls = []

    def respond(bot_id):
        calls.append(bot_id)
        if bot_id == "bad":
            raise RuntimeError("永久失败")
        return {"success": True, "content": {"good": "done"}}

    rs = _FakeRoleStore()
    rs.set_bindings([
        {"id": "bad-binding", "agent_id": "bad", "step_order": 1, "enabled": True},
        {"id": "good-binding", "agent_id": "good", "step_order": 2,
         "enabled": True, "depends_on": ["bad-binding"]},
    ])
    ps = _AuditFailProjectStore()
    original = _FakeAgentClient()
    client = _CallbackAgentClient(respond)
    sched = RoleAgentScheduler(
        rs, ps, original,
        executor=ThreadPoolExecutor(max_workers=2),
        clients={"coze": client},
        max_retries=1,
        backoff=0,
    )

    result = sched.invoke_role_agents("p1", "r1", 2, {"base": 1})

    assert result == {"base": 1, "good": "done"}
    assert "degraded" not in result
    assert calls.count("bad") == 2
    assert calls.count("good") == 1
    degraded_audits = [call for call in ps.calls if call[3] == "degraded"]
    assert len(degraded_audits) == 1
    assert degraded_audits[0][2]["degraded"] is True
    assert degraded_audits[0][2]["attempts"] == 2


def test_final_aggregation_uses_merge_result_instead_of_executor_merged_dict():
    parallel_executor = _StubParallelExecutor()
    sched, _rs, _ps, _original = _make(
        bindings=[{"agent_id": "a1", "step_order": 1, "enabled": True}],
        parallel_executor=parallel_executor,
    )

    result = sched.invoke_role_agents(
        "p1", "r1", 1, {"meta": {"x": 1, "y": 2}, "role": "林远"},
    )

    assert result == {"meta": {"x": 1, "y": 9}, "role": "林远"}
    assert parallel_executor.tasks[0].task_id == "a1"
    assert parallel_executor.tasks[0].payload["project_id"] == "p1"
    assert parallel_executor.tasks[0].payload["role_id"] == "r1"
