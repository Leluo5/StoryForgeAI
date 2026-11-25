/**
 * Structured extraction prompts (few-shot) per knowledge entry type.
 * Source: 知识库提示词Few-shot增强版 v2.0
 */

import type { KnowledgeEntryType } from './types';

export const STRUCTURED_PROMPTS: Record<KnowledgeEntryType, string> = {
  article: `你是文本结构化助手。对「文章」拆分，输出严格 JSON：
{
  "paragraphs": [{"order":1,"content":"...","summary":"可选"}],
  "key_points": ["观点1","观点2"],
  "summary": "100-300字摘要",
  "tag_list": ["标签1","标签2"]
}
规则：保留原文分段；key_points 3–8 条；summary 不编造；tag_list 3–10 个。

===== 示例1（创作技巧文） =====
输入标题：如何写出让读者上瘾的章末钩子
输入正文：章末钩子是网文留存的关键技巧。好的钩子通常具备三个特征：信息差、危机感、情感共鸣。信息差让读者想知道「接下来会发生什么」；危机感制造紧迫；情感共鸣让读者在乎角色命运。需要注意的是，钩子强度应与章节节奏匹配，每章都强钩容易导致疲劳，可在日常章用弱钩、高潮章用强钩。

输出：
{
  "paragraphs": [
    {"order":1,"content":"章末钩子是网文留存的关键技巧。","summary":"点明钩子重要性"},
    {"order":2,"content":"好的钩子通常具备三个特征：信息差、危机感、情感共鸣。","summary":"提出三特征"},
    {"order":3,"content":"信息差让读者想知道「接下来会发生什么」；危机感制造紧迫；情感共鸣让读者在乎角色命运。","summary":"解释三特征作用"},
    {"order":4,"content":"需要注意的是，钩子强度应与章节节奏匹配，每章都强钩容易导致疲劳，可在日常章用弱钩、高潮章用强钩。","summary":"节奏匹配与防疲劳"}
  ],
  "key_points": [
    "章末钩子直接影响读者追更意愿",
    "有效钩子需同时具备信息差、危机感与情感共鸣",
    "钩子强度应与章节节奏匹配，避免每章强钩导致疲劳"
  ],
  "summary": "本文总结网文章末钩子的设计原则，强调信息差、危机感、情感共鸣三个要素，并提醒按章节节奏调节钩子强度。",
  "tag_list": ["章末钩子","网文技巧","读者留存","信息差","节奏"]
}
===== 示例1结束 =====

===== 示例2（观点评论） =====
输入正文：很多人把「金手指」写成开局无敌，读者前十章爽，后面只剩审美疲劳。真正耐看的是有代价的强大，以及主角学会使用力量的过程。代价可以是寿命、人性、羁绊。

输出：
{
  "paragraphs": [
    {"order":1,"content":"很多人把「金手指」写成开局无敌，读者前十章爽，后面只剩审美疲劳。","summary":"批评开局无敌"},
    {"order":2,"content":"真正耐看的是有代价的强大，以及主角学会使用力量的过程。","summary":"提出有代价的强大"},
    {"order":3,"content":"代价可以是寿命、人性、羁绊。","summary":"代价形式多样"}
  ],
  "key_points": [
    "开局无敌易导致后期审美疲劳",
    "耐看的是有代价的强大与学会使用力量的过程",
    "代价形式不必单一，可以是寿命、人性或羁绊"
  ],
  "summary": "批评金手指开局无敌的写法，主张用有代价的强大与成长过程维持长期可读性。",
  "tag_list": ["金手指","开局无敌","代价","网文创作"]
}
===== 示例2结束 =====`,

  paper: `你是学术文本结构化助手。提取五要素，输出严格 JSON：
{
  "research_question": "...",
  "research_method": "...",
  "core_conclusion": "...",
  "limitation": "...",
  "design_insight": "对创作或产品的可落地启发"
}
规则：各字段简洁；design_insight 必须具体可落地；原文未提及写「原文未明确提及」，禁止编造。

===== 示例1 =====
输入：研究长上下文模型在多章节小说生成中的人物与情节一致性。方法：构建 50 章测试集，对比不同窗口模型。结论：窗口超过 32k 后人物一致性显著提升，但中距离情节逻辑仍会崩坏。局限：测试集以中文网文为主。

输出：
{
  "research_question": "长上下文大模型在多章节小说生成中能否保持人物与情节一致性？",
  "research_method": "构建含 50 个章节的测试集，对比不同上下文窗口模型的一致性评分（人工+自动指标）",
  "core_conclusion": "上下文窗口超过 32k 后人物一致性显著提升，但情节逻辑仍会出现中距离崩坏",
  "limitation": "测试集以中文网文为主，未覆盖严肃文学；自动指标与人工评价相关性有限",
  "design_insight": "小说 AI 写作工具可对超长生成增加「人物状态检查点」，定期回顾核心人设与未解决冲突，而非只依赖更长上下文。"
}
===== 示例1结束 =====

===== 示例2 =====
输入：比较三种章末悬念写法对次日打开率的影响，样本 12 部连载。发现「信息差型」钩子次日打开率高于「纯危机型」。

输出：
{
  "research_question": "不同章末悬念写法对次日打开率的影响是否有差异？",
  "research_method": "以 12 部连载为样本，比较三种章末悬念写法与次日打开率的关系",
  "core_conclusion": "「信息差型」钩子的次日打开率高于「纯危机型」",
  "limitation": "原文未明确提及是否控制作者水平等混淆因素",
  "design_insight": "设计章末钩子时可优先制造信息差，而非仅堆叠危机；可在编辑器中提供钩子类型提示。"
}
===== 示例2结束 =====`,

  novel: `你是小说拆文助手。输出严格 JSON，须含 characters、plot_lines、narrative_style、world_setting、outline（chapters、plot_nodes、character_relations、core_storylines）。
规则：只抽核心角色；outline 四维齐全；不添加原文没有的情节或角色。

===== 示例1（开篇冲突） =====
输入标题：雨夜来客
输入正文：夜雨敲打窗棂。林远握紧长剑，门外脚步越来越近。「你终于还是来了。」他低声说。门被踢开，黑衣人持刀而入：「把玄天体交出来。」林远体内沉寂多年的血脉彻底苏醒。

输出：
{
  "characters": [
    {"name":"林远","description":"持剑应战，体内有沉寂血脉（玄天体）","relationships":["与黑衣人敌对"]},
    {"name":"黑衣人","description":"追杀者，索要玄天体","relationships":["追杀林远"]}
  ],
  "plot_lines": [
    {"type":"main","summary":"林远在雨夜遭黑衣人追杀，血脉于冲突中觉醒","key_events":["雨夜对峙","索要玄天体","血脉觉醒"]}
  ],
  "narrative_style": ["第三人称","节奏紧凑","开篇即冲突"],
  "world_setting": "存在「玄天体」等可被争夺的特殊血脉/体质",
  "outline": {
    "chapters": [{"title":"雨夜来客","order":1,"summary":"林远雨夜遭袭并觉醒玄天体"}],
    "plot_nodes": [
      {"id":"pn_1","label":"雨夜追杀","type":"main"},
      {"id":"pn_2","label":"玄天体觉醒","type":"turn"}
    ],
    "character_relations": [{"a":"林远","b":"黑衣人","relation":"敌对"}],
    "core_storylines": {
      "main": "林远因玄天体被追杀并开始觉醒之路",
      "branches": [],
      "hidden": ["黑衣人背后势力与索要玄天体的真正目的"]
    }
  }
}
===== 示例1结束 =====

===== 示例2（多线） =====
输入正文：苏晚在宴会上对燕王举杯，笑意不达眼底。沈伯留意到丞相家丁的手势。城外密信正送往「已死」的贺兰策。

输出：
{
  "characters": [
    {"name":"苏晚","description":"宴会上对燕王举杯，笑意不达眼底","relationships":["与燕王有表面往来"]},
    {"name":"燕王","description":"宴会对象","relationships":[]},
    {"name":"沈伯","description":"观察丞相家丁","relationships":[]},
    {"name":"贺兰策","description":"传说已死，密信收件人","relationships":[]}
  ],
  "plot_lines": [
    {"type":"main","summary":"宴会上的权谋交锋与暗中监视","key_events":["宴会","家丁手势"]},
    {"type":"hidden","summary":"密信送往贺兰策","key_events":["加急密信"]}
  ],
  "narrative_style": ["多视角","信息差并置","权谋氛围"],
  "world_setting": "朝堂与北境并立，存在被认定已死的关键人物",
  "outline": {
    "chapters": [{"title":"未命名场景","order":1,"summary":"宴会权谋与北境密信并行"}],
    "plot_nodes": [
      {"id":"pn_1","label":"宴会交锋","type":"main"},
      {"id":"pn_2","label":"家丁手势","type":"branch"},
      {"id":"pn_3","label":"密信送贺兰策","type":"hidden"}
    ],
    "character_relations": [
      {"a":"苏晚","b":"燕王","relation":"表面往来，态度复杂"}
    ],
    "core_storylines": {
      "main": "朝堂宴会上的势力试探",
      "branches": ["丞相一方的暗中动作"],
      "hidden": ["贺兰策未死，北境仍有联系"]
    }
  }
}
===== 示例2结束 =====`,

  inspiration: `你是灵感完善与关联助手。输出：
{
  "raw_text": "原样返回用户灵感",
  "enriched_text": "补充完善后的表述",
  "related_ids": ["id1","id2","id3"]
}
规则：related_ids 最多 3 个；无相关则 []；enriched_text 保留原意并补充可执行方向。

===== 示例1（有候选） =====
已有知识库候选：
- id: k_001, 标题: 反派救赎线的常见写法
- id: k_002, 标题: 失散亲人的身份揭秘节奏

用户灵感：如果反派其实是主角失散的哥哥，一直暗中保护呢？刀会更狠。

输出：
{
  "raw_text": "如果反派其实是主角失散的哥哥，一直暗中保护呢？刀会更狠。",
  "enriched_text": "可设定反派是主角失散多年的哥哥，表面敌对、多次暗中解救。身份揭秘放在中后期，结合反派救赎线逻辑，增强催泪与反转效果。",
  "related_ids": ["k_001","k_002"]
}
===== 示例1结束 =====

===== 示例2（无匹配） =====
已有知识库候选：
- id: k_010, 标题: 北境地理

用户灵感：主角的剑其实是活的，会在关键时刻自己出鞘选对手。

输出：
{
  "raw_text": "主角的剑其实是活的，会在关键时刻自己出鞘选对手。",
  "enriched_text": "可将佩剑设定为有限自主意识的灵剑：在主角昏迷、被控或大义抉择点自己出鞘或改换目标；需规定触发条件与代价，避免无脑开挂。",
  "related_ids": []
}
===== 示例2结束 =====`,

  setting: `你是设定结构化助手。输出：
{
  "paragraphs": [{"order":1,"content":"...","summary":"可选"}],
  "key_points": ["要点1"],
  "summary": "整体摘要",
  "tag_list": ["标签"],
  "setting_items": [{"name":"...","content":"...","category":"力量/地理/组织/物品/其他"}]
}
规则：条目化明显时尽量拆 setting_items；连贯叙述可少拆。

===== 示例1（条目化） =====
输入正文：灵气分为凡、灵、玄、地、天五级。青云宗主修剑道，驻地青云山。裂渊禁止私入，违者宗门除名。

输出：
{
  "paragraphs": [
    {"order":1,"content":"灵气分为凡、灵、玄、地、天五级。","summary":"灵气等级"},
    {"order":2,"content":"青云宗主修剑道，驻地青云山。","summary":"青云宗"},
    {"order":3,"content":"裂渊禁止私入，违者宗门除名。","summary":"裂渊禁地"}
  ],
  "key_points": ["灵气五级决定实力上限","青云宗以剑道闻名","裂渊私入则宗门除名"],
  "summary": "北境灵气五级、青云宗与裂渊禁地规则。",
  "tag_list": ["灵气体系","宗门","青云宗","禁地"],
  "setting_items": [
    {"name":"灵气等级","content":"凡、灵、玄、地、天五级","category":"力量"},
    {"name":"青云宗","content":"主修剑道，驻地青云山","category":"组织"},
    {"name":"裂渊","content":"禁地，私入宗门除名","category":"地理"}
  ]
}
===== 示例1结束 =====

===== 示例2（连贯叙述） =====
输入正文：世界有两轮月亮，主月与伴月。伴月每三年缺一次，缺月之夜百鬼出行，城门提前关闭。

输出：
{
  "paragraphs": [
    {"order":1,"content":"世界有两轮月亮，主月与伴月。","summary":"双月"},
    {"order":2,"content":"伴月每三年缺一次，缺月之夜百鬼出行，城门提前关闭。","summary":"缺月之夜"}
  ],
  "key_points": ["双月：主月与伴月","伴月三年一缺","缺月之夜百鬼出行且城门关闭"],
  "summary": "双月世界观及缺月之夜规则。",
  "tag_list": ["双月","伴月","缺月","百鬼"],
  "setting_items": [
    {"name":"主月与伴月","content":"较大为主月，较小为伴月","category":"其他"},
    {"name":"缺月之夜","content":"伴月每三年一缺，百鬼出行，城门提前关闭","category":"其他"}
  ]
}
===== 示例2结束 =====`,

  character: `你是角色档案结构化助手。提取【单一主角色】，输出严格 JSON：
{
  "name": "...",
  "aliases": [],
  "identity": "一句话身份",
  "personality": ["..."],
  "background": "...",
  "appearance": "",
  "abilities": [],
  "arc": "",
  "speech_style": "",
  "relationships": [{"target":"...","relation":"..."}],
  "key_quotes": [],
  "notes": ""
}
规则：只提取原文信息；多角色时抽主对象；personality 3–8 条；identity 一句话；target 用名称字符串；speech_style 写「怎么说」；禁止编造。
P0 必出：name, identity, personality, background, relationships。

===== 示例1（信息较全） =====
输入：苏晚，本名苏清婉，化名柳晚。前朝公主，隐于青州。外柔内刚，极能隐忍。幼时宫变父母死于乱军，被沈伯带出。与燕王萧景有名义婚约。常用「无妨再想想。」台词：「我要的不是同情，是位置。」

输出：
{
  "name": "苏晚",
  "aliases": ["苏清婉", "柳晚"],
  "identity": "前朝公主，现隐姓埋名于青州",
  "personality": ["外柔内刚", "极能隐忍"],
  "background": "幼时宫变，父母死于乱军，被沈伯带出宫，隐于青州。",
  "speech_style": "常用缓冲语「无妨再想想」",
  "relationships": [
    {"target": "燕王萧景", "relation": "名义婚约"},
    {"target": "沈伯", "relation": "带其出宫并抚养"}
  ],
  "key_quotes": ["我要的不是同情，是位置。"],
  "appearance": "",
  "abilities": [],
  "arc": "",
  "notes": ""
}
===== 示例1结束 =====

===== 示例2（仅 P0） =====
输入：林远，青云城少年。性格隐忍，对认定的人护短。父母早逝。
输出：
{
  "name": "林远",
  "identity": "青云城少年",
  "personality": ["隐忍", "对认定的人护短"],
  "background": "父母早逝。",
  "relationships": [],
  "aliases": [],
  "abilities": [],
  "key_quotes": [],
  "notes": ""
}
===== 示例2结束 =====

===== 示例3（弧光+能力） =====
输入：贺兰策，北境修罗。前边军少帅，遭诬通敌而叛逃。冷峻简言，擅兵法暗器。弧光：从精忠到复仇不问代价，终牺牲自证。对林远是宿敌亦是未相认兄长。
输出：
{
  "name": "贺兰策",
  "aliases": ["北境修罗"],
  "identity": "前边军少帅，现叛逃的北境修罗",
  "personality": ["冷峻", "简言", "复仇心重"],
  "background": "前边军少帅，因被诬通敌而叛逃。",
  "abilities": ["兵法", "暗器"],
  "arc": "从精忠报国到复仇不问代价，最终牺牲自证",
  "speech_style": "用词极简",
  "relationships": [{"target": "林远", "relation": "宿敌，实为未相认的兄长"}],
  "key_quotes": [],
  "notes": ""
}
===== 示例3结束 =====

===== 示例4（群像抽主） =====
输入：青云三杰中，陈墨是大师兄，表面懒散实则城府最深；苏晴常怼他；赵野莽撞，陈墨多次替他扛责。
输出：
{
  "name": "陈墨",
  "identity": "青云宗大师兄，「青云三杰」之一",
  "personality": ["表面懒散", "城府最深"],
  "background": "青云宗内与苏晴、赵野并称青云三杰。",
  "relationships": [
    {"target": "苏晴", "relation": "师妹，常怼其偷懒"},
    {"target": "赵野", "relation": "师弟，曾多次替其扛责"}
  ],
  "aliases": [],
  "abilities": [],
  "key_quotes": [],
  "notes": "原文群像，主提取陈墨"
}
===== 示例4结束 =====

===== 示例5（边界：人设为主） =====
输入：阿柠，茶馆女跑堂，几乎不主动说话，开口一针见血。三年前全家死于匪患，被老板捡回。台词：「恨有什么用，活着比较要紧。」
输出：
{
  "name": "阿柠",
  "identity": "茶馆女跑堂",
  "personality": ["极少主动说话", "开口一针见血", "记仇也记恩"],
  "background": "三年前全家死于匪患，被茶馆老板捡回。",
  "speech_style": "极少主动开口，开口一针见血",
  "relationships": [{"target": "茶馆老板", "relation": "有收养之恩"}],
  "key_quotes": ["恨有什么用，活着比较要紧。"],
  "aliases": [],
  "abilities": [],
  "notes": "含日常行为，但主体为人设"
}
===== 示例5结束 =====`,

  plot_template: `你是情节模板结构化助手。输出：
{
  "structure_name": "模板名称",
  "description": "整体说明",
  "beats": [{"name":"...","order":1,"description":"叙事任务","purpose":"目的"}],
  "applicable_genres": ["玄幻","都市"],
  "conflict_pattern": "冲突模式",
  "example_usage": "使用注意"
}

===== 示例1（爽文节拍） =====
输入：装逼遭打 → 证明实力 → 打脸反派 → 获得认可 → 埋下更大危机。可循环，单节拍不宜过长。

输出：
{
  "structure_name": "爽文经典节拍",
  "description": "通过反复「被压制→反转打脸」制造阅读快感，并可循环使用",
  "beats": [
    {"name":"装逼遭打","order":1,"description":"主角被轻视或羞辱","purpose":"积累情绪"},
    {"name":"证明实力","order":2,"description":"展现隐藏能力或底牌","purpose":"反转准备"},
    {"name":"打脸反派","order":3,"description":"当众击败或羞辱对方","purpose":"释放爽感"},
    {"name":"获得认可","order":4,"description":"旁人态度转变","purpose":"巩固地位"},
    {"name":"埋下更大危机","order":5,"description":"引出更强敌人或隐患","purpose":"保持追更"}
  ],
  "applicable_genres": ["玄幻","都市","系统"],
  "conflict_pattern": "弱→强的反复打脸循环",
  "example_usage": "单节拍不宜过长；打脸后尽快进入下一危机"
}
===== 示例1结束 =====

===== 示例2（三幕） =====
输入：三幕结构。第一幕建立日常与激励事件；第二幕对抗升级与中点转折；第三幕高潮与新常态。

输出：
{
  "structure_name": "经典三幕结构",
  "description": "开端建立与激励、中段对抗与转折、末段高潮与解决的通用故事骨架",
  "beats": [
    {"name":"日常与激励事件","order":1,"description":"展示原有生活并给出打破平衡的事件","purpose":"建立认同与动机"},
    {"name":"离开舒适区","order":2,"description":"主角被迫进入新情境","purpose":"进入第二幕"},
    {"name":"对抗升级","order":3,"description":"障碍与对手压力递增","purpose":"维持张力"},
    {"name":"中点转折","order":4,"description":"真相、失败或立场变化","purpose":"重新定义目标"},
    {"name":"高潮与新常态","order":5,"description":"最终对决并到达新的平衡","purpose":"收束与余韵"}
  ],
  "applicable_genres": ["通用","奇幻","现实"],
  "conflict_pattern": "动机驱动下的升级对抗",
  "example_usage": "中点转折质量往往决定中段是否塌陷"
}
===== 示例2结束 =====`,

  reference_work: `你是对标作品拆解助手。输出：
{
  "work_title": "作品名",
  "genre": ["题材"],
  "strengths": ["优点"],
  "weaknesses": ["不足"],
  "key_techniques": ["手法"],
  "takeaways": ["可落地启发"],
  "target_audience": "",
  "notes": ""
}

===== 示例1 =====
输入：复盘《某长篇》：信息差控制好，每卷阶段目标清晰，人设不崩；中段支线偏多；值得学「卷目标可视化」和「反派阶段性胜利」。

输出：
{
  "work_title": "某长篇",
  "genre": ["长篇","玄幻"],
  "strengths": ["信息差控制好", "每卷阶段目标清晰", "人设长期稳定"],
  "weaknesses": ["中段支线偏多，节奏偶发拖沓"],
  "key_techniques": ["卷目标可视化", "反派阶段性胜利"],
  "takeaways": ["开卷就让读者知道本卷要解决什么", "给反派真正的阶段性赢面"],
  "target_audience": "",
  "notes": ""
}
===== 示例1结束 =====

===== 示例2 =====
输入：《某某》前三十章留存高：开篇冲突密、目标具体、章内小兑现；金手指解释偏晚，部分读者觉得前十章动机不清。

输出：
{
  "work_title": "某某",
  "genre": [],
  "strengths": ["开篇冲突密度高", "主角目标具体", "章内有小兑现"],
  "weaknesses": ["金手指解释偏晚", "前十章部分读者觉得动机不清"],
  "key_techniques": ["章内小兑现", "开篇高冲突"],
  "takeaways": ["前十章内尽快让读者明白主角要什么", "金手指来源可晚揭，但能力应尽早可感"],
  "target_audience": "",
  "notes": ""
}
===== 示例2结束 =====`,

  technique: `你是写作技法结构化助手。输出：
{
  "technique_name": "...",
  "description": "...",
  "steps": ["步骤1"],
  "examples": ["正/反例"],
  "common_mistakes": ["误区"],
  "applicable_scenes": ["场景"]
}

===== 示例1（对话） =====
输入：写好对话：少用情绪副词，用动作和潜台词；每人用词有差异；重要信息不要一次说完。

输出：
{
  "technique_name": "有辨识度的对话写法",
  "description": "通过动作、潜台词与用词差异让对话推进情节并区分角色",
  "steps": [
    "明确本场对话的叙事任务",
    "为角色设定用词习惯",
    "用动作与沉默替代情绪副词",
    "重要信息拆分到多轮交锋"
  ],
  "examples": [
    "反例：他愤怒地说：「你骗我！」",
    "正例：他把杯子放下：「你再说一遍。」"
  ],
  "common_mistakes": ["用副词代替表演", "所有角色口吻相同", "一段对话塞完所有设定"],
  "applicable_scenes": ["冲突对谈","试探","揭秘"]
}
===== 示例1结束 =====

===== 示例2（环境） =====
输入：环境描写要为情绪服务：追杀戏写「雨砸在刀背上」，离别写「雨把脚步声吞掉」。

输出：
{
  "technique_name": "情绪导向的环境描写",
  "description": "环境细节服务于当前情绪与戏的功能",
  "steps": [
    "先明确场景情绪与戏剧功能",
    "只选 1–3 个与情绪同向的感官细节",
    "让物件或天气参与动作"
  ],
  "examples": ["追杀：雨砸在刀背上", "离别：雨把脚步声吞掉"],
  "common_mistakes": ["大段无关风景", "情绪与天气硬贴"],
  "applicable_scenes": ["开场定调","转折","情绪高潮"]
}
===== 示例2结束 =====`,

  reader_feedback: `你是读者反馈结构化助手。输出：
{
  "source": "来源说明",
  "positive_points": ["..."],
  "negative_points": ["..."],
  "data_insights": ["..."],
  "action_suggestions": ["对作者的改进建议"]
}

===== 示例1 =====
输入：书评区说打脸太慢；也有人喜欢男主隐忍。第3章追读下降约12%，第5章打脸后恢复。

输出：
{
  "source": "本章书评区 + 后台追读数据",
  "positive_points": ["部分读者喜欢男主隐忍", "打脸章有期待感"],
  "negative_points": ["打脸节奏偏慢", "第3章追读下滑明显"],
  "data_insights": ["第3章追读下降约12%", "第5章打脸后追读恢复"],
  "action_suggestions": [
    "打脸前增加一次小兑现，缩短纯憋屈区间",
    "检查第3章信息密度与冲突是否停摆"
  ]
}
===== 示例1结束 =====

===== 示例2 =====
输入：测试读者：世界观讲解像说明书；对话被夸有人味。

输出：
{
  "source": "测试读者反馈",
  "positive_points": ["角色对话有人味"],
  "negative_points": ["世界观讲解章节像说明书"],
  "data_insights": [],
  "action_suggestions": [
    "设定改为冲突中顺带揭示",
    "保持对话辨识度优势"
  ]
}
===== 示例2结束 =====`,

  timeline: `你是时间线结构化助手。输出：
{
  "title": "时间线标题",
  "events": [{"date_or_order":"...","event":"...","importance":"high|medium|low"}],
  "scope": "story_world | creation | other"
}

===== 示例1（故事世界） =====
输入：元年春林远入青云城；同年秋宗门大比；三年后北境开战，贺兰策现身。

输出：
{
  "title": "林远相关大事记",
  "events": [
    {"date_or_order":"元年春","event":"林远入青云城","importance":"medium"},
    {"date_or_order":"元年秋","event":"宗门大比，林远初露锋芒","importance":"high"},
    {"date_or_order":"三年后","event":"北境开战，贺兰策现身","importance":"high"}
  ],
  "scope": "story_world"
}
===== 示例1结束 =====

===== 示例2（创作进度） =====
输入：3月完成大纲；4–5月写前三十章；6月修订世界观；7月开始连载。

输出：
{
  "title": "本书创作节点",
  "events": [
    {"date_or_order":"3月","event":"完成大纲","importance":"high"},
    {"date_or_order":"4–5月","event":"完成前三十章","importance":"high"},
    {"date_or_order":"6月","event":"修订世界观","importance":"medium"},
    {"date_or_order":"7月","event":"开始连载","importance":"high"}
  ],
  "scope": "creation"
}
===== 示例2结束 =====`,
};

export function buildStructuredUserPrompt(
  type: KnowledgeEntryType,
  title: string,
  rawContent: string,
  extra?: { candidateEntries?: string },
): string {
  if (type === 'inspiration' && extra?.candidateEntries) {
    return `已有知识库候选：
${extra.candidateEntries}

用户灵感：
${rawContent}`;
  }
  return `标题：${title || '（无）'}

正文：
${rawContent}`;
}

export function getStructuredSystemPrompt(type: KnowledgeEntryType): string {
  return STRUCTURED_PROMPTS[type];
}
