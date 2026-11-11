# -*- coding: utf-8 -*-
"""角色 Agent 调度器（P3-T2）。

职责（对齐架构设计文档 §4 角色 Agent 调度机制）：
  1. 单角色多 Agent 绑定按 step_order 有序调用（命中当前或此前步骤）；
  2. 身份一致性：注入「你扮演角色<role_id>，保持身份一致」系统提示词前缀；
  3. 记忆连续性：按 (role_id, agent_id) 命名空间恢复 / 写回 memory_state；
  4. 会话隔离：conversation_id = f"{role_id}:{agent_id}"，禁止跨角色复用；
  5. 同步调用走线程池（executor 注入，非阻塞）；
  6. 上下文透传：merge_result 合并各 Agent 输出到同一 context；
  7. 记录工具调用：经 ProjectStore.append_tool_call 落审计（success/failed）。

边界：本模块不 import 知识库模块任何符号；知识条目经 RoleContextDTO 只读注入。
依赖注入：role_store / project_store / agent_client / executor 由路由层构造传入，
不在模块内硬编码单例（对齐架构设计 §4.1 构造函数签名）。
"""

from __future__ import annotations

import copy
from concurrent.futures import Executor
from typing import Any, Callable, Dict, List, Optional

from ..common.errors import bad_gateway, bad_request, server_error

# 身份一致性提示词前缀（架构设计文档 §4.2）
_IDENTITY_PROMPT = "你扮演角色{role_id}，保持身份一致"


def merge_result(base: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, Any]:
    """上下文透传合并：以 base 为主，result 浅层覆盖（不深改嵌套结构）。

    对齐架构设计文档 §4.1「merge_result 透传上下文」。
    """
    if not isinstance(base, dict):
        base = {}
    if not isinstance(result, dict):
        return base
    merged = copy.copy(base)
    for key, value in result.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            # 嵌套 dict 也浅合并一层，保留未覆盖的旧字段
            nested = copy.copy(merged[key])
            nested.update(value)
            merged[key] = nested
        else:
            merged[key] = value
    return merged


class RoleAgentScheduler:
    """单角色多 Agent 有序调度器。

    构造参数：
        role_store: RoleStore 实例（get_bindings / get_memory / set_memory）。
        project_store: ProjectStore 实例（append_tool_call 审计）。
        agent_client: Coze 客户端（chat(bot_id, user_message, conversation_id,
            parameters) -> dict{success, content, ...}）。agent_id 即 bot_id。
        executor: concurrent.futures.Executor，同步调用投递到线程池。
        tool_name: 审计工具名（默认 role_agent_invoke），按调用记录。
    """

    def __init__(
        self,
        role_store: Any,
        project_store: Any,
        agent_client: Any,
        executor: Optional[Executor] = None,
        max_workers: int = 8,
        tool_name: str = "role_agent_invoke",
    ) -> None:
        self.role_store = role_store
        self.project_store = project_store
        self.agent_client = agent_client
        self.max_workers = max_workers
        self.tool_name = tool_name
        if executor is None:
            from concurrent.futures import ThreadPoolExecutor

            executor = ThreadPoolExecutor(max_workers=max_workers)
        self.executor: Executor = executor

    # ---------- 内部：单绑定 Agent 调用 ----------

    def _build_sys_prompt(self, role_id: str) -> str:
        """身份一致性：系统提示词前缀。"""
        return _IDENTITY_PROMPT.format(role_id=role_id)

    def _invoke_agent(
        self,
        project_id: str,
        role_id: str,
        agent_id: str,
        binding: Dict[str, Any],
        context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """调用单个 Agent：恢复记忆 → 注入身份 → 调用 → 合并输出。

        返回合并后的输出 dict（供 merge_result 用），失败经 errors 转换。
        """
        # 1. 记忆连续性：按 (role_id, agent_id) 命名空间恢复
        memory = self.role_store.get_memory(project_id, role_id, agent_id)
        # 2. 会话隔离 key
        conversation_id = f"{role_id}:{agent_id}"
        # 3. 身份一致性：系统提示词前缀
        sys_prompt = self._build_sys_prompt(role_id)
        # 4. 组装用户消息：系统提示词 + 上下文序列化
        user_message = self._compose_user_message(sys_prompt, memory, context)

        # 5. 记录请求（审计，先落 request 再补 response）
        request_payload: Dict[str, Any] = {
            "role_id": role_id,
            "agent_id": agent_id,
            "step_order": binding.get("step_order"),
            "conversation_id": conversation_id,
            "message": user_message,
        }

        try:
            # 6. 同步调用走线程池（非阻塞）
            future = self.executor.submit(
                self._call_agent,
                agent_id,
                user_message,
                conversation_id,
            )
            raw = future.result()
        except Exception as exc:  # noqa: BLE001 - 统一转 AppError
            self._record_tool_call(project_id, request_payload, {"error": str(exc)}, "failed")
            raise server_error("角色 Agent 调用失败", detail=str(exc))

        # 7. 解析返回：success=False 或 content 缺失均视为失败
        if not isinstance(raw, dict) or not raw.get("success", False):
            error = raw.get("error", "未知错误") if isinstance(raw, dict) else str(raw)
            self._record_tool_call(project_id, request_payload, {"error": error}, "failed")
            raise bad_gateway("角色 Agent 返回失败", detail=str(error))

        output = self._extract_output(raw)
        response_payload = {
            "conversation_id": raw.get("conversation_id", conversation_id),
            "content": output,
        }
        self._record_tool_call(project_id, request_payload, response_payload, "success")

        # 8. 写回记忆（role_id 命名空间）：保存本次输出
        self.role_store.set_memory(project_id, role_id, agent_id, output)
        # 9. 返回合并后输出（外层再 merge 到 context）
        return output

    def _call_agent(
        self, agent_id: str, user_message: str, conversation_id: str,
    ) -> Dict[str, Any]:
        """实际调用注入的 agent_client（子类可覆写便于测试）。"""
        return self.agent_client.chat(
            bot_id=agent_id,
            user_message=user_message,
            conversation_id=conversation_id,
            parameters={},
        )

    def _compose_user_message(
        self, sys_prompt: str, memory: Dict[str, Any], context: Dict[str, Any],
    ) -> str:
        """组装发送给 Agent 的文本消息。

        系统提示词前缀 + 记忆摘要 + 上下文摘要，保持单一字符串（对齐 Coze chat 约定）。
        """
        parts: List[str] = [sys_prompt]
        if memory:
            parts.append("【记忆】" + self._safe_json(memory))
        if context:
            parts.append("【上下文】" + self._safe_json(context))
        return "\n".join(parts)

    def _extract_output(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        """从 Agent 返回提取可写回记忆的输出对象。

        优先取 raw["content"]（字符串或 dict）；否则取 raw 去除控制字段。
        """
        content = raw.get("content")
        if isinstance(content, dict):
            return content
        if isinstance(content, str):
            return {"content": content}
        # 无 content 时，去掉响应元数据后整体作为输出
        return {
            k: v for k, v in raw.items()
            if k not in ("success", "error", "conversation_id", "debug_url")
        }

    def _safe_json(self, obj: Any) -> str:
        import json

        try:
            return json.dumps(obj, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(obj)

    def _record_tool_call(
        self, project_id: str, request: Dict[str, Any],
        response: Dict[str, Any], status: str,
    ) -> None:
        """记录工具调用（success/failed），失败不阻断主流程。"""
        try:
            self.project_store.append_tool_call(
                project_id, self.tool_name, request, response, status,
            )
        except Exception:  # noqa: BLE001 - 审计失败不阻断调度
            pass

    # ---------- 对外主入口 ----------

    def invoke_role_agents(
        self, project_id: str, role_id: str, step_order: int, context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """按预设流程调用角色绑定的全部 Agent。

        命中规则：绑定 step_order <= 当前 step_order 且 enabled=true，按 step_order 升序。
        返回合并后 context；无命中绑定返回原 context 浅拷贝。

        参数：
            project_id: 所属项目（RoleStore 聚合根定位）。
            role_id: 目标角色。
            step_order: 当前步骤（1-11）。
            context: 透传上下文（含角色/知识库只读注入）。

        异常：AppError（400 step_order 非法；404 角色不存在；502 Agent 上游失败；
              500 未知内部错误）。
        """
        if not isinstance(step_order, int) or not (1 <= step_order <= 11):
            raise bad_request("step_order 须为 1-11 整数")

        # 1. 读取启用的绑定并按 step_order 排序（RoleStore 已按 step_order 排序，兜底再排）
        bindings = self.role_store.get_bindings(project_id, role_id, enabled=True)
        bindings = sorted(bindings, key=lambda b: b["step_order"])

        # 2. 命中当前或此前步骤的绑定
        hit_bindings = [b for b in bindings if b["step_order"] <= step_order]

        # 3. 无命中：返回原 context（条件触发，由路由层决定是否 409）
        merged_context = copy.copy(context)
        for binding in hit_bindings:
            agent_id = binding.get("agent_id", "")
            if not agent_id:
                continue
            output = self._invoke_agent(
                project_id, role_id, agent_id, binding, merged_context,
            )
            # 上下文透传合并
            merged_context = merge_result(merged_context, output)

        return merged_context
