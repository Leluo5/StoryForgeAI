# -*- coding: utf-8 -*-
"""AgentClient 抽象协议与 CozeAgentClient 包装测试。"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.novel_creation.agent_client import AgentClient, CozeAgentClient
from modules.novel_creation.trae_agent_client import TraeAgentClient


class _FakeCoze:
    def __init__(self):
        self.calls = []

    def chat(self, bot_id, user_message, conversation_id="", parameters=None, **kwargs):
        self.calls.append(
            {
                "bot_id": bot_id,
                "msg": user_message,
                "cid": conversation_id,
                "params": parameters,
                "kwargs": kwargs,
            }
        )
        return {"success": True, "content": "hi"}


def test_agentclient_abstract() -> None:
    with pytest.raises(TypeError):
        AgentClient()


def test_coze_agentclient_wraps_and_passes_model() -> None:
    fake = _FakeCoze()
    client = CozeAgentClient(fake)

    out = client.chat(
        "bot1",
        "你好",
        "r1:a1",
        {"k": 1},
        model="gpt-4o",
        temperature=0.2,
    )

    assert out["content"] == "hi"
    assert fake.calls[0] == {
        "bot_id": "bot1",
        "msg": "你好",
        "cid": "r1:a1",
        "params": {"k": 1},
        "kwargs": {"model": "gpt-4o", "temperature": 0.2},
    }

    client.chat("bot2", "无附加参数")
    assert fake.calls[1]["params"] == {}


def test_trae_agentclient_is_stub() -> None:
    client = TraeAgentClient()
    with pytest.raises(
        NotImplementedError,
        match="Trae 通道协议尚未定义，真实接入待补全",
    ):
        client.chat("bot1", "hi", "r1:a1", {})
