#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
合规性检查统一入口
汇总运行：后端规范 / 前端规范 / 安全与数据 / 依赖与模块 四类检查。
用法:
    python scripts/run_checks.py [--path 根目录]
退出码: 0=全部通过, 1=存在违规
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)))


def run(script, root, quiet=False):
    """运行单个检查脚本，返回 (违规数, 是否成功)。.js 用 node，.py 用 python。"""
    exe = "node" if script.endswith(".js") else sys.executable
    cmd = [exe, os.path.join(SCRIPTS_DIR, script), "--path", root]
    if quiet:
        cmd.append("--quiet")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        out = result.stdout + result.stderr
        # 解析 "共 N 条违规"
        import re
        m = re.search(r"共 (\d+) 条违规", out)
        count = int(m.group(1)) if m else -1
        return count, result.returncode
    except Exception as e:
        return -1, 1


def main():
    root = ROOT
    if "--path" in sys.argv:
        idx = sys.argv.index("--path")
        root = sys.argv[idx + 1]
    quiet = "--quiet" in sys.argv

    scripts = [
        ("check_backend.py", "后端规范"),
        ("check_frontend.js", "前端规范"),
        ("check_security.py", "安全与数据"),
        ("check_deps.py", "依赖与模块"),
    ]
    total = 0
    for script, label in scripts:
        count, code = run(script, root, quiet)
        status = "OK" if code == 0 else "FAIL"
        total += max(0, count)
        print(f"[{label}] {script} -> {status}（违规 {count} 条）")
    print(f"\n[run_checks] 总计违规 {total} 条")
    return 1 if total > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
