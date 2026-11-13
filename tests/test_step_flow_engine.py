# -*- coding: utf-8 -*-
"""step_flow_engine.py 补测（P5-T1：覆盖率补测，覆盖 get_steps/get_step/reorder/trigger_step/trigger_flow/校验）。

依赖注入 mock scheduler + role_store，避免真实 Agent 调用。
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError, bad_request
from modules.novel_creation.step_flow_engine import StepFlowEngine, DEFAULT_STEPS


class _FakeRoleStore:
    def __init__(self, exists=True):
        self.exists = exists

    def get_role(self, project_id, role_id):
        if not self.exists:
            raise AppError(404, "角色不存在")
        return {"id": role_id}


class _FakeScheduler:
    def __init__(self):
        self.calls = []

    def invoke_role_agents(self, project_id, role_id, step_order, context):
        self.calls.append((step_order, context))
        return dict(context, last_step=step_order)


def _make(steps=None, exists=True):
    rs = _FakeRoleStore(exists)
    sched = _FakeScheduler()
    engine = StepFlowEngine(sched, rs, steps=steps)
    return engine, sched


# ---------- 构造校验 ----------

class TestValidation:
    def test_default_steps_valid(self):
        _make()  # 不抛异常

    def test_duplicate_order_raises(self):
        steps = [
            {"step_order": 1, "name": "a"},
            {"step_order": 1, "name": "b"},
        ]
        with pytest.raises(AppError) as ei:
            _make(steps=steps)
        assert ei.value.code == 400

    def test_out_of_range_raises(self):
        steps = [{"step_order": 12, "name": "a"}]
        with pytest.raises(AppError):
            _make(steps=steps)

    def test_non_continuous_raises(self):
        steps = [
            {"step_order": 1, "name": "a"},
            {"step_order": 3, "name": "c"},
        ]
        with pytest.raises(AppError):
            _make(steps=steps)


# ---------- get_steps / get_step ----------

class TestGetters:
    def test_get_steps_returns_11(self):
        engine, _ = _make()
        steps = engine.get_steps()
        assert len(steps) == 11
        assert steps[0]["step_order"] == 1
        assert steps[-1]["step_order"] == 11
        assert steps[0]["name"] == "外貌特征"

    def test_get_steps_returns_copy(self):
        engine, _ = _make()
        steps = engine.get_steps()
        steps[0]["name"] = "篡改"
        assert engine.get_steps()[0]["name"] != "篡改"

    def test_get_step_ok(self):
        engine, _ = _make()
        step = engine.get_step(5)
        assert step["step_order"] == 5
        assert step["name"] == "情感状态"

    def test_get_step_out_of_range(self):
        engine, _ = _make()
        with pytest.raises(AppError):
            engine.get_step(12)

    def test_get_step_missing(self):
        engine, _ = _make(steps=[
            {"step_order": 1, "name": "a"},
            {"step_order": 2, "name": "b"},
        ])
        # 99 > 11，先触发越界校验
        with pytest.raises(AppError) as ei:
            engine.get_step(99)
        assert "越界" in ei.value.message


# ---------- reorder ----------

class TestReorder:
    def test_reorder_ok(self):
        engine, _ = _make(steps=[
            {"step_order": 1, "name": "a"},
            {"step_order": 2, "name": "b"},
            {"step_order": 3, "name": "c"},
        ])
        reordered = engine.reorder([3, 1, 2])
        # 原第3步排到第1位
        assert reordered[0]["name"] == "c"
        assert reordered[0]["step_order"] == 1
        assert reordered[1]["name"] == "a"
        assert reordered[2]["name"] == "b"

    def test_reorder_wrong_length(self):
        engine, _ = _make(steps=[
            {"step_order": 1, "name": "a"},
            {"step_order": 2, "name": "b"},
        ])
        with pytest.raises(AppError):
            engine.reorder([1])

    def test_reorder_not_permutation(self):
        engine, _ = _make(steps=[
            {"step_order": 1, "name": "a"},
            {"step_order": 2, "name": "b"},
        ])
        with pytest.raises(AppError):
            engine.reorder([1, 1])  # 重复，非排列


# ---------- trigger_step ----------

class TestTriggerStep:
    def test_trigger_step_ok(self):
        engine, sched = _make()
        result = engine.trigger_step("p1", "r1", 3, {"role": "林远"})
        assert result["last_step"] == 3
        assert sched.calls[0][0] == 3

    def test_trigger_step_invalid_order(self):
        engine, _ = _make()
        with pytest.raises(AppError):
            engine.trigger_step("p1", "r1", 0, {})

    def test_trigger_step_role_not_found(self):
        engine, _ = _make(exists=False)
        with pytest.raises(AppError) as ei:
            engine.trigger_step("p1", "r1", 3, {})
        assert ei.value.code == 404


# ---------- trigger_flow ----------

class TestTriggerFlow:
    def test_trigger_flow_runs_all_steps(self):
        engine, sched = _make(steps=[
            {"step_order": 1, "name": "a"},
            {"step_order": 2, "name": "b"},
        ])
        result = engine.trigger_flow("p1", "r1", {"x": 1})
        assert len(sched.calls) == 2
        assert result["last_step"] == 2
        # 上下文透传：第一步后 last_step=1 传入第二步
        assert sched.calls[0][1] == {"x": 1}
        assert sched.calls[1][1]["last_step"] == 1

    def test_trigger_flow_role_not_found(self):
        engine, _ = _make(exists=False)
        with pytest.raises(AppError):
            engine.trigger_flow("p1", "r1", {})
