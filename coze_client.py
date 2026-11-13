"""
Coze API 客户端
通过 Coze Open API 自动拉取智能体信息
"""

import requests
import json
import os
import logging
from dataclasses import dataclass, field

from modules.common.mapping import map_component_type

# 模块级 logger
_logger = logging.getLogger(__name__)


@dataclass
class ChatOptions:
    """chat() 可选参数聚合（降低函数参数个数，保持向后兼容）。"""
    user_id: str = "storyforge_user"
    max_poll: int = 60
    poll_interval: float = 1.0
    # 预留：未来可扩展其他可选参数
    extra: dict = field(default_factory=dict)


class CozeClient:
    """Coze 平台 API 客户端"""

    COZE_API_BASE = "https://api.coze.cn"

    def __init__(self, pat_token=""):
        self.pat_token = pat_token

    def _headers(self):
        return {
            "Authorization": f"Bearer {self.pat_token}",
            "Content-Type": "application/json"
        }

    def get_all_resources(self, workspace_id=""):
        """获取工作空间下所有资源（智能体 + 工作流）"""
        all_items = []
        seen_ids = set()

        def _add_items(items, source_type):
            if not isinstance(items, list):
                return
            for item in items:
                if isinstance(item, dict):
                    item_id = item.get("id", "")
                    if item_id and item_id not in seen_ids:
                        item["_source_type"] = source_type
                        all_items.append(item)
                        seen_ids.add(item_id)

        # 1. 智能体
        try:
            bot_result = self.get_bot_list(workspace_id)
            if bot_result.get("success"):
                _add_items(bot_result.get("bots", []), "bot")
            else:
                _logger.warning(f"[get_all_resources] bots failed: {bot_result.get('error')}")
        except Exception as e:
            _logger.warning(f"[get_all_resources] bots error: {e}")

        # 2. 工作流
        try:
            wf_result = self.get_workflow_list(workspace_id)
            if wf_result.get("success"):
                _add_items(wf_result.get("items", []), "workflow")
            else:
                _logger.warning(f"[get_all_resources] workflows failed: {wf_result.get('error')}")
        except Exception as e:
            _logger.warning(f"[get_all_resources] workflows error: {e}")

        _logger.info(f"[get_all_resources] total: {len(all_items)} items")
        return {"success": True, "bots": all_items, "total": len(all_items)}

    def get_bot_list(self, workspace_id=""):
        """获取智能体列表"""
        url = f"{self.COZE_API_BASE}/v1/bots"
        params = {
            "workspace_id": workspace_id,
            "page_num": 1,
            "page_size": 50
        }
        try:
            resp = requests.get(url, headers=self._headers(), params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") == 0:
                bot_data = data.get("data", {})
                return {
                    "success": True,
                    "bots": bot_data.get("items", []),
                    "total": bot_data.get("total", 0),
                }
            return {"success": False, "error": data.get("msg", "获取失败")}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def get_bot_info(self, bot_id, is_published=True):
        """获取智能体详细信息"""
        url = f"{self.COZE_API_BASE}/v1/bots/{bot_id}"
        params = {"is_published": str(is_published).lower()}
        try:
            resp = requests.get(url, headers=self._headers(), params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") == 0:
                return {"success": True, "data": data.get("data", {})}
            return {"success": False, "error": data.get("msg", "获取失败")}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def test_connection(self, workspace_id=""):
        """测试 PAT Token 是否有效"""
        return self.get_all_resources(workspace_id)

    def get_dataset_list(self, page_num=1, page_size=50):
        """获取知识库列表"""
        url = f"{self.COZE_API_BASE}/v1/datasets"
        params = {"page_num": page_num, "page_size": page_size}
        try:
            resp = requests.get(url, headers=self._headers(), params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") == 0:
                return {"success": True, "items": data.get("data", [])}
            return {"success": False, "error": data.get("msg", "获取失败")}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def get_workflow_list(self, workspace_id="", page_num=1, page_size=50):
        """获取工作流列表"""
        url = f"{self.COZE_API_BASE}/v1/workflows"
        params = {"page_num": page_num, "page_size": page_size}
        if workspace_id:
            params["workspace_id"] = workspace_id
        try:
            resp = requests.get(url, headers=self._headers(), params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") == 0:
                raw_data = data.get("data", {})
                # Coze 返回嵌套结构: {"items": {"has_more": false, "items": [...]}}
                if isinstance(raw_data, dict):
                    items = raw_data.get("items", [])
                    if isinstance(items, dict):
                        items = items.get("items", [])
                elif isinstance(raw_data, list):
                    items = raw_data
                else:
                    items = []
                # 标准化字段名：workflow_id -> id, workflow_name -> name
                normalized = []
                for item in items:
                    if isinstance(item, dict):
                        normalized.append({
                            "id": item.get("workflow_id", item.get("id", "")),
                            "name": item.get("workflow_name", item.get("name", "")),
                            "description": item.get("description", ""),
                            "icon_url": item.get("icon_url", ""),
                            "created_at": item.get("created_at", ""),
                            "updated_at": item.get("updated_at", ""),
                        })
                return {"success": True, "items": normalized}
            return {"success": False, "error": data.get("msg", "获取失败")}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def convert_to_agent_config(self, bot_info):
        """
        将 Coze BotInfo 转换为本地的智能体配置格式

        Args:
            bot_info (dict): Coze API 返回的 BotInfo 对象

        Returns:
            dict: 本地智能体配置
        """
        # 基本信息
        name = bot_info.get("name", "未命名智能体")
        description = bot_info.get("description", "")
        icon_url = bot_info.get("icon_url", "")

        # 提示词
        prompt_info = bot_info.get("prompt_info", {})
        system_prompt = prompt_info.get("prompt", "")

        # 开场白
        onboarding = bot_info.get("onboarding_info", {})
        prologue = onboarding.get("prologue", "")
        suggested_questions = onboarding.get("suggested_questions", [])

        # 模型信息
        model_info = bot_info.get("model_info", {})
        response_format = model_info.get("response_format", "text")

        # 变量 -> 转换为 parameters
        variables = bot_info.get("variables", [])
        parameters = []
        for var in variables:
            if not var.get("enable", True):
                continue
            param = {
                "name": var.get("keyword", ""),
                "label": var.get("description", var.get("keyword", "")),
                "type": "text",
                "required": False,
                "default": var.get("default_value", ""),
                "placeholder": var.get("description", ""),
                "options": []
            }
            parameters.append(param)

        # 快捷指令 -> 也转换为 parameters 或单独存储
        shortcut_commands = bot_info.get("shortcut_commands", [])

        # 工作流信息
        workflow_info_list = bot_info.get("workflow_info_list", [])

        # 插件信息
        plugin_info_list = bot_info.get("plugin_info_list", [])

        # 判断交互类型
        # 如果有变量或快捷指令且有组件参数，用 form 或 mixed
        has_params = len(parameters) > 0
        has_shortcuts_with_components = any(
            sc.get("components") for sc in shortcut_commands
        )

        if has_params and system_prompt:
            interaction_type = "mixed"
        elif has_params:
            interaction_type = "form"
        else:
            interaction_type = "chat"

        # 如果有快捷指令的组件参数，也添加到 parameters
        for sc in shortcut_commands:
            components = sc.get("components", [])
            for comp in components:
                comp_name = comp.get("name", "")
                if comp_name and not any(p["name"] == comp_name for p in parameters):
                    param = {
                        "name": comp_name,
                        "label": comp.get("description", comp_name),
                        "type": self._map_component_type(comp.get("type", "text")),
                        "required": not comp.get("is_hide", False),
                        "default": comp.get("default_value", ""),
                        "placeholder": comp.get("description", ""),
                        "options": []
                    }
                    parameters.append(param)

        # 构建完整的智能体配置
        agent_config = {
            "name": name,
            "description": description or prologue,
            "icon": "\U0001f916",  # 默认图标，如果有 icon_url 可以后续处理
            "interaction_type": interaction_type,
            "system_prompt": system_prompt,
            "parameters": parameters,
            "output_format": {
                "type": (
                    response_format
                    if response_format in ["text", "json", "markdown"]
                    else "text"
                ),
                "stream": True
            },
            "api_config": {
                "provider": "coze",
                "base_url": self.COZE_API_BASE,
                # 安全：不落真实 token（PAT 属敏感凭据）。出站请求时由调用方
                # 从 work.pat_token 注入 Authorization 头，此处仅存占位标记。
                "api_key": "",  # 占位，勿存 token
                "model": "",
                "bot_id": bot_info.get("bot_id", ""),
                "use_coze_api": True
            },
            # Coze 特有信息，额外存储
            "coze_meta": {
                "icon_url": icon_url,
                "prologue": prologue,
                "suggested_questions": suggested_questions,
                "shortcut_commands": shortcut_commands,
                "workflow_info_list": workflow_info_list,
                "plugin_info_list": plugin_info_list,
                "bot_mode": bot_info.get("bot_mode", 0),
                "model_name": model_info.get("model_name", "")
            }
        }

        return agent_config

    def _map_component_type(self, coze_type):
        """映射 Coze 组件类型到本地参数类型（公共映射，见 modules/common/mapping.py）"""
        return map_component_type(coze_type)

    def run_workflow(self, workflow_id, parameters=None, stream=False):
        """
        执行 Coze 工作流

        Args:
            workflow_id (str): 工作流 ID
            parameters (dict): 工作流输入参数
            stream (bool): 是否使用流式执行

        Returns:
            dict: 非流式返回 {"success": True, "data": "...", "debug_url": "..."}
                  流式返回 {"success": True, "data": "", "response": requests.Response}
                  失败返回 {"success": False, "error": "..."}
        """
        if stream:
            url = f"{self.COZE_API_BASE}/v1/workflow/stream_run"
        else:
            url = f"{self.COZE_API_BASE}/v1/workflow/run"

        body = {
            "workflow_id": workflow_id,
            "parameters": parameters or {}
        }

        try:
            resp = requests.post(
                url, headers=self._headers(), json=body, stream=stream, timeout=120
            )
            if stream:
                # 流式：response 保留原始响应对象（调用方逐行读取），
                # data 置空占位以统一返回契约（success/data 恒存在）。
                return {"success": True, "data": "", "response": resp}
            else:
                resp.raise_for_status()
                data = resp.json()
                if data.get("code") == 0:
                    return {
                        "success": True,
                        "data": data.get("data", ""),
                        "debug_url": data.get("debug_url", "")
                    }
                return {"success": False, "error": data.get("msg", "执行失败")}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def generate_character_image(self, workflow_id, prompt):
        """
        调用 Coze 文生图工作流生成角色图像（F9-T2）。

        复用 run_workflow 执行 Coze 文生图工作流。工作流输入参数约定：
        {"prompt": <描述文本>}。返回值统一契约：
            {"success": True, "image_url": <URL>, "data": <原始 data>}
        或 {"success": False, "error": <消息>}。

        Args:
            workflow_id (str): Coze 文生图工作流 ID。
            prompt (str): 确定性构造的角色形象描述 prompt。

        Returns:
            dict: 成功 {"success": True, "image_url": ...} / 失败 {"success": False, "error": ...}
        """
        result = self.run_workflow(workflow_id, {"prompt": prompt})
        if not result.get("success"):
            return {"success": False, "error": result.get("error", "图像生成失败")}

        data = result.get("data")
        # 工作流 data 通常为 JSON 字符串或 dict，需提取图像 URL 字段（兼容多形态）
        image_url = ""
        if isinstance(data, dict):
            image_url = data.get("image_url") or data.get("url") or data.get("image") or ""
        elif isinstance(data, str):
            try:
                parsed = json.loads(data)
                if isinstance(parsed, dict):
                    image_url = (
                        parsed.get("image_url") or parsed.get("url") or parsed.get("image") or ""
                    )
                else:
                    image_url = str(parsed)
            except (ValueError, TypeError):
                image_url = data.strip()
        if not image_url:
            return {"success": False, "error": "图像工作流未返回可用的 image_url"}
        return {"success": True, "image_url": image_url, "data": data}

    def chat(
        self,
        bot_id,
        user_message,
        conversation_id="",
        parameters=None,
        **kwargs,
    ):
        """
        调用 Coze 对话（v3/chat），同步等待结果。

        对齐 RoleAgentScheduler 契约：chat(bot_id, user_message, conversation_id, parameters)
        -> {"success": True, "content": <str|dict>, "conversation_id": ...}。

        实现：POST /v3/chat 创建会话（stream=False），随后轮询
        GET /v3/chat/retrieve 直至 status=completed，取最后一条 assistant 消息
        content 作为输出。失败返回 {"success": False, "error": ...}。

        Args:
            bot_id (str): Coze 智能体 ID（即角色绑定的 agent_id）。
            user_message (str): 发送给智能体的用户消息（含身份提示词/记忆/上下文）。
            conversation_id (str): 会话隔离 key（f"{role_id}:{agent_id}"）；空则服务端新建。
            parameters (dict): 附加变量（预留，当前透传未用）。
            options (ChatOptions|dict): 可选参数聚合（user_id/max_poll/poll_interval）。

        Returns:
            dict: {"success": True, "content": ..., "conversation_id": ...}
                  或 {"success": False, "error": ...}
        """
        # 解析可选参数（支持 ChatOptions 对象或 dict，兼容旧关键字调用）
        options = kwargs.get("options")
        opts = ChatOptions()
        if isinstance(options, ChatOptions):
            opts = options
        elif isinstance(options, dict):
            for key in ("user_id", "max_poll", "poll_interval"):
                if key in options:
                    setattr(opts, key, options[key])
        # 兼容旧式关键字传参（user_id/max_poll/poll_interval 直接传入）
        for key in ("user_id", "max_poll", "poll_interval"):
            if key in kwargs and kwargs.get(key) is not None:
                setattr(opts, key, kwargs[key])

        if not bot_id:
            return {"success": False, "error": "bot_id 不能为空"}
        if not user_message:
            return {"success": False, "error": "user_message 不能为空"}

        # 1. 创建会话（异步，stream=False）
        create_url = f"{self.COZE_API_BASE}/v3/chat"
        body = {
            "bot_id": bot_id,
            "user_id": opts.user_id,
            "stream": False,
            "auto_save": True,
            "additional_messages": [
                {"role": "user", "content": user_message, "content_type": "text"}
            ],
        }
        if conversation_id:
            body["conversation_id"] = conversation_id
        if parameters:
            body["custom_variables"] = parameters

        try:
            resp = requests.post(create_url, headers=self._headers(), json=body, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") != 0:
                return {"success": False, "error": data.get("msg", "创建会话失败")}
        except Exception as e:
            return {"success": False, "error": str(e)}

        chat_id = data.get("data", {}).get("id", "")
        if not chat_id:
            return {"success": False, "error": "未返回 chat_id"}
        conv_id = data.get("data", {}).get("conversation_id", conversation_id)

        # 2. 轮询查询结果
        retrieve_url = f"{self.COZE_API_BASE}/v3/chat/retrieve"
        for _ in range(opts.max_poll):
            try:
                resp = requests.get(retrieve_url, headers=self._headers(),
                                    params={"chat_id": chat_id}, timeout=15)
                resp.raise_for_status()
                data = resp.json()
            except Exception as e:
                return {"success": False, "error": str(e)}

            if data.get("code") != 0:
                return {"success": False, "error": data.get("msg", "查询会话失败")}

            chat_data = data.get("data", {})
            status = chat_data.get("status", "")
            if status == "completed":
                # 提取最后一条 assistant 消息 content
                messages = chat_data.get("messages", [])
                content = None
                for msg in reversed(messages):
                    if msg.get("role") == "assistant" and msg.get("type") in (
                        "answer",
                        "function_call",
                        "",
                    ):
                        c = msg.get("content")
                        if c not in (None, ""):
                            content = c
                            break
                if content is None and messages:
                    content = messages[-1].get("content", "")
                return {
                    "success": True,
                    "content": content if content is not None else "",
                    "conversation_id": conv_id,
                }
            if status == "failed":
                err = chat_data.get("last_error", {}) or {}
                return {"success": False,
                        "error": err.get("msg", err.get("msg_text", "会话执行失败"))}
            if status == "requires_action":
                return {"success": False, "error": "会话需要额外操作，暂不支持"}

        return {"success": False, "error": "查询超时"}

    def upload_file(self, file_obj, filename=None, content_type=None):
        """
        上传文件到 Coze

        Args:
            file_obj: 文件对象（支持 file-like object 或文件路径）
            filename (str): 文件名
            content_type (str): 文件 MIME 类型

        Returns:
            dict: {"success": True, "file_id": "...", "file_name": "..."}
        """
        url = f"{self.COZE_API_BASE}/v1/files/upload"
        headers = {"Authorization": f"Bearer {self.pat_token}"}

        if isinstance(file_obj, str):
            # 文件路径：用 with 确保文件句柄被关闭
            _fh = None
            try:
                _fh = open(file_obj, "rb")
                files = {"file": (filename or os.path.basename(file_obj), _fh, content_type)}
                return self._do_upload(url, headers, files, filename)
            finally:
                if _fh is not None:
                    _fh.close()
        else:
            # file-like object
            files = {"file": (filename or "file", file_obj, content_type)}
            return self._do_upload(url, headers, files, filename)

    def _do_upload(self, url, headers, files, filename):
        """上传并解析响应（内部辅助）"""
        try:
            resp = requests.post(url, headers=headers, files=files, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") == 0:
                file_info = data.get("data", {})
                return {
                    "success": True,
                    "file_id": file_info.get("id", ""),
                    "file_name": file_info.get("file_name", filename or "")
                }
            return {"success": False, "error": data.get("msg", "上传失败")}
        except Exception as e:
            return {"success": False, "error": str(e)}
