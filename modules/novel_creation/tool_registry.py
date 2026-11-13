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

import hashlib
import json
import os
from typing import Any, Callable, Dict, Optional

import requests

from ..common.errors import bad_gateway, bad_request, conflict, not_found

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


# ---------- F9-T3 角色形象生成工具真实实现 ----------

def _avatar_project_dir(data_root: str, project_id: str) -> str:
    """头像缓存目录：data/avatars/<project>/。"""
    base = data_root if data_root else os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data"
    )
    d = os.path.join(base, "avatars", project_id)
    os.makedirs(d, exist_ok=True)
    return d


def _feature_signature(role: Dict[str, Any]) -> str:
    """构造确定性特征签名（F9-01/02：同特征组合 → 同签名 → 同头像）。

    取 role.visual_features 五维度 + 性别 + 姓名（姓名用于 prompt 描述，不入签名核心，
    但性别纳入特征以保证不同性别区分）。排序保证字段顺序无关。
    """
    vf = role.get("visual_features") or {}
    core = [
        str(role.get("gender") or ""),
        str(vf.get("hair_style") or ""),
        str(vf.get("hair_color") or ""),
        str(vf.get("face_features") or ""),
        str(vf.get("outfit_style") or ""),
        str(vf.get("expression") or ""),
    ]
    return json.dumps(core, ensure_ascii=False, separators=(",", ":"))


def _avatar_hash(sig: str) -> str:
    """特征签名 → sha256 前 16 位十六进制（确定性，幂等键）。"""
    return hashlib.sha256(sig.encode("utf-8")).hexdigest()[:16]


def _build_prompt(role: Dict[str, Any]) -> str:
    """由特征维度确定性构造文生图 prompt（中文描述，风格统一）。"""
    vf = role.get("visual_features") or {}
    name = role.get("name") or "角色"
    gender = role.get("gender") or ""
    parts = [f"一个{gender}角色" if gender else "一个角色", f"名叫{name}"]
    hair_style = vf.get("hair_style") or ""
    hair_color = vf.get("hair_color") or ""
    if hair_style and hair_color:
        parts.append(f"{hair_color}色{hair_style}")
    elif hair_color:
        parts.append(f"{hair_color}色头发")
    elif hair_style:
        parts.append(hair_style)
    face = vf.get("face_features") or ""
    if face:
        parts.append(face)
    outfit = vf.get("outfit_style") or ""
    if outfit:
        parts.append(f"{outfit}风格服饰")
    expr = vf.get("expression") or ""
    if expr:
        parts.append(f"表情{expr}")
    parts.append("二次元插画风，半身像，纯色背景，高清")
    return "，".join(parts)


def _gen_character_image_handler(params: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    """角色形象生成真实处理器（替换原 stub）。

    流程（F9-03：创建/修改后自动更新头像）：
      1. 从 context 取 role（role_link 注入）+ project_id。
      2. 计算特征签名 → sha256 → hash；目标路径 data/avatars/<project>/<hash>.png。
      3. 缓存命中：直接返回既有 avatar 路径（幂等，不重复调 AI）。
      4. 特征全空：返回占位（不调 AI），avatar 置空。
      5. 未命中：调 Coze 文生图 → 下载 → 落盘 → 写回 role.avatar。
      6. AI 失败：抛 bad_gateway（保留旧头像）。
    """
    role = context.get("role")
    if not role:
        raise bad_request("缺少角色上下文")
    project_id = context.get("project_id")
    if not project_id:
        raise bad_request("缺少 project_id")

    # 惰性默认依赖：测试可经 params 注入 mock；生产用默认单例路径
    role_store = params.get("_role_store") or context.get("role_store")
    coze_client = params.get("_coze_client") or context.get("coze_client")
    data_root = params.get("_data_root") or context.get("data_root")
    workflow_id = params.get("workflow_id") or context.get("image_workflow_id")

    # 配置读取 image_workflow_id（app 全局配置，可选）
    if not workflow_id and context.get("config_loader"):
        try:
            cfg = context["config_loader"].load_global_config()
            wf = (cfg.get("image_tools") or {}).get("character_workflow_id")
            if wf:
                workflow_id = wf
        except Exception:  # noqa: BLE001 - 配置读取失败仅降级
            workflow_id = None

    # 特征全空 → 占位灰底（不调 AI）
    sig = _feature_signature(role)
    vf = role.get("visual_features") or {}
    if not any(vf.get(k) for k in
               ("hair_style", "hair_color", "face_features", "outfit_style", "expression")):
        return {
            "tool": "gen_character_image",
            "status": "ok",
            "avatar": "",
            "cached": False,
            "placeholder": True,
            "message": "特征为空，返回占位头像（未调用 AI）",
            "role": {"id": role.get("id"), "name": role.get("name")},
        }

    avatar_hash = _avatar_hash(sig)
    avatars_dir = _avatar_project_dir(data_root or "", project_id)
    avatar_rel = f"/api/role-map/avatar/{avatar_hash}"
    local_path = os.path.join(avatars_dir, f"{avatar_hash}.png")

    # 缓存命中（幂等）
    if os.path.exists(local_path):
        # 确保 role.avatar 同步（可能此前未写回）
        try:
            if role_store:
                role_store.update_role(project_id, role["id"], avatar=avatar_rel)
        except Exception:  # noqa: BLE001
            pass
        return {
            "tool": "gen_character_image",
            "status": "ok",
            "avatar": avatar_rel,
            "cached": True,
            "role": {"id": role.get("id"), "name": role.get("name")},
        }

    if not workflow_id or not coze_client:
        raise bad_gateway("图像工作流未配置（缺 image_workflow_id 或 coze 客户端）")

    prompt = _build_prompt(role)
    gen = coze_client.generate_character_image(workflow_id, prompt)
    if not gen.get("success"):
        raise bad_gateway("AI 图像生成失败", detail=str(gen.get("error") or ""))

    image_url = gen.get("image_url", "")
    try:
        resp = requests.get(image_url, timeout=60)
        resp.raise_for_status()
        with open(local_path, "wb") as f:
            f.write(resp.content)
    except Exception as e:  # noqa: BLE001 - 下载失败同样走失败路径
        raise bad_gateway("图像下载失败", detail=str(e))

    # 写回 role.avatar（同步头像）
    try:
        if role_store:
            role_store.update_role(project_id, role["id"], avatar=avatar_rel)
    except Exception as e:  # noqa: BLE001 - 写回失败不阻断返回（头像文件已生成）
        return {
            "tool": "gen_character_image",
            "status": "ok",
            "avatar": avatar_rel,
            "cached": False,
            "sync_warning": str(e),
            "role": {"id": role.get("id"), "name": role.get("name")},
        }

    return {
        "tool": "gen_character_image",
        "status": "ok",
        "avatar": avatar_rel,
        "cached": False,
        "role": {"id": role.get("id"), "name": role.get("name")},
    }


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
        # F9-T3：gen_character_image 替换为真实形象生成处理器（其余保留 stub）
        if name == "gen_character_image":
            handler = _gen_character_image_handler
        else:
            handler = _stub_handler(name, desc)
        registry.register(ToolSpec(
            name, handler,
            role_link=role_link, long_task=long_task, description=desc,
        ))
    return registry
