#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
后端代码规范违规检查脚本
对应规范：《开发规范》01-基础约定与后端规范.md（第二节~第三节）
检查项：缩进(Tab)、行宽>100、裸except、print残留、裸jsonify(非契约)、
        无docstring(公开函数)、命名风格(snake_case/PascalCase/UPPER)、
        参数>5、混用引号、函数内import、敏感字段日志、模块间跨模块import。

用法:
    python scripts/check_backend.py [--path 根目录] [--quiet]
退出码: 0=无违规, 1=存在违规
"""
import argparse
import ast
import os
import re
import sys

# ---------- 配置 ----------
ROOT_DEFAULT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET_PY = re.compile(r"\.py$")
# 后端相关文件（排除测试、docs-archive、static/templates、scripts 自身）
EXCLUDE_DIRS = {"__pycache__", ".git", "docs-archive", "docs", "data", ".pytest_cache", "tests", "node_modules", "scripts", ".uploads", ".vscode"}
# 敏感字段（安全规范 2.1）
SENSITIVE_KEYS = {"pat_token", "access_code", "api_key", "secret", "token"}
# 模块间跨模块 import 检查：modules/<模块>/ 禁止 import 其它模块内部符号
MODULE_DIR = "modules"


class Violation:
    """一条违规记录"""

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
    """收集后端 .py 文件"""
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if TARGET_PY.search(fn):
                files.append(os.path.join(dirpath, fn))
    return files


def check_indent_and_width(path, violations):
    """检查缩进(Tab) 与行宽(>100)"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f, 1):
            if "\t" in line[: line.find(line.lstrip())] if line.strip() else False:
                # 行首存在 Tab 缩进
                if line.startswith("\t") or re.match(r"^\s*\t", line):
                    violations.append(Violation(path, i, "3.1-缩进", "使用 Tab 缩进，应改为 4 空格"))
            if len(line.rstrip("\n")) > 100:
                violations.append(Violation(path, i, "3.1-行宽", f"行宽 {len(line.rstrip())}>100", "SHOULD"))


def check_import_order(path, violations):
    """检查 import 顺序：标准库->第三方->本地，及函数内 import"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    # 函数内 import（缩进级别>0 的 import）
    for i, line in enumerate(lines, 1):
        if re.match(r"^\s+(import|from)\s", line):
            violations.append(Violation(path, i, "3.1-导入顺序", "函数内 import，应移至模块顶部统一分组", "SHOULD"))


def check_ast(path, violations):
    """AST 级检查：裸except、print、命名、参数、docstring、敏感字段日志、跨模块import"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
        tree = ast.parse(src, filename=path)
    except (SyntaxError, UnicodeDecodeError) as e:
        violations.append(Violation(path, 1, "语法", f"解析失败: {e}"))
        return

    # 模块 docstring
    has_module_doc = bool(ast.get_docstring(tree, clean=False))
    if not has_module_doc and os.path.basename(path) not in ("__init__.py",):
        violations.append(Violation(path, 1, "3.2-docstring", "模块缺少 docstring"))

    for node in ast.walk(tree):
        # 裸 except
        if isinstance(node, ast.ExceptHandler) and node.type is None:
            violations.append(Violation(path, node.lineno, "3.3-裸except", "裸 `except:` 吞掉所有异常，应捕获具体异常"))
        # print 残留
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "print":
            violations.append(Violation(path, node.lineno, "3.3-print", "print() 调试残留，应改 app.logger / logging"))
        # 敏感字段日志（logger.info(pat) 形式）
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("info", "warning", "error", "debug"):
            if isinstance(node.func.value, ast.Name) and node.func.value.id in ("logger", "app", "logging"):
                for arg in node.args:
                    if isinstance(arg, ast.Name) and arg.id in SENSITIVE_KEYS:
                        violations.append(Violation(path, node.lineno, "安全-敏感日志", f"日志记录敏感字段 {arg.id}，应用 *** 占位"))
        # 公开函数命名 + docstring + 参数个数
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if not node.name.startswith("_") and not node.name.startswith("test_"):
                # 命名 snake_case
                if not re.match(r"^[a-z_][a-z0-9_]*$", node.name):
                    violations.append(Violation(path, node.lineno, "3.1-命名", f"函数名 {node.name} 非 snake_case"))
                # docstring
                if not ast.get_docstring(node, clean=False):
                    violations.append(Violation(path, node.lineno, "3.2-docstring", f"公开函数 {node.name}() 缺少 docstring"))
                # 参数个数
                arg_count = len(node.args.args) + len(node.args.kwonlyargs)
                if arg_count > 5:
                    violations.append(Violation(path, node.lineno, "3.2-参数", f"函数 {node.name}() 参数 {arg_count}>5，应聚合 dataclass", "SHOULD"))
        # 类命名 PascalCase
        if isinstance(node, ast.ClassDef):
            if not re.match(r"^[A-Z][A-Za-z0-9]*$", node.name):
                violations.append(Violation(path, node.lineno, "3.1-命名", f"类名 {node.name} 非 PascalCase"))
        # 模块级常量 UPPER（大写名但非全大写）
        if isinstance(node, ast.Assign) and isinstance(node.value, (ast.Constant, ast.List, ast.Dict, ast.Tuple)):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name) and re.match(r"^[a-z][a-zA-Z0-9]*$", tgt.id):
                    if tgt.id.isupper() is False and tgt.id.islower() is False and re.search(r"[A-Z]", tgt.id):
                        # camelCase 常量
                        if re.match(r"^[a-z]+[A-Z]", tgt.id):
                            violations.append(Violation(path, node.lineno, "3.1-命名", f"常量 {tgt.id} 应 UPPER_SNAKE_CASE"))

    # 模块间跨模块 import（modules/<模块>/xxx.py import modules/<另一模块>）
    rel = os.path.relpath(path, ROOT)
    if rel.startswith(MODULE_DIR + os.sep):
        parts = rel.split(os.sep)
        if len(parts) >= 2 and parts[1] not in ("common", "__init__.py"):
            cur_module = parts[1]
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module:
                    if node.module.startswith("modules."):
                        imported = node.module.split(".")[1]
                        if imported != cur_module and imported != "common":
                            violations.append(Violation(path, node.lineno, "3.6-跨模块", f"模块 {cur_module} import 其它模块内部符号 {imported}（应走 common）"))


def check_quotes(path, violations):
    """检查引号混用（文件级别启发式）"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()
    # 去掉注释后统计单/双引号使用（简单启发式：字符串字面量中双引号 vs 单引号）
    single = len(re.findall(r"(?<![\w])'[^'\n]*'", src))
    double = len(re.findall(r'"[^"\n]*"', src))
    if single > 3 and double > 3:
        violations.append(Violation(path, 1, "3.1-引号", f"引号混用（单引号 {single} 处 / 双引号 {double} 处），应统一双引号", "SHOULD"))


def check_bare_jsonify(path, violations):
    """检查裸 jsonify 非契约结构（{error:} / {success:} 等）"""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    for i, line in enumerate(lines, 1):
        if "jsonify(" in line:
            # 裸结构：{"error": 或 {"success": 或 {"works": 等非 {code,data,message}
            stripped = line.strip()
            if re.search(r'jsonify\(\s*\{"(error|success|works|data|message)\s*:', stripped):
                violations.append(Violation(path, i, "3.3-响应契约", "裸 jsonify 非统一 {code,data,message} 结构"))


def main():
    parser = argparse.ArgumentParser(description="后端规范违规检查")
    parser.add_argument("--path", default=ROOT_DEFAULT, help="项目根目录")
    parser.add_argument("--quiet", action="store_true", help="仅输出统计")
    args = parser.parse_args()
    global ROOT
    ROOT = args.path

    all_violations = []
    for pyf in collect_py_files(ROOT):
        v = []
        check_indent_and_width(pyf, v)
        check_import_order(pyf, v)
        check_ast(pyf, v)
        check_quotes(pyf, v)
        check_bare_jsonify(pyf, v)
        all_violations.extend(v)

    # 输出
    if not args.quiet:
        for vio in all_violations:
            print(vio)
    must = sum(1 for x in all_violations if x.severity == "MUST")
    should = sum(1 for x in all_violations if x.severity == "SHOULD")
    print(f"\n[check_backend] 共 {len(all_violations)} 条违规（MUST {must} / SHOULD {should}）")
    return 1 if all_violations else 0


if __name__ == "__main__":
    sys.exit(main())
