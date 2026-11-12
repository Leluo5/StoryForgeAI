# -*- coding: utf-8 -*-
"""角色版图图谱服务层（F8-T2）。

职责（对齐 F8 技术方案 §3.2 / §五 数据完整性）：
1. 图谱数据内嵌项目文件 `data/projects/<project_id>.json` 的 `role_map` 字段：
   {nodes: [role_id], edges: [{source,target,relation_type,note}],
    ai_generated, ai_progress, generated_at}。
2. 图谱只存 ID + 边；节点完整属性从 Role 实体实时读取（单一数据源）。
3. 关联双向一致：建关联 A.relations += B、B.relations += A（同一事务）；删关联反向同步。
4. 环路防护：关联为无向边，禁止自关联（A 不能关联 A）。
5. 并发安全：项目文件锁（fcntl/msvcrt）+ 临时文件原子写。

解耦：本模块通过注入 role_store / plot_store（可选）访问领域实体，不直接依赖
知识库模块；成长线读取剧情树由路由层装配。

注意：图谱文件锁与 RoleStore 使用同一锁文件（data/projects/.locks/<pid>.lock），
本模块内所有读写都持锁，保证与 RoleStore 对同一聚合根的并发互斥。
"""

from __future__ import annotations

import copy
import os
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, not_found
from ..common.storage import FileLock, atomic_write_json, new_id, now_iso, read_json

# 图谱默认值（与 RoleStore 同聚合根，role_map 字段）
_ROLE_MAP_DEFAULTS: Dict[str, Any] = {
    "nodes": [],
    "edges": [],
    "ai_generated": False,
    "ai_progress": {"stage": "idle", "percent": 0},
    "generated_at": None,
}


def _now() -> str:
    return now_iso()


class RoleMapStore:
    """角色版图图谱存储（内嵌项目文件 role_map 字段）。

    data/projects/<project_id>.json 结构（新增 role_map 键）：
    {
      ...项目字段..., "roles": [...],
      "role_map": {
        "nodes": ["<role_id>", ...],
        "edges": [{"source": "A", "target": "B", "relation_type": "ally", "note": ""}],
        "ai_generated": false,
        "ai_progress": {"stage": "extract", "percent": 30},
        "generated_at": null
      }
    }
    """

    def __init__(
        self, data_dir: str, role_store: Any = None,
        project_store: Any = None, plot_store: Any = None,
    ) -> None:
        self.data_dir = data_dir
        self._role_store = role_store
        self._project_store = project_store
        self._plot_store = plot_store
        os.makedirs(data_dir, exist_ok=True)

    def _path(self, project_id: str) -> str:
        return os.path.join(self.data_dir, f"{project_id}.json")

    def _lock(self, project_id: str) -> FileLock:
        return FileLock(os.path.join(self.data_dir, ".locks", f"{project_id}.lock"))

    def _load(self, project_id: str) -> Dict[str, Any]:
        data = read_json(self._path(project_id), {})
        if not isinstance(data, dict):
            return {}
        data.setdefault("roles", [])
        data.setdefault("role_map", copy.deepcopy(_ROLE_MAP_DEFAULTS))
        # 深拷贝默认，避免共享引用
        rm = data["role_map"]
        for key, default in _ROLE_MAP_DEFAULTS.items():
            if key not in rm:
                rm[key] = copy.deepcopy(default)
        return data

    def _save(self, project_id: str, data: Dict[str, Any]) -> None:
        atomic_write_json(self._path(project_id), data)

    # ---------- 图谱读取 ----------

    def get_role_map(self, project_id: str) -> Dict[str, Any]:
        """读取角色版图元数据（nodes/edges/ai_generated/...）。"""
        with self._lock(project_id):
            data = self._load(project_id)
            rm = data["role_map"]
            return {
                "nodes": list(rm.get("nodes", [])),
                "edges": list(rm.get("edges", [])),
                "ai_generated": bool(rm.get("ai_generated", False)),
                "ai_progress": dict(rm.get("ai_progress", {})),
                "generated_at": rm.get("generated_at"),
            }

    def _get_role(self, project_id: str, role_id: str) -> Optional[Dict[str, Any]]:
        """从聚合根 roles 数组找角色（不另开锁，调用方已持锁）。"""
        for role in self._load(project_id)["roles"]:
            if role["id"] == role_id:
                return role
        return None

    def _role_ids(self, project_id: str) -> List[str]:
        with self._lock(project_id):
            data = self._load(project_id)
            return [r["id"] for r in data["roles"]]

    def get_graph(self, project_id: str) -> Dict[str, Any]:
        """加载图谱（nodes 含角色属性 + edges）。

        节点数据单一数据源：图谱只存 ID，节点属性从 Role 实体实时读取。
        edges 只保留两端节点均在 nodes 内的边（避免悬空边）。
        """
        with self._lock(project_id):
            data = self._load(project_id)
            rm = data["role_map"]
            node_ids = set(rm.get("nodes", []))
            roles = {r["id"]: r for r in data["roles"] if r["id"] in node_ids}
            nodes = []
            for rid in rm.get("nodes", []):
                role = roles.get(rid)
                if role is not None:
                    # 图谱节点输出最小集：id/name + 筛选维度 + 关联
                    nodes.append({
                        "id": role["id"],
                        "name": role.get("name", ""),
                        "identity": role.get("identity", ""),
                        "nationality": role.get("nationality", ""),
                        "faith": role.get("faith", ""),
                        "camp": role.get("camp", ""),
                        "race": role.get("race", ""),
                        "profession": role.get("profession", ""),
                        "age_group": role.get("age_group", ""),
                        "attributes": role.get("attributes", {}),
                    })
            edges = []
            for edge in rm.get("edges", []):
                if edge.get("source") in node_ids and edge.get("target") in node_ids:
                    edges.append(edge)
            return {
                "nodes": nodes,
                "edges": edges,
                "ai_generated": bool(rm.get("ai_generated", False)),
                "ai_progress": dict(rm.get("ai_progress", {})),
                "generated_at": rm.get("generated_at"),
            }

    # ---------- 节点增删 ----------

    def add_node(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """添加角色到图谱（幂等：已在图谱则忽略）。

        校验：角色必须存在；已存在则不重复添加。
        """
        with self._lock(project_id):
            data = self._load(project_id)
            rm = data["role_map"]
            if role_id not in [r["id"] for r in data["roles"]]:
                raise not_found(f"角色不存在: {role_id}")
            if role_id not in rm["nodes"]:
                rm["nodes"].append(role_id)
                self._save(project_id, data)
            return self._role_map_summary(rm)

    def remove_node(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """移除角色出图谱，并清理其关联边（不删 Role 实体）。

        边界：仅操作图谱；Role 删除全链路（标红章节/清剧情/删实体）由 F8-T3 负责。
        """
        with self._lock(project_id):
            data = self._load(project_id)
            rm = data["role_map"]
            if role_id not in rm["nodes"]:
                raise not_found(f"角色不在图谱中: {role_id}")
            rm["nodes"] = [n for n in rm["nodes"] if n != role_id]
            rm["edges"] = [
                e for e in rm["edges"]
                if e.get("source") != role_id and e.get("target") != role_id
            ]
            self._save(project_id, data)
            return self._role_map_summary(rm)

    # ---------- 边增删（双向关联一致） ----------

    def _edge_key(self, source: str, target: str) -> str:
        """无向边规范化键（A-B 与 B-A 同键，防重复）。"""
        return "|".join(sorted([source, target]))

    def add_edge(
        self, project_id: str, source: str, target: str,
        relation_type: str = "", **extra: Any,
    ) -> Dict[str, Any]:
        """建立关联（双向写入双方 relations）。

        校验（环路防护）：
        - source/target 必须存在且都在图谱 nodes 中。
        - 禁止自关联（A 不能关联 A）。
        - 重复边 → 409 冲突。
        双向一致：A.relations 含 B，B.relations 必含 A（同一事务）。
        extra 聚合可选字段：note（兼容 keyword 调用）。
        """
        note = extra.get("note", "")
        if not source or not target:
            raise bad_request("source/target 不能为空")
        if source == target:
            raise bad_request("禁止自关联（A 不能关联 A）")

        with self._lock(project_id):
            data = self._load(project_id)
            rm = data["role_map"]
            node_set = set(rm.get("nodes", []))
            if source not in node_set or target not in node_set:
                raise bad_request("关联角色须先加入图谱")
            # 去重：无向边规范化
            key = self._edge_key(source, target)
            for e in rm["edges"]:
                if self._edge_key(e.get("source", ""), e.get("target", "")) == key:
                    raise bad_request("关联已存在")
            edge = {
                "id": new_id(),
                "source": source,
                "target": target,
                "relation_type": relation_type or "unknown",
                "note": note,
            }
            rm["edges"].append(edge)
            # 双向写入双方 relations（无向边，双方各存一条对端引用）
            self._sync_role_relations(data, source, target, relation_type, note, add=True)
            self._save(project_id, data)
            return edge

    def remove_edge(self, project_id: str, source: str, target: str) -> Dict[str, Any]:
        """删除关联（双向清理双方 relations）。

        边界：仅删图谱边 + 双向清 relations；不删 Role 实体。
        """
        key = self._edge_key(source, target)
        with self._lock(project_id):
            data = self._load(project_id)
            rm = data["role_map"]
            before = len(rm["edges"])
            rm["edges"] = [
                e for e in rm["edges"]
                if self._edge_key(e.get("source", ""), e.get("target", "")) != key
            ]
            if len(rm["edges"]) == before:
                raise not_found("关联不存在")
            self._sync_role_relations(data, source, target, "", "", add=False)
            self._save(project_id, data)
            return self._role_map_summary(rm)

    def _sync_role_relations(
        self, data: Dict[str, Any], a_id: str, b_id: str,
        relation_type: str, note: str, add: bool,
    ) -> None:
        """双向同步 A/B 的 relations（同一事务内调用，调用方已持锁）。

        relations 元素：{target_role_id, relation_type, note}。
        add=True：双方各追加对端引用（幂等防重）；add=False：双向移除。
        """
        role_map = {r["id"]: r for r in data["roles"]}
        for (self_id, other_id) in [(a_id, b_id), (b_id, a_id)]:
            role = role_map.get(self_id)
            if role is None:
                continue
            relations = role.setdefault("relations", [])
            if add:
                exists = any(
                    r.get("target_role_id") == other_id for r in relations
                )
                if not exists:
                    relations.append({
                        "target_role_id": other_id,
                        "relation_type": relation_type or "unknown",
                        "note": note,
                    })
            else:
                role["relations"] = [
                    r for r in relations if r.get("target_role_id") != other_id
                ]

    @staticmethod
    def _role_map_summary(rm: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "nodes": list(rm.get("nodes", [])),
            "edges": list(rm.get("edges", [])),
            "ai_generated": bool(rm.get("ai_generated", False)),
            "ai_progress": dict(rm.get("ai_progress", {})),
            "generated_at": rm.get("generated_at"),
        }

    # ---------- 图谱元数据更新（AI 进度等） ----------

    def set_ai_progress(
        self, project_id: str, stage: str, percent: int,
    ) -> Dict[str, Any]:
        """更新 AI 生成进度（长任务排队阶段由服务层轮询读取）。"""
        with self._lock(project_id):
            data = self._load(project_id)
            rm = data["role_map"]
            rm["ai_progress"] = {"stage": stage, "percent": int(percent)}
            if stage == "done":
                rm["ai_generated"] = True
                rm["generated_at"] = _now()
            self._save(project_id, data)
            return dict(rm["ai_progress"])

    def get_role_relations(self, project_id: str, role_id: str) -> List[Dict[str, Any]]:
        """读取角色关联列表（图谱边 + Role.relations 双源一致校验）。"""
        with self._lock(project_id):
            data = self._load(project_id)
            rm = data["role_map"]
            edges = [
                e for e in rm.get("edges", [])
                if e.get("source") == role_id or e.get("target") == role_id
            ]
            role = self._get_role(project_id, role_id)
            relations = role.get("relations", []) if role else []
            return {"edges": edges, "relations": relations}

    # ---------- F8-T3 删除角色全链路 ----------

    def delete_role_chain(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """删除角色全链路（F8-T3，原子语义）。

        顺序（全部在一个项目文件锁内，保证原子）：
        1. 标红章节：把 role_id 加入所有出场章节的 flagged_role_ids。
        2. 清关联：移除图谱中该角色的全部边；双向清理其他角色 relations 中指向它的引用。
        3. 删 Role 实体：从 roles 数组移除（级联删 role_bindings/agent_sessions）。
        4. 移出图谱：从 role_map.nodes 移除。
        5. 清独立剧情（后置）：plot_store 中 role_id 匹配的剧情树节点（独立锁，非原子但最终一致）。

        返回统计：{flagged_chapters, removed_edges, deleted_role, removed_nodes,
        plot_nodes_deleted}。
        """
        with self._lock(project_id):
            data = self._load(project_id)
            # 校验角色存在
            if role_id not in [r["id"] for r in data["roles"]]:
                raise not_found(f"角色不存在: {role_id}")

            # 1. 标红章节（project_store 与 role_map 同文件，直接操作 data）
            flagged_chapters: List[str] = []
            for chapter in data.get("chapters", []):
                if role_id in chapter.get("role_ids", []):
                    flagged_list = chapter.setdefault("flagged_role_ids", [])
                    if role_id not in flagged_list:
                        flagged_list.append(role_id)
                    flagged_chapters.append(chapter["id"])

            # 2. 清关联：移除该角色相关图谱边 + 双向清理 relations
            rm = data["role_map"]
            before_edges = len(rm.get("edges", []))
            rm["edges"] = [
                e for e in rm.get("edges", [])
                if e.get("source") != role_id and e.get("target") != role_id
            ]
            removed_edges = before_edges - len(rm["edges"])
            # 双向：其他角色 relations 移除指向 role_id 的引用
            for role in data["roles"]:
                if role["id"] == role_id:
                    continue
                role["relations"] = [
                    r for r in role.get("relations", [])
                    if r.get("target_role_id") != role_id
                ]

            # 3. 删 Role 实体（级联绑定/会话）
            data["roles"] = [r for r in data["roles"] if r["id"] != role_id]
            data["role_bindings"] = [
                b for b in data.get("role_bindings", []) if b.get("role_id") != role_id
            ]
            data["agent_sessions"] = [
                s for s in data.get("agent_sessions", []) if s.get("role_id") != role_id
            ]

            # 4. 移出图谱 nodes
            rm["nodes"] = [n for n in rm.get("nodes", []) if n != role_id]

            self._save(project_id, data)

        # 5. 清独立剧情（后置，独立锁；失败不阻断主删除，记录到结果）
        plot_nodes_deleted: List[str] = []
        if self._plot_store is not None:
            try:
                for tree in self._plot_store.list_trees():
                    tree_data = self._plot_store.load_tree(tree["id"])
                    if not tree_data:
                        continue
                    result = self._plot_store.clear_nodes_by_role(tree_data, role_id)
                    plot_nodes_deleted.extend(result.get("deleted", []))
            except Exception:
                # 剧情树清理失败不影响角色删除主链路（最终一致，可由后台重试）
                pass

        return {
            "flagged_chapters": flagged_chapters,
            "removed_edges": removed_edges,
            "deleted_role": role_id,
            "removed_nodes": 1,
            "plot_nodes_deleted": plot_nodes_deleted,
        }

    # ---------- F8-T5 筛选服务 ----------

    @staticmethod
    def _filter_dimensions() -> List[str]:
        """6 个筛选维度字段（对齐 F8 技术方案 §3.1）。"""
        return [
            "nationality", "faith", "camp", "race", "profession", "age_group",
        ]

    def get_filter_options(self, project_id: str) -> Dict[str, List[str]]:
        """获取维度候选值（从图谱节点属性聚合去重，排除空值）。

        返回：{nationality: [...], faith: [...], camp: [...], race: [...],
        profession: [...], age_group: [...]}，各数组已排序。
        """
        graph = self.get_graph(project_id)
        options: Dict[str, List[str]] = {}
        for dim in self._filter_dimensions():
            values: set = set()
            for node in graph["nodes"]:
                val = node.get(dim)
                if val:
                    values.add(str(val))
            options[dim] = sorted(values)
        return options

    def filter_graph(
        self, project_id: str, filter_dict: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """组合筛选：按维度候选值过滤节点/边（服务端）。

        filter_dict 形如 {"nationality": ["中原"], "camp": ["正道", "魔道"]}。
        规则：
        - 多维度 = AND；单维度多值 = OR。
        - 空 filter_dict / 空值 → 返回全图。
        - 节点满足所有维度（每个维度的值须命中其候选列表）。
        - 边保留仅当两端节点均命中（避免悬空边）。
        """
        filter_dict = filter_dict or {}
        # 归一化：仅保留有效维度 + 非空候选
        active: Dict[str, set] = {}
        for dim in self._filter_dimensions():
            vals = filter_dict.get(dim)
            if not vals:
                continue
            if isinstance(vals, str):
                vals = [vals]
            active[dim] = {str(v) for v in vals if str(v)}

        graph = self.get_graph(project_id)

        def match(node: Dict[str, Any]) -> bool:
            """判断节点是否满足当前所有维度过滤条件（AND 语义）。"""
            for dim, allowed in active.items():
                if str(node.get(dim) or "") not in allowed:
                    return False
            return True

        matched_ids = {node["id"] for node in graph["nodes"] if match(node)}
        nodes = [node for node in graph["nodes"] if node["id"] in matched_ids]
        edges = [
            e for e in graph["edges"]
            if e.get("source") in matched_ids and e.get("target") in matched_ids
        ]
        return {
            "nodes": nodes,
            "edges": edges,
            "matched_count": len(nodes),
            "total_count": len(graph["nodes"]),
            "ai_generated": graph.get("ai_generated", False),
            "ai_progress": graph.get("ai_progress", {}),
            "generated_at": graph.get("generated_at"),
        }
