# -*- coding: utf-8 -*-
"""工具注册中心（P3 工具接口 §4）。

对齐接口契约 §4 / §9 与实施路线图 §6.4「14 工具注册表」：
  - 注册中心统一调度工具，白名单校验；缺工具返回明确错误（404），无功能断点。
  - 工具声明 role_link 时读取角色上下文（只读注入，§4.2 工具-角色联动）。
  - 长耗时工具（gen_novel / gen_audiobook / run_70_workflow）声明 long_task，
    由路由层走任务队列（返回 task_id + status=queued），避免阻塞 SSE 主通道。

本阶段注册 11 个经 `/api/projects/<id>/tools/<tool>` 调用的工具；
其余 3 个映射到既有专用路由，不在此注册：
  new_project -> POST /api/projects（§2.1）
  open_project -> GET /api/projects/<id>
  open_settings -> GET /api/admin/config

处理器为占位 stub（返回基础结果 + 回显入参），真实业务逻辑（Coze 调用 /
章节生成 / 后台任务）由后续实现任务替换，本模块只固化「注册-派发-审计-联动」骨架。
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from ..common.errors import conflict, not_found

# 处理器签名：handler(params, context) -> result
Handler = Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]]


class ToolSpec:
    """工具元数据 + 处理器。"""

    def __init__(
        self,
        name: str,
        handler: Handler,
        role_link: bool = False,
        long_task: bool = False,
        description: str = "",
    ) -> None:
        self.name = name
        self.handler = handler
        self.role_link = role_link          # 是否读取角色上下文（§4.2）
        self.long_task = long_task          # 是否长耗时（走任务队列）
        self.description = description

    def to_meta(self) -> Dict[str, Any]:
        """导出工具元数据（供前端展示工具列表）。"""
        return {
            "name": self.name,
            "role_link": self.role_link,
            "long_task": self.long_task,
            "description": self.description,
        }


class ToolRegistry:
    """工具注册中心：注册 / 查找 / 派发 / 列表。"""

    def __init__(self) -> None:
        self._tools: Dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        """注册工具，重名抛 409。"""
        if spec.name in self._tools:
            raise conflict(f"工具已注册: {spec.name}")
        self._tools[spec.name] = spec

    def get(self, name: str) -> Optional[ToolSpec]:
        """按名查找工具，未注册返回 None。"""
        return self._tools.get(name)

    def list_tools(self) -> list:
        """列出全部工具元数据。"""
        return [spec.to_meta() for spec in self._tools.values()]

    def invoke(
        self, name: str, params: Dict[str, Any], context: Dict[str, Any],
    ) -> Dict[str, Any]:
        """派发工具。未注册抛 404（接口契约 §4.1 错误码：404 工具未注册）。"""
        spec = self._tools.get(name)
        if spec is None:
            raise not_found(f"工具未注册: {name}")
        return spec.handler(params or {}, context or {})


def _stub_handler(tool_name: str, description: str) -> Handler:
    """占位处理器：返回基础结果 + 回显入参；role_link 时透出注入的角色摘要。"""

    def handler(params: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
        """占位处理器主体：回显入参，透出注入角色摘要。"""
        result: Dict[str, Any] = {
            "tool": tool_name,
            "status": "ok",
            "description": description,
            "echo": params,
        }
        role = context.get("role")
        if role:
            result["role"] = {
                "id": role.get("id"),
                "name": role.get("name"),
            }
        return result

    return handler


def create_default_registry() -> ToolRegistry:
    """注册 11 个经 /tools/<tool> 调用的工具（实施路线图 §6.4 注册表）。"""
    registry = ToolRegistry()
    # (name, role_link, long_task, description) —— 与 §9 映射表一致
    specs = [
        ("gen_outline", True, False, "生成小说大纲（多角色协同）"),
        ("gen_chapter", True, False, "生成章节内容（按情节发展步骤调用角色 Agent）"),
        ("gen_character_image", True, False, "生成角色图像（按外貌特征步骤）"),
        ("gen_world_map", False, False, "生成世界地图"),
        ("emotion_analysis", True, False, "情感分析（按情感状态步骤）"),
        ("consistency_check", True, False, "一致性检查（读取角色上下文）"),
        ("create_version", False, False, "创建版本"),
        ("gen_novel", True, True, "生成长篇小说（后台任务）"),
        ("gen_audiobook", False, True, "生成有声书（后台任务）"),
        ("run_70_workflow", True, True, "运行 70 步工作流（后台任务）"),
        ("export_novel", False, False, "导出小说"),
    ]
    for name, role_link, long_task, desc in specs:
        registry.register(ToolSpec(
            name, _stub_handler(name, desc),
            role_link=role_link, long_task=long_task, description=desc,
        ))
    return registry
