"""
StoryForgeAI - 小说AI写作软件
让创作者方便地展示 Coze 智能体/工作流，让体验者直接在线体验
"""

import os
import sys
import json
import uuid
import threading
import hmac
import re
import time
import base64
import requests

from flask import Flask, render_template, jsonify, request, Response, stream_with_context
from flask_cors import CORS
from functools import wraps
from werkzeug.security import check_password_hash
from werkzeug.exceptions import HTTPException

# 确保项目根目录在路径中
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

from config_loader import ConfigLoader
from work_manager import WorkManager
from coze_client import CozeClient
from modules.common.storage import atomic_write_json, read_json

# ==================== 初始化 ====================

app = Flask(__name__)
CORS(app)

# 全局错误处理，防止返回 HTML 500 页面
# 识别业务异常 AppError -> 接口契约格式 {"code": <非0>, "data": null, "message": "..."} + 对应状态码
from modules.common.errors import AppError as _AppError

@app.errorhandler(Exception)
def handle_error(e):
    """全局异常处理：业务异常按契约返回，HTTP 异常保留状态码，其余统一 500。"""
    app.logger.exception(e)
    if isinstance(e, _AppError):
        # 业务异常：按契约错误格式返回对应状态码
        return respond(e.code, None, e.message)
    # 非业务异常：HTTPException（如 404 路由）保留其状态码，其余统一 500
    if isinstance(e, HTTPException):
        return respond(e.code, None, e.description)
    return respond(500, None, "内部错误")

DATA_DIR = os.path.join(BASE_DIR, "data")

# 初始化各模块
config_loader = ConfigLoader(DATA_DIR)
work_manager = WorkManager(DATA_DIR)
coze_client = CozeClient()

# 统一响应契约辅助函数
def respond(code, data=None, message="ok"):
    """统一响应契约：{"code": <int>, "data": <any>, "message": "<可读>"}

    HTTP 状态码约定：业务成功（code=0）返回 HTTP 200；业务/HTTP 错误
    （code!=0）返回对应状态码。避免 HTTP 0 导致前端 fetch resp.ok=false。
    """
    http_status = 200 if code == 0 else code
    return jsonify({"code": code, "data": data, "message": message}), http_status


# ==================== 会话存储（C-001 过期 + C-004 持久化） ====================
# 会话结构：_admin_sessions[token] = {"role": <"admin" | "work_<id>">, "exp": <unix 秒>}
# 满足安全基线：C-001 会话过期（require_admin 校验 TTL）、C-004 持久化（写 data/sessions.json，
# 服务重启不失效）。会话文件含 token（敏感），位于 data/（.gitignore 保护，不提交 Git）。

SESSION_FILE = os.path.join(DATA_DIR, "sessions.json")
SESSION_TTL = 24 * 3600  # 管理员会话有效期 24 小时
_session_lock = threading.Lock()

# 管理员会话存储（value 为 {"role": str, "exp": float}）
_admin_sessions = {}


def _load_sessions():
    """启动时从 data/sessions.json 加载会话（C-004 持久化恢复）。"""
    global _admin_sessions
    data = read_json(SESSION_FILE, default={}) or {}
    _admin_sessions = {
        k: v for k, v in data.items()
        if isinstance(v, dict) and "exp" in v
        and float(v.get("exp", 0)) > time.time()
    }


def _save_sessions():
    """将有效会话持久化到 data/sessions.json（含过期清理）。"""
    now = time.time()
    valid = {k: v for k, v in _admin_sessions.items()
             if isinstance(v, dict) and float(v.get("exp", 0)) > now}
    with _session_lock:
        _admin_sessions.clear()
        _admin_sessions.update(valid)
    try:
        atomic_write_json(SESSION_FILE, _admin_sessions)
    except OSError:
        # 持久化失败不影响请求（会话仍有效），仅记录
        app.logger.warning("[会话] 持久化失败: %s", SESSION_FILE)


def _set_session(token, role, ttl=SESSION_TTL):
    """写入会话（带过期时间）并持久化。"""
    _admin_sessions[token] = {"role": role, "exp": time.time() + ttl}
    _save_sessions()


def _get_session_role(token):
    """读取会话角色，过期或不存在返回 None（C-001 过期校验）。"""
    entry = _admin_sessions.get(token)
    if not isinstance(entry, dict):
        return None
    if float(entry.get("exp", 0)) <= time.time():
        _admin_sessions.pop(token, None)
        _save_sessions()
        return None
    return entry.get("role")


def _sanitize_error(exc=None, default="请求失败，请稍后重试", upstream_msg=None):
    """脱敏：返回通用错误提示，真实异常/上游原文仅记入日志，不透传前端（F3-R4）。"""
    if exc is not None:
        app.logger.exception("F3 上游异常: %s", exc)
    if upstream_msg is not None:
        app.logger.warning("F3 上游返回错误原文: %s", upstream_msg)
        msg = str(upstream_msg)
        if msg and "can't convert" in msg:
            return "参数类型不匹配，请检查参数配置是否与 Coze 工作流开始节点的参数类型一致"
        # 作品发布状态属用户可操作的配置信息（非敏感），按 can't convert 同思路给出可执行指引
        if "has not been published" in msg or "not been published to the channel" in msg:
            return "该作品尚未发布到 API 渠道，请先在 Coze 后台将其发布（Agent As API）后再试"
    return default


# AI 生成参数异步任务存储
_gen_tasks = {}


# ==================== 装饰器 ====================

def require_admin(f):
    """管理员验证装饰器（从 _admin_sessions 校验 token，C-001 会话过期校验）"""
    @wraps(f)
    def decorated(*args, **kwargs):
        """校验管理员会话 token，未授权/过期返回 401。"""
        token = request.headers.get("X-Admin-Token", "") or request.cookies.get("admin_token", "")
        if not token or _get_session_role(token) != "admin":
            return respond(401, None, "未授权，请先登录管理员")
        return f(*args, **kwargs)
    return decorated


def require_work_access(f):
    """作品访问验证装饰器"""
    @wraps(f)
    def decorated(work_id, *args, **kwargs):
        """校验作品公开/访问码，通过后注入 request.work_config。"""
        work = work_manager.get_work(work_id)
        if work is None:
            return respond(404, None, "作品不存在")

        # 检查是否公开
        if not work.get("is_public", True):
            return respond(403, None, "该作品未公开")

        # 检查访问码
        access_code = work.get("access_code", "")
        if access_code:
            token = request.headers.get("X-Access-Token", "")
            session_key = f"work_{work_id}"
            if not token or _get_session_role(token) != session_key:
                return respond(403, None, "需要验证访问码")

        request.work_config = work
        return f(work_id, *args, **kwargs)
    return decorated


# ==================== 页面路由 ====================

@app.route("/")
def index():
    """渲染单页应用"""
    return render_template("index.html")


# ==================== 创作者 API ====================

@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    """管理员登录"""
    data = request.get_json(force=True) or {}
    password = data.get("password", "")

    config = config_loader.load_global_config()
    stored = config.get("admin_password", "")

    # 兼容现有明文密码：若存储值非 werkzeug 哈希格式，回退明文比较
    if isinstance(stored, str) and (stored.startswith("pbkdf2:") or stored.startswith("scrypt:")):
        valid = check_password_hash(stored, password)
    else:
        valid = hmac.compare_digest(str(stored), str(password))

    if not valid:
        return respond(403, None, "管理密码错误")

    # 生成会话 token（C-004 持久化 + C-001 过期）
    token = str(uuid.uuid4())
    _set_session(token, "admin")
    return respond(0, {"token": token}, "ok")


def _config_view(config):
    """返回配置的脱敏视图（剥离 api_key 等敏感字段）"""
    result = {
        "version": config.get("version", "2.0.0"),
        "site_name": config.get("site_name", "StoryForgeAI"),
        "site_description": config.get("site_description", "AI 作品展示平台"),
        "theme": config.get("theme", "light"),
        "llm_config": {}
    }
    llm = config.get("llm_config", {}) or {}
    # 仅保留非敏感字段
    for key in ("base_url", "model"):
        if key in llm:
            result["llm_config"][key] = llm[key]
    return result


@app.route("/api/admin/config", methods=["GET"])
@require_admin
def get_admin_config():
    """获取全局配置（脱敏，不含 api_key 等敏感字段）"""
    config = config_loader.load_global_config()
    return respond(0, _config_view(config), "ok")


@app.route("/api/admin/config", methods=["PUT"])
@require_admin
def update_admin_config():
    """更新全局配置（返回脱敏视图）"""
    data = request.get_json(force=True) or {}
    allowed_fields = ["site_name", "site_description", "theme", "admin_password", "llm_config"]
    updates = {k: v for k, v in data.items() if k in allowed_fields}
    config = config_loader.update_global_config(updates)
    return respond(0, _config_view(config), "ok")


@app.route("/api/admin/coze/test", methods=["POST"])
@require_admin
def coze_test():
    """测试 Coze PAT 连接"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    workspace_id = data.get("workspace_id", "")
    if not pat_token:
        return respond(400, None, "请输入 PAT Token")

    coze_client.pat_token = pat_token
    result = coze_client.test_connection(workspace_id)
    return respond(0, result, "ok")


@app.route("/api/admin/coze/bots", methods=["POST"])
@require_admin
def coze_bot_list():
    """获取 Coze 应用列表（智能体+工作流+应用）"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    workspace_id = data.get("workspace_id", "")
    if not pat_token:
        return respond(400, None, "请输入 PAT Token")

    coze_client.pat_token = pat_token
    result = coze_client.get_all_resources(workspace_id)
    return respond(0, result, "ok")


@app.route("/api/admin/works/import", methods=["POST"])
@require_admin
def import_works():
    """导入作品（单个或批量，支持智能体和工作流）"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    bot_ids = data.get("bot_ids", [])
    access_code = data.get("access_code", "")
    workspace_id = data.get("workspace_id", "")

    if not pat_token:
        return respond(400, None, "请输入 PAT Token")
    if not bot_ids:
        return respond(400, None, "请选择要导入的作品")

    coze_client.pat_token = pat_token
    results = []

    for bid in bot_ids:
        source_type = bid.get("_source_type", "bot") if isinstance(bid, dict) else "bot"
        actual_id = bid.get("id", bid) if isinstance(bid, dict) else bid

        if source_type == "workflow":
            # 导入工作流：进入独立工作流管理模块的全局未分类池
            # Coze 工作流列表项可能同时带 id 与 workflow_id，优先取 workflow_id
            actual_id = (bid.get("workflow_id") or bid.get("id", bid)
                         if isinstance(bid, dict) else bid)
            wf_info = {
                "id": actual_id,
                "name": bid.get("name", ""),
                "description": bid.get("description", ""),
                "icon_url": bid.get("icon_url", ""),
            }
            wf = _workflow_service.import_coze_workflow(wf_info, workspace_id)
            results.append({
                "success": True,
                "workflow_id": wf["id"],
                "name": wf["name"],
                "type": "workflow",
            })
        else:
            # 导入智能体
            result = coze_client.get_bot_info(actual_id, is_published=True)
            if not result.get("success"):
                result = coze_client.get_bot_info(actual_id, is_published=False)
            if result.get("success"):
                agent = _agent_service.import_coze_agent(result["data"], workspace_id)
                results.append({
                    "success": True,
                    "agent_id": agent["id"],
                    "name": agent["name"],
                    "type": "bot",
                })
            else:
                results.append({
                    "success": False,
                    "id": actual_id,
                    "error": result.get("error", "导入失败"),
                })

    success_count = sum(1 for r in results if r.get("success"))
    return respond(0, {
        "success": True,
        "total": len(bot_ids),
        "imported": success_count,
        "results": results
    }, "ok")


@app.route("/api/admin/coze/datasets", methods=["POST"])
@require_admin
def coze_dataset_list():
    """获取 Coze 知识库列表"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    if not pat_token:
        return respond(400, None, "请输入 PAT Token")

    coze_client.pat_token = pat_token
    result = coze_client.get_dataset_list()
    return respond(0, result, "ok")


@app.route("/api/admin/coze/workflows", methods=["POST"])
@require_admin
def coze_workflow_list():
    """获取 Coze 工作流列表"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    workspace_id = data.get("workspace_id", "")
    if not pat_token:
        return respond(400, None, "请输入 PAT Token")

    coze_client.pat_token = pat_token
    result = coze_client.get_workflow_list(workspace_id)
    return respond(0, result, "ok")


@app.route("/api/admin/works/import-dataset", methods=["POST"])
@require_admin
def import_dataset():
    """导入知识库"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    dataset_id = data.get("dataset_id", "")
    access_code = data.get("access_code", "")

    if not pat_token:
        return respond(400, None, "请输入 PAT Token")
    if not dataset_id:
        return respond(400, None, "请指定知识库 ID")

    coze_client.pat_token = pat_token

    # 先获取知识库列表找到对应的知识库信息
    list_result = coze_client.get_dataset_list()
    if not list_result.get("success"):
        return respond(400, None, list_result.get("error", "获取知识库列表失败"))

    dataset_info = None
    for item in list_result.get("items", []):
        if str(item.get("id", "")) == str(dataset_id):
            dataset_info = item
            break

    if not dataset_info:
        return respond(404, None, "未找到指定的知识库")

    work = work_manager.import_dataset(dataset_info, pat_token, access_code)
    return respond(0, {"success": True, "work_id": work["id"], "name": work["name"]}, "ok")


@app.route("/api/admin/works/import-workflow", methods=["POST"])
@require_admin
def import_workflow():
    """导入工作流"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    workflow_id = data.get("workflow_id", "")
    workspace_id = data.get("workspace_id", "")
    access_code = data.get("access_code", "")

    if not pat_token:
        return respond(400, None, "请输入 PAT Token")
    if not workflow_id:
        return respond(400, None, "请指定工作流 ID")

    coze_client.pat_token = pat_token

    # 先获取工作流列表找到对应的工作流信息
    list_result = coze_client.get_workflow_list(workspace_id)
    if not list_result.get("success"):
        return respond(400, None, list_result.get("error", "获取工作流列表失败"))

    workflow_info = None
    for item in list_result.get("items", []):
        if str(item.get("workflow_id", item.get("id", ""))) == str(workflow_id):
            workflow_info = item
            break

    if not workflow_info:
        return respond(404, None, "未找到指定的工作流")

    work = work_manager.import_workflow(workflow_info, pat_token, workspace_id, access_code)
    return respond(0, {"success": True, "work_id": work["id"], "name": work["name"]}, "ok")


@app.route("/api/admin/works", methods=["GET"])
@require_admin
def list_admin_works():
    """获取所有已导入作品（脱敏，不含敏感字段）"""
    works = work_manager.list_works()
    public_works = []
    for work in works:
        public = work_manager.get_work_public(work["id"])
        if public is not None:
            public_works.append(public)
    return respond(0, {"works": public_works}, "ok")


@app.route("/api/admin/works/<work_id>", methods=["PUT"])
@require_admin
def update_work(work_id):
    """更新作品配置"""
    data = request.get_json(force=True) or {}
    allowed_fields = [
        "name", "description", "access_code", "is_public",
        "interaction_type", "prologue", "suggested_questions",
        "parameters", "system_prompt", "project_id"
    ]
    updates = {k: v for k, v in data.items() if k in allowed_fields}

    work = work_manager.update_work(work_id, updates)
    if work is None:
        return respond(404, None, "作品不存在")
    return respond(0, work_manager.get_work_public(work_id), "ok")


@app.route("/api/admin/works/<work_id>", methods=["DELETE"])
@require_admin
def delete_work(work_id):
    """删除作品"""
    success = work_manager.delete_work(work_id)
    if not success:
        return respond(404, None, "作品不存在")
    return respond(0, {"success": True}, "ok")


@app.route("/api/admin/works/<work_id>/llm-config", methods=["PUT"])
@require_admin
def update_llm_config(work_id):
    """更新工作流的 LLM 配置"""
    work = work_manager.get_work(work_id)
    if work is None:
        return respond(404, None, "作品不存在")
    data = request.get_json(force=True) or {}
    llm_config = {
        "base_url": data.get("base_url", ""),
        "api_key": data.get("api_key", ""),
        "model": data.get("model", "")
    }
    work_manager.update_work(work_id, {"llm_config": llm_config})
    return respond(0, {"success": True}, "ok")


@app.route("/api/admin/works/<work_id>/generate-params", methods=["POST"])
@require_admin
def generate_params_from_image(work_id):
    """上传图片让 LLM 生成参数结构（异步）"""
    work = work_manager.get_work(work_id)
    if work is None:
        return respond(404, None, "作品不存在")

    llm_config = work.get("llm_config", {})
    global_config = config_loader.load_global_config()
    global_llm = global_config.get("llm_config", {})
    base_url = llm_config.get("base_url") or global_llm.get("base_url", "")
    api_key = llm_config.get("api_key") or global_llm.get("api_key", "")
    model = llm_config.get("model") or global_llm.get("model", "")

    if not base_url or not api_key or not model:
        return respond(400, None, "请先配置大模型（base_url、api_key、model）")

    # 获取上传的图片
    if "image" not in request.files:
        return respond(400, None, "请上传图片")

    image_file = request.files["image"]
    # 安全校验：图片扩展名白名单 + 大小上限（10MB）
    image_ext = os.path.splitext(image_file.filename or "")[1].lower()
    image_allowed_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
    if image_ext not in image_allowed_exts:
        return respond(400, None, f"不支持的图片格式: {image_ext or '无扩展名'}")
    image_max_bytes = 10 * 1024 * 1024
    image_file.stream.seek(0, os.SEEK_END)
    if image_file.stream.tell() > image_max_bytes:
        return respond(400, None, "图片大小不能超过 10MB")
    image_file.stream.seek(0)
    image_data = image_file.read()
    image_base64 = base64.b64encode(image_data).decode("utf-8")

    # 获取生成类型：input 只生成输入参数，output 只生成输出参数，默认全部
    gen_group = request.form.get("gen_group", "")

    # 创建异步任务
    task_id = str(uuid.uuid4())[:8]
    _gen_tasks[task_id] = {"status": "running", "result": None, "error": None}

    def run_generation():
        """后台线程：调用 LLM 从截图提取参数结构，结果写回 _gen_tasks。"""
        try:
            # 检查是否已取消
            if _gen_tasks.get(task_id, {}).get("status") == "cancelled":
                return

            base_url_clean = base_url.rstrip("/")
            # 如果 base_url 已以 /v1 结尾，不再追加
            if base_url_clean.endswith("/v1"):
                url = f"{base_url_clean}/chat/completions"
            else:
                url = f"{base_url_clean}/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            # 根据 gen_group 构建不同的 prompt
            if gen_group == "input":
                prompt = """请分析这张工作流截图，只提取工作流的输入参数（开始节点的输入）。

请严格按照以下 JSON 格式返回（不要包含其他文字）：
{
  "parameters": [
    {
      "name": "参数英文名",
      "label": "参数中文名",
      "type": "String",
      "required": true,
      "default": "",
      "placeholder": "请输入...",
      "item_type": "",
      "children": []
    }
  ]
}

参数类型只能是以下 8 种之一：String, Integer, Number, Boolean, Time, Object, Array, File
- Object 类型可能有 children 子属性
- Array 类型需要指定 item_type（元素类型）
- File 类型表示文件上传
- 只提取输入参数，不要包含输出参数"""
            elif gen_group == "output":
                prompt = """请分析这张工作流截图，只提取工作流的输出参数（结束节点的输出）。

请严格按照以下 JSON 格式返回（不要包含其他文字）：
{
  "parameters": [
    {
      "name": "参数英文名",
      "label": "参数中文名",
      "type": "String",
      "required": false,
      "default": "",
      "placeholder": "",
      "item_type": "",
      "children": []
    }
  ]
}

参数类型只能是以下 8 种之一：String, Integer, Number, Boolean, Time, Object, Array, File
- Object 类型可能有 children 子属性
- Array 类型需要指定 item_type（元素类型）
- 只提取输出参数，不要包含输入参数"""
            else:
                prompt = """请分析这张工作流截图，提取出工作流的输入参数和输出参数。

请严格按照以下 JSON 格式返回（不要包含其他文字）：
{
  "input_parameters": [
    {
      "name": "参数英文名",
      "label": "参数中文名",
      "type": "String",
      "required": true,
      "default": "",
      "placeholder": "请输入...",
      "item_type": "",
      "children": []
    }
  ],
  "output_parameters": [
    {
      "name": "参数英文名",
      "label": "参数中文名",
      "type": "String",
      "required": false,
      "default": "",
      "placeholder": "",
      "item_type": "",
      "children": []
    }
  ]
}

参数类型只能是以下 8 种之一：String, Integer, Number, Boolean, Time, Object, Array, File
- Object 类型可能有 children 子属性
- Array 类型需要指定 item_type（元素类型）
- File 类型表示文件上传
- 请仔细区分哪些是输入参数（用户需要填写的）哪些是输出参数（工作流返回的结果）"""

            body = {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{image_base64}"},
                            }
                        ]
                    }
                ],
                "temperature": 0.3,
                "max_tokens": 4096
            }

            resp = requests.post(url, headers=headers, json=body, timeout=60)
            resp.raise_for_status()
            result = resp.json()

            # 检查是否已取消
            if _gen_tasks.get(task_id, {}).get("status") == "cancelled":
                return

            content = result["choices"][0]["message"]["content"]

            # 提取 JSON
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                params_data = json.loads(json_match.group())
                input_params = params_data.get("input_parameters", [])
                output_params = params_data.get("output_parameters", [])
                output_desc = params_data.get("output_description", "")

                # 兼容处理：如果 LLM 没有返回 input_parameters/output_parameters，
                # 尝试从 parameters 中提取
                if not input_params and not output_params:
                    all_params = params_data.get("parameters", [])
                    if all_params:
                        # 尝试根据已有的分组信息拆分
                        input_params = [p for p in all_params if p.get("group") == "input"]
                        output_params = [p for p in all_params if p.get("group") == "output"]
                        # 如果都没有 group，根据 gen_group 决定归属
                        ungrouped = [p for p in all_params if not p.get("group")]
                        if gen_group == "output":
                            output_params.extend(ungrouped)
                        else:
                            input_params.extend(ungrouped)

                # 给每个参数添加 group 字段并合并，移除 Coze 不需要的 options 字段
                for p in input_params:
                    p["group"] = "input"
                    p.pop("options", None)
                for p in output_params:
                    p["group"] = "output"
                    p.pop("options", None)
                parameters = input_params + output_params

                # 如果是单独生成输入或输出，只返回对应参数
                if gen_group == "input":
                    parameters = input_params
                elif gen_group == "output":
                    parameters = output_params

                # 自动保存到作品配置（合并到现有参数中）
                existing_params = work_manager.get_work(work_id).get("parameters", [])
                if gen_group == "input":
                    # 只替换输入参数，保留输出参数
                    existing_output = [p for p in existing_params if p.get("group") == "output"]
                    all_params = parameters + existing_output
                elif gen_group == "output":
                    # 只替换输出参数，保留输入参数
                    existing_input = [p for p in existing_params if p.get("group") != "output"]
                    all_params = existing_input + parameters
                else:
                    all_params = parameters

                work_manager.update_work(work_id, {"parameters": all_params})

                _gen_tasks[task_id] = {
                    "status": "done",
                    "result": {"parameters": parameters},
                    "error": None,
                }
            else:
                _gen_tasks[task_id] = {
                    "status": "error",
                    "error": "无法从 LLM 响应中提取参数结构",
                    "result": None,
                }

        except Exception as e:
            if _gen_tasks.get(task_id, {}).get("status") != "cancelled":
                _gen_tasks[task_id] = {"status": "error", "error": str(e), "result": None}

    thread = threading.Thread(target=run_generation, daemon=True)
    thread.start()

    return respond(0, {"success": True, "task_id": task_id}, "ok")


@app.route("/api/admin/works/<work_id>/generate-params/status", methods=["GET"])
@require_admin
def get_gen_params_status(work_id):
    """查询生成任务状态"""
    task_id = request.args.get("task_id", "")
    if not task_id or task_id not in _gen_tasks:
        return respond(404, None, "任务不存在")

    task = _gen_tasks[task_id]
    result = {"status": task["status"]}
    if task["status"] == "done":
        result["result"] = task["result"]
    elif task["status"] == "error":
        result["error"] = task["error"]

    # 如果已完成，清理任务
    if task["status"] in ("done", "error"):
        del _gen_tasks[task_id]

    return respond(0, result, "ok")


@app.route("/api/admin/works/<work_id>/generate-params/cancel", methods=["POST"])
@require_admin
def cancel_gen_params(work_id):
    """取消生成任务（标记为取消，线程中检查）"""
    task_id = (request.get_json(force=True) or {}).get("task_id", "")
    if task_id and task_id in _gen_tasks:
        _gen_tasks[task_id]["status"] = "cancelled"
        return respond(0, {"success": True}, "ok")
    return respond(404, None, "任务不存在")


@app.route("/api/admin/works/<work_id>/refresh", methods=["POST"])
@require_admin
def refresh_work(work_id):
    """刷新作品信息（重新从 Coze 拉取，更新原作品而不是创建新作品）"""
    work = work_manager.get_work(work_id)
    if work is None:
        return respond(404, None, "作品不存在")

    coze_meta = work.get("coze_meta", {})
    work_type = coze_meta.get("type", "bot")

    if work_type == "workflow":
        # 工作流刷新：重新从 Coze 获取工作流信息
        pat_token = work.get("pat_token", "")
        workflow_id = work.get("coze_workflow_id", "") or coze_meta.get("workflow_id", "")
        if not pat_token or not workflow_id:
            return respond(400, None, "工作流缺少 PAT Token 或 Workflow ID")

        # TODO: Coze 没有获取单个工作流详情的 API，暂时直接返回成功
        return respond(0, {"success": True, "message": "工作流信息已是最新的"}, "ok")

    # 智能体刷新（原有逻辑）
    pat_token = work.get("pat_token", "")
    bot_id = work.get("coze_bot_id", "")
    if not pat_token or not bot_id:
        return respond(400, None, "作品缺少 PAT Token 或 Bot ID")

    coze_client.pat_token = pat_token
    result = coze_client.get_bot_info(bot_id, is_published=True)
    if not result.get("success"):
        result = coze_client.get_bot_info(bot_id, is_published=False)

    if not result.get("success"):
        return respond(400, None, result.get("error", "刷新失败"))

    bot_info = result["data"]

    # 保留本地的访问码和公开设置
    access_code = work.get("access_code", "")
    is_public = work.get("is_public", True)

    # 构建更新字段（和 import_from_coze 相同的逻辑，但不创建新作品）
    prompt_info = bot_info.get("prompt_info", {})
    onboarding = bot_info.get("onboarding_info", {})
    model_info = bot_info.get("model_info", {})
    variables = bot_info.get("variables", [])
    shortcut_commands = bot_info.get("shortcut_commands", [])

    parameters = []
    for var in variables:
        if not var.get("enable", True):
            continue
        parameters.append({
            "name": var.get("keyword", ""),
            "label": var.get("description", var.get("keyword", "")),
            "type": "text",
            "required": False,
            "default": var.get("default_value", ""),
            "placeholder": var.get("description", ""),
            "options": [],
            "coze_variable": True
        })

    for sc in shortcut_commands:
        for comp in sc.get("components", []):
            comp_name = comp.get("name", "")
            if comp_name and not any(p["name"] == comp_name for p in parameters):
                parameters.append({
                    "name": comp_name,
                    "label": comp.get("description", comp_name),
                    "type": "text",
                    "required": not comp.get("is_hide", False),
                    "default": comp.get("default_value", ""),
                    "placeholder": comp.get("description", ""),
                    "options": [],
                    "coze_variable": False
                })

    has_params = len(parameters) > 0
    system_prompt = prompt_info.get("prompt", "")
    if has_params and system_prompt:
        interaction_type = "mixed"
    elif has_params:
        interaction_type = "form"
    else:
        interaction_type = "chat"

    response_format = model_info.get("response_format", "text")

    updates = {
        "name": bot_info.get("name", work.get("name", "")),
        "description": bot_info.get("description", "") or onboarding.get("prologue", ""),
        "icon_url": bot_info.get("icon_url", ""),
        "interaction_type": interaction_type,
        "system_prompt": system_prompt,
        "prologue": onboarding.get("prologue", ""),
        "suggested_questions": onboarding.get("suggested_questions", []),
        "parameters": parameters,
        "shortcut_commands": shortcut_commands,
        "plugins": bot_info.get("plugin_info_list", []),
        "workflows": bot_info.get("workflow_info_list", []),
        "model_name": model_info.get("model_name", ""),
        "response_format": (
            response_format if response_format in ["text", "json", "markdown"] else "text"
        ),
        "is_public": is_public
    }

    updated = work_manager.update_work(work_id, updates)
    return respond(0, {"success": True, "work": work_manager.get_work_public(work_id)}, "ok")


# ==================== 体验者 API ====================

@app.route("/api/works", methods=["GET"])
def list_public_works():
    """获取公开作品列表（不含敏感信息）"""
    works = work_manager.list_works()
    public_works = []
    for work in works:
        if not work.get("is_public", True):
            continue
        public_works.append({
            "id": work["id"],
            "name": work.get("name", ""),
            "description": work.get("description", ""),
            "icon_url": work.get("icon_url", ""),
            "interaction_type": work.get("interaction_type", "chat"),
            "has_access_code": bool(work.get("access_code", "")),
            "model_name": work.get("model_name", ""),
            "created_at": work.get("created_at", ""),
            "updated_at": work.get("updated_at", ""),
            "coze_meta": work.get("coze_meta", {})
        })
    return respond(0, {"works": public_works}, "ok")


@app.route("/api/works/<work_id>", methods=["GET"])
def get_public_work(work_id):
    """获取作品公开信息"""
    work = work_manager.get_work_public(work_id)
    if work is None:
        return respond(404, None, "作品不存在")
    if not work.get("is_public", True):
        return respond(403, None, "该作品未公开")
    return respond(0, work, "ok")


@app.route("/api/works/<work_id>/verify", methods=["POST"])
def verify_work_access(work_id):
    """验证访问码"""
    work = work_manager.get_work(work_id)
    if work is None:
        return respond(404, None, "作品不存在")

    data = request.get_json(force=True) or {}
    code = data.get("access_code", "")

    if work_manager.verify_access_code(work_id, code):
        # 生成访问 token（C-004 持久化 + C-001 过期）
        token = str(uuid.uuid4())
        _set_session(token, f"work_{work_id}")
        return respond(0, {"success": True, "token": token}, "ok")
    else:
        return respond(403, None, "访问码错误")


@app.route("/api/works/<work_id>/chat", methods=["POST"])
@require_work_access
def chat_work(work_id):
    """发送对话消息（SSE 流式响应）"""
    work = request.work_config
    data = request.get_json(force=True) or {}

    user_message = data.get("message", "")
    conversation_id = data.get("conversation_id", "")
    user_id = data.get("user_id", "")
    parameters = data.get("parameters", {})

    if not user_message and not parameters:
        return respond(400, None, "请输入消息或填写参数")

    # 构建 Coze 对话请求
    chat_body = _build_coze_chat_request(work, user_message, conversation_id, parameters, user_id)

    pat_token = work.get("pat_token", "")
    coze_client.pat_token = pat_token

    def generate():
        """SSE 生成器：转发 Coze 对话流为 delta/done/error 事件。"""
        resp = None
        try:
            url = f"{coze_client.COZE_API_BASE}/v3/chat"
            headers = {
                "Authorization": f"Bearer {pat_token}",
                "Content-Type": "application/json"
            }

            # Coze 官方契约：conversation_id 是 Query 参数，放在 Body 会被忽略并新建会话。
            chat_params = {"conversation_id": conversation_id} if conversation_id else None
            resp = requests.post(
                url, headers=headers, json=chat_body, params=chat_params,
                stream=True, timeout=120
            )
            resp.encoding = "utf-8"
            resp.raise_for_status()

            # Coze 业务失败（如 bot 未发布到 Agent As API，错误码 4015）时返回
            # HTTP200 + JSON 错误体而非 SSE 流；iter_lines 解析不到 data:/event: 前缀
            # 会静默吞掉错误，导致前端只见 done 永远转圈。显式检测非 SSE 并透出上游错误。
            # getattr 防御：测试 mock 等无 headers 的对象跳过检查，走正常 SSE 解析。
            resp_headers = getattr(resp, "headers", None)
            if (resp_headers is not None
                    and "text/event-stream" not in resp_headers.get("Content-Type", "")):
                try:
                    err_obj = resp.json()
                    upstream_msg = err_obj.get("msg") or err_obj.get("message") or resp.text[:200]
                except (ValueError, AttributeError):
                    upstream_msg = resp.text[:200]
                yield "data: " + json.dumps(
                    {"error": _sanitize_error(default="对话失败，请稍后重试", upstream_msg=upstream_msg)},
                    ensure_ascii=False
                ) + "\n\n"
                return

            current_event = ""

            for line in resp.iter_lines():
                if not line:
                    continue

                try:
                    line_str = line.decode("utf-8")
                except (UnicodeDecodeError, AttributeError):
                    continue

                if line_str.startswith("event:"):
                    current_event = line_str[6:].strip()
                    continue

                if line_str.startswith("data:"):
                    data_str = line_str[5:].strip()
                    if not data_str:
                        continue

                    try:
                        event_data = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue

                    # Coze SSE 格式：顶层有 event 和 data 字段
                    # 但有时 data 字段直接就是内容对象
                    if "data" in event_data and isinstance(event_data["data"], dict):
                        msg_data = event_data["data"]
                    else:
                        msg_data = event_data

                    msg_type = msg_data.get("type", "")

                    # 处理不同事件类型（F3-R3：统一 SSE 事件契约 delta/done/error）
                    if current_event == "conversation.message.delta" or msg_type == "answer":
                        content = msg_data.get("content", "")
                        if content:
                            yield "data: " + json.dumps(
                                {"delta": content}, ensure_ascii=False
                            ) + "\n\n"
                    elif current_event == "conversation.chat.completed":
                        conv_id = msg_data.get("conversation_id", "") or msg_data.get("id", "")
                        yield "data: " + json.dumps(
                            {"done": True, "conversation_id": conv_id},
                            ensure_ascii=False,
                        ) + "\n\n"
                    elif current_event == "conversation.chat.failed":
                        upstream_msg = msg_data.get("msg") or msg_data.get("error_msg")
                        yield "data: " + json.dumps(
                            {"error": _sanitize_error(
                                default="对话失败，请稍后重试", upstream_msg=upstream_msg)},
                            ensure_ascii=False
                        ) + "\n\n"
                    elif current_event == "error":
                        upstream_msg = msg_data.get("msg")
                        yield "data: " + json.dumps(
                            {"error": _sanitize_error(
                                default="对话失败，请稍后重试", upstream_msg=upstream_msg)},
                            ensure_ascii=False
                        ) + "\n\n"
                    elif current_event == "done":
                        break

            yield "data: {\"done\": true}\n\n"

        except Exception as e:
            yield "data: " + json.dumps(
                {"error": _sanitize_error(
                    exc=e, default="对话失败，请稍后重试")},
                ensure_ascii=False
            ) + "\n\n"
        finally:
            if resp is not None:
                resp.close()

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


@app.route("/api/works/<work_id>/upload", methods=["POST"])
@require_work_access
def upload_file(work_id):
    """上传文件到 Coze（用于工作流 File 类型参数）"""
    work = request.work_config

    pat_token = work.get("pat_token", "")
    if not pat_token:
        return respond(400, None, "未配置 PAT Token")

    if "file" not in request.files:
        return respond(400, None, "请选择文件")

    file = request.files["file"]

    # 扩展名白名单校验（P1 安全合规）
    allowed_exts = {
        ".md", ".txt", ".json", ".csv", ".xml", ".yaml", ".yml",
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    }
    original_name = file.filename or ""
    ext = os.path.splitext(original_name)[1].lower()
    if ext not in allowed_exts:
        allowed_str = ", ".join(sorted(allowed_exts))
        ext_label = ext or "无扩展名"
        return respond(400, None, f"不支持的文件类型: {ext_label}，仅允许: {allowed_str}")

    # 大小上限（5MB）
    max_size = 5 * 1024 * 1024
    file.stream.seek(0, os.SEEK_END)
    file_size = file.stream.tell()
    file.stream.seek(0)
    if file_size > max_size:
        return respond(400, None, "文件大小超过限制（最大 5MB）")

    # 清洗文件名，仅取 basename，防路径穿越
    safe_name = os.path.basename(original_name) or "upload.bin"

    try:
        url = f"{coze_client.COZE_API_BASE}/v1/files/upload"
        headers = {"Authorization": f"Bearer {pat_token}"}
        files = {"file": (safe_name, file.stream, file.content_type)}
        resp = requests.post(url, headers=headers, files=files, timeout=60)
        resp.raise_for_status()
        result = resp.json()

        resp_code = result.get("code")
        app.logger.info(f"[上传文件] 响应: code={resp_code}")

        if result.get("code") == 0:
            file_info = result.get("data", {})
            file_id = file_info.get("id", "")
            file_name = file_info.get("file_name", safe_name)
            app.logger.info(f"[上传文件] 成功: file_id={file_id}")
            if not file_id:
                return respond(500, None, "上传成功但未获取到 file_id")
            return respond(0, {"success": True, "file_id": file_id, "file_name": file_name}, "ok")
        else:
            upstream_msg = result.get("msg")
            return respond(500, None, _sanitize_error(
                default="文件上传失败，请稍后重试", upstream_msg=upstream_msg))
    except Exception as e:
        return respond(500, None, _sanitize_error(exc=e, default="文件上传失败，请稍后重试"))


@app.route("/api/works/<work_id>/workflow/run", methods=["POST"])
@require_work_access
def execute_workflow(work_id):
    """执行工作流（通过 Coze API）"""
    work = request.work_config

    pat_token = work.get("pat_token", "")
    workflow_id = work.get("coze_workflow_id", "") or work.get(
        "coze_meta", {}
    ).get("workflow_id", "")

    if not pat_token or not workflow_id:
        return respond(400, None, "该工作流未正确配置，请联系管理员")

    data = request.get_json(force=True) or {}
    user_inputs = data.get("params", {})
    stream = data.get("stream", False)

    # 构建 parameters：按参数类型白名单转换（F3-R1：抽离 convert_param，非法返 400）
    parameters = {}
    input_params = [p for p in work.get("parameters", []) if p.get("group") != "output"]

    try:
        for param in input_params:
            name = param.get("name", "")
            value = user_inputs.get(name, param.get("default", ""))
            param_type = param.get("type", "String")

            if not value and value != 0 and value is not False:
                # 空值跳过（有默认值的话用默认值）
                if param.get("default"):
                    value = param["default"]
                else:
                    continue

            parameters[name] = convert_param(name, param_type, value)
    except ParamError as e:
        return respond(400, None, str(e))

    if stream:
        # 流式执行
        def generate():
            """SSE 生成器：转发 Coze 工作流流式执行为增量事件。"""
            resp = None

            def _fallback_run(reason):
                # R5：流式失败 → 降级到非流式 run，结果包装为 delta + done
                app.logger.warning("F3 流式执行降级到非流式 run: %s", reason)
                ok, payload = _run_workflow_sync(pat_token, workflow_id, parameters)
                if ok:
                    output_str = payload if isinstance(payload, str) \
                        else json.dumps(payload, ensure_ascii=False)
                    yield "data: " + json.dumps(
                        {"delta": output_str}, ensure_ascii=False) + "\n\n"
                    yield "data: {\"done\": true}\n\n"
                else:
                    yield "data: " + json.dumps(
                        {"error": payload}, ensure_ascii=False) + "\n\n"

            try:
                url = f"{coze_client.COZE_API_BASE}/v1/workflow/stream_run"
                headers = {
                    "Authorization": f"Bearer {pat_token}",
                    "Content-Type": "application/json"
                }
                body = {
                    "workflow_id": workflow_id,
                    "parameters": parameters
                }
                resp = requests.post(url, headers=headers, json=body, stream=True, timeout=120)
                resp.encoding = "utf-8"

                current_event = ""

                for line in resp.iter_lines():
                    if not line:
                        continue
                    try:
                        line_str = line.decode("utf-8")
                    except UnicodeDecodeError:
                        continue

                    # Coze 工作流 SSE 格式：
                    # id: 0
                    # event: Message
                    # data: {"content":"增量文本","node_is_finish":false,...}
                    #
                    # 事件类型是大写开头：Message, Done, Error, Interrupt
                    if line_str.startswith("event:"):
                        current_event = line_str[6:].strip()
                        continue

                    if line_str.startswith("data:"):
                        data_str = line_str[5:].strip()
                        if not data_str:
                            continue
                        try:
                            event_data = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue

                        if current_event == "Message":
                            content = event_data.get("content", "")
                            if content:
                                yield "data: " + json.dumps(
                                    {"delta": content}, ensure_ascii=False
                                ) + "\n\n"
                        elif current_event == "Done":
                            yield "data: " + json.dumps(
                                {"done": True}, ensure_ascii=False
                            ) + "\n\n"
                        elif current_event == "Error":
                            upstream_msg = event_data.get("error_message")
                            # R5：上游报错 → 降级到非流式 run
                            for chunk in _fallback_run(upstream_msg or "upstream Error event"):
                                yield chunk
                            break

                else:
                    # 循环正常结束（未因 Error break）→ 兜底 done
                    yield "data: {\"done\": true}\n\n"
            except Exception as e:
                # R5：流式异常 → 降级到非流式 run
                for chunk in _fallback_run(e):
                    yield chunk
            finally:
                if resp is not None:
                    resp.close()

        return Response(
            stream_with_context(generate()),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
        )
    else:
        # 非流式执行
        ok, payload = _run_workflow_sync(pat_token, workflow_id, parameters)
        if ok:
            return respond(0, {"output": payload}, "ok")
        return respond(500, None, payload)


# ==================== 工具函数 ====================

class ParamError(ValueError):
    """参数类型转换失败（含参数名与原因，F3-R1）。"""


ALLOWED_PARAM_TYPES = {"String", "Integer", "Number", "Boolean", "Time", "Object", "Array", "File"}


def convert_param(name, ptype, value):
    """按 Coze 参数类型白名单转换值；Integer/Number 非法抛 ParamError（F3-R1）。

    Object/Array/File 保留前端依赖的友好处理（分隔符拆分、兜底包装），
    仅 Integer/Number 转换失败时抛错（原实现会静默保留原值透传）。
    """
    if ptype not in ALLOWED_PARAM_TYPES:
        raise ParamError(f"参数 {name} 类型不合法: 不支持的类型 {ptype!r}")
    if value is None:
        return ""
    if ptype == "Integer":
        try:
            return int(value)
        except (ValueError, TypeError) as e:
            raise ParamError(f"参数 {name} 类型不合法: Integer 无法转换 {value!r}") from e
    if ptype == "Number":
        try:
            return float(value)
        except (ValueError, TypeError) as e:
            raise ParamError(f"参数 {name} 类型不合法: Number 无法转换 {value!r}") from e
    if ptype == "Boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.lower() in ("true", "1", "yes", "是")
        return bool(value)
    if ptype == "File":
        if isinstance(value, str) and value.startswith("{"):
            return value
        return json.dumps({"file_id": value})
    if ptype == "Object":
        if isinstance(value, str):
            try:
                return json.dumps(json.loads(value))
            except json.JSONDecodeError:
                return json.dumps({"value": value})
        return json.dumps(value)
    if ptype == "Array":
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                return json.dumps(parsed if isinstance(parsed, list) else [parsed])
            except json.JSONDecodeError:
                for sep in [",", "，", ";", "；", "\n"]:
                    if sep in value:
                        return json.dumps([v.strip() for v in value.split(sep) if v.strip()])
                return json.dumps([value])
        return json.dumps(value)
    # String / Time
    return str(value)


def _run_workflow_sync(pat_token, workflow_id, parameters):
    """非流式调用 Coze workflow/run（F3-R5：供流式降级与非流式路径共用）。

    返回 (ok, payload)：
      ok=True  → payload 为工作流输出 data
      ok=False → payload 为脱敏后的错误提示
    """
    url = f"{coze_client.COZE_API_BASE}/v1/workflow/run"
    headers = {
        "Authorization": f"Bearer {pat_token}",
        "Content-Type": "application/json",
    }
    body = {"workflow_id": workflow_id, "parameters": parameters}
    try:
        resp = requests.post(url, headers=headers, json=body, timeout=120)
        resp.raise_for_status()
        result = resp.json()
        if result.get("code") == 0:
            return True, result.get("data", "")
        return False, _sanitize_error(
            default="执行失败，请稍后重试", upstream_msg=result.get("msg"))
    except Exception as e:
        return False, _sanitize_error(exc=e, default="执行失败，请稍后重试")


def _build_coze_chat_request(
    work_config, user_message, conversation_id="", parameters=None, user_id=""
):
    """构建 Coze 对话请求体；conversation_id 由路由放入 URL Query。"""
    body = {
        "bot_id": work_config["coze_bot_id"],
        "user_id": user_id or "visitor_" + str(uuid.uuid4())[:8],
        "stream": True,
        "auto_save_history": True,
        "additional_messages": []
    }

    # 处理消息内容
    if user_message:
        # 检查是否包含文件引用
        if isinstance(user_message, list):
            # object_string 格式
            content_str = json.dumps(user_message, ensure_ascii=False)
            app.logger.info(f"[对话] 多模态消息: {content_str[:200]}")
            body["additional_messages"].append({
                "role": "user",
                "content": content_str,
                "content_type": "object_string"
            })
        else:
            body["additional_messages"].append({
                "role": "user",
                "content": user_message,
                "content_type": "text"
            })

    # 如果有 custom_variables（来自表单参数）
    if parameters:
        body["custom_variables"] = parameters

    return body


# ==================== 小说创作模块（P3） ====================
# 依赖注入：role_store / project_store / agent_client / scheduler / flow_engine
# 由应用层构造传入，不在模块内硬编码单例（对齐架构设计 §7 依赖注入）。
from modules.novel_creation.project_store import ProjectStore
from modules.novel_creation.role_store import RoleStore
from modules.novel_creation.role_agent_scheduler import RoleAgentScheduler
from modules.novel_creation.step_flow_engine import DEFAULT_STEPS, StepFlowEngine
from modules.novel_creation.tool_registry import create_default_registry
from modules.novel_creation.routes import create_blueprint
from modules.novel_creation.model_router import ModelRouter
from modules.novel_creation.agent_client import CozeAgentClient
from modules.novel_creation.trae_agent_client import TraeAgentClient
from modules.novel_creation.flow_progress_store import FlowProgressStore
from modules.agent_management.agent_store import AgentStore
from modules.agent_management.agent_service import AgentService
from modules.agent_management.routes import create_blueprint as create_agent_blueprint

_project_store = ProjectStore(os.path.join(DATA_DIR, "projects"))
_role_store = RoleStore(os.path.join(DATA_DIR, "projects"))
_role_scheduler = RoleAgentScheduler(
    _role_store, _project_store, coze_client,
    model_router=ModelRouter(config_loader),
    clients={
        "coze": CozeAgentClient(coze_client),
        "trae": TraeAgentClient(),
    },
)
_step_flow_engine = StepFlowEngine(_role_scheduler, _role_store)
_tool_registry = create_default_registry()


def _load_flow_template():
    """读取 11 步模板；缺失或不足 11 步时回退到 DEFAULT_STEPS 占位。"""
    path = os.path.join(BASE_DIR, "config", "default_flow_agents.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            steps = json.load(f).get("steps") or []
        if len(steps) == 11:
            return steps
    except (OSError, ValueError):
        pass
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

# 知识库蓝图（F5）：模块级 bp，注册后挂载 /api/knowledge/* 全部接口
from modules.knowledge_base.routes import bp as _knowledge_bp
from modules.knowledge_base.routes import _store as _kb_store

# F5→P3 知识库角色同步导入引擎（依赖注入，避免 role_store 硬耦合知识库符号）
from modules.novel_creation.role_import import RoleImportEngine
_role_import_engine = RoleImportEngine(
    _kb_store, _role_store, os.path.join(DATA_DIR, "projects"),
)

_novel_bp = create_blueprint(
    _role_store, _project_store, _role_scheduler, _step_flow_engine,
    tool_registry=_tool_registry, import_engine=_role_import_engine,
    project_provisioner=_agent_service.provision_project_defaults,
    tool_agent_resolver=_agent_service.resolve_default_tool_agent,
)
app.register_blueprint(_novel_bp)
app.register_blueprint(create_agent_blueprint(_agent_service, _flow_progress_store))
app.register_blueprint(_knowledge_bp)

# 工作流管理模块：独立资源生命周期管理（参考 agent 模块四层结构）
from modules.workflow_management.workflow_store import WorkflowStore as _WorkflowStore
from modules.workflow_management.workflow_service import WorkflowService as _WorkflowService
from modules.workflow_management.routes import create_blueprint as _create_workflow_blueprint

_workflow_store = _WorkflowStore(os.path.join(DATA_DIR, "workflows"))
_workflow_service = _WorkflowService(_workflow_store)
app.register_blueprint(_create_workflow_blueprint(_workflow_service))


def _bootstrap_workflow_migration():
    """一次性存量迁移：把 work_manager 中 Coze 工作流作品幂等迁入全局池。

    失败仅告警，不阻塞启动，可重复执行（按 workflow_id 幂等）。
    """
    try:
        _workflow_service.migrate_from_work_manager(work_manager)
    except Exception as _e:  # noqa: BLE001 - 引导阶段容错
        app.logger.warning("[工作流迁移] 存量 Coze 工作流迁移失败: %s", _e)


_bootstrap_workflow_migration()

# 剧情推衍聊天室蓝图（F6）：模块级 bp，注册后挂载 /api/story/* 全部接口
from modules.routes_story import bp as _story_bp
app.register_blueprint(_story_bp)

# 剧情树蓝图（F7）：模块级 bp，注册后挂载 /api/plot/* 全部接口
from modules.plot.routes import bp as _plot_bp
app.register_blueprint(_plot_bp)

# 角色版图蓝图（F8）：依赖注入装配，挂载 /api/role-map/* 全部接口
from modules.plot.routes_role_map import (
    create_role_map_blueprint, set_workflow_id as _set_role_map_workflow_id,
)
from modules.plot.role_map_service import RoleMapStore
from modules.plot.plot_tree import PlotTreeStore

_role_map_store = RoleMapStore(
    os.path.join(DATA_DIR, "projects"),
    role_store=_role_store,
    project_store=_project_store,
    plot_store=PlotTreeStore(os.path.join(DATA_DIR, "plot")),
)
_role_map_bp = create_role_map_blueprint(
    _role_map_store, _role_store,
    project_store=_project_store,
    plot_store=_role_map_store._plot_store,
    llm_fn=None,  # 生产由 _set_role_map_workflow_id + coze 包装；当前用 extractor 默认占位
    data_root=DATA_DIR,
    tool_registry=_tool_registry,
    coze_client=coze_client,
    config_loader=config_loader,
)
app.register_blueprint(_role_map_bp)
# 注入抽取 workflow id（从配置读取；默认空则 AI generate 报错，不阻断手动图谱）
_role_map_workflow_cfg = getattr(coze_client, "role_map_workflow_id", "")
if _role_map_workflow_cfg:
    _set_role_map_workflow_id(_role_map_workflow_cfg)


# ==================== 启动入口 ====================

if __name__ == "__main__":
    port = 5000

    # 启动时从磁盘恢复持久化会话（C-004：服务重启不失效）
    _load_sessions()

    # 加载配置并打印管理密码
    config = config_loader.load_global_config()
    admin_password = config.get("admin_password", "")
    site_name = config.get("site_name", "StoryForgeAI")

    sep = "=" * 50
    app.logger.info(f"\n{sep}")
    app.logger.info(f"  {site_name} - Coze 作品展示平台")
    app.logger.info(f"  访问地址: http://localhost:{port}")
    app.logger.info(f"{sep}\n")

    # 启动时执行一次幂等迁移（失败不阻断启动）
    try:
        report = _agent_service.migrate_role_bindings(
            os.path.join(DATA_DIR, "projects"), dry_run=False)
        app.logger.info("[Agent] 角色绑定迁移: %s", report)
    except Exception as exc:  # noqa: BLE001 - 迁移失败不阻断启动
        app.logger.warning("[Agent] 角色绑定迁移失败: %s", exc)

    app.run(host="0.0.0.0", port=port, debug=False)
