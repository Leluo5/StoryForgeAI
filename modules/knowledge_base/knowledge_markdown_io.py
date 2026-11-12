# -*- coding: utf-8 -*-
"""知识库 Markdown 文件导入导出引擎（F5-T12 / F5-T13，Extension 2026-11-12）。

对齐技术方案 §9.2 模块设计，为知识库条目提供标准 Markdown 导入导出能力：

**导出侧（纯函数 + store 只读）**：
- `sanitize_filename(title)`：标题清洗非法字符，截断长度。
- `build_filename(title, ts)`：规范文件名（清洗标题 + 时间戳防冲突）。
- `build_export_markdown(entry)`：条目 → 标准 Markdown（元数据 HTML 注释 + 标题 H1 + 正文保原样）。
- `export_entries(entries, with_meta)`：批量渲染，单条失败记入 failed。
- `build_zip(file_items, zip_name)`：内存打包 ZIP，返回 bytes。

**导入侧（纯函数 + store 写入）**：
- `decode_bytes(raw)`：字节 → 文本（utf-8 优先 → gbk 兜底 → 抛 EncodingError）。
- `parse_markdown_text(text)`：Markdown → {title, raw_content, format_stats}（剥离导出元数据注释）。
- `detect_conflict(title, raw_content, existing_entries)`：判重（标题 + 内容哈希）。
- `import_files(file_items, target_type, conflict_strategy, store, progress_cb)`：批量导入 + 统计。

设计要点（对齐需求澄清 §8.4 决策）：
- **解耦**：本模块不 import `knowledge_store` 符号，通过 `store` 参数注入（依赖注入约定）。
- **内容一致性 100%（MD-14）**：导出正文直接取 `entry["raw_content"]` 原样，导入解析后
  `raw_content` 与源文件逐字符一致（仅剥离导出时注入的元数据注释，不影响用户正文）。
- **图片引用**：原样保留引用文本，不打包二进制（决策 §8.4）。
- **编码**：UTF-8 优先强制，失败才回退 GBK，减少误判（技术方案 §9.9 风险对策）。
"""

from __future__ import annotations

import hashlib
import io
import re
import zipfile
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

# 文件名非法字符（Windows 保留 + 控制符）
_INVALID_FILENAME_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
# 连续空白 / 首尾空白
_SPACE_RE = re.compile(r"\s+")
# 标题最大字符数
_TITLE_MAX = 60
# 文件名最大字符数（不含扩展名与时间戳）
_NAME_MAX = 80

# 导出元数据注释标记（置于文件头部；导入解析时剥离）
_META_COMMENT_OPEN = "<!-- knowledge-export"
_META_COMMENT_CLOSE = "-->"

# 支持的导入扩展名（对齐需求澄清 §8.7 仅支持 .md）
SUPPORTED_EXTENSIONS = (".md", ".markdown")

# 冲突原因
CONFLICT_IDENTICAL = "identical"
CONFLICT_NAME = "name_collision"
CONFLICT_NONE = ""


# ============================================================
# 导出侧
# ============================================================

def sanitize_filename(title: str) -> str:
    """标题清洗：非法字符 → 下划线，去除首尾空白，压缩连续空白，截断 80 字符。

    - Windows 非法字符 `\\/:*?"<>|` 及控制符 → `_`。
    - 去除首尾空白、压缩连续空白为单空格。
    - 结果截断至 `_NAME_MAX` 字符；空结果回退 "untitled"。
    """
    cleaned = _INVALID_FILENAME_RE.sub("_", title or "")
    cleaned = _SPACE_RE.sub(" ", cleaned).strip()
    cleaned = cleaned.strip(" .")  # Windows 文件名不允许结尾点/空格
    cleaned = cleaned.rstrip("_")  # 清洗产生的尾部下划线（如 a/b:c* → a_b_c_ → a_b_c）
    if not cleaned:
        cleaned = "untitled"
    return cleaned[:_NAME_MAX]


def build_filename(title: str, ts: Optional[datetime] = None) -> str:
    """规范文件名：`{sanitize(title)}_{YYYYMMDD_HHMMSS}.md`，时间戳防冲突。

    对齐需求澄清 MD-4：文件名含清洗后标题 + 时间戳，无冲突。
    """
    ts = ts or datetime.now()
    stamp = ts.strftime("%Y%m%d_%H%M%S")
    return f"{sanitize_filename(title)}_{stamp}.md"


def _meta_comment(entry: Dict[str, Any]) -> str:
    """构建导出元数据 HTML 注释（置于文件头部，导入解析时剥离）。"""
    eid = entry.get("id", "")
    etype = entry.get("type", "")
    etitle = entry.get("title", "")
    esource = entry.get("source", "")
    etags = ",".join(entry.get("tags", []) or [])
    ecreated = entry.get("created_at", "")
    eupdated = entry.get("updated_at", "")
    lines = [
        _META_COMMENT_OPEN,
        f"id: {eid}",
        f"type: {etype}",
        f"title: {etitle}",
        f"source: {esource}",
        f"tags: {etags}",
        f"created_at: {ecreated}",
        f"updated_at: {eupdated}",
        _META_COMMENT_CLOSE,
    ]
    return "\n".join(lines)


def build_export_markdown(entry: Dict[str, Any], with_meta: bool = True) -> str:
    """条目 → 标准 Markdown 文本。

    结构：可选元数据 HTML 注释头部 + `# 标题` + 空行 + 正文原样。
    - 正文直接取 `entry["raw_content"]`（已含 Markdown 语法），保真 100%（MD-14）。
    - 图片引用、代码块、列表等格式元素随正文原样保留。
    """
    title = entry.get("title", "") or "untitled"
    body = entry.get("raw_content", "") or ""
    parts: List[str] = []
    if with_meta:
        parts.append(_meta_comment(entry))
    parts.append(f"# {title}")
    parts.append("")
    # 正文原样（不重排、不规范化），保证导入再导出逐字符一致
    parts.append(body)
    return "\n".join(parts)


def export_entries(
    entries: List[Dict[str, Any]], with_meta: bool = True
) -> Dict[str, Any]:
    """批量条目 → `{files: [{file_name, content}], failed: [{id, reason}]}`。

    每条独立渲染，单条失败记入 failed（不中断整批，对齐需求澄清 §8.7）。
    """
    files: List[Dict[str, str]] = []
    failed: List[Dict[str, str]] = []
    for entry in entries:
        entry_id = entry.get("id", "")
        try:
            content = build_export_markdown(entry, with_meta=with_meta)
            files.append(
                {"file_name": build_filename(entry.get("title", "")), "content": content}
            )
        except Exception as exc:  # noqa: BLE001 - 单条失败不中断整批
            failed.append({"id": entry_id, "reason": f"export_error: {exc}"})
    return {"files": files, "failed": failed}


def build_zip(file_items: List[Dict[str, str]], zip_name: str = "knowledge_export.zip") -> bytes:
    """打包 ZIP（内存 BytesIO），返回 bytes 供 `send_file`。

    - 文件名冲突时自动追加序号（避免 ZIP 内重名覆盖）。
    - 使用 ZIP_DEFLATED 压缩。
    """
    buffer = io.BytesIO()
    seen: Dict[str, int] = {}
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in file_items:
            name = item.get("file_name", "untitled.md")
            # 防 ZIP 内重名
            if name in seen:
                seen[name] += 1
                base, ext = name.rsplit(".", 1) if "." in name else (name, "md")
                name = f"{base}_{seen[name]}.{ext}"
            else:
                seen[name] = 0
            zf.writestr(name, item.get("content", ""))
    buffer.seek(0)
    return buffer.getvalue()


# ============================================================
# 导入侧
# ============================================================

class EncodingError(ValueError):
    """文件解码失败（utf-8 / gbk 均失败）。"""


def decode_bytes(raw: bytes) -> str:
    """字节 → 文本：utf-8 优先强制 → gbk 兜底 → 均失败抛 `EncodingError`。

    对齐需求澄清 MD-13 / 技术方案 §9.9：utf-8 优先减少误判，失败才回退 gbk。
    """
    if isinstance(raw, str):
        return raw
    for encoding in ("utf-8", "gbk"):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    raise EncodingError("无法识别文件编码（不支持 utf-8 / gbk）")


def _strip_export_header(text: str) -> str:
    """剥离导出时注入的头部块（元数据注释 + 生成器添加的 H1 标题）。

    仅当文本以导出注释开头时生效——这标识文件是「本系统导出」而非用户手写 Markdown，
    因此其后的首个 H1 是生成器添加的标题，不是用户正文。剥离后保证 MD-14 循环一致：
    导出（注释 + H1 + 正文）→ 导入（剥注释 + H1）→ 正文 == 原始 raw_content。

    用户手写 md（无导出注释）不剥离，保留其 H1 作为正文一部分。
    """
    text = text or ""
    if not text.lstrip().startswith(_META_COMMENT_OPEN):
        return text
    idx = text.find(_META_COMMENT_CLOSE)
    if idx == -1:
        return text
    rest = text[idx + len(_META_COMMENT_CLOSE):]
    rest = rest.lstrip("\n")
    # 剥离注释后的首个 H1（生成器标题）
    m = re.match(r"^#{1,6}\s+.+$", rest, flags=re.MULTILINE)
    if m and m.start() == 0:
        rest = rest[m.end():]
        rest = rest.lstrip("\n")
    return rest


def _count_md_elements(text: str) -> Dict[str, int]:
    """统计 Markdown 格式元素数量（标题/代码块/图片/列表/表格/引用）。"""
    stats = {
        "headings": 0,
        "code_blocks": 0,
        "images": 0,
        "lists": 0,
        "tables": 0,
        "blockquotes": 0,
    }
    in_code = False
    prev_is_table_row = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            if not in_code:  # 仅开块计数（闭合行不重复计）
                stats["code_blocks"] += 1
            in_code = not in_code
            prev_is_table_row = False
            continue
        if in_code:
            prev_is_table_row = False
            continue
        if re.match(r"^#{1,6}\s", stripped):
            stats["headings"] += 1
        if re.search(r"!\[[^\]]*\]\([^)]*\)", line):
            stats["images"] += 1
        if re.match(r"^\s*(?:[-*+]|\d+[.)])\s", stripped):
            stats["lists"] += 1
        # 表格：计块首行（| 行且前一行不是 | 行），避免逐行重复计
        is_table_row = bool(
            re.match(r"^\s*\|.*\|\s*$", stripped) and stripped.count("|") >= 2
        )
        if is_table_row and not prev_is_table_row:
            stats["tables"] += 1
        prev_is_table_row = is_table_row
        if stripped.startswith(">"):
            stats["blockquotes"] += 1
    return stats


def _extract_title(text: str) -> str:
    """提取标题：首个 H1，否则首行非空文本；截断 60 字；空回退 "untitled"。"""
    for line in text.splitlines():
        m = re.match(r"^#\s+(.+)$", line.strip())
        if m:
            return m.group(1).strip()[:_TITLE_MAX]
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("<!--"):
            return stripped[:_TITLE_MAX]
    return "untitled"


def parse_markdown_text(text: str) -> Dict[str, Any]:
    """Markdown 文本 → `{title, raw_content, format_stats}`。

    - `title`：首个 H1 或首行非空文本（≤ 60 字）。
    - `raw_content`：**保原样**（仅剥离导出元数据注释），保证 MD-14 逐字符一致。
    - `format_stats`：标题/代码块/图片/列表/表格/引用数量统计（供导入预览 MD-8）。
    """
    if text is None:
        text = ""
    # title 从原始文本提取（导出注释场景下取生成器 H1，用户手写场景取首个 H1/首行）
    title = _extract_title(text)
    raw = _strip_export_header(text)
    return {
        "title": title,
        "raw_content": raw,
        "format_stats": _count_md_elements(raw),
    }


def _content_hash(raw_content: str) -> str:
    """正文内容 SHA256（去首尾空白），与 store 查重键一致。"""
    return hashlib.sha256((raw_content or "").strip().encode("utf-8")).hexdigest()


def detect_conflict(
    title: str, raw_content: str, existing_entries: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """判重：`{is_dup, reason, existing_id}`。

    - `identical`：已有条目标题相同 **且** 正文哈希相同 → 完全重复。
    - `name_collision`：标题相同但正文不同 → 待确认（走冲突策略）。
    - 其余：`is_dup=False, reason=""`。

    对齐需求澄清 §8.4 决策：判重依据 = 标题 + 内容哈希。
    """
    target_hash = _content_hash(raw_content)
    for existing in existing_entries:
        if (existing.get("title") or "") == title:
            existing_hash = existing.get("content_hash") or _content_hash(
                existing.get("raw_content", "")
            )
            if existing_hash == target_hash:
                return {
                    "is_dup": True,
                    "reason": CONFLICT_IDENTICAL,
                    "existing_id": existing.get("id", ""),
                }
            return {"is_dup": True, "reason": CONFLICT_NAME, "existing_id": existing.get("id", "")}
    return {"is_dup": False, "reason": CONFLICT_NONE, "existing_id": ""}


def _validate_file(file_name: str, content: str) -> Dict[str, Any]:
    """单文件格式校验：`{valid, reason}`（扩展名/空内容/解析失败）。

    - 非 `.md` 扩展名 → `bad_extension`。
    - 空内容 → `empty_content`。
    - 其他异常 → `parse_error`。
    """
    lower = (file_name or "").lower()
    if not lower.endswith(SUPPORTED_EXTENSIONS):
        return {"valid": False, "reason": "bad_extension"}
    if not (content or "").strip():
        return {"valid": False, "reason": "empty_content"}
    try:
        parse_markdown_text(content)
        return {"valid": True, "reason": ""}
    except Exception:  # noqa: BLE001
        return {"valid": False, "reason": "parse_error"}


def import_files(
    file_items: List[Dict[str, Any]],
    target_type: str,
    conflict_strategy: str,
    store: Any,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> Dict[str, Any]:
    """批量导入：解析 → 冲突判定 → 按策略写入 → 统计。

    参数：
    - `file_items`：`[{file_name, content}]`（content 为已解码文本，或 base64 由路由层解码）。
    - `target_type`：目标 type（article/paper/novel/inspiration）。
    - `conflict_strategy`：`overwrite` / `rename` / `skip`。
    - `store`：`KnowledgeStore` 实例（依赖注入，本模块不 import 其符号）。
    - `progress_cb`：`(done, total)` 进度回调（MD-12，界面不阻塞）。

    返回：`{total, success, failed, failed_items, created, updated, skipped}`。

    策略：
    - `overwrite`：更新已有条目（复用 id，更新 raw_content + content_hash）。
    - `rename`：新建条目，标题加 `_imported` 后缀（新 id 新文件名）。
    - `skip`：不处理，计入 skipped（失败统计 reason=conflict_skip）。

    单条失败不中断整批（对齐需求澄清 §8.7）。损坏文件记 `parse_error`。
    """
    result: Dict[str, Any] = {
        "total": len(file_items),
        "success": 0,
        "failed": 0,
        "failed_items": [],
        "created": [],
        "updated": [],
        "skipped": [],
    }
    if conflict_strategy not in ("overwrite", "rename", "skip"):
        raise ValueError(f"非法冲突策略: {conflict_strategy}")

    # 预取已有条目（用于判重），一次加载避免逐条扫描
    existing_entries = [
        store.load_entry(e["id"]) or {} for e in store.query_index()
    ]

    total = len(file_items)
    for idx, item in enumerate(file_items):
        file_name = item.get("file_name", "")
        try:
            content = item.get("content", "")
            # 格式校验（扩展名/空/损坏）
            v = _validate_file(file_name, content)
            if not v["valid"]:
                result["failed"] += 1
                result["failed_items"].append({"file_name": file_name, "reason": v["reason"]})
                if progress_cb:
                    progress_cb(idx + 1, total)
                continue

            parsed = parse_markdown_text(content)
            title = parsed["title"]
            raw_content = parsed["raw_content"]

            # 判重：identical（标题+哈希均同）与 name_collision（仅标题同）均视为冲突，
            # 走冲突策略三选一（对齐需求澄清 §8.7「同名不同内容 → 待确认 → 走冲突策略」）。
            conflict = detect_conflict(title, raw_content, existing_entries)
            if conflict["is_dup"]:
                existing_id = conflict["existing_id"]
                if conflict_strategy == "skip":
                    result["skipped"].append(existing_id)
                    if progress_cb:
                        progress_cb(idx + 1, total)
                    continue
                if conflict_strategy == "overwrite":
                    existing = store.load_entry(existing_id)
                    if existing:
                        existing["raw_content"] = raw_content
                        existing["content_hash"] = _content_hash(raw_content)
                        existing["updated_at"] = datetime.now().isoformat(timespec="seconds")
                        store.save_entry(existing)
                        result["updated"].append(existing_id)
                        result["success"] += 1
                    else:
                        result["failed"] += 1
                        result["failed_items"].append(
                            {"file_name": file_name, "reason": "existing_not_found"}
                        )
                    if progress_cb:
                        progress_cb(idx + 1, total)
                    continue
                # rename：内容完全重复（identical）时 create_entry 的 find_by_hash
                # 会命中已有条目而不新建（见 knowledge_store.create_entry 注释），
                # 语义含混 —— 内容已存在，视同 skip（对齐使用文档 FAQ）。
                if conflict["reason"] == CONFLICT_IDENTICAL:
                    result["skipped"].append(existing_id)
                    if progress_cb:
                        progress_cb(idx + 1, total)
                    continue
                # rename：仅同名不同内容（name_collision），新建，标题加后缀
                title = f"{title}_imported"

            # 新建条目
            entry = store.create_entry(
                type_=target_type,
                title=title,
                raw_content=raw_content,
                source="import",
                structured={},
                tags=[],
                status="saved",
            )
            result["created"].append(entry["id"])
            result["success"] += 1
            # 判重缓存更新（避免同批同名文件互判冲突）
            existing_entries.append(entry)
        except Exception as exc:  # noqa: BLE001 - 单条失败不中断整批
            result["failed"] += 1
            result["failed_items"].append(
                {"file_name": file_name, "reason": f"parse_error: {exc}"}
            )
        if progress_cb:
            progress_cb(idx + 1, total)

    return result


# ============================================================
# 预览辅助（供路由层组装 import_preview_item）
# ============================================================

def build_preview_item(file_name: str, content: str, store: Any) -> Dict[str, Any]:
    """单文件 → `import_preview_item`（对齐需求澄清 §8.8）。

    - `valid`：扩展名/编码/损坏校验。
    - `conflict`：判重标记（identical/name_collision）。
    - `format_stats`：格式元素统计。
    """
    item: Dict[str, Any] = {
        "file_name": file_name,
        "title": "",
        "raw_content": "",
        "format_stats": {},
        "conflict": {"is_dup": False, "reason": "", "existing_id": ""},
        "valid": True,
        "reason": "",
    }
    v = _validate_file(file_name, content)
    if not v["valid"]:
        item["valid"] = False
        item["reason"] = v["reason"]
        return item
    parsed = parse_markdown_text(content)
    item["title"] = parsed["title"]
    item["raw_content"] = parsed["raw_content"]
    item["format_stats"] = parsed["format_stats"]
    existing = [store.load_entry(e["id"]) or {} for e in store.query_index()]
    item["conflict"] = detect_conflict(parsed["title"], parsed["raw_content"], existing)
    return item
