# modules/knowledge_base/routes.py —— /api/knowledge/* 全部路由（蓝图工厂）
# 拆分说明：由 app.py 原知识库路由外迁（get_datasets / import 等），app.py 仅注册蓝图。
# 说明：本文件为架构骨架，路由实现随 P4-T18 编码落地；当前保留入口签名。

from flask import Blueprint


def create_blueprint() -> Blueprint:
    """创建知识库模块蓝图。

    路由规划（见知识库模块拆分说明 §5.2）：
      GET  /api/knowledge/datasets             拉取 Coze 知识库列表
      POST /api/knowledge/import               dataset 导入转作品
      POST /api/knowledge/entries              新增条目（粘贴/上传/OCR）
      GET  /api/knowledge/entries              统一检索
      PUT  /api/knowledge/entries/<id>         条目编辑
      DELETE /api/knowledge/entries/<id>       条目删除
      POST /api/knowledge/entries/<id>/split   结构化拆分
      POST /api/knowledge/entries/<id>/link    跨条目关联
      POST /api/knowledge/entries/<id>/outline 大纲自动提取（v1.1）
    """
    bp = Blueprint("knowledge_base", __name__)
    # TODO(P4-T18): 注册上述路由
    return bp
