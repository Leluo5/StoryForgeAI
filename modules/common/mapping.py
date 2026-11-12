"""共享类型映射。

承载跨模块重复的静态映射（如 Coze 组件类型 -> 本地参数类型），
供 work_manager / coze_client 复用，消除复制粘贴重复。
"""


_COMPONENT_TYPE_MAP = {
    "text": "text",
    "textarea": "textarea",
    "number": "number",
    "select": "select",
    "multiselect": "multiselect",
    "file": "file",
    "date": "date",
    "boolean": "boolean",
    "dropdown": "select",
}


def map_component_type(coze_type: str) -> str:
    """映射 Coze 组件类型到本地参数类型（未知类型回退 text）。"""
    return _COMPONENT_TYPE_MAP.get(coze_type, "text")
