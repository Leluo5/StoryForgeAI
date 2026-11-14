# -*- coding: utf-8 -*-
"""统一 Agent 客户端协议（Coze / Trae 双通道）。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional


class AgentClient(ABC):
    """Agent 运行环境客户端抽象基类。

    契约：chat(bot_id, user_message, conversation_id="", parameters=None, **kwargs)
        -> dict{success: bool, content: str, ...}
    agent_id 即 bot_id。
    """

    @abstractmethod
    def chat(
        self,
        bot_id: str,
        user_message: str,
        conversation_id: str = "",
        parameters: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """调用 Agent 对话并返回统一字典结果。

        Args:
            bot_id: Agent 的 bot ID。
            user_message: 发送给 Agent 的用户消息。
            conversation_id: 会话隔离 ID。
            parameters: 附加变量；None 表示未提供。
            **kwargs: 各通道支持的扩展参数。

        Returns:
            包含 success、content 等字段的结果字典。

        Raises:
            NotImplementedError: 子类未实现该方法时抛出。
        """
        raise NotImplementedError


class CozeAgentClient(AgentClient):
    """Coze 通道客户端：包装现有 CozeClient，保持 _call_agent 契约不变。"""

    def __init__(self, coze_client: Any) -> None:
        """注入已有 Coze 客户端实例。"""
        self._coze = coze_client

    def chat(
        self,
        bot_id: str,
        user_message: str,
        conversation_id: str = "",
        parameters: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        """原样透传对话参数与扩展参数，并将 None parameters 转为空字典。

        Returns:
            注入的 Coze 客户端返回的结果字典；其异常不做拦截。
        """
        return self._coze.chat(
            bot_id=bot_id,
            user_message=user_message,
            conversation_id=conversation_id,
            parameters=parameters if parameters is not None else {},
            **kwargs,
        )
