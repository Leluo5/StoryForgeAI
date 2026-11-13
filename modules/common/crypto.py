"""
敏感字段加解密模块（C-003：PAT Token 落盘加密）

提供 Fernet 对称加密，用于将 pat_token 等敏感字段加密后落盘，
磁盘上不出现明文 Token。主密钥来源优先级：
1. 环境变量 STORYFORGE_MASTER_KEY（推荐，生产用）
2. data/.master.key（开发用，.gitignore 保护，不提交 Git）
3. 首次使用自动生成并持久化到 data/.master.key

密钥轮换：更新 STORYFORGE_MASTER_KEY 后需重新导入作品（旧密文不可解密）。
"""

import os
import json
import threading

from cryptography.fernet import Fernet

# 敏感字段加密前缀：加密后的字段存储为 {"__enc__": <fernet_token>}，
# 便于 work_manager 识别并解密；非加密明文旧数据保持兼容（见 decrypt_value）。
_ENC_MARKER = "__enc__"

# 主密钥文件名（开发回退，位于 data/，已被 .gitignore 保护）
_DEFAULT_KEY_FILE = ".master.key"

_lock = threading.Lock()
_fernet = None  # 惰性初始化，单例


def _env_key() -> str:
    """从环境变量读取主密钥（可选）。"""
    return os.environ.get("STORYFORGE_MASTER_KEY", "")


def _load_or_create_key(data_dir: str) -> str:
    """获取主密钥：优先环境变量，否则读取/生成 data/.master.key。"""
    env = _env_key()
    if env:
        return env
    key_path = os.path.join(data_dir, _DEFAULT_KEY_FILE)
    if os.path.exists(key_path):
        with open(key_path, "r", encoding="utf-8") as f:
            return f.read().strip()
    os.makedirs(data_dir, exist_ok=True)
    key = Fernet.generate_key().decode()
    # 写临时文件再原子替换，避免半写；权限不刻意收紧（Windows 无 chmod 语义）
    tmp = key_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(key)
    os.replace(tmp, key_path)
    return key


def get_fernet(data_dir: str):
    """获取 Fernet 单例（线程安全惰性初始化）。"""
    global _fernet
    if _fernet is not None:
        return _fernet
    with _lock:
        if _fernet is None:
            key = _load_or_create_key(data_dir)
            _fernet = Fernet(key.encode())
    return _fernet


def encrypt_value(data_dir: str, plain: str) -> str:
    """加密字符串为带标记的密文（供落盘存储）。"""
    if not plain:
        return plain
    f = get_fernet(data_dir)
    token = f.encrypt(plain.encode("utf-8")).decode()
    # 用 dict 包装便于扩展（记录算法版本）
    return json.dumps({_ENC_MARKER: token}, ensure_ascii=False)


def decrypt_value(data_dir: str, stored: str) -> str:
    """解密落盘字段；非加密明文旧数据原样返回（兼容）。"""
    if not stored:
        return stored
    if isinstance(stored, str) and stored.startswith("{"):
        try:
            obj = json.loads(stored)
        except (ValueError, TypeError):
            return stored
        if isinstance(obj, dict) and _ENC_MARKER in obj:
            f = get_fernet(data_dir)
            try:
                return f.decrypt(obj[_ENC_MARKER].encode()).decode("utf-8")
            except Exception:
                # 密钥不匹配或密文损坏：返回空，避免泄露原始错误
                return ""
        return stored
    return stored


def is_encrypted(stored: str) -> bool:
    """判断字段是否为加密存储格式。"""
    if not stored or not isinstance(stored, str) or not stored.startswith("{"):
        return False
    try:
        obj = json.loads(stored)
    except (ValueError, TypeError):
        return False
    return isinstance(obj, dict) and _ENC_MARKER in obj


def reset_for_test():
    """测试专用：重置单例，便于切换 data_dir。"""
    global _fernet
    with _lock:
        _fernet = None
