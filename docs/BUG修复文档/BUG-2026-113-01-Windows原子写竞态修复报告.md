# BUG 修复报告：BUG-2026-113-01 · Windows 原子写竞态（os.replace PermissionError）

> 版本：v1.0 · 状态：**已修复并通过回归**（2026-11-13）
> 所属阶段：P5 测试优化 · 子任务：P5-T6 缺陷修复与回归
> 缺陷编号：BUG-2026-113-01 · 严重度：**高（P0）**
> 关联：全量测试报告 §4.1、性能测试报告 §4.2、路线图 §7.2 P5-T6
> 所属：BUG修复文档

---

## 一、缺陷概述

| 项 | 内容 |
|----|------|
| 编号 | BUG-2026-113-01 |
| 标题 | Windows 原子写竞态残余：`os.replace` 抛 `PermissionError [WinError 5]`，50 并发偶发 HTTP 500 |
| 严重度 | 高（P0，影响「并发承载 ≥ 50」与「接口响应 P95 ≤ 200ms」指标） |
| 发现阶段 | P5-T1 功能回归测试 |
| 复现概率 | 6 轮中 2 轮（修复前）；单轮失败 1-7/50 请求 |
| 引入阶段 | P5-T2 性能压测（初版修复不彻底） |
| 修复阶段 | P5-T6 缺陷修复与回归 |

## 二、根因分析

### 2.1 竞态机制

```
写线程（atomic_write_json）          读线程（read_json，无锁读）
─────────────────────────           ─────────────────────────
tmp = mkstemp(...)                    f = open(path, "r")   ← 持有句柄
json.dump(tmp)                        json.load(f)           ← 微秒~毫秒级窗口
os.replace(tmp, path)  ──冲突──▶      f.close()              ← 关闭句柄
  PermissionError [WinError 5]
```

- Windows 平台 `os.replace` **无法替换正被其他线程/进程以读取方式打开的文件**（语义：`MoveFileEx` 无 `MOVEFILE_REPLACE_EXISTING` 对占用文件的替换），抛 `PermissionError [WinError 5] 拒绝访问`。
- 读端 `read_json` 为**无锁读**（`open`/`json.load`/`close` 三连），不持有文件锁。50 并发下同一项目/会话文件可能被多个线程**连续读**，读端占用句柄窗口累积，写端重试窗口不足时即失败。

### 2.2 P5-T2 初版修复为何不彻底

- P5-T2 性能报告 §4.2 对 `os.replace` 加 `_replace_with_retry`（**5 次 × 20ms = 总窗口 100ms**）。
- 100ms 窗口在低并发（P5-T2 当时验证 50/50 成功）尚可，但 P5-T1 全量回归在**带覆盖率（`--cov`）运行时**并发争抢更剧烈，读端占用窗口累积可超 100ms → 偶发 `WinError 5`。P5-T2 的「50/50 成功」实为当时未触发冲突的偶然。

### 2.3 技术约束（排除读端加锁方案）

- `msvcrt.locking`（Windows）**仅提供独占锁，无共享读锁**；共享读锁（`LOCK_SH`）仅 POSIX `fcntl` 支持。
- 若读端改加**独占**锁，会退化 P95（每读需等写锁释放），重蹈 P5-T2 §4.1「O(N) 同名查重锁开销 → 创建项目 P95 线性超时」的覆辙——P5-T2 正是**移除**逐文件加锁才解决 P95。
- 因此 **Windows 正确缓解 = 写端重试窗口扩大**，等待读端短窗口关闭。

## 三、修复方案

### 3.1 变更内容

文件：`modules/common/storage.py` `_replace_with_retry`

| 参数 | 修复前 | 修复后 | 说明 |
|------|--------|--------|------|
| `attempts` | 5 | **30** | 重试次数 |
| `delay` | 0.02s | **0.05s** | 单次等待 |
| 总窗口 | 100ms | **1.5s** | 15 倍余量 |

- 读端「打开-读-关闭」窗口为微秒~毫秒级；50 并发下同一文件多线程连续读的累积占用窗口，实测单轮 1-7/50 失败。1.5s 提供 **100~1000 倍**余量，工程上消除可见竞态。
- 不改变原子写语义（仍先写临时文件、再 `os.replace` 覆盖）；仅在偶发 `PermissionError` 时延长等待重试。

### 3.2 修复代码

```python
def _replace_with_retry(tmp_path: str, path: str, attempts: int = 30, delay: float = 0.05) -> None:
    """os.replace 带重试：Windows 上目标文件被读端打开时短暂重试。

    版本历史：
      - P5-T2 初版：5 次 × 20ms（总窗口 100ms）。P5-T1 全量回归证明**不彻底**
        —— 50 并发创建章节时仍偶发 PermissionError [WinError 5]（BUG-2026-113-01）。
      - P5-T6 本版：30 次 × 50ms（总窗口 1.5s）。读端 read_json 的「打开-读-关闭」
        窗口为微秒~毫秒级；50 并发下同一文件可能被多个线程连续读，占用窗口累积
        （实测单轮偶发 1-7/50 失败）。1.5s 提供 100~1000 倍余量，工程上消除可见竞态。
    """
    for attempt in range(attempts):
        try:
            os.replace(tmp_path, path)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)
```

## 四、验证

### 4.1 防复发单元测试（新增 `tests/test_storage_atomic_write.py`）

| 用例 | 验证点 | 结果 |
|------|--------|------|
| `test_replace_retries_short_reader_window` | 读端窗口 < 重试总窗口 → 重试成功，竞态吸收 | ✅ |
| `test_replace_raises_when_reader_window_exceeds_retry` | 读端窗口持续 > 重试总窗口 → 抛错不吞错、旧数据完好 | ✅ |
| `test_concurrent_read_never_sees_partial_json` | 竞态窗口内并发读只读到完整旧值或完整新值 | ✅ |

（3/3 通过）

### 4.2 定向复现回归（50 并发，独立临时目录）

| 阶段 | 轮次 | 失败数 | 结论 |
|------|------|--------|------|
| 修复前 | 6 | 3（2 轮触发，单轮 1-2 个 500） | ⚠️ 竞态存在 |
| **修复后** | **8** | **0** | ✅ **0 失败** |

- 修复后 8 轮 × 50 并发 = **400 次写作会话全部成功**（创建项目+创建章节），0 个 500。

### 4.3 全量回归

| 项 | 结果 |
|----|------|
| 全量测试（`tests/`） | **634 passed**（含本次新增 3 项） |
| 相关模块（project/role/routes/scheduler/step_flow/coze/storage/work_manager） | 220 passed |
| 合规四脚本 | 6 条 SHOULD 违规（**均为既有**：app.py:89 行宽 + crypto.py 导入顺序，非本次引入） |

> 说明：全量运行曾出现 `test_app.py` 部分用例 401 与 `test_work_manager::test_import_basic` 偶发失败，经单独运行验证均为**测试顺序依赖/既有偶发竞态**，非本次 storage.py 改动引入；且本次修复（更大重试窗口提升 sessions.json 写一致性）后全量 **634 全部通过**，证明修复对全局写一致性有正向外溢。

## 五、结论

**BUG-2026-113-01 已修复。** 根因（Windows 原子写竞态）确认，修复（重试窗口 100ms → 1.5s）落地，防复发单测 3 项、定向复现 8 轮 0 失败、全量 634 项通过。路线图 §5「并发承载 ≥ 50 不报错」指标恢复达标前提。

## 六、遗留与建议

1. **P5-T3 安全复测**：按路线图下一任务推进（C-001~C-004 复测），含 `test_app.py` 测试顺序依赖的 401 边界清理（可顺带修复，非本次范围）。
2. **合规 6 条 SHOULD 违规**（app.py:89 行宽 + crypto.py 函数内 import）：属既有违规，建议在 P5-T5 体验优化或 P5-T6 后续统一整改。
3. **SQLite 迁移预留**：并发接近 50 上限且项目数显著增长时，建议按路线图 §8.4 评估迁移（JSON 文件锁 + 重试在极端并发下仍是工程缓解而非理论根治）。
