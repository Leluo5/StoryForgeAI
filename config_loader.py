"""
配置文件读写模块
负责 global_config.json 的加载与保存
"""

import json
import os
import secrets

# 默认全局配置
DEFAULT_GLOBAL_CONFIG = {
    "version": "2.0.0",
    "admin_password": "",
    "site_name": "StoryForgeAI",
    "site_description": "AI 作品展示平台",
    "theme": "light"
}


class ConfigLoader:
    """配置加载器，管理全局配置"""

    def __init__(self, data_dir=None):
        """
        初始化配置加载器

        Args:
            data_dir: 数据目录路径，默认为项目根目录下的 data/
        """
        if data_dir is None:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            data_dir = os.path.join(base_dir, "data")
        self.data_dir = data_dir
        self.global_config_path = os.path.join(data_dir, "global_config.json")

        # 确保 data 目录存在
        os.makedirs(data_dir, exist_ok=True)

    def load_global_config(self):
        """
        加载全局配置文件，如果不存在则创建默认配置

        Returns:
            dict: 全局配置字典
        """
        if not os.path.exists(self.global_config_path):
            default = dict(DEFAULT_GLOBAL_CONFIG)
            default["admin_password"] = self._generate_password()
            self.save_global_config(default)
            return default

        try:
            with open(self.global_config_path, "r", encoding="utf-8") as f:
                config = json.load(f)
            # 确保必要字段存在
            for key, value in DEFAULT_GLOBAL_CONFIG.items():
                if key not in config:
                    config[key] = value
            if not config.get("admin_password"):
                config["admin_password"] = self._generate_password()
                self.save_global_config(config)
            return config
        except (json.JSONDecodeError, IOError) as e:
            print(f"[警告] 加载全局配置失败: {e}，使用默认配置")
            default = dict(DEFAULT_GLOBAL_CONFIG)
            default["admin_password"] = self._generate_password()
            return default

    def save_global_config(self, config):
        """
        保存全局配置文件

        Args:
            config (dict): 全局配置字典
        """
        self._write_json(self.global_config_path, config)

    def update_global_config(self, updates):
        """
        更新全局配置（部分更新）

        Args:
            updates (dict): 需要更新的字段

        Returns:
            dict: 更新后的完整配置
        """
        config = self.load_global_config()
        config.update(updates)
        self.save_global_config(config)
        return config

    def _generate_password(self):
        """生成随机管理密码"""
        return secrets.token_urlsafe(12)

    def _write_json(self, filepath, data):
        """写入 JSON 文件（带缩进格式化）"""
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
