# -*- coding: utf-8 -*-
"""小说创作模块路由蓝图（P3-T4：角色 Agent API）。

对齐接口契约 §3 角色接口（本文件实现 3.2/3.3/3.4/3.5，§3.1 创建角色属 P3-T5）：
  POST   /api/roles/<role_id>/agents            绑定角色 Agent（§3.2）
  PUT    /api/roles/<role_id>/agents/<bid>      更新绑定（§3.3）
  POST   /api/roles/<role_id>/agents/invoke     按预设流程调用（§3.4）
  GET    /api/roles/<role_id>/agents            列出角色 Agent（§3.5）

关键设计：
  角色接口路径无 project_id，而 RoleStore 全部方法需 (project_id, ...)。
  因此经 ProjectStore.find_project_by_role(role_id) 反查聚合根；找不到抛 404。
  依赖注入：role_store / project_store / scheduler / flow_engine 由应用层构造传入，
  不在蓝图内硬编码单例（对齐架构设计 §7 依赖注入）。

响应格式（接口契约 §1.1）：{"code": 0, "data": ..., "message": "ok"}；
错误 {"code": <非0>, "data": null, "message": "..."}。
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from flask import Blueprint, jsonify, request

from ..common.errors import AppError, bad_request, not_found


def create_blueprint(
    role_store: Any,
    project_store: Any,
    scheduler: Any,
    flow_engine: Any,
) -> Blueprint:
    """创建小说创作模块蓝图（依赖注入）。

    参数：
        role_store: RoleStore 实例（角色 CRUD / 绑定管理 / 记忆）。
        project_store: ProjectStore 实例（聚合根反查 / 工具调用审计）。
        scheduler: RoleAgentScheduler 实例（有序调用绑定 Agent）。
        flow_engine: StepFlowEngine 实例（11 步流程配置与触发）。
    """
    bp = Blueprint("novel_creation", __name__)

    # ---------- 辅助 ----------

    def _resolve_role(role_id: str) -> Dict[str, Any]:
        """反查角色所属项目，返回 (project_id, role) 二元组。找不到抛 404。"""
        project = project_store.find_project_by_role(role_id)
        if project is None:
            raise not_found(f"角色不存在: {role_id}")
        role = next((r for r in project.get("roles", []) if r.get("id") == role_id), None)
        if role is None:
            raise not_found(f"角色不存在: {role_id}")
        return project, role

    def _ok(data: Any, message: str = "ok"):
        return jsonify({"code": 0, "data": data, "message": message})

    # ---------- 3.2 绑定角色 Agent ----------

    @bp.post("/api/roles/<role_id>/agents")
    def bind_agent(role_id: str):
        """绑定角色 Agent（接口契约 §3.2）。"""
        project, _role = _resolve_role(role_id)
        payload = request.get_json(silent=True) or {}
        agent_id = payload.get("agent_id")
        step_order = payload.get("step_order")
        workflow_id = payload.get("workflow_id")
        enabled = payload.get("enabled", True)
        if not agent_id:
            raise bad_request("agent_id 不能为空")
        if not isinstance(step_order, int) or not (1 <= step_order <= 11):
            raise bad_request("step_order 须为 1-11 整数")
        binding = role_store.create_binding(
            project["id"], role_id, agent_id,
            step_order=step_order, workflow_id=workflow_id, enabled=enabled,
        )
        return _ok({"binding_id": binding["id"], "step_order": binding["step_order"]})

    # ---------- 3.3 更新绑定 ----------

    @bp.put("/api/roles/<role_id>/agents/<binding_id>")
    def update_agent(role_id: str, binding_id: str):
        """更新角色 Agent 绑定（接口契约 §3.3）。"""
        project, _role = _resolve_role(role_id)
        payload = request.get_json(silent=True) or {}
        allowed_keys = {"agent_id", "step_order", "workflow_id", "enabled"}
        updates = {k: v for k, v in payload.items() if k in allowed_keys}
        if not updates:
            raise bad_request("无可更新字段")
        if "step_order" in updates and (
            not isinstance(updates["step_order"], int)
            or not (1 <= updates["step_order"] <= 11)
        ):
            raise bad_request("step_order 须为 1-11 整数")
        if "enabled" in updates and not isinstance(updates["enabled"], bool):
            raise bad_request("enabled 须为布尔值")
        binding = role_store.update_binding(project["id"], binding_id, **updates)
        return _ok({
            "binding_id": binding["id"],
            "step_order": binding["step_order"],
            "enabled": binding["enabled"],
        })

    # ---------- 3.4 按预设流程调用 ----------

    @bp.post("/api/roles/<role_id>/agents/invoke")
    def invoke_agent(role_id: str):
        """按预设流程调用角色 Agent（接口契约 §3.4）。

        请求 {"step_order": 11, "context": {...}}。
        条件触发：调度器无命中绑定返回原 context，本路由据此返回 409
        （接口契约 §3.4 错误码：409 step_order 不符）。
        """
        project, _role = _resolve_role(role_id)
        payload = request.get_json(silent=True) or {}
        step_order = payload.get("step_order")
        context = payload.get("context") or {}
        if not isinstance(step_order, int) or not (1 <= step_order <= 11):
            raise bad_request("step_order 须为 1-11 整数")
        if not isinstance(context, dict):
            raise bad_request("context 须为对象")
        bindings = role_store.get_bindings(project["id"], role_id, enabled=True)
        has_hit = any(b["step_order"] <= step_order for b in bindings)
        if not has_hit:
            # 条件触发：无命中绑定，按契约返回 409
            from ..common.errors import AppError as _A
            raise _A(409, f"step_order={step_order} 无匹配绑定", "")
        merged = flow_engine.trigger_step(project["id"], role_id, step_order, context)
        return _ok({"merged_context": merged, "role_id": role_id})

    # ---------- 3.5 列出角色 Agent ----------

    @bp.get("/api/roles/<role_id>/agents")
    def list_agents(role_id: str):
        """列出角色绑定的全部 Agent（接口契约 §3.5）。"""
        project, _role = _resolve_role(role_id)
        enabled = request.args.get("enabled")
        if enabled is not None:
            if enabled not in ("true", "false"):
                raise bad_request("enabled 查询参数须为 true/false")
            enabled = enabled == "true"
        else:
            enabled = None
        bindings = role_store.get_bindings(project["id"], role_id, enabled=enabled)
        return _ok({"bindings": bindings})

    return bp
