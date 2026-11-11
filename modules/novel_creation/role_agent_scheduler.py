# modules/novel_creation/role_agent_scheduler.py —— 角色 Agent 调度器
# 核心逻辑：单角色多 Agent 按 step_order 有序调用；conversation_id 按 role_id+agent_id 隔离；
# 记忆按 role_id 独立命名空间；多角色并行用 project_id 写锁防冲突。
# 同步调用走线程池，存储读写加文件锁（见改造路线图 §5.4）。
