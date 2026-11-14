# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules.novel_creation.role_agent_scheduler import RoleAgentScheduler


class _RoleStore:
    def __init__(self, bindings):
        self.bindings = bindings
        self.memory = {}

    def get_bindings(self, project_id, role_id, enabled=None):
        return self.bindings

    def get_memory(self, project_id, role_id, agent_id):
        return self.memory.get((role_id, agent_id), {})

    def set_memory(self, project_id, role_id, agent_id, memory):
        self.memory[(role_id, agent_id)] = memory


class _ProjectStore:
    def append_tool_call(self, *args, **kwargs):
        pass


class _Client:
    def __init__(self):
        self.calls = []

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        return {"success": True, "content": {"ok": True}, "conversation_id": kwargs["conversation_id"]}


def _scheduler(bindings, resolver):
    role_store = _RoleStore(bindings)
    client = _Client()
    scheduler = RoleAgentScheduler(role_store, _ProjectStore(), client,
                                   clients={"coze": client}, max_workers=1)
    scheduler.set_agent_resolver(resolver)
    return scheduler, client


def test_resolver_overrides_platform_and_model():
    bindings = [{"id": "b1", "role_id": "r1", "agent_id": "legacy",
                 "step_order": 1, "enabled": True, "agent_ref_id": "a1", "agent_env": "coze"}]
    scheduler, client = _scheduler(bindings, lambda pid, aid: {
        "id": "a1", "status": "active", "platform": "coze",
        "platform_config": {"bot_id": "bot-real"},
        "model_config": {"model": "model-x"},
    })
    scheduler.invoke_role_agents("p1", "r1", 1, {})
    assert client.calls[0]["bot_id"] == "bot-real"
    assert client.calls[0]["model"] == "model-x"
    assert client.calls[0]["conversation_id"] == "r1:legacy"


def test_archived_agent_is_skipped():
    bindings = [{"id": "b1", "role_id": "r1", "agent_id": "legacy",
                 "step_order": 1, "enabled": True, "agent_ref_id": "a1"}]
    scheduler, client = _scheduler(bindings, lambda pid, aid: {
        "id": "a1", "status": "archived", "platform": "coze",
        "platform_config": {"bot_id": "bot-real"}, "model_config": {},
    })
    result = scheduler.invoke_role_agents("p1", "r1", 1, {"seed": 1})
    assert result == {"seed": 1}
    assert client.calls == []


def test_unconfigured_bot_raises_clear_error():
    bindings = [{"id": "b1", "role_id": "r1", "agent_id": "legacy",
                 "step_order": 1, "enabled": True, "agent_ref_id": "a1"}]
    scheduler, _ = _scheduler(bindings, lambda pid, aid: {
        "id": "a1", "status": "active", "platform": "coze",
        "platform_config": {"bot_id": ""}, "model_config": {},
    })
    with pytest.raises(AppError) as ei:
        scheduler.invoke_role_agents("p1", "r1", 1, {})
    assert ei.value.code == 400
