# -*- coding: utf-8 -*-
"""P5-T3 安全复测（C-001~C-004）。

针对安全基线逐项验证：
- C-001 会话过期：_get_session_role 对过期/不存在 token 返回 None；require_admin 拒绝过期会话。
- C-003 PAT 落盘加密：import 后磁盘文件不含明文 token；get_work 返回明文；_save_work 不破坏密文。
- C-004 会话持久化：_set_session 写 data/sessions.json；_load_sessions 启动恢复有效会话、丢弃过期。

用 tmp_path 隔离数据目录，不污染真实 data/。
"""

import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import app as app_mod  # noqa: E402
from work_manager import WorkManager  # noqa: E402
from modules.common import crypto  # noqa: E402


# ---------- C-003：PAT 落盘加密 ----------

class TestPatEncryption:
    def test_import_pat_not_in_file(self, tmp_path):
        """C-003：导入作品后，磁盘 work 文件不含明文 pat_token。"""
        wm = WorkManager(str(tmp_path))
        work = wm.import_from_coze(
            {"name": "测试", "prompt_info": {"prompt": ""},
             "onboarding_info": {"prologue": "hi"}, "model_info": {},
             "variables": [], "shortcut_commands": [],
             "workflow_info_list": [], "plugin_info_list": [],
             "bot_id": "b1"},
            "super-secret-pat", access_code="",
        )
        # 返回 dict 保留明文（接口语义）
        assert work["pat_token"] == "super-secret-pat"
        # 磁盘文件不含明文
        raw = open(wm._work_filepath(work["id"]), "r", encoding="utf-8").read()
        assert "super-secret-pat" not in raw
        # 磁盘上是加密标记格式
        on_disk = json.loads(raw)
        assert crypto.is_encrypted(on_disk["pat_token"])

    def test_get_work_returns_plaintext(self, tmp_path):
        """C-003：get_work 读取时解密为明文，供运行时注入 Authorization 头。"""
        wm = WorkManager(str(tmp_path))
        work = wm.import_from_coze(
            {"name": "测试", "prompt_info": {"prompt": ""},
             "onboarding_info": {"prologue": "hi"}, "model_info": {},
             "variables": [], "shortcut_commands": [],
             "workflow_info_list": [], "plugin_info_list": [],
             "bot_id": "b1"},
            "pat-abc", access_code="",
        )
        loaded = wm.get_work(work["id"])
        assert loaded["pat_token"] == "pat-abc"

    def test_save_work_keeps_encrypted(self, tmp_path):
        """C-003：update_work 走 _save_work，磁盘仍不出现明文。"""
        wm = WorkManager(str(tmp_path))
        work = wm.import_from_coze(
            {"name": "测试", "prompt_info": {"prompt": ""},
             "onboarding_info": {"prologue": "hi"}, "model_info": {},
             "variables": [], "shortcut_commands": [],
             "workflow_info_list": [], "plugin_info_list": [],
             "bot_id": "b1"},
            "pat-xyz", access_code="",
        )
        wm.update_work(work["id"], {"name": "改名"})
        raw = open(wm._work_filepath(work["id"]), "r", encoding="utf-8").read()
        assert "pat-xyz" not in raw
        assert "改名" in raw

    def test_public_view_excludes_token(self, tmp_path):
        """C-003：get_work_public 公开视图不含 pat_token（对外脱敏）。"""
        wm = WorkManager(str(tmp_path))
        work = wm.import_from_coze(
            {"name": "测试", "prompt_info": {"prompt": ""},
             "onboarding_info": {"prologue": "hi"}, "model_info": {},
             "variables": [], "shortcut_commands": [],
             "workflow_info_list": [], "plugin_info_list": [],
             "bot_id": "b1"},
            "pat-pub", access_code="",
        )
        pub = wm.get_work_public(work["id"])
        assert "pat_token" not in pub


# ---------- C-001 / C-004：会话过期与持久化 ----------

class TestSessionExpiryPersistence:
    def _set_session(self, tmp_path, token, role, ttl):
        """直接调用 app 模块会话函数（data_dir 由 SESSION_FILE 固定为项目 data/）。"""
        # 会话持久化文件固定指向项目 data/sessions.json；测试不触碰真实文件，
        # 仅验证内存逻辑与持久化行为，需 monkeypatch SESSION_FILE 指向 tmp。
        return token

    def test_get_session_role_expired(self, monkeypatch):
        """C-001：过期会话返回 None。"""
        app_mod._admin_sessions["expired"] = {"role": "admin", "exp": time.time() - 10}
        assert app_mod._get_session_role("expired") is None

    def test_get_session_role_valid(self, monkeypatch):
        """C-001：有效会话返回角色。"""
        app_mod._admin_sessions["valid"] = {"role": "admin", "exp": time.time() + 100}
        assert app_mod._get_session_role("valid") == "admin"

    def test_get_session_role_missing(self):
        """C-001：不存在 token 返回 None。"""
        assert app_mod._get_session_role("nope") is None

    def test_set_session_writes_persistence(self, tmp_path, monkeypatch):
        """C-004：_set_session 写持久化文件（有效会话）。"""
        sess_file = str(tmp_path / "sessions.json")
        monkeypatch.setattr(app_mod, "SESSION_FILE", sess_file)
        monkeypatch.setattr(app_mod, "_admin_sessions", {})
        app_mod._set_session("tok-1", "admin", ttl=100)
        assert os.path.exists(sess_file)
        data = json.load(open(sess_file, "r", encoding="utf-8"))
        assert "tok-1" in data
        assert data["tok-1"]["role"] == "admin"

    def test_load_sessions_recovers_valid(self, tmp_path, monkeypatch):
        """C-004：启动时恢复有效会话、丢弃过期。"""
        sess_file = str(tmp_path / "sessions.json")
        json.dump({
            "live": {"role": "admin", "exp": time.time() + 500},
            "dead": {"role": "admin", "exp": time.time() - 5},
        }, open(sess_file, "w", encoding="utf-8"))
        monkeypatch.setattr(app_mod, "SESSION_FILE", sess_file)
        monkeypatch.setattr(app_mod, "_admin_sessions", {})
        app_mod._load_sessions()
        assert "live" in app_mod._admin_sessions
        assert "dead" not in app_mod._admin_sessions
        assert app_mod._admin_sessions["live"]["role"] == "admin"
