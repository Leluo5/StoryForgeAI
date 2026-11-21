# -*- coding: utf-8 -*-
"""工作流管理路由：/api/workflows/* 生命周期管理。"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from ..common.errors import AppError, bad_request
from .types import GLOBAL_WORKFLOW_PROJECT_ID


def create_blueprint(service) -> Blueprint:
    """装配工作流管理蓝图（依赖注入 service）。"""
    bp = Blueprint("workflow_management", __name__, url_prefix="/api")

    def _ok(data, message: str = "ok"):
        return jsonify({"code": 0, "data": data, "message": message})

    @bp.errorhandler(AppError)
    def _handle_app_error(e: AppError):
        return jsonify({"code": e.code, "data": None, "message": e.message}), e.code

    def _pid():
        pid = request.args.get("project_id")
        if not pid:
            pid = (request.get_json(silent=True) or {}).get("project_id")
        return pid or GLOBAL_WORKFLOW_PROJECT_ID

    def _page_args():
        try:
            page = max(1, int(request.args.get("page", 1)))
            page_size = min(100, max(1, int(request.args.get("page_size", 20))))
        except ValueError:
            raise bad_request("page/page_size 须为整数")
        return page, page_size

    # ---------- Workflow CRUD ----------

    @bp.post("/workflows")
    def create_workflow():
        """新建工作流（手动创建），project_id 默认全局池。"""
        body = request.get_json(silent=True) or {}
        pid = body.get("project_id") or GLOBAL_WORKFLOW_PROJECT_ID
        return _ok(service.create_workflow(pid, body))

    @bp.get("/workflows")
    def list_workflows():
        """分页列出工作流，支持 status/keyword 过滤。"""
        pid = _pid()
        page, page_size = _page_args()
        items = service.list_workflows(
            pid,
            status=request.args.get("status"),
            keyword=request.args.get("keyword"),
        )
        total = len(items)
        start = (page - 1) * page_size
        return _ok({"items": items[start:start + page_size], "total": total})

    @bp.get("/workflows/<workflow_id>")
    def get_workflow(workflow_id: str):
        """读取单个工作流详情，可按 include_versions=true 返回版本快照。"""
        include = request.args.get("include_versions") == "true"
        return _ok(service.get_workflow(_pid(), workflow_id, include))

    @bp.put("/workflows/<workflow_id>")
    def update_workflow(workflow_id: str):
        """白名单字段更新工作流并生成版本快照。"""
        return _ok(service.update_workflow(
            _pid(), workflow_id, request.get_json(silent=True) or {}))

    @bp.post("/workflows/<workflow_id>/status")
    def set_status(workflow_id: str):
        """启用/禁用状态切换，body 携带 status。"""
        body = request.get_json(silent=True) or {}
        status = body.get("status")
        if not status:
            raise bad_request("status 不能为空")
        return _ok(service.set_status(_pid(), workflow_id, status))

    @bp.post("/workflows/<workflow_id>/archive")
    def archive_workflow(workflow_id: str):
        """归档工作流（归档后仍可恢复或删除）。"""
        return _ok(service.archive_workflow(_pid(), workflow_id))

    @bp.post("/workflows/<workflow_id>/restore")
    def restore_workflow(workflow_id: str):
        """将归档工作流恢复为 active。"""
        return _ok(service.restore_workflow(_pid(), workflow_id))

    @bp.delete("/workflows/<workflow_id>")
    def delete_workflow(workflow_id: str):
        """删除工作流；未归档且未 force=true 时返回 409。"""
        force = request.args.get("force") == "true"
        service.delete_workflow(_pid(), workflow_id, force=force)
        return _ok({"success": True})

    @bp.get("/workflows/<workflow_id>/versions")
    def list_versions(workflow_id: str):
        """列出工作流版本摘要（不含快照内容）。"""
        return _ok({"items": service.get_versions(_pid(), workflow_id)})

    @bp.post("/workflows/<workflow_id>/versions/<int:version_no>/rollback")
    def rollback(workflow_id: str, version_no: int):
        """回滚工作流到指定版本，生成新版本号。"""
        return _ok(service.rollback(_pid(), workflow_id, version_no))

    return bp
