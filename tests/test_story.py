# -*- coding: utf-8 -*-
"""F6 剧情推衍聊天室单测：数据模型 / 状态机 / 随机系统 / 多线程隔离 / 接口契约。

对齐 F6 技术方案 §4 核心逻辑与 §7 DoD。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules import story_engine, story_thread
from modules.random_system import RandomSystem
from modules.story_engine import StoryEngine, init_room


# ---------- 工具：构造 LLM 调用器 ----------

def make_llm(step_text="林远推开房门，发现桌上留有一封密信。", branches=None, fail=False):
    def llm(prompt, bot_id=""):
        if fail:
            return {"success": False, "error": "LLM down"}
        if "分支" in prompt or "branches" in prompt or "2-4" in prompt:
            return {"success": True, "content": branches or ["A 追问线索", "B 按兵不动"]}
        return {"success": True, "content": step_text}
    return llm


def make_rng(rolls):
    """固定序列掷骰器。"""
    import random
    rng = random.Random()
    state = {"idx": 0}
    orig = rng.random
    def fixed():
        v = rolls[state["idx"] % len(rolls)]
        state["idx"] += 1
        return v
    rng.random = fixed
    return rng


def base_cfg():
    return {
        "name": "雨夜破庙",
        "place": "破庙",
        "background": "主角追寻失落的龙族秘宝",
        "time_node": "深夜",
        "premise_plots": ["秘宝现世"],
        "related_plots": ["龙族传说"],
        "characters": ["林远", "苏晚"],
        "character_pool": ["萧烈", "顾长青"],
    }


# ---------- T1 数据模型 ----------

class TestInitRoom:
    def test_ok_full(self):
        room = init_room(base_cfg())
        assert room["place"] == "破庙"
        assert room["background"].startswith("主角追寻")
        assert room["status"] == "idle"
        assert room["step_index"] == 0
        assert room["history"] == []
        assert room["random_enabled"] is True
        assert room["id"]

    def test_missing_place_400(self):
        cfg = base_cfg(); cfg["place"] = ""
        with pytest.raises(AppError) as e:
            init_room(cfg)
        assert e.value.code == 400
        assert "场所" in e.value.message

    def test_missing_background_400(self):
        cfg = base_cfg(); cfg["background"] = "  "
        with pytest.raises(AppError) as e:
            init_room(cfg)
        assert e.value.code == 400

    def test_apply_config_updates(self):
        room = init_room(base_cfg())
        story_engine.apply_config_updates(room, {
            "name": "雨夜城楼", "random_enabled": False, "characters": ["林远"],
        })
        assert room["name"] == "雨夜城楼"
        assert room["random_enabled"] is False
        assert room["characters"] == ["林远"]

    def test_apply_updates_bad_field(self):
        room = init_room(base_cfg())
        with pytest.raises(AppError) as e:
            story_engine.apply_config_updates(room, {"evil": 1})
        assert e.value.code == 400


# ---------- T2 状态机 ----------

class TestAdvanceStep:
    def test_single_step_paused(self):
        room = init_room(base_cfg())
        eng = StoryEngine(llm=make_llm(), random_system=None)
        step = eng.advance_step(room)
        assert room["status"] == "paused"  # 一步一断
        assert room["step_index"] == 1
        assert len(room["history"]) == 1
        assert step["step_no"] == 1
        assert "密信" in step["content"]
        assert len(step["branches"]) >= 2

    def test_no_characters_400(self):
        cfg = base_cfg(); cfg["characters"] = []
        room = init_room(cfg)
        eng = StoryEngine(llm=make_llm(), random_system=None)
        with pytest.raises(AppError) as e:
            eng.advance_step(room)
        assert e.value.code == 400
        assert "角色" in e.value.message

    def test_finished_reject(self):
        room = init_room(base_cfg()); room["status"] = "finished"
        eng = StoryEngine(llm=make_llm(), random_system=None)
        with pytest.raises(AppError) as e:
            eng.advance_step(room)
        assert e.value.code == 400
        assert "结束" in e.value.message

    def test_llm_fail_keeps_paused(self):
        room = init_room(base_cfg())
        eng = StoryEngine(llm=make_llm(fail=True), random_system=None)
        with pytest.raises(AppError) as e:
            eng.advance_step(room)
        assert e.value.code == 502
        # 失败保持 paused，历史不追加
        assert room["status"] == "paused"
        assert room["history"] == []

    def test_step_index_increments(self):
        room = init_room(base_cfg())
        eng = StoryEngine(llm=make_llm(), random_system=None)
        eng.advance_step(room)
        eng.advance_step(room)
        assert room["step_index"] == 2
        assert room["history"][1]["step_no"] == 2


# ---------- T3 随机系统 ----------

class TestRandomSystem:
    def test_event_triggers(self):
        rng = make_rng([0.0, 0.5])  # 0.0 <= event_prob → 触发
        rs = RandomSystem(rng=rng, event_prob=0.3)
        room = init_room(base_cfg())
        event = rs.roll_event(room)
        assert event is not None
        assert event["desc"]
        assert event["step_no"] == 1

    def test_event_dedup(self):
        rng = make_rng([0.0])
        rs = RandomSystem(rng=rng, event_prob=0.3, events=[{"id": "only", "desc": "唯一事件"}])
        room = init_room(base_cfg())
        e1 = rs.roll_event(room)
        assert e1 is not None
        # 已触发事件不复用（模拟历史含该事件）
        room["history"].append({"event_triggered": {"id": "only"}})
        e2 = rs.roll_event(room)
        assert e2 is None

    def test_event_disabled(self):
        rs = RandomSystem(event_prob=0.9)
        cfg = base_cfg(); cfg["random_enabled"] = False
        room = init_room(cfg)
        assert rs.roll_event(room) is None

    def test_enter_char_from_pool(self):
        rng = make_rng([0.0])
        rs = RandomSystem(rng=rng, enter_prob=0.2)
        room = init_room(base_cfg())
        c = rs.roll_enter(room)
        assert c in ("萧烈", "顾长青")

    def test_enter_dedup(self):
        rng = make_rng([0.0])
        rs = RandomSystem(rng=rng, enter_prob=0.2)
        cfg = base_cfg(); cfg["character_pool"] = ["萧烈"]
        room = init_room(cfg)
        room["characters"].append("萧烈")  # 已入场
        assert rs.roll_enter(room) is None


# ---------- T5 分支 ----------

class TestBranches:
    def test_normalize_2_to_4(self):
        raw = ["A 追", "B 守", "C 走"]
        out = StoryEngine._normalize_branches(raw)
        assert 2 <= len(out) <= 4
        assert out[0] == "A 追"

    def test_normalize_dedup(self):
        out = StoryEngine._normalize_branches(["A", "A", "B", "B"])
        assert len(set(out)) == len(out)

    def test_normalize_bad_fallback(self):
        out = StoryEngine._normalize_branches(["单条"])
        assert len(out) >= 2  # 降级补默认


# ---------- T4 多线程隔离 ----------

class TestStoryThread:
    def test_create_and_get(self):
        story_thread._rooms.clear()
        room = init_room(base_cfg())
        story_thread.create_room(room)
        assert story_thread.get_room(room["id"]) is not None
        assert len(story_thread.list_rooms()) == 1

    def test_capacity_limit(self):
        story_thread._rooms.clear()
        for i in range(story_thread.MAX_ROOMS):
            story_thread.create_room(init_room(base_cfg()))
        with pytest.raises(AppError) as e:
            story_thread.create_room(init_room(base_cfg()))
        assert e.value.code == 409
        assert "容量" in e.value.message

    def test_with_room_404(self):
        story_thread._rooms.clear()
        with pytest.raises(AppError) as e:
            with story_thread.with_room("nope", "r"):
                pass
        assert e.value.code == 404

    def test_with_room_isolated(self):
        story_thread._rooms.clear()
        r1 = init_room(base_cfg()); r1["name"] = "甲"
        r2 = init_room(base_cfg()); r2["name"] = "乙"
        story_thread.create_room(r1); story_thread.create_room(r2)
        with story_thread.with_room(r1["id"], "w") as a:
            a["name"] = "甲改"
        with story_thread.with_room(r2["id"], "r") as b:
            assert b["name"] == "乙"  # 互不干扰

    def test_drop_room(self):
        story_thread._rooms.clear()
        room = init_room(base_cfg())
        story_thread.create_room(room)
        assert story_thread.drop_room(room["id"]) is True
        assert story_thread.get_room(room["id"]) is None
