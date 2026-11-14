# -*- coding: utf-8 -*-
"""ParallelAgentExecutor 的 DAG、并发、重试、超时与聚合行为测试。"""

import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.common.errors import AppError
from modules.novel_creation.parallel_agent_executor import (
    AgentTask,
    ExecuteResult,
    PerAgentResult,
    ParallelAgentExecutor,
    build_layers,
)


def test_build_layers_uses_stable_kahn_order_and_ignores_missing_dependencies() -> None:
    tasks = [
        AgentTask(task_id="c", depends_on=["b"]),
        AgentTask(task_id="a"),
        AgentTask(task_id="b", depends_on=["a", "missing"]),
        AgentTask(task_id="d"),
    ]

    assert build_layers(tasks) == [["a", "d"], ["b"], ["c"]]


def test_build_layers_rejects_dependency_cycle_with_bad_request() -> None:
    tasks = [
        AgentTask(task_id="a", depends_on=["b"]),
        AgentTask(task_id="b", depends_on=["a"]),
    ]

    with pytest.raises(AppError) as caught:
        build_layers(tasks)

    assert caught.value.code == 400


def test_build_layers_rejects_self_dependency_with_bad_request() -> None:
    with pytest.raises(AppError) as caught:
        build_layers([AgentTask(task_id="a", depends_on=["a"])])

    assert caught.value.code == 400


def test_same_layer_tasks_actually_run_in_parallel() -> None:
    barrier = threading.Barrier(2)

    def caller(task: AgentTask, context: Dict[str, Any]) -> Dict[str, Any]:
        barrier.wait(timeout=1)
        return {task.task_id: "done"}

    with ThreadPoolExecutor(max_workers=2) as pool:
        executor = ParallelAgentExecutor(
            caller, executor=pool, timeout=2, max_retries=0, backoff=0,
        )
        result = executor.execute([AgentTask("a"), AgentTask("b")], {})

    assert [item.ok for item in result.per_agent] == [True, True]
    assert result.merged == {"a": "done", "b": "done"}


def test_layers_wait_for_previous_layer_before_starting() -> None:
    a_started = threading.Event()
    release_a = threading.Event()
    b_started = threading.Event()
    release_b = threading.Event()
    c_started = threading.Event()
    observed = {}

    def caller(task: AgentTask, context: Dict[str, Any]) -> Dict[str, Any]:
        if task.task_id == "a":
            a_started.set()
            if not release_a.wait(2):
                raise RuntimeError("a was not released")
        elif task.task_id == "b":
            b_started.set()
            observed["b_after_a"] = release_a.is_set()
            if not release_b.wait(2):
                raise RuntimeError("b was not released")
        else:
            c_started.set()
            observed["c_after_b"] = release_b.is_set()
        return {task.task_id: True}

    tasks = [
        AgentTask("a"),
        AgentTask("b", depends_on=["a"]),
        AgentTask("c", depends_on=["b"]),
    ]
    with ThreadPoolExecutor(max_workers=3) as pool:
        executor = ParallelAgentExecutor(
            caller, executor=pool, timeout=3, max_retries=0, backoff=0,
        )
        with ThreadPoolExecutor(max_workers=1) as runner:
            running = runner.submit(executor.execute, tasks, {})
            try:
                assert a_started.wait(1)
                assert not b_started.wait(0.05)
                release_a.set()
                assert b_started.wait(1)
                assert not c_started.wait(0.05)
                release_b.set()
                result = running.result(timeout=2)
            finally:
                release_a.set()
                release_b.set()

    assert observed == {"b_after_a": True, "c_after_b": True}
    assert [item.ok for item in result.per_agent] == [True, True, True]


def test_next_layer_sees_previous_successes_and_input_context_is_not_mutated() -> None:
    seen = {}

    def caller(task: AgentTask, context: Dict[str, Any]) -> Dict[str, Any]:
        seen[task.task_id] = dict(context)
        return {"from_" + task.task_id: task.task_id}

    context = {"base": 1}
    tasks = [AgentTask("a"), AgentTask("b", depends_on=["a"])]
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = ParallelAgentExecutor(
            caller, executor=pool, timeout=1, max_retries=0, backoff=0,
        ).execute(tasks, context)

    assert seen["a"] == {"base": 1}
    assert seen["b"] == {"base": 1, "from_a": "a"}
    assert result.merged == {"base": 1, "from_a": "a", "from_b": "b"}
    assert context == {"base": 1}


def test_same_layer_outputs_merge_in_task_order_not_completion_order() -> None:
    second_finished = threading.Event()
    completion_order = []

    def caller(task: AgentTask, context: Dict[str, Any]) -> Dict[str, Any]:
        if task.task_id == "first":
            if not second_finished.wait(1):
                raise RuntimeError("second did not finish")
            completion_order.append("first")
            return {"shared": "first", "first": True}
        completion_order.append("second")
        second_finished.set()
        return {"shared": "second", "second": True}

    tasks = [AgentTask("first"), AgentTask("second")]
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = ParallelAgentExecutor(
            caller, executor=pool, timeout=2, max_retries=0, backoff=0,
        ).execute(tasks, {"base": 1})

    assert completion_order == ["second", "first"]
    assert [item.task_id for item in result.per_agent] == ["first", "second"]
    assert result.merged == {
        "base": 1,
        "shared": "second",
        "first": True,
        "second": True,
    }


def test_empty_tasks_return_an_independent_context_copy() -> None:
    def unexpected_caller(task: AgentTask, context: Dict[str, Any]) -> Dict[str, Any]:
        raise AssertionError("caller must not run for an empty task list")

    context = {"base": 1}
    result = ParallelAgentExecutor(unexpected_caller).execute([], context)

    assert isinstance(result, ExecuteResult)
    assert result.merged == context
    assert result.merged is not context
    assert result.per_agent == []
    assert result.degraded is False


def test_caller_exception_is_retried_and_success_records_attempts() -> None:
    calls = []

    def flaky_caller(task: AgentTask, context: Dict[str, Any]) -> Dict[str, Any]:
        calls.append(task.task_id)
        if len(calls) < 3:
            raise RuntimeError("temporary failure")
        return {"value": "ok"}

    executor = ParallelAgentExecutor(
        flaky_caller, max_retries=2, backoff=0, timeout=1,
    )
    result = executor.execute([AgentTask("a")], {})

    assert calls == ["a", "a", "a"]
    assert isinstance(result.per_agent[0], PerAgentResult)
    assert result.per_agent[0].ok is True
    assert result.per_agent[0].attempts == 3
    assert result.per_agent[0].degraded is False
    assert result.merged == {"value": "ok"}


def test_non_dict_output_is_retried_then_degrades() -> None:
    calls = []

    def invalid_caller(task: AgentTask, context: Dict[str, Any]) -> Any:
        calls.append(task.task_id)
        return "not a dict"

    executor = ParallelAgentExecutor(
        invalid_caller, max_retries=1, backoff=0, timeout=1,
    )
    result = executor.execute([AgentTask("a")], {"base": 1})

    assert calls == ["a", "a"]
    assert result.per_agent[0].ok is False
    assert result.per_agent[0].attempts == 2
    assert result.per_agent[0].degraded is True
    assert "dict" in result.per_agent[0].error
    assert result.degraded is True
    assert result.merged == {"base": 1}


def test_final_failure_does_not_block_another_task() -> None:
    bad_calls = []

    def caller(task: AgentTask, context: Dict[str, Any]) -> Dict[str, Any]:
        if task.task_id == "bad":
            bad_calls.append(task.task_id)
            raise RuntimeError("permanent failure")
        return {"good": "done"}

    with ThreadPoolExecutor(max_workers=2) as pool:
        result = ParallelAgentExecutor(
            caller, executor=pool, max_retries=1, backoff=0, timeout=1,
        ).execute([AgentTask("bad"), AgentTask("good")], {})

    by_id = {item.task_id: item for item in result.per_agent}
    assert bad_calls == ["bad", "bad"]
    assert by_id["bad"].ok is False
    assert by_id["bad"].attempts == 2
    assert by_id["bad"].degraded is True
    assert by_id["bad"].error == "permanent failure"
    assert by_id["good"].ok is True
    assert by_id["good"].attempts == 1
    assert result.merged == {"good": "done"}
    assert result.degraded is True


def test_future_timeout_degrades_and_late_output_is_never_merged() -> None:
    slow_started = threading.Event()
    release_slow = threading.Event()
    slow_finished = threading.Event()

    def caller(task: AgentTask, context: Dict[str, Any]) -> Dict[str, Any]:
        if task.task_id == "slow":
            slow_started.set()
            try:
                if not release_slow.wait(2):
                    raise RuntimeError("slow task was not released")
                return {"late": "must not merge"}
            finally:
                slow_finished.set()
        return {"fast": "done"}

    with ThreadPoolExecutor(max_workers=2) as pool:
        executor = ParallelAgentExecutor(
            caller, executor=pool, timeout=0.05, max_retries=0, backoff=0,
        )
        try:
            result = executor.execute([AgentTask("slow"), AgentTask("fast")], {})
            assert slow_started.is_set()
            assert not slow_finished.is_set()
        finally:
            release_slow.set()
        assert slow_finished.wait(1)

    by_id = {item.task_id: item for item in result.per_agent}
    assert by_id["slow"].ok is False
    assert by_id["slow"].degraded is True
    assert "超时" in by_id["slow"].error
    assert by_id["fast"].ok is True
    assert result.merged == {"fast": "done"}
    assert result.degraded is True


def test_execute_does_not_shutdown_injected_executor() -> None:
    with ThreadPoolExecutor(max_workers=1) as pool:
        executor = ParallelAgentExecutor(
            lambda task, context: {"value": "done"},
            executor=pool,
            timeout=1,
            max_retries=0,
            backoff=0,
        )
        result = executor.execute([AgentTask("a")], {})

        assert result.merged == {"value": "done"}
        assert pool.submit(lambda: "still open").result(timeout=1) == "still open"
