# -*- coding: utf-8 -*-
"""剧情树数据引擎（F7-T1/T3/T4/T5）。

对齐 F7 技术方案 §2（数据模型）/ §4.2（树操作）/ §4.4（双向联动）/ §4.5（导入导出）。

职责边界：
- 数据模型：plot_tree / plot_node / plot_link 结构定义与校验。
- 持久化：data/plot/<tree_id>.json 单文件，文件锁 + 原子写（复用 modules.common.storage）。
- 树操作：add_node / edit_node / delete_node（级联）/ add_link（自环校验）。
- 双向联动：push_to_room（树→推衍上下文）/ pull_from_room（推衍回写新节点，id 去重）。
- 导入导出：export（全量/单节点子链）/ import（结构校验合并/覆盖）。

边界：本模块不 import 知识库/聊天室内部符号；联动所需上下文经 DTO 注入（对齐
开发规范 §3.6「纯函数 + 依赖注入」）。
"""

from __future__ import annotations

import os
import threading
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, conflict, not_found
from ..common.storage import FileLock, atomic_write_json, new_id, now_iso, read_json

# 进程内树级事务锁表（按 tree_id 粒度共享 RLock）。
# 背景（P5-T4 发现）：pull_from_room 是「读-改-写」快照模式——load_tree（锁外）
# 读独立快照 → 改快照 → save_tree（锁内原子写）。锁只保护写一瞬间，不保护整个
# 读-改-写事务，多线程各自读独立快照互相覆盖（50 并发只留最后写入者）。
# 用按 tree_id 的 RLock 作为进程内事务锁，保证同一树的读-改-写全程串行；
# 跨进程仍靠 FileLock（save_tree 内）兜底。
_tree_txn_locks: Dict[str, threading.RLock] = {}
_tree_txn_guard = threading.Lock()


def _tree_txn_lock(tree_id: str) -> threading.RLock:
    """获取按 tree_id 共享的进程内事务锁（可重入）。"""
    with _tree_txn_guard:
        lock = _tree_txn_locks.get(tree_id)
        if lock is None:
            lock = threading.RLock()
            _tree_txn_locks[tree_id] = lock
        return lock

# 节点类型白名单（对齐 F7 技术方案 §2.2）
VALID_NODE_TYPES = ("start", "main", "branch", "turn", "climax", "end")
# 节点来源白名单
VALID_NODE_SOURCES = ("manual", "generated", "outline_sync", "derivation")
# 关联类型白名单（对齐 F7 技术方案 §2.3）
VALID_LINK_TYPES = ("前置", "后置", "非线性")
# 剧情树来源白名单（对齐需求澄清 §6.1）
VALID_TREE_SOURCES = ("outline", "novel", "manual")

# 默认节点位置（拖拽前初始坐标）
_DEFAULT_POSITION = {"x": 120, "y": 200}

# 各类白名单的 "/" 连接展示文本（避免 f-string 内嵌单引号）
_JOINED_TREE_SOURCES = "/".join(VALID_TREE_SOURCES)
_JOINED_NODE_TYPES = "/".join(VALID_NODE_TYPES)
_JOINED_NODE_SOURCES = "/".join(VALID_NODE_SOURCES)
_JOINED_LINK_TYPES = "/".join(VALID_LINK_TYPES)


def _now() -> str:
    return now_iso()


def _default_node(label: str, node_type: str = "main", **overrides: Any) -> Dict[str, Any]:
    """构造默认 plot_node 结构（对齐技术方案 §2.2）。

    overrides 允许调用方覆盖任意字段（如 content / position / source / tags）。
    """
    node: Dict[str, Any] = {
        "id": new_id(),
        "label": label,
        "type": node_type,
        "content": "",
        "parent_id": None,
        "children_ids": [],
        "source": "manual",
        "linked_room_id": None,
        "position": dict(_DEFAULT_POSITION),
        "tags": [],
        "role_id": None,  # F8：关联角色（成长线过滤 / 删除角色清独立剧情）
    }
    node.update(overrides)
    return node


class PlotTreeStore:
    """剧情树存储（单树一文件：data/plot/<tree_id>.json）。

    结构（对齐技术方案 §2.1）：
    {
      "id": tree_id, "name": "...", "source": "outline|novel|manual",
      "root_node_id": null, "nodes": [plot_node...], "links": [plot_link...],
      "created_at": "...", "updated_at": "..."
    }
    """

    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)

    def _path(self, tree_id: str) -> str:
        return os.path.join(self.data_dir, f"{tree_id}.json")

    def _lock(self, tree_id: str) -> FileLock:
        return FileLock(os.path.join(self.data_dir, ".locks", f"{tree_id}.lock"))

    # ---- 基础 CRUD（F7-T1）----

    def create_tree(self, name: str, source: str = "manual") -> Dict[str, Any]:
        """创建剧情树。source ∈ VALID_TREE_SOURCES。返回完整 plot_tree。"""
        if not name or not name.strip():
            raise bad_request("剧情树标题不能为空")
        if source not in VALID_TREE_SOURCES:
            raise bad_request(f"剧情树来源非法，允许：{_JOINED_TREE_SOURCES}")
        tree_id = new_id()
        tree: Dict[str, Any] = {
            "id": tree_id,
            "name": name.strip(),
            "source": source,
            "root_node_id": None,
            "nodes": [],
            "links": [],
            "created_at": _now(),
            "updated_at": _now(),
        }
        self.save_tree(tree)
        return tree

    def load_tree(self, tree_id: str) -> Dict[str, Any]:
        """按 id 读取剧情树；不存在抛 404。"""
        data = read_json(self._path(tree_id), None)
        if data is None or not isinstance(data, dict):
            raise not_found("剧情树不存在")
        data.setdefault("nodes", [])
        data.setdefault("links", [])
        return data

    def save_tree(self, tree: Dict[str, Any]) -> None:
        """保存剧情树（更新 updated_at，原子写）。"""
        tree["updated_at"] = _now()
        with self._lock(tree["id"]):
            atomic_write_json(self._path(tree["id"]), tree)

    def delete_tree(self, tree_id: str) -> bool:
        """删除剧情树；不存在返回 False。"""
        with self._lock(tree_id):
            try:
                os.unlink(self._path(tree_id))
                return True
            except FileNotFoundError:
                return False

    def list_trees(self) -> List[Dict[str, Any]]:
        """剧情树列表（轻量：不含 nodes 全量，含计数）。"""
        result: List[Dict[str, Any]] = []
        if not os.path.isdir(self.data_dir):
            return result
        for name in os.listdir(self.data_dir):
            if not name.endswith(".json"):
                continue
            tree_id = name[: -len(".json")]
            tree = read_json(self._path(tree_id), None)
            if not isinstance(tree, dict):
                continue
            result.append({
                "id": tree.get("id", tree_id),
                "name": tree.get("name", ""),
                "source": tree.get("source", "manual"),
                "nodes_count": len(tree.get("nodes", [])),
                "links_count": len(tree.get("links", [])),
                "updated_at": tree.get("updated_at", ""),
            })
        result.sort(key=lambda t: t.get("updated_at", ""), reverse=True)
        return result

    # ---- 节点定位辅助 ----

    def get_node(self, tree: Dict[str, Any], node_id: str) -> Dict[str, Any]:
        """按 id 取节点；不存在抛 404。"""
        for node in tree.get("nodes", []):
            if node.get("id") == node_id:
                return node
        raise not_found("剧情节点不存在")

    # ---- 树操作（F7-T3）----

    def add_node(
        self,
        tree: Dict[str, Any],
        label: str,
        node_type: str = "main",
        **extra: Any,
    ) -> Dict[str, Any]:
        """新增节点。parent_id 存在则挂到其 children_ids；首节点自动设 root_node_id。

        extra 聚合可选字段：content/parent_id/source/tags/position/role_id。
        """
        content = extra.get("content", "")
        parent_id = extra.get("parent_id")
        source = extra.get("source", "manual")
        tags = extra.get("tags")
        position = extra.get("position")
        role_id = extra.get("role_id")
        if not label or not label.strip():
            raise bad_request("节点标题不能为空")
        if node_type not in VALID_NODE_TYPES:
            raise bad_request(f"节点类型非法，允许：{_JOINED_NODE_TYPES}")
        if source not in VALID_NODE_SOURCES:
            raise bad_request(f"节点来源非法，允许：{_JOINED_NODE_SOURCES}")
        if parent_id is not None:
            # 校验父节点存在
            self.get_node(tree, parent_id)

        node = _default_node(
            label.strip(),
            node_type,
            content=content or "",
            source=source,
            tags=list(tags or []),
            position=position or dict(_DEFAULT_POSITION),
            parent_id=parent_id,
            role_id=role_id,
        )
        tree.setdefault("nodes", []).append(node)

        if parent_id is not None:
            parent = self.get_node(tree, parent_id)
            parent.setdefault("children_ids", []).append(node["id"])
        if tree.get("root_node_id") is None:
            tree["root_node_id"] = node["id"]

        self.save_tree(tree)
        return node

    def edit_node(
        self, tree: Dict[str, Any], node_id: str, patch: Dict[str, Any]
    ) -> Dict[str, Any]:
        """编辑节点。patch 任意子集：label/content/type/tags/position。

        仅允许修改白名单字段；parent_id/children_ids/linked_room_id 不可直接改。
        """
        node = self.get_node(tree, node_id)
        allowed = {"label", "content", "type", "tags", "position", "role_id"}
        for key in ("label", "content", "type", "tags", "position", "role_id"):
            if key in patch:
                if key == "label" and (not patch[key] or not str(patch[key]).strip()):
                    raise bad_request("节点标题不能为空")
                if key == "type" and patch[key] not in VALID_NODE_TYPES:
                    raise bad_request(f"节点类型非法，允许：{_JOINED_NODE_TYPES}")
                if key == "tags" and not isinstance(patch[key], list):
                    raise bad_request("节点标签须为数组")
                node[key] = patch[key]
        self.save_tree(tree)
        return node

    def delete_node(self, tree: Dict[str, Any], node_id: str) -> Dict[str, Any]:
        """删除节点并级联删除其所有子节点与相关关联。返回被删节点 id 集。"""
        # 先构建后代集合（含自身），保证级联
        to_delete = self._collect_descendants(tree, node_id)
        # 清理 links：任一端点在被删集合内即删除
        tree["links"] = [
            link for link in tree.get("links", [])
            if link.get("from") not in to_delete and link.get("to") not in to_delete
        ]
        # 清理节点与 children_ids 引用
        kept_nodes: List[Dict[str, Any]] = []
        for node in tree.get("nodes", []):
            if node["id"] in to_delete:
                continue
            node["children_ids"] = [
                cid for cid in node.get("children_ids", []) if cid not in to_delete
            ]
            kept_nodes.append(node)
        tree["nodes"] = kept_nodes
        # 若根节点被删，重设 root_node_id 为剩余首节点
        if tree.get("root_node_id") in to_delete:
            tree["root_node_id"] = tree["nodes"][0]["id"] if tree["nodes"] else None
        self.save_tree(tree)
        return {"deleted": sorted(to_delete)}

    def clear_nodes_by_role(self, tree: Dict[str, Any], role_id: str) -> Dict[str, Any]:
        """清独立剧情：删除全部关联指定角色的节点（F8-T3 删除角色联动）。

        语义：仅删除 role_id 匹配的「独立剧情」节点；父节点引用与 links 同步清理，
        与 delete_node 同规则（级联后代，但这里按 role_id 批量匹配整棵子树）。
        返回被删节点 id 集（供调用方记录）。
        """
        # 收集所有 role_id 匹配的节点作为删除种子
        seeds = [
            node.get("id")
            for node in tree.get("nodes", [])
            if node.get("role_id") == role_id
        ]
        if not seeds:
            return {"deleted": []}
        to_delete: set[str] = set()
        for seed in seeds:
            to_delete |= self._collect_descendants(tree, seed)
        tree["links"] = [
            link for link in tree.get("links", [])
            if link.get("from") not in to_delete and link.get("to") not in to_delete
        ]
        kept_nodes: List[Dict[str, Any]] = []
        for node in tree.get("nodes", []):
            if node["id"] in to_delete:
                continue
            node["children_ids"] = [
                cid for cid in node.get("children_ids", []) if cid not in to_delete
            ]
            kept_nodes.append(node)
        tree["nodes"] = kept_nodes
        if tree.get("root_node_id") in to_delete:
            tree["root_node_id"] = tree["nodes"][0]["id"] if tree["nodes"] else None
        self.save_tree(tree)
        return {"deleted": sorted(to_delete)}

    def _collect_descendants(self, tree: Dict[str, Any], node_id: str) -> set[str]:
        """收集 node_id 及其全部后代节点 id 集合。"""
        if not self._node_exists(tree, node_id):
            raise not_found("剧情节点不存在")
        result: set[str] = set()
        stack = [node_id]
        while stack:
            cur = stack.pop()
            if cur in result:
                continue
            result.add(cur)
            node = self.get_node(tree, cur)
            for child_id in node.get("children_ids", []):
                stack.append(child_id)
        return result

    def _node_exists(self, tree: Dict[str, Any], node_id: str) -> bool:
        return any(node.get("id") == node_id for node in tree.get("nodes", []))

    def add_link(
        self,
        tree: Dict[str, Any],
        from_id: str,
        to_id: str,
        link_type: str = "前置",
        **extra: Any,
    ) -> Dict[str, Any]:
        """建立关联。

        校验：from==to 拒绝（自环）；前置/后置禁止任何环；非线性允许环（跳过/回环）。
        同一对 (from,to,type) 去重。
        extra 聚合可选字段：note。
        """
        note = extra.get("note", "")
        if from_id == to_id:
            raise bad_request("不允许自环关联")
        if link_type not in VALID_LINK_TYPES:
            raise bad_request(f"关联类型非法，允许：{_JOINED_LINK_TYPES}")
        self.get_node(tree, from_id)
        self.get_node(tree, to_id)
        # 同向重复关联去重
        for link in tree.get("links", []):
            if (
                link.get("from") == from_id
                and link.get("to") == to_id
                and link.get("type") == link_type
            ):
                raise conflict("该关联已存在")

        # 前置/后置禁止环路：若已有 from→...→to 的路径，再加 to→from 会成环
        if link_type in ("前置", "后置"):
            if self._would_create_cycle(tree, from_id, to_id):
                raise bad_request("该关联将形成环路，已禁止")

        link: Dict[str, Any] = {
            "from": from_id,
            "to": to_id,
            "type": link_type,
            "note": note or "",
        }
        tree.setdefault("links", []).append(link)
        self.save_tree(tree)
        return link

    def _would_create_cycle(self, tree: Dict[str, Any], from_id: str, to_id: str) -> bool:
        """若已存在 from 可达 to 的路径，则再连 to→from 会成环。

        前置语义：from 在 to 之前（有向边 from→to）。
        判断：to 是否已可达 from（即存在 to→...→from 路径）。若可达则成环。
        """
        visited: set[str] = set()
        stack = [to_id]
        while stack:
            cur = stack.pop()
            if cur == from_id:
                return True
            if cur in visited:
                continue
            visited.add(cur)
            for link in tree.get("links", []):
                if link.get("from") == cur:
                    stack.append(link["to"])
        return False

    def delete_link(self, tree: Dict[str, Any], from_id: str, to_id: str, link_type: str) -> bool:
        """删除指定关联。返回是否删除成功。"""
        before = len(tree.get("links", []))
        tree["links"] = [
            link for link in tree.get("links", [])
            if not (
                link.get("from") == from_id
                and link.get("to") == to_id
                and link.get("type") == link_type
            )
        ]
        changed = len(tree["links"]) != before
        if changed:
            self.save_tree(tree)
        return changed

    # ---- 布局保存（F7-T3 扩展 / 技术方案 §3.8）----

    def save_layout(self, tree: Dict[str, Any], positions: List[Dict[str, Any]]) -> int:
        """保存节点坐标。positions: [{id, position:{x,y}}]。返回更新节点数。"""
        count = 0
        for item in positions:
            node_id = item.get("id")
            pos = item.get("position")
            if not node_id or not isinstance(pos, dict):
                continue
            node = self.get_node(tree, node_id)
            node["position"] = {
                "x": int(pos.get("x", node["position"]["x"])),
                "y": int(pos.get("y", node["position"]["y"])),
            }
            count += 1
        if count:
            self.save_tree(tree)
        return count

    # ---- 双向联动（F7-T4）----

    def push_to_room(
        self,
        tree: Dict[str, Any],
        room_id: str,
        context_node_ids: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """把剧情树节点作为推衍上下文推给聊天室（F6）。

        context_node_ids 缺省取根节点 + 其直接子节点（前置/分支上下文）。
        本方法只负责「挑选上下文节点并返回」，实际注入由路由层协调 story_thread。
        返回 {context_nodes: [...], injected: n}。
        """
        if not room_id:
            raise bad_request("聊天室 id 不能为空")
        nodes = tree.get("nodes", [])
        if not nodes:
            raise conflict("剧情树为空，无法推送上下文")

        if context_node_ids:
            context = [self.get_node(tree, nid) for nid in context_node_ids]
        else:
            # 默认：根节点 + 直接子节点
            root_id = tree.get("root_node_id")
            context = []
            if root_id and self._node_exists(tree, root_id):
                root = self.get_node(tree, root_id)
                context.append(root)
                for child_id in root.get("children_ids", []):
                    context.append(self.get_node(tree, child_id))
            if not context:
                context = [nodes[0]]
        return {"context_nodes": context, "injected": len(context)}

    def pull_from_room(
        self,
        tree: Dict[str, Any],
        room_id: str,
        room_steps: List[Dict[str, Any]],
        parent_node_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """把聊天室推衍结果回写为剧情树新节点（F6 → F7）。

        room_steps: F6 未提交推衍步骤列表，每步含 {label, content, ...}。
        每个步骤生成一个新节点，source=derivation，linked_room_id 标记来源，id 去重。
        新节点挂到 parent_node_id（缺省挂根节点）下。返回 {new_nodes: [...], added: n}。

        并发安全（P5-T4 修复）：本方法为「读-改-写」事务，锁只保护写一瞬间会丢节点。
        故在进程内树级事务锁（按 tree_id 的 RLock）内**重新 load_tree 最新快照**再合并，
        保证同一树的并发回写串行且基于最新数据，不互相覆盖；单线程语义不变（最新=传入快照）。
        """
        if not room_id:
            raise bad_request("聊天室 id 不能为空")
        if not room_steps:
            raise conflict("无待回写的推衍步骤")

        tree_id = tree.get("id")
        if not tree_id:
            raise bad_request("剧情树 id 不能为空")

        with _tree_txn_lock(tree_id):
            # 锁内重读最新快照：多线程并发时拿到最新已提交数据，避免覆盖他人节点
            latest = self.load_tree(tree_id)
            new_nodes = self._merge_room_steps(latest, room_id, room_steps, parent_node_id)
            if new_nodes:
                self.save_tree(latest)
            return {"new_nodes": new_nodes, "added": len(new_nodes)}

    def _merge_room_steps(
        self,
        tree: Dict[str, Any],
        room_id: str,
        room_steps: List[Dict[str, Any]],
        parent_node_id: Optional[str],
    ) -> List[Dict[str, Any]]:
        """在给定 tree 快照上合并推衍步骤为派生节点（去重）。返回新增节点列表。"""
        # 去重：该聊天室已回写的推导节点按「步骤 id」去重（linked_room_id 仅标记来源）
        existing_steps = {
            n.get("source_step_id")
            for n in tree.get("nodes", [])
            if n.get("linked_room_id") == room_id
        }

        new_nodes: List[Dict[str, Any]] = []
        parent_id = parent_node_id
        if parent_id is not None:
            self.get_node(tree, parent_id)  # 校验存在

        for step in room_steps:
            step_id = step.get("id") or step.get("room_step_id")
            if step_id and step_id in existing_steps:
                continue  # 去重合并
            label = step.get("label") or step.get("title") or f"推衍节点{len(new_nodes) + 1}"
            content = step.get("content") or step.get("summary") or ""
            node = _default_node(
                label,
                "branch",
                content=content,
                source="derivation",
                linked_room_id=room_id,
                parent_id=parent_id,
                source_step_id=step_id,
            )
            tree.setdefault("nodes", []).append(node)
            if parent_id is not None:
                parent = self.get_node(tree, parent_id)
                parent.setdefault("children_ids", []).append(node["id"])
            if tree.get("root_node_id") is None:
                tree["root_node_id"] = node["id"]
            new_nodes.append(node)

        return new_nodes

    # ---- 导入导出（F7-T5）----

    def export_tree(
        self,
        tree: Dict[str, Any],
        scope: str = "all",
        node_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """导出剧情树。scope=all 全量；scope=node 单节点及子链。"""
        if scope == "all":
            return {
                "id": tree["id"],
                "name": tree["name"],
                "source": tree["source"],
                "root_node_id": tree.get("root_node_id"),
                "nodes": list(tree.get("nodes", [])),
                "links": list(tree.get("links", [])),
                "created_at": tree.get("created_at"),
                "updated_at": tree.get("updated_at"),
            }
        if scope == "node":
            if not node_id:
                raise bad_request("单节点导出须指定 node_id")
            sub_ids = self._collect_descendants(tree, node_id)
            sub_nodes = [n for n in tree.get("nodes", []) if n["id"] in sub_ids]
            sub_links = [
                l for l in tree.get("links", [])
                if l.get("from") in sub_ids and l.get("to") in sub_ids
            ]
            return {
                "id": tree["id"],
                "name": tree["name"],
                "source": tree["source"],
                "root_node_id": node_id if node_id in sub_ids else None,
                "nodes": sub_nodes,
                "links": sub_links,
                "created_at": tree.get("created_at"),
                "updated_at": tree.get("updated_at"),
                "scope": "node",
                "export_node_id": node_id,
            }
        raise bad_request("导出范围非法，允许：all / node")

    def import_tree(
        self,
        data: Dict[str, Any],
        mode: str = "merge",
        target_tree_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """导入剧情树结构（校验后合并或覆盖）。

        mode=merge：把导入 nodes/links 追加到 target_tree（target_tree_id 必填）。
        mode=replace：用导入数据覆盖 target_tree（target_tree_id 必填）。
        校验失败抛 400，不破坏现有剧情树。
        """
        if mode not in ("merge", "replace"):
            raise bad_request("导入模式非法，允许：merge / replace")
        self._validate_import(data)

        if mode == "replace":
            if not target_tree_id:
                raise bad_request("覆盖模式须指定目标剧情树")
            tree = self.load_tree(target_tree_id)
            # 重新生成节点 id，避免与目标冲突；保留导入结构
            id_map = self._remap_node_ids(data.get("nodes", []))
            tree["nodes"] = [self._remap_node(n, id_map) for n in data.get("nodes", [])]
            tree["links"] = [
                {
                    "from": id_map.get(l.get("from"), l.get("from")),
                    "to": id_map.get(l.get("to"), l.get("to")),
                    "type": l.get("type", "前置"),
                    "note": l.get("note", ""),
                }
                for l in data.get("links", [])
            ]
            tree["root_node_id"] = id_map.get(data.get("root_node_id"))
            tree["source"] = data.get("source", tree.get("source", "manual"))
            self.save_tree(tree)
            return {"tree_id": target_tree_id, "nodes_count": len(tree["nodes"]), "mode": "replace"}

        # merge
        if not target_tree_id:
            raise bad_request("合并模式须指定目标剧情树")
        tree = self.load_tree(target_tree_id)
        id_map = self._remap_node_ids(data.get("nodes", []))
        for n in data.get("nodes", []):
            tree.setdefault("nodes", []).append(self._remap_node(n, id_map))
        for l in data.get("links", []):
            tree.setdefault("links", []).append({
                "from": id_map.get(l.get("from"), l.get("from")),
                "to": id_map.get(l.get("to"), l.get("to")),
                "type": l.get("type", "前置"),
                "note": l.get("note", ""),
            })
        self.save_tree(tree)
        return {"tree_id": target_tree_id, "nodes_count": len(tree["nodes"]), "mode": "merge"}

    def _validate_import(self, data: Dict[str, Any]) -> None:
        """校验导入结构：nodes/links 为合法数组，节点字段合法，关联端点存在。"""
        if not isinstance(data, dict):
            raise bad_request("导入数据须为对象")
        nodes = data.get("nodes", [])
        links = data.get("links", [])
        if not isinstance(nodes, list) or not isinstance(links, list):
            raise bad_request("导入数据结构不合法：nodes/links 须为数组")
        node_ids = set()
        for n in nodes:
            if not isinstance(n, dict) or not n.get("id") or not n.get("label"):
                raise bad_request("导入数据结构不合法：节点缺少 id/label")
            if n.get("type") not in VALID_NODE_TYPES:
                ntype = n.get("type")
                raise bad_request(f"导入节点类型非法：{ntype}")
            node_ids.add(n["id"])
        for l in links:
            if not isinstance(l, dict):
                raise bad_request("导入关联结构不合法")
            if l.get("from") not in node_ids or l.get("to") not in node_ids:
                raise bad_request("导入关联引用了不存在的节点")
            if l.get("type") not in VALID_LINK_TYPES:
                ltype = l.get("type")
                raise bad_request(f"导入关联类型非法：{ltype}")

    @staticmethod
    def _remap_node_ids(nodes: List[Dict[str, Any]]) -> Dict[str, str]:
        """导入节点 id 重映射（防与目标冲突）。"""
        return {n["id"]: new_id() for n in nodes}

    @staticmethod
    def _remap_node(node: Dict[str, Any], id_map: Dict[str, str]) -> Dict[str, Any]:
        """重映射单节点：id 替换、children_ids 重映射、parent_id 重映射。"""
        new_node = dict(node)
        new_node["id"] = id_map.get(node["id"], node["id"])
        new_node["children_ids"] = [id_map.get(c, c) for c in node.get("children_ids", [])]
        if node.get("parent_id"):
            new_node["parent_id"] = id_map.get(node["parent_id"], node["parent_id"])
        new_node.setdefault("position", dict(_DEFAULT_POSITION))
        new_node.setdefault("tags", [])
        return new_node
