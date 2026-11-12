# -*- coding: utf-8 -*-
"""知识库数据层（F5-T1）。

对齐技术方案 §2：`data/knowledge/<id>.json` 每条目一个文件 + `index.json` 元数据索引。
复用公共层 storage 的文件锁 + 原子写；额外实现：
- 哈希查重：同一 raw_content（去空白）哈希在索引中查重，防重复条目。
- 索引重建：index.json 损坏/缺失时全量扫描重建。
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Dict, List, Optional

from modules.common.storage import (
    FileLock,
    atomic_write_json,
    new_id,
    now_iso,
    read_json,
)

# 知识库数据类型（对齐技术方案 §2.2 / 接口契约 §5.1）
VALID_TYPES = ("article", "paper", "novel", "inspiration")

# 条目文件扩展名
ENTRY_SUFFIX = ".json"


class KnowledgeStore:
    """知识条目 JSON 存储：每条目一个文件 + 元数据索引 + 哈希查重。"""

    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir
        self.lock_dir = os.path.join(data_dir, ".locks")
        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(self.lock_dir, exist_ok=True)

    # ---- 路径与锁 ----

    def _entry_path(self, entry_id: str) -> str:
        return os.path.join(self.data_dir, f"{entry_id}{ENTRY_SUFFIX}")

    def _index_path(self) -> str:
        return os.path.join(self.data_dir, "index.json")

    def _entry_lock(self, entry_id: str) -> FileLock:
        return FileLock(os.path.join(self.lock_dir, f"{entry_id}.lock"))

    def _index_lock(self) -> FileLock:
        return FileLock(os.path.join(self.lock_dir, "index.lock"))

    # ---- 哈希查重 ----

    @staticmethod
    def _content_hash(raw_content: str) -> str:
        """对原文内容（去首尾空白）计算 SHA256，作为查重键。"""
        normalized = (raw_content or "").strip()
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def find_by_hash(self, raw_content: str) -> Optional[Dict[str, Any]]:
        """按内容哈希查找已有条目；无重复返回 None。

        索引中存 `content_hash` 字段，避免全量扫描。索引无该字段时
        回退逐条读取匹配（兼容旧索引）。
        """
        target = self._content_hash(raw_content)
        index = self.load_index()
        items = index.get("items", [])
        for meta in items:
            if meta.get("content_hash") == target:
                entry = self.load_entry(meta["id"])
                if entry is not None:
                    return entry
        return None

    # ---- CRUD ----

    def create_entry(
        self,
        type_: str,
        title: str,
        raw_content: str,
        source: str = "manual",
        structured: Optional[Dict[str, Any]] = None,
        tags: Optional[List[str]] = None,
        file_id: str = "",
        status: str = "preview",
    ) -> Dict[str, Any]:
        """新建知识条目并写文件 + 更新索引。

        重复录入（内容哈希命中）时返回已有条目（防重复）。
        """
        if type_ not in VALID_TYPES:
            raise ValueError(f"非法知识类型: {type_}")
        existing = self.find_by_hash(raw_content)
        if existing is not None:
            return existing

        entry_id = new_id()
        now = now_iso()
        entry: Dict[str, Any] = {
            "id": entry_id,
            "type": type_,
            "title": title,
            "source": source,
            "raw_content": raw_content,
            "structured": structured or {},
            "tags": tags or [],
            "links": [],
            "status": status,
            "file_id": file_id,
            "content_hash": self._content_hash(raw_content),
            "created_at": now,
            "updated_at": now,
        }
        self._write_entry(entry)
        self._upsert_index_meta(self._meta_of(entry))
        return entry

    def _write_entry(self, entry: Dict[str, Any]) -> None:
        with self._entry_lock(entry["id"]):
            atomic_write_json(self._entry_path(entry["id"]), entry)

    def load_entry(self, entry_id: str) -> Optional[Dict[str, Any]]:
        """按 id 读取完整条目（含 structured）；不存在返回 None。"""
        with self._entry_lock(entry_id):
            return read_json(self._entry_path(entry_id), None)

    def save_entry(self, entry: Dict[str, Any]) -> None:
        """整条覆盖保存（更新 updated_at + 刷新索引元数据）。"""
        entry["updated_at"] = now_iso()
        if entry.get("content_hash") is None and entry.get("raw_content"):
            entry["content_hash"] = self._content_hash(entry["raw_content"])
        self._write_entry(entry)
        self._upsert_index_meta(self._meta_of(entry))

    def delete_entry(self, entry_id: str) -> bool:
        """删除条目文件 + 从索引移除；不存在返回 False。"""
        with self._entry_lock(entry_id):
            try:
                os.unlink(self._entry_path(entry_id))
            except FileNotFoundError:
                return False
        index = self.load_index()
        items = [m for m in index.get("items", []) if m.get("id") != entry_id]
        self._write_index({"items": items})
        return True

    @staticmethod
    def _meta_of(entry: Dict[str, Any]) -> Dict[str, Any]:
        """抽取索引元数据（轻量，不含 structured 正文）。"""
        return {
            "id": entry.get("id", ""),
            "type": entry.get("type", ""),
            "title": entry.get("title", ""),
            "tags": entry.get("tags", []),
            "source": entry.get("source", ""),
            "status": entry.get("status", ""),
            "content_hash": entry.get("content_hash", ""),
            "created_at": entry.get("created_at", ""),
            "updated_at": entry.get("updated_at", ""),
        }

    # ---- 索引 ----

    def load_index(self) -> Dict[str, Any]:
        """读取 index.json；缺失/损坏时重建（全量扫描 data/knowledge/*.json）。"""
        index = read_json(self._index_path(), None)
        if index is None:
            return self.rebuild_index()
        return index

    def _write_index(self, index: Dict[str, Any]) -> None:
        with self._index_lock():
            atomic_write_json(self._index_path(), index)

    def _upsert_index_meta(self, meta: Dict[str, Any]) -> None:
        """向索引插入或更新一条元数据（并发安全，读改写加索引锁）。"""
        with self._index_lock():
            index = read_json(self._index_path(), {"items": []})
            items = index.get("items", [])
            replaced = False
            for i, m in enumerate(items):
                if m.get("id") == meta["id"]:
                    items[i] = meta
                    replaced = True
                    break
            if not replaced:
                items.append(meta)
            atomic_write_json(self._index_path(), {"items": items})

    def rebuild_index(self) -> Dict[str, Any]:
        """全量扫描条目文件，重建 index.json（索引损坏/缺失时调用）。"""
        items: List[Dict[str, Any]] = []
        if not os.path.isdir(self.data_dir):
            self._write_index({"items": []})
            return {"items": []}
        for name in os.listdir(self.data_dir):
            if not name.endswith(ENTRY_SUFFIX) or name == "index.json":
                continue
            entry_id = name[: -len(ENTRY_SUFFIX)]
            entry = self.load_entry(entry_id)
            if entry is not None:
                items.append(self._meta_of(entry))
        index = {"items": items}
        self._write_index(index)
        return index

    def query_index(
        self,
        keyword: Optional[str] = None,
        type_: Optional[str] = None,
        tag: Optional[str] = None,
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """四维度索引过滤（关键词/类型/标签/时间），返回元数据列表。

        关键词命中在 raw_content + structured 全文（需读条目），其余维度走索引。
        """
        index = self.load_index()
        results: List[Dict[str, Any]] = []
        for meta in index.get("items", []):
            if type_ and meta.get("type") != type_:
                continue
            if tag and tag not in (meta.get("tags") or []):
                continue
            created = meta.get("created_at", "")
            if start_time and created < start_time:
                continue
            if end_time and created > end_time:
                continue
            if keyword:
                entry = self.load_entry(meta["id"])
                if entry is None:
                    continue
                if not self._match_keyword(entry, keyword):
                    continue
            results.append(meta)
        return results

    @staticmethod
    def _match_keyword(entry: Dict[str, Any], keyword: str) -> bool:
        kw = keyword.lower()
        haystack = json.dumps(
            {
                "title": entry.get("title", ""),
                "raw_content": entry.get("raw_content", ""),
                "structured": entry.get("structured", {}),
                "tags": entry.get("tags", []),
            },
            ensure_ascii=False,
        ).lower()
        return kw in haystack
