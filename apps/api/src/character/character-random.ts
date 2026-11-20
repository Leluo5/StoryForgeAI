import { createHash } from 'node:crypto';
import type { CharacterAttribute, CharacterDossier } from '@storyforge/contracts';
import { ageToBand } from './character-candidate.normalize';

// ──────────────────────── 确定性 PRNG ────────────────────────

/** mulberry32：单 32-bit seed → 可复现的 [0,1) 随机序列 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  const hex = createHash('sha256').update(seed).digest('hex');
  return Number.parseInt(hex.slice(0, 8), 16);
}

// ──────────────────────── 候选池（与 Python 旧 random_system 语义对齐） ────────────────────────

const NAMES = [
  '江离', '沈砚', '陆行', '白舟', '云麓', '苏晚', '谢时', '顾之', '孟野', '柳序',
  '林风眠', '阮长安', '叶知秋', '方惊鸿', '程雪舟', '韩照', '周衍', '吴知', '陈墨', '褚风',
  'Aria', 'Kael', 'Lyra', 'Noah', 'Elena', 'Dante', 'Maya', 'Leo', 'Zoe', 'Ivan'
];

const IDENTITIES = [
  '游侠', '史官', '铸剑师', '游方郎中', '书院山长', '镇抚司校尉', '江湖剑客',
  '隐士', '歌姬', '花匠', '药师', '猎户', '御厨', '乐师', '占星师', '译官',
  '商人', '账房', '镖师', '信使', '武师', '画家', '抄书吏', '船娘', '巡山僧'
];

const GENDERS = ['男', '女', '非二元'];

const PERSONALITIES = [
  '冷静自持，善于在混乱中保持清醒',
  '热情奔放，行事雷厉风行',
  '外冷内热，对认定的朋友格外护短',
  '随性洒脱，不被世俗规矩束缚',
  '思虑缜密，每一步都算得清清楚楚',
  '憨直忠勇，认定的事九头牛也拉不回',
  '敏感细腻，能察言观色，擅读人心',
  '桀骜不驯，对权威天然抱有敌意',
  '温润如玉，说话从不带锋却自有分量',
  '阴郁寡言，内心藏着不为人知的伤痛'
];

const NATIONALITIES = [
  '大夏', '北漠', '南疆', '东海', '西域', '东瀛', '西戎', '百越'
];

const FAITHS = ['天道', '佛', '道', '无', '星象', '古神'];

const CAMPS = ['正道', '魔道', '中立', '江湖', '朝堂', '世外'];

const RACES = ['人', '妖', '半妖', '灵族', '机械', '魔族', '精灵'];

const PROFESSIONS = IDENTITIES; // 复用：职业与身份同池

const AVATAR_ASSET_POOL = Array.from({ length: 16 }, (_, i) => `avatar-${i}`);

// 每类属性键保持 ≤ 20 字，值 ≤ 200 字（契约层已兜底；此处人工控长）
const ATTRIBUTE_TEMPLATES: { key: string; values: string[] }[] = [
  { key: '武学造诣', values: ['宗师', '登堂入室', '初窥门径', '天赋异禀', '平平无奇'] },
  { key: '才情', values: ['惊世', '过人', '普通', '愚钝'] },
  { key: '出身', values: ['寒门', '世家', '皇室', '流民', '商贾', '工匠'] },
  { key: '武器', values: ['长剑', '短刀', '折扇', '长鞭', '机关弩', '徒手', '玉笛', '铜钱'] },
  { key: '坐骑', values: ['赤兔', '雪蹄', '铁鹰', '无', '御剑'] },
  { key: '特技', values: ['过目不忘', '日行千里', '百毒不侵', '易容', '医术', '毒术', '阵法'] },
  { key: '弱点', values: ['重情义', '贪杯', '好色', '惧内', '有暗伤', '执念太深', '信任他人'] },
  { key: '信物', values: ['玉佩', '断剑', '半卷残书', '一枚铜钱', '家传印章', '奇怪的罗盘'] },
  { key: '口头禅', values: ['有意思', '还未到时候', '告辞', '哈哈哈哈哈', '无聊', '随他去'] },
  { key: '喜好', values: ['饮酒', '读书', '练剑', '下棋', '钓鱼', '游山玩水', '敛财', '布施'] }
];

const STATUSES = ['active'];

// ──────────────────────── 工具函数 ────────────────────────

function pick<T>(pool: readonly T[], rnd: () => number): T {
  const idx = Math.floor(rnd() * pool.length);
  return pool[idx] as T;
}

function pickMany<T>(pool: readonly T[], count: number, rnd: () => number): T[] {
  const copy = [...pool];
  const out: T[] = [];
  while (out.length < count && copy.length > 0) {
    const index = Math.floor(rnd() * copy.length);
    const [picked] = copy.splice(index, 1);
    out.push(picked as T);
  }
  return out;
}

function randomInt(min: number, max: number, rnd: () => number): number {
  return Math.floor(rnd() * (max - min + 1)) + min;
}

// ──────────────────────── 公共接口 ────────────────────────

export interface RandomDossierResult {
  seed: string;
  dossier: CharacterDossier;
  avatar_asset_id: string | null;
}

export function generateRandomDossier(seedInput?: string): RandomDossierResult {
  const seed = seedInput ?? `char-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rnd = mulberry32(hashSeed(seed));

  const age = randomInt(8, 85, rnd);
  const age_band = ageToBand(age);
  const attributeCount = randomInt(2, 5, rnd);
  const selectedKeys = pickMany(ATTRIBUTE_TEMPLATES, attributeCount, rnd);
  const attributes: CharacterAttribute[] = selectedKeys.map((t) => ({
    key: t.key,
    value: pick(t.values, rnd)
  }));
  const avatar_asset_id = pick(AVATAR_ASSET_POOL, rnd);

  const dossier: CharacterDossier = {
    name: pick(NAMES, rnd),
    identity: pick(IDENTITIES, rnd),
    age,
    gender: pick(GENDERS, rnd),
    personality: pick(PERSONALITIES, rnd),
    experience: '',
    country_region: pick(NATIONALITIES, rnd),
    faith: pick(FAITHS, rnd),
    faction: pick(CAMPS, rnd),
    race: pick(RACES, rnd),
    occupation: pick(PROFESSIONS, rnd),
    age_band,
    attributes
  };

  return { seed, dossier, avatar_asset_id };
}

export const RANDOM_STATUSES = STATUSES;
