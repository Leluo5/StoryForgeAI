# -*- coding: utf-8 -*-
"""Agent 枚举、默认值与字段校验。"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ..common.errors import bad_request

KINDS = {"role_agent", "tool_agent", "flow_step_agent", "unclassified"}
PLATFORMS = {"coze", "trae"}
STATUSES = {"active", "disabled", "archived"}
CHANGE_TYPES = {"create", "update", "archive", "restore", "rollback"}
RESPONSE_FORMATS = {"text", "json", "markdown"}
SCOPES = {"project", "role", "global"}
GLOBAL_AGENT_PROJECT_ID = "_global"
MAX_VERSIONS = 50
STEP_MIN, STEP_MAX = 1, 11


def default_model_config(overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """返回 10 项模型参数的默认值，并合并 overrides。"""
    cfg = {
        "model": "",
        "temperature": 0.7,
        "top_p": 1.0,
        "max_tokens": 2048,
        "system_prompt": "",
        "stream": False,
        "frequency_penalty": 0,
        "presence_penalty": 0,
        "response_format": "text",
        "stop": [],
    }
    if overrides:
        cfg.update(overrides)
    return cfg


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_model_config(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """校验并归一化模型参数；越界或非法类型抛 400。"""
    raw = raw or {}
    if not isinstance(raw, dict):
        raise bad_request("model_config 须为对象")
    cfg = default_model_config(raw)

    if not isinstance(cfg["model"], str):
        raise bad_request("model 须为字符串")
    if not _is_number(cfg["temperature"]) or not (0 <= cfg["temperature"] <= 2):
        raise bad_request("temperature 须为 0-2 数字")
    if not _is_number(cfg["top_p"]) or not (0 <= cfg["top_p"] <= 1):
        raise bad_request("top_p 须为 0-1 数字")
    if not isinstance(cfg["max_tokens"], int) or isinstance(cfg["max_tokens"], bool) \
            or not (1 <= cfg["max_tokens"] <= 32768):
        raise bad_request("max_tokens 须为 1-32768 整数")
    if not isinstance(cfg["system_prompt"], str):
        raise bad_request("system_prompt 须为字符串")
    if not isinstance(cfg["stream"], bool):
        raise bad_request("stream 须为布尔值")
    for key in ("frequency_penalty", "presence_penalty"):
        if not _is_number(cfg[key]) or not (-2 <= cfg[key] <= 2):
            raise bad_request(f"{key} 须为 -2 到 2 数字")
    if cfg["response_format"] not in RESPONSE_FORMATS:
        raise bad_request("response_format 须为 text/json/markdown")
    stop = cfg["stop"]
    if not isinstance(stop, list) or len(stop) > 4 \
            or any(not isinstance(s, str) or len(s) > 64 for s in stop):
        raise bad_request("stop 须为最多 4 项、每项不超过 64 字符的字符串数组")
    cfg["temperature"] = float(cfg["temperature"])
    cfg["top_p"] = float(cfg["top_p"])
    cfg["frequency_penalty"] = float(cfg["frequency_penalty"])
    cfg["presence_penalty"] = float(cfg["presence_penalty"])
    return cfg


def validate_platform_config(platform: str, raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """只保留平台非敏感字段，禁止把 token 写入 Agent 文件。"""
    if platform not in PLATFORMS:
        raise bad_request("platform 须为 coze 或 trae")
    raw = raw or {}
    if not isinstance(raw, dict):
        raise bad_request("platform_config 须为对象")
    if platform == "coze":
        return {"bot_id": str(raw.get("bot_id") or ""),
                "workspace_id": str(raw.get("workspace_id") or "")}
    return {"agent_id": str(raw.get("agent_id") or ""),
            "endpoint": str(raw.get("endpoint") or "")}


def validate_agent_identity(kind: str, fields: Dict[str, Any]) -> None:
    """校验 kind 与归属字段组合。"""
    if kind not in KINDS:
        raise bad_request("kind 须为 role_agent/tool_agent/flow_step_agent/unclassified")
    role_id = fields.get("role_id")
    tool_name = fields.get("tool_name")
    step_order = fields.get("step_order")
    if kind == "unclassified":
        if role_id or tool_name or step_order is not None:
            raise bad_request("unclassified 不能提供 role_id/tool_name/step_order")
    elif kind == "role_agent":
        if not role_id or tool_name or step_order is not None:
            raise bad_request("role_agent 必须且只能提供 role_id")
    elif kind == "tool_agent":
        if not tool_name or role_id or step_order is not None:
            raise bad_request("tool_agent 必须且只能提供 tool_name")
    else:
        if not isinstance(step_order, int) or isinstance(step_order, bool) \
                or not (STEP_MIN <= step_order <= STEP_MAX):
            raise bad_request("flow_step_agent 的 step_order 须为 1-11 整数")
        if role_id or tool_name:
            raise bad_request("flow_step_agent 不能提供 role_id/tool_name")
