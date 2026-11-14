#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
安全与数据规范违规检查脚本
对应规范：《开发规范》04-安全与数据规范.md（第二节安全、第三节数据）
检查项：敏感字段出站(响应含 api_key/pat_token)、明文密码(==比较/存JSON)、
        原子写(JSON写无 .tmp+os.replace)、文件上传无白名单/无大小上限、
        密码哈希缺失(存明文)、恒时比较缺失、任意文件读取路径穿越。

用法:
    python scripts/check_security.py [--path 根目录] [--quiet]
退出码: 0=无违规, 1=存在违规
"""
import argparse
import os
import re
import sys

ROOT_DEFAULT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXCLUDE_DIRS = {"__pycache__", ".git", "docs-archive", "docs", "data", ".pytest_cache", "tests", "node_modules", ".uploads", "scripts", ".venv", "venv", ".tox"}
SENSITIVE_FIELDS = {"api_key", "pat_token", "access_code", "password", "secret"}


class Violation:
    def __init__(self, file, line, rule, message, severity="MUST"):
        self.file = file
        self.line = line
        self.rule = rule
        self.message = message
        self.severity = severity

    def __repr__(self):
        return f"{self.severity} | {os.path.relpath(self.file, ROOT)}:{self.line} | {self.rule} | {self.message}"


ROOT = ROOT_DEFAULT


def collect_py_files(root):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if fn.endswith(".py"):
                files.append(os.path.join(dirpath, fn))
    return files


def check_sensitive_outbound(path, violations):
    """检查响应返回敏感字段（jsonify(...api_key...) / return {...敏感...}）"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    for i, line in enumerate(lines, 1):
        if "jsonify(" in line or "return" in line:
            for field in SENSITIVE_FIELDS:
                # 排除 get_work_public / 脱敏 / 剥离 / 占位 *** 的上下文
                if f'"{field}"' in line or f"'{field}'" in line:
                    # 若是脱敏(***)或剥离(placeholder/"" )跳过
                    if "***" in line or "pop(" in line or "placeholder" in line or "del " in line:
                        continue
                    violations.append(Violation(path, i, "安全-敏感出站", f"响应可能返回敏感字段 {field}，应剥离/脱敏"))


def check_plaintext_password(path, violations):
    """检查明文密码比较(== password) 与 JSON 存明文 password"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    for i, line in enumerate(lines, 1):
        # 明文 == 比较
        if re.search(r"password\s*==\s*['\"]", line) or re.search(r"==\s*\w*password\b", line):
            if "check_password_hash" not in line and "==" in line:
                violations.append(Violation(path, i, "安全-明文密码", "密码用明文 == 比较，应 check_password_hash 恒时比较"))
        # JSON 存明文
        if re.search(r'["\']password["\']\s*:\s*["\']', line) and "generate_password_hash" not in line:
            violations.append(Violation(path, i, "安全-明文密码", "JSON 直接存明文 password，应存哈希"))


def check_atomic_write(path, violations):
    """检查 JSON 写入无原子写(open(path,'w') 直接写)"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()
    # 找到写文件的地方
    for m in re.finditer(r"open\(([^)]+)[,\s]*['\"]w['\"]", src):
        line_no = src[: m.start()].count("\n") + 1
        context = src[max(0, m.start() - 200) : m.end() + 200]
        if ".tmp" not in context and "os.replace" not in context:
            violations.append(Violation(path, line_no, "数据-原子写", "open(...,'w') 直接写，应先写 .tmp 再 os.replace 原子替换"))


def _func_context(lines, i):
    """取包含第 i 行（1-based）的整个函数体文本，避免 ±N 行窗口漏掉函数内校验"""
    start = max(0, i - 1)
    while start > 0 and not lines[start - 1].strip().startswith(("def ", "@")):
        start -= 1
    end = i
    while end < len(lines):
        s = lines[end].strip()
        if (s.startswith(("def ", "@")) and end != i - 1) or s.startswith("class "):
            break
        end += 1
    return "".join(lines[start:end])


def check_file_upload(path, violations):
    """检查 HTTP 文件上传缺白名单/大小上限（仅 Flask 路由层）"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    for i, line in enumerate(lines, 1):
        # 仅匹配 HTTP 上传入口：request.files
        if "request.files" in line:
            context = _func_context(lines, i)
            if "ALLOWED_EXT" not in context and "allowed" not in context.lower() and "whitelist" not in context.lower():
                violations.append(Violation(path, i, "安全-文件上传", "文件上传缺扩展名白名单校验", "SHOULD"))
            if "MAX_CONTENT_LENGTH" not in context and "max_size" not in context and "max_bytes" not in context:
                violations.append(Violation(path, i, "安全-文件上传", "文件上传缺大小上限校验", "SHOULD"))


def check_path_traversal(path, violations):
    """检查路径穿越(send_file 用未校验 user 输入 / os.path.join 拼接 user 文件名)"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    for i, line in enumerate(lines, 1):
        if "send_file" in line or "send_from_directory" in line:
            if "os.path.basename" not in line and "secure" not in line.lower() and ".." in line:
                violations.append(Violation(path, i, "安全-路径穿越", "send_file 未校验路径，防 .. 路径穿越", "SHOULD"))


def main():
    parser = argparse.ArgumentParser(description="安全与数据规范违规检查")
    parser.add_argument("--path", default=ROOT_DEFAULT)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    global ROOT
    ROOT = args.path

    all_v = []
    for pyf in collect_py_files(ROOT):
        v = []
        check_sensitive_outbound(pyf, v)
        check_plaintext_password(pyf, v)
        check_atomic_write(pyf, v)
        check_file_upload(pyf, v)
        check_path_traversal(pyf, v)
        all_v.extend(v)

    if not args.quiet:
        for vio in all_v:
            print(vio)
    must = sum(1 for x in all_v if x.severity == "MUST")
    should = sum(1 for x in all_v if x.severity == "SHOULD")
    print(f"\n[check_security] 共 {len(all_v)} 条违规（MUST {must} / SHOULD {should}）")
    return 1 if all_v else 0


if __name__ == "__main__":
    sys.exit(main())
