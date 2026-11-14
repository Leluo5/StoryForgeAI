# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.agent_management.agent_grouping import build_tree
from modules.agent_management.agent_store import AgentStore


@pytest.fixture()
def store(tmp_path):
    return AgentStore(str(tmp_path / "agents"))


def _seed(store):
    store.create_agent("p1", {"project_id": "p1", "kind": "flow_step_agent",
                              "name": "第1步", "step_order": 1, "source": "template"})
    store.create_agent("p1", {"project_id": "p1", "kind": "flow_step_agent",
                              "name": "第2步", "step_order": 2, "source": "template"})
    store.create_agent("p1", {"project_id": "p1", "kind": "role_agent",
                              "name": "角色Agent", "role_id": "r1"})
    store.create_agent("p1", {"project_id": "p1", "kind": "tool_agent",
                              "name": "大纲工具A", "tool_name": "gen_outline", "is_default": True})
    store.create_agent("p1", {"project_id": "p1", "kind": "tool_agent",
                              "name": "大纲工具B", "tool_name": "gen_outline"})


def _find(node, key):
    if node["key"] == key:
        return node
    for child in node["children"]:
        found = _find(child, key)
        if found:
            return found
    return None


def test_auto_groups_by_project_role_tool_and_flow(store):
    _seed(store)
    agents = store.list_agents("p1")
    tree = build_tree({"id": "p1", "title": "测试作品"}, agents,
                      store.load_group_overrides("p1"), role_names={"r1": "林远"})
    assert tree["key"] == "project:p1"
    assert _find(tree, "flow_group")["count"] == 2
    assert _find(tree, "role:p1:r1")["name"] == "角色：林远"
    assert _find(tree, "tool:p1:gen_outline")["count"] == 2


def test_override_alias_sort_and_hidden(store):
    _seed(store)
    store.upsert_override("p1", "role:p1:r1", name="主角组", sort_order=1)
    store.upsert_override("p1", "flow_group", hidden=True)
    agents = store.list_agents("p1")
    tree = build_tree({"id": "p1", "title": "测试作品"}, agents,
                      store.load_group_overrides("p1"), role_names={"r1": "林远"})
    assert _find(tree, "role:p1:r1")["name"] == "主角组"
    assert _find(tree, "flow_group") is None


def test_manual_group_takes_precedence(store):
    _seed(store)
    group = store.create_manual_group("p1", "project:p1", "我的分组")
    role_agent = next(a for a in store.list_agents("p1") if a["kind"] == "role_agent")
    store.update_agent("p1", role_agent["id"], {"manual_group_key": group["id"]})
    tree = build_tree({"id": "p1", "title": "测试作品"}, store.list_agents("p1"),
                      store.load_group_overrides("p1"), role_names={"r1": "林远"})
    manual = _find(tree, group["id"])
    assert manual["count"] == 1
    assert manual["agents"][0]["id"] == role_agent["id"]
    assert _find(tree, "role:p1:r1") is None
