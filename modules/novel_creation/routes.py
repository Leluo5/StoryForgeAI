# -*- coding: utf-8 -*-
"""小说创作模块路由蓝图（P3-T4 角色 Agent API + P3-T5 项目/章节 API）。

对齐接口契约：
  §2 项目接口（P3-T5）：
    POST   /api/projects                         创建小说项目（2.1）
    GET    /api/projects                         列出项目（2.2）
    POST   /api/projects/<id>/chapters           生成章节内容（2.3）
  §3 角色接口：
    POST   /api/projects/<id>/roles              创建角色（3.1，P3-T5）
    POST   /api/roles/<role_id>/agents           绑定角色 Agent（3.2）
    PUT    /api/roles/<role_id>/agents/<bid>     更新绑定（3.3）
    POST   /api/roles/<role_id>/agents/invoke    按预设流程调用（3.4）
    GET    /api/roles/<role_id>/agents           列出角色 Agent（3.5）
  §4 工具接口（P3-T7）：
    POST   /api/projects/<id>/tools/<tool>       调用写作工具（4.1，工具-角色联动 §4.2）

关键设计：
  角色接口路径无 project_id，而 RoleStore 全部方法需 (project_id, ...)。
  因此经 ProjectStore.find_project_by_role(role_id) 反查聚合根；找不到抛 404。
  依赖注入：role_store / project_store / scheduler / flow_engine 由应用层构造传入，
  不在蓝图内硬编码单例（对齐架构设计 §7 依赖注入）。

响应格式（接口契约 §1.1）：{"code": 0, "data": ..., "message": "ok"}；
错误 {"code": <非0>, "data": null, "message": "..."}。
"""

from __future__ import annotations

from typing import Any, Dict

from flask import Blueprint, jsonify, request

from ..common.errors import bad_request, conflict, forbidden, not_found
from .role_agent_scheduler import merge_result


def create_blueprint(
    role_store: Any,
    project_store: Any,
    scheduler: Any,
    flow_engine: Any,
    tool_registry: Any = None,
) -> Blueprint:
    """创建小说创作模块蓝图（依赖注入）。

    参数：
        role_store: RoleStore 实例（角色 CRUD / 绑定管理 / 记忆）。
        project_store: ProjectStore 实例（聚合根反查 / 工具调用审计）。
        scheduler: RoleAgentScheduler 实例（有序调用绑定 Agent）。
        flow_engine: StepFlowEngine 实例（11 步流程配置与触发）。
        tool_registry: ToolRegistry 实例（工具注册/派发，§4 工具接口）。
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

    # ---------- 2.1 创建小说项目 ----------

    @bp.post("/api/projects")
    def create_project():
        """创建小说项目（接口契约 §2.1）。

        请求 {"title": "书名", "genre": "玄幻", "world_setting": {...}}。
        错误：400 title 缺失；409 同名项目已存在。
        """
        payload = request.get_json(silent=True) or {}
        title = payload.get("title")
        if not title or not str(title).strip():
            raise bad_request("title 不能为空")
        # world_setting 存 description 兜底；genre 透传
        project = project_store.create_project(
            title,
            genre=payload.get("genre") or "",
            description=payload.get("world_setting") or "",
            author=payload.get("author") or "",
        )
        return _ok({"id": project["id"], "title": project["title"],
                    "current_step": 1})

    # ---------- 2.2 列出项目 ----------

    @bp.get("/api/projects")
    def list_projects():
        """列出项目（接口契约 §2.2）。

        查询参数 page（默认 1）、page_size（默认 20）。
        """
        try:
            page = max(1, int(request.args.get("page", 1)))
            page_size = min(100, max(1, int(request.args.get("page_size", 20))))
        except ValueError:
            raise bad_request("page/page_size 须为整数")
        all_projects = project_store.list_projects()
        total = len(all_projects)
        start = (page - 1) * page_size
        items = all_projects[start:start + page_size]
        return _ok({"items": items, "total": total})

    # ---------- 2.3 生成章节内容 ----------

    @bp.post("/api/projects/<project_id>/chapters")
    def create_chapter(project_id: str):
        """生成章节内容（接口契约 §2.3）。

        请求 {"title": "章名", "content": "正文", "author_role_id": "角色ID"}。
        错误：400 content 缺失；404 项目不存在；403 非本角色章节（越界）。
        order 缺省自动分配（当前最大 + 1）。
        """
        project = project_store.get_project(project_id)  # 404 若不存在
        payload = request.get_json(silent=True) or {}
        title = payload.get("title")
        content = payload.get("content")
        author_role_id = payload.get("author_role_id")
        if not content or not str(content).strip():
            raise bad_request("content 不能为空")
        # 越界校验：author_role_id 须属于本项目（接口契约 §2.3：403 非本角色章节）
        if author_role_id:
            role_ids = {r.get("id") for r in project.get("roles", [])}
            if author_role_id not in role_ids:
                raise forbidden(f"角色 {author_role_id} 不属于本项目")
        chapter = project_store.create_chapter(
            project_id, title or "", content=content,
        )
        return _ok({"id": chapter["id"], "order": chapter["order"]})

    # ---------- 3.1 创建角色 ----------

    @bp.post("/api/projects/<project_id>/roles")
    def create_role(project_id: str):
        """创建角色（接口契约 §3.1）。

        请求 {"name": "角色名", "age": 25, "gender": "男"}。
        错误：400 name 缺失；404 项目不存在。
        """
        project_store.get_project(project_id)  # 404 若不存在
        payload = request.get_json(silent=True) or {}
        name = payload.get("name")
        if not name or not str(name).strip():
            raise bad_request("name 不能为空")
        role = role_store.create_role(
            project_id, name,
            age=payload.get("age"),
            gender=payload.get("gender"),
        )
        return _ok({"id": role["id"], "name": role["name"]})

    # ---------- 2.4 多角色协同 ----------

    @bp.post("/api/projects/<project_id>/collab")
    def collab_invoke(project_id: str):
        """多角色协同调用（接口契约 §2.4）。

        请求 {"roles": ["role1", "role2"], "step_order": 11, "context": {...}}。
        流程：project_id 获取写锁（非阻塞，未获抛 409）→ 各角色 Agent 依序调用
        （并行读/串行写，context 逐角色合并）→ 汇总 merged_context 与 conflicts。

        错误码：
            400 roles 为空/非法 step_order/context 非对象
            404 项目不存在
            409 协同未开启（collab_enabled=false）/ 写锁未获取
        """
        payload = request.get_json(silent=True) or {}
        roles = payload.get("roles")
        step_order = payload.get("step_order")
        context = payload.get("context") or {}
        if not isinstance(roles, list) or not roles:
            raise bad_request("roles 不能为空")
        if any(not isinstance(r, str) or not r.strip() for r in roles):
            raise bad_request("roles 须为字符串数组")
        if not isinstance(step_order, int) or not (1 <= step_order <= 11):
            raise bad_request("step_order 须为 1-11 整数")
        if not isinstance(context, dict):
            raise bad_request("context 须为对象")

        # 协同模式开关（接口契约 §2.4：409 协同未开启）
        if not project_store.get_collab_enabled(project_id):
            raise conflict("协同模式未开启")

        # 项目存在校验（404）
        project_store.get_project(project_id)

        # 角色存在校验（404，拿锁前完成，避免锁内异常污染）
        for role_id in roles:
            role_store.get_role(project_id, role_id)

        # 获取协同写锁（非阻塞，未获抛 409）
        collab_lock = project_store._collab_lock(project_id)
        if not collab_lock.try_acquire():
            raise conflict("写锁未获取")
        try:
            merged: Dict[str, Any] = {}
            conflicts: list = []
            # 各角色依序调用；角色无命中绑定则跳过（无输出，不算冲突）
            for role_id in roles:
                # 命中规则与调度器一致：step_order <= 当前 且 enabled=true
                bindings = role_store.get_bindings(project_id, role_id, enabled=True)
                if not any(b["step_order"] <= step_order for b in bindings):
                    continue
                try:
                    result = scheduler.invoke_role_agents(
                        project_id, role_id, step_order, merged,
                    )
                except Exception as _e:  # 记录但继续其他角色
                    conflicts.append({
                        "role_id": role_id,
                        "error": str(_e),
                    })
                    continue
                # 冲突检测：后写覆盖告警（结果与既有上下文键冲突）
                if merged and set(merged.keys()) & set(result.keys()):
                    conflicts.append({
                        "role_id": role_id,
                        "type": "context_overlap",
                        "keys": sorted(set(merged.keys()) & set(result.keys())),
                    })
                merged = merge_result(merged, result)
        finally:
            collab_lock.release()
        return _ok({"merged_context": merged, "conflicts": conflicts})

    # ---------- 4.1 调用写作工具 ----------

    @bp.post("/api/projects/<project_id>/tools/<tool>")
    def invoke_tool(project_id: str, tool: str):
        """调用写作工具（接口契约 §4.1）。

        请求 {"params": {...}, "role_id": "可选"}。
        流程：白名单校验（404 未注册）→ 项目存在校验（404）→ role_link 工具注入
        角色上下文（只读，§4.2）→ 派发处理器 → 审计落库（success/failed/pending）。

        响应：
            同步工具：{"code": 0, "data": {"result": ...}}
            长任务（gen_novel / gen_audiobook / run_70_workflow）：
                {"code": 0, "data": {"task_id": "...", "status": "queued"}}
        错误码：404 工具未注册 / 项目不存在 / 角色不存在。

        注：真实长任务队列由实现任务替换；本阶段占位返回 task_id（新 UUID）
        + status=queued，并落 pending 审计，保持契约「长任务排队」语义。
        """
        if tool_registry is None:
            raise not_found("工具注册中心未初始化")
        # 白名单校验：未注册抛 404（接口契约 §4.1：404 工具未注册）
        spec = tool_registry.get(tool)
        if spec is None:
            raise not_found(f"工具未注册: {tool}")
        project_store.get_project(project_id)  # 404 若不存在

        payload = request.get_json(silent=True) or {}
        params = payload.get("params") or {}
        role_id = payload.get("role_id")
        if not isinstance(params, dict):
            raise bad_request("params 须为对象")
        if role_id is not None and not isinstance(role_id, str):
            raise bad_request("role_id 须为字符串")

        # §4.2 工具-角色联动：role_link 工具读取角色上下文（只读注入）
        context: Dict[str, Any] = {}
        if spec.role_link and role_id:
            role = role_store.get_role(project_id, role_id)  # 404 若不存在
            context["role"] = role
            context["role_id"] = role_id
            context["project_id"] = project_id

        # 派发处理器（异常映射 500/502 由应用层错误处理器统一处理）
        try:
            result = spec.handler(params, context)
            status = "success"
        except Exception as _e:  # noqa: BLE001 - 失败审计后重抛
            project_store.append_tool_call(
                project_id, tool, params, {"error": str(_e)},
                status="failed", role_id=role_id,
            )
            raise

        # 长任务：落 pending 审计，返回排队语义（task_id 暂用新 UUID）
        if spec.long_task:
            from ..common.storage import new_id as _new_id
            task_id = _new_id()
            project_store.append_tool_call(
                project_id, tool, params, {"task_id": task_id},
                status="pending", role_id=role_id,
            )
            return _ok({"task_id": task_id, "status": "queued"})

        # 同步工具：审计 + 返回 result
        project_store.append_tool_call(
            project_id, tool, params, result, status="success", role_id=role_id,
        )
        return _ok({"result": result})

    return bp
