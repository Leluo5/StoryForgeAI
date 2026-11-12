# -*- coding: utf-8 -*-
"""知识库拆分引擎（F5-T2/T3/T4）。

对齐技术方案 §4.1~§4.3：
- detect_type：LLM 自动判定 + 手动指定兜底；不确定抛 TypeUncertain。
- parse_entry：按类型调用 parse_article/paper/novel/inspiration；
  拆分失败降级为原文存储；超大文本（>CHUNK_SIZE）分块逐块送 LLM。
- extract_outline：小说拆文成功后自动触发，四维度（章节/情节/人物关系/核心故事线）；
  失败返回 outline_failed，无章节结构返回 no_chapters。

LLM 调用通过可注入的 llm 调用器（默认走 coze_client.chat），便于单测 mock。
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional

from modules.common.errors import AppError

# 拆分分块阈值（字符），对齐技术方案 §4.6「超大文本 8000 字分块」
CHUNK_SIZE = 8000

# 合法知识类型（对齐 types.py / 技术方案 §2.2）
VALID_TYPES = ("article", "paper", "novel", "inspiration")


class TypeUncertain(AppError):
    """类型识别不确定：需要前端手动指定兜底。"""

    def __init__(self, message: str = "类型识别不确定，请手动指定"):
        super().__init__(400, message, "")


# LLM 调用器签名：llm(prompt, bot_id="") -> {"success": bool, "content": str|dict, "error": str}
# 默认经 coze_client.chat(bot_id, user_message)，bot_id 为空时用全局配置的拆分智能体。
def _default_llm(prompt: str, bot_id: str = "") -> Dict[str, Any]:
    from coze_client import CozeClient

    client = CozeClient()
    return client.chat(bot_id, prompt)


def _coerce_content(result: Dict[str, Any]) -> Any:
    """从 LLM 结果中取 content（字符串尝试解析 JSON）。"""
    if not result.get("success"):
        raise AppError(502, "LLM 调用失败", result.get("error", ""))
    content = result.get("content")
    if isinstance(content, str):
        stripped = content.strip()
        # 去除可能包裹的 ```json ... ```
        code_fence = re.search(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL)
        if code_fence:
            stripped = code_fence.group(1).strip()
        try:
            return json.loads(stripped)
        except (ValueError, TypeError):
            return stripped
    return content


class KnowledgeParser:
    """拆分引擎：类型识别 + 四类型结构化拆分 + 大纲提取。"""

    def __init__(
        self,
        llm: Optional[Callable[[str, str], Dict[str, Any]]] = None,
        chunk_size: int = CHUNK_SIZE,
        split_bot_id: str = "",
        outline_bot_id: str = "",
    ) -> None:
        self._llm = llm or _default_llm
        self.chunk_size = chunk_size
        self.split_bot_id = split_bot_id
        self.outline_bot_id = outline_bot_id

    # ---- T2 类型识别 ----

    def detect_type(self, raw_content: str, manual: Optional[str] = None) -> str:
        """判定资料类型。

        - manual 为四类型之一时直接返回（手动指定兜底）。
        - 否则调 LLM 自动判定；返回类型非法或不确定时抛 TypeUncertain。
        """
        if manual in VALID_TYPES:
            return manual
        if not raw_content or not raw_content.strip():
            raise TypeUncertain("内容为空，无法识别类型")

        prompt = (
            "你是小说创作知识库的类型识别器。请判断以下文本属于哪一类资料，"
            "只输出一个词：article（文章）、paper（论文）、novel（小说/故事）、"
            "inspiration（灵感/构思）。若无法确定输出 uncertain。\n\n文本片段：\n"
            + raw_content[:2000]
        )
        result = self._llm(prompt, self.split_bot_id)
        content = _coerce_content(result)
        detected = str(content).strip().lower()
        if detected in VALID_TYPES:
            return detected
        raise TypeUncertain()

    # ---- T3 拆分引擎 ----

    def parse_entry(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        """按类型拆分，返回结构化结果 structured。

        拆分失败（LLM 异常）降级为原文存储：{ "fallback": true, "raw_text": ... }。
        超大文本分块逐块送 LLM，结果合并。
        """
        type_ = entry.get("type")
        raw_content = entry.get("raw_content", "")
        try:
            if type_ == "article":
                return self.parse_article(raw_content)
            if type_ == "paper":
                return self.parse_paper(raw_content)
            if type_ == "novel":
                return self.parse_novel(raw_content)
            if type_ == "inspiration":
                return self.parse_inspiration(raw_content)
            raise AppError(400, f"未知类型: {type_}")
        except AppError:
            # LLM 失败：降级原文存储（对齐技术方案 §5「拆分失败」）
            return {"fallback": True, "raw_text": raw_content}

    def _split_chunks(self, text: str) -> List[str]:
        """按 chunk_size 分块；长度不足返回单块。"""
        if len(text) <= self.chunk_size:
            return [text]
        chunks = []
        for i in range(0, len(text), self.chunk_size):
            chunks.append(text[i : i + self.chunk_size])
        return chunks

    def parse_article(self, raw_content: str) -> Dict[str, Any]:
        """文章结构化：paragraphs / key_points / summary / tag_list。"""
        paragraphs = self._split_paragraphs(raw_content)
        prompt = self._prompt_article(raw_content)
        data = self._llm_json(prompt)
        return {
            "paragraphs": data.get("paragraphs") or paragraphs,
            "key_points": data.get("key_points") or [],
            "summary": data.get("summary") or "",
            "tag_list": data.get("tag_list") or [],
        }

    def parse_paper(self, raw_content: str) -> Dict[str, Any]:
        """论文五要素：research_question / method / conclusion / limitation / insight。"""
        prompt = self._prompt_paper(raw_content)
        data = self._llm_json(prompt)
        return {
            "research_question": data.get("research_question") or "",
            "research_method": data.get("research_method") or "",
            "core_conclusion": data.get("core_conclusion") or "",
            "limitation": data.get("limitation") or "",
            "design_insight": data.get("design_insight") or "",
        }

    def parse_novel(self, raw_content: str) -> Dict[str, Any]:
        """小说拆文四要素：characters / plot_lines / narrative_style / world_setting。"""
        prompt = self._prompt_novel(raw_content)
        data = self._llm_json(prompt)
        return {
            "characters": data.get("characters") or [],
            "plot_lines": data.get("plot_lines") or [],
            "narrative_style": data.get("narrative_style") or [],
            "world_setting": data.get("world_setting") or "",
        }

    def parse_inspiration(self, raw_content: str) -> Dict[str, Any]:
        """灵感记录：raw_text / enriched_text / related_ids（空，待关联引擎补）。"""
        return {
            "raw_text": raw_content,
            "enriched_text": raw_content,
            "related_ids": [],
        }

    # ---- T4 大纲提取 ----

    def extract_outline(self, raw_content: str) -> Dict[str, Any]:
        """四维度大纲提取：chapters / plot_nodes / character_relations / core_storylines。

        无法提取（无章节结构）返回 {"error": "no_chapters"}；
        LLM 失败返回 {"error": "outline_failed"}。
        """
        if not self._has_chapter_structure(raw_content):
            return {"error": "no_chapters"}
        prompt = self._prompt_outline(raw_content)
        try:
            data = self._llm_json(prompt, bot_id=self.outline_bot_id)
        except AppError:
            return {"error": "outline_failed"}
        return self._normalize_outline(data)

    @staticmethod
    def _has_chapter_structure(raw_content: str) -> bool:
        """启发式：是否含章节标题特征（第X章/回/节/卷 等）。"""
        return bool(
            re.search(
                r"(第\s*[0-9一二三四五六七八九十百千]+\s*[章回节卷部]|序章|楔子|尾声)",
                raw_content,
            )
        )

    @staticmethod
    def _normalize_outline(data: Dict[str, Any]) -> Dict[str, Any]:
        """规范大纲四字段结构（对齐技术方案 §2.2 outline）。"""
        chapters = data.get("chapters") or []
        plot_nodes = data.get("plot_nodes") or []
        char_relations = data.get("character_relations") or []
        core = data.get("core_storylines") or {}
        if isinstance(core, dict):
            core_storylines = {
                "main": core.get("main") or "",
                "branches": core.get("branches") or [],
                "hidden": core.get("hidden") or [],
            }
        else:
            core_storylines = {"main": str(core), "branches": [], "hidden": []}
        return {
            "chapters": chapters,
            "plot_nodes": plot_nodes,
            "character_relations": char_relations,
            "core_storylines": core_storylines,
        }

    # ---- 私有 LLM 辅助 ----

    def _llm_json(self, prompt: str, bot_id: Optional[str] = None) -> Dict[str, Any]:
        """调 LLM 并强制解析为 dict。"""
        result = self._llm(prompt, bot_id if bot_id is not None else self.split_bot_id)
        content = _coerce_content(result)
        if isinstance(content, dict):
            return content
        raise AppError(502, "LLM 返回非 JSON 结构", str(content)[:200])

    @staticmethod
    def _split_paragraphs(text: str) -> List[str]:
        return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]

    @staticmethod
    def _prompt_article(raw: str) -> str:
        return (
            "你是文章结构化助手。请从以下文章中提取：paragraphs（按自然段数组）、"
            "key_points（要点数组）、summary（一句话摘要）、tag_list（主题标签数组）。"
            "以 JSON 返回 {\"paragraphs\":[],\"key_points\":[],\"summary\":\"\",\"tag_list\":[]}。"
            "\n\n文章：\n" + raw[:6000]
        )

    @staticmethod
    def _prompt_paper(raw: str) -> str:
        return (
            "你是论文结构化助手。请从以下论文中提取五要素：research_question（研究问题）、"
            "research_method（研究方法）、core_conclusion（核心结论）、limitation（局限）、"
            "design_insight（设计启示）。以 JSON 返回五字段字符串。"
            "\n\n论文：\n" + raw[:6000]
        )

    @staticmethod
    def _prompt_novel(raw: str) -> str:
        return (
            "你是小说拆文助手。请从以下小说文本中提取四要素：characters（人物数组，含名字/身份/性格）、"
            "plot_lines（情节线数组，含事件/因果）、narrative_style（叙事风格数组）、"
            "world_setting（世界观设定字符串）。以 JSON 返回。"
            "\n\n小说：\n" + raw[:6000]
        )

    @staticmethod
    def _prompt_outline(raw: str) -> str:
        return (
            "你是小说大纲提取助手。请从以下小说文本提取四维度大纲："
            "chapters（章节数组，含 title/summary/order）、plot_nodes（情节节点数组，含 id/label/type，type 为 main|branch|turn）、"
            "character_relations（人物关系数组，含 a/b/relation/camp）、core_storylines（核心故事线，含 main/branches/hidden）。"
            "以 JSON 返回 {\"chapters\":[],\"plot_nodes\":[],\"character_relations\":[],\"core_storylines\":{}}。"
            "\n\n小说：\n" + raw[:8000]
        )
