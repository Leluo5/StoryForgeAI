# -*- coding: utf-8 -*-
"""工作流枚举、默认值与字段校验。"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ..common.errors import bad_request

WORKFLOW_STATUSES = {"active", "disabled", "archived"}
PLATFORMS = {"coze"}
SOURCES = {"manual", "coze_import"}
GLOBAL_WORKFLOW_PROJECT_ID = "_global"
MAX_VERSIONS = 50
UPDATE_WHITELIST = {
    "name", "description", "status", "platform", "platform_config",
    "params", "llm_config", "source", "icon_url",
}


def default_llm_config(overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """返回 LLM 配置默认值，并合并 overrides。"""
    cfg = {"base_url": "", "api_key": "", "model": ""}
    if overrides:
        cfg.update(overrides)
    return cfg


def validate_platform_config(platform: str, raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """只保留工作流平台非敏感字段，禁止把 token 写入工作流文件。"""
    if platform not in PLATFORMS:
        raise bad_request("platform 须为 coze")
    raw = raw or {}
    if not isinstance(raw, dict):
        raise bad_request("platform_config 须为对象")
    return {"workflow_id": str(raw.get("workflow_id") or ""),
            "workspace_id": str(raw.get("workspace_id") or "")}


def validate_llm_config(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """校验并归一化 LLM 配置；字段须为字符串。"""
    raw = raw or {}
    if not isinstance(raw, dict):
        raise bad_request("llm_config 须为对象")
    cfg = default_llm_config(raw)
    for key in ("base_url", "api_key", "model"):
        if not isinstance(cfg[key], str):
            raise bad_request(f"{key} 须为字符串")
    return cfg


def validate_status(raw: Optional[str]) -> str:
    """校验工作流状态，必须在 active/disabled/archived 内。"""
    if raw not in WORKFLOW_STATUSES:
        raise bad_request("status 须为 active/disabled/archived")
    return raw
