# -*- coding: utf-8 -*-
"""剧情树生成解析器（F7-T2）。

对齐 F7 技术方案 §4.1：parse_outline（大纲→树）+ parse_novel（拆文→树），
统一产出 plot_tree 结构；生成结果进入待确认态（确认前不入主数据）。

设计：纯函数 + 依赖注入。LLM 调用经注入的 callable（默认 coze 封装），
便于单测 mock；知识库/拆文数据经参数注入（不直接 import 知识库模块）。
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from ..common.errors import bad_request, conflict
from ..common.storage import new_id, now_iso


def _default_llm(prompt: str, *args: Any, **kwargs: Any) -> Dict[str, Any]:
    """默认 LLM 封装占位（生产由路由层注入 coze_client；单测 mock 覆盖）。"""
    raise NotImplementedError("parse_outline/parse_novel 需要注入 llm_fn")


def _build_tree(
    name: str,
    source: str,
    node_specs: List[Dict[str, Any]],
    link_specs: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """把 LLM 产出的节点/关联规格组装为 plot_tree 结构（待确认态）。"""
    nodes: List[Dict[str, Any]] = []
    id_map: Dict[str, str] = {}

    # 防御：LLM 可能返回非法元素（非 dict），直接拒绝（对齐技术方案 §4.1 容错）
    if (
        not all(isinstance(s, dict) for s in node_specs)
        or not all(isinstance(s, dict) for s in link_specs)
    ):
        raise conflict("LLM 返回结构不合法，请重试")

    # 首节点为根（start 类型优先）
    root_marker = None
    for spec in node_specs:
        if spec.get("type") == "start":
            root_marker = spec
            break
    if root_marker is None and node_specs:
        root_marker = node_specs[0]

    for spec in node_specs:
        nid = new_id()
        id_map[spec.get("key") or spec.get("label")] = nid
        nodes.append({
            "id": nid,
            "label": spec.get("label", "剧情节点"),
            "type": spec.get("type", "main"),
            "content": spec.get("content", ""),
            "parent_id": None,
            "children_ids": [],
            "source": "generated",
            "linked_room_id": None,
            "position": {"x": 120 + len(nodes) * 60, "y": 200},
            "tags": spec.get("tags", []),
        })

    links: List[Dict[str, Any]] = []
    for spec in link_specs:
        from_id = id_map.get(spec.get("from"))
        to_id = id_map.get(spec.get("to"))
        if from_id and to_id:
            links.append({
                "from": from_id,
                "to": to_id,
                "type": spec.get("type", "前置"),
                "note": spec.get("note", ""),
            })

    # 父指针回填（依据 children 关系）
    for spec in node_specs:
        nid = id_map.get(spec.get("key") or spec.get("label"))
        if nid and spec.get("parent"):
            parent_id = id_map.get(spec["parent"])
            if parent_id:
                for node in nodes:
                    if node["id"] == nid:
                        node["parent_id"] = parent_id
                    if node["id"] == parent_id:
                        node["children_ids"].append(nid)

    root_key = root_marker.get("key") or root_marker.get("label") if root_marker else None
    root_node_id = id_map.get(root_key) if root_key else None
    return {
        "id": new_id(),
        "name": name,
        "source": source,
        "root_node_id": root_node_id,
        "nodes": nodes,
        "links": links,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "pending": True,  # 待确认态
    }


def parse_outline(
    outline_text: str,
    name: str = "大纲剧情树",
    llm_fn: Optional[Callable[..., Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """基于小说大纲生成剧情树（待确认态）。

    outline_text: 大纲文本（章节/情节概要）。
    llm_fn: LLM 调用封装，签名 llm_fn(prompt) -> {nodes, links}。缺省 _default_llm。

    校验：大纲过短（< 20 字）拒绝生成（对齐需求澄清 §五）。
    """
    if not outline_text or len(outline_text.strip()) < 20:
        raise bad_request("大纲内容过短，请补充后再生成（至少 20 字）")
    fn = llm_fn or _default_llm
    prompt = (
        "请把以下小说大纲解析为剧情树结构。只输出 JSON，格式：\n"
        """{"nodes": [{"key":"n1","label":"节点标题","type":"start|main|branch|turn|climax|end","""
        """ "content":"摘要","parent":"父key或null"}], """
        """ "links": [{"from":"n1","to":"n2","type":"前置|后置|非线性","note":"可选"}]}\n"""
        "大纲内容：\n" + outline_text
    )
    result = fn(prompt)
    if not isinstance(result, dict) or "nodes" not in result:
        raise conflict("大纲解析失败，请重试")
    return _build_tree(name, "outline", result.get("nodes", []), result.get("links", []))


def parse_novel(
    novel_structured: str,
    name: str = "小说剧情树",
    llm_fn: Optional[Callable[..., Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """基于现有小说拆文生成剧情树（待确认态）。

    novel_structured: 小说拆文文本（结构化）。
    llm_fn: LLM 调用封装。
    """
    if not novel_structured or len(novel_structured.strip()) < 20:
        raise bad_request("小说文本过短，请补充后再生成（至少 20 字）")
    fn = llm_fn or _default_llm
    prompt = (
        "请把以下小说拆文解析为剧情树结构，识别剧情节点（按章节/情节段落）及逻辑关系。"
        "只输出 JSON，格式：\n"
        """{"nodes": [{"key":"n1","label":"节点标题","type":"start|main|branch|turn|climax|end","""
        """ "content":"摘要","parent":"父key或null"}], """
        """ "links": [{"from":"n1","to":"n2","type":"前置|后置|非线性","note":"可选"}]}\n"""
        "小说文本：\n" + novel_structured
    )
    result = fn(prompt)
    if not isinstance(result, dict) or "nodes" not in result:
        raise conflict("小说解析失败，请重试")
    return _build_tree(name, "novel", result.get("nodes", []), result.get("links", []))
