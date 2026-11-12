# -*- coding: utf-8 -*-
"""角色随机生成器（F8-T1：随机生成字段池 + seed 复现 + 年龄段归档）。

对齐 F8 技术方案 §3.4：
- 字段池可配置：从 `config/role_map_pools.json` 加载，新增条目即时生效。
- 随机种子：生成函数接受 `seed` 参数，同一 seed 产出可复现结果（测试断言用固定 seed）。
- 年龄段归档：`age_group` 由 `age` 自动映射（少年 16-25 / 青年 26-45 / 中年 46-60 / 老年 61-70），不单独随机。

职责：仅负责「随机生成一个角色草稿」，不落库、不 import 领域 store（解耦）。
返回的 dict 字段与 RoleStore 的 `_ROLE_EXTRA_DEFAULTS` 对齐，可传给 create_role(**payload)。
"""

from __future__ import annotations

import json
import os
import random
from typing import Any, Dict, List, Optional

# 字段池配置文件名（相对项目根）
POOLS_FILENAME = "role_map_pools.json"

# 默认字段池（配置文件缺失/损坏时兜底，保证生成器仍可用）
_DEFAULT_POOLS: Dict[str, Any] = {
    "name_pool": {
        "surnames": ["林", "沈", "苏", "顾"],
        "given_names": ["风眠", "雪落", "惊蛰", "青鸾"],
    },
    "identity_pool": ["主角", "配角", "反派"],
    "nationality_pool": ["中原", "北境"],
    "faith_pool": ["无", "天道"],
    "camp_pool": ["正道", "魔道"],
    "race_pool": ["人族", "妖族"],
    "profession_pool": ["剑客", "术士"],
    "personality_pool": ["冷静", "热血"],
    "background_pool": ["出身名门，因家族变故流落江湖"],
    "attribute_ranges": {
        "age": {"min": 16, "max": 70},
        "gender_pool": ["男", "女"],
    },
}

# 年龄段边界（含边界，左闭右闭）：少年 16-25 / 青年 26-45 / 中年 46-60 / 老年 61-70
_AGE_GROUPS: List[Dict[str, Any]] = [
    {"label": "少年", "min": 16, "max": 25},
    {"label": "青年", "min": 26, "max": 45},
    {"label": "中年", "min": 46, "max": 60},
    {"label": "老年", "min": 61, "max": 70},
]

# 可生成的字段（除 name/age/gender 由 attribute_ranges 特殊处理外，其余走对应 pool）
_GENERATABLE_FIELDS = [
    "identity", "nationality", "faith", "camp", "race", "profession",
]


def load_pools(pools_path: Optional[str] = None) -> Dict[str, Any]:
    """加载字段池配置；文件缺失/损坏时返回默认池（不抛异常）。

    参数 pools_path 可注入（测试用临时文件），默认相对项目根 config/。
    """
    if pools_path is None:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        pools_path = os.path.join(base_dir, "config", POOLS_FILENAME)
    try:
        with open(pools_path, "r", encoding="utf-8") as f:
            pools = json.load(f)
        if not isinstance(pools, dict):
            return dict(_DEFAULT_POOLS)
        # 合并默认池：缺失键用默认兜底（保证结构完整）
        merged = dict(_DEFAULT_POOLS)
        for key, value in pools.items():
            if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
                merged[key].update(value)
            else:
                merged[key] = value
        return merged
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return dict(_DEFAULT_POOLS)


def classify_age_group(age: Optional[int]) -> str:
    """年龄 → 年龄段（少年/青年/中年/老年）。

    边界规则（左闭右闭）：
    - 16-25 少年；26-45 青年；46-60 中年；61-70 老年。
    - 超出 [16, 70] 或非整数 → 返回 ""（不归档，前端可标红待补）。
    """
    if age is None:
        return ""
    if isinstance(age, bool) or not isinstance(age, int):
        # 兼容字符串数字
        try:
            age = int(str(age).strip())
        except (TypeError, ValueError):
            return ""
    for group in _AGE_GROUPS:
        if group["min"] <= age <= group["max"]:
            return group["label"]
    return ""


def _pick(rng: random.Random, values: List[str]) -> str:
    """从列表安全随机取一项（空列表返回 ""）。"""
    if not values:
        return ""
    return rng.choice(values)


def generate_random_role(
    pools: Optional[Dict[str, Any]] = None,
    seed: Optional[int] = None,
    overrides: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """随机生成一个角色草稿（不落库）。

    参数：
    - pools: 字段池（默认 load_pools()）。
    - seed: 随机种子；None 用系统随机，同一 seed 产出可复现结果。
    - overrides: 覆盖字段（如 {"name": "指定名", "age": 30}），优先级最高。

    返回字段与 RoleStore._ROLE_EXTRA_DEFAULTS 对齐：
    name/age/gender + identity/nationality/faith/camp/race/profession/age_group
    + attributes（含性格/背景/随机种子）/relations=[]。
    """
    if pools is None:
        pools = load_pools()
    rng = random.Random(seed)

    # 属性范围
    ranges = pools.get("attribute_ranges", {}) or {}
    age_range = ranges.get("age", {}) or {}
    age_min = int(age_range.get("min", 16))
    age_max = int(age_range.get("max", 70))
    gender_pool = ranges.get("gender_pool", []) or ["男", "女"]

    # 姓名池
    name_pool = pools.get("name_pool", {}) or {}
    surname = _pick(rng, name_pool.get("surnames", []))
    given = _pick(rng, name_pool.get("given_names", []))
    name = (surname + given) if (surname and given) else (surname or given)

    age = rng.randint(age_min, age_max)
    gender = _pick(rng, gender_pool)
    personality = _pick(rng, pools.get("personality_pool", []))
    background = _pick(rng, pools.get("background_pool", []))

    role: Dict[str, Any] = {
        "name": name,
        "age": age,
        "gender": gender,
        "age_group": classify_age_group(age),
        "attributes": {
            "personality": personality,
            "background": background,
            "random_seed": seed,
        },
        "relations": [],
    }
    for field in _GENERATABLE_FIELDS:
        pool = pools.get(f"{field}_pool", [])
        role[field] = _pick(rng, pool)

    # 覆盖字段（最高优先级）：overrides 可覆盖任何可生成字段
    if overrides:
        role.update(overrides)
        # 若覆盖了 age，重新归档 age_group（除非显式给 age_group）
        if "age" in overrides and "age_group" not in overrides:
            role["age_group"] = classify_age_group(role.get("age"))

    return role
