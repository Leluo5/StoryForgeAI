# -*- coding: utf-8 -*-
"""F6 推衍引擎：数据模型（story_room）+ 推衍状态机 + 分支生成。

对齐 F6 技术方案 §2 数据模型 / §4.1 状态机 / §4.5 分支生成。
存储形态：会话级内存实例（多线程隔离在 story_thread.py），不持久化到 DB（F6 边界）。

边界：本模块不 import 知识库/角色模块任何符号；角色 id 由调用方注入（字符串列表），
LLM 经注入 callable 调用（便于 mock）。
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional

from .common.errors import AppError, bad_request
from .common.storage import new_id, now_iso
from coze_client import CozeClient

# 状态白名单（F6 技术方案 §4.1 状态机）
ROOM_STATUSES = {"idle", "running", "paused", "finished"}

# 分支生成兜底（LLM 失败/非法时使用，符合上下文逻辑）
_DEFAULT_BRANCHES = ["A 继续推进", "B 暂缓观察", "C 另寻线索"]


def _default_llm(prompt: str, bot_id: str = "") -> Dict[str, Any]:
    """默认 LLM 调用器：经 coze_client.chat(bot_id, user_message)。"""
    client = CozeClient()
    return client.chat(bot_id, prompt)


def _coerce_text(result: Dict[str, Any]) -> str:
    """从 LLM 结果取文本 content；失败抛 502。"""
    if not result.get("success"):
        raise AppError(502, "LLM 调用失败", result.get("error", ""))
    content = result.get("content")
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    # dict/list 结果：尝试 JSON 序列化
    try:
        return json.dumps(content, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(content)


def _coerce_json(result: Dict[str, Any]) -> Any:
    """从 LLM 结果解析 JSON content（剥代码围栏）；失败返回 None。"""
    if not result.get("success"):
        raise AppError(502, "LLM 调用失败", result.get("error", ""))
    content = result.get("content")
    if isinstance(content, (dict, list)):
        return content
    if not isinstance(content, str):
        return None
    stripped = content.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL)
    if fence:
        stripped = fence.group(1).strip()
    try:
        return json.loads(stripped)
    except (ValueError, TypeError):
        return None


def init_room(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """构造 story_room 实例，校验必填（场所/背景）。

    对齐 F6 技术方案 §2.1：id/name/place/background/time_node/premise_plots/
    related_plots/characters/random_enabled/step_index/status/history。
    额外 character_pool 为随机入场候选角色池（角色库来源，由调用方注入）。
    """
    place = (cfg.get("place") or "").strip()
    background = (cfg.get("background") or "").strip()
    if not place:
        raise bad_request("请补充故事场所")
    if not background:
        raise bad_request("请补充核心剧情背景")

    room: Dict[str, Any] = {
        "id": (cfg.get("id") or new_id()).strip(),
        "name": (cfg.get("name") or "").strip(),
        "place": place,
        "background": background,
        "time_node": (cfg.get("time_node") or "").strip(),
        "premise_plots": list(cfg.get("premise_plots") or []),
        "related_plots": list(cfg.get("related_plots") or []),
        "characters": list(cfg.get("characters") or []),
        "character_pool": list(cfg.get("character_pool") or []),
        "random_enabled": bool(cfg.get("random_enabled", True)),
        "step_index": 0,
        "status": "idle",
        "history": [],
        "created_at": now_iso(),
    }
    return room


def apply_config_updates(room: Dict[str, Any], updates: Dict[str, Any]) -> None:
    """配置实时编辑（F6 §3.8 / DoD #11）：白名单字段子集，不中断线程。

    允许更新：name/place/background/time_node/premise_plots/related_plots/
    characters/character_pool/random_enabled。place/background 非空校验。
    """
    allowed = {
        "name", "place", "background", "time_node",
        "premise_plots", "related_plots",
        "characters", "character_pool", "random_enabled",
    }
    for key, value in updates.items():
        if key not in allowed:
            raise bad_request(f"非法配置字段: {key}")
        if key in ("premise_plots", "related_plots", "characters", "character_pool"):
            room[key] = list(value or [])
        elif key == "random_enabled":
            room[key] = bool(value)
        elif key in ("place", "background"):
            v = (value or "").strip()
            if not v:
                label = "故事场所" if key == "place" else "核心剧情背景"
                raise bad_request(f"请补充{label}")
            room[key] = v
        else:
            room[key] = value


class StoryEngine:
    """推衍状态机：advance_step 完成一步 → status=paused（一步一断，DoD #8）。"""

    def __init__(
        self,
        llm: Optional[Callable[[str, str], Dict[str, Any]]] = None,
        random_system: Optional[Any] = None,
        bot_id: str = "",
    ) -> None:
        self._llm = llm or _default_llm
        self._random = random_system
        self.bot_id = bot_id

    # ---------- 上下文 ----------

    def build_context(self, room: Dict[str, Any]) -> Dict[str, Any]:
        """组装推衍上下文：配置 + 角色 + 前序历史（F6 §4.1 步 1）。"""
        return {
            "place": room.get("place", ""),
            "background": room.get("background", ""),
            "time_node": room.get("time_node", ""),
            "premise_plots": list(room.get("premise_plots") or []),
            "related_plots": list(room.get("related_plots") or []),
            "characters": list(room.get("characters") or []),
            "step_index": room.get("step_index", 0),
            "recent_history": [h.get("content", "") for h in room.get("history", [])[-3:]],
        }

    # ---------- 生成步骤 ----------

    def gen_step(self, ctx: Dict[str, Any]) -> str:
        """生成本步剧情内容（Coze 智能体，符合上下文）。公开接口。"""
        prompt = self._step_prompt(ctx)
        return _coerce_text(self._llm(prompt, self.bot_id))

    def _step_prompt(self, ctx: Dict[str, Any]) -> str:
        chars = "、".join(ctx.get("characters") or []) or "（无角色）"
        history = "；".join(ctx.get("recent_history") or []) or "（无前序）"
        place = ctx.get("place") or ""
        background = ctx.get("background") or ""
        time_node = ctx.get("time_node") or ""
        premise_plots = ctx.get("premise_plots") or ""
        related_plots = ctx.get("related_plots") or ""
        step_index = ctx.get("step_index", 0)
        return (
            f"你是小说剧情推衍引擎。当前故事场所「{place}」，"
            f"核心剧情背景「{background}」，时间节点「{time_node}」。\n"
            f"聊天室参与角色：{chars}。重要前置剧情：{premise_plots}。"
            f"关联剧情：{related_plots}。\n"
            f"前序剧情（最近）：{history}。\n"
            f"请推衍下一步剧情（第 {step_index + 1} 步），"
            f"输出一段连贯、符合背景与角色设定的剧情文字，直接输出正文，不要编号。"
        )

    # ---------- 分支生成（T5） ----------

    def gen_branches(self, ctx: Dict[str, Any], content: str) -> List[str]:
        """LLM 生成 2-4 个分支选项；非法/重复降级默认分支。公开接口。"""
        bg = ctx.get("background") or ""
        plc = ctx.get("place") or ""
        chrs = ctx.get("characters") or ""
        prompt = (
            f"基于以下剧情生成 2-4 个可选分支走向，每个分支用简短短语，符合剧情逻辑：\n"
            f"背景：{bg}｜场所：{plc}｜角色：{chrs}\n"
            f"本步剧情：{content[:500]}\n"
            f"返回 JSON 字符串数组，如 [\"A 追问线索\", \"B 按兵不动\"]。"
        )
        raw = _coerce_json(self._llm(prompt, self.bot_id))
        branches = self._normalize_branches(raw)
        return branches

    @staticmethod
    def _normalize_branches(raw: Any) -> List[str]:
        """规整分支为 2-4 个不重复非空项；非法降级默认。"""
        if not isinstance(raw, list):
            return list(_DEFAULT_BRANCHES)
        out: List[str] = []
        for item in raw:
            if not isinstance(item, str):
                continue
            s = item.strip()
            if not s or s in out:
                continue
            out.append(s)
        if len(out) < 2:
            # 冲突/非法分支：补默认，前端提示重选（F6 异常表「分支选项冲突」）
            for default in _DEFAULT_BRANCHES:
                if default not in out:
                    out.append(default)
                if len(out) >= 4:
                    break
        return out[:4]

    # ---------- 状态机主流程（T2） ----------

    def advance_step(self, room: Dict[str, Any]) -> Dict[str, Any]:
        """推衍一步：idle/running → paused（一步一断）。

        - 无角色 → 400「请先拉入至少 1 名角色」。
        - 已 finished → 400「聊天室已结束」。
        - 生成失败保持 paused（F6 异常表「推衍引擎调用失败」），不抛异常。
        """
        if room.get("status") == "finished":
            raise bad_request("聊天室已结束")
        if not room.get("characters"):
            raise bad_request("请先拉入至少 1 名角色")

        room["status"] = "running"
        ctx = self.build_context(room)
        step = self._roll_step(room, ctx)
        self._commit_step(room, step)
        return step

    def _roll_step(self, room: Dict[str, Any], ctx: Dict[str, Any]) -> Dict[str, Any]:
        """生成并装配本步（内容 + 随机事件/角色 + 分支）；失败保持 paused 并重抛。"""
        try:
            content = self.gen_step(ctx)
            event, new_char = self._roll_random(room, content)
            branches = self.gen_branches(ctx, content)
        except AppError:
            # 生成/分支失败：保留当前步编辑内容，保持 paused 供重试，不追加 step
            room["status"] = "paused"
            raise
        return {
            "step_no": room.get("step_index", 0) + 1,
            "content": content,
            "event_triggered": event,
            "new_character": new_char,
            "branches": branches,
            "created_at": now_iso(),
        }

    def _roll_random(
        self, room: Dict[str, Any], content: str,
    ) -> tuple:
        """随机度系统掷骰（T3）：返回 (event, new_char)，并就地追加新入场角色。"""
        if self._random is None:
            return None, None
        event = self._random.roll_event(room)
        new_char = self._random.roll_enter(room)
        if event:
            content = self.apply_event(content, event)
        if new_char and new_char not in room.get("characters", []):
            room["characters"].append(new_char)
        return event, new_char

    def _commit_step(self, room: Dict[str, Any], step: Dict[str, Any]) -> None:
        """落盘本步：追加 history、步进 step_index、置 paused（一步一断 DoD #8）。"""
        room.setdefault("history", []).append(step)
        room["step_index"] = room.get("step_index", 0) + 1
        room["status"] = "paused"

    @staticmethod
    def apply_event(content: str, event: Dict[str, Any]) -> str:
        """随机意外事件改写当前步（追加事件描述，F6 §3.3）。公开接口。"""
        desc = event.get("desc", "")
        if not desc:
            return content
        return f"{content}\n\n【意外事件】{desc}"
