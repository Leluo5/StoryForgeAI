"""统一错误码。

与改造路线图 §2.3 错误码对齐：400/401/403/404/409/500/502。
"""

class AppError(Exception):
    """应用统一异常基类。"""

    def __init__(self, code: int = 500, message: str = "内部错误", detail: str = ""):
        self.code = code
        self.message = message
        self.detail = detail
        super().__init__(f"[{code}] {message} {detail}".strip())

    @property
    def status_code(self) -> int:
        """Flask 异常协议兼容：HTTP 状态码即错误码。"""
        return self.code


def bad_request(message: str = "请求参数错误", detail: str = "") -> AppError:
    """构造 400 请求参数错误。"""
    return AppError(400, message, detail)


def unauthorized(message: str = "未授权", detail: str = "") -> AppError:
    """构造 401 未授权。"""
    return AppError(401, message, detail)


def not_found(message: str = "资源不存在", detail: str = "") -> AppError:
    """构造 404 资源不存在。"""
    return AppError(404, message, detail)


def forbidden(message: str = "禁止访问", detail: str = "") -> AppError:
    """构造 403 禁止访问。"""
    return AppError(403, message, detail)


def conflict(message: str = "资源冲突", detail: str = "") -> AppError:
    """构造 409 资源冲突。"""
    return AppError(409, message, detail)


def server_error(message: str = "服务器错误", detail: str = "") -> AppError:
    """构造 500 服务器错误。"""
    return AppError(500, message, detail)


def bad_gateway(message: str = "上游服务异常", detail: str = "") -> AppError:
    """构造 502 上游服务异常。"""
    return AppError(502, message, detail)
