"""
配置文件读写模块
负责 global_config.json 的加载与保存
"""

import json
import os
import secrets
import threading
import logging

from werkzeug.security import generate_password_hash

# 模块级写入锁（保证 _write_json 原子性）
_write_lock = threading.Lock()

# 模块级 logger
_logger = logging.getLogger(__name__)

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
            default["admin_password"] = self._hash_password(self._generate_password())
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
                config["admin_password"] = self._hash_password(self._generate_password())
                self.save_global_config(config)
            else:
                # 兼容旧明文数据：若已存明文（非 werkzeug 哈希格式），迁移为哈希并回写
                stored = config["admin_password"]
                if not self._is_hashed(stored):
                    config["admin_password"] = self._hash_password(stored)
                    self.save_global_config(config)
            return config
        except (json.JSONDecodeError, IOError) as e:
            _logger.warning(f"[警告] 加载全局配置失败: {e}，使用默认配置")
            default = dict(DEFAULT_GLOBAL_CONFIG)
            default["admin_password"] = self._hash_password(self._generate_password())
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
        # 若传入明文 admin_password，先哈希再落库（安全整改：不存明文）
        if "admin_password" in updates and updates.get("admin_password"):
            updates["admin_password"] = self._hash_password(updates["admin_password"])
        config.update(updates)
        self.save_global_config(config)
        return config

    def _generate_password(self):
        """生成随机管理密码（明文，调用方负责哈希后落库）"""
        return secrets.token_urlsafe(12)

    @staticmethod
    def _is_hashed(value: str) -> bool:
        """判断是否已是 werkzeug 哈希格式（pbkdf2:/scrypt: 前缀）。"""
        return isinstance(value, str) and (
            value.startswith("pbkdf2:") or value.startswith("scrypt:")
        )

    @staticmethod
    def _hash_password(plain: str) -> str:
        """明文密码 → werkzeug 哈希（存库格式）。"""
        return generate_password_hash(plain)

    def _write_json(self, filepath, data):
        """写入 JSON 文件（带缩进格式化，先写 .tmp 再原子替换，线程安全）"""
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        tmp_path = filepath + ".tmp"
        with _write_lock:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, filepath)
