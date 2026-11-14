# -*- coding: utf-8 -*-
"""多 Agent 并行调度、模型路由、聚合与降级的端到端集成测试。"""

import copy
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.novel_creation.agent_client import CozeAgentClient
from modules.novel_creation.model_router import ModelRouter
from modules.novel_creation.parallel_agent_executor import ParallelAgentExecutor
from modules.novel_creation.role_agent_scheduler import RoleAgentScheduler


class _FakeConfigLoader:
    def load_global_config(self):
        return {
            "model_config": {
                "models": ["scene-model", "root-override-model"],
                "default_model": "default-model",
                "route_rules": [
                    {"scene": "role_agent_invoke", "model": "scene-model"},
                ],
            },
        }


class _FakeRoleStore:
    def __init__(self, bindings):
        self._bindings = bindings
        self.memory = {}
        self._lock = threading.Lock()

    def get_bindings(self, project_id, role_id, enabled=None):
        bindings = [dict(binding) for binding in self._bindings]
        if enabled is not None:
            bindings = [
                binding for binding in bindings
                if binding.get("enabled") is enabled
            ]
        return sorted(bindings, key=lambda binding: binding["step_order"])

    def get_memory(self, project_id, role_id, agent_id):
        key = (project_id, role_id, agent_id)
        with self._lock:
            return copy.deepcopy(self.memory.get(key, {}))

    def set_memory(self, project_id, role_id, agent_id, memory_state):
        key = (project_id, role_id, agent_id)
        with self._lock:
            self.memory[key] = copy.deepcopy(memory_state)


class _FakeProjectStore:
    def __init__(self):
        self.calls = []
        self._lock = threading.Lock()

    def append_tool_call(self, project_id, tool_name, request, response, status):
        with self._lock:
            self.calls.append({
                "project_id": project_id,
                "tool_name": tool_name,
                "request": copy.deepcopy(request),
                "response": copy.deepcopy(response),
                "status": status,
            })


class _FakeCozeHttpClient:
    def __init__(self, responder):
        self._responder = responder
        self.calls = []
        self._lock = threading.Lock()

    def chat(
        self, bot_id, user_message, conversation_id="", parameters=None, model=None,
    ):
        call = {
            "bot_id": bot_id,
            "user_message": user_message,
            "conversation_id": conversation_id,
            "parameters": parameters,
            "model": model,
        }
        with self._lock:
            self.calls.append(call)
        return self._responder(call)


def _make_scheduler(role_store, project_store, coze_http, executor):
    agent_client = CozeAgentClient(coze_http)
    return RoleAgentScheduler(
        role_store=role_store,
        project_store=project_store,
        agent_client=agent_client,
        executor=executor,
        clients={"coze": agent_client},
        model_router=ModelRouter(_FakeConfigLoader()),
        timeout=3,
        max_retries=0,
        backoff=0,
    )


def test_dag_runs_children_in_parallel_and_merges_routed_outputs() -> None:
    root_agent = "root-agent"
    child_agents = {"child-a-agent", "child-b-agent"}
    final_agent = "final-agent"
    all_agents = {root_agent, final_agent, *child_agents}
    bindings = [
        {
            "id": "root-binding",
            "agent_id": root_agent,
            "step_order": 1,
            "enabled": True,
            "model": "root-override-model",
        },
        {
            "id": "child-a-binding",
            "agent_id": "child-a-agent",
            "step_order": 2,
            "enabled": True,
            "depends_on": ["root-binding"],
        },
        {
            "id": "child-b-binding",
            "agent_id": "child-b-agent",
            "step_order": 3,
            "enabled": True,
            "depends_on": ["root-binding"],
        },
        {
            "id": "final-binding",
            "agent_id": final_agent,
            "step_order": 4,
            "enabled": True,
            "depends_on": ["child-a-binding", "child-b-binding"],
        },
    ]
    role_store = _FakeRoleStore(bindings)
    project_store = _FakeProjectStore()
    child_barrier = threading.Barrier(2)
    completed = set()
    completed_lock = threading.Lock()

    def respond(call):
        bot_id = call["bot_id"]
        with completed_lock:
            if bot_id in child_agents:
                assert root_agent in completed
            if bot_id == final_agent:
                assert child_agents.issubset(completed)

        if bot_id in child_agents:
            child_barrier.wait(timeout=2)

        with completed_lock:
            completed.add(bot_id)
        return {
            "success": True,
            "content": {bot_id: f"{bot_id}-result"},
            "conversation_id": call["conversation_id"],
        }

    coze_http = _FakeCozeHttpClient(respond)
    context = {"base": "preserved", "nested": {"original": True}}
    original_context = copy.deepcopy(context)

    with ThreadPoolExecutor(max_workers=4) as pool:
        scheduler = _make_scheduler(role_store, project_store, coze_http, pool)
        assert isinstance(scheduler.parallel_executor, ParallelAgentExecutor)
        result = scheduler.invoke_role_agents(
            "project-1", "role-1", 4, context,
        )

    expected_outputs = {
        agent_id: f"{agent_id}-result" for agent_id in all_agents
    }
    assert result == {**original_context, **expected_outputs}
    assert context == original_context
    assert completed == all_agents

    assert len(coze_http.calls) == 4
    calls_by_agent = {call["bot_id"]: call for call in coze_http.calls}
    assert set(calls_by_agent) == all_agents
    for agent_id, output in expected_outputs.items():
        call = calls_by_agent[agent_id]
        expected_model = (
            "root-override-model" if agent_id == root_agent else "scene-model"
        )
        assert call["model"] == expected_model
        assert call["conversation_id"] == f"role-1:{agent_id}"
        assert call["parameters"] == {}
        assert role_store.memory[("project-1", "role-1", agent_id)] == {
            agent_id: output,
        }

    assert len(project_store.calls) == 4
    assert {call["status"] for call in project_store.calls} == {"success"}


def test_final_failure_degrades_and_dependent_agent_still_runs() -> None:
    bindings = [
        {
            "id": "bad-binding",
            "agent_id": "bad-agent",
            "step_order": 1,
            "enabled": True,
        },
        {
            "id": "good-binding",
            "agent_id": "good-agent",
            "step_order": 2,
            "enabled": True,
            "depends_on": ["bad-binding"],
        },
    ]
    role_store = _FakeRoleStore(bindings)
    project_store = _FakeProjectStore()
    bad_response_sent = threading.Event()

    def respond(call):
        if call["bot_id"] == "bad-agent":
            bad_response_sent.set()
            return {
                "success": False,
                "error": "永久失败",
                "conversation_id": call["conversation_id"],
            }

        assert bad_response_sent.is_set()
        return {
            "success": True,
            "content": {"good_output": "done"},
            "conversation_id": call["conversation_id"],
        }

    coze_http = _FakeCozeHttpClient(respond)
    with ThreadPoolExecutor(max_workers=2) as pool:
        scheduler = _make_scheduler(role_store, project_store, coze_http, pool)
        result = scheduler.invoke_role_agents(
            "project-1", "role-1", 2, {"base": 1},
        )

    assert result == {"base": 1, "good_output": "done"}
    assert "degraded" not in result
    assert [call["bot_id"] for call in coze_http.calls].count("bad-agent") == 1
    assert [call["bot_id"] for call in coze_http.calls].count("good-agent") == 1

    degraded_audits = [
        call for call in project_store.calls if call["status"] == "degraded"
    ]
    assert len(degraded_audits) == 1
    audit = degraded_audits[0]
    assert audit["project_id"] == "project-1"
    assert audit["tool_name"] == "role_agent_invoke"
    assert audit["request"]["binding_id"] == "bad-binding"
    assert audit["request"]["agent_id"] == "bad-agent"
    assert audit["response"]["degraded"] is True
    assert audit["response"]["attempts"] == 1
