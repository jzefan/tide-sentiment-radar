import type { LiveClueRangeProof, RawClue } from "./eastMoney.ts";

interface ForumFeedPayload {
  schema_version?: string;
  source?: { id?: string; name?: string; license_id?: string; terms_url?: string };
  items?: Array<{
    id?: string;
    stock_codes?: string[];
    title?: string;
    excerpt?: string;
    permalink?: string;
    published_at?: string;
    metrics?: { views?: number; replies?: number; likes?: number };
    deleted?: boolean;
  }>;
  coverage?: {
    query_from?: string;
    query_to?: string;
    cursor_exhausted?: boolean;
    stock_codes?: string[];
  };
}

export function isForumFeedConfigured() {
  return Boolean(process.env.FORUM_FEED_URL);
}

export async function fetchAuthorizedForumClues(stockCodes: string[], requestedRange?: { queryFrom: string; queryTo: string }) {
  const configuredUrl = process.env.FORUM_FEED_URL;
  if (!configuredUrl) return { items: [] as RawClue[], sourceName: "论坛舆情 · 待授权接入", licenseId: null, termsUrl: null, range: null as LiveClueRangeProof | null };

  const url = new URL(configuredUrl);
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback.has(url.hostname))) {
    throw new Error("授权论坛源必须使用加密连接或本机回环地址");
  }
  url.searchParams.set("stock_codes", stockCodes.join(","));
  url.searchParams.set("limit", "1000");
  if (requestedRange) {
    url.searchParams.set("published_from", requestedRange.queryFrom);
    url.searchParams.set("published_to", requestedRange.queryTo);
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.FORUM_FEED_TOKEN) headers.authorization = `Bearer ${process.env.FORUM_FEED_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`授权论坛源返回状态 ${response.status}`);
  const payload = await response.json() as ForumFeedPayload;
  const termsUrl = validPublicUrl(payload.source?.terms_url);
  if (payload.schema_version !== "1.0" || !payload.source?.id || !payload.source.license_id || !payload.source.name || !termsUrl) {
    throw new Error("授权论坛源缺少版本、来源、许可标识或许可条款链接");
  }

  const items = (payload.items ?? []).filter((item) => !item.deleted).map((item): RawClue | null => {
    const id = String(item.id ?? "");
    const title = String(item.title ?? "").trim();
    const publishedAt = new Date(String(item.published_at ?? ""));
    const permalink = validPublicUrl(item.permalink);
    if (!id || !title || Number.isNaN(publishedAt.valueOf())) return null;
    if (!permalink) throw new Error(`授权论坛源记录 ${id} 缺少合法的逐条永久链接`);
    return {
      id: `论坛-${payload.source!.id}-${id}`,
      source: payload.source!.name!,
      sourceKind: "forum",
      title,
      summary: String(item.excerpt ?? title).trim(),
      publishedAt: publishedAt.toISOString(),
      url: permalink,
      stockCodes: (item.stock_codes ?? []).filter((code) => /^\d{6}$/.test(code)),
      interactionCount: Number(item.metrics?.views ?? 0) + Number(item.metrics?.replies ?? 0) * 4 + Number(item.metrics?.likes ?? 0) * 2,
    };
  }).filter((item): item is RawClue => item !== null);

  const sameInstant = (left: unknown, right: string) => typeof left === "string" && Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right);
  const coveredCodes = [...new Set((payload.coverage?.stock_codes ?? []).filter((code): code is string => typeof code === "string" && stockCodes.includes(code) && /^\d{6}$/.test(code)))].sort();
  const range = requestedRange
    && payload.coverage?.cursor_exhausted === true
    && sameInstant(payload.coverage.query_from, requestedRange.queryFrom)
    && sameInstant(payload.coverage.query_to, requestedRange.queryTo)
    && coveredCodes.length > 0
    ? { kind: "server-window-paginated" as const, queryFrom: requestedRange.queryFrom, queryTo: requestedRange.queryTo, cursorExhausted: true, coveredCodes }
    : null;
  return { items, sourceName: payload.source.name, licenseId: payload.source.license_id, termsUrl, range };
}

function validPublicUrl(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    if (!new Set(["https:", "http:"]).has(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
