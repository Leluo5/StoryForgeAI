# -*- coding: utf-8 -*-
"""剧情树接口层（F7-T6）。

对齐 F7 技术方案 §3.1~§3.11 全部路由：
- §3.1 创建树 / §3.2 列出 / §3.3 详情 / §3.4 删除
- §3.5 生成（大纲/拆文两种模式，待确认态）
- §3.6 节点：新增/编辑/删除（级联）
- §3.7 关联：新增/删除（自环校验）
- §3.8 布局保存
- §3.9 双向联动：push（树→推衍上下文）/ pull（推衍回写）
- §3.10 导出 / §3.11 导入

统一响应 {"code":0,"data":...,"message":"ok"}；错误 {"code":非0,"data":null,"message":...}。
依赖注入：LLM 封装经模块级 _llm_fn 注入（生产默认 _default_llm，单测 mock）。
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Callable, Dict, Optional

from flask import Blueprint, jsonify, request

from coze_client import CozeClient
from modules import story_thread
from modules.common.errors import AppError, bad_request, not_found
from modules.plot.plot_parser import parse_novel, parse_outline
from modules.plot.plot_tree import PlotTreeStore

# 蓝图
bp = Blueprint("plot", __name__, url_prefix="/api/plot")

# 数据目录（对齐全栈约定：项目根 data/plot/）
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PLOT_DATA_DIR = os.path.join(_BASE_DIR, "data", "plot")

# 领域对象（可被测试覆盖注入）
_store: PlotTreeStore = PlotTreeStore(PLOT_DATA_DIR)


def _ok(data: Any, message: str = "ok"):
    return jsonify({"code": 0, "data": data, "message": message})


def _err(code: int, message: str, detail: str = ""):
    msg = message if not detail else f"{message}: {detail}"
    return jsonify({"code": code, "data": None, "message": msg}), code


@bp.errorhandler(AppError)
def _handle_app_error(e: AppError):
    return _err(e.code, e.message, e.detail)


def _body() -> Dict[str, Any]:
    return request.get_json(silent=True) or {}


# ---- §3.1 创建树 ----

@bp.route("/trees", methods=["POST"])
def create_tree():
    """创建剧情树。请求：{"name": "...", "source": "outline|novel|manual"}"""
    body = _body()
    tree = _store.create_tree(body.get("name", ""), body.get("source", "manual"))
    return _ok(tree)


# ---- §3.2 列出 ----

@bp.route("/trees", methods=["GET"])
def list_trees():
    """剧情树列表（轻量：计数 + 更新时间，不含节点全量）。"""
    return _ok({"trees": _store.list_trees()})


# ---- §3.3 详情 ----

@bp.route("/trees/<tree_id>", methods=["GET"])
def tree_detail(tree_id: str):
    """剧情树详情（含全量节点/关联）。"""
    return _ok(_store.load_tree(tree_id))


# ---- §3.4 删除 ----

@bp.route("/trees/<tree_id>", methods=["DELETE"])
def delete_tree(tree_id: str):
    """删除剧情树。"""
    deleted = _store.delete_tree(tree_id)
    if not deleted:
        raise not_found("剧情树不存在", tree_id)
    return _ok({"deleted": True})


# ---- §3.5 生成（大纲/拆文 → 树，待确认态）----

@bp.route("/trees/generate", methods=["POST"])
def generate_tree():
    """生成剧情树。请求：{"name": "...", "mode": "outline|novel", "content": "..."}

    mode=outline：基于大纲解析；mode=novel：基于拆文解析。产出待确认态（pending=True）。
    LLM 封装经 _llm_fn 注入（见模块底部）。
    """
    body = _body()
    mode = body.get("mode", "")
    content = body.get("content", "")
    name = body.get("name", "生成剧情树")
    if mode == "outline":
        tree = parse_outline(content, name, _llm_fn)
    elif mode == "novel":
        tree = parse_novel(content, name, _llm_fn)
    else:
        raise bad_request("生成模式非法，允许：outline / novel")
    return _ok(tree)


# ---- §3.6 节点：新增/编辑/删除 ----

@bp.route("/trees/<tree_id>/nodes", methods=["POST"])
def add_node(tree_id: str):
    """新增节点。请求：{"label", "type", "content", "parent_id", "source", "tags", "position"}"""
    tree = _store.load_tree(tree_id)
    body = _body()
    node = _store.add_node(
        tree,
        label=body.get("label", ""),
        node_type=body.get("type", "main"),
        content=body.get("content", ""),
        parent_id=body.get("parent_id"),
        source=body.get("source", "manual"),
        tags=body.get("tags"),
        position=body.get("position"),
    )
    return _ok(node)


@bp.route("/trees/<tree_id>/nodes/<node_id>", methods=["PATCH"])
def edit_node(tree_id: str, node_id: str):
    """编辑节点。请求：{"label"|"content"|"type"|"tags"|"position"}"""
    tree = _store.load_tree(tree_id)
    node = _store.edit_node(tree, node_id, _body())
    return _ok(node)


@bp.route("/trees/<tree_id>/nodes/<node_id>", methods=["DELETE"])
def delete_node(tree_id: str, node_id: str):
    """删除节点（级联子节点 + 清关联）。"""
    tree = _store.load_tree(tree_id)
    result = _store.delete_node(tree, node_id)
    return _ok(result)


# ---- §3.7 关联：新增/删除 ----

@bp.route("/trees/<tree_id>/links", methods=["POST"])
def add_link(tree_id: str):
    """新增关联。请求：{"from_id", "to_id", "type": "前置|后置|非线性", "note"}"""
    tree = _store.load_tree(tree_id)
    body = _body()
    link = _store.add_link(
        tree,
        from_id=body.get("from_id", ""),
        to_id=body.get("to_id", ""),
        link_type=body.get("type", "前置"),
        note=body.get("note", ""),
    )
    return _ok(link)


@bp.route("/trees/<tree_id>/links", methods=["DELETE"])
def delete_link(tree_id: str):
    """删除关联。请求：{"from_id", "to_id", "type"}"""
    tree = _store.load_tree(tree_id)
    body = _body()
    deleted = _store.delete_link(
        tree,
        from_id=body.get("from_id", ""),
        to_id=body.get("to_id", ""),
        link_type=body.get("type", "前置"),
    )
    if not deleted:
        raise not_found("关联不存在")
    return _ok({"deleted": True})


# ---- §3.8 布局保存 ----

@bp.route("/trees/<tree_id>/layout", methods=["POST"])
def save_layout(tree_id: str):
    """保存节点坐标。请求：{"positions": [{"id", "position": {"x", "y"}}]}"""
    tree = _store.load_tree(tree_id)
    body = _body()
    count = _store.save_layout(tree, body.get("positions", []))
    return _ok({"updated": count})


# ---- §3.9 双向联动 ----

@bp.route("/trees/<tree_id>/sync-room/<room_id>", methods=["POST"])
def sync_room(tree_id: str, room_id: str):
    """与聊天室双向联动。

    请求：{"action": "push"|"pull", "context_node_ids": [], "parent_node_id": ""}
    action=push：树 → 推衍上下文注入（选择上下文节点返回，实际注入由前端/聊天室完成）。
    action=pull：聊天室已提交推衍步骤 → 回写为新节点（去重）。
    """
    tree = _store.load_tree(tree_id)
    body = _body()
    action = body.get("action", "")

    if action == "push":
        result = _store.push_to_room(tree, room_id, body.get("context_node_ids"))
        return _ok(result)

    if action == "pull":
        # 读取聊天室历史步骤（已提交推衍），转为回写步骤
        with story_thread.with_room(room_id, "r") as room:
            history = room.get("history", [])
        steps = [
            {
                "id": h.get("step_no"),
                "label": f"推衍第{h.get('step_no')}步",
                "content": h.get("content", ""),
            }
            for h in history
        ]
        result = _store.pull_from_room(tree, room_id, steps, body.get("parent_node_id"))
        return _ok(result)

    raise bad_request("联动动作非法，允许：push / pull")


# ---- §3.10 导出 ----

@bp.route("/trees/<tree_id>/export", methods=["GET"])
def export_tree(tree_id: str):
    """导出剧情树。query：scope=all|node，node_id=..."""
    tree = _store.load_tree(tree_id)
    scope = request.args.get("scope", "all")
    node_id = request.args.get("node_id")
    data = _store.export_tree(tree, scope, node_id)
    return _ok(data)


# ---- §3.11 导入 ----

@bp.route("/trees/import", methods=["POST"])
def import_tree():
    """导入剧情树。请求：{"data": {...}, "mode": "merge|replace", "target_tree_id": "..."}"""
    body = _body()
    data = body.get("data")
    if not isinstance(data, dict):
        raise bad_request("导入数据缺失或非法")
    result = _store.import_tree(
        data,
        mode=body.get("mode", "merge"),
        target_tree_id=body.get("target_tree_id"),
    )
    return _ok(result)


# ---- LLM 封装注入点 ----

def _default_llm(prompt: str, *args: Any, **kwargs: Any) -> Dict[str, Any]:
    """生产 LLM 封装：经 coze_client.chat（与 story_engine/knowledge_parser 一致）。

    返回须为 {"nodes": [...], "links": [...]}；由调用方（parse_outline/parse_novel）解析。
    """
    client = CozeClient()
    # chat 返回字符串，此处由解析器做 JSON 解析；返回原始文本包装为可解析结构
    text = client.chat("", prompt, **kwargs)
    return _parse_llm_json(text)


def _parse_llm_json(text: str) -> Dict[str, Any]:
    """解析 LLM 返回文本为 dict（剥离 markdown 代码围栏）。"""
    if not isinstance(text, str):
        return text if isinstance(text, dict) else {}
    cleaned = text.strip()
    # 去掉 ```json ... ``` 围栏
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1)
    try:
        return json.loads(cleaned)
    except (ValueError, TypeError):
        # 尝试提取首个 {...} 块
        m = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except (ValueError, TypeError):
                pass
        raise bad_request("LLM 返回内容无法解析为剧情树结构")


# 模块级 LLM 封装（可被测试覆盖）
_llm_fn: Callable[..., Dict[str, Any]] = _default_llm


def set_llm_fn(fn: Optional[Callable[..., Dict[str, Any]]]) -> None:
    """测试注入点：替换 LLM 封装。"""
    global _llm_fn
    _llm_fn = fn or _default_llm
