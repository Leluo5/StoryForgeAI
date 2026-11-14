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
