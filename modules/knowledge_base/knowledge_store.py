# -*- coding: utf-8 -*-
"""知识库数据层（F5-T1，Markdown 双层改造版）。

存储形态（对齐技术方案 §2 + Markdown 双层优化）：
- `<id>.json`：元数据 + structured（强结构）+ tags + links + content_hash + 时间戳。
- `<id>.md`  ：正文（Markdown 语法，人可读、可 diff、可富媒体）。
- `index.json`：轻量元数据索引（不含 structured 正文）。

加载合成：`load_entry` 读 JSON + 读 `.md`，把正文塞回 `raw_content` 键，
对 parser/linker/接口层完全透明（调用方仍按 `entry["raw_content"]` 访问）。

旧数据惰性迁移：历史条目正文内嵌于 `<id>.json` 的 `raw_content` 字段，
首次读该条目时自动写出 `<id>.md` 并从 JSON 剥离该键（不破坏已有 data/）。

复用公共层 storage 的文件锁 + 原子写；额外实现：
- 哈希查重：同一正文（去空白）哈希在索引中查重，防重复条目。
- 索引重建：index.json 损坏/缺失时全量扫描重建。
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import tempfile
from collections import Counter
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

# 条目元数据文件扩展名
ENTRY_SUFFIX = ".json"
# 正文 Markdown 文件扩展名
BODY_SUFFIX = ".md"
# 全文检索倒排索引文件名（字符级单字 + bigram）
SEARCH_INDEX_FILE = "search_index.json"

# 分词正则：中文单字 | 英文/数字词
_TOKEN_RE = re.compile(r"[\u4e00-\u9fff]|[a-zA-Z0-9]+")


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

    def _body_path(self, entry_id: str) -> str:
        """正文 Markdown 文件路径（<id>.md）。"""
        return os.path.join(self.data_dir, f"{entry_id}{BODY_SUFFIX}")

    def _index_path(self) -> str:
        return os.path.join(self.data_dir, "index.json")

    def _search_index_path(self) -> str:
        """全文检索倒排索引文件路径。"""
        return os.path.join(self.data_dir, SEARCH_INDEX_FILE)

    def _entry_lock(self, entry_id: str) -> FileLock:
        return FileLock(os.path.join(self.lock_dir, f"{entry_id}.lock"))

    def _index_lock(self) -> FileLock:
        return FileLock(os.path.join(self.lock_dir, "index.lock"))

    # ---- 全文检索倒排索引 ----

    @staticmethod
    def _search_tokens(text: str) -> List[str]:
        """分词：中文单字 + 英文/数字词 + 相邻 bigram（提升中文短语命中敏感度）。

        与 linker._tokenize 思路一致（共享字符特征），供倒排索引与查询共用。
        """
        units = _TOKEN_RE.findall((text or "").lower())
        tokens = list(units)
        for i in range(len(units) - 1):
            tokens.append(units[i] + units[i + 1])
        return tokens

    @staticmethod
    def _entry_search_text(entry: Dict[str, Any]) -> str:
        """条目可检索文本：title + raw_content + tags（不含 structured，正文已含主体）。"""
        return " ".join(
            [
                entry.get("title", ""),
                entry.get("raw_content", ""),
                " ".join(entry.get("tags", [])),
            ]
        )

    @staticmethod
    def _build_postings(text: str) -> Dict[str, int]:
        """由文本生成 {token: 词频} 词频表。"""
        return dict(Counter(KnowledgeStore._search_tokens(text)))

    def _load_search_index(self) -> Dict[str, Any]:
        """读取倒排索引；缺失/损坏时返回空结构（不自动重建，避免递归写）。"""
        return read_json(self._search_index_path(), {"postings": {}, "entry_tokens": {}})

    def _write_search_index(self, index: Dict[str, Any]) -> None:
        """原子写倒排索引（调用方须持 _index_lock，避免读改写竞态）。"""
        atomic_write_json(self._search_index_path(), index)

    def _upsert_search_entry(self, entry_id: str, text: str) -> None:
        """增量更新倒排：移除旧词频、写入新词频（原子，读改写加索引锁）。"""
        tokens = self._build_postings(text)
        with self._index_lock():
            index = self._load_search_index()
            postings: Dict[str, Any] = index.get("postings", {})
            entry_tokens: Dict[str, Any] = index.get("entry_tokens", {})
            # 移除该条目的旧 token 引用
            old = entry_tokens.get(entry_id, {})
            for tok, count in old.items():
                posting = postings.get(tok)
                if posting is None:
                    continue
                posting["entries"].pop(entry_id, None)
                posting["total"] = max(0, posting.get("total", 0) - count)
                if not posting["entries"]:
                    postings.pop(tok, None)
            # 写入新 token 引用
            for tok, count in tokens.items():
                posting = postings.setdefault(tok, {"total": 0, "entries": {}})
                posting["entries"][entry_id] = count
                posting["total"] += count
            entry_tokens[entry_id] = tokens
            self._write_search_index({"postings": postings, "entry_tokens": entry_tokens})

    def _remove_search_entry(self, entry_id: str) -> None:
        """从倒排移除条目（删除时调用）。"""
        with self._index_lock():
            index = self._load_search_index()
            postings = index.get("postings", {})
            entry_tokens = index.get("entry_tokens", {})
            old = entry_tokens.pop(entry_id, {})
            for tok, count in old.items():
                posting = postings.get(tok)
                if posting is None:
                    continue
                posting["entries"].pop(entry_id, None)
                posting["total"] = max(0, posting.get("total", 0) - count)
                if not posting["entries"]:
                    postings.pop(tok, None)
            self._write_search_index({"postings": postings, "entry_tokens": entry_tokens})

    def _search_candidate_ids(self, keyword: str) -> Optional[List[str]]:
        """倒排预筛候选 id 集（超集，供精排）；索引缺失/损坏返回 None 走全量兜底。

        命中规则：关键词任一分词 token 出现在倒排中即入候选。
        候选集是「子串命中」的超集（子串必含某单字/bigram token），保证精排不误杀。
        """
        index = self._load_search_index()
        postings = index.get("postings", {})
        if not postings:
            return None
        tokens = self._search_tokens(keyword)
        candidates: set = set()
        for tok in tokens:
            posting = postings.get(tok)
            if posting:
                candidates.update(posting["entries"].keys())
        return list(candidates)

    def rebuild_search_index(self) -> Dict[str, Any]:
        """全量重建倒排索引（扫描全部条目；索引损坏/缺失时供外部调用）。"""
        postings: Dict[str, Any] = {}
        entry_tokens: Dict[str, Any] = {}
        if os.path.isdir(self.data_dir):
            for name in os.listdir(self.data_dir):
                if (
                    not name.endswith(ENTRY_SUFFIX)
                    or name == "index.json"
                    or name == SEARCH_INDEX_FILE
                ):
                    continue
                entry_id = name[: -len(ENTRY_SUFFIX)]
                entry = self.load_entry(entry_id)
                if entry is None:
                    continue
                tokens = self._build_postings(self._entry_search_text(entry))
                entry_tokens[entry_id] = tokens
                for tok, count in tokens.items():
                    posting = postings.setdefault(tok, {"total": 0, "entries": {}})
                    posting["entries"][entry_id] = count
                    posting["total"] += count
        index = {"postings": postings, "entry_tokens": entry_tokens}
        self._write_search_index(index)
        return index

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
        **extra: Any,
    ) -> Dict[str, Any]:
        """新建知识条目并写文件 + 更新索引。

        重复录入（内容哈希命中）时返回已有条目（防重复）。
        extra 聚合可选字段：structured/tags/file_id/status。
        """
        structured = extra.get("structured")
        tags = extra.get("tags")
        file_id = extra.get("file_id", "")
        status = extra.get("status", "preview")
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
        self._upsert_search_entry(entry["id"], self._entry_search_text(entry))
        return entry

    @staticmethod
    def _atomic_write_text(path: str, text: str) -> None:
        """文本原子写：先写临时文件（.tmp），再 os.replace 原子替换，避免半写损坏。"""
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix=os.path.basename(path) + ".", suffix=".tmp",
            dir=os.path.dirname(path) or ".",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp_path, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)
            raise

    def _write_entry_locked(self, entry: Dict[str, Any]) -> None:
        """整条落盘（调用方须持 _entry_lock）：正文写 <id>.md，元数据+structured 写 <id>.json（双层）。

        正文与元数据在同一锁内原子提交：正文用 .tmp + os.replace 原子写，
        元数据复用 atomic_write_json，二者都在持锁期间完成，避免半写损坏。
        内存中的 `raw_content` 仅用于合成，落盘时从 JSON 剥离、独立写 .md。
        """
        body = entry.get("raw_content", "") or ""
        meta = dict(entry)
        meta.pop("raw_content", None)
        # 正文 Markdown（原子写）
        self._atomic_write_text(self._body_path(entry["id"]), body)
        # 元数据 + structured（原子写）
        atomic_write_json(self._entry_path(entry["id"]), meta)

    def _write_entry(self, entry: Dict[str, Any]) -> None:
        """整条落盘：正文写 <id>.md，元数据+structured 写 <id>.json（双层）。

        内存中的 `raw_content` 仅用于合成，落盘时从 JSON 剥离、独立写 .md。
        """
        with self._entry_lock(entry["id"]):
            self._write_entry_locked(entry)

    def _load_entry_locked(self, entry_id: str) -> Optional[Dict[str, Any]]:
        """按 id 读取完整条目（调用方须持 _entry_lock）。

        合成逻辑：读取 <id>.json 元数据 + <id>.md 正文，正文塞回 `raw_content`。
        若 `.md` 缺失但 JSON 内含 raw_content（旧数据），首次读时惰性迁移：
        写出 <id>.md 并从 JSON 剥离该键。
        """
        meta = read_json(self._entry_path(entry_id), None)
        if meta is None:
            return None
        body_path = self._body_path(entry_id)
        body = ""
        if os.path.exists(body_path):
            try:
                with open(body_path, "r", encoding="utf-8") as f:
                    body = f.read()
            except OSError:
                body = ""
        elif "raw_content" in meta:
            # 旧数据：正文内嵌于 JSON，惰性迁移到 .md（正文原子写）
            body = meta.get("raw_content", "") or ""
            meta.pop("raw_content", None)
            try:
                self._atomic_write_text(body_path, body)
                atomic_write_json(self._entry_path(entry_id), meta)
            except OSError:
                pass
        meta["raw_content"] = body
        return meta

    def load_entry(self, entry_id: str) -> Optional[Dict[str, Any]]:
        """按 id 读取完整条目（含 structured）；不存在返回 None。

        合成逻辑：读取 <id>.json 元数据 + <id>.md 正文，正文塞回 `raw_content`。
        若 `.md` 缺失但 JSON 内含 raw_content（旧数据），首次读时惰性迁移：
        写出 <id>.md 并从 JSON 剥离该键。
        """
        with self._entry_lock(entry_id):
            return self._load_entry_locked(entry_id)

    def save_entry(self, entry: Dict[str, Any]) -> None:
        """整条覆盖保存（更新 updated_at + 刷新索引元数据）。"""
        entry["updated_at"] = now_iso()
        if entry.get("content_hash") is None and entry.get("raw_content"):
            entry["content_hash"] = self._content_hash(entry["raw_content"])
        self._write_entry(entry)
        self._upsert_index_meta(self._meta_of(entry))
        self._upsert_search_entry(entry["id"], self._entry_search_text(entry))

    def update_entry(self, entry_id: str, mutator) -> Optional[Dict[str, Any]]:
        """锁内读-改-写原子更新条目（并发安全）。

        mutator(entry) 就地修改 entry 并返回 None，或返回新的 entry dict。
        条目不存在时 mutator 不会被调用，返回 None。
        更新后刷新索引元数据与全文倒排（与 save_entry 一致）。
        """
        with self._entry_lock(entry_id):
            entry = self._load_entry_locked(entry_id)
            if entry is None:
                return None
            result = mutator(entry)
            if isinstance(result, dict):
                entry = result
            entry["updated_at"] = now_iso()
            if entry.get("content_hash") is None and entry.get("raw_content"):
                entry["content_hash"] = self._content_hash(entry["raw_content"])
            self._write_entry_locked(entry)
        self._upsert_index_meta(self._meta_of(entry))
        self._upsert_search_entry(entry["id"], self._entry_search_text(entry))
        return entry

    def delete_entry(self, entry_id: str) -> bool:
        """删除条目文件 + 正文 .md + 从索引移除；不存在返回 False。"""
        with self._entry_lock(entry_id):
            try:
                os.unlink(self._entry_path(entry_id))
            except FileNotFoundError:
                return False
            with contextlib.suppress(OSError):
                os.unlink(self._body_path(entry_id))
        index = self.load_index()
        items = [m for m in index.get("items", []) if m.get("id") != entry_id]
        self._write_index({"items": items})
        self._remove_search_entry(entry_id)
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
            if not name.endswith(ENTRY_SUFFIX) or name == "index.json" or name == SEARCH_INDEX_FILE:
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
        **extra: Any,
    ) -> List[Dict[str, Any]]:
        """四维度索引过滤（关键词/类型/标签/时间），返回元数据列表。

        关键词命中在 raw_content + structured 全文（需读条目）。
        有倒排索引时先用 `_search_candidate_ids` 预筛候选集（超集），
        仅对候选集做 `_match_keyword` 精排，避免全量 `load_entry` 扫描。
        倒排缺失/损坏时回退全量遍历（语义不变，仅性能降级）。
        extra 聚合可选过滤：tag/start_time/end_time。
        """
        tag = extra.get("tag")
        start_time = extra.get("start_time")
        end_time = extra.get("end_time")
        index = self.load_index()
        all_items = index.get("items", [])

        # 倒排预筛候选 id 集（None 表示索引不可用，走全量兜底）
        candidate_ids = None
        if keyword:
            candidate_ids = self._search_candidate_ids(keyword)

        results: List[Dict[str, Any]] = []
        for meta in all_items:
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
                # 倒排可用且该条目不在候选集 → 直接跳过（精排前预剪枝）
                if candidate_ids is not None and meta["id"] not in candidate_ids:
                    continue
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
