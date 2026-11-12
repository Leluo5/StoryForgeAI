# -*- coding: utf-8 -*-
"""AI 角色抽取服务（F8-T4）。

对齐 F8 技术方案 §4.2（AI 自动生成）与 §3（数据模型）：
- 复用 `coze_client.run_workflow` 调用专用抽取 workflow（依赖注入可 mock）。
- 实体/关系解析：LLM 返回 characters[]/relations，解析为 Role 实体 + 图谱边。
- 进度管理：`role_map.ai_progress` 的 stage/percent，经 RoleMapStore.set_ai_progress 驱动。
- 三阶段：extract（调用 + 解析）→ preview（待确认数据，不落库）→ commit（写库 + ai_generated）。

设计：纯函数 + 依赖注入。LLM 调用经模块级 callable（默认 _default_extract_llm），
便于单测 mock；写库经注入的 RoleMapStore/RoleStore 实例（不直接 import 领域符号）。

数据契约（对齐技术方案 §4.2）：
- extract 入参：project_id + source（"all" 或 "<chapter_id>"）。
- LLM 返回：{"characters": [{"name","identity","nationality","faith","camp","race",
  "profession","age","gender","attributes"}], "relations": [{"from","to","relation_type","note"}]}。
- progress 返回：{stage, percent, done}。
- commit 入参：抽取结果（preview 确认后的最终数据），写库并置 ai_generated=true。
"""

from __future__ import annotations

import json
import re
from typing import Any, Callable, Dict, List, Optional

from ..common.errors import bad_request, conflict, not_found
from ..common.storage import new_id, now_iso


def _default_extract_llm(prompt: str, *args: Any, **kwargs: Any) -> Dict[str, Any]:
    """默认 LLM 封装占位（生产由路由层注入 coze run_workflow；单测 mock 覆盖）。"""
    raise NotImplementedError("extract_roles 需要注入 llm_fn")


def _parse_llm_json(text: str) -> Dict[str, Any]:
    """解析 LLM 返回文本为 dict（剥离 markdown 代码围栏）。

    兼容 run_workflow 返回 data 为字符串（JSON）或已解析 dict 两种形态。
    """
    if isinstance(text, dict):
        return text
    if not isinstance(text, str):
        raise conflict("AI 返回格式不合法，请重试")
    s = text.strip()
    # 剥离 ```json ... ``` / ``` ... ``` 围栏
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", s, re.DOTALL)
    if fence:
        s = fence.group(1).strip()
    # 若被包裹在字符串里（run_workflow 偶发二次 JSON 编码），尝试剥一层
    if s.startswith("\"") and s.endswith("\""):
        try:
            inner = json.loads(s)
            if isinstance(inner, str):
                s = inner.strip()
        except (json.JSONDecodeError, TypeError):
            pass
    try:
        data = json.loads(s)
    except json.JSONDecodeError:
        raise conflict("AI 返回无法解析为 JSON，请重试")
    if not isinstance(data, dict):
        raise conflict("AI 返回结构不合法，请重试")
    return data


def _norm_str(value: Any) -> str:
    """规范化字符串字段（None → ""；非字符串强转）。"""
    if value is None:
        return ""
    return str(value).strip()


def build_extract_prompt(source_text: str, source_label: str = "") -> str:
    """构造 AI 抽取提示词（对齐 F8 技术方案 §4.2）。

    source_text: 源文本（全部章节或指定章节内容）。
    source_label: 来源标识（"all" / 章节标题），用于提示词上下文。
    """
    label = source_label or "全文"
    return (
        "你是小说角色版图抽取引擎。请从以下小说内容中抽取全部角色实体及其关系，"
        "只输出 JSON，格式：\n"
        """{"characters": [{"name":"角色名","identity":"主角|配角|反派","nationality":"地域","""
        """ "faith":"信仰","camp":"阵营","race":"种族","profession":"职业","age":整数,"""
        """ "gender":"男|女","attributes":{"personality":"性格","background":"经历"}}], """
        """ "relations": [{"from":"角色名A","to":"角色名B","relation_type":"关系类型","""
        """ "note":"备注"}]}\n"""
        "规则：characters 至少 1 个；relations 的 from/to 必须在 characters 中存在；"
        "未识别字段填空字符串。\n"
        f"抽取范围：{label}\n"
        "小说内容：\n" + source_text
    )


class RoleMapAIExtractor:
    """AI 角色抽取服务（F8-T4）。

    注入依赖：
    - role_map_store: RoleMapStore（图谱读写 + set_ai_progress）。
    - role_store: RoleStore（Role 实体创建/更新）。
    - llm_fn: LLM 调用封装，签名 llm_fn(prompt) -> dict（默认 _default_extract_llm）。
    """

    # 抽取进度阶段（对齐 role_map.ai_progress 契约）
    STAGE_IDLE = "idle"
    STAGE_EXTRACT = "extract"
    STAGE_PREVIEW = "preview"
    STAGE_COMMIT = "commit"
    STAGE_DONE = "done"
    STAGE_FAILED = "failed"

    def __init__(
        self,
        role_map_store: Any,
        role_store: Any,
        llm_fn: Optional[Callable[..., Dict[str, Any]]] = None,
    ) -> None:
        self._role_map_store = role_map_store
        self._role_store = role_store
        self._llm_fn = llm_fn or _default_extract_llm

    # ---------- 进度 ----------

    def get_progress(self, project_id: str) -> Dict[str, Any]:
        """查询 AI 生成进度。返回 {stage, percent, done}。"""
        rm = self._role_map_store.get_role_map(project_id)
        progress = rm.get("ai_progress", {}) or {}
        return {
            "stage": progress.get("stage", self.STAGE_IDLE),
            "percent": int(progress.get("percent", 0) or 0),
            "done": bool(rm.get("ai_generated", False)),
        }

    def _set_progress(self, project_id: str, stage: str, percent: int) -> None:
        """写进度（stage=done 时同时置 ai_generated + generated_at）。"""
        self._role_map_store.set_ai_progress(project_id, stage, int(percent))

    # ---------- extract（阶段一：调用 + 解析） ----------

    def extract_roles(
        self, project_id: str, source_text: str, source_label: str = "",
    ) -> Dict[str, Any]:
        """执行 AI 抽取（同步调用，返回解析后的待确认数据）。

        入参 source_text：待抽取的源文本（项目全部章节或指定章节内容）。
        返回：{"characters": [...], "relations": [...], "source": source_label,
        "extracted_at": ...}，为 preview/commit 的输入。
        """
        if not source_text or not source_text.strip():
            raise bad_request("抽取源文本不能为空")
        self._set_progress(project_id, self.STAGE_EXTRACT, 10)
        try:
            prompt = build_extract_prompt(source_text, source_label)
            raw = self._llm_fn(prompt)
            self._set_progress(project_id, self.STAGE_EXTRACT, 60)
            parsed = _parse_llm_json(raw)
            characters, relations = self._parse_result(parsed)
            self._set_progress(project_id, self.STAGE_PREVIEW, 90)
            return {
                "characters": characters,
                "relations": relations,
                "source": source_label,
                "extracted_at": now_iso(),
            }
        except Exception:
            self._set_progress(project_id, self.STAGE_FAILED, 0)
            raise

    # ---------- 解析（核心逻辑，纯函数可单测） ----------

    def _parse_result(
        self,
        parsed: Dict[str, Any],
    ) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """解析 LLM 返回为 characters/relations 规范化结构。

        校验：
        - characters 必须为非空数组。
        - relations 的 from/to 必须在 characters 中存在（缺失则丢弃该边，标 warning）。
        - characters 字段规范化（缺失/None → 默认），age 非数字 → None（前端标红待补）。
        """
        chars_raw = parsed.get("characters")
        if not isinstance(chars_raw, list) or not chars_raw:
            raise conflict("AI 未识别到角色，请调整源内容后重试")

        characters: List[Dict[str, Any]] = []
        char_by_name: Dict[str, str] = {}  # 规范化 name -> 序号（去重：同名仅保留首个）
        name_index: Dict[str, int] = {}    # 规范化 name -> characters 下标
        for item in chars_raw:
            if not isinstance(item, dict):
                continue
            name = _norm_str(item.get("name"))
            if not name:
                continue
            if name in name_index:
                continue  # 同名去重（保留首个）
            age = item.get("age")
            try:
                age = int(age) if age is not None else None
            except (TypeError, ValueError):
                age = None
            attributes = item.get("attributes")
            if not isinstance(attributes, dict):
                attributes = {}
            character: Dict[str, Any] = {
                "name": name,
                "identity": _norm_str(item.get("identity")),
                "nationality": _norm_str(item.get("nationality")),
                "faith": _norm_str(item.get("faith")),
                "camp": _norm_str(item.get("camp")),
                "race": _norm_str(item.get("race")),
                "profession": _norm_str(item.get("profession")),
                "age": age,
                "gender": _norm_str(item.get("gender")),
                "attributes": {
                    "personality": _norm_str(attributes.get("personality")),
                    "background": _norm_str(attributes.get("background")),
                    "extracted": True,
                },
            }
            name_index[name] = len(characters)
            characters.append(character)

        if not characters:
            raise conflict("AI 未识别到有效角色，请调整源内容后重试")

        # 解析 relations（from/to 规范化匹配；对端缺失则丢弃）
        relations: List[Dict[str, Any]] = []
        rel_raw = parsed.get("relations")
        if isinstance(rel_raw, list):
            for item in rel_raw:
                if not isinstance(item, dict):
                    continue
                from_name = _norm_str(item.get("from"))
                to_name = _norm_str(item.get("to"))
                if not from_name or not to_name or from_name == to_name:
                    continue
                if from_name not in name_index or to_name not in name_index:
                    continue
                # 无向边规范化去重（A-B 与 B-A 同键）
                key = "|".join(sorted([from_name, to_name]))
                if any(
                    "|".join(sorted([r["from_name"], r["to_name"]])) == key
                    for r in relations
                ):
                    continue
                relations.append({
                    "from_name": from_name,
                    "to_name": to_name,
                    "relation_type": _norm_str(item.get("relation_type")) or "unknown",
                    "note": _norm_str(item.get("note")),
                })

        return characters, relations

    # ---------- commit（阶段三：二次编辑确认后写库） ----------

    def commit_extracted(
        self,
        project_id: str,
        characters: List[Dict[str, Any]],
        relations: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """提交抽取结果到库（二次编辑确认后调用）。

        写入顺序（原子语义由 role_map_store 文件锁保证）：
        1. 创建/复用 Role 实体（按 name 匹配：已存在则复用 + 更新 F8 字段）。
        2. 加入图谱 nodes。
        3. 建立关联（图谱边 + 双向 relations）。
        4. set_ai_progress(done) 置 ai_generated=true。

        返回：{created_roles, reused_roles, edges_added, ai_generated, generated_at}。
        """
        if not isinstance(characters, list) or not characters:
            raise bad_request("提交角色列表不能为空")

        self._set_progress(project_id, self.STAGE_COMMIT, 20)

        # 1. 创建/复用 Role 实体
        created_roles: List[str] = []
        reused_roles: List[str] = []
        role_id_by_name: Dict[str, str] = {}
        existing = {r["name"]: r["id"] for r in self._role_store.list_roles(project_id)}

        for char in characters:
            name = _norm_str(char.get("name"))
            if not name:
                continue
            if name in role_id_by_name:
                continue  # 去重（同名已处理）
            if name in existing:
                role_id = existing[name]
                reused_roles.append(name)
                # 复用：更新 F8 字段（不覆盖 name/id）
                self._role_store.update_role(project_id, role_id, **{
                    k: char.get(k)
                    for k in ("identity", "nationality", "faith", "camp", "race",
                              "profession", "age", "gender", "attributes")
                    if k in char
                })
            else:
                payload: Dict[str, Any] = {
                    "identity": char.get("identity", ""),
                    "nationality": char.get("nationality", ""),
                    "faith": char.get("faith", ""),
                    "camp": char.get("camp", ""),
                    "race": char.get("race", ""),
                    "profession": char.get("profession", ""),
                    "age": char.get("age"),
                    "gender": char.get("gender", ""),
                    "attributes": char.get("attributes", {}),
                    "relations": [],
                }
                role = self._role_store.create_role(project_id, name, **payload)
                role_id = role["id"]
                created_roles.append(name)
            role_id_by_name[name] = role_id

        self._set_progress(project_id, self.STAGE_COMMIT, 50)

        # 2. 加入图谱 nodes + 3. 建立关联
        for name, role_id in role_id_by_name.items():
            self._role_map_store.add_node(project_id, role_id)

        edges_added = 0
        for rel in relations:
            from_name = _norm_str(rel.get("from_name"))
            to_name = _norm_str(rel.get("to_name"))
            if from_name not in role_id_by_name or to_name not in role_id_by_name:
                continue
            from_id = role_id_by_name[from_name]
            to_id = role_id_by_name[to_name]
            if from_id == to_id:
                continue
            try:
                self._role_map_store.add_edge(
                    project_id, from_id, to_id,
                    relation_type=rel.get("relation_type", "unknown"),
                    note=rel.get("note", ""),
                )
                edges_added += 1
            except Exception:
                # 边已存在等冲突：跳过（幂等），不阻断提交
                continue

        self._set_progress(project_id, self.STAGE_DONE, 100)
        rm = self._role_map_store.get_role_map(project_id)
        return {
            "created_roles": created_roles,
            "reused_roles": reused_roles,
            "edges_added": edges_added,
            "ai_generated": bool(rm.get("ai_generated", False)),
            "generated_at": rm.get("generated_at"),
            "role_count": len(role_id_by_name),
        }
