# -*- coding: utf-8 -*-
"""智能体管理路由：/api/agents/* 与 /api/roles/* 默认流程接口。"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from ..common.errors import AppError, bad_request, not_found


def create_blueprint(service, flow_progress_store=None) -> Blueprint:
    """装配智能体管理蓝图（依赖注入 service / 进度存储）。"""
    bp = Blueprint("agent_management", __name__, url_prefix="/api")

    def _ok(data, message: str = "ok"):
        return jsonify({"code": 0, "data": data, "message": message})

    @bp.errorhandler(AppError)
    def _handle_app_error(e: AppError):
        return jsonify({"code": e.code, "data": None, "message": e.message}), e.code

    def _pid():
        pid = request.args.get("project_id")
        if not pid:
            pid = (request.get_json(silent=True) or {}).get("project_id")
        if not pid:
            raise bad_request("project_id 不能为空")
        return pid

    def _role_project(role_id: str) -> str:
        project = service.project_store.find_project_by_role(role_id)
        if project is None:
            raise not_found(f"角色不存在: {role_id}")
        return project["id"]

    # ---------- Agent CRUD ----------

    @bp.post("/agents")
    def create_agent():
        """新建 Agent（role_agent/tool_agent/flow_step_agent），校验 project_id。"""
        body = request.get_json(silent=True) or {}
        pid = body.get("project_id")
        if not pid:
            raise bad_request("project_id 不能为空")
        return _ok(service.store.create_agent(pid, body))

    @bp.get("/agents")
    def list_agents():
        """分页列出 Agent，支持 kind/status/role_id/tool_name/keyword 过滤。"""
        pid = _pid()
        try:
            page = max(1, int(request.args.get("page", 1)))
            page_size = min(100, max(1, int(request.args.get("page_size", 20))))
        except ValueError:
            raise bad_request("page/page_size 须为整数")
        items = service.list_agents(
            pid,
            kind=request.args.get("kind"),
            status=request.args.get("status"),
            role_id=request.args.get("role_id"),
            tool_name=request.args.get("tool_name"),
            keyword=request.args.get("keyword"),
        )
        total = len(items)
        start = (page - 1) * page_size
        return _ok({"items": items[start:start + page_size], "total": total})

    @bp.get("/agents/<agent_id>")
    def get_agent(agent_id: str):
        """读取单个 Agent 详情，可按 include_versions=true 返回版本快照。"""
        include = request.args.get("include_versions") == "true"
        return _ok(service.get_agent(_pid(), agent_id, include))

    @bp.put("/agents/<agent_id>")
    def update_agent(agent_id: str):
        """白名单字段更新 Agent 并生成版本快照。"""
        pid = _pid()
        return _ok(service.store.update_agent(pid, agent_id, request.get_json(silent=True) or {}))

    @bp.post("/agents/<agent_id>/archive")
    def archive_agent(agent_id: str):
        """归档 Agent（归档后仍可恢复或删除）。"""
        return _ok(service.store.archive_agent(_pid(), agent_id))

    @bp.post("/agents/<agent_id>/restore")
    def restore_agent(agent_id: str):
        """将归档 Agent 恢复为 active。"""
        return _ok(service.store.restore_agent(_pid(), agent_id))

    @bp.delete("/agents/<agent_id>")
    def delete_agent(agent_id: str):
        """删除 Agent；未归档且未 force=true 时返回 409。"""
        force = request.args.get("force") == "true"
        service.delete_agent(_pid(), agent_id, force=force)
        return _ok({"success": True})

    @bp.get("/agents/<agent_id>/versions")
    def list_versions(agent_id: str):
        """列出 Agent 版本摘要（不含快照内容）。"""
        return _ok({"items": service.store.get_versions(_pid(), agent_id)})

    @bp.post("/agents/<agent_id>/versions/<int:version_no>/rollback")
    def rollback(agent_id: str, version_no: int):
        """回滚 Agent 到指定版本，生成新版本号。"""
        return _ok(service.store.rollback(_pid(), agent_id, version_no))

    # ---------- 分组 ----------

    @bp.get("/agents/groups")
    def group_tree():
        """读取分组树（自动分组 + 覆盖层 + 手工分组）。"""
        return _ok(service.get_group_tree(_pid()))

    @bp.put("/agents/groups/overrides")
    def upsert_override():
        """新增或更新分组覆盖项（name/sort_order/hidden）。"""
        body = request.get_json(silent=True) or {}
        pid = body.get("project_id")
        if not pid or not body.get("key"):
            raise bad_request("project_id/key 不能为空")
        fields = {k: body[k] for k in ("name", "sort_order", "hidden") if k in body}
        return _ok(service.store.upsert_override(pid, body["key"], **fields))

    @bp.delete("/agents/groups/overrides")
    def delete_override():
        """删除分组覆盖项，需携带 key 查询参数。"""
        pid = _pid()
        key = request.args.get("key")
        if not key:
            raise bad_request("key 不能为空")
        return _ok({"success": service.store.delete_override(pid, key)})

    @bp.post("/agents/groups/manual")
    def create_manual_group():
        """新建手工分组，project_id 必填，父节点默认为项目根。"""
        body = request.get_json(silent=True) or {}
        pid = body.get("project_id")
        if not pid:
            raise bad_request("project_id 不能为空")
        parent = body.get("parent_key") or f"project:{pid}"
        return _ok(service.store.create_manual_group(
            pid, parent, body.get("name"), body.get("sort_order", 0)))

    @bp.delete("/agents/groups/manual/<group_id>")
    def delete_manual_group(group_id: str):
        """删除手工分组，组内 Agent 回落自动分组。"""
        return _ok({"success": service.store.delete_manual_group(_pid(), group_id)})

    @bp.put("/agents/<agent_id>/group")
    def set_agent_group(agent_id: str):
        """将 Agent 移入指定手工分组（manual_group_key 置空表示回落）。"""
        pid = _pid()
        body = request.get_json(silent=True) or {}
        return _ok(service.store.update_agent(
            pid, agent_id, {"manual_group_key": body.get("manual_group_key")}))

    # ---------- 工具 Agent ----------

    @bp.get("/agents/tools")
    def list_tools():
        """按工具汇总候选 Agent 与当前默认项。"""
        return _ok(service.list_tools(_pid()))

    @bp.post("/agents/tools/<tool_name>/switch")
    def switch_tool(tool_name: str):
        """切换某工具的默认 Agent，校验 project_id 与 agent_id。"""
        body = request.get_json(silent=True) or {}
        pid = body.get("project_id")
        if not pid or not body.get("agent_id"):
            raise bad_request("project_id/agent_id 不能为空")
        return _ok(service.switch_tool_default(pid, tool_name, body["agent_id"]))

    @bp.post("/agents/projects/<project_id>/provision")
    def provision(project_id: str):
        """幂等开通作品默认 Agent（11 步流程 + 每工具默认）。"""
        project = service.project_store.get_project(project_id)
        return _ok(service.provision_project_defaults(project))

    @bp.post("/agents/projects/<project_id>/bind-roles")
    def bind_roles(project_id: str):
        """为作品下全部角色补齐默认流程绑定。"""
        service.project_store.get_project(project_id)
        created = {}
        for role in service.role_store.list_roles(project_id):
            created[role["id"]] = len(service.bind_role_default_flow(project_id, role["id"]))
        return _ok({"roles": created})

    # ---------- 角色默认流程 ----------

    @bp.post("/roles/<role_id>/agents/reset-default")
    def reset_default(role_id: str):
        """恢复角色默认绑定：mode=fill 只补缺，replace 整体重建。"""
        body = request.get_json(silent=True) or {}
        pid = _role_project(role_id)
        bindings = service.reset_role_default_flow(pid, role_id, body.get("mode", "fill"))
        return _ok({"created": len(bindings)})

    @bp.get("/roles/<role_id>/flow-progress")
    def get_progress(role_id: str):
        """读取角色 11 步流程进度（按 project_id + role_id 隔离）。"""
        if flow_progress_store is None:
            raise not_found("进度存储未配置")
        return _ok(flow_progress_store.get(_role_project(role_id), role_id))

    @bp.post("/roles/<role_id>/flow-progress/reset")
    def reset_progress(role_id: str):
        """重置角色流程进度为 idle 空状态。"""
        if flow_progress_store is None:
            raise not_found("进度存储未配置")
        return _ok(flow_progress_store.reset(_role_project(role_id), role_id))

    # ---------- 迁移 ----------

    @bp.post("/agents/migrations/role-bindings")
    def migrate_bindings():
        """存量角色绑定回填 agent_ref_id，dry_run 默认 true。"""
        body = request.get_json(silent=True) or {}
        dry_run = bool(body.get("dry_run", True))
        result = service.migrate_role_bindings(dry_run=dry_run)
        result["dry_run"] = dry_run
        return _ok(result)

    return bp
