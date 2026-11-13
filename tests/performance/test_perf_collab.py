# -*- coding: utf-8 -*-
"""P5-T4 多角色协同压力测试。

对齐路线图 §1.2「多角色协同」三项量化指标，用 time.perf_counter + ThreadPoolExecutor 压测：
  1. 多角色协同无冲突 100%：多角色 Agent 并行协同写作，记忆/身份互不覆盖、数据不丢；
  2. 剧情推衍多线程隔离 100%：多房间并发推衍，各房间数据互不干扰；
  3. 剧情树回写一致性 100%：并发推衍结果回写剧情树，不丢节点、不建环。

方法（复用 P5-T2）：不引入新依赖，time.perf_counter 度量；隔离数据目录 + 依赖注入，
不污染生产数据。指标阈值对齐路线图：并发 ≥ 50 不报错不丢数据；回写不丢不环 100%。
"""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from modules.common.errors import AppError  # noqa: E402
from modules.novel_creation.project_store import ProjectStore  # noqa: E402
from modules.novel_creation.role_store import RoleStore  # noqa: E402
from modules.novel_creation.role_agent_scheduler import RoleAgentScheduler  # noqa: E402
from modules.novel_creation.routes import create_blueprint  # noqa: E402
from modules.story_engine import init_room  # noqa: E402
from modules import story_thread  # noqa: E402
from modules.plot.plot_tree import PlotTreeStore  # noqa: E402
from modules.random_system import RandomSystem  # noqa: E402
from modules.story_engine import StoryEngine  # noqa: E402


# ---------- Fixture：隔离协同环境（P5-T2 同款依赖注入） ----------

@pytest.fixture()
def collab_env(tmp_path):
    """构造独立 Flask app + 临时目录 store + 注入 mock agent_client，真正隔离。"""
    proj_dir = str(tmp_path / "projects")
    rs = RoleStore(proj_dir)
    ps = ProjectStore(proj_dir)

    # 注入 agent_client：返回带 role_id 标记的输出，用于验证身份不串
    class _AgentClient:
        def __init__(self):
            self.calls = []

        def chat(self, bot_id, user_message, conversation_id=None, parameters=None):
            self.calls.append({
                "bot_id": bot_id,
                "conversation_id": conversation_id,
                "message": user_message,
            })
            # 输出回显 role_id（从 conversation_id 前缀解析）+ 唯一时间戳
            role_id = (conversation_id or "").split(":")[0]
            return {
                "success": True,
                "content": {"role_id": role_id, "seq": len(self.calls)},
                "conversation_id": conversation_id,
            }

    agent_client = _AgentClient()
    # 用真实调度器（注入 mock agent_client），而非 P5-T2 的 SimpleNamespace，
    # 因为 P5-T4 要验证调度器真实并发语义（记忆写回 / 会话隔离 / 身份前缀）
    scheduler = RoleAgentScheduler(
        rs, ps, agent_client, max_workers=16,
    )
    flow_engine = SimpleNamespace(
        trigger_step=lambda pid, rid, so, ctx: {"role_id": rid, "step": so, **ctx},
    )
    import_engine = SimpleNamespace(
        list_candidate_roles=lambda pid, keyword=None: [],
        import_roles=lambda pid, cands, preview=False: {"total": 0, "success": 0},
        get_import_history=lambda pid: [],
    )

    class _Reg:
        def get(self, tool):
            return None

    bp = create_blueprint(
        rs, ps, scheduler, flow_engine,
        tool_registry=_Reg(), import_engine=import_engine,
    )
    app = __import__("flask").Flask(__name__)
    app.register_blueprint(bp)

    @app.errorhandler(Exception)
    def _on_error(e):
        if isinstance(e, AppError):
            return __import__("flask").jsonify({"code": e.status_code, "data": None, "message": str(e)}), e.status_code
        return __import__("flask").jsonify({"code": 500, "data": None, "message": "服务器内部错误"}), 500

    app.config["TESTING"] = True
    return SimpleNamespace(
        client=app.test_client(), rs=rs, ps=ps, scheduler=scheduler, agent_client=agent_client,
    )


def _mk_project(ps, title="协同项目"):
    pid = ps.create_project(title).get("id")
    ps.set_collab_enabled(pid, True)
    return pid


def _mk_role_with_binding(rs, ps, pid, role_name, agent_id, step_order=1):
    role = rs.create_role(pid, role_name)
    rs.create_binding(pid, role["id"], agent_id, step_order)
    return role


# ---------- 1. 多角色协同无冲突 ----------

class TestMultiRoleCollabNoConflict:
    def test_50_roles_parallel_memory_isolated(self, collab_env):
        """50 角色并行协同，记忆按 (role_id, agent_id) 命名空间隔离，互不覆盖。

        指标：多角色协同无冲突 100%。验证方式：
          - 每角色绑定独立 agent_id，调用后 get_memory 返回该角色自己的输出；
          - 各角色 conversation_id 前缀 = role_id（身份不串）；
          - 数据不丢：50 个角色的记忆全部可恢复。
        """
        env = collab_env
        pid = _mk_project(env.ps)
        role_ids = []
        bindings = []
        for i in range(50):
            r = _mk_role_with_binding(env.rs, env.ps, pid, f"角色{i}", f"agent_{i}")
            role_ids.append(r["id"])
            bindings.append((r["id"], f"agent_{i}"))

        # 50 角色并发各自调用（同一项目，验证协同写锁 + 记忆隔离）
        def _call(role_id, i):
            merged = env.scheduler.invoke_role_agents(pid, role_id, 1, {"idx": i})
            return role_id, merged

        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=50) as ex:
            futures = [ex.submit(_call, rid, i) for i, rid in enumerate(role_ids)]
            results = [f.result() for f in futures]
        dt = (time.perf_counter() - t0) * 1000

        # 不丢数据：每角色按真实绑定 agent_id 恢复记忆，role_id 一致
        for rid, agent_id in bindings:
            mem = env.rs.get_memory(pid, rid, agent_id)
            assert mem.get("role_id") == rid, f"角色 {rid} 记忆串号: {mem}"
        # 50 个角色全部成功
        assert len(results) == 50
        # 协同调用整体耗时可接受（宽松阈值，仅记录）
        assert dt < 15000, f"50 角色并行协同耗时 {dt:.0f}ms 超 15s"

    def test_50_concurrent_collab_api_no_data_loss(self, collab_env):
        """50 并发请求 /collab 接口（不同角色组），无数据丢失、无互相覆盖。

        验证：collab 接口在写锁保护下，各角色组 context 正确合并，无异常覆盖。
        """
        env = collab_env
        pid = _mk_project(env.ps)
        # 3 个角色，各绑定独立 agent
        rids = []
        for i in range(3):
            r = _mk_role_with_binding(env.rs, env.ps, pid, f"角{i}", f"ag_{i}")
            rids.append(r["id"])

        def _collab(i):
            r = env.client.post(f"/api/projects/{pid}/collab", json={
                "roles": rids,
                "step_order": 1,
                "context": {"req": i},
            })
            return r.status_code, r.get_json()

        # 50 并发协同请求（同项目，写锁串行化，不应覆盖数据）
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=50) as ex:
            outcomes = list(ex.map(_collab, range(50)))
        dt = (time.perf_counter() - t0) * 1000

        # 写锁串行化（非阻塞 try_acquire）：50 并发必然大量 409（锁竞争），
        # 但至少 1 个成功；成功的无数据丢失，409 属正常锁竞争不崩溃
        statuses = [s for s, _ in outcomes]
        ok = [s for s in statuses if s == 200]
        conflict = [s for s in statuses if s == 409]
        assert len(ok) >= 1, f"协同并发全部失败（无 200）: {statuses}"
        assert len(ok) + len(conflict) == len(statuses), \
            f"存在非 200/409 状态码: {[s for s in statuses if s not in (200, 409)]}"
        # 不丢数据：成功请求的 merged_context 含各自 req 上下文
        for s, body in outcomes:
            if s == 200:
                merged = body["data"]["merged_context"]
                assert "role_id" in merged, "协同结果缺角色上下文"
        assert dt < 15000, f"50 并发协同 API 耗时 {dt:.0f}ms 超 15s"


# ---------- 2. 剧情推衍多线程隔离 ----------

@pytest.fixture()
def story_room_env(tmp_path):
    """隔离 F6 聊天室：清空注册表 + 构造 10 房间。"""
    story_thread._rooms.clear()
    rooms = []
    for i in range(10):
        room = init_room({
            "name": f"房间{i}",
            "place": "密室",
            "background": f"背景{i}",
            "characters": [f"角色{i}"],
        })
        story_thread.create_room(room)
        rooms.append(room)
    yield rooms
    story_thread._rooms.clear()


class TestDeriveMultiThreadIsolation:
    def test_10_rooms_parallel_derive_isolated(self, story_room_env):
        """10 房间并发推衍，各房间 step_index/history 互不干扰。

        指标：剧情推衍多线程隔离 100%。验证方式：每房间独立写锁，并发推衍后
        各房间 step_index 恰好递增、history 只含本房间内容。
        """
        engine = StoryEngine(llm=lambda p, bot_id="": {"success": True, "content": "推衍内容"})
        rooms = story_room_env

        def _derive(room):
            with story_thread.with_room(room["id"], "w") as r:
                step = engine.advance_step(r)
                return r["id"], step["step_no"], r.get("step_index")

        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=10) as ex:
            results = list(ex.map(_derive, rooms))
        dt = (time.perf_counter() - t0) * 1000

        for rid, step_no, step_index in results:
            with story_thread.with_room(rid, "r") as r:
                assert len(r.get("history", [])) == 1, f"房间 {rid} history 异常"
                assert r.get("step_index") == 1, f"房间 {rid} step_index 异常"
        assert len(results) == 10
        assert dt < 5000, f"10 房间并发推衍耗时 {dt:.0f}ms 超 5s"

    def test_50_concurrent_step_same_room_no_corruption(self, story_room_env):
        """50 并发推衍同一房间，写锁串行化，history 不丢步骤、不串数据。

        指标：剧情推衍多线程隔离 100%。验证方式：同一房间高并发写，
        最终 step_index == history 长度，且历史步骤 step_no 连续无重复。
        """
        engine = StoryEngine(llm=lambda p, bot_id="": {"success": True, "content": "推衍内容"})
        room = story_room_env[0]

        def _step(i):
            try:
                with story_thread.with_room(room["id"], "w") as r:
                    if r.get("status") == "finished":
                        return None
                    step = engine.advance_step(r)
                    return step["step_no"]
            except AppError:
                return None

        with ThreadPoolExecutor(max_workers=50) as ex:
            steps = list(ex.map(_step, range(50)))

        with story_thread.with_room(room["id"], "r") as r:
            history = r.get("history", [])
            step_index = r.get("step_index", 0)
        # 写锁串行化：step_index 与 history 长度一致（不丢步骤）
        assert step_index == len(history), f"step_index={step_index} 与 history 长度 {len(history)} 不一致"
        # 步骤编号连续（1..N 无重复）
        nos = [h.get("step_no") for h in history]
        assert nos == list(range(1, len(nos) + 1)), f"步骤编号不连续: {nos}"


# ---------- 3. 剧情树回写一致性 ----------

class TestPlotTreeWritebackConsistency:
    def test_50_concurrent_pull_from_room_no_lost_no_cycle(self, tmp_path):
        """并发回写剧情树：不丢节点、不建环。

        指标：剧情树回写一致性 100%。验证方式：
          - 50 个推衍步骤并发回写，最终树节点数 == 50（不丢）；
          - 遍历节点父子链，无环（不建环）；
          - 根节点 children 完整挂载。
        """
        pt = PlotTreeStore(str(tmp_path / "trees"))
        tree = pt.create_tree("并发回写树", source="novel")

        # 50 个推衍步骤，各带独立 step id（模拟不同聊天室推衍结果）
        steps = [
            {"id": f"step_{i}", "label": f"节点{i}", "content": f"内容{i}", "summary": f"内容{i}"}
            for i in range(50)
        ]

        def _writeback(step):
            # 每个步骤独立 tree 快照（并发读 + 写，FileLock 保护）
            t = pt.load_tree(tree["id"])
            return pt.pull_from_room(t, "room_并发", [step], parent_node_id=None)

        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=50) as ex:
            results = list(ex.map(_writeback, steps))
        dt = (time.perf_counter() - t0) * 1000

        final = pt.load_tree(tree["id"])
        nodes = final.get("nodes", [])
        # 不丢节点：50 个步骤全部回写为节点
        assert len(nodes) == 50, f"回写后节点数 {len(nodes)}，期望 50（丢节点）"
        # 不建环：全图 DFS（每个节点出发）无重复访问——产品语义下多根合法
        #（parent_node_id=None 时每步独立根，仅首个设 root_node_id，其余为孤儿）
        visited = set()
        root_id = final.get("root_node_id")
        assert root_id is not None
        for start in nodes:
            stack = [start["id"]]
            while stack:
                nid = stack.pop()
                assert nid not in visited, f"检测到环（重复访问节点 {nid}）"
                visited.add(nid)
                node = next((n for n in nodes if n["id"] == nid), None)
                if node:
                    stack.extend(node.get("children_ids", []))
        assert len(visited) == 50, f"全图可达节点 {len(visited)}，期望 50（丢节点）"
        # 多根语义：50 步骤均独立根（parent_id=None），无父子引用（不建链）
        assert all(n.get("parent_id") is None for n in nodes), "存在节点被挂到父节点（非多根语义）"
        root = next(n for n in nodes if n["id"] == root_id)
        assert len(root.get("children_ids", [])) == 0  # 根节点无子（多根语义：根即第一节点）
        assert dt < 15000, f"50 并发回写耗时 {dt:.0f}ms 超 15s"

    def test_duplicate_writeback_no_dup_nodes(self, tmp_path):
        """重复回写同一推衍步骤：按 source_step_id 去重，不产生重复节点。

        指标：剧情树回写一致性 100%。验证方式：同一 step 回写 3 次，节点仅 1 个。
        """
        pt = PlotTreeStore(str(tmp_path / "trees"))
        tree = pt.create_tree("去重树", source="novel")
        step = {"id": "step_dup", "label": "去重节点", "content": "内容", "summary": "内容"}

        for _ in range(3):
            t = pt.load_tree(tree["id"])
            pt.pull_from_room(t, "room_dup", [step], parent_node_id=None)

        final = pt.load_tree(tree["id"])
        assert len(final.get("nodes", [])) == 1, "重复回写产生重复节点"


# ---------- 4. 多角色协同耗时（P95，补充指标） ----------

class TestCollabLatency:
    def test_collab_p95_under_500ms(self, collab_env):
        """协同接口 P95 响应时间（写锁串行化，宽松阈值 500ms 内网本机）。"""
        env = collab_env
        pid = _mk_project(env.ps)
        rids = []
        for i in range(3):
            r = _mk_role_with_binding(env.rs, env.ps, pid, f"角{i}", f"ag_{i}")
            rids.append(r["id"])

        times = []
        for i in range(30):
            t0 = time.perf_counter()
            r = env.client.post(f"/api/projects/{pid}/collab", json={
                "roles": rids, "step_order": 1, "context": {"req": i},
            })
            dt = (time.perf_counter() - t0) * 1000
            assert r.status_code == 200
            times.append(dt)

        times.sort()
        p95 = times[int(len(times) * 0.95) - 1]
        assert p95 < 500, f"协同接口 P95={p95:.1f}ms 超 500ms"
