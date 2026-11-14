# -*- coding: utf-8 -*-
"""Agent 业务编排：默认开通、角色绑定、工具切换、迁移。"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, not_found
from ..common.storage import read_json


class AgentService:
    """智能体管理领域服务。"""

    def __init__(self, store: Any, project_store: Any, role_store: Any,
                 tool_registry: Any = None, flow_template: Optional[List[Dict[str, Any]]] = None,
                 version_limit: int = 50) -> None:
        self.store = store
        self.project_store = project_store
        self.role_store = role_store
        self.tool_registry = tool_registry
        self.flow_template = flow_template or []
        self.version_limit = version_limit
        self._validate_flow_template()

    # ---------- 模板 ----------

    def _validate_flow_template(self) -> None:
        orders = [int(s.get("step_order", 0)) for s in self.flow_template]
        if sorted(orders) != list(range(1, 12)):
            raise bad_request("flow_template 必须包含 1-11 完整步骤")

    # ---------- 作品默认 Agent 开通 ----------

    def provision_project_defaults(self, project: Any) -> Dict[str, Any]:
        """幂等生成 11 个流程 Agent 与每个工具 1 个默认工具 Agent。"""
        project_id = project["id"] if isinstance(project, dict) else str(project)
        created = {"flow_agents": [], "tool_agents": []}
        errors: List[Dict[str, Any]] = []
        existing = self.store.list_agents(project_id)
        flow_by_step = {a.get("step_order") for a in existing if a["kind"] == "flow_step_agent"}
        for step in self.flow_template:
            order = int(step["step_order"])
            if order in flow_by_step:
                continue
            try:
                created["flow_agents"].append(self.store.create_agent(project_id, {
                    "project_id": project_id,
                    "kind": "flow_step_agent",
                    "name": f"默认流程·{order}-{step.get('name', '')}".rstrip("-"),
                    "description": step.get("desc", ""),
                    "step_order": order,
                    "scope": "project",
                    "platform": step.get("platform", "coze"),
                    "platform_config": step.get("platform_config") or {},
                    "model_config": step.get("model_config") or {},
                    "source": "template",
                }))
            except Exception as exc:  # noqa: BLE001 - 单项失败不阻断其余
                errors.append({"step_order": order, "error": str(exc)})
        tools = self.tool_registry.list_tools() if self.tool_registry else []
        existing_tools = {a.get("tool_name") for a in existing if a["kind"] == "tool_agent"}
        for meta in tools:
            name = meta.get("name")
            if not name or name in existing_tools:
                continue
            try:
                created["tool_agents"].append(self.store.create_agent(project_id, {
                    "project_id": project_id,
                    "kind": "tool_agent",
                    "name": f"工具·{name}",
                    "description": meta.get("description", ""),
                    "tool_name": name,
                    "scope": "project",
                    "platform": "coze",
                    "platform_config": {},
                    "model_config": {},
                    "is_default": True,
                    "source": "auto",
                }))
            except Exception as exc:  # noqa: BLE001
                errors.append({"tool_name": name, "error": str(exc)})
        self._ensure_tool_defaults(project_id)
        return {"created": created, "errors": errors}

    def _ensure_tool_defaults(self, project_id: str) -> None:
        """每个工具有且仅有一个默认 Agent。"""
        by_tool: Dict[str, List[Dict[str, Any]]] = {}
        for agent in self.store.list_agents(project_id):
            if agent["kind"] == "tool_agent" and agent.get("status") == "active":
                by_tool.setdefault(agent.get("tool_name") or "", []).append(agent)
        for tool_name, agents in by_tool.items():
            defaults = [a for a in agents if a.get("is_default")]
            if len(defaults) == 1:
                continue
            keep = defaults[0] if defaults else agents[0]
            for agent in agents:
                expected = agent["id"] == keep["id"]
                if bool(agent.get("is_default")) != expected:
                    self.store.update_agent(project_id, agent["id"], {"is_default": expected})

    # ---------- 角色默认绑定 ----------

    def bind_role_default_flow(self, project_id: str, role_id: str) -> List[Dict[str, Any]]:
        """为角色补齐 11 条默认绑定；不覆盖已存在步骤。"""
        self.role_store.get_role(project_id, role_id)
        flow_agents = self._active_flow_agents(project_id)
        if len(flow_agents) < 11:
            self.provision_project_defaults(project_id)
            flow_agents = self._active_flow_agents(project_id)
        existing = {b["step_order"] for b in self.role_store.get_bindings(project_id, role_id)}
        created: List[Dict[str, Any]] = []
        for agent in sorted(flow_agents, key=lambda a: int(a["step_order"])):
            order = int(agent["step_order"])
            if order in existing:
                continue
            bot_id = (agent.get("platform_config") or {}).get("bot_id") or agent["id"]
            created.append(self.role_store.create_binding(
                project_id, role_id, bot_id, step_order=order, enabled=True,
                model=(agent.get("model_config") or {}).get("model") or None,
                agent_env=agent.get("platform", "coze"),
                agent_ref_id=agent["id"],
            ))
        return created

    def _active_flow_agents(self, project_id: str) -> List[Dict[str, Any]]:
        return [a for a in self.store.list_agents(project_id)
                if a["kind"] == "flow_step_agent" and a.get("status") == "active"]

    def reset_role_default_flow(self, project_id: str, role_id: str,
                                mode: str = "fill") -> List[Dict[str, Any]]:
        """恢复默认绑定：fill 只补缺，replace 整体重建。"""
        if mode not in ("fill", "replace"):
            raise bad_request("mode 须为 fill 或 replace")
        if mode == "replace":
            for binding in self.role_store.get_bindings(project_id, role_id):
                self.role_store.delete_binding(project_id, binding["id"])
        return self.bind_role_default_flow(project_id, role_id)
