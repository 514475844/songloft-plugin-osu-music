/// <reference types="@songloft/plugin-sdk" />

// osu! 搜索：网页版 beatmapsets 页是服务端渲染，结果以 JSON 嵌在 HTML 里。
// 不需要 OAuth token，带浏览器 UA 即可（无 UA 会被 Cloudflare 403）。
// 从 `"beatmapsets":[...]` 起用括号配平截取数组，再 JSON.parse。

import { UA, OSU_BASE, SEARCH_REFERER, getCookieString } from './consts';
export interface OsuBeatmap {
  id: number;
  version: string;
  difficulty_rating: number;
  mode: string;
  total_length: number;
  status: string;
}

export interface OsuSet {
  id: number;
  title: string;
  title_unicode?: string;
  artist: string;
  artist_unicode?: string;
  creator: string;
  status: string;
  bpm: number;
  favourite_count: number;
  play_count: number;
  nsfw: boolean;
  covers: { cover?: string; card?: string; list?: string; 'cover@2x'?: string };
  preview_url?: string;
  beatmaps: OsuBeatmap[];
  source?: string;
  tags?: string;
  // 前端展示用（本地派生）
  duration?: number;
  cover?: string;
}

/** 从 HTML 中截取 `"beatmapsets":` 后面的 JSON 数组（括号配平，避开字符串内的括号） */
function extractJsonArray(html: string, marker: string): unknown[] | null {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('[', i + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, j + 1);
        try {
          return JSON.parse(raw) as unknown[];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeSet(raw: any): OsuSet | null {
  if (!raw || typeof raw.id !== 'number') return null;
  const beats: OsuBeatmap[] = Array.isArray(raw.beatmaps)
    ? raw.beatmaps.map((b: any) => ({
        id: Number(b.id) || 0,
        version: String(b.version || ''),
        difficulty_rating: Number(b.difficulty_rating) || 0,
        mode: String(b.mode || 'osu'),
        total_length: Number(b.total_length) || 0,
        status: String(b.status || ''),
      }))
    : [];
  const duration = beats.reduce((m, b) => Math.max(m, b.total_length), 0);
  const cover = raw.covers?.cover || raw.covers?.card || raw.covers?.list || '';
  return {
    id: raw.id,
    title: String(raw.title || ''),
    title_unicode: raw.title_unicode ? String(raw.title_unicode) : undefined,
    artist: String(raw.artist || ''),
    artist_unicode: raw.artist_unicode ? String(raw.artist_unicode) : undefined,
    creator: String(raw.creator || ''),
    status: String(raw.status || ''),
    bpm: Number(raw.bpm) || 0,
    favourite_count: Number(raw.favourite_count) || 0,
    play_count: Number(raw.play_count) || 0,
    nsfw: !!raw.nsfw,
    covers: raw.covers || {},
    preview_url: raw.preview_url ? String(raw.preview_url) : undefined,
    beatmaps: beats,
    source: raw.source ? String(raw.source) : undefined,
    tags: raw.tags ? String(raw.tags) : undefined,
    duration,
    cover,
  };
}

async function fetchHtml(url: string, withCookie = false): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  // osu! 搜索结果需登录态才在 SSR 里返回真实命中；未登录只会拿到热门列表。
  if (withCookie) {
    const cookie = await getCookieString();
    if (cookie) headers['Cookie'] = cookie;
  }
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`osu! 网页请求失败：HTTP ${resp.status}`);
  return await resp.text();
}

export interface SearchResult {
  items: OsuSet[];
  total: number;
  page: number;
}

/** 搜索谱面集。q 为空时取热门。page 从 1 开始。 */
export async function searchBeatmaps(q: string, page = 1): Promise<SearchResult> {
  const params = new URLSearchParams();
  params.set('m', '0'); // 0=osu! 标准模式
  if (q) params.set('q', q);
  if (page > 1) params.set('page', String(page));
  const url = `${OSU_BASE}/beatmapsets?${params.toString()}`;
  const html = await fetchHtml(url, true); // 搜索带 Cookie，否则只返回热门
  const arr = extractJsonArray(html, '"beatmapsets":');
  if (!arr) throw new Error('未能从 osu! 页面解析出搜索结果，页面结构可能已变化');
  const items = arr.map(normalizeSet).filter((x): x is OsuSet => !!x && !x.nsfw);
  // 总数：网页里通常带 "total":N
  const tm = html.match(/"total":(\d+)/);
  const total = tm ? Number(tm[1]) : items.length;
  return { items, total, page };
}

/** 按谱面集 id 取详情（详情页把单个对象放在 <script id="json-beatmapset"> 里） */
export async function getSetById(id: number): Promise<OsuSet | null> {
  const html = await fetchHtml(`${OSU_BASE}/beatmapsets/${id}`);
  // 优先取 <script id="json-beatmapset" type="application/json">{...}</script>
  const sm = html.match(/<script id="json-beatmapset"[^>]*>([\s\S]*?)<\/script>/);
  if (sm) {
    try {
      const obj = JSON.parse(sm[1].trim());
      return normalizeSet(obj);
    } catch {}
  }
  // 兼容旧结构： "beatmapset":{...}
  const marker = '"beatmapset":';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = html.indexOf('{', i + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const ch = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return normalizeSet(JSON.parse(html.slice(start, j + 1)));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 从用户粘贴的 osu 链接里解析出谱面集 id */
export function parseSetId(input: string): number | null {
  const s = (input || '').trim();
  let m = s.match(/beatmapsets\/(\d+)/);
  if (m) return Number(m[1]);
  m = s.match(/\/b\/(\d+)/);
  if (m) return Number(m[1]);
  m = s.match(/(?:^|[^\d])(\d{4,})(?:$|[^\d])/);
  if (m) return Number(m[1]);
  if (/^\d+$/.test(s)) return Number(s);
  return null;
}

/** 从谱面页面 URL 提取（用于 URL 导入模式） */
export async function extractFromUrl(input: string): Promise<{ set?: OsuSet; id: number | null }> {
  const id = parseSetId(input);
  if (!id) return { id: null };
  const set = await getSetById(id);
  return { id, set: set || undefined };
}
