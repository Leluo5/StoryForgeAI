# -*- coding: utf-8 -*-
"""知识库关联引擎（F5-T5）。

对齐技术方案 §4.4：
- link_inspiration：相似度检索（LLM 嵌入优先，TF-IDF 兜底）+ 建立关联 + llm_enrich 上下文补充。
- search_similar：在已有条目中检索与给定文本最相似的候选。
- 无匹配返回 related_ids=[]，仅存独立灵感。

同模块内复用一个轻量 TF-IDF + 余弦相似度实现（无外部向量依赖）。
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any, Callable, Dict, List, Optional

from modules.common.errors import AppError

_TOKEN_RE = re.compile(r"[\u4e00-\u9fff]|[a-zA-Z0-9]+")


def _tokenize(text: str) -> List[str]:
    """中文按单字 + 英文按词切分；并叠加字符 bigram 提升中文相似度敏感度。

    纯中文 `\w` 会把整段连成一个大 token，跨文本无共享词导致余弦恒 0。
    这里用 单字 + 双字组合 作为特征，使共享字符的文本获得非零相似度。
    """
    units = _TOKEN_RE.findall((text or "").lower())
    tokens: List[str] = list(units)
    for i in range(len(units) - 1):
        tokens.append(units[i] + units[i + 1])
    return tokens


def _cosine(a: Counter, b: Counter) -> float:
    """两个词频向量余弦相似度。"""
    if not a or not b:
        return 0.0
    dot = sum(count * b.get(tok, 0) for tok, count in a.items())
    norm_a = math.sqrt(sum(c * c for c in a.values()))
    norm_b = math.sqrt(sum(c * c for c in b.values()))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


class KnowledgeLinker:
    """关联引擎：跨条目相似度检索 + 关联 + 灵感上下文补充。"""

    def __init__(
        self,
        store=None,
        llm: Optional[Callable[[str, str], Dict[str, Any]]] = None,
        enrich_bot_id: str = "",
        top_k: int = 3,
    ) -> None:
        # store 延迟注入（在 routes 中组装），避免循环依赖
        self._store = store
        self._llm = llm
        self.enrich_bot_id = enrich_bot_id
        self.top_k = top_k

    def set_store(self, store) -> None:
        self._store = store

    # ---- 相似度检索 ----

    def search_similar(
        self, text: str, exclude_ids: Optional[List[str]] = None, top_k: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """在全部条目中检索与 text 最相似的前 top_k 条。

        优先 LLM 嵌入（有 _llm 时），否则 TF-IDF + 余弦兜底。
        返回 [{id, type, title, score}]。
        """
        store = self._store
        if store is None:
            return []
        exclude = set(exclude_ids or [])
        top = top_k or self.top_k
        if self._llm is not None:
            results = self._search_by_embedding(text, exclude, top)
            if results:
                return results
        return self._search_by_tfidf(text, exclude, top)

    def _search_by_tfidf(
        self, text: str, exclude: set, top: int
    ) -> List[Dict[str, Any]]:
        query_vec = Counter(_tokenize(text))
        scored: List[Dict[str, Any]] = []
        for meta in self._store.load_index().get("items", []):
            if meta.get("id") in exclude:
                continue
            entry = self._store.load_entry(meta["id"])
            if entry is None:
                continue
            haystack = " ".join(
                [
                    entry.get("title", ""),
                    entry.get("raw_content", ""),
                    " ".join(entry.get("tags", [])),
                ]
            )
            score = _cosine(query_vec, Counter(_tokenize(haystack)))
            if score > 0:
                scored.append(
                    {"id": meta["id"], "type": meta.get("type"), "title": meta.get("title"), "score": round(score, 4)}
                )
        scored.sort(key=lambda x: x["score"], reverse=True)
        return scored[:top]

    def _search_by_embedding(
        self, text: str, exclude: set, top: int
    ) -> List[Dict[str, Any]]:
        """LLM 嵌入检索（预留）：当前无独立嵌入服务，返回空走 TF-IDF 兜底。"""
        # 嵌入服务未接入；技术方案 §8「无嵌入服务时 TF-IDF 兜底」
        return []

    # ---- 关联建立 ----

    def link_inspiration(self, inspiration: Dict[str, Any]) -> Dict[str, Any]:
        """灵感自动关联：检索相似条目 → 建立关联 → 上下文补充。

        返回更新后的 structured（含 raw_text / enriched_text / related_ids）。
        无匹配时 related_ids=[]。
        """
        store = self._store
        if store is None:
            return {
                "raw_text": inspiration.get("raw_content", ""),
                "enriched_text": inspiration.get("raw_content", ""),
                "related_ids": [],
            }
        raw_text = inspiration.get("raw_content", "")
        candidates = self.search_similar(raw_text, exclude_ids=[inspiration.get("id")])
        related_ids = [c["id"] for c in candidates[: self.top_k]]

        enriched = raw_text
        if related_ids and self._llm is not None:
            enriched = self._llm_enrich(raw_text, candidates)
        return {
            "raw_text": raw_text,
            "enriched_text": enriched,
            "related_ids": related_ids,
        }

    def _llm_enrich(self, raw_text: str, candidates: List[Dict[str, Any]]) -> str:
        """基于已有知识上下文补充完善灵感文本。"""
        ctx = "\n".join(
            f"- [{c.get('type')}] {c.get('title')}" for c in candidates
        )
        prompt = (
            "你是灵感补充助手。基于以下已有知识上下文，为灵感文本补充背景、"
            "冲突方向或可扩展要素，保持原有表达。只输出补充后的文本。"
            f"\n\n已有知识：\n{ctx}\n\n灵感：\n{raw_text}"
        )
        result = self._llm(prompt, self.enrich_bot_id)
        if not result.get("success"):
            raise AppError(502, "灵感补充失败", result.get("error", ""))
        content = result.get("content", "")
        return content if isinstance(content, str) else str(content)

    # ---- 手动关联 ----

    def add_link(self, entry_id: str, target_id: str) -> List[str]:
        """在条目 links 中追加目标引用（去重），返回更新后的 links。

        同步回写目标条目 links（双向引用，对齐技术方案 §3.5 DELETE 清理引用）。
        """
        store = self._store
        if store is None:
            raise AppError(500, "store 未注入")
        entry = store.load_entry(entry_id)
        if entry is None:
            raise AppError(404, f"条目不存在: {entry_id}")
        target = store.load_entry(target_id)
        if target is None:
            raise AppError(404, f"目标条目不存在: {target_id}")
        if target_id == entry_id:
            raise AppError(400, "不能关联自身")

        entry_links = entry.get("links", [])
        if target_id not in entry_links:
            entry_links.append(target_id)
            entry["links"] = entry_links
            store.save_entry(entry)

        target_links = target.get("links", [])
        if entry_id not in target_links:
            target_links.append(entry_id)
            target["links"] = target_links
            store.save_entry(target)

        return entry_links

    def remove_link(self, entry_id: str, target_id: str) -> List[str]:
        """移除条目对目标的引用（双向清理）。"""
        store = self._store
        if store is None:
            raise AppError(500, "store 未注入")
        entry = store.load_entry(entry_id)
        if entry is None:
            raise AppError(404, f"条目不存在: {entry_id}")
        entry_links = [l for l in entry.get("links", []) if l != target_id]
        entry["links"] = entry_links
        store.save_entry(entry)

        target = store.load_entry(target_id)
        if target is not None:
            target_links = [l for l in target.get("links", []) if l != entry_id]
            target["links"] = target_links
            store.save_entry(target)
        return entry_links
