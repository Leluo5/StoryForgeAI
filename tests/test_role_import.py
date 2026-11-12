# -*- coding: utf-8 -*-
"""F5→P3 知识库角色同步导入单测。

覆盖 RoleImportEngine：
- 候选角色提取（characters[] + outline.character_relations[] 关联边）。
- 字段映射标红（appearance 无来源 / relations target_missing）。
- 批量导入 + 单条预览 + 结果反馈。
- 同名查重（available=False）。
- 导入历史回溯。

kb_store 用轻量 fake 注入（本模块不依赖知识库真实存储，解耦验证）。
"""

import os
import sys
import tempfile
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)

from modules.novel_creation.role_import import RoleImportEngine  # noqa: E402
from modules.novel_creation.role_store import RoleStore  # noqa: E402


class FakeKBStore:
    """模拟知识库 store：query_index + load_entry。"""

    def __init__(self, entries):
        self._entries = entries

    def query_index(self, keyword=None, type_=None, tag=None,
                    start_time=None, end_time=None):
        # 返回元数据列表（id/title/type）
        metas = [
            {"id": e["id"], "title": e["title"], "type": e.get("type", "novel")}
            for e in self._entries
        ]
        if type_:
            metas = [m for m in metas if m["type"] == type_]
        if keyword:
            metas = [m for m in metas if keyword in m["title"]]
        return metas

    def load_entry(self, entry_id):
        for e in self._entries:
            if e["id"] == entry_id:
                return e
        return None


def _entry(entry_id="kb1", title="龙火传说"):
    return {
        "id": entry_id,
        "title": title,
        "type": "novel",
        "structured": {
            "characters": [
                {"名字": "龙", "身份": "龙族少主", "性格": "高傲"},
                {"名字": "火", "身份": "火凤圣女", "性格": "热忱"},
            ],
            "outline": {
                "character_relations": [
                    {"a": "龙", "b": "火", "relation": "对立", "camp": "a"},
                ],
            },
        },
    }


class RoleImportBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.role_store = RoleStore(os.path.join(self.tmp, "projects"))
        self.kb = FakeKBStore([_entry()])
        self.engine = RoleImportEngine(
            self.kb, self.role_store, os.path.join(self.tmp, "projects"),
        )
        self.project_id = "proj1"
        # 预置项目（RoleStore 不强校验 project 存在，直接建角色即可）

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)


# ---------- 候选提取 ----------

class TestListCandidates(RoleImportBase):
    def test_extract_two_roles(self):
        items = self.engine.list_candidate_roles(self.project_id)
        self.assertEqual(len(items), 2)
        names = {it["name"] for it in items}
        self.assertEqual(names, {"龙", "火"})

    def test_relation_edges_attached(self):
        items = self.engine.list_candidate_roles(self.project_id)
        dragon = next(it for it in items if it["name"] == "龙")
        self.assertEqual(len(dragon["relation_edges"]), 1)
        self.assertEqual(dragon["relation_edges"][0]["relation"], "对立")

    def test_duplicate_marked_unavailable(self):
        # 先导入「龙」，再列候选应标记 available=False
        self.engine.import_roles(self.project_id, [
            {"name": "龙", "identity": "", "personality": "",
             "relation_edges": [], "entry_id": "kb1", "entry_title": "龙火传说",
             "role_index": 0},
        ])
        items = self.engine.list_candidate_roles(self.project_id)
        dragon = next(it for it in items if it["name"] == "龙")
        self.assertFalse(dragon["available"])

    def test_keyword_filter(self):
        items = self.engine.list_candidate_roles(self.project_id, keyword="龙火")
        self.assertEqual(len(items), 2)
        items2 = self.engine.list_candidate_roles(self.project_id, keyword="不存在")
        self.assertEqual(items2, [])


# ---------- 字段映射标红 ----------

class TestFieldMapping(RoleImportBase):
    def test_appearance_flagged(self):
        cand = {
            "name": "龙", "identity": "龙族少主", "personality": "高傲",
            "relation_edges": [
                {"a": "龙", "b": "火", "relation": "对立", "camp": "a"},
            ],
        }
        payload = self.engine.build_role_payload(cand)
        fm = payload["field_mapping"]
        self.assertTrue(fm["name"]["mapped"])
        self.assertTrue(fm["identity"]["mapped"])
        self.assertTrue(fm["personality"]["mapped"])
        # appearance 无直接来源 → 标红
        self.assertFalse(fm["appearance"]["mapped"])
        self.assertEqual(fm["appearance"]["reason"], "kb_no_appearance")
        # background 聚合关系
        self.assertTrue(fm["background"]["mapped"])
        self.assertIn("龙与火", payload["background"])

    def test_relations_relation_type(self):
        cand = {
            "name": "龙", "identity": "", "personality": "",
            "relation_edges": [
                {"a": "龙", "b": "火", "relation": "对立", "camp": "a"},
            ],
        }
        payload = self.engine.build_role_payload(cand)
        rel = payload["relations"][0]
        self.assertEqual(rel["target_name"], "火")
        self.assertEqual(rel["relation_type"], "对立")

    def test_missing_identity_flagged(self):
        cand = {"name": "龙", "identity": "", "personality": "", "relation_edges": []}
        payload = self.engine.build_role_payload(cand)
        fm = payload["field_mapping"]
        self.assertFalse(fm["identity"]["mapped"])
        self.assertEqual(fm["identity"]["reason"], "kb_missing")


# ---------- 批量导入 / 预览 ----------

class TestImport(RoleImportBase):
    def _candidates(self):
        return [
            {"name": "龙", "identity": "龙族少主", "personality": "高傲",
             "relation_edges": [{"a": "龙", "b": "火", "relation": "对立", "camp": "a"}],
             "entry_id": "kb1", "entry_title": "龙火传说", "role_index": 0},
            {"name": "火", "identity": "火凤圣女", "personality": "热忱",
             "relation_edges": [{"a": "龙", "b": "火", "relation": "对立", "camp": "a"}],
             "entry_id": "kb1", "entry_title": "龙火传说", "role_index": 1},
        ]

    def test_batch_import_creates_roles(self):
        result = self.engine.import_roles(self.project_id, self._candidates())
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["success"], 2)
        self.assertEqual(result["failed"], 0)
        roles = self.role_store.list_roles(self.project_id)
        self.assertEqual(len(roles), 2)
        by_name = {r["name"]: r for r in roles}
        # personality/background/appearance 顶层字段已写入
        self.assertEqual(by_name["龙"]["personality"], "高傲")
        self.assertIn("龙与火", by_name["龙"]["background"])
        # 关系解析：同批导入，target 可解析
        rels = by_name["龙"]["relations"]
        self.assertEqual(len(rels), 1)
        self.assertTrue(rels[0]["mapped"])
        self.assertTrue(rels[0]["target_role_id"])

    def test_preview_no_write(self):
        result = self.engine.import_roles(self.project_id, self._candidates(), preview=True)
        self.assertEqual(result["success"], 2)
        # 预览不落库
        self.assertEqual(self.role_store.list_roles(self.project_id), [])
        # 每项含 field_mapping
        self.assertIn("field_mapping", result["imported"][0])

    def test_relation_target_missing_flagged(self):
        # 只导入「龙」，对端「火」不在库中 → target_missing 标红
        result = self.engine.import_roles(self.project_id, self._candidates()[:1])
        roles = self.role_store.list_roles(self.project_id)
        rels = roles[0]["relations"]
        self.assertEqual(rels[0]["reason"], "target_missing")
        self.assertFalse(rels[0]["mapped"])


# ---------- 导入历史 ----------

class TestHistory(RoleImportBase):
    def test_history_recorded_and_filtered(self):
        cands = [
            {"name": "龙", "identity": "", "personality": "", "relation_edges": [],
             "entry_id": "kb1", "entry_title": "龙火传说", "role_index": 0},
        ]
        self.engine.import_roles(self.project_id, cands)
        hist_all = self.engine.get_import_history()
        self.assertEqual(len(hist_all), 1)
        hist_proj = self.engine.get_import_history(self.project_id)
        self.assertEqual(len(hist_proj), 1)
        rec = hist_proj[0]
        self.assertEqual(rec["project_id"], self.project_id)
        self.assertEqual(len(rec["role_ids"]), 1)
        self.assertEqual(rec["roles"][0]["name"], "龙")
        # 其他项目过滤为空
        self.assertEqual(self.engine.get_import_history("proj2"), [])

    def test_history_not_written_on_preview(self):
        cands = [
            {"name": "龙", "identity": "", "personality": "", "relation_edges": [],
             "entry_id": "kb1", "entry_title": "龙火传说", "role_index": 0},
        ]
        self.engine.import_roles(self.project_id, cands, preview=True)
        self.assertEqual(self.engine.get_import_history(), [])


if __name__ == "__main__":
    unittest.main()
