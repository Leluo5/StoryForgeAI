# -*- coding: utf-8 -*-
"""Trae Agent 客户端（协议桩）。

开放项：Trae Agent 调用通道（HTTP 网关 / MCP / Tool / 本地 CLI）尚未定义。
真实接入待用户提供通道契约后补全；当前为占位实现，调用即抛 NotImplementedError。
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .agent_client import AgentClient


class TraeAgentClient(AgentClient):
    """Trae 通道协议桩，真实接入待通道契约明确后补全。"""

    def chat(
        self,
        bot_id: str,
        user_message: str,
        conversation_id: str = "",
        parameters: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """按统一协议接收对话参数，但通道未定义，无正常返回。

        Raises:
            NotImplementedError: 每次调用均抛出，等待 Trae 通道协议补全。
        """
        raise NotImplementedError("Trae 通道协议尚未定义，真实接入待补全")
