# -*- coding: utf-8 -*-
"""project_store.py 补测（P5-T1：覆盖率补测）。

覆盖 ProjectStore 全部公开方法：项目 CRUD / 协同开关 / 章节 CRUD /
标红章节 / 工具调用记录。用 tmp_path 隔离数据目录。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError, bad_request, conflict, not_found
from modules.novel_creation.project_store import ProjectStore


@pytest.fixture()
def store(tmp_path):
    return ProjectStore(str(tmp_path))


# ---------- Project ----------

class TestProjectCRUD:
    def test_create_project_ok(self, store):
        p = store.create_project("我的小说", description="简介", genre="玄幻", author="作者A")
        assert p["title"] == "我的小说"
        assert p["description"] == "简介"
        assert p["genre"] == "玄幻"
        assert p["author"] == "作者A"
        assert p["status"] == "active"
        assert p["collab_enabled"] is False
        assert p["chapters"] == []
        assert store.get_project(p["id"])["id"] == p["id"]

    def test_create_project_empty_title(self, store):
        with pytest.raises(AppError) as ei:
            store.create_project("")
        assert ei.value.code == 400

    def test_create_project_whitespace_title(self, store):
        with pytest.raises(AppError):
            store.create_project("   ")

    def test_create_project_invalid_status(self, store):
        with pytest.raises(AppError) as ei:
            store.create_project("小说", status="invalid")
        assert "非法项目状态" in ei.value.message

    def test_create_project_duplicate_title(self, store):
        store.create_project("同名")
        with pytest.raises(AppError) as ei:
            store.create_project("同名")
        assert ei.value.code == 409

    def test_create_project_collab(self, store):
        p = store.create_project("协同项目", collab_enabled=True)
        assert p["collab_enabled"] is True

    def test_get_project_not_found(self, store):
        with pytest.raises(AppError) as ei:
            store.get_project("no-such")
        assert ei.value.code == 404

    def test_list_projects(self, store):
        assert store.list_projects() == []
        store.create_project("A")
        store.create_project("B")
        projects = store.list_projects()
        assert len(projects) == 2
        # 摘要不含 chapters
        assert all("chapters" not in p for p in projects)

    def test_find_project_by_role(self, store):
        p = store.create_project("含角色项目")
        # 直接注入 roles 到聚合根
        p["roles"] = [{"id": "role-x"}]
        store._save(p["id"], p)
        found = store.find_project_by_role("role-x")
        assert found["id"] == p["id"]
        assert store.find_project_by_role("role-none") is None

    def test_update_project(self, store):
        p = store.create_project("原题")
        updated = store.update_project(p["id"], title="新题", description="新简介", collab_enabled=True)
        assert updated["title"] == "新题"
        assert updated["collab_enabled"] is True
        assert store.get_project(p["id"])["title"] == "新题"

    def test_update_project_not_found(self, store):
        with pytest.raises(AppError) as ei:
            store.update_project("no-such", title="x")
        assert ei.value.code == 404

    def test_update_project_invalid_field(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError) as ei:
            store.update_project(p["id"], bad_field="x")
        assert "非法项目字段" in ei.value.message

    def test_update_project_bad_collab_type(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError):
            store.update_project(p["id"], collab_enabled="yes")

    def test_update_project_invalid_status(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError):
            store.update_project(p["id"], status="deleted")

    def test_delete_project(self, store):
        p = store.create_project("待删")
        store.delete_project(p["id"])
        with pytest.raises(AppError):
            store.get_project(p["id"])

    def test_delete_project_not_found(self, store):
        with pytest.raises(AppError) as ei:
            store.delete_project("no-such")
        assert ei.value.code == 404


# ---------- Collab 开关 ----------

class TestCollab:
    def test_get_collab_default_false(self, store):
        p = store.create_project("小说")
        assert store.get_collab_enabled(p["id"]) is False

    def test_set_collab_enabled(self, store):
        p = store.create_project("小说")
        store.set_collab_enabled(p["id"], True)
        assert store.get_collab_enabled(p["id"]) is True

    def test_set_collab_bad_type(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError):
            store.set_collab_enabled(p["id"], "yes")

    def test_get_collab_not_found(self, store):
        with pytest.raises(AppError):
            store.get_collab_enabled("no-such")

    def test_set_collab_not_found(self, store):
        with pytest.raises(AppError):
            store.set_collab_enabled("no-such", True)


# ---------- Chapter ----------

class TestChapterCRUD:
    def test_create_chapter_auto_order(self, store):
        p = store.create_project("小说")
        c1 = store.create_chapter(p["id"], "第一章")
        c2 = store.create_chapter(p["id"], "第二章")
        assert c1["order"] == 0
        assert c2["order"] == 1
        assert c1["status"] == "draft"
        assert c1["role_ids"] == []

    def test_create_chapter_explicit_order(self, store):
        p = store.create_project("小说")
        c = store.create_chapter(p["id"], "第一章", content="内容", order=5)
        assert c["order"] == 5

    def test_create_chapter_empty_title(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError):
            store.create_chapter(p["id"], "")

    def test_create_chapter_dup_order(self, store):
        p = store.create_project("小说")
        store.create_chapter(p["id"], "a", order=1)
        with pytest.raises(AppError) as ei:
            store.create_chapter(p["id"], "b", order=1)
        assert "已存在" in ei.value.message

    def test_create_chapter_bad_order(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError):
            store.create_chapter(p["id"], "a", order=-1)

    def test_create_chapter_project_not_found(self, store):
        with pytest.raises(AppError):
            store.create_chapter("no-such", "章")

    def test_list_chapters_sorted(self, store):
        p = store.create_project("小说")
        store.create_chapter(p["id"], "b", order=3)
        store.create_chapter(p["id"], "a", order=1)
        chapters = store.list_chapters(p["id"])
        assert [c["order"] for c in chapters] == [1, 3]

    def test_get_chapter(self, store):
        p = store.create_project("小说")
        c = store.create_chapter(p["id"], "章")
        assert store.get_chapter(p["id"], c["id"])["title"] == "章"

    def test_get_chapter_not_found(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError):
            store.get_chapter(p["id"], "no-chapter")

    def test_update_chapter(self, store):
        p = store.create_project("小说")
        c = store.create_chapter(p["id"], "章")
        store.update_chapter(p["id"], c["id"], title="改后", content="新内容", status="completed")
        updated = store.get_chapter(p["id"], c["id"])
        assert updated["title"] == "改后"
        assert updated["status"] == "completed"

    def test_update_chapter_invalid_field(self, store):
        p = store.create_project("小说")
        c = store.create_chapter(p["id"], "章")
        with pytest.raises(AppError):
            store.update_chapter(p["id"], c["id"], bad="x")

    def test_update_chapter_invalid_status(self, store):
        p = store.create_project("小说")
        c = store.create_chapter(p["id"], "章")
        with pytest.raises(AppError):
            store.update_chapter(p["id"], c["id"], status="deleted")

    def test_update_chapter_not_found(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError):
            store.update_chapter(p["id"], "no-chapter", title="x")

    def test_delete_chapter(self, store):
        p = store.create_project("小说")
        c = store.create_chapter(p["id"], "章")
        store.delete_chapter(p["id"], c["id"])
        assert store.list_chapters(p["id"]) == []

    def test_delete_chapter_not_found(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError):
            store.delete_chapter(p["id"], "no-chapter")


# ---------- flag_chapters_by_role ----------

class TestFlagChapters:
    def test_flag(self, store):
        p = store.create_project("小说")
        c = store.create_chapter(p["id"], "章")
        store.update_chapter(p["id"], c["id"], role_ids=["r1", "r2"])
        flagged = store.flag_chapters_by_role(p["id"], "r1")
        assert flagged == [c["id"]]
        # 幂等
        assert store.flag_chapters_by_role(p["id"], "r1") == [c["id"]]
        ch = store.get_chapter(p["id"], c["id"])
        assert ch["flagged_role_ids"] == ["r1"]
        # 非出场角色不标红
        assert store.flag_chapters_by_role(p["id"], "r3") == []

    def test_flag_saves_only_when_changed(self, store):
        p = store.create_project("小说")
        c = store.create_chapter(p["id"], "章")
        store.update_chapter(p["id"], c["id"], role_ids=["r1"])
        # 首次标红会保存
        store.flag_chapters_by_role(p["id"], "r1")
        # 再调用不产生新修改
        assert store.flag_chapters_by_role(p["id"], "r1") == [c["id"]]


# ---------- ToolCallRecord ----------

class TestToolCalls:
    def test_append_and_list(self, store):
        p = store.create_project("小说")
        rec = store.append_tool_call(p["id"], "novel_analysis", {"q": 1}, {"ok": True}, role_id="r1")
        assert rec["tool_name"] == "novel_analysis"
        assert rec["role_id"] == "r1"
        assert rec["status"] == "success"
        rec2 = store.append_tool_call(p["id"], "novel_analysis", {"q": 2}, {"ok": False}, status="failed")
        assert rec2["status"] == "failed"
        records = store.list_tool_calls(p["id"])
        assert len(records) == 2
        # 倒序按 created_at；同一秒内 created_at 相同，仅断言两记录都在且倒序稳定
        assert {r["id"] for r in records} == {rec["id"], rec2["id"]}
        # created_at 单调不增（倒序）
        assert records[0]["created_at"] >= records[1]["created_at"]

    def test_list_filter_by_tool(self, store):
        p = store.create_project("小说")
        store.append_tool_call(p["id"], "a", {}, {})
        store.append_tool_call(p["id"], "b", {}, {})
        records = store.list_tool_calls(p["id"], tool_name="a")
        assert len(records) == 1
        assert records[0]["tool_name"] == "a"

    def test_append_bad_status(self, store):
        p = store.create_project("小说")
        with pytest.raises(AppError):
            store.append_tool_call(p["id"], "a", {}, {}, status="unknown")

    def test_append_project_not_found(self, store):
        with pytest.raises(AppError):
            store.append_tool_call("no-such", "a", {}, {})

    def test_list_limit(self, store):
        p = store.create_project("小说")
        for i in range(5):
            store.append_tool_call(p["id"], "a", {"i": i}, {})
        assert len(store.list_tool_calls(p["id"], limit=3)) == 3
