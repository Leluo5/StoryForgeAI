# -*- coding: utf-8 -*-
"""全局配置中的模型配置默认值与对象隔离测试。"""

import json
import os
import sys
from copy import deepcopy

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from config_loader import DEFAULT_GLOBAL_CONFIG, ConfigLoader  # noqa: E402


DEFAULT_MODEL_CONFIG = {
    "models": [],
    "default_model": "default",
    "route_rules": [],
}
HASHED_PASSWORD = "pbkdf2:sha256:1000$salt$hash"


def _write_config(data_dir, config):
    os.makedirs(data_dir, exist_ok=True)
    with open(os.path.join(data_dir, "global_config.json"), "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False)


def test_load_model_config_defaults_for_new_config(tmp_path):
    config = ConfigLoader(str(tmp_path)).load_global_config()

    assert config["model_config"] == DEFAULT_MODEL_CONFIG


def test_load_model_config_defaults_for_legacy_config(tmp_path):
    _write_config(str(tmp_path), {"admin_password": HASHED_PASSWORD})

    config = ConfigLoader(str(tmp_path)).load_global_config()

    assert config["model_config"] == DEFAULT_MODEL_CONFIG


def test_load_model_config_completes_partial_config(tmp_path):
    models = [{"id": "model-a"}]
    _write_config(
        str(tmp_path),
        {"admin_password": HASHED_PASSWORD, "model_config": {"models": models}},
    )

    config = ConfigLoader(str(tmp_path)).load_global_config()

    assert config["model_config"] == {
        "models": models,
        "default_model": "default",
        "route_rules": [],
    }


@pytest.mark.parametrize("legacy_config", [False, True], ids=["new-config", "legacy-config"])
def test_model_config_does_not_share_mutable_defaults(tmp_path, legacy_config):
    if legacy_config:
        for name in ("first", "second"):
            _write_config(str(tmp_path / name), {"admin_password": HASHED_PASSWORD})
    original_default = deepcopy(DEFAULT_GLOBAL_CONFIG)
    first = ConfigLoader(str(tmp_path / "first")).load_global_config()
    second = ConfigLoader(str(tmp_path / "second")).load_global_config()

    first["model_config"]["models"].append({"id": "changed"})
    first["model_config"]["default_model"] = "changed"
    first["model_config"]["route_rules"].append({"scene": "changed"})

    assert second["model_config"] == DEFAULT_MODEL_CONFIG
    assert DEFAULT_GLOBAL_CONFIG == original_default
