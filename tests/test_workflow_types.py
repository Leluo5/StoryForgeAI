# -*- coding: utf-8 -*-
"""工作流管理 types.py 纯函数测试。"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules.workflow_management.types import (
    GLOBAL_WORKFLOW_PROJECT_ID,
    default_llm_config,
    validate_llm_config,
    validate_platform_config,
    validate_status,
)


def test_default_llm_config_returns_defaults():
    cfg = default_llm_config()
    assert cfg == {"base_url": "", "api_key": "", "model": ""}


def test_default_llm_config_merges_overrides():
    cfg = default_llm_config({"model": "coze"})
    assert cfg["model"] == "coze"
    assert cfg["base_url"] == ""


def test_validate_platform_config_keeps_only_whitelist():
    cfg = validate_platform_config("coze", {
        "workflow_id": "wf-1", "workspace_id": "ws-1", "pat_token": "secret",
    })
    assert cfg == {"workflow_id": "wf-1", "workspace_id": "ws-1"}
    assert "pat_token" not in cfg


def test_validate_llm_config_accepts_strings_and_empty():
    cfg = validate_llm_config({"base_url": "http://x", "api_key": "", "model": "gpt"})
    assert cfg == {"base_url": "http://x", "api_key": "", "model": "gpt"}


def test_validate_llm_config_rejects_non_string():
    with pytest.raises(AppError) as ei:
        validate_llm_config({"model": 123})
    assert ei.value.code == 400


def test_validate_status_accepts_known():
    assert validate_status("active") == "active"
    assert validate_status("disabled") == "disabled"
    assert validate_status("archived") == "archived"


def test_validate_status_rejects_unknown():
    with pytest.raises(AppError) as ei:
        validate_status("paused")
    assert ei.value.code == 400


def test_global_workflow_project_id():
    assert GLOBAL_WORKFLOW_PROJECT_ID == "_global"
