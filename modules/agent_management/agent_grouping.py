# -*- coding: utf-8 -*-
"""虚拟分组树：自动规则 + 覆盖层合并。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def build_tree(project: Dict[str, Any], agents: List[Dict[str, Any]],
               overrides: Dict[str, Any],
               role_names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """构建「作品 → 角色/工具/11步/手工」多级分组树。"""
    role_names = role_names or {}
    project_id = project.get("id", "")
    project_key = f"project:{project_id}"
    overrides_by_key = {o.get("key"): o for o in overrides.get("overrides", [])}
    hidden = {k for k, o in overrides_by_key.items() if o.get("hidden")}

    def make_node(key: str, name: str, kind: str, parent_key: Optional[str],
                  sort_order: int = 0) -> Dict[str, Any]:
        """创建分组节点并合并覆盖层的名称与排序。"""
        override = overrides_by_key.get(key) or {}
        return {
            "key": key,
            "name": override.get("name") or name,
            "kind": kind,
            "parent_key": parent_key,
            "sort_order": override.get("sort_order", sort_order),
            "count": 0,
            "children": [],
            "agents": [],
        }

    def summary(agent: Dict[str, Any]) -> Dict[str, Any]:
        """裁剪 Agent 为分组树使用的摘要字段。"""
        return {k: agent.get(k) for k in
                ("id", "name", "kind", "status", "is_default", "step_order",
                 "tool_name", "platform", "role_id")}

    root = make_node(project_key, f"作品：{project.get('title', '')}", "project", None)
    flow_node = make_node("flow_group", "默认11步流程", "flow_group", project_key, 1)
    tool_node = make_node("tool_group", "小说工具", "tool_group", project_key, 2)
    role_nodes: Dict[str, Dict[str, Any]] = {}
    tool_nodes: Dict[str, Dict[str, Any]] = {}
    manual_nodes = {}
    for group in overrides.get("manual_groups", []):
        node = make_node(group["id"], group.get("name", "自定义分组"), "manual",
                         group.get("parent_key") or project_key, group.get("sort_order", 9))
        manual_nodes[group["id"]] = node

    for agent in agents:
        if agent.get("status") == "archived":
            continue
        kind = agent.get("kind")
        manual_key = agent.get("manual_group_key")
        target = None
        if manual_key and manual_key in manual_nodes:
            target = manual_nodes[manual_key]
        elif kind == "flow_step_agent":
            target = flow_node
        elif kind == "role_agent":
            role_id = agent.get("role_id") or ""
            key = f"role:{project_id}:{role_id}"
            if key in hidden:
                continue
            target = role_nodes.get(key)
            if target is None:
                target = make_node(key, f"角色：{role_names.get(role_id, role_id)}",
                                   "role", project_key, 0)
                role_nodes[key] = target
        elif kind == "tool_agent":
            tool_name = agent.get("tool_name") or ""
            key = f"tool:{project_id}:{tool_name}"
            if key in hidden:
                continue
            target = tool_nodes.get(key)
            if target is None:
                target = make_node(key, tool_name, "tool", tool_node["key"], 0)
                tool_nodes[key] = target
        if target is not None:
            target["agents"].append(summary(agent))
            target["count"] += 1

    def attach(parent: Dict[str, Any], children: List[Dict[str, Any]]) -> None:
        """按排序值把子节点挂到父节点，跳过已隐藏节点。"""
        for child in sorted(children, key=lambda n: (n.get("sort_order", 0), n.get("name", ""))):
            if child["key"] in hidden:
                continue
            parent["children"].append(child)
            parent["count"] += child["count"]

    attach(flow_node, [])
    if not flow_node["agents"]:
        flow_node["children"] = []
    attach(tool_node, list(tool_nodes.values()))
    for manual in manual_nodes.values():
        if manual["parent_key"] == project_key:
            parent = root
        else:
            parent = manual_nodes.get(manual["parent_key"], root)
        parent["children"].append(manual)
        parent["count"] += manual["count"]
    root_children = [flow_node, tool_node] + list(role_nodes.values())
    attach(root, root_children)
    return root
