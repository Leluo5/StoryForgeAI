"""模块间共享类型。

RoleContextDTO：知识库条目注入角色上下文（只读）的公共载体，
知识库 -> 小说创作单向传递，无代码依赖。
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class RoleContextDTO:
    """角色上下文公共载体（只读注入）。

    知识库模块（F5）构造并填充；小说创作模块（P3/P4）读取。
    约束：角色不可写知识库条目，本 DTO 携带的知识库引用为只读。
    """
    role_id: str
    project_id: str
    knowledge_entries: List[Dict[str, Any]] = field(default_factory=list)
    memory_state: Optional[Dict[str, Any]] = None
    extra: Dict[str, Any] = field(default_factory=dict)
