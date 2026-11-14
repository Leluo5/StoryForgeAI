# -*- coding: utf-8 -*-
"""DAG 拓扑分层并行执行器：层内并行、层间串行，超时/重试/降级。"""

from __future__ import annotations

import time
from concurrent.futures import Executor, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from ..common.errors import bad_request


@dataclass
class AgentTask:
    """一个 Agent 调用任务及其 DAG 依赖。"""

    task_id: str
    depends_on: List[str] = field(default_factory=list)
    payload: Dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        """读取 payload 字段，缺省时返回 default。"""
        return self.payload.get(key, default)


@dataclass
class PerAgentResult:
    """单个 Agent 的最终调用结果。"""

    task_id: str
    ok: bool
    output: Dict[str, Any] = field(default_factory=dict)
    error: str = ""
    degraded: bool = False
    attempts: int = 0


@dataclass
class ExecuteResult:
    """一次 DAG 执行的聚合上下文与各 Agent 结果。"""

    merged: Dict[str, Any] = field(default_factory=dict)
    per_agent: List[PerAgentResult] = field(default_factory=list)
    degraded: bool = False


def build_layers(tasks: List[AgentTask]) -> List[List[str]]:
    """按输入顺序进行 Kahn 拓扑分层，未知依赖视为已满足。

    返回各层 task_id；普通循环依赖和自依赖均抛 400 AppError。
    """
    by_id = {task.task_id: task for task in tasks}
    order = list(by_id)
    indegree = {task_id: 0 for task_id in order}
    adjacency = {task_id: [] for task_id in order}

    for task in tasks:
        for dependency in task.depends_on:
            if dependency in by_id:
                indegree[task.task_id] += 1
                adjacency[dependency].append(task.task_id)

    layers = []
    remaining = set(order)
    while remaining:
        current = [
            task_id for task_id in order
            if task_id in remaining and indegree[task_id] == 0
        ]
        if not current:
            raise bad_request("角色 Agent 绑定存在循环依赖")
        layers.append(current)
        for task_id in current:
            remaining.remove(task_id)
            for dependent in adjacency[task_id]:
                indegree[dependent] -= 1

    return layers


class ParallelAgentExecutor:
    """使用可注入 Executor 分层调度 Agent，并隔离调用失败。"""

    def __init__(
        self,
        caller: Callable[[AgentTask, Dict[str, Any]], Dict[str, Any]],
        executor: Optional[Executor] = None,
        max_workers: int = 8,
        timeout: float = 30.0,
        max_retries: int = 2,
        backoff: float = 1.5,
    ) -> None:
        """注入调用函数及执行参数；未传 executor 时创建线程池。"""
        self._caller = caller
        self.max_workers = max_workers
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff = backoff
        if executor is None:
            executor = ThreadPoolExecutor(max_workers=max_workers)
        self.executor: Executor = executor

    def execute(self, tasks: List[AgentTask], context: Dict[str, Any]) -> ExecuteResult:
        """执行 DAG，按稳定任务顺序聚合成功输出并返回降级标记。

        每层先统一提交任务，再按层内任务顺序收集结果；超时只取消 future
        的等待语义，不假定正在运行的 caller 线程已被强制终止。
        """
        layers = build_layers(tasks)
        by_id = {task.task_id: task for task in tasks}
        merged = dict(context)
        per_agent = []
        any_degraded = False

        for layer in layers:
            layer_context = dict(merged)
            futures = [
                (
                    task_id,
                    self.executor.submit(
                        self._run_one, by_id[task_id], dict(layer_context),
                    ),
                )
                for task_id in layer
            ]
            for task_id, future in futures:
                try:
                    result = future.result(timeout=self.timeout)
                except FutureTimeoutError:
                    future.cancel()
                    result = PerAgentResult(
                        task_id=task_id,
                        ok=False,
                        error=f"Agent 执行超时（{self.timeout} 秒）",
                        degraded=True,
                    )
                per_agent.append(result)
                if result.ok:
                    merged.update(result.output)
                if result.degraded:
                    any_degraded = True

        return ExecuteResult(
            merged=merged,
            per_agent=per_agent,
            degraded=any_degraded,
        )

    def _run_one(self, task: AgentTask, context: Dict[str, Any]) -> PerAgentResult:
        """调用单个 Agent；异常和非 dict 输出按配置重试并降级。"""
        last_error = ""
        for attempt in range(self.max_retries + 1):
            try:
                output = self._caller(task, context)
                if not isinstance(output, dict):
                    raise ValueError("Agent 输出非 dict")
                return PerAgentResult(
                    task_id=task.task_id,
                    ok=True,
                    output=output,
                    attempts=attempt + 1,
                )
            except Exception as exc:  # noqa: BLE001 - 单 Agent 失败需隔离
                last_error = str(exc)
                if attempt < self.max_retries:
                    delay = self.backoff * (2 ** attempt)
                    if delay > 0:
                        time.sleep(delay)

        return PerAgentResult(
            task_id=task.task_id,
            ok=False,
            error=last_error,
            degraded=True,
            attempts=self.max_retries + 1,
        )
