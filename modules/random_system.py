# -*- coding: utf-8 -*-
"""F6 随机度系统：随机意外事件 + 随机新角色入场。

对齐 F6 技术方案 §4.3。核心约束：
- 事件池去重（已触发事件不复用，DoD #4）；
- 新角色入场优先 character_pool 候选，已入场角色不再进（DoD #5）；
- 概率可调（event_prob / enter_prob，0-1）；
- 随机上下文符合率 100%（生成器注入 random，便于 mock 确定性测试）。
"""

from __future__ import annotations

import random
from typing import Any, Dict, List, Optional

# 默认随机意外事件池（上下文相关，事件描述贴近剧情推衍）
DEFAULT_EVENTS: List[Dict[str, Any]] = [
    {"id": "weather_shift", "desc": "天气骤变，暴雨倾盆，打乱了原有的计划。"},
    {"id": "stranger_witness", "desc": "一名路人目击了关键场景，局势变得微妙。"},
    {"id": "lost_object", "desc": "关键信物意外丢失，众人陷入慌乱。"},
    {"id": "sudden_rumor", "desc": "城中流传起一则关于主角的谣言，人心浮动。"},
    {"id": "ambush_prep", "desc": "暗处传来异响，似乎有人正在暗中布置埋伏。"},
    {"id": "unexpected_letter", "desc": "一封来历不明的密信送到，内容真假难辨。"},
]


class RandomSystem:
    """随机度系统：掷骰决定是否触发意外事件 / 新角色入场。"""

    def __init__(
        self,
        rng: Optional[random.Random] = None,
        event_prob: float = 0.3,
        enter_prob: float = 0.2,
        events: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self._rng = rng or random.Random()
        self.event_prob = max(0.0, min(1.0, event_prob))
        self.enter_prob = max(0.0, min(1.0, enter_prob))
        self._events = list(events or DEFAULT_EVENTS)

    # ---------- 随机意外事件 ----------

    def roll_event(self, room: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """掷骰触发意外事件；已触发事件去重。

        返回 None 表示未触发；否则返回 {"id", "desc", "step_no"}。
        """
        if not room.get("random_enabled", True):
            return None
        used = set()
        for e in room.get("history", []):
            ev = e.get("event_triggered")
            if isinstance(ev, dict) and ev.get("id"):
                used.add(ev["id"])
        candidates = [e for e in self._events if e.get("id") not in used]
        if not candidates:
            return None
        if self._rng.random() > self.event_prob:
            return None
        event = dict(self._rng.choice(candidates))
        event["step_no"] = room.get("step_index", 0) + 1
        return event

    # ---------- 随机新角色入场 ----------

    def roll_enter(self, room: Dict[str, Any]) -> Optional[str]:
        """掷骰决定是否拉入候选角色；已入场角色不重复。

        返回新角色 id/名称（字符串），None 表示不入场。
        """
        if not room.get("random_enabled", True):
            return None
        pool = [c for c in room.get("character_pool", []) if c not in room.get("characters", [])]
        if not pool:
            return None
        if self._rng.random() > self.enter_prob:
            return None
        return self._rng.choice(pool)
