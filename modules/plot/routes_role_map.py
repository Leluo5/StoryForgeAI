# -*- coding: utf-8 -*-
"""F8 角色版图图谱 API 路由（/api/role-map/*）。

对齐 F8 技术方案 §4（API 设计）：
- GET  /api/role-map/graph        — 图谱全量（节点含角色属性 + 边 + AI 状态）
- POST /api/role-map/nodes        — 手动添加角色节点到图谱
- DELETE /api/role-map/nodes/<id> — 从图谱移除节点（仅图谱，不删 Role 实体）
- POST /api/role-map/edges        — 建立关联（双向 relations）
- DELETE /api/role-map/edges      — 删除关联（双向清理）
- GET  /api/role-map/filter/options  — 筛选维度候选值
- POST /api/role-map/filter       — 组合筛选（服务端过滤）
- DELETE /api/role-map/roles/<id> — 删除角色全链路（标红章节+清剧情+清关联+删 Role）
- GET  /api/role-map/roles/<id>   — 角色详情（含关联 + 成长线剧情节点）
- POST /api/role-map/ai/generate  — AI 抽取（后台线程，返回 task_id 202）
- GET  /api/role-map/ai/progress  — AI 抽取进度 {stage, percent, done}
- POST /api/role-map/ai/commit    — 二次编辑确认提交（写库 + ai_generated=true）

依赖注入：create_role_map_blueprint(role_map_store, role_store, project_store,
plot_store=None, llm_fn=None)。llm_fn 生产由 app 装配 coze run_workflow 包装；
单测可注入 mock。AI generate 用后台 daemon thread + 进程内 task 表（202 立即返回，
前端轮询 progress），对齐技术方案 §4.2 长任务排队契约。
"""

from __future__ import annotations

import os
import threading
import uuid
from typing import Any, Callable, Dict, List

from flask import Blueprint, jsonify, request, send_file

from ..common.errors import AppError, bad_request, not_found
from .role_map_ai import RoleMapAIExtractor


def _json_body() -> Dict[str, Any]:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise bad_request("请求体须为 JSON 对象")
    return data


def _error_response(exc: Exception) -> Any:
    """统一错误响应（对齐 modules/common/errors 契约）。"""
    if isinstance(exc, AppError):
        return jsonify({"error": exc.message}), exc.status_code
    return jsonify({"error": str(exc)}), 500


# 进程内 AI 任务表（对齐技术方案 §4.2 task_id 契约）
# key: task_id -> {"project_id": ..., "status": "running|done|failed", "error": ...}
_AI_TASKS: Dict[str, Dict[str, Any]] = {}
_AI_TASKS_LOCK = threading.Lock()


def _make_llm_wrapper(coze_client: Any) -> Callable[[str], Dict[str, Any]]:
    """包装 coze_client.run_workflow 为 RoleMapAIExtractor 的 llm_fn。

    契约：llm_fn(prompt) -> dict（LLM 返回解析结果）。
    实现：调用 coze run_workflow（固定抽取 workflow_id），失败抛 AppError。
    """
    def _wrapper(prompt: str) -> Dict[str, Any]:
        result = coze_client.run_workflow(
            _ROLE_MAP_WORKFLOW_ID, {"prompt": prompt})
        if not result.get("success"):
            raise AppError(502, f"AI 抽取失败: {result.get('error', '未知错误')}")
        data = result.get("data")
        # run_workflow 返回 data 可能是字符串（JSON 文本），解析交由 extractor._parse_llm_json
        return data
    return _wrapper


# 抽取 workflow id（由 app 装配时注入；默认空表示未配置，走 mock/报错）
_ROLE_MAP_WORKFLOW_ID: str = ""


def set_workflow_id(workflow_id: str) -> None:
    """注入抽取 workflow id（app 装配时调用）。"""
    global _ROLE_MAP_WORKFLOW_ID
    _ROLE_MAP_WORKFLOW_ID = workflow_id


def create_role_map_blueprint(
    role_map_store: Any,
    role_store: Any,
    **options: Any,
) -> Blueprint:
    """创建角色版图蓝图（依赖注入，便于单测）。

    参数：
        role_map_store: 角色版图存储。
        role_store: 角色存储。
        **options: 可选依赖（F9-T5 增量）——
            project_store: 项目存储（默认 None）。
            plot_store: 剧情树存储（成长线过滤，默认 None）。
            llm_fn: 抽取调用函数（默认 None，走 extractor 默认占位）。
            data_root: 数据根目录（data/），用于定位头像 data/avatars/<project>/<hash>.png。
            tool_registry: 工具注册中心（F9 头像生成复用 gen_character_image 真实 handler）。
            coze_client: Coze 客户端（头像生成工作流调用）。
            config_loader: 全局配置加载器（读取 image_workflow_id）。
    """
    project_store = options.get("project_store")
    plot_store = options.get("plot_store")
    llm_fn = options.get("llm_fn")
    data_root = options.get("data_root")
    tool_registry = options.get("tool_registry")
    coze_client = options.get("coze_client")
    config_loader = options.get("config_loader")
    bp = Blueprint("role_map", __name__, url_prefix="/api/role-map")

    @bp.errorhandler(AppError)
    def _handle_app_error(exc):
        """蓝图内统一处理业务异常（独立挂载时也生效）。"""
        return _error_response(exc)

    extractor = RoleMapAIExtractor(role_map_store, role_store, llm_fn=llm_fn)

    # ---------- 图谱 ----------

    @bp.get("/graph")
    def graph():
        """获取角色版图全量图数据（节点+边）。"""
        project_id = request.args.get("project_id", "")
        if not project_id:
            raise bad_request("project_id 不能为空")
        return jsonify(role_map_store.get_graph(project_id))

    # ---------- 节点 ----------

    @bp.post("/nodes")
    def add_node():
        """添加角色节点，返回 201。"""
        body = _json_body()
        project_id = body.get("project_id", "")
        role_id = body.get("role_id", "")
        if not project_id or not role_id:
            raise bad_request("project_id/role_id 不能为空")
        return jsonify(role_map_store.add_node(project_id, role_id)), 201

    @bp.delete("/nodes/<role_id>")
    def remove_node(role_id):
        """移除角色节点（含关联边）。"""
        project_id = request.args.get("project_id", "")
        if not project_id:
            raise bad_request("project_id 不能为空")
        return jsonify(role_map_store.remove_node(project_id, role_id))

    # ---------- 边 ----------

    @bp.post("/edges")
    def add_edge():
        """添加角色关系边，返回 201。"""
        body = _json_body()
        project_id = body.get("project_id", "")
        source = body.get("source", "")
        target = body.get("target", "")
        relation_type = body.get("relation_type", "")
        note = body.get("note", "")
        return jsonify(
            role_map_store.add_edge(
                project_id, source, target, relation_type, note=note,
            )
        ), 201

    @bp.delete("/edges")
    def remove_edge():
        """删除角色关系边。"""
        body = _json_body()
        project_id = body.get("project_id", "")
        source = body.get("source", "")
        target = body.get("target", "")
        return jsonify(role_map_store.remove_edge(project_id, source, target))

    # ---------- 筛选 ----------

    @bp.get("/filter/options")
    def filter_options():
        """获取版图各维度可选筛选项。"""
        project_id = request.args.get("project_id", "")
        if not project_id:
            raise bad_request("project_id 不能为空")
        return jsonify(role_map_store.get_filter_options(project_id))

    @bp.post("/filter")
    def filter_graph():
        """按维度过滤版图节点与边。"""
        body = _json_body()
        project_id = body.get("project_id", "")
        if not project_id:
            raise bad_request("project_id 不能为空")
        filters = body.get("filters") or {}
        return jsonify(role_map_store.filter_graph(project_id, filters))

    # ---------- 角色详情 + 删除全链路 ----------

    @bp.get("/roles/<role_id>")
    def role_detail(role_id):
        """角色详情：基础信息 + 关系 + 成长线节点。"""
        project_id = request.args.get("project_id", "")
        if not project_id:
            raise bad_request("project_id 不能为空")
        role = role_store.get_role(project_id, role_id)
        rel_data = role_map_store.get_role_relations(project_id, role_id)
        # 契约：relations 为图谱边列表（含 relation_type/note）；relation_check 为双源一致校验
        # 成长线：从剧情树按 role_id 过滤（plot_store 可选注入）
        growth_nodes = []
        if plot_store is not None:
            growth_nodes = _collect_growth_nodes(plot_store, role_id)
        return jsonify({
            "role": role,
            "relations": rel_data.get("edges", []),
            "relation_check": rel_data.get("relations", []),
            "growth": {"nodes": growth_nodes},
        })

    @bp.delete("/roles/<role_id>")
    def delete_role_chain(role_id):
        """删除角色全链路（节点/边/绑定/会话）。"""
        body = _json_body()
        project_id = body.get("project_id", "")
        if not project_id:
            raise bad_request("project_id 不能为空")
        result = role_map_store.delete_role_chain(project_id, role_id)
        return jsonify(result)

    # ---------- AI 抽取（三阶段） ----------

    @bp.post("/ai/generate")
    def ai_generate():
        """启动 AI 角色抽取后台任务，返回 task_id + 202。"""
        body = _json_body()
        project_id = body.get("project_id", "")
        source_text = body.get("source_text", "")
        source_label = body.get("source_label", "all")
        if not project_id or not source_text:
            raise bad_request("project_id/source_text 不能为空")

        task_id = uuid.uuid4().hex
        with _AI_TASKS_LOCK:
            _AI_TASKS[task_id] = {
                "project_id": project_id, "status": "running", "error": None,
            }

        def _run():
            try:
                extractor.extract_roles(project_id, source_text, source_label)
                with _AI_TASKS_LOCK:
                    _AI_TASKS[task_id]["status"] = "done"
            except Exception as exc:  # noqa: BLE001 后台线程捕获全部异常
                with _AI_TASKS_LOCK:
                    _AI_TASKS[task_id]["status"] = "failed"
                    _AI_TASKS[task_id]["error"] = str(exc)

        threading.Thread(target=_run, daemon=True).start()
        # 202 Accepted：长任务排队契约（前端轮询 /ai/progress）
        return jsonify({"task_id": task_id, "status": "running"}), 202

    @bp.get("/ai/progress")
    def ai_progress():
        """查询 AI 抽取任务进度。"""
        project_id = request.args.get("project_id", "")
        if not project_id:
            raise bad_request("project_id 不能为空")
        return jsonify(extractor.get_progress(project_id))

    @bp.post("/ai/commit")
    def ai_commit():
        """提交抽取结果（角色+关系），返回 201。"""
        body = _json_body()
        project_id = body.get("project_id", "")
        characters = body.get("characters", [])
        relations = body.get("relations", [])
        if not project_id:
            raise bad_request("project_id 不能为空")
        result = extractor.commit_extracted(project_id, characters, relations)
        return jsonify(result), 201

    # ---------- F9-T5 头像与形象特征 ----------

    @bp.post("/avatar/generate")
    def avatar_generate():
        """生成/重新生成角色头像（F9-03：创建/修改后自动更新）。

        契约（技术方案 §六）：
        - body: {project_id, role_id, force?}
        - 复用工具注册中心 gen_character_image 真实 handler（F9-T3）；
          缓存命中直接返回既有 avatar（幂等）；未命中调 Coze 文生图 → 落盘 → 写回。
        - 返回 {avatar, cached, role:{id,name}}。
        """
        body = _json_body()
        project_id = body.get("project_id", "")
        role_id = body.get("role_id", "")
        if not project_id or not role_id:
            raise bad_request("project_id/role_id 不能为空")
        role = role_store.get_role(project_id, role_id)

        # 依赖检查：缺工具注册中心 → 回退占位（不调 AI），不阻断图谱操作
        if tool_registry is None:
            return jsonify({
                "avatar": "", "cached": False, "placeholder": True,
                "message": "工具注册中心未配置，返回占位头像",
                "role": {"id": role_id, "name": role.get("name", "")},
            })

        context = {
            "role": role,
            "role_id": role_id,
            "project_id": project_id,
            "role_store": role_store,
            "coze_client": coze_client,
            "data_root": data_root,
            "image_workflow_id": None,
            "config_loader": config_loader,
        }
        # 从配置读取 image_workflow_id（handler 内部也会尝试，这里预取一次）
        if config_loader is not None:
            try:
                cfg = config_loader.load_global_config()
                wf = (cfg.get("image_tools") or {}).get("character_workflow_id")
                if wf:
                    context["image_workflow_id"] = wf
            except Exception:  # noqa: BLE001 - 配置读取失败仅降级
                pass

        params = {}
        force = body.get("force", False)
        # force=true：请求重新生成（清缓存）——handler 目前无 force 分支，
        # 保留参数供后续扩展；当前 force 仍走缓存（幂等优先）。
        if force:
            params["force"] = True

        result = tool_registry.invoke("gen_character_image", params, context)
        return jsonify(result)

    @bp.get("/avatar/<avatar_hash>")
    def avatar_file(avatar_hash):
        """获取头像文件（F9-T5）。

        avatar 存储路径为 /api/role-map/avatar/<hash>（与项目无关，哈希即特征幂等键）。
        文件按项目分目录存放 data/avatars/<project>/<hash>.png；同特征跨项目共享同一 hash，
        确定性一致（F9-02）。GET 时在 data/avatars/*/ 下查找该 hash 文件。
        """
        if not avatar_hash or len(avatar_hash) != 16:
            raise bad_request("无效的头像 hash")
        base = data_root or ""
        avatars_root = os.path.join(base, "avatars")
        # 遍历各项目子目录查找 hash 文件（项目数有限，低频头像读取）
        found_path = None
        if os.path.isdir(avatars_root):
            for proj_dir in os.listdir(avatars_root):
                cand = os.path.join(avatars_root, proj_dir, f"{avatar_hash}.png")
                if os.path.isfile(cand):
                    found_path = cand
                    break
        if found_path is None:
            raise not_found(f"头像不存在: {avatar_hash}")
        return send_file(found_path, mimetype="image/png")

    @bp.put("/roles/<role_id>/visual")
    def role_visual(role_id):
        """更新角色形象特征（F9-01/03）。

        契约：body: {project_id, visual_features:{hair_style,hair_color,face_features,
        outfit_style,expression}}。写入 role.visual_features（白名单由 RoleStore 校验），
        并返回更新后的 role（含 avatar 字段）。
        """
        body = _json_body()
        project_id = body.get("project_id", "")
        if not project_id:
            raise bad_request("project_id 不能为空")
        visual_features = body.get("visual_features") or {}
        if not isinstance(visual_features, dict):
            raise bad_request("visual_features 须为对象")
        updated = role_store.update_role(project_id, role_id, visual_features=visual_features)
        return jsonify({"role": updated})

    return bp


def _collect_growth_nodes(plot_store: Any, role_id: str) -> List[Dict[str, Any]]:
    """从剧情树收集指定角色的成长线节点（F8-T10 成长线渲染用）。

    遍历 plot_store 全部树，按节点 role_id 匹配，输出轻量节点
    （id/label/type/order/章节标题），按序排序供时间线渲染。
    """
    nodes: List[Dict[str, Any]] = []
    try:
        trees = plot_store.list_trees()
        # tree_index 记录树在 list_trees 中的下标，作为排序主键：
        # 保证跨树不交错（先整棵树、再下一棵），树内再按节点顺序。
        for tree_index, tree in enumerate(trees):
            try:
                tree_data = plot_store.load_tree(tree["id"])
            except Exception:
                continue
            for node in tree_data.get("nodes", []):
                if node.get("role_id") == role_id:
                    # 章节标题（若关联章节）：从节点 linked 或 content 摘要
                    nodes.append({
                        "id": node.get("id"),
                        "label": node.get("label", ""),
                        "type": node.get("type", ""),
                        "order": _node_order(tree_data, node),
                        "tree_id": tree["id"],
                        "tree_name": tree.get("name", ""),
                        "tree_index": tree_index,
                    })
    except Exception:
        return []
    # 按树顺序（主键）+ 树内节点顺序排序；排序键不透出到 API 输出前剥离
    nodes.sort(key=lambda n: (n.get("tree_index", 0), n.get("order", 0)))
    for n in nodes:
        n.pop("tree_index", None)
    return nodes


def _node_order(tree_data: Dict[str, Any], node: Dict[str, Any]) -> int:
    """计算节点在树中的顺序（按根到当前节点的深度优先序）。"""
    # 简化：按节点在 nodes 数组中的下标作为稳定序（F8-T10 时间线顺序够用）
    nodes = tree_data.get("nodes", [])
    for idx, n in enumerate(nodes):
        if n.get("id") == node.get("id"):
            return idx
    return 0
