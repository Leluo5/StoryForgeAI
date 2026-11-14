# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.agent_management.types import (
    default_model_config,
    validate_agent_identity,
    validate_model_config,
    validate_platform_config,
)
from modules.common.errors import AppError


def test_default_model_config_has_ten_fields():
    cfg = default_model_config()
    assert cfg == {
        "model": "", "temperature": 0.7, "top_p": 1.0, "max_tokens": 2048,
        "system_prompt": "", "stream": False,
        "frequency_penalty": 0, "presence_penalty": 0,
        "response_format": "text", "stop": [],
    }


def test_validate_model_config_normalizes_and_rejects_out_of_range():
    cfg = validate_model_config({"temperature": 1.2, "max_tokens": 100, "stop": ["x"]})
    assert cfg["temperature"] == 1.2
    assert cfg["max_tokens"] == 100
    assert cfg["stop"] == ["x"]
    with pytest.raises(AppError):
        validate_model_config({"temperature": 3})
    with pytest.raises(AppError):
        validate_model_config({"response_format": "xml"})
    with pytest.raises(AppError):
        validate_model_config({"stop": ["a", "b", "c", "d", "e"]})


def test_validate_platform_config_keeps_only_non_secret_fields():
    assert validate_platform_config("coze", {"bot_id": "b1", "token": "secret"}) == {
        "bot_id": "b1", "workspace_id": ""
    }
    assert validate_platform_config("trae", {"agent_id": "a1"}) == {
        "agent_id": "a1", "endpoint": ""
    }
    with pytest.raises(AppError):
        validate_platform_config("openai", {})


def test_validate_agent_identity_enforces_kind_fields():
    validate_agent_identity("role_agent", {"role_id": "r1"})
    validate_agent_identity("tool_agent", {"tool_name": "gen_outline"})
    validate_agent_identity("flow_step_agent", {"step_order": 1})
    with pytest.raises(AppError):
        validate_agent_identity("role_agent", {"tool_name": "x"})
    with pytest.raises(AppError):
        validate_agent_identity("flow_step_agent", {"step_order": 12})
