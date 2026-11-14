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
