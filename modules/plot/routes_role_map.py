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

import threading
import uuid
from typing import Any, Callable, Dict, List, Optional

from flask import Blueprint, jsonify, request

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
    project_store: Any = None,
    plot_store: Any = None,
    llm_fn: Optional[Callable[[str], Dict[str, Any]]] = None,
) -> Blueprint:
    """创建角色版图蓝图（依赖注入，便于单测）。"""
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

    return bp


def _collect_growth_nodes(plot_store: Any, role_id: str) -> List[Dict[str, Any]]:
    """从剧情树收集指定角色的成长线节点（F8-T10 成长线渲染用）。

    遍历 plot_store 全部树，按节点 role_id 匹配，输出轻量节点
    （id/label/type/order/章节标题），按序排序供时间线渲染。
    """
    nodes: List[Dict[str, Any]] = []
    try:
        trees = plot_store.list_trees()
        for tree in trees:
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
                    })
    except Exception:
        return []
    # 按 tree 顺序 + 节点顺序排序
    nodes.sort(key=lambda n: (n.get("order", 0), n.get("label", "")))
    return nodes


def _node_order(tree_data: Dict[str, Any], node: Dict[str, Any]) -> int:
    """计算节点在树中的顺序（按根到当前节点的深度优先序）。"""
    # 简化：按节点在 nodes 数组中的下标作为稳定序（F8-T10 时间线顺序够用）
    nodes = tree_data.get("nodes", [])
    for idx, n in enumerate(nodes):
        if n.get("id") == node.get("id"):
            return idx
    return 0
