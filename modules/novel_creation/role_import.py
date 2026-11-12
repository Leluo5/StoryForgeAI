# -*- coding: utf-8 -*-
"""知识库角色 → 小说创作角色库 同步导入引擎（F5 → P3 跨模块集成）。

职责：
1. 从知识库 novel 条目提取候选角色（characters[] + outline.character_relations[]）。
2. 将知识库角色字段映射为小说创作角色字段（Role 顶层，含新增 personality/background/appearance）。
3. 映射时对无来源/无法关联的字段标注 mapped=False + reason（供前端标红）。
4. 批量导入 + 单条预览；记录导入历史（可回溯）。

设计要点（对齐 F8 角色版图 §3.1 + 用户已确认决策）：
- 源字段：knowledge_parser._prompt_novel 的 characters[]（名字/身份/性格）；
  outline.character_relations[]（a/b/relation/camp）。
- 目标字段：Role 顶层 name/identity/personality + background（关系聚合）+ relations[]。
- appearance 无直接来源 → 标红待补（mapped=False, reason="kb_no_appearance"）。
- relations 若目标角色不在本次导入集合或角色库中 → 标红（mapped=False, reason="target_missing"）。

解耦：本模块不 import 知识库符号，依赖注入 kb_store 访问函数（应用层/路由层装配）。
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from modules.common.errors import AppError, bad_request, not_found
from modules.common.storage import FileLock

# 导入历史文件名（与 role_store 的 projects 数据同目录）
IMPORT_HISTORY_FILE = "role_import_history.json"

# 角色名兜底（知识库 character 缺 name 时）
_FALLBACK_NAME_PREFIX = "知识库角色"


def _coerce_str(value: Any) -> str:
    """任意值 → 去掉首尾空白的字符串。"""
    if value is None:
        return ""
    return str(value).strip()


def _now_ms() -> int:
    return int(time.time() * 1000)


class RoleImportEngine:
    """知识库角色导入引擎。

    依赖注入：
    - kb_store：提供 load_entry(entry_id) 和 query_index(...) 访问知识库条目的对象。
    - role_store：提供 create_role(project_id, ...) 创建小说创作角色的对象。
    - history_dir：导入历史 JSON 存放目录（一般 = projects 数据目录）。
    """

    def __init__(
        self,
        kb_store: Any,
        role_store: Any,
        history_dir: str,
    ) -> None:
        self._kb_store = kb_store
        self._role_store = role_store
        self._history_dir = history_dir
        self._history_path = os.path.join(history_dir, IMPORT_HISTORY_FILE)
        # 导入历史文件锁（覆盖 load+save，防并发丢记录）
        self._history_lock = FileLock(
            os.path.join(history_dir, ".locks", "role_import_history.lock")
        )

    # ---- 候选角色提取 ----

    def list_candidate_roles(
        self, project_id: str, keyword: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """从知识库 novel 条目提取候选角色（供前端批量选择）。

        返回结构：每项 {entry_id, entry_title, type, role_index, name, identity,
        personality, relation_edges, available: bool}。available=False 表示该角色
        已被当前项目角色库导入过（同名），避免重复导入。
        """
        entries = self._kb_store.query_index(keyword=keyword, type_="novel")
        candidates: List[Dict[str, Any]] = []
        existing_names = set()
        # 已存在的角色名（按项目查重）
        try:
            for meta in self._list_all_roles(project_id):
                existing_names.add(_coerce_str(meta.get("name", "")))
        except Exception:
            existing_names = set()

        for meta in entries:
            entry = self._kb_store.load_entry(meta.get("id", ""))
            if not entry:
                continue
            structured = entry.get("structured", {}) or {}
            characters = structured.get("characters", []) or []
            relations = (structured.get("outline", {}) or {}).get("character_relations", []) or []
            for idx, ch in enumerate(characters):
                if not isinstance(ch, dict):
                    continue
                name = _coerce_str(ch.get("名字") or ch.get("name"))
                if not name:
                    continue
                edges = [
                    rel
                    for rel in relations
                    if _coerce_str(rel.get("a")) == name or _coerce_str(rel.get("b")) == name
                ]
                candidates.append({
                    "entry_id": meta.get("id", ""),
                    "entry_title": meta.get("title", ""),
                    "type": "novel",
                    "role_index": idx,
                    "name": name,
                    "identity": _coerce_str(ch.get("身份") or ch.get("identity")),
                    "personality": _coerce_str(ch.get("性格") or ch.get("personality")),
                    "relation_edges": edges,
                    "available": name not in existing_names,
                })
        return candidates

    def _list_all_roles(self, project_id: str) -> List[Dict[str, Any]]:
        """列出指定项目角色库全部角色元数据（用于查重 + 关系目标校验）。"""
        if hasattr(self._role_store, "list_roles"):
            return self._role_store.list_roles(project_id) or []
        return []

    # ---- 字段映射 ----

    def build_role_payload(self, candidate: Dict[str, Any]) -> Dict[str, Any]:
        """单条候选 → 小说创作角色字段 payload（含 field_mapping 标红信息）。

        返回 {name, identity, personality, background, appearance, relations,
        field_mapping: {field: {mapped, reason, value}}}。
        """
        name = _coerce_str(candidate.get("name"))
        if not name:
            raise bad_request("知识库角色缺少名字，无法导入")

        identity = _coerce_str(candidate.get("identity"))
        personality = _coerce_str(candidate.get("personality"))

        edges = candidate.get("relation_edges", []) or []
        background_parts = self._build_background(edges)
        background = "；".join(background_parts).strip()

        # relations：每条边 → {target_name, relation_type, note, mapped, reason}
        relations = self._build_relations(edges, name)

        # appearance 无直接来源（标红）
        field_mapping: Dict[str, Any] = {
            "name": {"mapped": True, "reason": "kb_name", "value": name},
            "identity": {
                "mapped": bool(identity),
                "reason": "kb_identity" if identity else "kb_missing",
                "value": identity,
            },
            "personality": {
                "mapped": bool(personality),
                "reason": "kb_personality" if personality else "kb_missing",
                "value": personality,
            },
            "background": {
                "mapped": bool(background),
                "reason": "kb_relations" if background else "kb_missing",
                "value": background,
            },
            "appearance": {"mapped": False, "reason": "kb_no_appearance", "value": ""},
        }

        return {
            "name": name,
            "identity": identity,
            "personality": personality,
            "background": background,
            "appearance": "",
            "relations": relations,
            "field_mapping": field_mapping,
        }

    @staticmethod
    def _build_background(edges: List[Dict[str, Any]]) -> List[str]:
        """人物关系边 → 背景故事描述（聚合）。"""
        parts: List[str] = []
        for rel in edges:
            a = _coerce_str(rel.get("a"))
            b = _coerce_str(rel.get("b"))
            relation = _coerce_str(rel.get("relation"))
            camp = _coerce_str(rel.get("camp"))
            seg = f"{a}与{b}"
            if relation:
                seg += f"：{relation}"
            if camp:
                seg += f"（{camp}）"
            if seg:
                parts.append(seg)
        return parts

    def _build_relations(self, edges: List[Dict[str, Any]], self_name: str) -> List[Dict[str, Any]]:
        """人物关系边 → Role.relations 数组（target_missing 标红）。"""
        relations: List[Dict[str, Any]] = []
        seen: set = set()
        for rel in edges:
            a = _coerce_str(rel.get("a"))
            b = _coerce_str(rel.get("b"))
            relation = _coerce_str(rel.get("relation"))
            camp = _coerce_str(rel.get("camp"))
            # 找对端角色名
            if a == self_name:
                target_name = b
            elif b == self_name:
                target_name = a
            else:
                target_name = ""
            if not target_name or target_name == self_name:
                continue
            key = (target_name, relation, camp)
            if key in seen:
                continue
            seen.add(key)
            relations.append({
                "target_name": target_name,
                "relation_type": relation,
                "note": camp,
                "mapped": True,
                "reason": "",
            })
        return relations

    # ---- 批量导入 ----

    def import_roles(
        self,
        project_id: str,
        candidates: List[Dict[str, Any]],
        preview: bool = False,
    ) -> Dict[str, Any]:
        """批量导入知识库角色 → 角色库。

        preview=True 仅生成预览（不落库），返回每条的 payload + field_mapping。
        preview=False 真正创建角色，并写导入历史。
        """
        if not project_id:
            raise bad_request("缺少 project_id")
        if not candidates:
            raise bad_request("未选择任何知识库角色")

        imported: List[Dict[str, Any]] = []
        failed: List[Dict[str, Any]] = []
        created_role_ids: List[str] = []
        # 阶段 2 统一解析 relations 用的 name→id 映射（含本批已建 + 库中已有）
        name_to_id: Dict[str, str] = {}

        for candidate in candidates:
            try:
                payload = self.build_role_payload(candidate)
                if preview:
                    # 预览：附加候选来源信息，不创建
                    payload["entry_id"] = candidate.get("entry_id", "")
                    payload["entry_title"] = candidate.get("entry_title", "")
                    payload["role_index"] = candidate.get("role_index", 0)
                    imported.append(payload)
                    continue
                # 阶段 1：先创建角色（不带 relations），再统一解析
                role_id = self._create_role_from_payload(project_id, payload, with_relations=False)
                created_role_ids.append(role_id)
                name_to_id[payload.get("name", "")] = role_id
                imported.append({
                    **payload,
                    "role_id": role_id,
                    "entry_id": candidate.get("entry_id", ""),
                    "entry_title": candidate.get("entry_title", ""),
                    "role_index": candidate.get("role_index", 0),
                })
            except AppError as e:
                failed.append({
                    "name": _coerce_str(candidate.get("name")),
                    "reason": e.message,
                    "detail": e.detail,
                })
            except Exception as e:  # noqa: BLE001 - 单条失败不阻断批量
                failed.append({
                    "name": _coerce_str(candidate.get("name")),
                    "reason": "import_failed",
                    "detail": str(e),
                })

        # 阶段 2：本批全部建好后，用最终 name→id 映射统一解析 relations
        # （解决同批对端角色后建导致 target_missing 误标的问题）
        for it in imported:
            if preview or not it.get("role_id"):
                continue
            relations = it.get("relations", [])
            if not relations:
                continue
            resolved = self._resolve_relations(project_id, relations, name_to_id=name_to_id)
            try:
                self._role_store.update_role(project_id, it["role_id"], relations=resolved)
                it["relations"] = resolved
            except AppError as e:
                failed.append({
                    "name": it.get("name", ""),
                    "reason": "relation_resolve_failed",
                    "detail": e.message,
                })

        result = {
            "total": len(candidates),
            "success": len(imported),
            "failed": len(failed),
            "imported": imported,
            "failed_items": failed,
        }

        if not preview and created_role_ids:
            self._record_history(project_id, created_role_ids, imported)

        return result

    def _create_role_from_payload(
        self, project_id: str, payload: Dict[str, Any], with_relations: bool = True,
    ) -> str:
        """调用 role_store.create_role 创建角色，注入映射字段。

        with_relations=True 时（单条/预览场景）即时解析 relations；
        with_relations=False 时（批量阶段 1）跳过，由阶段 2 统一解析。
        """
        name = payload.get("name", "")
        kwargs: Dict[str, Any] = {
            "identity": payload.get("identity", ""),
            "personality": payload.get("personality", ""),
            "background": payload.get("background", ""),
            "appearance": payload.get("appearance", ""),
        }
        if with_relations:
            relations = payload.get("relations", [])
            if relations:
                # 只保留可关联（mapped）的关系，target 用名字引用（角色库按名查 id）
                resolved = self._resolve_relations(project_id, relations)
                kwargs["relations"] = resolved
        role = self._role_store.create_role(project_id, name, **kwargs)
        return role.get("id", "")

    def _resolve_relations(
        self,
        project_id: str,
        relations: List[Dict[str, Any]],
        name_to_id: Optional[Dict[str, str]] = None,
    ) -> List[Dict[str, Any]]:
        """把 target_name 解析为 role_id；找不到则保留标记 target_missing。

        name_to_id：批量场景传入本批已建角色的 name→id 映射，优先命中；
        未命中再查角色库（覆盖「对端为库中已有角色」场景）。
        """
        merged = dict(name_to_id or {})
        resolved: List[Dict[str, Any]] = []
        for rel in relations:
            target_name = rel.get("target_name", "")
            target_id = merged.get(target_name, "")
            if not target_id:
                target_id = self._find_role_id_by_name(project_id, target_name)
            item = {
                "target_role_id": target_id or "",
                "target_name": target_name,
                "relation_type": rel.get("relation_type", ""),
                "note": rel.get("note", ""),
                "mapped": bool(target_id),
                "reason": "" if target_id else "target_missing",
            }
            resolved.append(item)
        return resolved

    def _find_role_id_by_name(self, project_id: str, name: str) -> str:
        """角色库按名字查 id（用于关系目标解析）。"""
        try:
            for meta in self._list_all_roles(project_id):
                if _coerce_str(meta.get("name", "")) == _coerce_str(name):
                    return _coerce_str(meta.get("id", ""))
        except Exception:
            pass
        return ""

    # ---- 导入历史 ----

    def _record_history(
        self,
        project_id: str,
        role_ids: List[str],
        imported: List[Dict[str, Any]],
    ) -> None:
        """追加一条导入历史（含角色快照，可回溯）。

        load+insert+save 在同一文件锁内执行（读-改-写原子），防并发丢记录。
        """
        record = {
            "history_id": f"ih_{_now_ms()}",
            "project_id": project_id,
            "imported_at": _now_ms(),
            "role_ids": role_ids,
            "roles": [
                {
                    "role_id": it.get("role_id", ""),
                    "name": it.get("name", ""),
                    "entry_id": it.get("entry_id", ""),
                    "entry_title": it.get("entry_title", ""),
                    "personality": it.get("personality", ""),
                    "background": it.get("background", ""),
                    "appearance": it.get("appearance", ""),
                    "field_mapping": it.get("field_mapping", {}),
                }
                for it in imported
            ],
        }
        with self._history_lock:
            history = self._load_history()
            history.insert(0, record)
            history = history[:200]  # 保留最近 200 条
            self._save_history(history)

    def get_import_history(self, project_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """查询导入历史（可按项目过滤）。"""
        history = self._load_history()
        if project_id:
            return [h for h in history if h.get("project_id") == project_id]
        return history

    def _load_history(self) -> List[Dict[str, Any]]:
        try:
            with open(self._history_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def _save_history(self, history: List[Dict[str, Any]]) -> None:
        os.makedirs(self._history_dir, exist_ok=True)
        tmp = self._history_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(history, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self._history_path)
