# -*- coding: utf-8 -*-
"""F6 剧情推衍聊天室接口层（/api/story/*）。

对齐 F6 技术方案 §3 接口设计（3.1~3.9）与 §4.1 状态机。
边界：本模块只做参数校验与协议转换，核心逻辑在 story_engine / random_system /
story_thread；错误统一抛 AppError 由 app.py 全局处理。
"""

from __future__ import annotations

import json
from typing import Any, Dict

from flask import Blueprint, Response, jsonify, request, stream_with_context

from .common.errors import AppError, bad_request, not_found
from .common.storage import now_iso
from . import story_engine, story_thread
from .random_system import RandomSystem
from .story_engine import StoryEngine

bp = Blueprint("story", __name__, url_prefix="/api/story")

# 模块级装配（单例引擎 + 随机系统，注入 coze_client 默认调用器）
_engine = StoryEngine()
_random = RandomSystem()


# ---------- 辅助 ----------

def _ok(data: Any, message: str = "ok") -> Response:
    return jsonify({"code": 0, "data": data, "message": message})


def _room_or_404(room_id: str) -> Dict[str, Any]:
    room = story_thread.get_room(room_id)
    if room is None:
        raise not_found("聊天室不存在", room_id)
    return room


# ---------- 3.1 创建聊天室 ----------

@bp.route("/rooms", methods=["POST"])
def create_room():
    body = request.get_json(silent=True) or {}
    room = story_engine.init_room(body)
    story_thread.create_room(room)
    return _ok({"room_id": room["id"]})


# ---------- 3.2 列出所有聊天室 ----------

@bp.route("/rooms", methods=["GET"])
def list_rooms():
    rooms = story_thread.list_rooms()
    return _ok({"rooms": rooms})


# ---------- 3.3 聊天室详情（含历史） ----------

@bp.route("/rooms/<room_id>", methods=["GET"])
def room_detail(room_id: str):
    with story_thread.with_room(room_id, "r") as room:
        return _ok(room)


# ---------- 3.4 推衍一步（同步） ----------

@bp.route("/rooms/<room_id>/step", methods=["POST"])
def advance_step(room_id: str):
    body = request.get_json(silent=True) or {}
    with story_thread.with_room(room_id, "w") as room:
        if body.get("random_enabled") is not None:
            room["random_enabled"] = bool(body.get("random_enabled"))
        step = _engine.advance_step(room)
        # 用户 override_content / branch_choice 覆盖（编辑本步）
        override = (body.get("override_content") or "").strip()
        if override:
            step["content"] = override
        if body.get("branch_choice"):
            step["selected_branch"] = body.get("branch_choice")
        return _ok({"step": step, "status": room.get("status")})


# ---------- 3.5 确认本步并进入下一步 ----------

@bp.route("/rooms/<room_id>/continue", methods=["POST"])
def continue_room(room_id: str):
    body = request.get_json(silent=True) or {}
    with story_thread.with_room(room_id, "w") as room:
        if room.get("status") == "finished":
            raise bad_request("聊天室已结束")
        final_content = (body.get("final_content") or "").strip()
        if final_content:
            # 回写最后一步内容（编辑确认）
            if room.get("history"):
                room["history"][-1]["content"] = final_content
        if body.get("branch_choice"):
            room["history"][-1]["selected_branch"] = body.get("branch_choice")
        # 配置实时调整（可选）
        updates = body.get("config_updates") or {}
        if updates:
            story_engine.apply_config_updates(room, updates)
        # 进入 running，前端随后调 SSE 或 step
        room["status"] = "running"
        return _ok({"status": room.get("status")})


# ---------- 3.6 推衍流式反馈（SSE） ----------

@bp.route("/rooms/<room_id>/stream", methods=["POST"])
def stream_step(room_id: str):
    def _gen():
        yield _sse({"stage": "generating"})
        try:
            with story_thread.with_room(room_id, "w") as room:
                if room.get("status") == "finished":
                    raise bad_request("聊天室已结束")
                ctx = _engine.build_context(room)
                content = _engine._gen_step(ctx)
                event = _random.roll_event(room)
                new_char = _random.roll_enter(room)
                if event:
                    yield _sse({"stage": "rolling", "event": event.get("id", "")})
                    content = _engine._apply_event(content, event)
                if new_char and new_char not in room.get("characters", []):
                    room["characters"].append(new_char)
                branches = _engine._gen_branches(ctx, content)
                step = {
                    "step_no": room.get("step_index", 0) + 1,
                    "content": content,
                    "event_triggered": event,
                    "new_character": new_char,
                    "branches": branches,
                    "created_at": now_iso(),
                }
                room.setdefault("history", []).append(step)
                room["step_index"] = room.get("step_index", 0) + 1
                room["status"] = "paused"
                # 分片推送 delta
                chunk = 120
                for i in range(0, len(content), chunk):
                    yield _sse({"delta": content[i:i + chunk]})
                yield _sse({"done": True, "step": step, "status": "paused"})
        except AppError as e:
            yield _sse({"error": {"code": e.code, "message": e.message, "detail": e.detail}})
        except Exception as e:  # noqa: BLE001
            yield _sse({"error": {"code": 500, "message": "推衍失败", "detail": str(e)}})

    return Response(stream_with_context(_gen()), mimetype="text/event-stream")


def _sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


# ---------- 3.7 角色拉入 / 随机入场 ----------

@bp.route("/rooms/<room_id>/characters", methods=["POST"])
def pull_characters(room_id: str):
    body = request.get_json(silent=True) or {}
    chars = body.get("characters") or []
    with story_thread.with_room(room_id, "w") as room:
        existing = room.setdefault("characters", [])
        for c in chars:
            if c and c not in existing:
                existing.append(c)
        random_entered = None
        if body.get("random_enter"):
            random_entered = _random.roll_enter(room)
            if random_entered and random_entered not in existing:
                existing.append(random_entered)
        return _ok({"characters": existing, "random_entered": random_entered})


# ---------- 3.8 配置实时编辑 ----------

@bp.route("/rooms/<room_id>", methods=["PUT"])
def update_room(room_id: str):
    body = request.get_json(silent=True) or {}
    with story_thread.with_room(room_id, "w") as room:
        story_engine.apply_config_updates(room, body)
        return _ok({"status": "updated"})


# ---------- 3.9 关闭/销毁聊天室 ----------

@bp.route("/rooms/<room_id>", methods=["DELETE"])
def delete_room(room_id: str):
    _room_or_404(room_id)
    deleted = story_thread.drop_room(room_id)
    return _ok({"deleted": bool(deleted)})
