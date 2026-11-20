// M3c-2 关系类型默认种子（F2 §2.2.3，5 组 23 类）
// 作品创建时同事务写入；存量作品由迁移与首次访问角色页签时幂等补种
// 幂等键 UNIQUE (work_id, code)，并发补种走 ON CONFLICT DO NOTHING（Q2 / A2）

export interface CharacterRelationTypeSeed {
  code: string;
  label: string;
  group_key: string;
  group_label: string;
  directed: boolean;
  reverse_label: string | null;
  sort_order: number;
}

export const DEFAULT_CHARACTER_RELATION_TYPES: readonly CharacterRelationTypeSeed[] = [
  { code: 'kinship_father_child', label: '父', group_key: 'kinship', group_label: '亲属', directed: true, reverse_label: '子', sort_order: 1 },
  { code: 'kinship_mother_child', label: '母', group_key: 'kinship', group_label: '亲属', directed: true, reverse_label: '子', sort_order: 2 },
  { code: 'kinship_sibling', label: '兄弟', group_key: 'kinship', group_label: '亲属', directed: false, reverse_label: null, sort_order: 3 },
  { code: 'kinship_sister', label: '姐妹', group_key: 'kinship', group_label: '亲属', directed: false, reverse_label: null, sort_order: 4 },
  { code: 'kinship_spouse', label: '夫妻', group_key: 'kinship', group_label: '亲属', directed: false, reverse_label: null, sort_order: 5 },
  { code: 'kinship_grandparent', label: '祖', group_key: 'kinship', group_label: '亲属', directed: true, reverse_label: '孙', sort_order: 6 },
  { code: 'kinship_adoption', label: '收养', group_key: 'kinship', group_label: '亲属', directed: true, reverse_label: '被收养', sort_order: 7 },
  { code: 'kinship_step', label: '继父母', group_key: 'kinship', group_label: '亲属', directed: true, reverse_label: '继子女', sort_order: 8 },
  { code: 'society_master_apprentice', label: '师', group_key: 'society', group_label: '社会', directed: true, reverse_label: '徒', sort_order: 9 },
  { code: 'society_master_servant', label: '主', group_key: 'society', group_label: '社会', directed: true, reverse_label: '仆', sort_order: 10 },
  { code: 'society_same_school', label: '同门', group_key: 'society', group_label: '社会', directed: false, reverse_label: null, sort_order: 11 },
  { code: 'society_colleague', label: '同事', group_key: 'society', group_label: '社会', directed: false, reverse_label: null, sort_order: 12 },
  { code: 'society_superior_subordinate', label: '上级', group_key: 'society', group_label: '社会', directed: true, reverse_label: '下级', sort_order: 13 },
  { code: 'emotion_admiration', label: '爱慕', group_key: 'emotion', group_label: '情感', directed: true, reverse_label: '被爱慕', sort_order: 14 },
  { code: 'emotion_lover', label: '恋人', group_key: 'emotion', group_label: '情感', directed: false, reverse_label: null, sort_order: 15 },
  { code: 'emotion_close_friend', label: '挚友', group_key: 'emotion', group_label: '情感', directed: false, reverse_label: null, sort_order: 16 },
  { code: 'emotion_first_love', label: '初恋', group_key: 'emotion', group_label: '情感', directed: false, reverse_label: null, sort_order: 17 },
  { code: 'camp_ally', label: '盟友', group_key: 'camp', group_label: '阵营', directed: false, reverse_label: null, sort_order: 18 },
  { code: 'camp_hostile', label: '敌对', group_key: 'camp', group_label: '阵营', directed: false, reverse_label: null, sort_order: 19 },
  { code: 'camp_nemesis', label: '宿敌', group_key: 'camp', group_label: '阵营', directed: false, reverse_label: null, sort_order: 20 },
  { code: 'camp_loyalty', label: '效忠', group_key: 'camp', group_label: '阵营', directed: true, reverse_label: '被效忠', sort_order: 21 },
  { code: 'other_acquaintance', label: '认识', group_key: 'other', group_label: '其他', directed: false, reverse_label: null, sort_order: 22 },
  { code: 'other_competitor', label: '竞争对手', group_key: 'other', group_label: '其他', directed: false, reverse_label: null, sort_order: 23 }
];

// EntityManager / QueryRunner 的结构子集，避免种子模块依赖具体数据库实现
export interface SqlExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

// 幂等补种：作品创建时调用，也用于存量作品首次访问角色页签
export async function seedCharacterRelationTypes(executor: SqlExecutor, workId: string): Promise<void> {
  for (const type of DEFAULT_CHARACTER_RELATION_TYPES) {
    await executor.query(
      `INSERT INTO character_relation_types
         (id, work_id, code, label, group_key, group_label, directed, reverse_label, is_builtin, sort_order)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, true, $8)
       ON CONFLICT (work_id, code) DO NOTHING`,
      [
        workId,
        type.code,
        type.label,
        type.group_key,
        type.group_label,
        type.directed,
        type.reverse_label,
        type.sort_order
      ]
    );
  }
}
