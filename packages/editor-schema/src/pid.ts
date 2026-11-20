import { Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';

// 块级 pid：仅表示段落身份，用于锚点定位与排版稳定；不含业务语义。
// 约定一律使用 UUID v4 随机生成（F2 §3.6.1 v1.4 补充约定 / ADR-0003）。
const PID_BLOCK_TYPES = new Set(['paragraph', 'heading']);
const PID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PidValidationResult {
  invalid: Array<{ type: string; pid: unknown; position: number }>;
  duplicates: Array<{ pid: string; count: number }>;
}

export function newPid(): string {
  return crypto.randomUUID().toLowerCase();
}

export function isPidBlock(node: Node): boolean {
  return PID_BLOCK_TYPES.has(node.type.name);
}

export function isValidPid(value: unknown): value is string {
  return typeof value === 'string' && PID_PATTERN.test(value);
}

export function validateDocumentPids(document: Node): PidValidationResult {
  const invalid: PidValidationResult['invalid'] = [];
  const counts = new Map<string, number>();

  document.descendants((node, position) => {
    if (!isPidBlock(node)) return true;
    const pid = node.attrs.pid;
    if (pid === null || pid === undefined) return true;
    if (!isValidPid(pid)) {
      invalid.push({ type: node.type.name, pid, position });
      return true;
    }
    counts.set(pid, (counts.get(pid) ?? 0) + 1);
    return true;
  });

  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([pid, count]) => ({ pid, count }))
    .sort((left, right) => left.pid.localeCompare(right.pid));

  return { invalid, duplicates };
}

// 仅补齐缺失或为 null 的 pid；已有 pid 原样保留，重复调用幂等。
export function ensurePids(document: Node): Node {
  const transform = new Transform(document);
  const positions: number[] = [];

  document.descendants((node, position) => {
    if (!isPidBlock(node)) return true;
    if (node.attrs.pid === null || node.attrs.pid === undefined) positions.push(position);
    return true;
  });

  for (const position of positions) {
    transform.setNodeAttribute(position, 'pid', newPid());
  }
  return transform.doc;
}

// 剔除 attrs.pid，并清理变空的 attrs / content / marks，供内容哈希使用。
export function stripPidAttributes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPidAttributes);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'attrs') {
      const attrs = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
      const cleaned: Record<string, unknown> = {};
      for (const [attrKey, attrValue] of Object.entries(attrs as Record<string, unknown>)) {
        if (attrKey !== 'pid') cleaned[attrKey] = stripPidAttributes(attrValue);
      }
      if (Object.keys(cleaned).length > 0) result.attrs = cleaned;
      continue;
    }
    if ((key === 'content' || key === 'marks') && Array.isArray(item)) {
      const cleaned = item.map(stripPidAttributes);
      if (cleaned.length > 0) result[key] = cleaned;
      continue;
    }
    result[key] = stripPidAttributes(item);
  }
  return result;
}

interface PidBlockSnapshot {
  pid: unknown;
  signature: string;
}

function blockSignature(node: Node): string {
  return JSON.stringify(stripPidAttributes(node.toJSON()));
}

function collectPidBlocks(document: Node): PidBlockSnapshot[] {
  const blocks: PidBlockSnapshot[] = [];
  document.descendants((node) => {
    if (!isPidBlock(node)) return true;
    blocks.push({ pid: node.attrs.pid, signature: blockSignature(node) });
    return true;
  });
  return blocks;
}

// 整篇替换前保留未改动段落的 pid：按文档顺序做内容签名匹配，命中即复用，其余分配新 pid。
export function preservePids(base: Node, candidate: Node): Node {
  const baseBlocks = collectPidBlocks(base);
  const transform = new Transform(candidate);
  const assignments: Array<{ position: number; pid: string }> = [];
  let cursor = 0;

  candidate.descendants((node, position) => {
    if (!isPidBlock(node)) return true;
    const signature = blockSignature(node);
    let matchedIndex = -1;
    for (let index = cursor; index < baseBlocks.length; index += 1) {
      if (baseBlocks[index]?.signature === signature) {
        matchedIndex = index;
        break;
      }
    }

    let pid: string;
    if (matchedIndex >= 0) {
      cursor = matchedIndex + 1;
      const basePid = baseBlocks[matchedIndex]?.pid;
      pid = isValidPid(basePid) ? basePid : isValidPid(node.attrs.pid) ? node.attrs.pid : newPid();
    } else {
      pid = isValidPid(node.attrs.pid) ? node.attrs.pid : newPid();
    }

    if (pid !== node.attrs.pid) assignments.push({ position, pid });
    return true;
  });

  for (const { position, pid } of assignments) {
    transform.setNodeAttribute(position, 'pid', pid);
  }
  return transform.doc;
}
