# -*- coding: utf-8 -*-
"""模型路由层：全局配置 + 动态指定 + 按场景路由。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional


class ModelRouter:
    """根据实时全局配置解析模型，支持场景规则和显式覆盖。"""

    def __init__(self, config_loader: Any, default_model: str = "default") -> None:
        """注入配置加载器，并设置未配置默认模型时的回退值。"""
        self._config_loader = config_loader
        self._fallback_default = default_model

    def _model_config(self) -> Dict[str, Any]:
        cfg = self._config_loader.load_global_config() or {}
        return cfg.get("model_config", {}) or {}

    def list_models(self) -> List[str]:
        """返回当前配置的可用模型列表。"""
        return list(self._model_config().get("models", []))

    def get_default_model(self) -> str:
        """返回当前配置的默认模型，缺省时使用构造参数回退值。"""
        return self._model_config().get("default_model") or self._fallback_default

    def resolve(self, scene: str, override: Optional[str] = None) -> str:
        """优先返回显式覆盖模型，其次匹配场景规则，最后返回默认模型。"""
        if override:
            return override
        model_config = self._model_config()
        for rule in model_config.get("route_rules", []):
            if rule.get("scene") == scene:
                return rule.get("model") or self.get_default_model()
        return self.get_default_model()
