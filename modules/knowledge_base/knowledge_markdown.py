# -*- coding: utf-8 -*-
"""知识库正文 Markdown 能力（F5，Markdown 语法升级）。

本模块是正文 Markdown 语法的「规范化 + 渲染」纯函数层，无 IO、无状态：

- `normalize_body(text)`：把普通文本规范化为 Markdown 友好形态（标题/列表/引用/分隔线）。
- `render_body_html(text)`：把 Markdown 正文渲染为安全 HTML 片段，供详情接口附带。

设计要点：
- 纯函数：不读文件、不写文件、不依赖 store，便于单测与复用。
- 渲染使用 `markdown` 库，开启 `extra`（表格/围栏代码块/删除线）+ `nl2br`（换行转 `<br>`）。
- HTML 不做全量净化（正文为用户自有数据，单创作者本地场景）；转义由调用方按需处理。
"""

from __future__ import annotations

import re
from typing import Optional

import markdown as _md

# 渲染扩展：extra = 表格/围栏代码块/删除线/定义列表；nl2br = 换行转 <br>。
_EXTENSIONS = ["extra", "nl2br"]

# 识别「章节标题」：开头为 第X章/第X节/序章/楔子/尾声 + 可选序号，或纯编号标题。
_CHAPTER_RE = re.compile(r"^\s*(第[一二三四五六七八九十百千万0-9]+[章节回卷]|序章|楔子|尾声|前言|后记|番外)\s*[:：]?\s*.*$")

# 识别「编号列表项」：1. / 1、 / 一、 / （一） 等开头。
_NUM_ITEM_RE = re.compile(r"^\s*(?:\d+[.、)]|[一二三四五六七八九十]+[、.]|[（(][一二三四五六七八九十]+[)）])\s+")


def normalize_body(text: str) -> str:
    """把普通文本规范化为 Markdown 友好形态（幂等：已是 Markdown 的输入基本不变）。

    规则（按行处理）：
    1. 章节标题（第X章/序章/楔子/尾声等）→ `## 标题`（若已是标题前缀 `#` 则跳过）。
    2. 编号列表项（1. / 一、 / （一） 等）→ `- 内容`（列表化）。
    3. 连续空行压缩为单个空行。
    4. 去除行尾多余空白。

    不强行改写正文语义：未命中规则的普通段落保持原样（纯文本段落本身是合法 Markdown）。
    """
    if not text:
        return ""
    lines = text.split("\n")
    out: list[str] = []
    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped:
            # 空行：压缩连续空行
            if out and out[-1] == "":
                continue
            out.append("")
            continue
        if _is_heading(stripped):
            out.append(f"## {stripped}")
        elif _NUM_ITEM_RE.match(stripped):
            out.append(f"- {stripped}")
        else:
            out.append(line)
    # 去除首尾空行
    while out and out[0] == "":
        out.pop(0)
    while out and out[-1] == "":
        out.pop()
    return "\n".join(out)


def _is_heading(line: str) -> bool:
    """判断是否为章节标题（已有 Markdown 标题前缀直接跳过）。"""
    if line.startswith("#"):
        return False
    return bool(_CHAPTER_RE.match(line))


def render_body_html(text: str, safe: bool = True) -> str:
    """把 Markdown 正文渲染为 HTML 片段。

    Args:
        text: Markdown 正文（可为空）。
        safe: True 时对 `<script>`/`<iframe>`/事件属性做基本剔除（防 XSS 底线）。
    """
    if not text:
        return ""
    html = _md.markdown(text, extensions=_EXTENSIONS)
    if safe:
        html = _sanitize(html)
    return html


def _sanitize(html: str) -> str:
    """最小化 HTML 净化：剔除 script/iframe/object/embed 及 on* 事件属性。

    仅作安全底线（正文来自用户粘贴/上传，不信任）；富文本标签（h/p/table/ul 等）保留。
    """
    html = re.sub(
        r"<\s*(script|iframe|object|embed)\b[^>]*>.*?<\s*/\s*\1\s*>",
        "",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    html = re.sub(
        r"\s+on\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)",
        "",
        html,
        flags=re.IGNORECASE,
    )
    html = re.sub(
        r"(href|src)\s*=\s*(\"|\')?\s*javascript:[^\"'\s>]*",
        r"\1=\"#\"",
        html,
        flags=re.IGNORECASE,
    )
    return html


def render_body_html_if_text(text: Optional[str]) -> str:
    """空值安全的渲染入口（None → ""）。"""
    return render_body_html(text or "")
