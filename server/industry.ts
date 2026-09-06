/**
 * 行业基础类型与稳定标识。
 *
 * 东方财富实时行情的 f100 字段通常只返回行业名称，不保证提供可长期依赖的
 * 行业编码。这里保留原始名称，同时生成“eastmoney:<规范化名称>”形式的稳定键，
 * 方便 SQLite 在不同交易日沉淀行业归属。名称变化或分类切换时，调用方应显式
 * 记录 taxonomyVersion，而不是悄悄覆盖历史归属。
 */

export const INDUSTRY_TAXONOMY = "eastmoney" as const;

export interface IndustryRecord {
  code: string;
  name: string;
  level: number;
  parentCode: string | null;
  taxonomy: string;
  taxonomyVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface StockIndustryMembership {
  code: string;
  industryCode: string;
  industryName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  sourceField: string | null;
  confidence: number;
}

export interface IndustryMembershipInput {
  code: string;
  industryName: string | null | undefined;
  effectiveFrom: string;
  source?: string;
  sourceField?: string;
  confidence?: number;
  taxonomyVersion?: string | null;
}

export interface ClueIndustryLinkInput {
  clueId: string;
  industryCode?: string;
  industryName?: string;
  relevance: number;
  influenceDirection: -1 | 0 | 1;
  chainPosition?: string | null;
  evidence?: string | null;
}

export interface ClueIndustryLink {
  clueId: string;
  industryCode: string;
  industryName: string;
  relevance: number;
  influenceDirection: -1 | 0 | 1;
  chainPosition: string | null;
  evidence: string | null;
  createdAt: string;
}

/** 将东方财富 f100 之类的自由文本安全地规范化为可匹配的名称。 */
export function normalizeIndustryName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const name = String(value)
    .replace(/[\u00a0\s]+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .trim();
  if (!name || name === "-" || name === "--" || name === "未知" || name === "暂无") return null;
  return name.slice(0, 80);
}

/** 行业名称的稳定键；不依赖运行时随机值，便于历史数据库与导入文件复用。 */
export function industryCodeForName(value: string): string {
  const name = normalizeIndustryName(value);
  if (!name) throw new Error("行业名称不能为空");
  return `${INDUSTRY_TAXONOMY}:${stableHash(name)}`;
}

function stableHash(value: string): string {
  // FNV-1a 32 位足够作为本地分类键；原始名称仍保存在 industries.name 中。
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

