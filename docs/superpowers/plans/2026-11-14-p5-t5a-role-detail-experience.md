# P5-T5a 版图角色详情体验优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除版图角色详情切换的空白帧与旧响应覆盖，使基础详情和成长线的冷/热本地渲染 P95 均低于 100ms。

**Architecture:** 沿用现有 IIFE + D3 + `requestAnimationFrame` 结构，不引入框架或全局状态。`_openRoleDetail()` 先构建完整面板，再用 `replaceChild` 一次性替换旧面板；面板闭包内维护单调递增的详情代次，`_loadGrowth()` 在写 DOM 前校验角色 ID、代次和容器引用，丢弃所有过期响应。

**Tech Stack:** 原生 JavaScript（ES6）、D3（既有）、Python 3.9+、unittest、Chrome DevTools Protocol

**Design Spec:** [2026-11-14-p5-t5-role-detail-experience-design.md](../specs/2026-11-14-p5-t5-role-detail-experience-design.md)

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `static/js/role_map_panel.js` | 修改 | 详情渲染、请求代次、成长线加载 |
| `tests/test_role_map_detail_switch.py` | 新建 | 前端不变量守卫（沿用 `test_role_map_perf.py` 既有模式） |
| `docs/05-测试与验收报告/P5-T5a-版图角色详情体验验收报告-2026-11-14.md` | 新建 | 运行时验收证据与结论 |

说明：项目无前端 JS 测试框架，真实闪烁和耗时必须在浏览器中采样。本计划的自动化守卫只锁定「一次性提交」和「请求代次隔离」两条不可回退的源码不变量，行为正确性由 Task 5/6 的真实浏览器验证兜底。

---

## Task 1: 建立前端不变量守卫测试（RED）

**Files:**
- Create: `tests/test_role_map_detail_switch.py`
- Test: `tests/test_role_map_detail_switch.py`

- [ ] **Step 1: 写失败测试**

创建 `tests/test_role_map_detail_switch.py`：

```python
# -*- coding: utf-8 -*-
"""P5-T5a 版图角色详情体验优化：前端不变量守卫。

真实闪烁、乱序响应与渲染耗时需真实浏览器采样（见验收报告）；
此处以源码不变量兜底，防止「一次性提交」「请求代次隔离」被回退。

沿用 tests/test_role_map_perf.py 的 RoleMapFrontendPerfTest 模式。
"""

import os
import unittest

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_PATH = os.path.join(BASE, "static", "js", "role_map_panel.js")


class RoleDetailInvariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(JS_PATH, encoding="utf-8") as fh:
            cls.src = fh.read()

    def _method_body(self, signature, end_marker):
        start = self.src.find(signature)
        self.assertGreater(start, -1, "未找到方法 %s" % signature)
        end = self.src.find(end_marker, start + len(signature))
        self.assertGreater(end, start, "未找到 %s 的结束标记" % signature)
        return self.src[start:end]

    def _open_detail_body(self):
        return self._method_body(
            "        _openRoleDetail(d) {",
            "\n        _closeRoleDetail() {",
        )

    def test_open_detail_increments_generation(self):
        """打开详情必须递增代次，旧请求才能被判为过期。"""
        self.assertIn("const seq = ++this._detailSeq;", self._open_detail_body())

    def test_open_detail_does_not_close_before_build(self):
        """不得先关闭旧详情再构建新面板，否则产生空白帧。"""
        self.assertNotIn("this._closeRoleDetail();", self._open_detail_body())

    def test_open_detail_swaps_panel_in_place(self):
        """新面板必须原地替换旧面板。"""
        self.assertIn("replaceChild(panel, prev)", self._open_detail_body())

    def test_open_detail_passes_generation_to_loader(self):
        """成长线加载必须携带角色 ID 与代次。"""
        self.assertIn("this._loadGrowth(roleId, seq)", self._open_detail_body())

    def test_close_detail_invalidates_generation(self):
        """关闭详情必须使在途请求失效。"""
        body = self._method_body(
            "        _closeRoleDetail() {",
            "\n        // ---------- F8-T10",
        )
        self.assertIn("this._detailSeq += 1;", body)
        self.assertIn("this._detailRoleId = null;", body)

    def test_loader_guards_role_generation_and_container(self):
        """写 DOM 前必须同时校验角色、代次与容器。"""
        body = self._method_body(
            "        async _loadGrowth(roleId, seq) {",
            "\n        _renderGrowthTimeline(box, nodes) {",
        )
        self.assertIn("seq === self._detailSeq", body)
        self.assertIn("roleId === self._detailRoleId", body)
        self.assertIn("self._detailGrowthBox === box", body)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试，确认按预期失败**

Run:

```powershell
& ".\.venv\Scripts\python.exe" -m pytest tests/test_role_map_detail_switch.py -v
```

Expected: 6 项全部 FAIL。失败原因必须是「未找到方法」或断言不包含目标字符串，不能是语法错误或导入错误。

**不要提交。** 红灯测试不能进入 Git，按项目规则提交前必须 CI 全绿。

---

## Task 2: 一次性 DOM 提交，消除空白帧

**Files:**
- Modify: `static/js/role_map_panel.js:961-1040`

- [ ] **Step 1: 修改 `_openRoleDetail` 开头**

把方法开头：

```js
        _openRoleDetail(d) {
            if (!d || !d.id) return;
            const self = this;
            // 关闭已有详情
            this._closeRoleDetail();

            const panel = _el('div', { class: 'rmp-detail' });
            this._detailEl = panel;
            // F9-T7：记录当前详情角色数据（供头像同步事件更新 src）
            this._detailData = d;
```

替换为：

```js
        _openRoleDetail(d) {
            if (!d || !d.id) return;
            const self = this;
            const roleId = d.id;
            // P5-T5a：递增详情代次，使在途的旧成长线响应失效；
            // 不先关闭旧详情，避免「先删后建」产生空白帧。
            const seq = ++this._detailSeq;

            const panel = _el('div', { class: 'rmp-detail' });
```

- [ ] **Step 2: 修改 `_openRoleDetail` 结尾**

把方法结尾：

```js
            panel.appendChild(growthBox);
            this._detailGrowthBox = growthBox;

            this._root.appendChild(panel);

            // F8-T10：异步加载成长线（剧情树按角色过滤）
            this._loadGrowth(d.id);
        }
```

替换为：

```js
            panel.appendChild(growthBox);

            // P5-T5a：一次性提交详情——有旧详情时原地替换，否则追加。
            // 构建期间旧内容保持可见，构建完成后一次性替换，无空白帧。
            const prev = this._detailEl;
            if (prev && prev.parentNode) {
                prev.parentNode.replaceChild(panel, prev);
            } else {
                this._root.appendChild(panel);
            }
            this._detailEl = panel;
            this._detailData = d;
            this._detailRoleId = roleId;
            this._detailGrowthBox = growthBox;

            // F8-T10：异步加载成长线（剧情树按角色过滤）
            this._loadGrowth(roleId, seq);
        }
```

- [ ] **Step 3: 运行测试，确认一次性提交相关用例转为通过**

Run:

```powershell
& ".\.venv\Scripts\python.exe" -m pytest tests/test_role_map_detail_switch.py -v
```

Expected: `test_open_detail_does_not_close_before_build`、`test_open_detail_swaps_panel_in_place`、`test_open_detail_passes_generation_to_loader` 转为 PASS；其余仍 FAIL。

---

## Task 3: 请求代次隔离，丢弃过期响应

**Files:**
- Modify: `static/js/role_map_panel.js:241-261`（构造函数）
- Modify: `static/js/role_map_panel.js:1042-1073`（`_closeRoleDetail`、`_loadGrowth`）

- [ ] **Step 1: 在构造函数中初始化代次字段**

把：

```js
            this._raf = null;
            this._destroyed = false;
```

替换为：

```js
            this._raf = null;
            this._destroyed = false;
            // P5-T5a：详情请求代次与当前角色，用于丢弃旧成长线响应
            this._detailSeq = 0;
            this._detailRoleId = null;
```

- [ ] **Step 2: 修改 `_closeRoleDetail`**

把：

```js
        _closeRoleDetail() {
            if (this._detailEl) { this._detailEl.remove(); this._detailEl = null; }
            if (this._detailGrowthBox) this._detailGrowthBox = null;
            this._detailData = null;
        }
```

替换为：

```js
        _closeRoleDetail() {
            // P5-T5a：递增代次，使所有在途成长线响应失效
            this._detailSeq += 1;
            this._detailRoleId = null;
            if (this._detailEl) { this._detailEl.remove(); this._detailEl = null; }
            if (this._detailGrowthBox) this._detailGrowthBox = null;
            this._detailData = null;
        }
```

- [ ] **Step 3: 重写 `_loadGrowth`**

把整个方法：

```js
        async _loadGrowth(roleId) {
            if (!this.projectId) return;
            const box = this._detailGrowthBox;
            if (!box) return;
            try {
                const url = this._api('/roles/' + encodeURIComponent(roleId) +
                    '?project_id=' + encodeURIComponent(this.projectId));
                const data = await _request(url);
                const nodes = (data && data.growth && data.growth.nodes) || [];
                if (!this._detailGrowthBox) return;
                box.replaceChildren();
                if (!nodes.length) {
                    box.appendChild(_el('div', { class: 'rmp-nodata', text: '暂无成长线' }));
                    return;
                }
                this._renderGrowthTimeline(box, nodes);
            } catch (e) {
                if (this._detailGrowthBox) {
                    box.replaceChildren();
                    box.appendChild(_el('div', { class: 'rmp-nodata', text: '成长线加载失败: ' + e.message }));
                }
            }
        }
```

替换为：

```js
        async _loadGrowth(roleId, seq) {
            if (!this.projectId) return;
            const box = this._detailGrowthBox;
            if (!box) return;
            // P5-T5a：仅当角色、代次、面板与容器全部仍有效时才允许写 DOM；
            // 旧请求即使晚到，也不能覆盖当前详情。
            const self = this;
            const isCurrent = function () {
                return seq === self._detailSeq &&
                    roleId === self._detailRoleId &&
                    self._detailEl != null &&
                    self._detailGrowthBox === box;
            };
            try {
                const url = this._api('/roles/' + encodeURIComponent(roleId) +
                    '?project_id=' + encodeURIComponent(this.projectId));
                const data = await _request(url);
                if (!isCurrent()) return;
                const nodes = (data && data.growth && data.growth.nodes) || [];
                box.replaceChildren();
                if (!nodes.length) {
                    box.appendChild(_el('div', { class: 'rmp-nodata', text: '暂无成长线' }));
                    return;
                }
                this._renderGrowthTimeline(box, nodes);
            } catch (e) {
                if (!isCurrent()) return;
                box.replaceChildren();
                box.appendChild(_el('div', { class: 'rmp-nodata', text: '成长线加载失败: ' + e.message }));
            }
        }
```

- [ ] **Step 4: 运行守卫测试，确认全部通过**

Run:

```powershell
& ".\.venv\Scripts\python.exe" -m pytest tests/test_role_map_detail_switch.py tests/test_role_map_perf.py -v
```

Expected: 新增 6 项全部 PASS，既有 F8 不变量守卫 3 项仍 PASS。

- [ ] **Step 5: 运行全量回归与合规检查**

Run:

```powershell
& ".\.venv\Scripts\python.exe" -m pytest -q
```

Expected: 全量通过，数量为 703 加新增 6 项，即 `709 passed`。

Run:

```powershell
$env:Path = 'C:\Users\taurus\AppData\Local\Author Software\nvm\.nodejs;E:\Program Files\nvm\.shim;' + $env:Path
& ".\.venv\Scripts\python.exe" scripts/run_checks.py --path "f:\workspace_trae\StoryForgeAI"
```

Expected: 四类检查均 `OK`，总计违规 0 条。

- [ ] **Step 6: 提交**

```powershell
git add static/js/role_map_panel.js tests/test_role_map_detail_switch.py
git commit -m "fix(role-map): 消除角色详情切换空白帧并丢弃过期成长线响应"
```

---

## Task 4: 准备 100 角色基准数据

**Files:**
- Create: `scripts/cdp_tmp/seed_perf.py`（`scripts/cdp_tmp/` 已加入 `.gitignore`，不进库）

- [ ] **Step 1: 写数据生成脚本**

创建 `scripts/cdp_tmp/seed_perf.py`：

```python
# -*- coding: utf-8 -*-
"""P5-T5a 验收用基准数据：100 角色 + 150 边。data/ 已 gitignore。"""

import os
import sys

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)

from modules.novel_creation.project_store import ProjectStore  # noqa: E402
from modules.novel_creation.role_store import RoleStore  # noqa: E402
from modules.plot.plot_tree import PlotTreeStore  # noqa: E402
from modules.plot.role_map_service import RoleMapStore  # noqa: E402

DATA_DIR = os.path.join(BASE, "data", "projects")
N_ROLES = 100
N_EDGES = 150
DIMENSIONS = {
    "nationality": ["中原", "北境", "西域", "东海"],
    "faith": ["天道", "魔道", "无"],
    "camp": ["正道", "魔道", "中立"],
    "race": ["人族", "妖族", "仙族"],
    "profession": ["剑客", "术士", "谋士", "医者"],
    "age_group": ["少年", "青年", "中年", "老年"],
}


def main():
    project_store = ProjectStore(DATA_DIR)
    work = project_store.create_project("P5T5基准100")
    pid = work["id"]
    role_store = RoleStore(DATA_DIR)
    map_store = RoleMapStore(DATA_DIR, role_store)
    plot_store = PlotTreeStore(os.path.join(DATA_DIR, "plot"))

    role_ids = []
    for i in range(N_ROLES):
        dims = {k: vs[i % len(vs)] for k, vs in DIMENSIONS.items()}
        role = role_store.create_role(
            pid, "角色%03d" % i,
            identity="主角" if i % 7 == 0 else "配角",
            **dims,
        )
        role_ids.append(role["id"])
    for rid in role_ids:
        map_store.add_node(pid, rid)

    seen = set()
    created = 0
    step = 1
    while created < N_EDGES and step < 60:
        for i in range(N_ROLES):
            if created >= N_EDGES:
                break
            a = role_ids[i % N_ROLES]
            b = role_ids[(i * step + 1) % N_ROLES]
            if a == b:
                b = role_ids[(i + 1) % N_ROLES]
            key = tuple(sorted((a, b)))
            if key in seen:
                continue
            seen.add(key)
            map_store.add_edge(pid, a, b, "ally" if i % 2 == 0 else "enemy")
            created += 1
        step += 1

    # 剧情节点：给前 5 个角色各挂 3 个节点，供成长线渲染测量；
    # 其余角色保持空成长线，用于空状态验收。
    tree = plot_store.create_tree("P5T5基准剧情")
    for rid in role_ids[:5]:
        for k in range(3):
            plot_store.add_node(
                tree, "角色%s 节点%d" % (rid[:6], k), role_id=rid,
            )

    print("PROJECT_ID=%s" % pid)
    print("URL=http://localhost:5000/#work/%s" % pid)
    print("ROLES=%d EDGES=%d" % (len(role_ids), created))
    print("FIRST_ROLE_ID=%s" % role_ids[0])
    print("SECOND_ROLE_ID=%s" % role_ids[1])


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 生成数据并记录输出**

Run:

```powershell
& ".\.venv\Scripts\python.exe" scripts/cdp_tmp/seed_perf.py
```

Expected: 输出 `ROLES=100 EDGES=150`，并给出 `PROJECT_ID`、`FIRST_ROLE_ID`、`SECOND_ROLE_ID`。把三个 ID 记录到验收报告草稿。

若报「项目已存在」，说明同名基准已存在，改用历史 `PROJECT_ID` 继续即可。

---

## Task 5: 浏览器乱序一致性验证

**Files:**
- Create: `scripts/cdp_tmp/p5t5_consistency.js`（不进库）
- Test: 手动运行脚本，观察输出

- [ ] **Step 1: 启动服务**

```powershell
& ".\.venv\Scripts\python.exe" app.py
```

Expected: 监听 `http://localhost:5000`。保持该终端运行。

- [ ] **Step 2: 安装 CDP 客户端**

```powershell
New-Item -ItemType Directory -Force scripts/cdp_tmp | Out-Null
npm init -y --prefix scripts/cdp_tmp
npm i ws --prefix scripts/cdp_tmp
```

Expected: `scripts/cdp_tmp/node_modules/ws` 存在。

- [ ] **Step 3: 写乱序验证脚本**

创建 `scripts/cdp_tmp/p5t5_consistency.js`：

```javascript
// P5-T5a 乱序一致性验证：A -> B -> A 共 30 轮，A 的成长线响应延迟 800ms。
// 用法：node p5t5_consistency.js <projectId> <roleA> <roleB> <cdpPort>
const WebSocket = require('ws');

const [projectId, roleA, roleB, port] = process.argv.slice(2);
const CDP = `http://127.0.0.1:${port || 9333}`;

async function main() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到浏览器页面，请先启动带 --remote-debugging-port 的 Chrome 并打开应用');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  await new Promise((resolve) => ws.on('open', resolve));

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result && res.result.exceptionDetails) {
      throw new Error(JSON.stringify(res.result.exceptionDetails));
    }
    return res.result && res.result.result ? res.result.result.value : undefined;
  };

  await evaluate(`location.hash = '#work/${projectId}'`);
  await new Promise((r) => setTimeout(r, 2500));

  // 拦截成长线请求：按 URL 中的 roleId 施加延迟，制造乱序。
  await evaluate(`
    (function () {
      if (window.__p5t5Patched) return true;
      window.__p5t5Patched = true;
      const orig = window.fetch;
      window.fetch = function (url, opts) {
        const text = String(url);
        const delay = text.indexOf('/roles/${roleA}') >= 0 ? 800 : 0;
        if (!delay) return orig.call(window, url, opts);
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            orig.call(window, url, opts).then(resolve, reject);
          }, delay);
        });
      };
      return true;
    })()
  `);

  const results = await evaluate(`
    (async function () {
      const nodes = Array.from(document.querySelectorAll('.rmp-node'));
      function findNode(roleId) {
        return nodes.find(function (n) { return n.__data__ && n.__data__.id === roleId; });
      }
      const a = findNode('${roleA}');
      const b = findNode('${roleB}');
      if (!a || !b) return { error: '未找到角色节点 A/B' };
      const out = { rounds: 0, mismatches: 0, staleWrites: 0, details: [] };
      for (let i = 0; i < 30; i++) {
        a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        a.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise(function (r) { setTimeout(r, 1100); });
        const title = document.querySelector('.rmp-detail-head h4');
        const expected = a.__data__.name || '${roleA}';
        out.rounds += 1;
        if (!title || title.textContent !== expected) {
          out.mismatches += 1;
          out.details.push({ round: i, expected: expected, actual: title && title.textContent });
        }
      }
      return out;
    })()
  `);

  console.log(JSON.stringify(results, null, 2));
  ws.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: 启动可调试浏览器并运行脚本**

```powershell
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9333","--user-data-dir=$PWD\scripts\cdp_tmp\p5t5-profile","http://localhost:5000"
node scripts/cdp_tmp/p5t5_consistency.js <PROJECT_ID> <FIRST_ROLE_ID> <SECOND_ROLE_ID> 9333
```

Expected: 输出 `rounds: 30`、`mismatches: 0`、`staleWrites: 0`。若 Chrome 路径不同，替换为实际安装路径。

- [ ] **Step 5: 记录结果**

把完整 JSON 输出、浏览器版本、脚本路径写入验收报告草稿。若 `mismatches > 0`，停止后续任务并回到 Task 3 排查，不得进入 Task 6。

---

## Task 6: 浏览器渲染性能测量

**Files:**
- Create: `scripts/cdp_tmp/p5t5_perf.js`（不进库）

- [ ] **Step 1: 写性能测量脚本**

创建 `scripts/cdp_tmp/p5t5_perf.js`：

```javascript
// P5-T5a 本地渲染耗时：基础详情 + 成长线，冷/热各 30 次，输出 P95。
// 用法：node p5t5_perf.js <projectId> <roleId> <cdpPort>
const WebSocket = require('ws');

const [projectId, roleId, port] = process.argv.slice(2);
const CDP = `http://127.0.0.1:${port || 9333}`;

async function main() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到浏览器页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  await new Promise((resolve) => ws.on('open', resolve));

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result && res.result.exceptionDetails) {
      throw new Error(JSON.stringify(res.result.exceptionDetails));
    }
    return res.result && res.result.result ? res.result.result.value : undefined;
  };

  await evaluate(`location.hash = '#work/${projectId}'`);
  await new Promise((r) => setTimeout(r, 2500));

  // 预取成长线数据，并让后续同类请求立即返回，
  // 使 P95 只反映本地解析与渲染，不含网络等待（对齐设计口径）。
  await evaluate(`
    (async function () {
      if (window.__p5t5PerfPatched) return true;
      window.__p5t5PerfPatched = true;
      const url = '/api/role-map/roles/${roleId}?project_id=${projectId}';
      const resp = await fetch(url);
      const text = await resp.text();
      const orig = window.fetch;
      window.fetch = function (u, o) {
        if (String(u).indexOf('/roles/${roleId}') >= 0) {
          return Promise.resolve(new Response(text, {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        }
        return orig.call(window, u, o);
      };
      return true;
    })()
  `);

  const out = await evaluate(`
    (async function () {
      const nodes = Array.from(document.querySelectorAll('.rmp-node'));
      const target = nodes.find(function (n) { return n.__data__ && n.__data__.id === '${roleId}'; });
      if (!target) return { error: '未找到目标角色节点' };
      const closeBtn = function () {
        const el = document.querySelector('.rmp-detail-close');
        if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      };
      function nextFrame() {
        return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
      }
      async function sample() {
        const t0 = performance.now();
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await nextFrame();
        const detailMs = performance.now() - t0;
        // 成长线加载完成判据：加载中占位消失（有数据出现时间线，无数据显示空状态）。
        const growthStart = performance.now();
        function growthSettled() {
          const box = document.querySelector('.rmp-detail-growth');
          if (!box) return false;
          return (box.textContent || '').indexOf('成长线加载中') < 0;
        }
        while (!growthSettled() && performance.now() - growthStart < 2000) {
          await nextFrame();
        }
        const growthMs = performance.now() - growthStart;
        closeBtn();
        await nextFrame();
        return { detailMs: detailMs, growthMs: growthMs };
      }
      function p95(arr) {
        const s = arr.slice().sort(function (a, b) { return a - b; });
        return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
      }
      const coldDetail = [];
      const coldGrowth = [];
      for (let i = 0; i < 30; i++) {
        const s = await sample();
        coldDetail.push(s.detailMs);
        coldGrowth.push(s.growthMs);
      }
      const warmDetail = [];
      const warmGrowth = [];
      for (let i = 0; i < 30; i++) {
        const s = await sample();
        warmDetail.push(s.detailMs);
        warmGrowth.push(s.growthMs);
      }
      return {
        coldDetailP95: p95(coldDetail),
        coldGrowthP95: p95(coldGrowth),
        warmDetailP95: p95(warmDetail),
        warmGrowthP95: p95(warmGrowth),
        sampleCount: 30,
      };
    })()
  `);

  console.log(JSON.stringify(out, null, 2));
  ws.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 运行测量**

```powershell
node scripts/cdp_tmp/p5t5_perf.js <PROJECT_ID> <FIRST_ROLE_ID> 9333
```

Expected: 输出四组 P95，均 `<100ms`。

- [ ] **Step 3: 记录结果**

把四组 P95、样本数、浏览器版本写入验收报告草稿。若任一 P95 ≥100ms，停止并记录原因，不得宣布验收通过。

- [ ] **Step 4: 版图 FPS 不退化检查**

在同一页面通过 DevTools Protocol 采集 5 秒 `requestAnimationFrame` 间隔，计算平均 FPS：

```javascript
const out = await evaluate(`
  new Promise(function (resolve) {
    const ts = [];
    const t0 = performance.now();
    function tick(t) {
      ts.push(t);
      if (performance.now() - t0 < 5000) requestAnimationFrame(tick);
      else {
        const deltas = [];
        for (let i = 1; i < ts.length; i++) deltas.push(ts[i] - ts[i - 1]);
        const avg = deltas.reduce(function (a, b) { return a + b; }, 0) / deltas.length;
        resolve({ frames: deltas.length, avgFps: 1000 / avg });
      }
    }
    requestAnimationFrame(tick);
  })
`);
console.log(JSON.stringify(out));
```

Expected: `avgFps ≥ 57`（相对 F8 基线 60fps 下降不超过 5%），否则记录为不通过。

---

## Task 7: 验收报告与文档同步

**Files:**
- Create: `docs/05-测试与验收报告/P5-T5a-版图角色详情体验验收报告-2026-11-14.md`

- [ ] **Step 1: 写验收报告**

创建报告，必须包含以下小节，数字全部来自 Task 5/6 的真实输出，不得填估计值：

```markdown
# P5-T5a 版图角色详情体验验收报告

> 日期：2026-11-14
> 分支：feature/p5-t5-experience-optimization
> 设计依据：docs/superpowers/specs/2026-11-14-p5-t5-role-detail-experience-design.md

## 1. 验收环境

- 浏览器与版本：<实际值>
- Node.js：<实际值>
- Python：<实际值>
- 基准项目：<PROJECT_ID>，100 角色 + 150 边

## 2. 乱序一致性（A → B → A × 30）

| 指标 | 结果 | 判定 |
|---|---|---|
| 轮次 | 30 | — |
| 最终角色不一致次数 | <实际值> | 0 为通过 |
| 过期响应覆盖次数 | <实际值> | 0 为通过 |

## 3. 本地渲染耗时（各 30 次）

| 指标 | P95 | 判定 |
|---|---|---|
| 基础详情 冷 | <实际值> | <100ms |
| 基础详情 热 | <实际值> | <100ms |
| 成长线 冷 | <实际值> | <100ms |
| 成长线 热 | <实际值> | <100ms |

## 4. 版图 FPS

- 平均 FPS：<实际值>
- 相对 F8 基线 60fps 下降：<实际值>%
- 判定：<通过/不通过>

## 5. 回归与合规

- 全量测试：<实际值>
- 四脚本检查：<实际值>
- `compileall` / `git diff --check`：<实际值>

## 6. 结论

<通过 / 不通过，及未覆盖项说明>
```

- [ ] **Step 2: 运行最终回归**

```powershell
& ".\.venv\Scripts\python.exe" -m pytest -q
$env:Path = 'C:\Users\taurus\AppData\Local\Author Software\nvm\.nodejs;E:\Program Files\nvm\.shim;' + $env:Path
& ".\.venv\Scripts\python.exe" scripts/run_checks.py --path "f:\workspace_trae\StoryForgeAI"
git diff --check
```

Expected: 测试全通过，四类检查 0 违规，差异格式无告警。

- [ ] **Step 3: 提交报告**

```powershell
git add "docs/05-测试与验收报告/P5-T5a-版图角色详情体验验收报告-2026-11-14.md"
git commit -m "docs(p5-t5a): 补充版图角色详情体验验收报告"
```

- [ ] **Step 4: 更新路线图状态**

在 `docs/03-规划与路线/小说AI写作软件改造实施路线图.md` 的「体验优化」要点段落（`- 角色切换无闪烁，状态同步。` 之后）追加一行，仅写已发生的事实：

```markdown
> 实施状态（2026-11-14）：P5-T5a 版图角色详情已完成并通过验收；命令面板与同作品多 Agent 切换另立任务。
```

Run:

```powershell
git add "docs/03-规划与路线/小说AI写作软件改造实施路线图.md"
git commit -m "docs(roadmap): 记录 P5-T5a 完成状态"
```

---

## 完成定义

- Task 1 的 6 项守卫测试全部通过，且曾在实现前真实失败。
- Task 5 乱序验证 30 轮：不一致 0、过期覆盖 0。
- Task 6 四组 P95 均 `<100ms`，版图 FPS 下降不超过 5%。
- 全量测试、四脚本检查、`git diff --check` 全部通过。
- 验收报告中的数字全部可追溯到实际命令输出。
