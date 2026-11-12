# -*- coding: utf-8 -*-
"""11 步预设流程引擎（P3-T3）。

职责（对齐架构设计文档 §五 11 步预设流程引擎设计）：
  1. 预设 11 步流程配置（外貌特征/个性特点/思维方式/个人能力/情感状态/
     文化背景/信仰道德/成长线/经历沉淀/人际关系/情节发展）；
  2. get_steps：返回完整 11 步；
  3. reorder：重排 step_order（1-11 完整、可增删，校验唯一且连续）；
  4. trigger_step：单步触发 —— 委托 RoleAgentScheduler 按当前 step 调用绑定 Agent；
  5. trigger_flow：全流程顺序触发 —— 依次对 1..11 调用，上下文逐步透传。

边界：本模块不 import 知识库模块任何符号；知识条目经 RoleContextDTO 只读注入。
依赖注入：scheduler（RoleAgentScheduler）+ role_store（RoleStore）由路由层构造传入。

说明：设计 §5.2 方法表 `trigger_step(role_id, ...)` 未含 project_id 属伪代码简化；
调度器 RoleStore 实际签名均为 (project_id, ...)，故此处显式接收 project_id
（P3-T4 路由层持有，与 P3-T2 调度器处理方式一致）。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..common.errors import bad_request

# 预设 11 步（架构设计文档 §5.1，与骨架模块头注释一致）
DEFAULT_STEPS: List[Dict[str, Any]] = [
    {"step_order": 1,  "name": "外貌特征", "desc": "角色外观设定", "tool": "gen_character_image"},
    {"step_order": 2,  "name": "个性特点", "desc": "性格特质", "tool": None},
    {"step_order": 3,  "name": "思维方式", "desc": "认知模式", "tool": None},
    {"step_order": 4,  "name": "个人能力", "desc": "技能特长", "tool": None},
    {"step_order": 5,  "name": "情感状态", "desc": "当前情绪", "tool": "emotion_analysis"},
    {"step_order": 6,  "name": "文化背景", "desc": "出身文化", "tool": None},
    {"step_order": 7,  "name": "信仰道德", "desc": "价值观与信念", "tool": None},
    {"step_order": 8,  "name": "成长线", "desc": "成长弧线", "tool": None},
    {"step_order": 9,  "name": "经历沉淀", "desc": "过往经历", "tool": None},
    {"step_order": 10, "name": "人际关系", "desc": "社交网络", "tool": None},
    {"step_order": 11, "name": "情节发展", "desc": "参与剧情", "tool": "gen_chapter"},
]

# step_order 合法范围（架构设计文档 §5.3）
_MIN_ORDER = 1
_MAX_ORDER = 11


class StepFlowEngine:
    """11 步预设流程引擎。

    构造参数：
        scheduler: RoleAgentScheduler 实例（invoke_role_agents 调用绑定 Agent）。
        role_store: RoleStore 实例（校验角色存在、读取步骤绑定）。
        steps: 可选自定义步骤列表，默认使用 DEFAULT_STEPS（深拷贝隔离）。
    """

    def __init__(
        self,
        scheduler: Any,
        role_store: Any,
        steps: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        self.scheduler = scheduler
        self.role_store = role_store
        # 深拷贝隔离：外部修改不污染引擎内部状态
        self._steps: List[Dict[str, Any]] = [dict(s) for s in (steps or DEFAULT_STEPS)]
        self._validate()

    def _validate(self) -> None:
        """校验步骤表：step_order 1-11 完整、唯一且连续（架构设计文档 §5.3）。"""
        orders = [s.get("step_order") for s in self._steps]
        if len(orders) != len(set(orders)):
            raise bad_request("step_order 存在重复")
        for order in orders:
            if not isinstance(order, int) or isinstance(order, bool) \
                    or not (_MIN_ORDER <= order <= _MAX_ORDER):
                raise bad_request(f"step_order 越界: {order}（须 1-11）")
        expected = list(range(_MIN_ORDER, _MIN_ORDER + len(self._steps)))
        if sorted(orders) != expected:
            raise bad_request("step_order 不连续，须为 1..N 完整序列")

    def get_steps(self) -> List[Dict[str, Any]]:
        """返回完整 11 步（按 step_order 升序，深拷贝防外部修改）。"""
        return [dict(s) for s in sorted(self._steps, key=lambda s: s["step_order"])]

    def get_step(self, step_order: int) -> Dict[str, Any]:
        """取单个步骤。不存在抛 400。"""
        if not isinstance(step_order, int) or isinstance(step_order, bool) \
                or not (_MIN_ORDER <= step_order <= _MAX_ORDER):
            raise bad_request(f"step_order 越界: {step_order}")
        for s in self._steps:
            if s["step_order"] == step_order:
                return dict(s)
        raise bad_request(f"步骤不存在: {step_order}")

    def reorder(self, new_order: List[int]) -> List[Dict[str, Any]]:
        """重排 step_order。

        参数 new_order 为新的顺序列表，长度与当前步骤数一致，元素为原 step_order 的排列。
        例如原 1..5，new_order=[3,1,5,2,4] 表示把原第 3 步排到第 1 位。
        校验后原地重排并返回新步骤列表。
        """
        current = self.get_steps()
        if len(new_order) != len(current):
            raise bad_request(f"new_order 长度须为 {len(current)}")
        if sorted(new_order) != [s["step_order"] for s in current]:
            raise bad_request("new_order 必须为原 step_order 的完整排列")
        # 原 step_order -> 步骤 映射
        by_order = {s["step_order"]: dict(s) for s in current}
        reordered: List[Dict[str, Any]] = []
        for new_pos, old_order in enumerate(new_order, start=1):
            step = by_order[old_order]
            step["step_order"] = new_pos
            reordered.append(step)
        # 校验唯一/连续后提交
        self._steps = reordered
        self._validate()
        return self.get_steps()

    # ---------- 触发 ----------

    def trigger_step(
        self, project_id: str, role_id: str, step_order: int, context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """单步触发（架构设计文档 §5.2）。

        委托调度器按当前 step_order 调用角色绑定 Agent，返回透传合并后的 context。
        未绑定 Agent 的步骤由调度器无命中返回原 context（不抛错，条件触发语义）。

        参数：
            project_id: 所属项目（调度器/存储定位）。
            role_id: 目标角色。
            step_order: 当前步骤（1-11）。
            context: 透传上下文（含角色/知识库只读注入）。

        返回：merge_result 合并后的 context（含本步 Agent 输出）。

        异常：AppError（400 step_order 非法/步骤不存在；404 角色不存在；
              502 Agent 上游失败；500 未知内部错误）。
        """
        # 校验步骤存在（400），角色存在（404）
        self.get_step(step_order)
        self.role_store.get_role(project_id, role_id)
        # 委托调度器：命中绑定 step <= 当前 step 的 Agent 依序调用
        return self.scheduler.invoke_role_agents(project_id, role_id, step_order, context)

    def trigger_flow(
        self, project_id: str, role_id: str, context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """全流程顺序触发（架构设计文档 §5.2）。

        依次对 step_order 1..N 调用调度器，每步输出 merge 进下一步输入（上下文透传）。
        任一步 Agent 失败即中断并向上抛（AppError），已执行的步骤结果不落盘回滚。

        参数：
            project_id: 所属项目。
            role_id: 目标角色。
            context: 初始透传上下文。

        返回：全部步骤完成后最终合并 context。

        异常：AppError（同上，任一步失败即中断）。
        """
        self.role_store.get_role(project_id, role_id)
        merged: Dict[str, Any] = dict(context)
        for step in self.get_steps():
            order = step["step_order"]
            merged = self.scheduler.invoke_role_agents(project_id, role_id, order, merged)
        return merged
