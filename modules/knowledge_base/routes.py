# -*- coding: utf-8 -*-
"""知识库接口层（F5-T6）。

注册知识库全部接口。对齐：
- 接口契约 §5：`POST /api/knowledge`（创建条目）、`POST /api/knowledge/<id>/extract-outline`（大纲提取）。
- 技术方案 §3.1~§3.7：entries 系列完整路由。

统一响应 {"code": 0, "data": ..., "message": "ok"}；错误 {"code": <非0>, "data": null, "message": ...}。
"""

from __future__ import annotations

import base64
import io
import os
from datetime import datetime
from typing import Any, Dict

from flask import Blueprint, jsonify, request, send_file

from modules.common.errors import AppError, bad_request, not_found
from modules.knowledge_base.knowledge_linker import KnowledgeLinker
from modules.knowledge_base.knowledge_markdown import render_body_html
from modules.knowledge_base.knowledge_markdown_io import (
    build_preview_item,
    build_zip,
    decode_bytes,
    export_entries,
    import_files,
)
from modules.knowledge_base.knowledge_parser import KnowledgeParser, TypeUncertain
from modules.knowledge_base.knowledge_store import KnowledgeStore

# 蓝图
bp = Blueprint("knowledge", __name__, url_prefix="/api/knowledge")

# 数据目录（对齐全栈约定：项目根 data/knowledge/）
_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KNOWLEDGE_DATA_DIR = os.path.join(_BASE_DIR, "data", "knowledge")

# 组装领域对象（可被测试覆盖注入）
_store: KnowledgeStore = KnowledgeStore(KNOWLEDGE_DATA_DIR)
_parser = KnowledgeParser()
_linker = KnowledgeLinker()
_linker.set_store(_store)


def _ok(data: Any, message: str = "ok"):
    return jsonify({"code": 0, "data": data, "message": message})


def _err(code: int, message: str, detail: str = ""):
    msg = message if not detail else f"{message}: {detail}"
    return jsonify({"code": code, "data": None, "message": msg}), code


def _now_stamp() -> str:
    """当前时间戳（文件名用）：YYYYMMDD_HHMMSS。"""
    return datetime.now().strftime("%Y%m%d_%H%M%S")


# ---- 错误处理 ----

@bp.errorhandler(AppError)
def _handle_app_error(e: AppError):
    return _err(e.code, e.message, e.detail)


# ---- §3.1 创建条目（契约 §5.1 语义一致）----

@bp.route("", methods=["POST"])
def create_entry():
    """创建知识条目。

    请求：{"type": "article|paper|novel|inspiration", "title": "...", "raw_content": "...",
           "source": "manual", "tags": [], "file_id": ""}
    流程：检测类型 → 建条目（哈希查重）→ 拆分 → 灵感自动关联 → 返回结构化。
    """
    body = request.get_json(silent=True) or {}
    type_ = body.get("type", "")
    title = body.get("title", "")
    raw_content = body.get("raw_content", "")
    if not type_ or not title:
        raise bad_request("type 与 title 必填")

    # 手动指定类型兜底（type 不确定由前端传 manual_type）
    manual = body.get("manual_type")
    try:
        detected = _parser.detect_type(raw_content, manual) if type_ == "auto" else type_
    except TypeUncertain as e:
        return _err(e.code, e.message, "请通过 manual_type 指定类型")
    if detected not in ("article", "paper", "novel", "inspiration"):
        raise bad_request(f"非法类型: {detected}")

    entry = _store.create_entry(
        type_=detected,
        title=title,
        raw_content=raw_content,
        source=body.get("source", "manual"),
        structured={},
        tags=body.get("tags", []),
        file_id=body.get("file_id", ""),
    )
    # 拆分结构化
    structured = _parser.parse_entry(entry)
    entry["structured"] = structured
    # 灵感自动关联
    if detected == "inspiration":
        entry["structured"] = _linker.link_inspiration(entry)
    _store.save_entry(entry)
    return _ok({"id": entry["id"], "title": entry["title"], "type": detected,
                "structured": entry["structured"]})


# ---- §3.2 查询条目列表 ----

@bp.route("/entries", methods=["GET"])
def list_entries():
    """条目列表（四维过滤）。

    查询参数：keyword / type / tag / start_time / end_time / page / page_size。
    返回 {items, total}，item 为索引元数据。
    """
    q = request.args
    meta_list = _store.query_index(
        keyword=q.get("keyword"),
        type_=q.get("type"),
        tag=q.get("tag"),
        start_time=q.get("start_time"),
        end_time=q.get("end_time"),
    )
    try:
        page = max(1, int(q.get("page", 1) or 1))
        page_size = max(1, int(q.get("page_size", 20) or 20))
    except ValueError:
        raise bad_request("page/page_size 须为整数")
    start = (page - 1) * page_size
    items = meta_list[start : start + page_size]
    return _ok({"items": items, "total": len(meta_list)})


# ---- §3.3 条目详情 ----

@bp.route("/entries/<entry_id>", methods=["GET"])
def get_entry(entry_id: str):
    """条目完整详情（含 structured / links / body_html）。

    body_html：正文 Markdown 渲染为安全 HTML 片段，供前端直接展示富文本。
    """
    entry = _store.load_entry(entry_id)
    if entry is None:
        raise not_found("条目不存在")
    entry["body_html"] = render_body_html(entry.get("raw_content", ""))
    return _ok(entry)


# ---- §3.3b Markdown 渲染预览（正文语法升级）----

@bp.route("/markdown/render", methods=["POST"])
def render_markdown():
    """Markdown 渲染预览。请求：{"text": "..."}，返回 {"html": "..."}。

    供前端录入/编辑时实时预览富文本效果（不落库，纯渲染）。
    """
    body = request.get_json(silent=True) or {}
    text = body.get("text", "") or ""
    return _ok({"html": render_body_html(text)})


# ---- §3.4 更新条目 ----

@bp.route("/entries/<entry_id>", methods=["PUT"])
def update_entry(entry_id: str):
    """更新条目（title/tags/structured 部分字段）。"""
    entry = _store.load_entry(entry_id)
    if entry is None:
        raise not_found("条目不存在")
    body = request.get_json(silent=True) or {}
    if "title" in body:
        entry["title"] = body["title"]
    if "tags" in body:
        entry["tags"] = body["tags"]
    if "structured" in body:
        entry["structured"] = body["structured"]
    _store.save_entry(entry)
    return _ok({"id": entry["id"]})


# ---- §3.5 删除条目（清理引用）----

@bp.route("/entries/<entry_id>", methods=["DELETE"])
def delete_entry(entry_id: str):
    """删除条目；同时从所有关联条目的 links 中清理对该条的引用。"""
    entry = _store.load_entry(entry_id)
    if entry is None:
        raise not_found("条目不存在")
    # 清理其他条目对该条的引用
    for meta in _store.load_index().get("items", []):
        other = _store.load_entry(meta["id"])
        if other and entry_id in other.get("links", []):
            other["links"] = [l for l in other["links"] if l != entry_id]
            _store.save_entry(other)
    _store.delete_entry(entry_id)
    return _ok({"id": entry_id})


# ---- §3.6 灵感关联检索 ----

@bp.route("/entries/<entry_id>/similar", methods=["GET"])
def get_similar(entry_id: str):
    """检索与指定条目最相似的候选（灵感关联用）。"""
    entry = _store.load_entry(entry_id)
    if entry is None:
        raise not_found("条目不存在")
    text = entry.get("raw_content", "")
    candidates = _linker.search_similar(text, exclude_ids=[entry_id])
    return _ok({"candidates": candidates})


@bp.route("/entries/<entry_id>/links", methods=["POST"])
def add_link(entry_id: str):
    """手动关联条目（双向）。请求：{"target_id": "..."}。"""
    body = request.get_json(silent=True) or {}
    target_id = body.get("target_id", "")
    if not target_id:
        raise bad_request("target_id 必填")
    links = _linker.add_link(entry_id, target_id)
    return _ok({"id": entry_id, "links": links})


@bp.route("/entries/<entry_id>/links/<target_id>", methods=["DELETE"])
def remove_link(entry_id: str, target_id: str):
    """解除关联（双向清理）。"""
    links = _linker.remove_link(entry_id, target_id)
    return _ok({"id": entry_id, "links": links})


# ---- §3.7 大纲提取（契约 §5.2 语义一致）----

@bp.route("/entries/<entry_id>/outline", methods=["POST"])
@bp.route("/<entry_id>/extract-outline", methods=["POST"])
def extract_outline(entry_id: str):
    """小说拆文后自动触发大纲四维提取。

    契约 §5.2 端点 `/<id>/extract-outline` 与技术方案 §3.7 `/entries/<id>/outline` 语义一致，
    两路由映射到同一处理（技术方案 §3 为权威口径，契约端点兼容）。
    """
    entry = _store.load_entry(entry_id)
    if entry is None:
        raise not_found("条目不存在")
    outline = _parser.extract_outline(entry.get("raw_content", ""))
    if outline.get("error"):
        return _ok({"outline": {}, "warning": outline["error"]})
    entry["structured"] = {**entry.get("structured", {}), "outline": outline}
    _store.save_entry(entry)
    return _ok({"outline": outline})


# ---- 类型识别（独立端点，供前端 manual 兜底）----

@bp.route("/detect-type", methods=["POST"])
def detect_type():
    """类型识别接口。请求：{"raw_content": "...", "manual": "可选"}。"""
    body = request.get_json(silent=True) or {}
    raw_content = body.get("raw_content", "")
    try:
        detected = _parser.detect_type(raw_content, body.get("manual"))
    except TypeUncertain as e:
        return _err(e.code, e.message)
    return _ok({"type": detected})


# ============================================================
# Markdown 导入导出（F5-T14，技术方案 §9.3）
# ============================================================

# 导出范围模式
_EXPORT_SCOPE_SINGLE = "single"      # 单条：entry_ids=[id]
_EXPORT_SCOPE_BATCH = "batch"        # 批量：entry_ids=[...]
_EXPORT_SCOPE_CATEGORY = "category"  # 分类：type / tag


def _collect_export_entries(body: Dict[str, Any]) -> list:
    """按导出范围收集条目（单条/批量/分类）。

    返回完整条目列表；单条/批量按 entry_ids，分类按 type/tag 经 query_index 收集。
    """
    scope = body.get("scope", _EXPORT_SCOPE_SINGLE)
    if scope in (_EXPORT_SCOPE_SINGLE, _EXPORT_SCOPE_BATCH):
        ids = body.get("entry_ids") or []
        entries = []
        for eid in ids:
            entry = _store.load_entry(eid)
            if entry:
                entries.append(entry)
        return entries
    if scope == _EXPORT_SCOPE_CATEGORY:
        meta_list = _store.query_index(
            type_=body.get("type"), tag=body.get("tag")
        )
        entries = []
        for meta in meta_list:
            entry = _store.load_entry(meta["id"])
            if entry:
                entries.append(entry)
        return entries
    raise bad_request(f"非法导出范围: {scope}")


def _decode_item_content(content: Any) -> str:
    """导入内容解码：接受 base64 字符串（前端 FileReader 转 base64）或纯文本。"""
    if isinstance(content, str):
        if content.startswith("data:"):
            # data URL：data:text/markdown;base64,...
            try:
                header, _, payload = content.partition(",")
                return base64.b64decode(payload).decode("utf-8")
            except Exception:  # noqa: BLE001
                return content
        return content
    if isinstance(content, (bytes, bytearray)):
        return decode_bytes(bytes(content))
    return str(content or "")


@bp.route("/markdown/export", methods=["POST"])
def export_markdown():
    """导出知识条目为 Markdown（技术方案 §9.3）。

    请求：{"scope": "single|batch|category", "entry_ids": [...]（single/batch）, "type"/"tag"（category）,
           "as_zip": true}。
    - 单条：直接下载 .md（`send_file`）。
    - 批量/分类：打包 ZIP 下载。
    - 返回：ZIP 场景下发流文件；单条场景发 .md 文件。均带 Content-Disposition 文件名。
    """
    body = request.get_json(silent=True) or {}
    entries = _collect_export_entries(body)
    if not entries:
        return _ok({"total": 0, "success": 0, "failed": 0, "failed_items": [],
                    "files": [], "zip_name": ""}, "该范围下无条目可导出")

    result = export_entries(entries, with_meta=True)
    as_zip = body.get("as_zip", False) or len(result["files"]) > 1

    if as_zip:
        zip_name = body.get("zip_name") or f"knowledge_export_{_now_stamp()}.zip"
        data = build_zip(result["files"], zip_name)
        buf = io.BytesIO(data)
        buf.seek(0)
        resp = send_file(buf, mimetype="application/zip", as_attachment=True,
                         download_name=zip_name)
        # 附结果统计（响应头），供前端读取
        resp.headers["X-Export-Total"] = str(len(result["files"]))
        resp.headers["X-Export-Failed"] = str(len(result["failed"]))
        return resp

    # 单条：直接下载 .md
    file_item = result["files"][0]
    buf = io.BytesIO(file_item["content"].encode("utf-8"))
    buf.seek(0)
    return send_file(buf, mimetype="text/markdown", as_attachment=True,
                     download_name=file_item["file_name"])


@bp.route("/markdown/import/preview", methods=["POST"])
def import_preview():
    """导入前预览（技术方案 §9.3 / 需求 MD-8）。

    请求：{"files": [{"file_name": "a.md", "content": "<base64或文本>"}]}
    返回：{"items": [import_preview_item], "total": n}。
    """
    body = request.get_json(silent=True) or {}
    files = body.get("files") or []
    items = []
    for f in files:
        file_name = f.get("file_name", "")
        content = _decode_item_content(f.get("content", ""))
        items.append(build_preview_item(file_name, content, _store))
    return _ok({"items": items, "total": len(items)})


@bp.route("/markdown/import", methods=["POST"])
def do_import():
    """执行导入（技术方案 §9.3 / 需求 MD-5~MD-11）。

    请求：{"files": [{"file_name", "content"}], "target_type": "novel",
           "conflict_strategy": "overwrite|rename|skip"}
    返回：{total, success, failed, failed_items, created, updated, skipped}。
    """
    body = request.get_json(silent=True) or {}
    files = body.get("files") or []
    target_type = body.get("target_type", "")
    strategy = body.get("conflict_strategy", "rename")
    if target_type not in ("article", "paper", "novel", "inspiration"):
        raise bad_request(f"非法目标类型: {target_type}")
    if strategy not in ("overwrite", "rename", "skip"):
        raise bad_request(f"非法冲突策略: {strategy}")

    # 解码全部内容（保持文件名与内容一一对应）
    decoded = []
    for f in files:
        decoded.append({
            "file_name": f.get("file_name", ""),
            "content": _decode_item_content(f.get("content", "")),
        })
    result = import_files(decoded, target_type, strategy, _store)
    return _ok(result)


@bp.route("/markdown/import/validate", methods=["POST"])
def import_validate():
    """单文件格式校验（技术方案 §9.3）。

    请求：{"file_name": "a.md", "content": "..."}
    返回：{valid, reason}。
    """
    body = request.get_json(silent=True) or {}
    file_name = body.get("file_name", "")
    content = _decode_item_content(body.get("content", ""))
    preview = build_preview_item(file_name, content, _store)
    return _ok({"valid": preview["valid"], "reason": preview["reason"]})
