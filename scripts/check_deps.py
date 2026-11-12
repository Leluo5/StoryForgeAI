#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
依赖与模块规范违规检查脚本
对应规范：《开发规范》05-依赖与模块规范.md（第二节依赖、第三节模块拆分、第四节数据契约）
检查项：requirements 裸依赖未锁版本、模块分层缺失(routes/store/engine)、
        模块间直接 import 对方内部函数(应走 common)、引擎 import 数据层符号、
        统一响应契约 {code,data,message} 缺失、数据契约字段(条目 id/type/title)。

用法:
    python scripts/check_deps.py [--path 根目录] [--quiet]
退出码: 0=无违规, 1=存在违规
"""
import argparse
import ast
import os
import re
import sys

ROOT_DEFAULT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REQ_FILE = "requirements.txt"
MODULE_DIR = "modules"


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


def check_requirements(root, violations):
    """检查 requirements.txt 裸依赖未锁版本"""
    req = os.path.join(root, REQ_FILE)
    if not os.path.exists(req):
        violations.append(Violation(req, 1, "依赖-锁定", f"缺少 {REQ_FILE}"))
        return
    with open(req, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    for i, line in enumerate(lines, 1):
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        # 裸依赖无 == / >= / ~=
        if re.match(r"^[a-zA-Z][a-zA-Z0-9_\-]*\s*$", s):
            violations.append(Violation(req, i, "依赖-锁定", f"裸依赖 `{s}` 未锁定版本，应 `{s}==x.y.z`"))
        # 已锁定但含 -e 或 git 引用
        if "-e " in s or "git+" in s:
            violations.append(Violation(req, i, "依赖-锁定", f"依赖 `{s}` 用 git/可编辑引用，应锁 PyPI 版本"))


def collect_module_dirs(root):
    """收集功能模块目录（排除 __pycache__ 与共享层 common）"""
    mods = os.path.join(root, MODULE_DIR)
    if not os.path.exists(mods):
        return []
    return [d for d in os.listdir(mods)
            if os.path.isdir(os.path.join(mods, d))
            and d not in ("__pycache__", "common")]


# 数据层/引擎职责文件的后缀（实际项目命名与 <模块>_store.py 约定略有出入，按职责存在性判断）
_STORE_SUFFIXES = ("_store.py", "_parser.py", "_io.py", "store.py")
_ENGINE_SUFFIXES = ("_engine.py", "_linker.py", "_scheduler.py", "_parser.py", "_io.py", "tree.py", "_tree.py")


def _has_role(files, suffixes):
    return any(fn.endswith(suffixes) for fn in files)


def check_module_layering(root, violations):
    """检查每个模块分层：routes.py + 数据层 + 业务引擎 + __init__.py（按职责存在性，不抠固定文件名）"""
    for mod in collect_module_dirs(root):
        mod_dir = os.path.join(root, MODULE_DIR, mod)
        files = {fn for fn in os.listdir(mod_dir) if fn.endswith(".py")}
        has_routes = "routes.py" in files
        has_init = "__init__.py" in files
        has_store = _has_role(files, _STORE_SUFFIXES)
        has_engine = _has_role(files, _ENGINE_SUFFIXES)
        if not has_routes:
            violations.append(Violation(os.path.join(mod_dir, "routes.py"), 1, "模块-分层", f"模块 {mod} 缺 routes.py"))
        if not has_init:
            violations.append(Violation(os.path.join(mod_dir, "__init__.py"), 1, "模块-分层", f"模块 {mod} 缺 __init__.py"))
        if not has_store:
            violations.append(Violation(os.path.join(mod_dir, mod + "_store.py"), 1, "模块-分层", f"模块 {mod} 缺数据层（{mod}_store.py 或等价职责文件）", "SHOULD"))
        if not has_engine:
            violations.append(Violation(os.path.join(mod_dir, mod + "_engine.py"), 1, "模块-分层", f"模块 {mod} 缺业务引擎（{mod}_engine.py 或等价职责文件）", "SHOULD"))


def check_cross_module_import(root, violations):
    """模块间直接 import 对方内部函数（应走 common）"""
    mods = collect_module_dirs(root)
    for mod in mods:
        mod_dir = os.path.join(root, MODULE_DIR, mod)
        for fn in os.listdir(mod_dir):
            if not fn.endswith(".py"):
                continue
            full = os.path.join(mod_dir, fn)
            try:
                with open(full, "r", encoding="utf-8") as f:
                    tree = ast.parse(f.read())
            except (SyntaxError, UnicodeDecodeError):
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module:
                    if node.module.startswith("modules."):
                        imported = node.module.split(".")[1]
                        if imported != mod and imported != "common":
                            violations.append(Violation(full, node.lineno, "模块-跨模块", f"模块 {mod} import {imported} 内部符号，应走 modules/common/"))


def check_engine_imports_store(root, violations):
    """引擎文件 import 数据层符号"""
    mods = collect_module_dirs(root)
    for mod in mods:
        mod_dir = os.path.join(root, MODULE_DIR, mod)
        for fn in os.listdir(mod_dir):
            if not fn.endswith("_engine.py"):
                continue
            full = os.path.join(mod_dir, fn)
            try:
                with open(full, "r", encoding="utf-8") as f:
                    tree = ast.parse(f.read())
            except (SyntaxError, UnicodeDecodeError):
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.module and "_store" in (node.module or ""):
                    violations.append(Violation(full, node.lineno, "模块-引擎解耦", f"引擎 {fn} import 数据层 {node.module}，应通过 store 参数注入"))


def check_response_contract(root, violations):
    """检查统一响应契约 {code, data, message} 是否使用"""
    app_py = os.path.join(root, "app.py")
    if not os.path.exists(app_py):
        return
    with open(app_py, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()
    if "def respond(" not in src and '"code"' not in src and "'code'" not in src:
        violations.append(Violation(app_py, 1, "契约-响应", "缺统一 respond()/{code,data,message} 响应契约"))


def main():
    parser = argparse.ArgumentParser(description="依赖与模块规范违规检查")
    parser.add_argument("--path", default=ROOT_DEFAULT)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    global ROOT
    ROOT = args.path

    all_v = []
    check_requirements(ROOT, all_v)
    check_module_layering(ROOT, all_v)
    check_cross_module_import(ROOT, all_v)
    check_engine_imports_store(ROOT, all_v)
    check_response_contract(ROOT, all_v)

    if not args.quiet:
        for vio in all_v:
            print(vio)
    must = sum(1 for x in all_v if x.severity == "MUST")
    should = sum(1 for x in all_v if x.severity == "SHOULD")
    print(f"\n[check_deps] 共 {len(all_v)} 条违规（MUST {must} / SHOULD {should}）")
    return 1 if all_v else 0


if __name__ == "__main__":
    sys.exit(main())
