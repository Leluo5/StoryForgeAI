# 智能体管理模块与作品级 11 步流程 Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `modules/agent_management` 模块，统一管理角色/工具/作品级 11 步流程 Agent，并在创建作品与角色时自动开通默认 Agent 与绑定，保证多角色并发调用完全隔离。

**Architecture:** 每 Agent 一个 JSON 文件（`data/agents/<project_id>/<agent_id>.json`），分组树实时计算 + `_groups.json` 覆盖层；`AgentService` 负责生命周期、默认开通、切换与迁移；`novel_creation` 通过回调与 resolver 接入，避免循环依赖；每角色流程进度独立存 `data/flows/<project_id>/<role_id>.json`。

**Tech Stack:** Python 3.9+、Flask 2.3、pytest、JSON 文件 + `FileLock` + `atomic_write_json`。

**设计规格:** [2026-11-15-agent-management-design.md](../specs/2026-11-15-agent-management-design.md)

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `config/default_flow_agents.json` | 11 步流程 Agent 全局模板 |
| `modules/agent_management/__init__.py` | 模块导出 |
| `modules/agent_management/types.py` | 枚举、默认值、字段校验 |
| `modules/agent_management/agent_store.py` | 单 Agent 文件 CRUD、版本快照、`_groups.json` 读写、默认切换 |
| `modules/agent_management/agent_grouping.py` | 虚拟分组树 + 自动规则 + 覆盖层合并 |
| `modules/agent_management/agent_service.py` | 生命周期编排、默认开通、角色默认绑定、工具切换、迁移 |
| `modules/agent_management/routes.py` | `/api/agents/*`、`/api/roles/<id>/agents/reset-default`、`/api/roles/<id>/flow-progress` |
| `modules/novel_creation/flow_progress_store.py` | 每角色流程进度文件与执行锁 |
| `modules/novel_creation/role_store.py`（改） | 绑定新增 `agent_ref_id`；角色生命周期回调 |
| `modules/novel_creation/role_agent_scheduler.py`（改） | 按 `agent_ref_id` 解析 Agent 配置 |
| `modules/novel_creation/step_flow_engine.py`（改） | 记录/恢复每角色进度 |
| `modules/novel_creation/routes.py`（改） | 创建作品后开通默认 Agent；工具调用注入默认工具 Agent |
| `app.py`（改） | 装配、蓝图注册、启动迁移 |
| `config_loader.py` / `app.py`（改） | 读取 11 步模板并装配模块 |

---

## Task 1: 11 步模板与类型校验层

**Files:**
- Create: `config/default_flow_agents.json`
- Create: `modules/agent_management/__init__.py`
- Create: `modules/agent_management/types.py`
- Test: `tests/test_agent_types.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_agent_types.py
# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.agent_management.types import (
    default_model_config,
    validate_agent_identity,
    validate_model_config,
    validate_platform_config,
)
from modules.common.errors import AppError


def test_default_model_config_has_ten_fields():
    cfg = default_model_config()
    assert cfg == {
        "model": "", "temperature": 0.7, "top_p": 1.0, "max_tokens": 2048,
        "system_prompt": "", "stream": False,
        "frequency_penalty": 0, "presence_penalty": 0,
        "response_format": "text", "stop": [],
    }


def test_validate_model_config_normalizes_and_rejects_out_of_range():
    cfg = validate_model_config({"temperature": 1.2, "max_tokens": 100, "stop": ["x"]})
    assert cfg["temperature"] == 1.2
    assert cfg["max_tokens"] == 100
    assert cfg["stop"] == ["x"]
    with pytest.raises(AppError):
        validate_model_config({"temperature": 3})
    with pytest.raises(AppError):
        validate_model_config({"response_format": "xml"})
    with pytest.raises(AppError):
        validate_model_config({"stop": ["a", "b", "c", "d", "e"]})


def test_validate_platform_config_keeps_only_non_secret_fields():
    assert validate_platform_config("coze", {"bot_id": "b1", "token": "secret"}) == {
        "bot_id": "b1", "workspace_id": ""
    }
    assert validate_platform_config("trae", {"agent_id": "a1"}) == {
        "agent_id": "a1", "endpoint": ""
    }
    with pytest.raises(AppError):
        validate_platform_config("openai", {})


def test_validate_agent_identity_enforces_kind_fields():
    validate_agent_identity("role_agent", {"role_id": "r1"})
    validate_agent_identity("tool_agent", {"tool_name": "gen_outline"})
    validate_agent_identity("flow_step_agent", {"step_order": 1})
    with pytest.raises(AppError):
        validate_agent_identity("role_agent", {"tool_name": "x"})
    with pytest.raises(AppError):
        validate_agent_identity("flow_step_agent", {"step_order": 12})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_agent_types.py -q`
Expected: FAIL，`ModuleNotFoundError: No module named 'modules.agent_management'`

- [ ] **Step 3: 写实现**

```python
# config/default_flow_agents.json
{
  "version": 1,
  "steps": [
    {"step_order": 1, "name": "外貌特征", "desc": "角色外观设定", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 2, "name": "个性特点", "desc": "性格特质", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 3, "name": "思维方式", "desc": "认知模式", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 4, "name": "个人能力", "desc": "技能特长", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 5, "name": "情感状态", "desc": "当前情绪", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 6, "name": "文化背景", "desc": "出身文化", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 7, "name": "信仰道德", "desc": "价值观与信念", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 8, "name": "成长线", "desc": "成长弧线", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 9, "name": "经历沉淀", "desc": "过往经历", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 10, "name": "人际关系", "desc": "社交网络", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}},
    {"step_order": 11, "name": "情节发展", "desc": "参与剧情", "platform": "coze", "platform_config": {"bot_id": "", "workspace_id": ""}, "model_config": {}}
  ]
}
```

```python
# modules/agent_management/__init__.py
# -*- coding: utf-8 -*-
"""智能体管理模块（与 knowledge_base / novel_creation 同级）。"""
```

```python
# modules/agent_management/types.py
# -*- coding: utf-8 -*-
"""Agent 枚举、默认值与字段校验。"""

from __future__ import annotations

from typing import Any, Dict, Optional

from ..common.errors import bad_request

KINDS = {"role_agent", "tool_agent", "flow_step_agent"}
PLATFORMS = {"coze", "trae"}
STATUSES = {"active", "disabled", "archived"}
CHANGE_TYPES = {"create", "update", "archive", "restore", "rollback"}
RESPONSE_FORMATS = {"text", "json", "markdown"}
SCOPES = {"project", "role"}
MAX_VERSIONS = 50
STEP_MIN, STEP_MAX = 1, 11


def default_model_config(overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """返回 10 项模型参数的默认值，并合并 overrides。"""
    cfg = {
        "model": "",
        "temperature": 0.7,
        "top_p": 1.0,
        "max_tokens": 2048,
        "system_prompt": "",
        "stream": False,
        "frequency_penalty": 0,
        "presence_penalty": 0,
        "response_format": "text",
        "stop": [],
    }
    if overrides:
        cfg.update(overrides)
    return cfg


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_model_config(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """校验并归一化模型参数；越界或非法类型抛 400。"""
    raw = raw or {}
    if not isinstance(raw, dict):
        raise bad_request("model_config 须为对象")
    cfg = default_model_config(raw)

    if not isinstance(cfg["model"], str):
        raise bad_request("model 须为字符串")
    if not _is_number(cfg["temperature"]) or not (0 <= cfg["temperature"] <= 2):
        raise bad_request("temperature 须为 0-2 数字")
    if not _is_number(cfg["top_p"]) or not (0 <= cfg["top_p"] <= 1):
        raise bad_request("top_p 须为 0-1 数字")
    if not isinstance(cfg["max_tokens"], int) or isinstance(cfg["max_tokens"], bool) \
            or not (1 <= cfg["max_tokens"] <= 32768):
        raise bad_request("max_tokens 须为 1-32768 整数")
    if not isinstance(cfg["system_prompt"], str):
        raise bad_request("system_prompt 须为字符串")
    if not isinstance(cfg["stream"], bool):
        raise bad_request("stream 须为布尔值")
    for key in ("frequency_penalty", "presence_penalty"):
        if not _is_number(cfg[key]) or not (-2 <= cfg[key] <= 2):
            raise bad_request(f"{key} 须为 -2 到 2 数字")
    if cfg["response_format"] not in RESPONSE_FORMATS:
        raise bad_request("response_format 须为 text/json/markdown")
    stop = cfg["stop"]
    if not isinstance(stop, list) or len(stop) > 4 \
            or any(not isinstance(s, str) or len(s) > 64 for s in stop):
        raise bad_request("stop 须为最多 4 项、每项不超过 64 字符的字符串数组")
    cfg["temperature"] = float(cfg["temperature"])
    cfg["top_p"] = float(cfg["top_p"])
    cfg["frequency_penalty"] = float(cfg["frequency_penalty"])
    cfg["presence_penalty"] = float(cfg["presence_penalty"])
    return cfg


def validate_platform_config(platform: str, raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """只保留平台非敏感字段，禁止把 token 写入 Agent 文件。"""
    if platform not in PLATFORMS:
        raise bad_request("platform 须为 coze 或 trae")
    raw = raw or {}
    if not isinstance(raw, dict):
        raise bad_request("platform_config 须为对象")
    if platform == "coze":
        return {"bot_id": str(raw.get("bot_id") or ""),
                "workspace_id": str(raw.get("workspace_id") or "")}
    return {"agent_id": str(raw.get("agent_id") or ""),
            "endpoint": str(raw.get("endpoint") or "")}


def validate_agent_identity(kind: str, fields: Dict[str, Any]) -> None:
    """校验 kind 与归属字段组合。"""
    if kind not in KINDS:
        raise bad_request("kind 须为 role_agent/tool_agent/flow_step_agent")
    role_id = fields.get("role_id")
    tool_name = fields.get("tool_name")
    step_order = fields.get("step_order")
    if kind == "role_agent":
        if not role_id or tool_name or step_order is not None:
            raise bad_request("role_agent 必须且只能提供 role_id")
    elif kind == "tool_agent":
        if not tool_name or role_id or step_order is not None:
            raise bad_request("tool_agent 必须且只能提供 tool_name")
    else:
        if not isinstance(step_order, int) or isinstance(step_order, bool) \
                or not (STEP_MIN <= step_order <= STEP_MAX):
            raise bad_request("flow_step_agent 的 step_order 须为 1-11 整数")
        if role_id or tool_name:
            raise bad_request("flow_step_agent 不能提供 role_id/tool_name")
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_agent_types.py -q`
Expected: `6 passed`

- [ ] **Step 5: 提交**

```bash
git add config/default_flow_agents.json modules/agent_management tests/test_agent_types.py
git commit -m "feat(agent-management): 新增11步模板与Agent类型校验层"
```

---

## Task 2: AgentStore 单文件 CRUD 与版本快照

**Files:**
- Create: `modules/agent_management/agent_store.py`
- Test: `tests/test_agent_store.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_agent_store.py
# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.agent_management.agent_store import AgentStore
from modules.common.errors import AppError


@pytest.fixture()
def store(tmp_path):
    return AgentStore(str(tmp_path / "agents"))


def _payload(**overrides):
    data = {
        "project_id": "p1", "kind": "role_agent", "name": "角色甲",
        "role_id": "r1", "platform": "coze",
        "platform_config": {"bot_id": "bot-1", "workspace_id": ""},
        "model_config": {"temperature": 0.5},
    }
    data.update(overrides)
    return data


def test_create_read_update_delete(store):
    agent = store.create_agent("p1", _payload())
    assert agent["id"]
    assert agent["status"] == "active"
    assert agent["model_config"]["temperature"] == 0.5
    assert agent["version_no"] == 1
    assert len(agent["versions"]) == 1

    got = store.get_agent("p1", agent["id"])
    assert got["name"] == "角色甲"
    assert "versions" not in got

    updated = store.update_agent("p1", agent["id"], {"name": "角色乙"}, note="改名")
    assert updated["name"] == "角色乙"
    assert updated["version_no"] == 2
    assert len(store.get_agent("p1", agent["id"], include_versions=True)["versions"]) == 2

    assert store.delete_agent("p1", agent["id"], force=True) is True
    with pytest.raises(AppError):
        store.get_agent("p1", agent["id"])


def test_archive_restore_and_delete_requires_archive(store):
    agent = store.create_agent("p1", _payload())
    with pytest.raises(AppError) as ei:
        store.delete_agent("p1", agent["id"])
    assert ei.value.code == 409

    archived = store.archive_agent("p1", agent["id"])
    assert archived["status"] == "archived"
    assert archived["archived_at"]

    restored = store.restore_agent("p1", agent["id"])
    assert restored["status"] == "active"
    assert restored["archived_at"] is None


def test_version_limit_trims_oldest(store):
    agent = store.create_agent("p1", _payload())
    for i in range(60):
        store.update_agent("p1", agent["id"], {"description": str(i)})
    versions = store.get_agent("p1", agent["id"], include_versions=True)["versions"]
    assert len(versions) == 50
    assert versions[-1]["snapshot"]["description"] == "59"


def test_credentials_never_persisted(store):
    agent = store.create_agent("p1", _payload(platform_config={"bot_id": "b", "token": "secret"}))
    raw = open(store._path("p1", agent["id"]), "r", encoding="utf-8").read()
    assert "secret" not in raw
    assert "token" not in agent["platform_config"]


def test_duplicate_flow_step_rejected(store):
    store.create_agent("p1", _payload(kind="flow_step_agent", role_id=None, step_order=1))
    with pytest.raises(AppError) as ei:
        store.create_agent("p1", _payload(kind="flow_step_agent", role_id=None, step_order=1))
    assert ei.value.code == 409
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_agent_store.py -q`
Expected: FAIL，`ModuleNotFoundError: No module named 'modules.agent_management.agent_store'`

- [ ] **Step 3: 写实现**

```python
# modules/agent_management/agent_store.py
# -*- coding: utf-8 -*-
"""单 Agent 文件存储：CRUD、版本快照、分组覆盖层、工具默认切换。"""

from __future__ import annotations

import copy
import os
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, conflict, not_found
from ..common.storage import FileLock, atomic_write_json, new_id, now_iso, read_json
from .types import (
    MAX_VERSIONS, STATUSES,
    validate_agent_identity, validate_model_config, validate_platform_config,
)


class AgentStore:
    """data/agents/<project_id>/<agent_id>.json 存储。"""

    def __init__(self, root_dir: str) -> None:
        self.root_dir = root_dir
        os.makedirs(root_dir, exist_ok=True)

    # ---------- 路径与锁 ----------

    def _project_dir(self, project_id: str) -> str:
        path = os.path.join(self.root_dir, project_id)
        os.makedirs(path, exist_ok=True)
        os.makedirs(os.path.join(path, ".locks"), exist_ok=True)
        return path

    def _path(self, project_id: str, agent_id: str) -> str:
        return os.path.join(self._project_dir(project_id), f"{agent_id}.json")

    def _lock(self, project_id: str, agent_id: str) -> FileLock:
        return FileLock(os.path.join(self._project_dir(project_id), ".locks", f"{agent_id}.lock"))

    def _groups_path(self, project_id: str) -> str:
        return os.path.join(self._project_dir(project_id), "_groups.json")

    def _groups_lock(self, project_id: str) -> FileLock:
        return FileLock(os.path.join(self._project_dir(project_id), ".locks", "_groups.lock"))

    # ---------- Agent CRUD ----------

    def list_agents(self, project_id: str) -> List[Dict[str, Any]]:
        """列出项目全部 Agent（不含 versions，_groups.json 除外）。"""
        directory = self._project_dir(project_id)
        agents: List[Dict[str, Any]] = []
        for name in os.listdir(directory):
            if not name.endswith(".json") or name.startswith("_"):
                continue
            data = read_json(os.path.join(directory, name), None)
            if not isinstance(data, dict) or not data.get("id"):
                continue
            data.pop("versions", None)
            agents.append(data)
        return sorted(agents, key=lambda a: (a.get("kind", ""), a.get("step_order") or 0, a.get("name", "")))

    def get_agent(self, project_id: str, agent_id: str, include_versions: bool = False) -> Dict[str, Any]:
        """读取 Agent；默认剥离 versions。"""
        data = read_json(self._path(project_id, agent_id), None)
        if not isinstance(data, dict) or not data.get("id"):
            raise not_found(f"Agent 不存在: {agent_id}")
        if not include_versions:
            data = copy.deepcopy(data)
            data.pop("versions", None)
        return data

    def create_agent(self, project_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """创建 Agent，写版本 1 快照并做唯一性校验。"""
        kind = payload.get("kind", "")
        name = payload.get("name")
        if not name or not str(name).strip():
            raise bad_request("name 不能为空")
        validate_agent_identity(kind, payload)
        platform = payload.get("platform") or "coze"
        platform_config = validate_platform_config(platform, payload.get("platform_config"))
        model_config = validate_model_config(payload.get("model_config"))
        now = now_iso()
        agent = {
            "id": new_id(),
            "project_id": project_id,
            "kind": kind,
            "name": str(name).strip(),
            "description": payload.get("description") or "",
            "role_id": payload.get("role_id"),
            "tool_name": payload.get("tool_name"),
            "step_order": payload.get("step_order"),
            "scope": payload.get("scope") or ("role" if kind == "role_agent" else "project"),
            "platform": platform,
            "platform_config": platform_config,
            "credential_source": "global",
            "model_config": model_config,
            "status": payload.get("status") or "active",
            "is_default": bool(payload.get("is_default", False)),
            "source": payload.get("source") or "manual",
            "tags": list(payload.get("tags") or []),
            "manual_group_key": payload.get("manual_group_key"),
            "version_no": 1,
            "versions": [],
            "created_at": now,
            "updated_at": now,
            "archived_at": None,
        }
        if agent["status"] not in STATUSES:
            raise bad_request("status 须为 active/disabled/archived")
        agent["versions"].append(self._snapshot(agent, "create", payload.get("note", "")))
        with self._lock(project_id, agent["id"]):
            self._check_unique(project_id, agent)
            atomic_write_json(self._path(project_id, agent["id"]), agent)
        return self.get_agent(project_id, agent["id"])

    def update_agent(self, project_id: str, agent_id: str, updates: Dict[str, Any],
                     note: str = "") -> Dict[str, Any]:
        """白名单更新并写版本快照。"""
        allowed = {
            "name", "description", "platform", "platform_config", "model_config",
            "status", "is_default", "tags", "manual_group_key", "role_id",
            "tool_name", "step_order", "scope",
        }
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            for key, value in updates.items():
                if key not in allowed:
                    raise bad_request(f"非法 Agent 字段: {key}")
            merged = copy.deepcopy(agent)
            merged.update(updates)
            validate_agent_identity(merged["kind"], merged)
            merged["platform_config"] = validate_platform_config(
                merged.get("platform") or "coze", merged.get("platform_config")
            )
            merged["model_config"] = validate_model_config(merged.get("model_config"))
            if merged["status"] not in STATUSES:
                raise bad_request("status 须为 active/disabled/archived")
            self._check_unique(project_id, merged, exclude_id=agent_id)
            merged["version_no"] = int(agent.get("version_no", 1)) + 1
            merged["updated_at"] = now_iso()
            merged["versions"] = list(agent.get("versions") or [])
            merged["versions"].append(self._snapshot(merged, "update", note))
            merged["versions"] = merged["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, agent_id), merged)
        return self.get_agent(project_id, agent_id)

    def archive_agent(self, project_id: str, agent_id: str) -> Dict[str, Any]:
        """归档并写快照。"""
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            agent["status"] = "archived"
            agent["archived_at"] = now_iso()
            agent["version_no"] = int(agent.get("version_no", 1)) + 1
            agent["updated_at"] = agent["archived_at"]
            agent["versions"] = list(agent.get("versions") or [])
            agent["versions"].append(self._snapshot(agent, "archive", ""))
            agent["versions"] = agent["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, agent_id), agent)
        return self.get_agent(project_id, agent_id)

    def restore_agent(self, project_id: str, agent_id: str) -> Dict[str, Any]:
        """恢复为 active 并写快照。"""
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            agent["status"] = "active"
            agent["archived_at"] = None
            agent["version_no"] = int(agent.get("version_no", 1)) + 1
            agent["updated_at"] = now_iso()
            agent["versions"] = list(agent.get("versions") or [])
            agent["versions"].append(self._snapshot(agent, "restore", ""))
            agent["versions"] = agent["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, agent_id), agent)
        return self.get_agent(project_id, agent_id)

    def delete_agent(self, project_id: str, agent_id: str, force: bool = False) -> bool:
        """硬删除；默认要求已归档，force 可强制。"""
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            if agent.get("status") != "archived" and not force:
                raise conflict("Agent 未归档，需先归档或 force=true")
            try:
                os.unlink(self._path(project_id, agent_id))
            except FileNotFoundError:
                return False
        return True

    def get_versions(self, project_id: str, agent_id: str) -> List[Dict[str, Any]]:
        """返回版本列表（不含 snapshot 内容，仅摘要）。"""
        versions = self._load_full(project_id, agent_id).get("versions") or []
        return [{k: v for k, v in item.items() if k != "snapshot"} for item in versions]

    def rollback(self, project_id: str, agent_id: str, version_no: int) -> Dict[str, Any]:
        """回滚到指定版本，生成新版本号。"""
        with self._lock(project_id, agent_id):
            agent = self._load_full(project_id, agent_id)
            target = next((v for v in agent.get("versions", [])
                           if int(v.get("version_no", 0)) == int(version_no)), None)
            if target is None:
                raise not_found(f"版本不存在: {version_no}")
            snapshot = copy.deepcopy(target["snapshot"])
            versions = list(agent.get("versions") or [])
            next_version = int(agent.get("version_no", 1)) + 1
            agent.update(snapshot)
            agent["version_no"] = next_version
            agent["updated_at"] = now_iso()
            agent["versions"] = versions
            agent["versions"].append(self._snapshot(agent, "rollback", f"rollback to {version_no}"))
            agent["versions"] = agent["versions"][-MAX_VERSIONS:]
            atomic_write_json(self._path(project_id, agent_id), agent)
        return self.get_agent(project_id, agent_id)

    # ---------- 内部 ----------

    def _load_full(self, project_id: str, agent_id: str) -> Dict[str, Any]:
        data = read_json(self._path(project_id, agent_id), None)
        if not isinstance(data, dict) or not data.get("id"):
            raise not_found(f"Agent 不存在: {agent_id}")
        return data

    def _snapshot(self, agent: Dict[str, Any], change_type: str, note: str) -> Dict[str, Any]:
        snapshot = {k: copy.deepcopy(v) for k, v in agent.items()
                    if k not in ("versions",)}
        return {
            "version_no": agent.get("version_no", 1),
            "change_type": change_type,
            "note": note,
            "created_at": now_iso(),
            "snapshot": snapshot,
        }

    def _check_unique(self, project_id: str, agent: Dict[str, Any],
                      exclude_id: Optional[str] = None) -> None:
        for other in self.list_agents(project_id):
            if other["id"] == exclude_id:
                continue
            if agent["kind"] == "flow_step_agent" and other["kind"] == "flow_step_agent" \
                    and other.get("step_order") == agent.get("step_order"):
                raise conflict(f"step_order={agent.get('step_order')} 已存在流程 Agent")
            if agent["kind"] == "tool_agent" and other["kind"] == "tool_agent" \
                    and other.get("tool_name") == agent.get("tool_name") \
                    and other.get("is_default") and agent.get("is_default"):
                raise conflict(f"工具 {agent.get('tool_name')} 已存在默认 Agent")
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_agent_store.py -q`
Expected: `5 passed`

- [ ] **Step 5: 提交**

```bash
git add modules/agent_management/agent_store.py tests/test_agent_store.py
git commit -m "feat(agent-management): 实现单Agent文件存储与版本快照"
```

---

## Task 3: 分组覆盖层与虚拟分组树

**Files:**
- Create: `modules/agent_management/agent_grouping.py`
- Modify: `modules/agent_management/agent_store.py`
- Test: `tests/test_agent_grouping.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_agent_grouping.py
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_agent_grouping.py -q`
Expected: FAIL，`ModuleNotFoundError: No module named 'modules.agent_management.agent_grouping'`

- [ ] **Step 3: 写实现**

在 `agent_store.py` 末尾追加：

```python
    # ---------- 分组覆盖层 ----------

    def load_group_overrides(self, project_id: str) -> Dict[str, Any]:
        """读取 _groups.json；不存在返回空覆盖层。"""
        data = read_json(self._groups_path(project_id), None)
        if not isinstance(data, dict):
            data = {}
        data.setdefault("project_id", project_id)
        data.setdefault("schema_version", 1)
        data.setdefault("overrides", [])
        data.setdefault("manual_groups", [])
        return data

    def save_group_overrides(self, project_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """原子写 _groups.json。"""
        data = dict(data)
        data["project_id"] = project_id
        data["updated_at"] = now_iso()
        with self._groups_lock(project_id):
            atomic_write_json(self._groups_path(project_id), data)
        return data

    def upsert_override(self, project_id: str, key: str, **fields: Any) -> Dict[str, Any]:
        """upsert 分组覆盖：name/sort_order/hidden。"""
        if not key:
            raise bad_request("key 不能为空")
        data = self.load_group_overrides(project_id)
        item = next((o for o in data["overrides"] if o.get("key") == key), None)
        if item is None:
            item = {"key": key, "name": "", "sort_order": 0, "hidden": False}
            data["overrides"].append(item)
        for name in ("name", "sort_order", "hidden"):
            if name in fields:
                item[name] = fields[name]
        self.save_group_overrides(project_id, data)
        return item

    def delete_override(self, project_id: str, key: str) -> bool:
        """删除覆盖；不存在返回 False。"""
        data = self.load_group_overrides(project_id)
        before = len(data["overrides"])
        data["overrides"] = [o for o in data["overrides"] if o.get("key") != key]
        if len(data["overrides"]) == before:
            return False
        self.save_group_overrides(project_id, data)
        return True

    def create_manual_group(self, project_id: str, parent_key: str, name: str,
                            sort_order: int = 0) -> Dict[str, Any]:
        """新建手工分组。"""
        if not name or not str(name).strip():
            raise bad_request("分组名不能为空")
        data = self.load_group_overrides(project_id)
        group = {
            "id": f"manual:{new_id()}",
            "parent_key": parent_key,
            "name": str(name).strip(),
            "sort_order": int(sort_order),
        }
        data["manual_groups"].append(group)
        self.save_group_overrides(project_id, data)
        return group

    def delete_manual_group(self, project_id: str, group_id: str) -> bool:
        """删除手工分组；组内 Agent 回落自动分组。"""
        data = self.load_group_overrides(project_id)
        before = len(data["manual_groups"])
        data["manual_groups"] = [g for g in data["manual_groups"] if g.get("id") != group_id]
        if len(data["manual_groups"]) == before:
            return False
        self.save_group_overrides(project_id, data)
        for agent in self.list_agents(project_id):
            if agent.get("manual_group_key") == group_id:
                self.update_agent(project_id, agent["id"], {"manual_group_key": None})
        return True
```

创建 `agent_grouping.py`：

```python
# modules/agent_management/agent_grouping.py
# -*- coding: utf-8 -*-
"""虚拟分组树：自动规则 + 覆盖层合并。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


def build_tree(project: Dict[str, Any], agents: List[Dict[str, Any]],
               overrides: Dict[str, Any],
               role_names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """构建「作品 → 角色/工具/11步/手工」多级分组树。"""
    role_names = role_names or {}
    project_id = project.get("id", "")
    project_key = f"project:{project_id}"
    overrides_by_key = {o.get("key"): o for o in overrides.get("overrides", [])}
    hidden = {k for k, o in overrides_by_key.items() if o.get("hidden")}

    def make_node(key: str, name: str, kind: str, parent_key: Optional[str],
                  sort_order: int = 0) -> Dict[str, Any]:
        override = overrides_by_key.get(key) or {}
        return {
            "key": key,
            "name": override.get("name") or name,
            "kind": kind,
            "parent_key": parent_key,
            "sort_order": override.get("sort_order", sort_order),
            "count": 0,
            "children": [],
            "agents": [],
        }

    def summary(agent: Dict[str, Any]) -> Dict[str, Any]:
        return {k: agent.get(k) for k in
                ("id", "name", "kind", "status", "is_default", "step_order",
                 "tool_name", "platform", "role_id")}

    root = make_node(project_key, f"作品：{project.get('title', '')}", "project", None)
    flow_node = make_node("flow_group", "默认11步流程", "flow_group", project_key, 1)
    tool_node = make_node("tool_group", "小说工具", "tool_group", project_key, 2)
    role_nodes: Dict[str, Dict[str, Any]] = {}
    tool_nodes: Dict[str, Dict[str, Any]] = {}
    manual_nodes = {}
    for group in overrides.get("manual_groups", []):
        node = make_node(group["id"], group.get("name", "自定义分组"), "manual",
                         group.get("parent_key") or project_key, group.get("sort_order", 9))
        manual_nodes[group["id"]] = node

    for agent in agents:
        if agent.get("status") == "archived":
            continue
        kind = agent.get("kind")
        manual_key = agent.get("manual_group_key")
        target = None
        if manual_key and manual_key in manual_nodes:
            target = manual_nodes[manual_key]
        elif kind == "flow_step_agent":
            target = flow_node
        elif kind == "role_agent":
            role_id = agent.get("role_id") or ""
            key = f"role:{project_id}:{role_id}"
            if key in hidden:
                continue
            target = role_nodes.get(key)
            if target is None:
                target = make_node(key, f"角色：{role_names.get(role_id, role_id)}",
                                   "role", project_key, 0)
                role_nodes[key] = target
        elif kind == "tool_agent":
            tool_name = agent.get("tool_name") or ""
            key = f"tool:{project_id}:{tool_name}"
            if key in hidden:
                continue
            target = tool_nodes.get(key)
            if target is None:
                target = make_node(key, tool_name, "tool", tool_node["key"], 0)
                tool_nodes[key] = target
        if target is not None:
            target["agents"].append(summary(agent))
            target["count"] += 1

    def attach(parent: Dict[str, Any], children: List[Dict[str, Any]]) -> None:
        for child in sorted(children, key=lambda n: (n.get("sort_order", 0), n.get("name", ""))):
            if child["key"] in hidden:
                continue
            parent["children"].append(child)
            parent["count"] += child["count"]

    attach(flow_node, [])
    if not flow_node["agents"]:
        flow_node["children"] = []
    attach(tool_node, list(tool_nodes.values()))
    for manual in manual_nodes.values():
        parent = root if manual["parent_key"] == project_key else manual_nodes.get(manual["parent_key"], root)
        parent["children"].append(manual)
        parent["count"] += manual["count"]
    root_children = [flow_node, tool_node] + list(role_nodes.values())
    attach(root, root_children)
    return root
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_agent_grouping.py -q`
Expected: `3 passed`

- [ ] **Step 5: 提交**

```bash
git add modules/agent_management/agent_grouping.py modules/agent_management/agent_store.py tests/test_agent_grouping.py
git commit -m "feat(agent-management): 实现虚拟分组树与覆盖层"
```

---

## Task 4: RoleStore 扩展（agent_ref_id + 角色生命周期回调）

**Files:**
- Modify: `modules/novel_creation/role_store.py`
- Test: `tests/test_role_store_hooks.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_role_store_hooks.py
# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.novel_creation.role_store import RoleStore


def test_binding_supports_agent_ref_id(tmp_path):
    store = RoleStore(str(tmp_path))
    role = store.create_role("p1", "林远")
    binding = store.create_binding(
        "p1", role["id"], "bot-1", step_order=1, agent_ref_id="agent-1",
        model="gpt-4o", agent_env="coze",
    )
    assert binding["agent_ref_id"] == "agent-1"
    updated = store.update_binding("p1", binding["id"], agent_ref_id="agent-2")
    assert updated["agent_ref_id"] == "agent-2"


def test_create_and_delete_role_trigger_hooks(tmp_path):
    store = RoleStore(str(tmp_path))
    created = []
    deleted = []
    store.set_lifecycle_hooks(
        on_create=lambda pid, rid: created.append((pid, rid)),
        on_delete=lambda pid, rid: deleted.append((pid, rid)),
    )
    role = store.create_role("p1", "林远")
    assert created == [("p1", role["id"])]
    store.delete_role("p1", role["id"])
    assert deleted == [("p1", role["id"])]


def test_hook_failure_does_not_block_role_creation(tmp_path):
    store = RoleStore(str(tmp_path))
    store.set_lifecycle_hooks(on_create=lambda pid, rid: (_ for _ in ()).throw(RuntimeError("boom")))
    role = store.create_role("p1", "林远")
    assert store.get_role("p1", role["id"])["name"] == "林远"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_role_store_hooks.py -q`
Expected: FAIL，`AttributeError: 'RoleStore' object has no attribute 'set_lifecycle_hooks'`

- [ ] **Step 3: 写实现**

修改 `role_store.py`：

1. 文件顶部增加 logger：

```python
import logging

_logger = logging.getLogger(__name__)
```

2. `__init__` 增加回调属性：

```python
    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self._on_role_created = None
        self._on_role_deleted = None

    def set_lifecycle_hooks(self, on_create=None, on_delete=None) -> None:
        """注入角色生命周期回调（失败不阻断主流程）。"""
        self._on_role_created = on_create
        self._on_role_deleted = on_delete
```

3. `_validate_binding_extended_fields` 增加校验：

```python
    if "agent_ref_id" in fields:
        agent_ref_id = fields["agent_ref_id"]
        if agent_ref_id is not None and (
            not isinstance(agent_ref_id, str) or not agent_ref_id.strip()
        ):
            raise bad_request("agent_ref_id 须为非空字符串")
```

4. `create_binding` 的 `extended_fields` 增加 `agent_ref_id`：

```python
        extended_fields = {
            "depends_on": extra.get("depends_on", []),
            "model": extra.get("model"),
            "agent_env": extra.get("agent_env", "coze"),
            "agent_ref_id": extra.get("agent_ref_id"),
        }
```

5. `update_binding` 的 `allowed` 增加 `agent_ref_id`。

6. `create_role` 在 `with self._lock(...)` 结束后触发回调：

```python
        with self._lock(project_id):
            data = self._load(project_id)
            data["roles"].append(role)
            self._save(project_id, data)
        if self._on_role_created is not None:
            try:
                self._on_role_created(project_id, role["id"])
            except Exception as exc:  # noqa: BLE001 - 回调失败不阻断创建
                _logger.warning("[角色] 创建后回调失败: %s", exc)
        return role
```

7. `delete_role` 在保存后触发回调：

```python
            data["agent_sessions"] = [s for s in data["agent_sessions"] if s["role_id"] != role_id]
            self._save(project_id, data)
        if self._on_role_deleted is not None:
            try:
                self._on_role_deleted(project_id, role_id)
            except Exception as exc:  # noqa: BLE001 - 回调失败不阻断删除
                _logger.warning("[角色] 删除后回调失败: %s", exc)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_role_store_hooks.py tests/test_role_store.py -q`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add modules/novel_creation/role_store.py tests/test_role_store_hooks.py
git commit -m "feat(novel-creation): 角色绑定支持agent_ref_id与生命周期回调"
```

---

## Task 5: FlowProgressStore 每角色进度与执行锁

**Files:**
- Create: `modules/novel_creation/flow_progress_store.py`
- Test: `tests/test_flow_progress_store.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_flow_progress_store.py
# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.novel_creation.flow_progress_store import FlowProgressStore


@pytest.fixture()
def store(tmp_path):
    return FlowProgressStore(str(tmp_path / "flows"))


def test_start_record_finish_and_reset(store):
    progress = store.start("p1", "r1")
    assert progress["status"] == "running"
    assert progress["current_step"] == 0
    progress = store.record_step("p1", "r1", 1, "running")
    assert progress["current_step"] == 1
    progress = store.record_step("p1", "r1", 1, "done", output={"a": 1})
    assert progress["completed_steps"] == [1]
    progress = store.finish("p1", "r1", "done")
    assert progress["status"] == "done"
    reset = store.reset("p1", "r1")
    assert reset["status"] == "idle"
    assert reset["completed_steps"] == []


def test_roles_are_isolated(store):
    store.start("p1", "r1")
    store.start("p1", "r2")
    store.record_step("p1", "r1", 1, "done", output={"role": "r1"})
    assert store.get("p1", "r2")["completed_steps"] == []
    assert store.get("p1", "r1")["completed_steps"] == [1]


def test_same_role_lock_conflict(store):
    lock = store.lock("p1", "r1")
    assert lock.try_acquire() is True
    try:
        second = store.lock("p1", "r1")
        assert second.try_acquire() is False
    finally:
        lock.release()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_flow_progress_store.py -q`
Expected: FAIL，`ModuleNotFoundError`

- [ ] **Step 3: 写实现**

```python
# modules/novel_creation/flow_progress_store.py
# -*- coding: utf-8 -*-
"""每角色 11 步流程进度存储：data/flows/<project_id>/<role_id>.json。"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from ..common.storage import FileLock, atomic_write_json, new_id, now_iso, read_json


class FlowProgressStore:
    """按 (project_id, role_id) 隔离进度与执行锁。"""

    def __init__(self, root_dir: str) -> None:
        self.root_dir = root_dir
        os.makedirs(root_dir, exist_ok=True)

    def _project_dir(self, project_id: str) -> str:
        path = os.path.join(self.root_dir, project_id)
        os.makedirs(path, exist_ok=True)
        os.makedirs(os.path.join(path, ".locks"), exist_ok=True)
        return path

    def _path(self, project_id: str, role_id: str) -> str:
        return os.path.join(self._project_dir(project_id), f"{role_id}.json")

    def lock(self, project_id: str, role_id: str) -> FileLock:
        """返回该角色的执行锁（非阻塞 try_acquire 由调用方决定）。"""
        return FileLock(os.path.join(self._project_dir(project_id), ".locks", f"{role_id}.lock"))

    def get(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """读取进度；不存在返回 idle 空进度。"""
        data = read_json(self._path(project_id, role_id), None)
        if not isinstance(data, dict):
            data = {}
        return self._normalize(project_id, role_id, data)

    def start(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """开始一次新运行。"""
        return self._write(project_id, role_id, {
            "run_id": new_id(),
            "status": "running",
            "current_step": 0,
            "completed_steps": [],
            "steps": [],
            "context": {},
            "started_at": now_iso(),
            "last_error": "",
        })

    def record_step(self, project_id: str, role_id: str, step_order: int,
                    status: str, output: Optional[Dict[str, Any]] = None,
                    error: str = "") -> Dict[str, Any]:
        """更新单步状态；done 时写入 completed_steps。"""
        data = self.get(project_id, role_id)
        data["current_step"] = step_order
        steps = data["steps"]
        step = next((s for s in steps if int(s.get("step_order", 0)) == step_order), None)
        if step is None:
            step = {"step_order": step_order, "status": "pending", "output": {},
                    "started_at": now_iso(), "finished_at": "", "error": ""}
            steps.append(step)
        step["status"] = status
        step["output"] = output or step.get("output") or {}
        step["error"] = error
        if status == "running":
            step["started_at"] = step.get("started_at") or now_iso()
        if status in ("done", "failed"):
            step["finished_at"] = now_iso()
        if status == "done" and step_order not in data["completed_steps"]:
            data["completed_steps"].append(step_order)
            data["completed_steps"].sort()
        data["steps"] = steps
        return self._write(project_id, role_id, data)

    def finish(self, project_id: str, role_id: str, status: str,
               error: str = "") -> Dict[str, Any]:
        """结束运行：done/failed。"""
        data = self.get(project_id, role_id)
        data["status"] = status
        data["last_error"] = error
        return self._write(project_id, role_id, data)

    def reset(self, project_id: str, role_id: str) -> Dict[str, Any]:
        """重置为 idle。"""
        return self._write(project_id, role_id, {
            "run_id": "", "status": "idle", "current_step": 0,
            "completed_steps": [], "steps": [], "context": {},
            "started_at": "", "last_error": "",
        })

    def delete_role(self, project_id: str, role_id: str) -> bool:
        """删除角色进度文件（角色删除级联）。"""
        try:
            os.unlink(self._path(project_id, role_id))
            return True
        except FileNotFoundError:
            return False

    # ---------- 内部 ----------

    def _normalize(self, project_id: str, role_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        data.setdefault("project_id", project_id)
        data.setdefault("role_id", role_id)
        data.setdefault("run_id", "")
        data.setdefault("status", "idle")
        data.setdefault("current_step", 0)
        data.setdefault("completed_steps", [])
        data.setdefault("steps", [])
        data.setdefault("context", {})
        data.setdefault("started_at", "")
        data.setdefault("updated_at", "")
        data.setdefault("last_error", "")
        return data

    def _write(self, project_id: str, role_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        data = self._normalize(project_id, role_id, dict(data))
        data["updated_at"] = now_iso()
        with FileLock(self._path(project_id, role_id) + ".lock"):
            atomic_write_json(self._path(project_id, role_id), data)
        return data
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_flow_progress_store.py -q`
Expected: `3 passed`

- [ ] **Step 5: 提交**

```bash
git add modules/novel_creation/flow_progress_store.py tests/test_flow_progress_store.py
git commit -m "feat(novel-creation): 新增每角色流程进度存储"
```

---

## Task 6: AgentService 作品默认 Agent 开通与角色默认绑定

**Files:**
- Create: `modules/agent_management/agent_service.py`
- Test: `tests/test_agent_service_defaults.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_agent_service_defaults.py
# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.agent_management.agent_service import AgentService
from modules.agent_management.agent_store import AgentStore
from modules.novel_creation.project_store import ProjectStore
from modules.novel_creation.role_store import RoleStore


class _Registry:
    def list_tools(self):
        return [{"name": "gen_outline", "role_link": True},
                {"name": "gen_chapter", "role_link": True}]


TEMPLATE = [
    {"step_order": i, "name": f"步骤{i}", "desc": f"描述{i}", "platform": "coze",
     "platform_config": {"bot_id": f"bot-{i}"}, "model_config": {"model": "m1"}}
    for i in range(1, 12)
]


@pytest.fixture()
def env(tmp_path):
    data = tmp_path / "projects"
    store = AgentStore(str(tmp_path / "agents"))
    project_store = ProjectStore(str(data))
    role_store = RoleStore(str(data))
    service = AgentService(store, project_store, role_store,
                           tool_registry=_Registry(), flow_template=TEMPLATE)
    return service, store, project_store, role_store


def test_provision_creates_11_flow_and_tool_agents(env):
    service, store, project_store, _ = env
    project = project_store.create_project("测试作品")
    result = service.provision_project_defaults(project)
    assert len(result["created"]["flow_agents"]) == 11
    assert len(result["created"]["tool_agents"]) == 2
    agents = store.list_agents(project["id"])
    assert len([a for a in agents if a["kind"] == "flow_step_agent"]) == 11
    assert len([a for a in agents if a["kind"] == "tool_agent"]) == 2
    assert sum(1 for a in agents if a["kind"] == "tool_agent" and a["is_default"]) == 2


def test_provision_is_idempotent(env):
    service, store, project_store, _ = env
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    second = service.provision_project_defaults(project)
    assert second["created"]["flow_agents"] == []
    assert second["created"]["tool_agents"] == []
    assert len(store.list_agents(project["id"])) == 13


def test_bind_role_default_flow_creates_11_bindings(env):
    service, store, project_store, role_store = env
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    role = role_store.create_role(project["id"], "林远")
    created = service.bind_role_default_flow(project["id"], role["id"])
    assert len(created) == 11
    bindings = role_store.get_bindings(project["id"], role["id"])
    assert [b["step_order"] for b in bindings] == list(range(1, 12))
    assert all(b["agent_ref_id"] for b in bindings)
    assert all(b["agent_id"].startswith("bot-") for b in bindings)


def test_bind_does_not_overwrite_custom_step(env):
    service, store, project_store, role_store = env
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    role = role_store.create_role(project["id"], "林远")
    service.bind_role_default_flow(project["id"], role["id"])
    binding = role_store.get_bindings(project["id"], role["id"])[0]
    custom = store.create_agent(project["id"], {
        "project_id": project["id"], "kind": "role_agent",
        "name": "自定义", "role_id": role["id"],
    })
    role_store.update_binding(project["id"], binding["id"], agent_ref_id=custom["id"])
    service.bind_role_default_flow(project["id"], role["id"])
    again = role_store.get_bindings(project["id"], role["id"])[0]
    assert again["agent_ref_id"] == custom["id"]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_agent_service_defaults.py -q`
Expected: FAIL，`ModuleNotFoundError: No module named 'modules.agent_management.agent_service'`

- [ ] **Step 3: 写实现**

```python
# modules/agent_management/agent_service.py
# -*- coding: utf-8 -*-
"""Agent 业务编排：默认开通、角色绑定、工具切换、迁移。"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from ..common.errors import bad_request, not_found
from ..common.storage import read_json


class AgentService:
    """智能体管理领域服务。"""

    def __init__(self, store: Any, project_store: Any, role_store: Any,
                 tool_registry: Any = None, flow_template: Optional[List[Dict[str, Any]]] = None,
                 version_limit: int = 50) -> None:
        self.store = store
        self.project_store = project_store
        self.role_store = role_store
        self.tool_registry = tool_registry
        self.flow_template = flow_template or []
        self.version_limit = version_limit
        self._validate_flow_template()

    # ---------- 模板 ----------

    def _validate_flow_template(self) -> None:
        orders = [int(s.get("step_order", 0)) for s in self.flow_template]
        if sorted(orders) != list(range(1, 12)):
            raise bad_request("flow_template 必须包含 1-11 完整步骤")

    # ---------- 作品默认 Agent 开通 ----------

    def provision_project_defaults(self, project: Any) -> Dict[str, Any]:
        """幂等生成 11 个流程 Agent 与每个工具 1 个默认工具 Agent。"""
        project_id = project["id"] if isinstance(project, dict) else str(project)
        created = {"flow_agents": [], "tool_agents": []}
        errors: List[Dict[str, Any]] = []
        existing = self.store.list_agents(project_id)
        flow_by_step = {a.get("step_order") for a in existing if a["kind"] == "flow_step_agent"}
        for step in self.flow_template:
            order = int(step["step_order"])
            if order in flow_by_step:
                continue
            try:
                created["flow_agents"].append(self.store.create_agent(project_id, {
                    "project_id": project_id,
                    "kind": "flow_step_agent",
                    "name": f"默认流程·{order}-{step.get('name', '')}".rstrip("-"),
                    "description": step.get("desc", ""),
                    "step_order": order,
                    "scope": "project",
                    "platform": step.get("platform", "coze"),
                    "platform_config": step.get("platform_config") or {},
                    "model_config": step.get("model_config") or {},
                    "source": "template",
                }))
            except Exception as exc:  # noqa: BLE001 - 单项失败不阻断其余
                errors.append({"step_order": order, "error": str(exc)})
        tools = self.tool_registry.list_tools() if self.tool_registry else []
        existing_tools = {a.get("tool_name") for a in existing if a["kind"] == "tool_agent"}
        for meta in tools:
            name = meta.get("name")
            if not name or name in existing_tools:
                continue
            try:
                created["tool_agents"].append(self.store.create_agent(project_id, {
                    "project_id": project_id,
                    "kind": "tool_agent",
                    "name": f"工具·{name}",
                    "description": meta.get("description", ""),
                    "tool_name": name,
                    "scope": "project",
                    "platform": "coze",
                    "platform_config": {},
                    "model_config": {},
                    "is_default": True,
                    "source": "auto",
                }))
            except Exception as exc:  # noqa: BLE001
                errors.append({"tool_name": name, "error": str(exc)})
        self._ensure_tool_defaults(project_id)
        return {"created": created, "errors": errors}

    def _ensure_tool_defaults(self, project_id: str) -> None:
        """每个工具有且仅有一个默认 Agent。"""
        by_tool: Dict[str, List[Dict[str, Any]]] = {}
        for agent in self.store.list_agents(project_id):
            if agent["kind"] == "tool_agent" and agent.get("status") == "active":
                by_tool.setdefault(agent.get("tool_name") or "", []).append(agent)
        for tool_name, agents in by_tool.items():
            defaults = [a for a in agents if a.get("is_default")]
            if len(defaults) == 1:
                continue
            keep = defaults[0] if defaults else agents[0]
            for agent in agents:
                expected = agent["id"] == keep["id"]
                if bool(agent.get("is_default")) != expected:
                    self.store.update_agent(project_id, agent["id"], {"is_default": expected})

    # ---------- 角色默认绑定 ----------

    def bind_role_default_flow(self, project_id: str, role_id: str) -> List[Dict[str, Any]]:
        """为角色补齐 11 条默认绑定；不覆盖已存在步骤。"""
        self.role_store.get_role(project_id, role_id)
        flow_agents = self._active_flow_agents(project_id)
        if len(flow_agents) < 11:
            self.provision_project_defaults(project_id)
            flow_agents = self._active_flow_agents(project_id)
        existing = {b["step_order"] for b in self.role_store.get_bindings(project_id, role_id)}
        created: List[Dict[str, Any]] = []
        for agent in sorted(flow_agents, key=lambda a: int(a["step_order"])):
            order = int(agent["step_order"])
            if order in existing:
                continue
            bot_id = (agent.get("platform_config") or {}).get("bot_id") or agent["id"]
            created.append(self.role_store.create_binding(
                project_id, role_id, bot_id, step_order=order, enabled=True,
                model=(agent.get("model_config") or {}).get("model") or None,
                agent_env=agent.get("platform", "coze"),
                agent_ref_id=agent["id"],
            ))
        return created

    def _active_flow_agents(self, project_id: str) -> List[Dict[str, Any]]:
        return [a for a in self.store.list_agents(project_id)
                if a["kind"] == "flow_step_agent" and a.get("status") == "active"]

    def reset_role_default_flow(self, project_id: str, role_id: str,
                                mode: str = "fill") -> List[Dict[str, Any]]:
        """恢复默认绑定：fill 只补缺，replace 整体重建。"""
        if mode not in ("fill", "replace"):
            raise bad_request("mode 须为 fill 或 replace")
        if mode == "replace":
            for binding in self.role_store.get_bindings(project_id, role_id):
                self.role_store.delete_binding(project_id, binding["id"])
        return self.bind_role_default_flow(project_id, role_id)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_agent_service_defaults.py tests/test_role_store_hooks.py -q`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add modules/agent_management/agent_service.py tests/test_agent_service_defaults.py
git commit -m "feat(agent-management): 实现作品默认Agent开通与角色默认绑定"
```

---

## Task 7: 工具 Agent 切换、查询与存量绑定迁移

**Files:**
- Modify: `modules/agent_management/agent_service.py`
- Test: `tests/test_agent_service_tools.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_agent_service_tools.py
# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.agent_management.agent_service import AgentService
from modules.agent_management.agent_store import AgentStore
from modules.novel_creation.project_store import ProjectStore
from modules.novel_creation.role_store import RoleStore


class _Registry:
    def list_tools(self):
        return [{"name": "gen_outline"}]


TEMPLATE = [
    {"step_order": i, "name": f"步骤{i}", "platform": "coze",
     "platform_config": {"bot_id": f"bot-{i}"}, "model_config": {}}
    for i in range(1, 12)
]


@pytest.fixture()
def env(tmp_path):
    data = tmp_path / "projects"
    store = AgentStore(str(tmp_path / "agents"))
    project_store = ProjectStore(str(data))
    role_store = RoleStore(str(data))
    service = AgentService(store, project_store, role_store,
                           tool_registry=_Registry(), flow_template=TEMPLATE)
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    return service, store, project_store, role_store, project


def _tool_agents(store, project_id):
    return [a for a in store.list_agents(project_id) if a["kind"] == "tool_agent"]


def test_switch_tool_default_is_exclusive(env):
    service, store, _, _, project = env
    agents = _tool_agents(store, project["id"])
    old = next(a for a in agents if a["is_default"])
    new = store.create_agent(project["id"], {
        "project_id": project["id"], "kind": "tool_agent",
        "name": "候选B", "tool_name": "gen_outline",
    })
    switched = service.switch_tool_default(project["id"], "gen_outline", new["id"])
    assert switched["is_default"] is True
    assert store.get_agent(project["id"], old["id"])["is_default"] is False
    assert service.resolve_default_tool_agent(project["id"], "gen_outline")["id"] == new["id"]


def test_migrate_role_bindings_dry_run_then_write(env):
    service, store, project_store, role_store, project = env
    role = role_store.create_role(project["id"], "林远")
    legacy = role_store.create_binding(project["id"], role["id"], "legacy-bot", step_order=1)

    dry = service.migrate_role_bindings(project_store.data_dir, dry_run=True)
    assert dry["migrated"] == 1
    assert dry["created_agents"] == 1
    assert role_store.get_bindings(project["id"], role["id"])[0].get("agent_ref_id") is None

    done = service.migrate_role_bindings(project_store.data_dir, dry_run=False)
    assert done["migrated"] == 1
    bindings = role_store.get_bindings(project["id"], role["id"])
    migrated = next(b for b in bindings if b["id"] == legacy["id"])
    assert migrated["agent_ref_id"]
    assert store.get_agent(project["id"], migrated["agent_ref_id"])["kind"] == "role_agent"

    again = service.migrate_role_bindings(project_store.data_dir, dry_run=False)
    assert again["migrated"] == 0
    assert again["skipped"] >= 1
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_agent_service_tools.py -q`
Expected: FAIL，`AttributeError: 'AgentService' object has no attribute 'switch_tool_default'`

- [ ] **Step 3: 写实现**

在 `agent_service.py` 末尾追加：

```python
    # ---------- 工具 Agent ----------

    def list_tools(self, project_id: str) -> List[Dict[str, Any]]:
        """按工具汇总候选与默认项。"""
        result: Dict[str, List[Dict[str, Any]]] = {}
        for agent in self.store.list_agents(project_id):
            if agent["kind"] == "tool_agent":
                result.setdefault(agent.get("tool_name") or "", []).append(agent)
        return [{"tool_name": name, "agents": agents,
                 "default_agent_id": next((a["id"] for a in agents if a.get("is_default")), None)}
                for name, agents in sorted(result.items())]

    def resolve_default_tool_agent(self, project_id: str,
                                   tool_name: str) -> Optional[Dict[str, Any]]:
        """取工具默认 active Agent；无则返回 None。"""
        for agent in self.store.list_agents(project_id):
            if agent["kind"] == "tool_agent" and agent.get("tool_name") == tool_name \
                    and agent.get("is_default") and agent.get("status") == "active":
                return agent
        return None

    def switch_tool_default(self, project_id: str, tool_name: str,
                            agent_id: str) -> Dict[str, Any]:
        """切换工具默认 Agent；失败时回滚旧默认标记。"""
        agents = [a for a in self.store.list_agents(project_id)
                  if a["kind"] == "tool_agent" and a.get("tool_name") == tool_name]
        target = next((a for a in agents if a["id"] == agent_id), None)
        if target is None:
            raise not_found(f"工具 Agent 不存在: {agent_id}")
        if target.get("status") != "active":
            raise bad_request("仅 active 状态的 Agent 可设为默认")
        previous = [(a["id"], bool(a.get("is_default"))) for a in agents]
        try:
            for agent in agents:
                if agent["id"] != agent_id and agent.get("is_default"):
                    self.store.update_agent(project_id, agent["id"], {"is_default": False})
            return self.store.update_agent(project_id, agent_id, {"is_default": True})
        except Exception:
            for old_id, flag in previous:
                self.store.update_agent(project_id, old_id, {"is_default": flag})
            raise

    def delete_agent(self, project_id: str, agent_id: str, force: bool = False) -> bool:
        """删除 Agent 前解除角色绑定，并在必要时转移工具默认项。"""
        agent = self.store.get_agent(project_id, agent_id)
        for role in self.role_store.list_roles(project_id):
            for binding in self.role_store.get_bindings(project_id, role["id"]):
                if binding.get("agent_ref_id") == agent_id:
                    self.role_store.update_binding(
                        project_id, binding["id"], agent_ref_id=None, enabled=False)
        if agent["kind"] == "tool_agent" and agent.get("is_default"):
            candidates = [a for a in self.store.list_agents(project_id)
                          if a["kind"] == "tool_agent" and a["id"] != agent_id
                          and a.get("tool_name") == agent.get("tool_name")
                          and a.get("status") == "active"]
            if candidates:
                self.store.update_agent(
                    project_id, candidates[0]["id"], {"is_default": True})
        return self.store.delete_agent(project_id, agent_id, force=force)

    # ---------- 查询与分组 ----------

    def get_agent(self, project_id: str, agent_id: str,
                  include_versions: bool = False) -> Dict[str, Any]:
        return self.store.get_agent(project_id, agent_id, include_versions)

    def list_agents(self, project_id: str, kind: Optional[str] = None,
                    status: Optional[str] = None, role_id: Optional[str] = None,
                    tool_name: Optional[str] = None,
                    keyword: Optional[str] = None) -> List[Dict[str, Any]]:
        agents = self.store.list_agents(project_id)
        if kind:
            agents = [a for a in agents if a["kind"] == kind]
        if status:
            agents = [a for a in agents if a.get("status") == status]
        if role_id:
            agents = [a for a in agents if a.get("role_id") == role_id]
        if tool_name:
            agents = [a for a in agents if a.get("tool_name") == tool_name]
        if keyword:
            key = keyword.lower()
            agents = [a for a in agents
                      if key in (a.get("name") or "").lower()
                      or key in (a.get("description") or "").lower()]
        return agents

    def get_group_tree(self, project_id: str) -> Dict[str, Any]:
        """构建分组树（注入角色名）。"""
        from .agent_grouping import build_tree
        project = self.project_store.get_project(project_id)
        role_names = {r["id"]: r.get("name", "") for r in self.role_store.list_roles(project_id)}
        return build_tree(project, self.store.list_agents(project_id),
                          self.store.load_group_overrides(project_id), role_names)

    # ---------- 存量迁移 ----------

    def migrate_role_bindings(self, projects_root: Optional[str] = None,
                              dry_run: bool = True) -> Dict[str, Any]:
        """为旧绑定回填 agent_ref_id；匹配不到则创建 role_agent。"""
        root = projects_root or getattr(self.project_store, "data_dir", "")
        stats = {"scanned": 0, "migrated": 0, "created_agents": 0,
                 "skipped": 0, "errors": []}
        if not os.path.isdir(root):
            return stats
        for name in os.listdir(root):
            if not name.endswith(".json") or name.startswith("."):
                continue
            project = read_json(os.path.join(root, name), None)
            if not isinstance(project, dict) or not project.get("id"):
                continue
            project_id = project["id"]
            agents = self.store.list_agents(project_id)
            for binding in project.get("role_bindings", []):
                stats["scanned"] += 1
                try:
                    if binding.get("agent_ref_id"):
                        stats["skipped"] += 1
                        continue
                    agent_id = binding.get("agent_id") or ""
                    match = next((a for a in agents
                                  if a["kind"] in ("role_agent", "flow_step_agent")
                                  and (a.get("platform_config") or {}).get("bot_id") == agent_id
                                  and (a["kind"] != "role_agent"
                                       or a.get("role_id") == binding.get("role_id"))), None)
                    if match is None:
                        if not agent_id:
                            stats["errors"].append({"binding_id": binding.get("id"),
                                                    "error": "agent_id 为空"})
                            continue
                        stats["created_agents"] += 1
                        if dry_run:
                            stats["migrated"] += 1
                            continue
                        match = self.store.create_agent(project_id, {
                            "project_id": project_id,
                            "kind": "role_agent",
                            "name": f"迁移角色Agent·{binding.get('role_id', '')[:8]}",
                            "role_id": binding.get("role_id"),
                            "platform": binding.get("agent_env", "coze"),
                            "platform_config": {"bot_id": agent_id},
                            "model_config": {"model": binding.get("model") or ""},
                            "source": "manual",
                        })
                        agents.append(match)
                    if not dry_run:
                        self.role_store.update_binding(
                            project_id, binding["id"], agent_ref_id=match["id"])
                    stats["migrated"] += 1
                except Exception as exc:  # noqa: BLE001 - 单条失败继续
                    stats["errors"].append({"binding_id": binding.get("id"),
                                            "error": str(exc)})
        return stats
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_agent_service_tools.py -q`
Expected: `2 passed`

- [ ] **Step 5: 提交**

```bash
git add modules/agent_management/agent_service.py tests/test_agent_service_tools.py
git commit -m "feat(agent-management): 实现工具Agent切换与存量绑定迁移"
```

---

## Task 8: 调度器按 agent_ref_id 解析 Agent 配置

**Files:**
- Modify: `modules/novel_creation/role_agent_scheduler.py`
- Test: `tests/test_scheduler_agent_ref.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_scheduler_agent_ref.py
# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules.novel_creation.role_agent_scheduler import RoleAgentScheduler


class _RoleStore:
    def __init__(self, bindings):
        self.bindings = bindings
        self.memory = {}

    def get_bindings(self, project_id, role_id, enabled=None):
        return self.bindings

    def get_memory(self, project_id, role_id, agent_id):
        return self.memory.get((role_id, agent_id), {})

    def set_memory(self, project_id, role_id, agent_id, memory):
        self.memory[(role_id, agent_id)] = memory


class _ProjectStore:
    def append_tool_call(self, *args, **kwargs):
        pass


class _Client:
    def __init__(self):
        self.calls = []

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        return {"success": True, "content": {"ok": True}, "conversation_id": kwargs["conversation_id"]}


def _scheduler(bindings, resolver):
    role_store = _RoleStore(bindings)
    client = _Client()
    scheduler = RoleAgentScheduler(role_store, _ProjectStore(), client,
                                   clients={"coze": client}, max_workers=1)
    scheduler.set_agent_resolver(resolver)
    return scheduler, client


def test_resolver_overrides_platform_and_model():
    bindings = [{"id": "b1", "role_id": "r1", "agent_id": "legacy",
                 "step_order": 1, "enabled": True, "agent_ref_id": "a1", "agent_env": "coze"}]
    scheduler, client = _scheduler(bindings, lambda pid, aid: {
        "id": "a1", "status": "active", "platform": "coze",
        "platform_config": {"bot_id": "bot-real"},
        "model_config": {"model": "model-x"},
    })
    scheduler.invoke_role_agents("p1", "r1", 1, {})
    assert client.calls[0]["bot_id"] == "bot-real"
    assert client.calls[0]["model"] == "model-x"
    assert client.calls[0]["conversation_id"] == "r1:legacy"


def test_archived_agent_is_skipped():
    bindings = [{"id": "b1", "role_id": "r1", "agent_id": "legacy",
                 "step_order": 1, "enabled": True, "agent_ref_id": "a1"}]
    scheduler, client = _scheduler(bindings, lambda pid, aid: {
        "id": "a1", "status": "archived", "platform": "coze",
        "platform_config": {"bot_id": "bot-real"}, "model_config": {},
    })
    result = scheduler.invoke_role_agents("p1", "r1", 1, {"seed": 1})
    assert result == {"seed": 1}
    assert client.calls == []


def test_unconfigured_bot_raises_clear_error():
    bindings = [{"id": "b1", "role_id": "r1", "agent_id": "legacy",
                 "step_order": 1, "enabled": True, "agent_ref_id": "a1"}]
    scheduler, _ = _scheduler(bindings, lambda pid, aid: {
        "id": "a1", "status": "active", "platform": "coze",
        "platform_config": {"bot_id": ""}, "model_config": {},
    })
    with pytest.raises(AppError) as ei:
        scheduler.invoke_role_agents("p1", "r1", 1, {})
    assert ei.value.code == 400
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_scheduler_agent_ref.py -q`
Expected: FAIL，`AttributeError: 'RoleAgentScheduler' object has no attribute 'set_agent_resolver'`

- [ ] **Step 3: 写实现**

修改 `RoleAgentScheduler`：

0. 顶部导入增加 `not_found`：

```python
from ..common.errors import bad_gateway, bad_request, not_found, server_error
```

1. `__init__` 末尾增加：

```python
        self.agent_resolver = None
```

2. 增加方法：

```python
    def set_agent_resolver(self, resolver) -> None:
        """注入 agent_ref_id → Agent 配置解析器（应用层装配）。"""
        self.agent_resolver = resolver
```

3. 在 `invoke_role_agents` 的 `hit_bindings = [...]` 之后、`tasks = []` 之前插入预校验（避免并行执行器把 400 降级吞掉）：

```python
        resolved = {}
        valid_bindings = []
        for binding in hit_bindings:
            agent_id = binding.get("agent_id", "")
            if not agent_id:
                continue
            agent_cfg = None
            if binding.get("agent_ref_id") and self.agent_resolver is not None:
                agent_cfg = self.agent_resolver(project_id, binding["agent_ref_id"])
                if agent_cfg is None:
                    raise not_found(f"Agent 不存在: {binding['agent_ref_id']}")
                if agent_cfg.get("status") != "active":
                    self._record_tool_call(
                        project_id,
                        {"role_id": role_id, "agent_id": agent_id,
                         "agent_ref_id": binding.get("agent_ref_id"), "skipped": True},
                        {"reason": "agent_not_active"}, "skipped",
                    )
                    continue
                platform = agent_cfg.get("platform") or "coze"
                bot_id = (agent_cfg.get("platform_config") or {}).get("bot_id") or ""
                if platform == "coze" and not bot_id:
                    raise bad_request("作品级流程 Agent 未配置 bot_id")
            valid_bindings.append(binding)
            resolved[binding.get("id") or agent_id] = agent_cfg
        hit_bindings = valid_bindings
```

4. 构建任务时把解析结果放进 payload：

```python
            tasks.append(AgentTask(
                task_id=binding.get("id") or agent_id,
                depends_on=list(binding.get("depends_on") or []),
                payload={
                    "project_id": project_id,
                    "role_id": role_id,
                    "binding": binding,
                    "agent_cfg": resolved.get(binding.get("id") or agent_id),
                },
            ))
```

5. `_invoke_task` 透传配置，`_invoke_agent` 使用配置：

```python
    def _invoke_task(self, task: AgentTask, context: Dict[str, Any]) -> Dict[str, Any]:
        payload = task.payload
        return self._invoke_agent(
            payload["project_id"], payload["role_id"],
            payload["binding"]["agent_id"], payload["binding"], context,
            agent_cfg=payload.get("agent_cfg"),
        )
```

```python
    def _invoke_agent(self, project_id: str, role_id: str, agent_id: str,
                      binding: Dict[str, Any], context: Dict[str, Any],
                      agent_cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        # ...原记忆/消息组装代码保持不变...
        if agent_cfg is None and binding.get("agent_ref_id") and self.agent_resolver is not None:
            agent_cfg = self.agent_resolver(project_id, binding["agent_ref_id"])
        platform = binding.get("agent_env") or "coze"
        model_override = binding.get("model")
        effective_agent_id = agent_id
        if agent_cfg:
            platform = agent_cfg.get("platform") or platform
            effective_agent_id = (agent_cfg.get("platform_config") or {}).get("bot_id") or agent_id
            model_override = (agent_cfg.get("model_config") or {}).get("model") or model_override
```

6. 将原调用块改为：

```python
            model = model_override
            if self.model_router is not None:
                model = self.model_router.resolve(
                    scene="role_agent_invoke", override=model,
                )
            call_kwargs = {}
            if model:
                call_kwargs["model"] = model
            call_kwargs["agent_env"] = platform
            raw = self._call_agent(
                effective_agent_id, user_message, conversation_id, **call_kwargs,
            )
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_scheduler_agent_ref.py tests/test_role_agent_scheduler.py -q`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add modules/novel_creation/role_agent_scheduler.py tests/test_scheduler_agent_ref.py
git commit -m "feat(novel-creation): 调度器支持按agent_ref_id解析配置"
```

---

## Task 9: StepFlowEngine 记录每角色进度

**Files:**
- Modify: `modules/novel_creation/step_flow_engine.py`
- Test: `tests/test_step_flow_progress.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_step_flow_progress.py
# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules.novel_creation.flow_progress_store import FlowProgressStore
from modules.novel_creation.step_flow_engine import StepFlowEngine


class _RoleStore:
    def get_role(self, project_id, role_id):
        return {"id": role_id}


class _Scheduler:
    def __init__(self):
        self.calls = []

    def invoke_role_agents(self, project_id, role_id, step_order, context):
        self.calls.append((role_id, step_order))
        return {**context, f"step_{step_order}": role_id}


def test_trigger_flow_records_progress(tmp_path):
    scheduler = _Scheduler()
    progress = FlowProgressStore(str(tmp_path / "flows"))
    engine = StepFlowEngine(scheduler, _RoleStore())
    engine.set_progress_store(progress)
    merged = engine.trigger_flow("p1", "r1", {"seed": 1})
    state = progress.get("p1", "r1")
    assert state["status"] == "done"
    assert state["completed_steps"] == list(range(1, 12))
    assert merged["step_11"] == "r1"
    assert len(scheduler.calls) == 11


def test_same_role_concurrent_flow_returns_409(tmp_path):
    scheduler = _Scheduler()
    progress = FlowProgressStore(str(tmp_path / "flows"))
    engine = StepFlowEngine(scheduler, _RoleStore())
    engine.set_progress_store(progress)
    lock = progress.lock("p1", "r1")
    assert lock.try_acquire() is True
    try:
        with pytest.raises(AppError) as ei:
            engine.trigger_flow("p1", "r1", {})
        assert ei.value.code == 409
    finally:
        lock.release()


def test_failure_marks_progress_failed(tmp_path):
    class _FailScheduler(_Scheduler):
        def invoke_role_agents(self, project_id, role_id, step_order, context):
            if step_order == 3:
                raise AppError(502, "boom")
            return context

    progress = FlowProgressStore(str(tmp_path / "flows"))
    engine = StepFlowEngine(_FailScheduler(), _RoleStore())
    engine.set_progress_store(progress)
    with pytest.raises(AppError):
        engine.trigger_flow("p1", "r1", {})
    state = progress.get("p1", "r1")
    assert state["status"] == "failed"
    assert "boom" in state["last_error"]
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_step_flow_progress.py -q`
Expected: FAIL，`AttributeError: 'StepFlowEngine' object has no attribute 'set_progress_store'`

- [ ] **Step 3: 写实现**

修改 `step_flow_engine.py`：

1. 将现有 `from ..common.errors import bad_request` 改为：

```python
from ..common.errors import bad_request, conflict
```

2. `__init__` 末尾增加：

```python
        self.progress_store = None

    def set_progress_store(self, store) -> None:
        """注入每角色进度存储。"""
        self.progress_store = store
```

3. 替换 `trigger_flow` 为：

```python
    def trigger_flow(
        self, project_id: str, role_id: str, context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """全流程顺序触发，并记录每角色独立进度。"""
        self.role_store.get_role(project_id, role_id)
        merged: Dict[str, Any] = dict(context)
        if self.progress_store is None:
            for step in self.get_steps():
                merged = self.scheduler.invoke_role_agents(
                    project_id, role_id, step["step_order"], merged)
            return merged

        lock = self.progress_store.lock(project_id, role_id)
        if not lock.try_acquire():
            raise conflict("该角色流程正在执行")
        try:
            self.progress_store.start(project_id, role_id)
            for step in self.get_steps():
                order = step["step_order"]
                self.progress_store.record_step(project_id, role_id, order, "running")
                try:
                    merged = self.scheduler.invoke_role_agents(
                        project_id, role_id, order, merged)
                except Exception as exc:  # noqa: BLE001 - 记录失败后继续抛
                    self.progress_store.record_step(
                        project_id, role_id, order, "failed", error=str(exc))
                    self.progress_store.finish(project_id, role_id, "failed", str(exc))
                    raise
                self.progress_store.record_step(
                    project_id, role_id, order, "done", output=merged)
            self.progress_store.finish(project_id, role_id, "done")
            return merged
        finally:
            lock.release()
```

4. 在 `trigger_step` 末尾（返回前）增加进度记录：

```python
        merged = self.scheduler.invoke_role_agents(
            project_id, role_id, step_order, context)
        if self.progress_store is not None:
            self.progress_store.record_step(
                project_id, role_id, step_order, "done", output=merged)
        return merged
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_step_flow_progress.py tests/test_step_flow_engine.py -q`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add modules/novel_creation/step_flow_engine.py tests/test_step_flow_progress.py
git commit -m "feat(novel-creation): 11步流程记录每角色独立进度"
```

---

## Task 10: `/api/agents/*` 与角色默认流程路由

**Files:**
- Create: `modules/agent_management/routes.py`
- Test: `tests/test_agent_routes.py`

> 说明：Agent 存储按项目分目录，所有 `/<agent_id>` 接口必须带 `project_id` 查询参数（PUT/DELETE 也可放在 JSON body）。

- [ ] **Step 1: 写失败测试**

```python
# tests/test_agent_routes.py
# -*- coding: utf-8 -*-
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask

from modules.agent_management.agent_service import AgentService
from modules.agent_management.agent_store import AgentStore
from modules.agent_management.routes import create_blueprint
from modules.novel_creation.flow_progress_store import FlowProgressStore
from modules.novel_creation.project_store import ProjectStore
from modules.novel_creation.role_store import RoleStore


class _Registry:
    def list_tools(self):
        return [{"name": "gen_outline"}]


TEMPLATE = [
    {"step_order": i, "name": f"步骤{i}", "platform": "coze",
     "platform_config": {"bot_id": f"bot-{i}"}, "model_config": {}}
    for i in range(1, 12)
]


@pytest.fixture()
def env(tmp_path):
    data = tmp_path / "projects"
    store = AgentStore(str(tmp_path / "agents"))
    project_store = ProjectStore(str(data))
    role_store = RoleStore(str(data))
    service = AgentService(store, project_store, role_store,
                           tool_registry=_Registry(), flow_template=TEMPLATE)
    progress = FlowProgressStore(str(tmp_path / "flows"))
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(service, progress))
    project = project_store.create_project("测试作品")
    service.provision_project_defaults(project)
    return app.test_client(), service, project_store, role_store, project


def test_agent_crud_and_lifecycle(env):
    client, _, _, _, project = env
    created = client.post("/api/agents", json={
        "project_id": project["id"], "kind": "role_agent",
        "name": "自定义角色Agent", "role_id": "r1",
    })
    assert created.status_code == 200
    agent = created.get_json()["data"]
    aid = agent["id"]

    listed = client.get(f"/api/agents?project_id={project['id']}&kind=role_agent")
    assert listed.get_json()["data"]["total"] == 1

    updated = client.put(f"/api/agents/{aid}?project_id={project['id']}", json={"name": "改名"})
    assert updated.get_json()["data"]["name"] == "改名"

    conflict = client.delete(f"/api/agents/{aid}?project_id={project['id']}")
    assert conflict.status_code == 409
    assert client.post(f"/api/agents/{aid}/archive?project_id={project['id']}").status_code == 200
    assert client.delete(f"/api/agents/{aid}?project_id={project['id']}").status_code == 200


def test_groups_and_tool_switch(env):
    client, service, _, _, project = env
    tree = client.get(f"/api/agents/groups?project_id={project['id']}").get_json()["data"]
    assert tree["key"] == f"project:{project['id']}"

    tools = client.get(f"/api/agents/tools?project_id={project['id']}").get_json()["data"]
    tool_name = tools[0]["tool_name"]
    new_agent = service.store.create_agent(project["id"], {
        "project_id": project["id"], "kind": "tool_agent",
        "name": "候选B", "tool_name": tool_name,
    })
    switched = client.post(f"/api/agents/tools/{tool_name}/switch", json={
        "project_id": project["id"], "agent_id": new_agent["id"],
    })
    assert switched.get_json()["data"]["is_default"] is True


def test_role_reset_default_and_progress(env):
    client, _, _, role_store, project = env
    role = role_store.create_role(project["id"], "林远")
    reset = client.post(f"/api/roles/{role['id']}/agents/reset-default", json={"mode": "fill"})
    assert reset.status_code == 200
    assert len(role_store.get_bindings(project["id"], role["id"])) == 11

    progress = client.get(f"/api/roles/{role['id']}/flow-progress")
    assert progress.get_json()["data"]["status"] == "idle"
    reset_progress = client.post(f"/api/roles/{role['id']}/flow-progress/reset")
    assert reset_progress.status_code == 200


def test_provision_and_migration_endpoints(env):
    client, service, project_store, _, project = env
    provision = client.post(f"/api/agents/projects/{project['id']}/provision")
    assert provision.status_code == 200
    migration = client.post("/api/agents/migrations/role-bindings", json={"dry_run": True})
    assert migration.status_code == 200
    assert migration.get_json()["data"]["dry_run"] is True
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_agent_routes.py -q`
Expected: FAIL，`ModuleNotFoundError: No module named 'modules.agent_management.routes'`

- [ ] **Step 3: 写实现**

```python
# modules/agent_management/routes.py
# -*- coding: utf-8 -*-
"""智能体管理路由：/api/agents/* 与 /api/roles/* 默认流程接口。"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from ..common.errors import AppError, bad_request, not_found


def create_blueprint(service, flow_progress_store=None) -> Blueprint:
    """装配智能体管理蓝图（依赖注入 service / 进度存储）。"""
    bp = Blueprint("agent_management", __name__, url_prefix="/api")

    def _ok(data, message: str = "ok"):
        return jsonify({"code": 0, "data": data, "message": message})

    @bp.errorhandler(AppError)
    def _handle_app_error(e: AppError):
        return jsonify({"code": e.code, "data": None, "message": e.message}), e.code

    def _pid():
        pid = request.args.get("project_id")
        if not pid:
            pid = (request.get_json(silent=True) or {}).get("project_id")
        if not pid:
            raise bad_request("project_id 不能为空")
        return pid

    def _role_project(role_id: str) -> str:
        project = service.project_store.find_project_by_role(role_id)
        if project is None:
            raise not_found(f"角色不存在: {role_id}")
        return project["id"]

    # ---------- Agent CRUD ----------

    @bp.post("/agents")
    def create_agent():
        body = request.get_json(silent=True) or {}
        pid = body.get("project_id")
        if not pid:
            raise bad_request("project_id 不能为空")
        return _ok(service.store.create_agent(pid, body))

    @bp.get("/agents")
    def list_agents():
        pid = _pid()
        try:
            page = max(1, int(request.args.get("page", 1)))
            page_size = min(100, max(1, int(request.args.get("page_size", 20))))
        except ValueError:
            raise bad_request("page/page_size 须为整数")
        items = service.list_agents(
            pid,
            kind=request.args.get("kind"),
            status=request.args.get("status"),
            role_id=request.args.get("role_id"),
            tool_name=request.args.get("tool_name"),
            keyword=request.args.get("keyword"),
        )
        total = len(items)
        start = (page - 1) * page_size
        return _ok({"items": items[start:start + page_size], "total": total})

    @bp.get("/agents/<agent_id>")
    def get_agent(agent_id: str):
        include = request.args.get("include_versions") == "true"
        return _ok(service.get_agent(_pid(), agent_id, include))

    @bp.put("/agents/<agent_id>")
    def update_agent(agent_id: str):
        pid = _pid()
        return _ok(service.store.update_agent(pid, agent_id, request.get_json(silent=True) or {}))

    @bp.post("/agents/<agent_id>/archive")
    def archive_agent(agent_id: str):
        return _ok(service.store.archive_agent(_pid(), agent_id))

    @bp.post("/agents/<agent_id>/restore")
    def restore_agent(agent_id: str):
        return _ok(service.store.restore_agent(_pid(), agent_id))

    @bp.delete("/agents/<agent_id>")
    def delete_agent(agent_id: str):
        force = request.args.get("force") == "true"
        service.delete_agent(_pid(), agent_id, force=force)
        return _ok({"success": True})

    @bp.get("/agents/<agent_id>/versions")
    def list_versions(agent_id: str):
        return _ok({"items": service.store.get_versions(_pid(), agent_id)})

    @bp.post("/agents/<agent_id>/versions/<int:version_no>/rollback")
    def rollback(agent_id: str, version_no: int):
        return _ok(service.store.rollback(_pid(), agent_id, version_no))

    # ---------- 分组 ----------

    @bp.get("/agents/groups")
    def group_tree():
        return _ok(service.get_group_tree(_pid()))

    @bp.put("/agents/groups/overrides")
    def upsert_override():
        body = request.get_json(silent=True) or {}
        pid = body.get("project_id")
        if not pid or not body.get("key"):
            raise bad_request("project_id/key 不能为空")
        fields = {k: body[k] for k in ("name", "sort_order", "hidden") if k in body}
        return _ok(service.store.upsert_override(pid, body["key"], **fields))

    @bp.delete("/agents/groups/overrides")
    def delete_override():
        pid = _pid()
        key = request.args.get("key")
        if not key:
            raise bad_request("key 不能为空")
        return _ok({"success": service.store.delete_override(pid, key)})

    @bp.post("/agents/groups/manual")
    def create_manual_group():
        body = request.get_json(silent=True) or {}
        pid = body.get("project_id")
        if not pid:
            raise bad_request("project_id 不能为空")
        parent = body.get("parent_key") or f"project:{pid}"
        return _ok(service.store.create_manual_group(
            pid, parent, body.get("name"), body.get("sort_order", 0)))

    @bp.delete("/agents/groups/manual/<group_id>")
    def delete_manual_group(group_id: str):
        return _ok({"success": service.store.delete_manual_group(_pid(), group_id)})

    @bp.put("/agents/<agent_id>/group")
    def set_agent_group(agent_id: str):
        pid = _pid()
        body = request.get_json(silent=True) or {}
        return _ok(service.store.update_agent(
            pid, agent_id, {"manual_group_key": body.get("manual_group_key")}))

    # ---------- 工具 Agent ----------

    @bp.get("/agents/tools")
    def list_tools():
        return _ok(service.list_tools(_pid()))

    @bp.post("/agents/tools/<tool_name>/switch")
    def switch_tool(tool_name: str):
        body = request.get_json(silent=True) or {}
        pid = body.get("project_id")
        if not pid or not body.get("agent_id"):
            raise bad_request("project_id/agent_id 不能为空")
        return _ok(service.switch_tool_default(pid, tool_name, body["agent_id"]))

    @bp.post("/agents/projects/<project_id>/provision")
    def provision(project_id: str):
        project = service.project_store.get_project(project_id)
        return _ok(service.provision_project_defaults(project))

    @bp.post("/agents/projects/<project_id>/bind-roles")
    def bind_roles(project_id: str):
        service.project_store.get_project(project_id)
        created = {}
        for role in service.role_store.list_roles(project_id):
            created[role["id"]] = len(service.bind_role_default_flow(project_id, role["id"]))
        return _ok({"roles": created})

    # ---------- 角色默认流程 ----------

    @bp.post("/roles/<role_id>/agents/reset-default")
    def reset_default(role_id: str):
        body = request.get_json(silent=True) or {}
        pid = _role_project(role_id)
        bindings = service.reset_role_default_flow(pid, role_id, body.get("mode", "fill"))
        return _ok({"created": len(bindings)})

    @bp.get("/roles/<role_id>/flow-progress")
    def get_progress(role_id: str):
        if flow_progress_store is None:
            raise not_found("进度存储未配置")
        return _ok(flow_progress_store.get(_role_project(role_id), role_id))

    @bp.post("/roles/<role_id>/flow-progress/reset")
    def reset_progress(role_id: str):
        if flow_progress_store is None:
            raise not_found("进度存储未配置")
        return _ok(flow_progress_store.reset(_role_project(role_id), role_id))

    # ---------- 迁移 ----------

    @bp.post("/agents/migrations/role-bindings")
    def migrate_bindings():
        body = request.get_json(silent=True) or {}
        dry_run = bool(body.get("dry_run", True))
        result = service.migrate_role_bindings(dry_run=dry_run)
        result["dry_run"] = dry_run
        return _ok(result)

    return bp
```

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_agent_routes.py -q`
Expected: `4 passed`

- [ ] **Step 5: 提交**

```bash
git add modules/agent_management/routes.py tests/test_agent_routes.py
git commit -m "feat(agent-management): 新增Agent管理与角色默认流程路由"
```

---

## Task 11: 应用装配、作品创建开通与工具默认 Agent 联动

**Files:**
- Modify: `modules/novel_creation/routes.py`
- Modify: `app.py`
- Test: `tests/test_agent_integration.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_agent_integration.py
# -*- coding: utf-8 -*-
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask

from modules.novel_creation.project_store import ProjectStore
from modules.novel_creation.role_store import RoleStore
from modules.novel_creation.routes import create_blueprint
from modules.agent_management.agent_service import AgentService
from modules.agent_management.agent_store import AgentStore


TEMPLATE = [
    {"step_order": i, "name": f"步骤{i}", "platform": "coze",
     "platform_config": {"bot_id": f"bot-{i}"}, "model_config": {}}
    for i in range(1, 12)
]


class _Scheduler:
    def invoke_role_agents(self, *args, **kwargs):
        return {}


class _FlowEngine:
    def trigger_step(self, *args, **kwargs):
        return {}


class _Registry:
    def list_tools(self):
        return []

    def get(self, tool):
        return None


def test_create_project_calls_provisioner(tmp_path):
    calls = []
    project_store = ProjectStore(str(tmp_path / "projects"))
    role_store = RoleStore(str(tmp_path / "projects"))
    bp = create_blueprint(
        role_store, project_store, _Scheduler(), _FlowEngine(),
        tool_registry=_Registry(), project_provisioner=lambda project: calls.append(project["id"]),
    )
    app = Flask(__name__)
    app.register_blueprint(bp)
    resp = app.test_client().post("/api/projects", json={"title": "新作品"})
    assert resp.status_code == 200
    assert calls == [resp.get_json()["data"]["id"]]


def test_create_role_triggers_default_binding_hook(tmp_path):
    project_store = ProjectStore(str(tmp_path / "projects"))
    role_store = RoleStore(str(tmp_path / "projects"))
    bound = []
    role_store.set_lifecycle_hooks(on_create=lambda pid, rid: bound.append((pid, rid)))
    bp = create_blueprint(role_store, project_store, _Scheduler(), _FlowEngine(),
                          tool_registry=_Registry())
    app = Flask(__name__)
    app.register_blueprint(bp)
    project = project_store.create_project("新作品")
    resp = app.test_client().post(f"/api/projects/{project['id']}/roles", json={"name": "林远"})
    assert resp.status_code == 200
    assert bound == [(project["id"], resp.get_json()["data"]["id"])]


def test_project_and_role_end_to_end_auto_provision(tmp_path):
    """核心场景：建作品生成 11 步 Agent，建角色自动绑定 11 条。"""
    project_store = ProjectStore(str(tmp_path / "projects"))
    role_store = RoleStore(str(tmp_path / "projects"))
    store = AgentStore(str(tmp_path / "agents"))
    service = AgentService(store, project_store, role_store, flow_template=TEMPLATE)
    role_store.set_lifecycle_hooks(on_create=service.bind_role_default_flow)
    bp = create_blueprint(
        role_store, project_store, _Scheduler(), _FlowEngine(),
        tool_registry=_Registry(), project_provisioner=service.provision_project_defaults,
    )
    app = Flask(__name__)
    app.register_blueprint(bp)
    client = app.test_client()

    created = client.post("/api/projects", json={"title": "端到端作品"}).get_json()["data"]
    agents = store.list_agents(created["id"])
    assert len([a for a in agents if a["kind"] == "flow_step_agent"]) == 11

    role = client.post(f"/api/projects/{created['id']}/roles",
                       json={"name": "林远"}).get_json()["data"]
    bindings = role_store.get_bindings(created["id"], role["id"])
    assert len(bindings) == 11
    assert all(b["agent_ref_id"] for b in bindings)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `python -m pytest tests/test_agent_integration.py -q`
Expected: FAIL，`TypeError: create_blueprint() got an unexpected keyword argument 'project_provisioner'`

- [ ] **Step 3: 写实现**

**3.1 `modules/novel_creation/routes.py`**

在 `create_blueprint` 的 `extra` 读取处增加：

```python
    project_provisioner = extra.get("project_provisioner")
    tool_agent_resolver = extra.get("tool_agent_resolver")
```

`create_project` 在 `project_store.create_project(...)` 之后、`return` 之前增加：

```python
        if project_provisioner is not None:
            try:
                project_provisioner(project)
            except Exception as exc:  # noqa: BLE001 - 开通失败不阻断建作品
                from flask import current_app
                current_app.logger.warning("[作品] 默认 Agent 开通失败: %s", exc)
```

`invoke_tool` 在拿到 `project` 后、派发处理器前增加：

```python
        tool_agent = None
        if tool_agent_resolver is not None:
            try:
                tool_agent = tool_agent_resolver(project_id, tool)
            except Exception:  # noqa: BLE001 - 解析失败不阻断工具
                tool_agent = None
        if tool_agent:
            context["tool_agent"] = {
                "id": tool_agent.get("id"),
                "name": tool_agent.get("name"),
                "platform": tool_agent.get("platform"),
                "model_config": tool_agent.get("model_config") or {},
            }
```

**3.2 `app.py`**

在 `modules/novel_creation` 导入区增加：

```python
import json as _json
from modules.agent_management.agent_store import AgentStore
from modules.agent_management.agent_service import AgentService
from modules.agent_management.routes import create_blueprint as create_agent_blueprint
from modules.novel_creation.flow_progress_store import FlowProgressStore
```

在 `_tool_registry` 之后增加装配：

```python
def _load_flow_template():
    """读取 11 步模板；缺失或不足 11 步时回退到 DEFAULT_STEPS 占位。"""
    path = os.path.join(BASE_DIR, "config", "default_flow_agents.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            steps = _json.load(f).get("steps") or []
        if len(steps) == 11:
            return steps
    except (OSError, ValueError):
        pass
    from modules.novel_creation.step_flow_engine import DEFAULT_STEPS
    return [dict(step, platform="coze", platform_config={}, model_config={})
            for step in DEFAULT_STEPS]


_flow_progress_store = FlowProgressStore(os.path.join(DATA_DIR, "flows"))
_agent_store = AgentStore(os.path.join(DATA_DIR, "agents"))
_agent_service = AgentService(
    _agent_store, _project_store, _role_store, _tool_registry,
    flow_template=_load_flow_template(),
)
_role_store.set_lifecycle_hooks(
    on_create=_agent_service.bind_role_default_flow,
    on_delete=_flow_progress_store.delete_role,
)
_role_scheduler.set_agent_resolver(_agent_service.get_agent)
_step_flow_engine.set_progress_store(_flow_progress_store)
```

`_novel_bp = create_blueprint(...)` 增加两个参数：

```python
    project_provisioner=_agent_service.provision_project_defaults,
    tool_agent_resolver=_agent_service.resolve_default_tool_agent,
```

注册蓝图：

```python
app.register_blueprint(create_agent_blueprint(_agent_service, _flow_progress_store))
```

`__main__` 启动块中、`app.run` 之前增加一次幂等迁移：

```python
    try:
        report = _agent_service.migrate_role_bindings(
            os.path.join(DATA_DIR, "projects"), dry_run=False)
        app.logger.info("[Agent] 角色绑定迁移: %s", report)
    except Exception as exc:  # noqa: BLE001 - 迁移失败不阻断启动
        app.logger.warning("[Agent] 角色绑定迁移失败: %s", exc)
```

**3.3 凭据说明**

Agent 文件不存储 PAT/API Key；调用沿用现有全局 `coze_client.pat_token`（由管理端或作品导入设置）。本任务不新增凭据配置项，也不在 Agent API 中返回任何凭据。

- [ ] **Step 4: 运行测试确认通过**

Run: `python -m pytest tests/test_agent_integration.py tests/test_app.py -q`
Expected: 全部通过

- [ ] **Step 5: 提交**

```bash
git add app.py modules/novel_creation/routes.py tests/test_agent_integration.py
git commit -m "feat(agent-management): 装配模块并打通作品创建与工具默认Agent"
```

---

## Task 12: 核心验收场景测试、文档同步与全量 CI

**Files:**
- Create: `tests/test_flow_progress_isolation.py`
- Modify: `docs/02-技术与架构/数据结构设计.md`
- Modify: `docs/02-技术与架构/接口契约.md`
- Modify: `docs/02-技术与架构/目录结构.md`
- Create: `docs/04-功能交付档案/F10-智能体管理/README.md`

- [ ] **Step 1: 写并发隔离验收测试**

```python
# tests/test_flow_progress_isolation.py
# -*- coding: utf-8 -*-
import os
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.novel_creation.flow_progress_store import FlowProgressStore
from modules.novel_creation.step_flow_engine import StepFlowEngine


class _RoleStore:
    def get_role(self, project_id, role_id):
        return {"id": role_id}


class _SharedAgentScheduler:
    """模拟多个角色共享同一作品级 Agent：会话 key 必须按角色隔离。"""

    def __init__(self):
        self.calls = []
        self.lock = __import__("threading").Lock()

    def invoke_role_agents(self, project_id, role_id, step_order, context):
        with self.lock:
            self.calls.append((role_id, step_order))
        return {**context, "role_id": role_id, f"step_{step_order}": role_id}


@pytest.mark.parametrize("roles", [["r1", "r2", "r3"]])
def test_multi_role_concurrent_flow_isolated(tmp_path, roles):
    scheduler = _SharedAgentScheduler()
    progress = FlowProgressStore(str(tmp_path / "flows"))
    engine = StepFlowEngine(scheduler, _RoleStore())
    engine.set_progress_store(progress)

    def run(role_id):
        return role_id, engine.trigger_flow("p1", role_id, {"seed": role_id})

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = dict(pool.map(run, roles))

    for role_id in roles:
        assert results[role_id]["role_id"] == role_id
        state = progress.get("p1", role_id)
        assert state["status"] == "done"
        assert state["completed_steps"] == list(range(1, 12))
        assert all(step["output"]["role_id"] == role_id for step in state["steps"])
    assert len(scheduler.calls) == len(roles) * 11
```

- [ ] **Step 2: 运行测试确认失败或通过**

Run: `python -m pytest tests/test_flow_progress_isolation.py -q`
Expected: 此时应 PASS（Task 5/9 已实现）；若 FAIL，先修正进度文件或锁实现。

- [ ] **Step 3: 同步文档**

在 `数据结构设计.md` 增加：

```markdown
### 3.7 Agent（Agent Management）

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | 是 | UUID | Agent ID |
| `project_id` | string | 是 | — | 所属小说项目 |
| `kind` | string | 是 | — | `role_agent`/`tool_agent`/`flow_step_agent` |
| `role_id` | string/null | 条件 | null | role_agent 必填 |
| `tool_name` | string/null | 条件 | null | tool_agent 必填 |
| `step_order` | number/null | 条件 | null | flow_step_agent 必填（1-11） |
| `platform` | string | 是 | `coze` | `coze`/`trae` |
| `platform_config` | object | 是 | `{}` | 仅非敏感 ID |
| `model_config` | object | 是 | 10 项默认 | 调用参数 |
| `status` | string | 是 | `active` | `active`/`disabled`/`archived` |
| `is_default` | boolean | 否 | `false` | 工具默认项 |
| `versions` | array | 是 | `[]` | 版本快照（最近 50） |

### 3.8 角色流程进度（FlowProgress）

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `project_id` | string | 是 | — | 所属项目 |
| `role_id` | string | 是 | — | 所属角色 |
| `run_id` | string | 是 | — | 运行 ID |
| `status` | string | 是 | `idle` | `idle`/`running`/`done`/`failed` |
| `current_step` | number | 是 | 0 | 当前步骤 |
| `completed_steps` | array | 是 | `[]` | 已完成步骤 |
| `steps` | array | 是 | `[]` | 每步状态与输出 |
| `context` | object | 否 | `{}` | 中间上下文 |
```

在 `接口契约.md` 增加 `## 十、智能体管理接口（/api/agents）`，逐条列出本计划 Task 10 的路由表，并注明：

```markdown
> 所有 `/<agent_id>` 接口必须携带 `project_id` 查询参数（PUT/DELETE 也可放 JSON body）。
> 响应永不返回 PAT Token/API Key；Agent 文件仅保存 `bot_id` 等非敏感 ID。
```

在 `目录结构.md` 增加：

```text
├── modules/agent_management/       # ★ 智能体管理模块（F10）
├── data/agents/                    # 智能体配置（每项目一目录，每 Agent 一文件）
├── data/flows/                     # 每角色 11 步流程进度
├── config/default_flow_agents.json # 11 步流程 Agent 模板
```

创建交付档案 `docs/04-功能交付档案/F10-智能体管理/README.md`，写入：需求要点、设计链接、实现文件清单、三项验收场景与测试命令。

- [ ] **Step 4: 运行全量 CI**

Run:
```bash
python scripts/run_checks.py --path .
python -m compileall -q .
python -m pytest -q
```
Expected:
- 合规检查 `总计违规 0 条`
- compileall 无输出、退出码 0
- pytest `709 + 新增用例` 全部 passed

- [ ] **Step 5: 提交**

```bash
git add tests/test_flow_progress_isolation.py docs
git commit -m "test(agent-management): 补充并发隔离验收并同步架构文档"
```

---

## 自审记录

### 规格覆盖

| 规格章节 | 对应任务 |
| --- | --- |
| 三、架构与模块边界 | Task 1/10/11 |
| 四、存储布局 | Task 2/5 |
| 五、数据模型 | Task 1/2/3/4/5 |
| 六、分组规则 | Task 3 |
| 七、生命周期 | Task 2/10 |
| 八、关键流程 | Task 6/7/8/9/11 |
| 九、API 契约 | Task 10 |
| 十、并发隔离 | Task 5/8/9/12 |
| 十一、存量迁移 | Task 7/11 |
| 十二、错误码 | Task 1/2/6/8/10 |
| 十三、测试与验收 | 全部任务 + Task 12 |

### 已修正的不一致

1. 分组 key 统一为 `project:<project_id>`、`role:<project_id>:<role_id>`、`tool:<project_id>:<tool_name>`。
2. Agent 按项目目录存储，`/<agent_id>` 接口统一要求 `project_id`。
3. Agent 文件不存储凭据，调用沿用全局 `CozeClient.pat_token`；API 响应永不返回凭据。
4. `trigger_step` 与 `trigger_flow` 均记录进度；同角色冲突返回 409。

---

## 执行方式

**方案 1（推荐）：Subagent-Driven** — 每个 Task 派发独立子代理，完成后由主代理审查并继续下一个 Task。

**方案 2：Inline Execution** — 在当前会话按 Task 顺序批量执行，每个 Task 完成后设检查点。

选择方案 1 时使用 `superpowers:subagent-driven-development`；选择方案 2 时使用 `superpowers:executing-plans`。



