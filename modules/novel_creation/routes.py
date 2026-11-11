# modules/novel_creation/routes.py —— /api/novel/* 全部路由（蓝图工厂）
# 路由规划（见知识库模块拆分说明 §5.2）：
#   POST /api/novel/projects          创建/打开项目
#   POST /api/novel/roles             绑定/列出角色
#   POST /api/novel/agents/invoke     角色 Agent 有序调用
#   POST /api/novel/collab            多角色协同

from flask import Blueprint


def create_blueprint() -> Blueprint:
    """创建小说创作模块蓝图。"""
    bp = Blueprint("novel_creation", __name__)
    # TODO(P3-T4/T5/T6): 注册上述路由
    return bp
