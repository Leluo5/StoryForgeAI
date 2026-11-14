# -*- coding: utf-8 -*-
"""ModelRouter 模型列表、默认模型与场景路由测试。"""

import os
import sys
from typing import Any, Dict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.novel_creation.model_router import ModelRouter


class _FakeConfig:
    def __init__(self) -> None:
        self.model_config: Dict[str, Any] = {
            "models": ["gpt-4o", "claude-3-5"],
            "default_model": "gpt-4o",
            "route_rules": [
                {"scene": "character_detail", "model": "claude-3-5"},
            ],
        }

    def load_global_config(self) -> Dict[str, Any]:
        return {"model_config": self.model_config}


def test_list_models() -> None:
    router = ModelRouter(_FakeConfig())

    assert router.list_models() == ["gpt-4o", "claude-3-5"]


def test_get_default_model() -> None:
    router = ModelRouter(_FakeConfig())

    assert router.get_default_model() == "gpt-4o"


def test_resolve_scene_uses_latest_config() -> None:
    config = _FakeConfig()
    router = ModelRouter(config)

    assert router.resolve("character_detail") == "claude-3-5"

    config.model_config["route_rules"] = [
        {"scene": "character_detail", "model": "gpt-4o"},
    ]
    assert router.resolve("character_detail") == "gpt-4o"


def test_resolve_no_match_falls_back() -> None:
    router = ModelRouter(_FakeConfig())

    assert router.resolve("unknown_scene") == "gpt-4o"


def test_resolve_override_takes_priority() -> None:
    router = ModelRouter(_FakeConfig())

    assert router.resolve("character_detail", override="gpt-4o") == "gpt-4o"
