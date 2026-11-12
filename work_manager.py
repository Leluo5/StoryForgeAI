"""
作品管理模块
管理从 Coze 平台导入的作品（智能体/工作流）
"""

import json
import os
import uuid
import threading
import logging
from datetime import datetime

from modules.common.mapping import map_component_type

# 模块级写入锁（保证 _save_work 原子性）
_save_lock = threading.Lock()

# 模块级 logger
_logger = logging.getLogger(__name__)


class WorkManager:
    """作品管理器，负责作品的导入、存储、查询和更新"""

    def __init__(self, data_dir):
        """
        初始化作品管理器

        Args:
            data_dir: 数据目录路径
        """
        self.data_dir = data_dir
        self.works_dir = os.path.join(data_dir, "works")
        os.makedirs(self.works_dir, exist_ok=True)

    def import_from_coze(self, bot_info, pat_token, access_code=""):
        """
        从 Coze BotInfo 导入作品

        Args:
            bot_info (dict): Coze API 返回的 BotInfo 对象
            pat_token (str): Coze PAT Token
            access_code (str): 访问码，为空则无需验证

        Returns:
            dict: 作品配置
        """
        work_id = self._generate_id()

        # 基本信息
        name = bot_info.get("name", "未命名作品")
        description = bot_info.get("description", "")

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
        model_name = model_info.get("model_name", "")

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
                "options": [],
                "coze_variable": True
            }
            parameters.append(param)

        # 快捷指令
        shortcut_commands = bot_info.get("shortcut_commands", [])

        # 工作流信息
        workflow_info_list = bot_info.get("workflow_info_list", [])

        # 插件信息
        plugin_info_list = bot_info.get("plugin_info_list", [])

        # 判断交互类型
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
                        "options": [],
                        "coze_variable": False
                    }
                    parameters.append(param)

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        work_config = {
            "id": work_id,
            "name": name,
            "description": description or prologue,
            "icon_url": bot_info.get("icon_url", ""),
            "coze_bot_id": bot_info.get("bot_id", ""),
            "pat_token": pat_token,
            "access_code": access_code,
            "interaction_type": interaction_type,
            "system_prompt": system_prompt,
            "prologue": prologue,
            "suggested_questions": suggested_questions,
            "parameters": parameters,
            "shortcut_commands": shortcut_commands,
            "plugins": plugin_info_list,
            "workflows": workflow_info_list,
            "model_name": model_name,
            "response_format": (
                response_format
                if response_format in ["text", "json", "markdown"]
                else "text"
            ),
            "is_public": True,
            "project_id": "",  # 绑定的 novel_creation 项目（F8 角色版图/剧情树入口）
            "created_at": now,
            "updated_at": now
        }

        self._save_work(work_config)
        return work_config

    def import_dataset(self, dataset_info, pat_token, access_code=""):
        """
        从 Coze 导入知识库

        Args:
            dataset_info (dict): Coze API 返回的知识库信息
            pat_token (str): Coze PAT Token
            access_code (str): 访问码，为空则无需验证

        Returns:
            dict: 作品配置
        """
        work_id = self._generate_id()
        name = dataset_info.get("name", "未命名知识库")
        description = dataset_info.get("description", "")
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        work_config = {
            "id": work_id,
            "name": name,
            "description": description or f"知识库「{name}」",
            "icon_url": "",
            "coze_bot_id": "",
            "pat_token": pat_token,
            "access_code": access_code,
            "interaction_type": "chat",
            "system_prompt": f"你是一个知识库助手，基于知识库「{name}」的内容回答用户问题。请只使用知识库中的信息来回答，如果知识库中没有相关信息，请如实告知。",
            "prologue": f"你好！我是知识库「{name}」的助手，有什么可以帮你的？",
            "suggested_questions": [],
            "parameters": [],
            "shortcut_commands": [],
            "plugins": [],
            "workflows": [],
            "model_name": "",
            "response_format": "text",
            "is_public": True,
            "coze_meta": {
                "type": "dataset",
                "dataset_id": dataset_info.get("id", ""),
                "icon_url": "",
                "prologue": f"你好！我是知识库「{name}」的助手，有什么可以帮你的？",
            },
            "project_id": "",  # 绑定的 novel_creation 项目（F8 角色版图/剧情树入口）
            "created_at": now,
            "updated_at": now
        }

        self._save_work(work_config)
        return work_config

    def import_workflow(self, workflow_info, pat_token, workspace_id="", access_code=""):
        """
        从 Coze 导入工作流

        Args:
            workflow_info (dict): Coze API 返回的工作流信息
            pat_token (str): Coze PAT Token
            workspace_id (str): 工作空间 ID
            access_code (str): 访问码，为空则无需验证

        Returns:
            dict: 作品配置
        """
        work_id = self._generate_id()
        name = workflow_info.get("name", "未命名工作流")
        description = workflow_info.get("description", "")
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        work_config = {
            "id": work_id,
            "name": name,
            "description": description or f"工作流「{name}」",
            "icon_url": workflow_info.get("icon_url", ""),
            "coze_bot_id": "",  # 工作流没有 bot_id
            "coze_workflow_id": workflow_info.get("id", ""),
            "pat_token": pat_token,
            "access_code": access_code,
            "interaction_type": "form",  # 工作流默认表单模式
            "system_prompt": "",
            "prologue": "",
            "suggested_questions": [],
            "parameters": [],  # 用户自己维护
            "shortcut_commands": [],
            "plugins": [],
            "workflows": [],
            "model_name": "",
            "response_format": "text",
            "is_public": True,
            "coze_meta": {
                "type": "workflow",
                "workflow_id": workflow_info.get("id", ""),
                "icon_url": workflow_info.get("icon_url", ""),
            },
            # 新增：工作流专属配置
            "llm_config": {
                "base_url": "",
                "api_key": "",
                "model": ""
            },
            "project_id": "",  # 绑定的 novel_creation 项目（F8 角色版图/剧情树入口）
            "created_at": now,
            "updated_at": now
        }

        self._save_work(work_config)
        return work_config

    def list_works(self):
        """
        列出所有作品

        Returns:
            list: 作品配置列表
        """
        works = []
        if not os.path.exists(self.works_dir):
            return works

        for filename in sorted(os.listdir(self.works_dir)):
            if filename.endswith(".json"):
                filepath = os.path.join(self.works_dir, filename)
                try:
                    with open(filepath, "r", encoding="utf-8") as f:
                        work = json.load(f)
                    works.append(work)
                except (json.JSONDecodeError, IOError) as e:
                    _logger.warning(f"[警告] 加载作品配置失败 {filename}: {e}")
        return works

    def get_work(self, work_id):
        """
        获取作品详情

        Args:
            work_id (str): 作品 ID

        Returns:
            dict or None: 作品配置，不存在则返回 None
        """
        filepath = self._work_filepath(work_id)
        if not os.path.exists(filepath):
            return None

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            _logger.warning(f"[警告] 加载作品配置失败 {work_id}: {e}")
            return None

    def get_work_public(self, work_id):
        """
        获取作品公开信息（不含 PAT Token 等敏感信息）

        Args:
            work_id (str): 作品 ID

        Returns:
            dict or None: 作品公开信息
        """
        work = self.get_work(work_id)
        if work is None:
            return None

        # 返回公开信息，隐藏敏感字段
        public_fields = [
            "id", "name", "description", "icon_url", "coze_bot_id",
            "interaction_type", "system_prompt", "prologue",
            "suggested_questions", "parameters", "model_name",
            "response_format", "is_public", "created_at", "updated_at",
            "coze_meta", "project_id"
        ]
        return {k: work.get(k) for k in public_fields if k in work}

    def update_work(self, work_id, updates):
        """
        更新作品配置

        Args:
            work_id (str): 作品 ID
            updates (dict): 需要更新的字段

        Returns:
            dict or None: 更新后的作品配置，不存在则返回 None
        """
        work = self.get_work(work_id)
        if work is None:
            return None

        work.update(updates)
        work["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self._save_work(work)
        return work

    def delete_work(self, work_id):
        """
        删除作品

        Args:
            work_id (str): 作品 ID

        Returns:
            bool: 是否删除成功
        """
        filepath = self._work_filepath(work_id)
        if os.path.exists(filepath):
            os.remove(filepath)
            return True
        return False

    def verify_access_code(self, work_id, code):
        """
        验证访问码

        Args:
            work_id (str): 作品 ID
            code (str): 用户输入的访问码

        Returns:
            bool: 验证是否通过
        """
        work = self.get_work(work_id)
        if work is None:
            return False

        access_code = work.get("access_code", "")
        if not access_code:
            # 没有设置访问码，直接通过
            return True

        return access_code == code

    def work_exists(self, work_id):
        """检查作品是否存在"""
        return os.path.exists(self._work_filepath(work_id))

    def _save_work(self, work_config):
        """保存作品配置到文件（先写 .tmp 再原子替换，线程安全）"""
        filepath = self._work_filepath(work_config["id"])
        tmp_path = filepath + ".tmp"
        with _save_lock:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(work_config, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, filepath)

    def _work_filepath(self, work_id):
        """获取作品配置文件路径"""
        return os.path.join(self.works_dir, f"{work_id}.json")

    def _generate_id(self):
        """生成唯一 ID（完整 32 位 hex，规避短 ID 碰撞风险）"""
        return uuid.uuid4().hex

    def _map_component_type(self, coze_type):
        """映射 Coze 组件类型到本地参数类型（公共映射，见 modules/common/mapping.py）"""
        return map_component_type(coze_type)
