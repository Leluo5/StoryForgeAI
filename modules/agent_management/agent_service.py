# -*- coding: utf-8 -*-
"""Agent 业务编排：默认开通、角色绑定、工具切换、迁移。"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, not_found
from ..common.storage import read_json
from .agent_grouping import build_tree
from .types import GLOBAL_AGENT_PROJECT_ID


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

    # ---------- Coze 全局 Agent 导入 ----------

    def import_coze_agent(self, bot: Dict[str, Any], workspace_id: str = "") -> Dict[str, Any]:
        """导入到全局未分类池；按 Coze bot_id 更新，且不持久化 PAT。"""
        bot_id = str(bot.get("bot_id") or bot.get("id") or "")
        if not bot_id:
            raise bad_request("Coze Agent 缺少 bot_id")
        onboarding = bot.get("onboarding_info") or {}
        payload = {
            "kind": "unclassified",
            "name": bot.get("name") or "未命名 Agent",
            "description": bot.get("description") or onboarding.get("prologue") or "",
            "scope": "global",
            "platform": "coze",
            "platform_config": {"bot_id": bot_id, "workspace_id": workspace_id},
            "model_config": {
                "system_prompt": (bot.get("prompt_info") or {}).get("prompt") or "",
            },
            "source": "coze_import",
        }
        existing = next((
            agent for agent in self.store.list_agents(GLOBAL_AGENT_PROJECT_ID)
            if agent.get("kind") == "unclassified"
            and (agent.get("platform_config") or {}).get("bot_id") == bot_id
        ), None)
        if existing is not None:
            updates = {key: payload[key] for key in (
                "name", "description", "scope", "platform", "platform_config", "model_config",
            )}
            return self.store.update_agent(
                GLOBAL_AGENT_PROJECT_ID, existing["id"], updates,
                note="同步 Coze Agent 元信息",
            )
        return self.store.create_agent(GLOBAL_AGENT_PROJECT_ID, payload)

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

    # ---------- 工具 Agent ----------

    def list_tools(self, project_id: str) -> List[Dict[str, Any]]:
        """按工具汇总候选与默认项。"""
        result: Dict[str, List[Dict[str, Any]]] = {}
        for agent in self.store.list_agents(project_id):
            if agent["kind"] == "tool_agent":
                result.setdefault(agent.get("tool_name") or "", []).append(agent)
        return [{"tool_name": name, "agents": agents,
                 "default_agent_id": next((a["id"] for a in agents if a.get("is_default")), None)}
                for name, agents in sorted(result.items())]

    def resolve_default_tool_agent(self, project_id: str,
                                   tool_name: str) -> Optional[Dict[str, Any]]:
        """取工具默认 active Agent；无则返回 None。"""
        for agent in self.store.list_agents(project_id):
            if agent["kind"] == "tool_agent" and agent.get("tool_name") == tool_name \
                    and agent.get("is_default") and agent.get("status") == "active":
                return agent
        return None

    def switch_tool_default(self, project_id: str, tool_name: str,
                            agent_id: str) -> Dict[str, Any]:
        """切换工具默认 Agent；失败时回滚旧默认标记。"""
        agents = [a for a in self.store.list_agents(project_id)
                  if a["kind"] == "tool_agent" and a.get("tool_name") == tool_name]
        target = next((a for a in agents if a["id"] == agent_id), None)
        if target is None:
            raise not_found(f"工具 Agent 不存在: {agent_id}")
        if target.get("status") != "active":
            raise bad_request("仅 active 状态的 Agent 可设为默认")
        previous = [(a["id"], bool(a.get("is_default"))) for a in agents]
        try:
            for agent in agents:
                if agent["id"] != agent_id and agent.get("is_default"):
                    self.store.update_agent(project_id, agent["id"], {"is_default": False})
            return self.store.update_agent(project_id, agent_id, {"is_default": True})
        except Exception:
            for old_id, flag in previous:
                self.store.update_agent(project_id, old_id, {"is_default": flag})
            raise

    def delete_agent(self, project_id: str, agent_id: str, force: bool = False) -> bool:
        """删除 Agent 前解除角色绑定，并在必要时转移工具默认项。"""
        agent = self.store.get_agent(project_id, agent_id)
        for role in self.role_store.list_roles(project_id):
            for binding in self.role_store.get_bindings(project_id, role["id"]):
                if binding.get("agent_ref_id") == agent_id:
                    self.role_store.update_binding(
                        project_id, binding["id"], agent_ref_id=None, enabled=False)
        if agent["kind"] == "tool_agent" and agent.get("is_default"):
            candidates = [a for a in self.store.list_agents(project_id)
                          if a["kind"] == "tool_agent" and a["id"] != agent_id
                          and a.get("tool_name") == agent.get("tool_name")
                          and a.get("status") == "active"]
            if candidates:
                self.store.update_agent(
                    project_id, candidates[0]["id"], {"is_default": True})
        return self.store.delete_agent(project_id, agent_id, force=force)

    # ---------- 查询与分组 ----------

    def get_agent(self, project_id: str, agent_id: str,
                  include_versions: bool = False) -> Dict[str, Any]:
        """读取单个 Agent 详情。"""
        return self.store.get_agent(project_id, agent_id, include_versions)

    def list_agents(self, project_id: str, kind: Optional[str] = None,
                    **filters: Any) -> List[Dict[str, Any]]:
        """按条件列出 Agent：kind 及 status/role_id/tool_name/keyword 过滤。"""
        agents = self.store.list_agents(project_id)
        if kind:
            agents = [a for a in agents if a["kind"] == kind]
        status = filters.get("status")
        if status:
            agents = [a for a in agents if a.get("status") == status]
        role_id = filters.get("role_id")
        if role_id:
            agents = [a for a in agents if a.get("role_id") == role_id]
        tool_name = filters.get("tool_name")
        if tool_name:
            agents = [a for a in agents if a.get("tool_name") == tool_name]
        keyword = filters.get("keyword")
        if keyword:
            key = keyword.lower()
            agents = [a for a in agents
                      if key in (a.get("name") or "").lower()
                      or key in (a.get("description") or "").lower()]
        return agents

    def get_group_tree(self, project_id: str) -> Dict[str, Any]:
        """构建分组树（注入角色名）。"""
        project = self.project_store.get_project(project_id)
        role_names = {r["id"]: r.get("name", "") for r in self.role_store.list_roles(project_id)}
        return build_tree(project, self.store.list_agents(project_id),
                          self.store.load_group_overrides(project_id), role_names)

    # ---------- 存量迁移 ----------

    def migrate_role_bindings(self, projects_root: Optional[str] = None,
                              dry_run: bool = True) -> Dict[str, Any]:
        """为旧绑定回填 agent_ref_id；匹配不到则创建 role_agent。"""
        root = projects_root or getattr(self.project_store, "data_dir", "")
        stats = {"scanned": 0, "migrated": 0, "created_agents": 0,
                 "skipped": 0, "errors": []}
        if not os.path.isdir(root):
            return stats
        for name in os.listdir(root):
            if not name.endswith(".json") or name.startswith("."):
                continue
            project = read_json(os.path.join(root, name), None)
            if not isinstance(project, dict) or not project.get("id"):
                continue
            project_id = project["id"]
            agents = self.store.list_agents(project_id)
            for binding in project.get("role_bindings", []):
                stats["scanned"] += 1
                try:
                    if binding.get("agent_ref_id"):
                        stats["skipped"] += 1
                        continue
                    agent_id = binding.get("agent_id") or ""
                    match = next((a for a in agents
                                  if a["kind"] in ("role_agent", "flow_step_agent")
                                  and (a.get("platform_config") or {}).get("bot_id") == agent_id
                                  and (a["kind"] != "role_agent"
                                       or a.get("role_id") == binding.get("role_id"))), None)
                    if match is None:
                        if not agent_id:
                            stats["errors"].append({"binding_id": binding.get("id"),
                                                    "error": "agent_id 为空"})
                            continue
                        stats["created_agents"] += 1
                        if dry_run:
                            stats["migrated"] += 1
                            continue
                        role_id = binding.get("role_id") or ""
                        match = self.store.create_agent(project_id, {
                            "project_id": project_id,
                            "kind": "role_agent",
                            "name": f"迁移角色Agent·{role_id[:8]}",
                            "role_id": binding.get("role_id"),
                            "platform": binding.get("agent_env", "coze"),
                            "platform_config": {"bot_id": agent_id},
                            "model_config": {"model": binding.get("model") or ""},
                            "source": "manual",
                        })
                        agents.append(match)
                    if not dry_run:
                        self.role_store.update_binding(
                            project_id, binding["id"], agent_ref_id=match["id"])
                    stats["migrated"] += 1
                except Exception as exc:  # noqa: BLE001 - 单条失败继续
                    stats["errors"].append({"binding_id": binding.get("id"),
                                            "error": str(exc)})
        return stats
