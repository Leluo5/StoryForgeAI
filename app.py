"""
StoryForgeAI - 小说AI写作软件
让创作者方便地展示 Coze 智能体/工作流，让体验者直接在线体验
"""

import os
import sys
import json
import uuid
import threading
import requests

from flask import Flask, render_template, jsonify, request, Response, stream_with_context
from flask_cors import CORS
from functools import wraps

# 确保项目根目录在路径中
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

from config_loader import ConfigLoader
from work_manager import WorkManager
from coze_client import CozeClient

# ==================== 初始化 ====================

app = Flask(__name__)
CORS(app)

# 全局错误处理，防止返回 HTML 500 页面
# 识别业务异常 AppError -> 接口契约格式 {"code": <非0>, "data": null, "message": "..."} + 对应状态码
from modules.common.errors import AppError as _AppError

@app.errorhandler(Exception)
def handle_error(e):
    import traceback
    traceback.print_exc()
    if isinstance(e, _AppError):
        # 业务异常：按契约错误格式返回对应状态码
        return jsonify({"code": e.code, "data": None, "message": e.message}), e.code
    # 非业务异常：HTTPException（如 404 路由）保留其状态码，其余统一 500
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return jsonify({"code": e.code, "data": None, "message": e.description}), e.code
    return jsonify({"code": 500, "data": None, "message": "内部错误"}), 500

DATA_DIR = os.path.join(BASE_DIR, "data")

# 初始化各模块
config_loader = ConfigLoader(DATA_DIR)
work_manager = WorkManager(DATA_DIR)
coze_client = CozeClient()

# 管理员会话存储（简易实现，生产环境应使用数据库）
_admin_sessions = {}

# AI 生成参数异步任务存储
_gen_tasks = {}


# ==================== 装饰器 ====================

def require_admin(f):
    """管理员验证装饰器（已禁用密码验证）"""
    @wraps(f)
    def decorated(*args, **kwargs):
        return f(*args, **kwargs)
    return decorated


def require_work_access(f):
    """作品访问验证装饰器"""
    @wraps(f)
    def decorated(work_id, *args, **kwargs):
        work = work_manager.get_work(work_id)
        if work is None:
            return jsonify({"error": "作品不存在"}), 404

        # 检查是否公开
        if not work.get("is_public", True):
            return jsonify({"error": "该作品未公开"}), 403

        # 检查访问码
        access_code = work.get("access_code", "")
        if access_code:
            token = request.headers.get("X-Access-Token", "")
            session_key = f"work_{work_id}"
            if not token or _admin_sessions.get(token) != session_key:
                return jsonify({"error": "需要验证访问码"}), 403

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
    if password != config.get("admin_password"):
        return jsonify({"error": "管理密码错误"}), 403

    # 生成会话 token
    token = str(uuid.uuid4())
    _admin_sessions[token] = "admin"
    return jsonify({"success": True, "token": token})


@app.route("/api/admin/config", methods=["GET"])
@require_admin
def get_admin_config():
    """获取全局配置"""
    config = config_loader.load_global_config()
    # 返回配置（密码部分掩码处理）
    result = {
        "version": config.get("version", "2.0.0"),
        "site_name": config.get("site_name", "StoryForgeAI"),
        "site_description": config.get("site_description", "AI 作品展示平台"),
        "theme": config.get("theme", "light"),
        "llm_config": config.get("llm_config", {})
    }
    return jsonify(result)


@app.route("/api/admin/config", methods=["PUT"])
@require_admin
def update_admin_config():
    """更新全局配置"""
    data = request.get_json(force=True) or {}
    allowed_fields = ["site_name", "site_description", "theme", "admin_password", "llm_config"]
    updates = {k: v for k, v in data.items() if k in allowed_fields}
    config = config_loader.update_global_config(updates)
    return jsonify({
        "version": config.get("version", "2.0.0"),
        "site_name": config.get("site_name", "StoryForgeAI"),
        "site_description": config.get("site_description", "AI 作品展示平台"),
        "theme": config.get("theme", "light"),
        "llm_config": config.get("llm_config", {})
    })


@app.route("/api/admin/coze/test", methods=["POST"])
@require_admin
def coze_test():
    """测试 Coze PAT 连接"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    workspace_id = data.get("workspace_id", "")
    if not pat_token:
        return jsonify({"success": False, "error": "请输入 PAT Token"}), 400

    coze_client.pat_token = pat_token
    result = coze_client.test_connection(workspace_id)
    return jsonify(result)


@app.route("/api/admin/coze/bots", methods=["POST"])
@require_admin
def coze_bot_list():
    """获取 Coze 应用列表（智能体+工作流+应用）"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    workspace_id = data.get("workspace_id", "")
    if not pat_token:
        return jsonify({"success": False, "error": "请输入 PAT Token"}), 400

    coze_client.pat_token = pat_token
    result = coze_client.get_all_resources(workspace_id)
    return jsonify(result)


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
        return jsonify({"success": False, "error": "请输入 PAT Token"}), 400
    if not bot_ids:
        return jsonify({"success": False, "error": "请选择要导入的作品"}), 400

    coze_client.pat_token = pat_token
    results = []

    for bid in bot_ids:
        source_type = bid.get("_source_type", "bot") if isinstance(bid, dict) else "bot"
        actual_id = bid.get("id", bid) if isinstance(bid, dict) else bid

        if source_type == "workflow":
            # 导入工作流
            wf_info = {"id": actual_id, "name": bid.get("name", ""), "description": bid.get("description", ""), "icon_url": bid.get("icon_url", "")}
            work = work_manager.import_workflow(wf_info, pat_token, workspace_id, access_code)
            results.append({"success": True, "work_id": work["id"], "name": work["name"], "type": "workflow"})
        else:
            # 导入智能体
            result = coze_client.get_bot_info(actual_id, is_published=True)
            if not result.get("success"):
                result = coze_client.get_bot_info(actual_id, is_published=False)
            if result.get("success"):
                work = work_manager.import_from_coze(result["data"], pat_token, access_code)
                results.append({"success": True, "work_id": work["id"], "name": work["name"], "type": "bot"})
            else:
                results.append({"success": False, "id": actual_id, "error": result.get("error", "导入失败")})

    success_count = sum(1 for r in results if r.get("success"))
    return jsonify({
        "success": True,
        "total": len(bot_ids),
        "imported": success_count,
        "results": results
    })


@app.route("/api/admin/coze/datasets", methods=["POST"])
@require_admin
def coze_dataset_list():
    """获取 Coze 知识库列表"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    if not pat_token:
        return jsonify({"success": False, "error": "请输入 PAT Token"}), 400

    coze_client.pat_token = pat_token
    result = coze_client.get_dataset_list()
    return jsonify(result)


@app.route("/api/admin/coze/workflows", methods=["POST"])
@require_admin
def coze_workflow_list():
    """获取 Coze 工作流列表"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    workspace_id = data.get("workspace_id", "")
    if not pat_token:
        return jsonify({"success": False, "error": "请输入 PAT Token"}), 400

    coze_client.pat_token = pat_token
    result = coze_client.get_workflow_list(workspace_id)
    return jsonify(result)


@app.route("/api/admin/works/import-dataset", methods=["POST"])
@require_admin
def import_dataset():
    """导入知识库"""
    data = request.get_json(force=True) or {}
    pat_token = data.get("pat_token", "")
    dataset_id = data.get("dataset_id", "")
    access_code = data.get("access_code", "")

    if not pat_token:
        return jsonify({"success": False, "error": "请输入 PAT Token"}), 400
    if not dataset_id:
        return jsonify({"success": False, "error": "请指定知识库 ID"}), 400

    coze_client.pat_token = pat_token

    # 先获取知识库列表找到对应的知识库信息
    list_result = coze_client.get_dataset_list()
    if not list_result.get("success"):
        return jsonify({"success": False, "error": list_result.get("error", "获取知识库列表失败")}), 400

    dataset_info = None
    for item in list_result.get("items", []):
        if str(item.get("id", "")) == str(dataset_id):
            dataset_info = item
            break

    if not dataset_info:
        return jsonify({"success": False, "error": "未找到指定的知识库"}), 404

    work = work_manager.import_dataset(dataset_info, pat_token, access_code)
    return jsonify({"success": True, "work_id": work["id"], "name": work["name"]})


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
        return jsonify({"success": False, "error": "请输入 PAT Token"}), 400
    if not workflow_id:
        return jsonify({"success": False, "error": "请指定工作流 ID"}), 400

    coze_client.pat_token = pat_token

    # 先获取工作流列表找到对应的工作流信息
    list_result = coze_client.get_workflow_list(workspace_id)
    if not list_result.get("success"):
        return jsonify({"success": False, "error": list_result.get("error", "获取工作流列表失败")}), 400

    workflow_info = None
    for item in list_result.get("items", []):
        if str(item.get("workflow_id", item.get("id", ""))) == str(workflow_id):
            workflow_info = item
            break

    if not workflow_info:
        return jsonify({"success": False, "error": "未找到指定的工作流"}), 404

    work = work_manager.import_workflow(workflow_info, pat_token, workspace_id, access_code)
    return jsonify({"success": True, "work_id": work["id"], "name": work["name"]})


@app.route("/api/admin/works", methods=["GET"])
@require_admin
def list_admin_works():
    """获取所有已导入作品（含敏感信息）"""
    works = work_manager.list_works()
    return jsonify({"works": works})


@app.route("/api/admin/works/<work_id>", methods=["PUT"])
@require_admin
def update_work(work_id):
    """更新作品配置"""
    data = request.get_json(force=True) or {}
    allowed_fields = [
        "name", "description", "access_code", "is_public",
        "interaction_type", "prologue", "suggested_questions",
        "parameters", "system_prompt"
    ]
    updates = {k: v for k, v in data.items() if k in allowed_fields}

    work = work_manager.update_work(work_id, updates)
    if work is None:
        return jsonify({"error": "作品不存在"}), 404
    return jsonify(work)


@app.route("/api/admin/works/<work_id>", methods=["DELETE"])
@require_admin
def delete_work(work_id):
    """删除作品"""
    success = work_manager.delete_work(work_id)
    if not success:
        return jsonify({"error": "作品不存在"}), 404
    return jsonify({"success": True})


@app.route("/api/admin/works/<work_id>/llm-config", methods=["PUT"])
@require_admin
def update_llm_config(work_id):
    """更新工作流的 LLM 配置"""
    work = work_manager.get_work(work_id)
    if work is None:
        return jsonify({"error": "作品不存在"}), 404
    data = request.get_json(force=True) or {}
    llm_config = {
        "base_url": data.get("base_url", ""),
        "api_key": data.get("api_key", ""),
        "model": data.get("model", "")
    }
    work_manager.update_work(work_id, {"llm_config": llm_config})
    return jsonify({"success": True})


@app.route("/api/admin/works/<work_id>/generate-params", methods=["POST"])
@require_admin
def generate_params_from_image(work_id):
    """上传图片让 LLM 生成参数结构（异步）"""
    work = work_manager.get_work(work_id)
    if work is None:
        return jsonify({"error": "作品不存在"}), 404

    llm_config = work.get("llm_config", {})
    global_config = config_loader.load_global_config()
    global_llm = global_config.get("llm_config", {})
    base_url = llm_config.get("base_url") or global_llm.get("base_url", "")
    api_key = llm_config.get("api_key") or global_llm.get("api_key", "")
    model = llm_config.get("model") or global_llm.get("model", "")

    if not base_url or not api_key or not model:
        return jsonify({"success": False, "error": "请先配置大模型（base_url、api_key、model）"}), 400

    # 获取上传的图片
    if "image" not in request.files:
        return jsonify({"success": False, "error": "请上传图片"}), 400

    import base64
    image_file = request.files["image"]
    image_data = image_file.read()
    image_base64 = base64.b64encode(image_data).decode("utf-8")

    # 获取生成类型：input 只生成输入参数，output 只生成输出参数，默认全部
    gen_group = request.form.get("gen_group", "")

    # 创建异步任务
    task_id = str(uuid.uuid4())[:8]
    _gen_tasks[task_id] = {"status": "running", "result": None, "error": None}

    def run_generation():
        try:
            # 检查是否已取消
            if _gen_tasks.get(task_id, {}).get("status") == "cancelled":
                return

            import requests as req_lib
            import re
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
                            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_base64}"}}
                        ]
                    }
                ],
                "temperature": 0.3,
                "max_tokens": 4096
            }

            resp = req_lib.post(url, headers=headers, json=body, timeout=60)
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

                _gen_tasks[task_id] = {"status": "done", "result": {"parameters": parameters}, "error": None}
            else:
                _gen_tasks[task_id] = {"status": "error", "error": "无法从 LLM 响应中提取参数结构", "result": None}

        except Exception as e:
            if _gen_tasks.get(task_id, {}).get("status") != "cancelled":
                _gen_tasks[task_id] = {"status": "error", "error": str(e), "result": None}

    thread = threading.Thread(target=run_generation, daemon=True)
    thread.start()

    return jsonify({"success": True, "task_id": task_id})


@app.route("/api/admin/works/<work_id>/generate-params/status", methods=["GET"])
@require_admin
def get_gen_params_status(work_id):
    """查询生成任务状态"""
    task_id = request.args.get("task_id", "")
    if not task_id or task_id not in _gen_tasks:
        return jsonify({"status": "not_found"}), 404

    task = _gen_tasks[task_id]
    result = {"status": task["status"]}
    if task["status"] == "done":
        result["result"] = task["result"]
    elif task["status"] == "error":
        result["error"] = task["error"]

    # 如果已完成，清理任务
    if task["status"] in ("done", "error"):
        del _gen_tasks[task_id]

    return jsonify(result)


@app.route("/api/admin/works/<work_id>/generate-params/cancel", methods=["POST"])
@require_admin
def cancel_gen_params(work_id):
    """取消生成任务（标记为取消，线程中检查）"""
    task_id = (request.get_json(force=True) or {}).get("task_id", "")
    if task_id and task_id in _gen_tasks:
        _gen_tasks[task_id]["status"] = "cancelled"
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "任务不存在"}), 404


@app.route("/api/admin/works/<work_id>/refresh", methods=["POST"])
@require_admin
def refresh_work(work_id):
    """刷新作品信息（重新从 Coze 拉取，更新原作品而不是创建新作品）"""
    work = work_manager.get_work(work_id)
    if work is None:
        return jsonify({"error": "作品不存在"}), 404

    coze_meta = work.get("coze_meta", {})
    work_type = coze_meta.get("type", "bot")

    if work_type == "workflow":
        # 工作流刷新：重新从 Coze 获取工作流信息
        pat_token = work.get("pat_token", "")
        workflow_id = work.get("coze_workflow_id", "") or coze_meta.get("workflow_id", "")
        if not pat_token or not workflow_id:
            return jsonify({"success": False, "error": "工作流缺少 PAT Token 或 Workflow ID"}), 400

        # TODO: Coze 没有获取单个工作流详情的 API，暂时直接返回成功
        return jsonify({"success": True, "message": "工作流信息已是最新的"})

    # 智能体刷新（原有逻辑）
    pat_token = work.get("pat_token", "")
    bot_id = work.get("coze_bot_id", "")
    if not pat_token or not bot_id:
        return jsonify({"success": False, "error": "作品缺少 PAT Token 或 Bot ID"}), 400

    coze_client.pat_token = pat_token
    result = coze_client.get_bot_info(bot_id, is_published=True)
    if not result.get("success"):
        result = coze_client.get_bot_info(bot_id, is_published=False)

    if not result.get("success"):
        return jsonify({"success": False, "error": result.get("error", "刷新失败")}), 400

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
        "response_format": response_format if response_format in ["text", "json", "markdown"] else "text",
        "is_public": is_public
    }

    updated = work_manager.update_work(work_id, updates)
    return jsonify({"success": True, "work": updated})


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
    return jsonify({"works": public_works})


@app.route("/api/works/<work_id>", methods=["GET"])
def get_public_work(work_id):
    """获取作品公开信息"""
    work = work_manager.get_work_public(work_id)
    if work is None:
        return jsonify({"error": "作品不存在"}), 404
    if not work.get("is_public", True):
        return jsonify({"error": "该作品未公开"}), 403
    return jsonify(work)


@app.route("/api/works/<work_id>/verify", methods=["POST"])
def verify_work_access(work_id):
    """验证访问码"""
    work = work_manager.get_work(work_id)
    if work is None:
        return jsonify({"error": "作品不存在"}), 404

    data = request.get_json(force=True) or {}
    code = data.get("access_code", "")

    if work_manager.verify_access_code(work_id, code):
        # 生成访问 token
        token = str(uuid.uuid4())
        _admin_sessions[token] = f"work_{work_id}"
        return jsonify({"success": True, "token": token})
    else:
        return jsonify({"success": False, "error": "访问码错误"}), 403


@app.route("/api/works/<work_id>/chat", methods=["POST"])
@require_work_access
def chat_work(work_id):
    """发送对话消息（SSE 流式响应）"""
    work = request.work_config
    data = request.get_json(force=True) or {}

    user_message = data.get("message", "")
    conversation_id = data.get("conversation_id", "")
    parameters = data.get("parameters", {})

    if not user_message and not parameters:
        return jsonify({"error": "请输入消息或填写参数"}), 400

    # 构建 Coze 对话请求
    chat_body = _build_coze_chat_request(work, user_message, conversation_id, parameters)

    pat_token = work.get("pat_token", "")
    coze_client.pat_token = pat_token

    def generate():
        try:
            url = f"{coze_client.COZE_API_BASE}/v3/chat"
            headers = {
                "Authorization": f"Bearer {pat_token}",
                "Content-Type": "application/json"
            }

            import requests
            resp = requests.post(url, headers=headers, json=chat_body, stream=True, timeout=120)
            resp.encoding = "utf-8"
            resp.raise_for_status()

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

                    # 处理不同事件类型
                    if current_event == "conversation.message.delta" or msg_type == "answer":
                        content = msg_data.get("content", "")
                        if content:
                            yield f"data: {json.dumps({'type': 'delta', 'content': content}, ensure_ascii=False)}\n\n"
                    elif current_event == "conversation.message.completed":
                        content = msg_data.get("content", "")
                        if content:
                            yield f"data: {json.dumps({'type': 'delta', 'content': content}, ensure_ascii=False)}\n\n"
                    elif current_event == "conversation.chat.completed":
                        conv_id = msg_data.get("conversation_id", "") or msg_data.get("id", "")
                        yield f"data: {json.dumps({'type': 'done', 'conversation_id': conv_id}, ensure_ascii=False)}\n\n"
                    elif current_event == "conversation.chat.failed":
                        error_msg = msg_data.get("msg", msg_data.get("error_msg", "对话失败"))
                        yield f"data: {json.dumps({'type': 'error', 'content': error_msg}, ensure_ascii=False)}\n\n"
                    elif current_event == "error":
                        error_msg = msg_data.get("msg", "未知错误")
                        yield f"data: {json.dumps({'type': 'error', 'content': error_msg}, ensure_ascii=False)}\n\n"
                    elif current_event == "done":
                        break

            yield f"data: {json.dumps({'type': 'stream_end'}, ensure_ascii=False)}\n\n"

        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)}, ensure_ascii=False)}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


@app.route("/api/works/<work_id>/upload", methods=["POST"])
def upload_file(work_id):
    """上传文件到 Coze（用于工作流 File 类型参数）"""
    work = work_manager.get_work(work_id)
    if work is None:
        return jsonify({"error": "作品不存在"}), 404

    pat_token = work.get("pat_token", "")
    if not pat_token:
        return jsonify({"error": "未配置 PAT Token"}), 400

    if "file" not in request.files:
        return jsonify({"error": "请选择文件"}), 400

    file = request.files["file"]
    try:
        url = f"{coze_client.COZE_API_BASE}/v1/files/upload"
        headers = {"Authorization": f"Bearer {pat_token}"}
        files = {"file": (file.filename, file.stream, file.content_type)}
        resp = requests.post(url, headers=headers, files=files, timeout=60)
        resp.raise_for_status()
        result = resp.json()

        print(f"[上传文件] 响应: code={result.get('code')}, data={result.get('data', {})}")

        if result.get("code") == 0:
            file_info = result.get("data", {})
            file_id = file_info.get("id", "")
            file_name = file_info.get("file_name", file.filename)
            print(f"[上传文件] 成功: file_id={file_id}, file_name={file_name}")
            if not file_id:
                return jsonify({"success": False, "error": "上传成功但未获取到 file_id"}), 500
            return jsonify({"success": True, "file_id": file_id, "file_name": file_name})
        else:
            error_msg = result.get("msg", "上传失败")
            print(f"[上传文件] 失败: {error_msg}")
            return jsonify({"success": False, "error": error_msg}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/works/<work_id>/execute", methods=["POST"])
def execute_workflow(work_id):
    """执行工作流（通过 Coze API）"""
    work = work_manager.get_work(work_id)
    if work is None:
        return jsonify({"error": "作品不存在"}), 404

    # 验证访问码
    access_code = request.headers.get("X-Access-Code", "") or request.args.get("access_code", "")
    if work.get("access_code") and access_code != work.get("access_code"):
        return jsonify({"error": "访问码错误"}), 403

    pat_token = work.get("pat_token", "")
    workflow_id = work.get("coze_workflow_id", "") or work.get("coze_meta", {}).get("workflow_id", "")

    if not pat_token or not workflow_id:
        return jsonify({"error": "该工作流未正确配置，请联系管理员"}), 400

    data = request.get_json(force=True) or {}
    user_inputs = data.get("inputs", {})
    stream = data.get("stream", False)

    # 构建 parameters
    # 需要根据参数类型处理值：
    # - File 类型：值已经是 file_id，需要包装为 {"file_id": "xxx"}
    # - Object 类型：值是 JSON 对象，需要序列化为字符串
    # - 其他类型：直接传入
    parameters = {}
    input_params = [p for p in work.get("parameters", []) if p.get("group") != "output"]

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

        if param_type == "File" and value:
            # File 类型：包装为 {"file_id": "xxx"}
            if not value.startswith("{"):
                value = json.dumps({"file_id": value})
            parameters[name] = value
        elif param_type == "Object":
            # Object 类型：如果是字符串尝试解析为 JSON，否则序列化
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                    value = json.dumps(parsed)
                except json.JSONDecodeError:
                    value = json.dumps({"value": value})
            elif isinstance(value, dict):
                value = json.dumps(value)
            parameters[name] = value
        elif param_type == "Array":
            # Array 类型：如果是字符串，尝试按分隔符拆分或解析为 JSON
            if isinstance(value, str):
                try:
                    parsed = json.loads(value)
                    if isinstance(parsed, list):
                        value = json.dumps(parsed)
                    else:
                        value = json.dumps([parsed])
                except json.JSONDecodeError:
                    # 尝试按常见分隔符拆分
                    for sep in [",", "，", ";", "；", "\n"]:
                        if sep in value:
                            value = json.dumps([v.strip() for v in value.split(sep) if v.strip()])
                            break
                    else:
                        value = json.dumps([value])
            elif isinstance(value, list):
                value = json.dumps(value)
            parameters[name] = value
        elif param_type == "Integer":
            try:
                parameters[name] = int(value)
            except (ValueError, TypeError):
                parameters[name] = value
        elif param_type == "Number":
            try:
                parameters[name] = float(value)
            except (ValueError, TypeError):
                parameters[name] = value
        elif param_type == "Boolean":
            if isinstance(value, str):
                parameters[name] = value.lower() in ("true", "1", "yes", "是")
            else:
                parameters[name] = bool(value)
        elif param_type == "Time" and value:
            parameters[name] = str(value)
        else:
            parameters[name] = value

    if stream:
        # 流式执行
        def generate():
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
                    except:
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
                        except:
                            continue

                        if current_event == "Message":
                            content = event_data.get("content", "")
                            if content:
                                yield f"data: {json.dumps({'type': 'delta', 'content': content}, ensure_ascii=False)}\n\n"
                        elif current_event == "Done":
                            yield f"data: {json.dumps({'type': 'done'}, ensure_ascii=False)}\n\n"
                        elif current_event == "Error":
                            error_msg = event_data.get("error_message", "执行失败")
                            # 添加类型不匹配的友好提示
                            if "can't convert" in error_msg:
                                error_msg += "\n\n提示：这通常是因为参数类型配置与 Coze 工作流定义不一致。请检查编辑参数中的类型是否和 Coze 工作流开始节点的参数类型匹配。"
                            yield f"data: {json.dumps({'type': 'error', 'content': error_msg}, ensure_ascii=False)}\n\n"
                        elif current_event == "Interrupt":
                            interrupt_data = event_data.get("interrupt_data", {})
                            yield f"data: {json.dumps({'type': 'interrupt', 'content': interrupt_data}, ensure_ascii=False)}\n\n"

                yield f"data: {json.dumps({'type': 'stream_end'}, ensure_ascii=False)}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'content': str(e)}, ensure_ascii=False)}\n\n"

        return Response(stream_with_context(generate()), mimetype="text/event-stream")
    else:
        # 非流式执行
        try:
            url = f"{coze_client.COZE_API_BASE}/v1/workflow/run"
            headers = {
                "Authorization": f"Bearer {pat_token}",
                "Content-Type": "application/json"
            }
            body = {
                "workflow_id": workflow_id,
                "parameters": parameters
            }
            resp = requests.post(url, headers=headers, json=body, timeout=120)
            resp.raise_for_status()
            result = resp.json()

            if result.get("code") == 0:
                output_data = result.get("data", "")
                return jsonify({"success": True, "content": output_data, "debug_url": result.get("debug_url", "")})
            else:
                error_msg = result.get("msg", "执行失败")
                # 添加类型不匹配的友好提示
                if "can't convert" in error_msg:
                    error_msg += "（参数类型可能与 Coze 工作流定义不一致，请检查参数配置）"
                return jsonify({"success": False, "error": error_msg}), 500
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500


# ==================== 工具函数 ====================

def _build_coze_chat_request(work_config, user_message, conversation_id="", parameters=None):
    """构建 Coze 对话请求体"""
    body = {
        "bot_id": work_config["coze_bot_id"],
        "user_id": "visitor_" + str(uuid.uuid4())[:8],
        "stream": True,
        "auto_save_history": True,
        "additional_messages": []
    }

    if conversation_id:
        body["conversation_id"] = conversation_id

    # 处理消息内容
    if user_message:
        # 检查是否包含文件引用
        if isinstance(user_message, list):
            # object_string 格式
            content_str = json.dumps(user_message, ensure_ascii=False)
            print(f"[对话] 多模态消息: {content_str[:200]}")
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
from modules.novel_creation.step_flow_engine import StepFlowEngine
from modules.novel_creation.routes import create_blueprint

_project_store = ProjectStore(os.path.join(DATA_DIR, "projects"))
_role_store = RoleStore(os.path.join(DATA_DIR, "projects"))
_role_scheduler = RoleAgentScheduler(_role_store, _project_store, coze_client)
_step_flow_engine = StepFlowEngine(_role_scheduler, _role_store)
_novel_bp = create_blueprint(_role_store, _project_store, _role_scheduler, _step_flow_engine)
app.register_blueprint(_novel_bp)


# ==================== 启动入口 ====================

if __name__ == "__main__":
    port = 5000

    # 加载配置并打印管理密码
    config = config_loader.load_global_config()
    admin_password = config.get("admin_password", "")
    site_name = config.get("site_name", "StoryForgeAI")

    print(f"\n{'='*50}")
    print(f"  {site_name} - Coze 作品展示平台")
    print(f"  访问地址: http://localhost:{port}")
    print(f"{'='*50}\n")

    app.run(host="0.0.0.0", port=port, debug=False)
