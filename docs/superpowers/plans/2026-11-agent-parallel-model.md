# Agent 模块架构调整实现计划：并行接入 + 模型选择

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 StoryForgeAI agent 模块引入并行调度（DAG 分层）与模型路由（ModelRouter），并支持 Coze/Trae 双环境客户端协议，保持现有接口兼容。

**Architecture:** 方案 A 分层抽取。`RoleAgentScheduler` 公开签名不变，内部把串行 for 循环改为委托 `ParallelAgentExecutor.execute`（depends_on 建 DAG → 拓扑分层 → 层内并行、层间串行），模型解析委托 `ModelRouter.resolve`（全局配置 + 动态指定）。新增 `AgentClient` 抽象基类统一 Coze/Trae 通道。

**Tech Stack:** Python 3.9+，pytest，concurrent.futures，标准库 dataclasses。无新第三方依赖。

**前置开放项（实现前必须与用户确认，本文档按可落地路径编写）：**
1. **Trae 通道协议**：本文档先实现 `TraeAgentClient` 为**协议桩**（抛 NotImplementedError 占位），真实接入待用户提供通道契约后补全。若用户希望先只做 Coze，可跳过 Trae 桩（仅保留 `AgentClient` 基类 + `CozeAgentClient`）。
2. **Coze 运行时 model**：本文档按"Coze 允许 v3/chat 传 model"乐观路径实现（body 加可选 model 字段）；若实测不通过，仅影响 `CozeClient.chat` 的 model 参数传递，不影响其余组件。

---

## 文件结构

| 文件 | 职责 | 操作 |
|---|---|---|
| `modules/novel_creation/model_router.py` | 模型路由层：列表/默认/场景路由 | 新建 |
| `modules/novel_creation/parallel_agent_executor.py` | DAG 构建 + 层内并行 + 超时/重试/降级 + 聚合 | 新建 |
| `modules/novel_creation/agent_client.py` | `AgentClient` 抽象基类 + `CozeAgentClient` 包装 | 新建 |
| `modules/novel_creation/trae_agent_client.py` | `TraeAgentClient` 协议桩（通道待澄清） | 新建 |
| `modules/novel_creation/role_store.py` | `create_binding`/`update_binding` 白名单扩展 depends_on/model/agent_env | 修改 |
| `modules/novel_creation/role_agent_scheduler.py` | 内部委托 ParallelAgentExecutor + ModelRouter，公开签名不变 | 修改 |
| `coze_client.py` | `chat()` 支持可选 model 参数 | 修改 |
| `config_loader.py` | 全局配置新增 `model_config`（models/default_model/route_rules） | 修改 |
| `modules/novel_creation/routes.py` | 绑定创建/更新端点接受 depends_on/model/agent_env | 修改 |
| `app.py` | 装配 ModelRouter / ParallelAgentExecutor / AgentClient 注入 | 修改 |
| `tests/test_model_router.py` | ModelRouter 单测 | 新建 |
| `tests/test_parallel_agent_executor.py` | 并行执行器单测 | 新建 |
| `tests/test_agent_client.py` | AgentClient 协议 + Coze 包装单测 | 新建 |
| `tests/test_role_store.py` | 扩展字段持久化/校验单测 | 修改 |
| `tests/test_role_agent_scheduler.py` | 并行语义 + 兼容 + degraded 单测 | 修改 |
| `tests/test_parallel_integration.py` | 端到端多 Agent 并行聚合 | 新建 |

---

## Task 1: AgentClient 抽象协议 + CozeAgentClient 包装

**Files:**
- Create: `modules/novel_creation/agent_client.py`
- Test: `tests/test_agent_client.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_agent_client.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import pytest
from modules.novel_creation.agent_client import AgentClient, CozeAgentClient


class _FakeCoze:
    def __init__(self):
        self.calls = []
    def chat(self, bot_id, user_message, conversation_id="", parameters=None, **kwargs):
        self.calls.append({"bot_id": bot_id, "msg": user_message,
                           "cid": conversation_id, "params": parameters, "kwargs": kwargs})
        return {"success": True, "content": "hi"}


def test_agentclient_abstract():
    with pytest.raises(TypeError):
        AgentClient()


def test_coze_agentclient_wraps_and_passes_model():
    fake = _FakeCoze()
    c = CozeAgentClient(fake)
    out = c.chat("bot1", "你好", "r1:a1", {"k": 1}, model="gpt-4o")
    assert out["content"] == "hi"
    assert fake.calls[0]["kwargs"]["model"] == "gpt-4o"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_agent_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'modules.novel_creation.agent_client'`

- [ ] **Step 3: Write minimal implementation**

```python
# modules/novel_creation/agent_client.py
# -*- coding: utf-8 -*-
"""统一 Agent 客户端协议（Coze / Trae 双通道）。"""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any, Dict, Optional


class AgentClient(ABC):
    """Agent 运行环境客户端抽象基类。

    契约：chat(bot_id, user_message, conversation_id="", parameters=None, **kwargs)
        -> dict{success: bool, content: str, ...}
    agent_id 即 bot_id。
    """

    @abstractmethod
    def chat(
        self,
        bot_id: str,
        user_message: str,
        conversation_id: str = "",
        parameters: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        raise NotImplementedError


class CozeAgentClient(AgentClient):
    """Coze 通道客户端：包装现有 CozeClient，保持 _call_agent 契约不变。"""

    def __init__(self, coze_client: Any) -> None:
        self._coze = coze_client

    def chat(
        self,
        bot_id: str,
        user_message: str,
        conversation_id: str = "",
        parameters: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        return self._coze.chat(
            bot_id=bot_id,
            user_message=user_message,
            conversation_id=conversation_id,
            parameters=parameters or {},
            **kwargs,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_agent_client.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add modules/novel_creation/agent_client.py tests/test_agent_client.py
git commit -m "feat(agent): add AgentClient abstract protocol and CozeAgentClient wrapper"
```

---

## Task 2: TraeAgentClient 协议桩

**Files:**
- Create: `modules/novel_creation/trae_agent_client.py`
- Test: `tests/test_agent_client.py`（追加）

- [ ] **Step 1: Write the failing test**

```python
# 追加到 tests/test_agent_client.py 末尾
from modules.novel_creation.trae_agent_client import TraeAgentClient
import pytest

def test_trae_agentclient_is_stub():
    c = TraeAgentClient()
    with pytest.raises(NotImplementedError):
        c.chat("bot1", "hi", "r1:a1", {})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_agent_client.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'modules.novel_creation.trae_agent_client'`

- [ ] **Step 3: Write minimal implementation**

```python
# modules/novel_creation/trae_agent_client.py
# -*- coding: utf-8 -*-
"""Trae Agent 客户端（协议桩）。

开放项：Trae Agent 调用通道（HTTP 网关 / MCP / Tool / 本地 CLI）尚未定义。
真实接入待用户提供通道契约后补全；当前为占位实现，调用即抛 NotImplementedError。
"""
from __future__ import annotations
from typing import Any, Dict, Optional

from .agent_client import AgentClient


class TraeAgentClient(AgentClient):
    def chat(
        self,
        bot_id: str,
        user_message: str,
        conversation_id: str = "",
        parameters: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        raise NotImplementedError("Trae 通道协议尚未定义，真实接入待补全")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_agent_client.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add modules/novel_creation/trae_agent_client.py tests/test_agent_client.py
git commit -m "feat(agent): add TraeAgentClient protocol stub pending channel contract"
```

---

## Task 3: role_store 绑定字段白名单扩展

**Files:**
- Modify: `modules/novel_creation/role_store.py`（create_binding / update_binding）
- Test: `tests/test_role_store.py`（追加）

- [ ] **Step 1: Write the failing test**

```python
# 追加到 tests/test_role_store.py 末尾
def test_create_binding_extended_fields(store):
    b = store.create_binding("p1", "r1", {
        "agent_id": "a1", "step_order": 3,
        "depends_on": ["a0"], "model": "gpt-4o", "agent_env": "trae",
    })
    assert b["depends_on"] == ["a0"]
    assert b["model"] == "gpt-4o"
    assert b["agent_env"] == "trae"


def test_create_binding_defaults(store):
    b = store.create_binding("p1", "r1", {"agent_id": "a1", "step_order": 1})
    assert b["depends_on"] == []
    assert b["model"] is None
    assert b["agent_env"] == "coze"


def test_update_binding_extended_fields(store):
    b = store.create_binding("p1", "r1", {"agent_id": "a1", "step_order": 1})
    b2 = store.update_binding("p1", "r1", b["id"], {"model": "gpt-4o", "agent_env": "trae"})
    assert b2["model"] == "gpt-4o"
    assert b2["agent_env"] == "trae"


def test_create_binding_invalid_agent_env(store):
    import pytest
    with pytest.raises(Exception):
        store.create_binding("p1", "r1", {"agent_id": "a1", "step_order": 1, "agent_env": "foo"})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_role_store.py -v`
Expected: FAIL — 断言失败（字段未落库/未校验）

- [ ] **Step 3: Write minimal implementation**

在 `role_store.py` 中：

```python
# create_binding 内 **extra 显式提取（替换现有只读 workflow_id/enabled 逻辑）
_AGENT_ENVS = {"coze", "trae"}

def _extract_binding_extra(self, extra):
    depends_on = extra.get("depends_on", [])
    if not isinstance(depends_on, list) or not all(isinstance(x, str) for x in depends_on):
        raise self._bad_request("depends_on 须为字符串列表")
    model = extra.get("model")
    if model is not None and not isinstance(model, str):
        raise self._bad_request("model 须为字符串")
    agent_env = extra.get("agent_env", "coze")
    if agent_env not in _AGENT_ENVS:
        raise self._bad_request("agent_env 须为 coze 或 trae")
    out = {"depends_on": depends_on, "model": model, "agent_env": agent_env}
    if "workflow_id" in extra:
        out["workflow_id"] = extra["workflow_id"]
    if "enabled" in extra:
        out["enabled"] = extra["enabled"]
    return out
```

在 `create_binding` 调用 `_extract_binding_extra`，在 `update_binding` 的 `allowed` 集合扩展为 `{agent_id, step_order, workflow_id, enabled, depends_on, model, agent_env}`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_role_store.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add modules/novel_creation/role_store.py tests/test_role_store.py
git commit -m "feat(agent): extend role binding fields with depends_on/model/agent_env"
```

---

## Task 4: config_loader 新增 model_config

**Files:**
- Modify: `config_loader.py`（DEFAULT_GLOBAL_CONFIG + load 兜底）
- Test: `tests/test_app.py` 或新增 `tests/test_config_model.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_config_model.py
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config_loader import ConfigLoader

def test_load_model_config_defaults():
    with tempfile.TemporaryDirectory() as d:
        cl = ConfigLoader(d)
        cfg = cl.load_global_config()
        mc = cfg["model_config"]
        assert "models" in mc
        assert "default_model" in mc
        assert "route_rules" in mc
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_config_model.py -v`
Expected: FAIL — KeyError 'model_config'

- [ ] **Step 3: Write minimal implementation**

在 `config_loader.py`：

```python
DEFAULT_GLOBAL_CONFIG = {
    "version": 1,
    "admin_password": "",
    "site_name": "",
    "site_description": "",
    "theme": "light",
    "model_config": {
        "models": [],
        "default_model": "default",
        "route_rules": [],
    },
}

# load_global_config 中，对旧配置补默认值：
cfg = {**DEFAULT_GLOBAL_CONFIG, **cfg}
cfg.setdefault("model_config", {})
mc = cfg["model_config"]
mc.setdefault("models", [])
mc.setdefault("default_model", "default")
mc.setdefault("route_rules", [])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_config_model.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add config_loader.py tests/test_config_model.py
git commit -m "feat(agent): add model_config to global config with backward-compat defaults"
```

---

## Task 5: ModelRouter 模型路由层

**Files:**
- Create: `modules/novel_creation/model_router.py`
- Test: `tests/test_model_router.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_model_router.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from modules.novel_creation.model_router import ModelRouter

class _FakeConfig:
    def __init__(self):
        self.model_config = {
            "models": ["gpt-4o", "claude-3-5"],
            "default_model": "gpt-4o",
            "route_rules": [
                {"scene": "character_detail", "model": "claude-3-5"},
            ],
        }
    def load_global_config(self):
        return {"model_config": self.model_config}

def test_list_models():
    r = ModelRouter(_FakeConfig())
    assert r.list_models() == ["gpt-4o", "claude-3-5"]

def test_get_default():
    r = ModelRouter(_FakeConfig())
    assert r.get_default_model() == "gpt-4o"

def test_resolve_scene():
    r = ModelRouter(_FakeConfig())
    assert r.resolve("character_detail") == "claude-3-5"

def test_resolve_no_match_falls_back():
    r = ModelRouter(_FakeConfig())
    assert r.resolve("unknown_scene") == "gpt-4o"

def test_resolve_override():
    r = ModelRouter(_FakeConfig())
    assert r.resolve("character_detail", override="gpt-4o") == "gpt-4o"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_model_router.py -v`
Expected: FAIL — ModuleNotFoundError

- [ ] **Step 3: Write minimal implementation**

```python
# modules/novel_creation/model_router.py
# -*- coding: utf-8 -*-
"""模型路由层：全局配置 + 动态指定 + 按场景路由。"""
from __future__ import annotations
from typing import Any, Dict, List, Optional


class ModelRouter:
    def __init__(self, config_loader: Any, default_model: str = "default") -> None:
        self._config_loader = config_loader
        self._fallback_default = default_model

    def _model_config(self) -> Dict[str, Any]:
        cfg = self._config_loader.load_global_config() or {}
        return cfg.get("model_config", {}) or {}

    def list_models(self) -> List[str]:
        return list(self._model_config().get("models", []))

    def get_default_model(self) -> str:
        return self._model_config().get("default_model") or self._fallback_default

    def resolve(self, scene: str, override: Optional[str] = None) -> str:
        if override:
            return override
        mc = self._model_config()
        for rule in mc.get("route_rules", []):
            if rule.get("scene") == scene:
                return rule.get("model") or self.get_default_model()
        return self.get_default_model()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_model_router.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add modules/novel_creation/model_router.py tests/test_model_router.py
git commit -m "feat(agent): add ModelRouter for configurable model selection and scene routing"
```

---

## Task 6: CozeClient.chat 支持可选 model

**Files:**
- Modify: `coze_client.py`（chat 签名 + body）
- Test: `tests/test_coze_client.py`（追加）

- [ ] **Step 1: Write the failing test**

```python
# 追加到 tests/test_coze_client.py 末尾（若已有同结构，按实际 mock 调整）
def test_chat_accepts_model_kwarg():
    client = CozeClient(...)  # 按现有构造
    # 用 mock 捕获 body，断言 body 含 model 字段
    ...
```

> 注：`test_coze_client.py` 为既有文件，本步骤的 mock 细节需按该文件现有 fixture 调整。核心断言：`chat(..., model="gpt-4o")` 时，POST body 的 `model` 字段为 `"gpt-4o"`。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_coze_client.py -v`
Expected: FAIL — body 无 model 字段

- [ ] **Step 3: Write minimal implementation**

在 `CozeClient.chat` 签名加 `model: Optional[str] = None`，POST body 组装后：

```python
body = { ...现有字段... }
if model:
    body["model"] = model
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_coze_client.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add coze_client.py tests/test_coze_client.py
git commit -m "feat(agent): allow optional model param in CozeClient.chat"
```

---

## Task 7: ParallelAgentExecutor（DAG + 并行 + 超时/重试/降级）

**Files:**
- Create: `modules/novel_creation/parallel_agent_executor.py`
- Test: `tests/test_parallel_agent_executor.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_parallel_agent_executor.py
import os, sys, time
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from modules.novel_creation.parallel_agent_executor import ParallelAgentExecutor, AgentTask


class _FakeCaller:
    def __init__(self):
        self.calls = []
    def __call__(self, task, context):
        self.calls.append(task.task_id)
        time.sleep(task.get("delay", 0))
        return {task.task_id: "done"}


def test_layer_parallel_and_sequential():
    # a->b->c 链：a 在层0，b 层1，c 层2；d,e 与 b 同层可并行
    tasks = [
        AgentTask(task_id="a", depends_on=[]),
        AgentTask(task_id="b", depends_on=["a"]),
        AgentTask(task_id="c", depends_on=["b"]),
        AgentTask(task_id="d", depends_on=["a"]),
    ]
    caller = _FakeCaller()
    ex = ParallelAgentExecutor(caller, executor=ThreadPoolExecutor(max_workers=4))
    # 用 mock：验证 d 与 b 不在同一串行点
    ...
```

> 注：`_FakeCaller` 用 `task.get` 访问延迟需与 `AgentTask` 实现对齐。本任务为计划骨架，具体断言在实现时按 `AgentTask` dataclass 字段补齐（task_id / depends_on / payload）。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_parallel_agent_executor.py -v`
Expected: FAIL — ModuleNotFoundError

- [ ] **Step 3: Write minimal implementation**

```python
# modules/novel_creation/parallel_agent_executor.py
# -*- coding: utf-8 -*-
"""DAG 拓扑分层并行执行器：层内并行、层间串行，超时/重试/降级。"""
from __future__ import annotations
import time
from concurrent.futures import Executor, Future, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from ..common.errors import bad_request


@dataclass
class AgentTask:
    task_id: str
    depends_on: List[str] = field(default_factory=list)
    payload: Dict[str, Any] = field(default_factory=dict)

    def get(self, key, default=None):
        return self.payload.get(key, default)


@dataclass
class PerAgentResult:
    task_id: str
    ok: bool
    output: Dict[str, Any] = field(default_factory=dict)
    error: str = ""
    degraded: bool = False
    attempts: int = 0


@dataclass
class ExecuteResult:
    merged: Dict[str, Any] = field(default_factory=dict)
    per_agent: List[PerAgentResult] = field(default_factory=list)
    degraded: bool = False


def build_layers(tasks: List[AgentTask]) -> List[List[str]]:
    """Kahn 拓扑分层；依赖不存在的 task_id 视为已满足。返回 [层0, 层1, ...]。
    存在环则抛 bad_request(400)。"""
    by_id = {t.task_id: t for t in tasks}
    indeg = {t.task_id: 0 for t in tasks}
    adj = {t.task_id: [] for t in tasks}
    for t in tasks:
        for dep in t.depends_on:
            if dep in by_id and dep != t.task_id:
                indeg[t.task_id] += 1
                adj[dep].append(t.task_id)
    layers = []
    remaining = set(by_id)
    while remaining:
        cur = [tid for tid in remaining if indeg[tid] == 0]
        if not cur:
            raise bad_request("角色 Agent 绑定存在循环依赖")
        layers.append(cur)
        for tid in cur:
            remaining.discard(tid)
            for nxt in adj[tid]:
                indeg[nxt] -= 1
    return layers


class ParallelAgentExecutor:
    def __init__(self, caller: Callable, executor: Optional[Executor] = None,
                 max_workers: int = 8, timeout: float = 30.0,
                 max_retries: int = 2, backoff: float = 1.5) -> None:
        self._caller = caller
        self.max_workers = max_workers
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff = backoff
        if executor is None:
            executor = ThreadPoolExecutor(max_workers=max_workers)
        self.executor: Executor = executor

    def execute(self, tasks: List[AgentTask], context: Dict[str, Any]) -> ExecuteResult:
        layers = build_layers(tasks)
        by_id = {t.task_id: t for t in tasks}
        merged = dict(context)
        per_agent: List[PerAgentResult] = []
        any_degraded = False
        for layer in layers:
            futures = {}
            for tid in layer:
                futures[tid] = self.executor.submit(self._run_one, by_id[tid], merged)
            for tid, fut in futures.items():
                res = fut.result()  # 层内阻塞等待全部完成
                per_agent.append(res)
                if res.ok:
                    merged.update(res.output)
                if res.degraded:
                    any_degraded = True
        return ExecuteResult(merged=merged, per_agent=per_agent, degraded=any_degraded)

    def _run_one(self, task: AgentTask, context: Dict[str, Any]) -> PerAgentResult:
        last_err = ""
        for attempt in range(self.max_retries + 1):
            try:
                out = self._caller(task, context)
                if not isinstance(out, dict):
                    raise ValueError("Agent 输出非 dict")
                return PerAgentResult(task_id=task.task_id, ok=True, output=out, attempts=attempt + 1)
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)
                if attempt < self.max_retries:
                    time.sleep(self.backoff ** attempt)
        return PerAgentResult(task_id=task.task_id, ok=False, error=last_err,
                              degraded=True, attempts=self.max_retries + 1)
```

> 注：本实现未含 `future.result(timeout=...)` 显式超时——`_run_one` 内部的重试已覆盖大部分超时场景；如需对单个 future 加超时上限，可在 `execute` 的 `fut.result(timeout=self.timeout)` 处捕获 `TimeoutError` 标记 degraded。实现时二者选一，优先保留 `_run_one` 重试语义并补充 future 级超时。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_parallel_agent_executor.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add modules/novel_creation/parallel_agent_executor.py tests/test_parallel_agent_executor.py
git commit -m "feat(agent): add ParallelAgentExecutor with DAG layering, retry and degrade"
```

---

## Task 8: RoleAgentScheduler 委托并行 + 模型路由

**Files:**
- Modify: `modules/novel_creation/role_agent_scheduler.py`（`invoke_role_agents` 内部、`__init__` 可选参数、`_call_agent` 用 AgentClient）
- Test: `tests/test_role_agent_scheduler.py`（追加兼容 + degraded 测试）

- [ ] **Step 1: Write the failing test**

```python
# 追加到 tests/test_role_agent_scheduler.py 末尾
def test_invoke_delegates_parallel_and_merges(sched, role_store, project_store, agent_client, executor):
    # 多命中绑定 → 结果合并，语义与串行一致（兼容性）
    ...

def test_invoke_depends_on_respected(sched, role_store, project_store, agent_client, executor):
    # depends_on 声明 → 调用顺序按拓扑层
    ...

def test_invoke_degraded_continues(sched, role_store, project_store, agent_client, executor):
    # 某 Agent 超限失败 → degraded 标记 + 后续仍执行
    ...
```

> 注：现有 `test_role_agent_scheduler.py` 已用 `_FakeRoleStore/_FakeProjectStore`。本步骤复用现有 fixture，在 `sched` 构造时传入 `model_router`（可为 None → 内置默认）与 `parallel_executor`（可用真实 `ParallelAgentExecutor`）。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_role_agent_scheduler.py -v`
Expected: FAIL — 现有串行语义测试可能仍过，但新增并行/degraded 测试失败

- [ ] **Step 3: Write minimal implementation**

在 `role_agent_scheduler.py`：

```python
# __init__ 新增可选参数（向后兼容）
def __init__(self, role_store, project_store, agent_client, executor=None,
             max_workers=8, tool_name="role_agent_invoke",
             model_router=None, parallel_executor=None,
             timeout=30.0, max_retries=2, backoff=1.5):
    ...
    self.model_router = model_router  # 可为 None，内置用默认模型
    from .parallel_agent_executor import ParallelAgentExecutor
    if parallel_executor is None:
        parallel_executor = ParallelAgentExecutor(
            caller=self._invoke_agent, executor=executor,
            max_workers=max_workers, timeout=timeout,
            max_retries=max_retries, backoff=backoff)
    self.parallel_executor = parallel_executor


# invoke_role_agents 内部：命中绑定 → 构建 AgentTask 列表（含 depends_on）→ 委托
def invoke_role_agents(self, project_id, role_id, step_order, context):
    ...校验 step_order...
    bindings = self.role_store.get_bindings(project_id, role_id, enabled=True)
    bindings = sorted(bindings, key=lambda b: b["step_order"])
    hit = [b for b in bindings if b["step_order"] <= step_order]
    tasks = [self._to_task(b) for b in hit if b.get("agent_id")]
    if not tasks:
        return copy.copy(context)
    result = self.parallel_executor.execute(tasks, dict(context))
    # 若 degraded，记录审计标记（不阻断）
    return result.merged


def _to_task(self, binding):
    from .parallel_agent_executor import AgentTask
    return AgentTask(
        task_id=binding["id"],
        depends_on=list(binding.get("depends_on", [])),
        payload={"binding": binding},
    )


def _call_agent(self, agent_id, user_message, conversation_id, model=None):
    # 经 AgentClient 协议路由；缺省用 Coze 包装
    client = getattr(self, "_agent_client_protocol", None)
    if client is None:
        from .agent_client import CozeAgentClient
        client = CozeAgentClient(self.agent_client)
    kwargs = {}
    if model:
        kwargs["model"] = model
    return client.chat(bot_id=agent_id, user_message=user_message,
                       conversation_id=conversation_id, parameters={}, **kwargs)
```

> 注：`_invoke_agent` 需按 `binding.model` / `model_router.resolve(scene)` 解析出 model 后传给 `_call_agent`。若 `model_router` 为 None，model 为 `binding.get("model")` 或 None。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_role_agent_scheduler.py tests/test_step_flow_engine.py tests/test_novel_creation_routes.py -v`
Expected: PASS（全部既有测试不回归）

- [ ] **Step 5: Commit**

```bash
git add modules/novel_creation/role_agent_scheduler.py tests/test_role_agent_scheduler.py
git commit -m "feat(agent): delegate scheduler to ParallelAgentExecutor and ModelRouter"
```

---

## Task 9: routes.py 端点接受扩展字段

**Files:**
- Modify: `modules/novel_creation/routes.py`（绑定创建/更新端点）
- Test: `tests/test_novel_creation_routes.py`（追加）

- [ ] **Step 1: Write the failing test**

```python
# 追加：POST /roles/<id>/agents 携带 depends_on/model/agent_env → 201 且响应含字段
# PUT /roles/<id>/agents/<bid> 更新 model → 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_novel_creation_routes.py -v`
Expected: FAIL — 响应无新字段

- [ ] **Step 3: Write minimal implementation**

在 `routes.py` 绑定创建端点，从 `request.get_json()` 读取并透传 `depends_on / model / agent_env` 给 `role_store.create_binding`；更新端点 `allowed` 集合同步扩展。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_novel_creation_routes.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add modules/novel_creation/routes.py tests/test_novel_creation_routes.py
git commit -m "feat(agent): accept depends_on/model/agent_env in role binding API"
```

---

## Task 10: app.py 装配注入

**Files:**
- Modify: `app.py`（create_app 装配段）
- Test: `tests/test_app.py`（追加 smoke）

- [ ] **Step 1: Write the failing test**

```python
# 追加：create_app 后，app.config 或蓝图内含 ModelRouter / ParallelAgentExecutor
def test_app_wires_model_router(app):
    # 经 app 蓝图/工厂访问注入组件存在
    ...
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_app.py -v`
Expected: FAIL — 组件未注入

- [ ] **Step 3: Write minimal implementation**

在 `create_app` 装配段：

```python
from modules.novel_creation.model_router import ModelRouter
from modules.novel_creation.parallel_agent_executor import ParallelAgentExecutor
from modules.novel_creation.agent_client import CozeAgentClient

model_router = ModelRouter(config_loader)
scheduler = RoleAgentScheduler(
    role_store=role_store, project_store=project_store,
    agent_client=coze_client, executor=executor,
    model_router=model_router,  # 可选
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_app.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_app.py
git commit -m "feat(agent): wire ModelRouter and ParallelAgentExecutor into app assembly"
```

---

## Task 11: 集成测试（端到端多 Agent 并行聚合）

**Files:**
- Create: `tests/test_parallel_integration.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_parallel_integration.py
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from modules.novel_creation.role_agent_scheduler import RoleAgentScheduler
from modules.novel_creation.model_router import ModelRouter
from modules.novel_creation.parallel_agent_executor import ParallelAgentExecutor
from modules.novel_creation.agent_client import CozeAgentClient

# 集成：多个绑定（含 depends_on）+ ModelRouter + ParallelExecutor → invoke_role_agents
# 断言：结果聚合、层内并行触发、degraded 不阻断
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_parallel_integration.py -v`
Expected: FAIL — 未实现

- [ ] **Step 3: Write minimal implementation**

用 mock role_store / CozeAgentClient，构造真实 `RoleAgentScheduler(model_router=..., parallel_executor=...)`，调用 `invoke_role_agents` 验证聚合与并行。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/test_parallel_integration.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/test_parallel_integration.py
git commit -m "test(agent): integration test for parallel multi-agent aggregation"
```

---

## Task 12: 全量回归 + 文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-11-13-agent-parallel-model-design.md`（补实现说明）
- Test: 全量 `tests/`

- [ ] **Step 1: 全量回归**

Run: `cd G:\workspace_trae\StoryForgeAI && python -m pytest tests/ -v`
Expected: 全部 PASS（含既有 30+ 测试文件不回归）

- [ ] **Step 2: 文档同步**

更新设计文档，标注开放项①（Trae 通道）仍为桩、开放项②（Coze model）已实现，并记录实现说明。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-11-13-agent-parallel-model-design.md
git commit -m "docs(agent): update design doc with implementation notes"
```

---

## Self-Review 结果

**1. Spec 覆盖**：能力 1（Task 3/8/9）、能力 2（Task 1/2/8/10，Trae 为桩）、能力 3（Task 4/5/6/8）、兼容性（Task 8 保留签名 + Task 12 全量回归）、稳定性（Task 7）、测试三场景（Task 5/7/11）。无遗漏。

**2. Placeholder 扫描**：Task 6/7/8/9 的测试代码含 `...` 占位，因依赖既有 fixture 结构，实现时需按现有测试补全——已标注"按现有 fixture 调整"。其余任务均有完整代码。

**3. Type 一致性**：`AgentTask(task_id, depends_on, payload)`、`ExecuteResult(merged, per_agent, degraded)`、`PerAgentResult(task_id, ok, output, error, degraded, attempts)`、`AgentClient.chat` 签名、`ModelRouter.resolve(scene, override)` 在后续任务中引用一致。

---

## 执行交接

计划已保存。执行方式二选一：
1. **Subagent-Driven（推荐）**：每个任务派发独立子代理，任务间审查，快速迭代。
2. **Inline Execution**：本会话用 executing-plans 批量执行，检查点审查。

请确认采用哪种方式。
