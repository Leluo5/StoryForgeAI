# -*- coding: utf-8 -*-
"""role_store.py 补测（P5-T1：覆盖率补测）。

覆盖 RoleStore 全部公开方法：角色 CRUD / F8+F9 扩展字段 / 绑定 CRUD /
记忆会话 upsert。用 tmp_path 隔离数据目录。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError, bad_request, not_found
from modules.novel_creation.role_store import RoleStore


@pytest.fixture()
def store(tmp_path):
    return RoleStore(str(tmp_path))


def _proj(store):
    # 需要一个项目文件承载聚合根（复用 project_store 的 json 结构）
    return store


# ---------- Role CRUD ----------

class TestRoleCRUD:
    def test_create_role_defaults(self, store):
        r = store.create_role("p1", "林远")
        assert r["name"] == "林远"
        assert r["status"] == "active"
        assert r["memory_summary"] == {}
        # F8 默认扩展字段
        assert r["identity"] == ""
        assert r["nationality"] == ""
        assert r["attributes"] == {}
        assert r["relations"] == []
        # F9 默认视觉特征
        assert r["visual_features"]["hair_style"] == ""
        assert r["avatar"] == ""

    def test_create_role_with_extras(self, store):
        r = store.create_role("p1", "苏璃", age=18, gender="女", identity="主角",
                              nationality="大夏", faith="无", camp="正道",
                              race="人族", profession="剑修", age_group="青年",
                              attributes={"灵根": "天灵根"},
                              relations=[{"target": "林远", "type": "道侣"}],
                              personality="冷静", background="出身世家",
                              appearance="青衣", visual_features={"hair_color": "银白"},
                              avatar="/api/role-map/avatar/abc")
        assert r["age"] == 18
        assert r["gender"] == "女"
        assert r["identity"] == "主角"
        assert r["profession"] == "剑修"
        assert r["relations"][0]["target"] == "林远"
        assert r["visual_features"]["hair_color"] == "银白"
        assert r["avatar"].endswith("abc")

    def test_create_role_empty_name(self, store):
        with pytest.raises(AppError) as ei:
            store.create_role("p1", "")
        assert ei.value.code == 400

    def test_create_role_invalid_status(self, store):
        with pytest.raises(AppError):
            store.create_role("p1", "角色", status="deleted")

    def test_list_roles(self, store):
        assert store.list_roles("p1") == []
        store.create_role("p1", "A")
        store.create_role("p1", "B")
        assert len(store.list_roles("p1")) == 2

    def test_get_role(self, store):
        r = store.create_role("p1", "角色")
        assert store.get_role("p1", r["id"])["name"] == "角色"

    def test_get_role_not_found(self, store):
        with pytest.raises(AppError) as ei:
            store.get_role("p1", "no-role")
        assert ei.value.code == 404

    def test_update_role(self, store):
        r = store.create_role("p1", "角色")
        store.update_role("p1", r["id"], name="改名", age=20, identity="反配")
        updated = store.get_role("p1", r["id"])
        assert updated["name"] == "改名"
        assert updated["identity"] == "反配"

    def test_update_role_invalid_field(self, store):
        r = store.create_role("p1", "角色")
        with pytest.raises(AppError) as ei:
            store.update_role("p1", r["id"], bad_field="x")
        assert "非法角色字段" in ei.value.message

    def test_update_role_invalid_status(self, store):
        r = store.create_role("p1", "角色")
        with pytest.raises(AppError):
            store.update_role("p1", r["id"], status="deleted")

    def test_update_role_not_found(self, store):
        with pytest.raises(AppError):
            store.update_role("p1", "no-role", name="x")

    def test_delete_role_cascades(self, store):
        r = store.create_role("p1", "角色")
        b = store.create_binding("p1", r["id"], "agent-1", 1)
        store.set_memory("p1", r["id"], "agent-1", {"x": 1})
        store.delete_role("p1", r["id"])
        with pytest.raises(AppError):
            store.get_role("p1", r["id"])
        # 绑定/会话级联删除
        assert store.get_bindings("p1", r["id"]) == []
        # 会话读不回（已删）
        assert store.get_memory("p1", r["id"], "agent-1") == {}

    def test_delete_role_not_found(self, store):
        with pytest.raises(AppError):
            store.delete_role("p1", "no-role")


# ---------- RoleAgentBinding ----------

class TestBinding:
    def test_create_binding(self, store):
        b = store.create_binding("p1", "r1", "agent-1", 3, workflow_id="wf-1")
        assert b["agent_id"] == "agent-1"
        assert b["step_order"] == 3
        assert b["workflow_id"] == "wf-1"
        assert b["enabled"] is True

    def test_create_binding_empty_agent(self, store):
        with pytest.raises(AppError) as ei:
            store.create_binding("p1", "r1", "", 1)
        assert "agent_id" in ei.value.message

    def test_create_binding_bad_step(self, store):
        with pytest.raises(AppError):
            store.create_binding("p1", "r1", "a", 12)

    def test_create_binding_step_zero(self, store):
        with pytest.raises(AppError):
            store.create_binding("p1", "r1", "a", 0)

    def test_create_binding_bad_enabled(self, store):
        with pytest.raises(AppError):
            store.create_binding("p1", "r1", "a", 1, enabled="yes")

    def test_create_binding_dup_step(self, store):
        store.create_binding("p1", "r1", "a", 1)
        with pytest.raises(AppError) as ei:
            store.create_binding("p1", "r1", "b", 1)
        assert "已存在绑定" in ei.value.message

    def test_get_bindings_sorted_filtered(self, store):
        store.create_binding("p1", "r1", "a", 2)
        store.create_binding("p1", "r1", "b", 1)
        store.create_binding("p1", "r1", "c", 3, enabled=False)
        bindings = store.get_bindings("p1", "r1")
        assert [b["step_order"] for b in bindings] == [1, 2, 3]
        enabled = store.get_bindings("p1", "r1", enabled=True)
        assert [b["step_order"] for b in enabled] == [1, 2]

    def test_update_binding(self, store):
        b = store.create_binding("p1", "r1", "a", 1)
        updated = store.update_binding("p1", b["id"], agent_id="a2", step_order=5, enabled=False)
        assert updated["agent_id"] == "a2"
        assert updated["enabled"] is False

    def test_update_binding_invalid_field(self, store):
        b = store.create_binding("p1", "r1", "a", 1)
        with pytest.raises(AppError):
            store.update_binding("p1", b["id"], bad="x")

    def test_update_binding_not_found(self, store):
        with pytest.raises(AppError):
            store.update_binding("p1", "no-binding", agent_id="a")

    def test_delete_binding(self, store):
        b = store.create_binding("p1", "r1", "a", 1)
        store.delete_binding("p1", b["id"])
        assert store.get_bindings("p1", "r1") == []

    def test_delete_binding_not_found(self, store):
        with pytest.raises(AppError):
            store.delete_binding("p1", "no-binding")


# ---------- AgentSession 记忆 ----------

class TestMemory:
    def test_get_session_returns_empty(self, store):
        s = store.get_session("p1", "r1", "a1")
        assert s["conversation_id"] == "r1:a1"
        assert s["memory_state"] == {}

    def test_set_memory_insert_then_get(self, store):
        store.set_memory("p1", "r1", "a1", {"mood": "平静"})
        assert store.get_memory("p1", "r1", "a1") == {"mood": "平静"}

    def test_set_memory_upsert(self, store):
        store.set_memory("p1", "r1", "a1", {"mood": "平静"})
        store.set_memory("p1", "r1", "a1", {"mood": "愤怒"})
        assert store.get_memory("p1", "r1", "a1") == {"mood": "愤怒"}

    def test_memory_namespace_isolated(self, store):
        store.set_memory("p1", "r1", "a1", {"x": 1})
        store.set_memory("p1", "r2", "a1", {"y": 2})
        assert store.get_memory("p1", "r1", "a1") == {"x": 1}
        assert store.get_memory("p1", "r2", "a1") == {"y": 2}
