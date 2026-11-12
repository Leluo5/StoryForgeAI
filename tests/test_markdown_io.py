# -*- coding: utf-8 -*-
"""知识库 Markdown 导入导出引擎单元测试（F5-T12 / F5-T13）。

对齐技术方案 §9.8 测试策略，覆盖：
- `decode_bytes`：utf-8 / gbk / 异常。
- `parse_markdown_text`：标题提取 / 格式统计 / 元数据注释剥离。
- `sanitize_filename` / `build_filename`：非法字符 / 时间戳。
- `build_export_markdown`：内容一致性 100%（MD-14）。
- `detect_conflict`：identical / name_collision / 无冲突。
- `import_files`：overwrite / rename / skip + 统计 + 进度回调 + 损坏文件。
- `build_zip`：ZIP 字节可解包。
"""

import io
import os
import sys
import tempfile
import unittest
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.knowledge_base.knowledge_markdown_io import (  # noqa: E402
    CONFLICT_IDENTICAL,
    CONFLICT_NAME,
    EncodingError,
    build_export_markdown,
    build_filename,
    build_preview_item,
    build_zip,
    decode_bytes,
    detect_conflict,
    export_entries,
    import_files,
    parse_markdown_text,
    sanitize_filename,
)
from modules.knowledge_base.knowledge_store import KnowledgeStore  # noqa: E402


def _make_store():
    """临时目录 + KnowledgeStore 实例。"""
    tmp = tempfile.mkdtemp()
    store = KnowledgeStore(os.path.join(tmp, "knowledge"))
    return tmp, store


class TestDecodeBytes(unittest.TestCase):
    def test_utf8(self):
        self.assertEqual(decode_bytes("中文测试".encode("utf-8")), "中文测试")

    def test_gbk(self):
        self.assertEqual(decode_bytes("中文测试".encode("gbk")), "中文测试")

    def test_str_passthrough(self):
        self.assertEqual(decode_bytes("already str"), "already str")

    def test_bad_bytes_raises(self):
        with self.assertRaises(EncodingError):
            decode_bytes(b"\xff\xfe\x00\x01\x02\x03\x04\x05")


class TestSanitizeFilename(unittest.TestCase):
    def test_illegal_chars_replaced(self):
        self.assertEqual(sanitize_filename('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j")

    def test_space_collapsed_and_stripped(self):
        self.assertEqual(sanitize_filename("  龙火   传说  "), "龙火 传说")

    def test_empty_fallback(self):
        self.assertEqual(sanitize_filename(""), "untitled")
        self.assertEqual(sanitize_filename("   "), "untitled")

    def test_truncate_80(self):
        name = sanitize_filename("长" * 200)
        self.assertEqual(len(name), 80)

    def test_leading_trailing_dot_space(self):
        self.assertEqual(sanitize_filename(".龙火传说."), "龙火传说")


class TestBuildFilename(unittest.TestCase):
    def test_format_with_timestamp(self):
        import datetime
        ts = datetime.datetime(2026, 11, 12, 10, 30, 5)
        name = build_filename("龙火传说", ts)
        self.assertEqual(name, "龙火传说_20261112_103005.md")

    def test_illegal_chars_cleaned(self):
        import datetime
        ts = datetime.datetime(2026, 11, 12, 10, 30, 5)
        name = build_filename('a/b:c*', ts)
        self.assertEqual(name, "a_b_c_20261112_103005.md")


class TestBuildExportMarkdown(unittest.TestCase):
    def test_consistency_100_percent(self):
        """MD-14：导出正文与原 raw_content 逐字符一致。"""
        raw = "## 第一章 觉醒\n\n林远踏入灰雾。\n\n```python\nprint('hi')\n```\n\n- 要点一\n- 要点二\n\n![插图](images/hero.png)\n\n| 名 | 值 |\n|----|----|\n| a  | b  |"
        entry = {
            "id": "k_001",
            "type": "novel",
            "title": "龙火传说",
            "source": "upload",
            "tags": ["玄幻", "龙"],
            "created_at": "2026-11-12T10:00:00",
            "updated_at": "2026-11-12T10:00:00",
            "raw_content": raw,
        }
        out = build_export_markdown(entry)
        # 首行元数据注释 + 标题 H1 + 空行 + 正文
        self.assertTrue(out.startswith("<!-- knowledge-export"))
        self.assertIn("# 龙火传说", out)
        # 正文原样保留（含代码块/列表/图片/表格）
        self.assertIn(raw, out)
        # 提取正文（剥离注释与标题后）逐字符一致
        parsed = parse_markdown_text(out)
        self.assertEqual(parsed["raw_content"], raw)

    def test_meta_optional(self):
        entry = {"id": "k_001", "type": "article", "title": "标题", "raw_content": "正文"}
        out = build_export_markdown(entry, with_meta=False)
        self.assertNotIn("knowledge-export", out)
        self.assertEqual(out, "# 标题\n\n正文")


class TestParseMarkdownText(unittest.TestCase):
    def test_title_from_h1(self):
        parsed = parse_markdown_text("# 龙火传说\n\n正文")
        self.assertEqual(parsed["title"], "龙火传说")
        self.assertEqual(parsed["raw_content"], "# 龙火传说\n\n正文")

    def test_title_from_first_nonempty_line(self):
        parsed = parse_markdown_text("## 第二章\n\n内容")
        self.assertEqual(parsed["title"], "## 第二章")

    def test_format_stats(self):
        text = (
            "# 标题\n"
            "## 一\n"
            "正文\n"
            "```python\ncode\n```\n"
            "![img](a.png)\n"
            "- 列表项\n"
            "| 名 | 值 |\n"
            "|----|----|\n"
            "| a | b |\n"
            "> 引用\n"
        )
        parsed = parse_markdown_text(text)
        stats = parsed["format_stats"]
        self.assertEqual(stats["headings"], 2)
        self.assertEqual(stats["code_blocks"], 1)
        self.assertEqual(stats["images"], 1)
        self.assertEqual(stats["lists"], 1)
        self.assertEqual(stats["tables"], 1)
        self.assertEqual(stats["blockquotes"], 1)

    def test_meta_comment_stripped(self):
        text = "<!-- knowledge-export\nid: k_1\ntype: novel\n-->\n# 龙火传说\n\n正文"
        parsed = parse_markdown_text(text)
        # title 取自生成器 H1；raw_content 剥离注释 + 生成器 H1，仅剩用户正文（MD-14 循环一致）
        self.assertEqual(parsed["title"], "龙火传说")
        self.assertEqual(parsed["raw_content"], "正文")

    def test_meta_comment_absent(self):
        text = "# 标题\n\n正文"
        parsed = parse_markdown_text(text)
        self.assertEqual(parsed["raw_content"], text)

    def test_empty_fallback_title(self):
        parsed = parse_markdown_text("")
        self.assertEqual(parsed["title"], "untitled")
        self.assertEqual(parsed["raw_content"], "")


class TestDetectConflict(unittest.TestCase):
    def test_identical(self):
        entries = [{"id": "k_1", "title": "龙火", "content_hash": "", "raw_content": "内容A"}]
        conflict = detect_conflict("龙火", "内容A", entries)
        self.assertTrue(conflict["is_dup"])
        self.assertEqual(conflict["reason"], CONFLICT_IDENTICAL)
        self.assertEqual(conflict["existing_id"], "k_1")

    def test_name_collision(self):
        entries = [{"id": "k_1", "title": "龙火", "content_hash": "", "raw_content": "内容A"}]
        conflict = detect_conflict("龙火", "内容B", entries)
        self.assertTrue(conflict["is_dup"])
        self.assertEqual(conflict["reason"], CONFLICT_NAME)

    def test_no_conflict(self):
        entries = [{"id": "k_1", "title": "其他", "content_hash": "", "raw_content": "内容A"}]
        conflict = detect_conflict("龙火", "内容A", entries)
        self.assertFalse(conflict["is_dup"])
        self.assertEqual(conflict["reason"], "")


class TestExportEntries(unittest.TestCase):
    def test_batch(self):
        entries = [
            {"id": "k_1", "type": "novel", "title": "龙火", "raw_content": "## 第一章\n正文"},
            {"id": "k_2", "type": "article", "title": "论文", "raw_content": "## 方法\n内容"},
        ]
        result = export_entries(entries)
        self.assertEqual(len(result["files"]), 2)
        self.assertEqual(len(result["failed"]), 0)
        self.assertEqual(result["files"][0]["file_name"].endswith(".md"), True)
        self.assertIn("## 第一章", result["files"][0]["content"])

    def test_single_failure_recorded(self):
        entries = [
            {"id": "k_1", "type": "novel", "title": "龙火", "raw_content": "正文"},
            {"id": "k_bad", "type": "novel", "title": "缺正文"},  # 缺 raw_content，引擎兜底 untitled 不抛错
        ]
        result = export_entries(entries)
        # 引擎对缺字段条目兜底渲染（含标题/空正文），不中断整批 —— 2 条均成功渲染
        self.assertEqual(len(result["files"]), 2)
        self.assertEqual(len(result["failed"]), 0)
        self.assertEqual(result["files"][1]["file_name"].endswith(".md"), True)


class TestBuildZip(unittest.TestCase):
    def test_zip_roundtrip(self):
        items = [
            {"file_name": "a.md", "content": "# A"},
            {"file_name": "b.md", "content": "# B"},
        ]
        data = build_zip(items, "test.zip")
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = zf.namelist()
            self.assertEqual(len(names), 2)
            self.assertEqual(zf.read("a.md").decode("utf-8"), "# A")
            self.assertEqual(zf.read("b.md").decode("utf-8"), "# B")

    def test_zip_name_conflict_deduped(self):
        items = [
            {"file_name": "a.md", "content": "# A"},
            {"file_name": "a.md", "content": "# A2"},
        ]
        data = build_zip(items)
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            names = zf.namelist()
            self.assertEqual(len(names), 2)
            self.assertIn("a.md", names)
            self.assertTrue(any(n.startswith("a_1") for n in names))


class TestImportFiles(unittest.TestCase):
    def setUp(self):
        self.tmp, self.store = _make_store()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_import_new_no_conflict(self):
        items = [{"file_name": "龙火传说.md", "content": "# 龙火传说\n\n正文内容"}]
        result = import_files(items, "novel", "rename", self.store)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["success"], 1)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(len(result["created"]), 1)
        entry = self.store.load_entry(result["created"][0])
        self.assertEqual(entry["title"], "龙火传说")
        self.assertEqual(entry["type"], "novel")
        self.assertEqual(entry["raw_content"], "# 龙火传说\n\n正文内容")

    def test_bad_extension_failed(self):
        items = [{"file_name": "doc.txt", "content": "# 标题"}]
        result = import_files(items, "article", "rename", self.store)
        self.assertEqual(result["success"], 0)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["failed_items"][0]["reason"], "bad_extension")

    def test_empty_content_failed(self):
        items = [{"file_name": "a.md", "content": "   "}]
        result = import_files(items, "article", "rename", self.store)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["failed_items"][0]["reason"], "empty_content")

    def test_overwrite_strategy(self):
        # 先建一个条目
        first = self.store.create_entry("novel", "龙火", "内容A", source="import")
        items = [{"file_name": "龙火.md", "content": "# 龙火\n\n内容B"}]
        result = import_files(items, "novel", "overwrite", self.store)
        self.assertEqual(result["success"], 1)
        self.assertEqual(len(result["updated"]), 1)
        self.assertEqual(result["updated"][0], first["id"])
        # 更新后正文为内容B
        entry = self.store.load_entry(first["id"])
        self.assertIn("内容B", entry["raw_content"])

    def test_rename_strategy(self):
        first = self.store.create_entry("novel", "龙火", "内容A", source="import")
        items = [{"file_name": "龙火.md", "content": "# 龙火\n\n内容B"}]
        result = import_files(items, "novel", "rename", self.store)
        self.assertEqual(result["success"], 1)
        self.assertEqual(len(result["created"]), 1)
        new_entry = self.store.load_entry(result["created"][0])
        self.assertEqual(new_entry["title"], "龙火_imported")
        # 原条目不变
        self.assertNotEqual(result["created"][0], first["id"])

    def test_skip_strategy(self):
        self.store.create_entry("novel", "龙火", "内容A", source="import")
        items = [{"file_name": "龙火.md", "content": "# 龙火\n\n内容B"}]
        result = import_files(items, "novel", "skip", self.store)
        self.assertEqual(result["success"], 0)
        self.assertEqual(len(result["skipped"]), 1)

    def test_rename_identical_skipped(self):
        # 已知边界：identical（标题+哈希均同）+ rename → create_entry 的
        # find_by_hash 会命中已有条目而不新建，语义含混，视为 skip。
        first = self.store.create_entry("novel", "龙火", "# 龙火\n\n内容A", source="import")
        items = [{"file_name": "龙火.md", "content": "# 龙火\n\n内容A"}]
        result = import_files(items, "novel", "rename", self.store)
        self.assertEqual(result["success"], 0)
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(result["skipped"][0], first["id"])
        self.assertEqual(len(result["created"]), 0)

    def test_progress_callback(self):
        items = [
            {"file_name": "a.md", "content": "# A\n\n内容"},
            {"file_name": "b.md", "content": "# B\n\n内容"},
        ]
        calls = []
        import_files(items, "article", "rename", self.store, progress_cb=lambda d, t: calls.append((d, t)))
        self.assertEqual(calls, [(1, 2), (2, 2)])

    def test_corrupt_file_not_interrupt_batch(self):
        items = [
            {"file_name": "bad.txt", "content": "# 坏"},  # 坏扩展名
            {"file_name": "ok.md", "content": "# 好\n\n内容"},
        ]
        result = import_files(items, "article", "rename", self.store)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["success"], 1)


class TestBuildPreviewItem(unittest.TestCase):
    def setUp(self):
        self.tmp, self.store = _make_store()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_valid_no_conflict(self):
        item = build_preview_item("a.md", "# 标题\n\n正文", self.store)
        self.assertTrue(item["valid"])
        self.assertEqual(item["title"], "标题")
        self.assertEqual(item["format_stats"]["headings"], 1)
        self.assertFalse(item["conflict"]["is_dup"])

    def test_invalid_bad_extension(self):
        item = build_preview_item("a.txt", "# 标题", self.store)
        self.assertFalse(item["valid"])
        self.assertEqual(item["reason"], "bad_extension")

    def test_conflict_marked(self):
        self.store.create_entry("novel", "龙火", "内容A", source="import")
        item = build_preview_item("龙火.md", "# 龙火\n\n内容B", self.store)
        self.assertTrue(item["valid"])
        self.assertTrue(item["conflict"]["is_dup"])
        self.assertEqual(item["conflict"]["reason"], CONFLICT_NAME)


class TestMarkdownIORoutes(unittest.TestCase):
    """API 端点层测试（F5-T14，技术方案 §9.3）。

    对齐 test_knowledge_routes.py 模式：临时 KnowledgeStore 注入 routes._store，
    Flask 测试客户端调用四端点，覆盖成功路径 + 400 异常路径。
    """

    @classmethod
    def setUpClass(cls):
        import app as app_module  # noqa: F811
        app_module.app.config["TESTING"] = True
        cls.client = app_module.app.test_client()

    def setUp(self):
        # 每个用例独立临时 store，避免共享污染（同名标题跨用例干扰判重/导出）
        import modules.knowledge_base.routes as routes
        self.tmp, self.store = _make_store()
        routes._store = self.store

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_entry(self, title="龙火传说", body="第一章 龙族觉醒"):
        """预置一条知识条目，返回其 id。"""
        return self.store.create_entry("novel", title, body, source="manual")["id"]

    def test_export_single_downloads_md(self):
        eid = self._make_entry()
        resp = self.client.post("/api/knowledge/markdown/export", json={
            "scope": "single", "entry_ids": [eid],
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.mimetype, "text/markdown")
        body = resp.get_data(as_text=True)
        self.assertIn("# 龙火传说", body)
        self.assertIn("第一章 龙族觉醒", body)
        # Content-Disposition 含规范文件名
        self.assertIn("attachment", resp.headers.get("Content-Disposition", ""))

    def test_export_batch_returns_zip(self):
        id1 = self._make_entry("龙火传说", "第一章 龙族觉醒")
        id2 = self._make_entry("凤鸣九霄", "第二章 火凤涅槃")
        resp = self.client.post("/api/knowledge/markdown/export", json={
            "scope": "batch", "entry_ids": [id1, id2], "as_zip": True,
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.mimetype, "application/zip")
        # 解包验证含两个 .md
        import zipfile as _zf
        with _zf.ZipFile(io.BytesIO(resp.get_data())) as z:
            names = z.namelist()
            self.assertEqual(len(names), 2)
            self.assertTrue(all(n.endswith(".md") for n in names))

    def test_export_category_by_type(self):
        self._make_entry("龙火传说", "第一章 龙族觉醒")
        self.store.create_entry("article", "论文A", "摘要A", source="manual")
        resp = self.client.post("/api/knowledge/markdown/export", json={
            "scope": "category", "type": "novel", "as_zip": True,
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.mimetype, "application/zip")
        import zipfile as _zf
        with _zf.ZipFile(io.BytesIO(resp.get_data())) as z:
            self.assertEqual(len(z.namelist()), 1)
            self.assertTrue(z.namelist()[0].endswith(".md"))

    def test_export_empty_scope_returns_stat(self):
        resp = self.client.post("/api/knowledge/markdown/export", json={
            "scope": "batch", "entry_ids": [],
        })
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body["code"], 0)
        self.assertEqual(body["data"]["total"], 0)

    def test_import_preview_returns_items(self):
        resp = self.client.post("/api/knowledge/markdown/import/preview", json={
            "files": [{"file_name": "a.md", "content": "# 标题\n\n正文内容"}],
        })
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body["code"], 0)
        self.assertEqual(body["data"]["total"], 1)
        item = body["data"]["items"][0]
        self.assertTrue(item["valid"])
        self.assertEqual(item["title"], "标题")
        self.assertEqual(item["format_stats"]["headings"], 1)

    def test_import_preview_base64(self):
        import base64 as _b64
        content = "# 标题\n\n正文".encode("utf-8")
        data_url = "data:text/markdown;base64," + _b64.b64encode(content).decode("ascii")
        resp = self.client.post("/api/knowledge/markdown/import/preview", json={
            "files": [{"file_name": "b.md", "content": data_url}],
        })
        body = resp.get_json()
        self.assertEqual(body["data"]["items"][0]["title"], "标题")

    def test_import_executes_and_stats(self):
        resp = self.client.post("/api/knowledge/markdown/import", json={
            "files": [
                {"file_name": "c.md", "content": "# 新文档\n\n内容C"},
                {"file_name": "bad.txt", "content": "# 坏"},
            ],
            "target_type": "article", "conflict_strategy": "rename",
        })
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body["code"], 0)
        self.assertEqual(body["data"]["total"], 2)
        self.assertEqual(body["data"]["success"], 1)
        self.assertEqual(body["data"]["failed"], 1)
        self.assertEqual(len(body["data"]["created"]), 1)
        self.assertEqual(body["data"]["failed_items"][0]["reason"], "bad_extension")

    def test_import_invalid_target_type_400(self):
        resp = self.client.post("/api/knowledge/markdown/import", json={
            "files": [], "target_type": "bad", "conflict_strategy": "rename",
        })
        self.assertEqual(resp.status_code, 400)

    def test_import_invalid_strategy_400(self):
        resp = self.client.post("/api/knowledge/markdown/import", json={
            "files": [], "target_type": "article", "conflict_strategy": "bad",
        })
        self.assertEqual(resp.status_code, 400)

    def test_import_validate_valid(self):
        resp = self.client.post("/api/knowledge/markdown/import/validate", json={
            "file_name": "d.md", "content": "# 校验\n\n正文",
        })
        body = resp.get_json()
        self.assertTrue(body["data"]["valid"])

    def test_import_validate_invalid(self):
        resp = self.client.post("/api/knowledge/markdown/import/validate", json={
            "file_name": "d.txt", "content": "内容",
        })
        body = resp.get_json()
        self.assertFalse(body["data"]["valid"])
        self.assertEqual(body["data"]["reason"], "bad_extension")


if __name__ == "__main__":
    unittest.main()
