/// <reference types="@songloft/plugin-sdk" />

// osu! 网页版常量与设置/凭证持久化

// osu! 的 Cloudflare 对某些完整浏览器 UA 指纹敏感；实测短 UA 稳定通过。
export const UA = 'Mozilla/5.0 Chrome/120';
export const OSU_BASE = 'https://osu.ppy.sh';
export const SEARCH_REFERER = 'https://osu.ppy.sh/beatmapsets';

export type NameOrder = 'artist-title' | 'title-artist';

export interface Settings {
  path_template: string;
  name_order: NameOrder;
  embed_metadata: boolean;
  download_interval: number;
  keep_all_audio: boolean;
  preferred_lang: 'any' | 'zh' | 'en' | 'jp';
  convert_mp3: boolean;
}

export const DEFAULT_TEMPLATE = 'OSU音乐/{artist} - {title}';
export const MUSIC_DIR = 'OSU音乐';

/** 按命名顺序生成落盘路径模板（转码与否都用同一份，保证文件名规则统一） */
export function templateForOrder(order: NameOrder): string {
  return order === 'title-artist'
    ? `${MUSIC_DIR}/{title} - {artist}`
    : `${MUSIC_DIR}/{artist} - {title}`;
}

const DEFAULTS: Settings = {
  path_template: DEFAULT_TEMPLATE,
  name_order: 'artist-title',
  embed_metadata: true,
  download_interval: 3,
  keep_all_audio: false,
  preferred_lang: 'any',
  convert_mp3: false,
};

export async function getSettings(): Promise<Settings> {
  const stored = (await songloft.storage.get('settings')) as Partial<Settings> | null;
  return { ...DEFAULTS, ...(stored || {}) };
}

export async function saveSettings(partial: Partial<Settings>): Promise<Settings> {
  const updated = { ...(await getSettings()), ...partial };
  await songloft.storage.set('settings', updated);
  return updated;
}

export async function getCookieString(): Promise<string> {
  return ((await songloft.storage.get('cookie')) as string) || '';
}

export async function setCookieString(s: string): Promise<void> {
  await songloft.storage.set('cookie', s.trim());
}

export async function clearCookie(): Promise<void> {
  await songloft.storage.delete('cookie');
}

export async function hasCookie(): Promise<boolean> {
  return !!(await getCookieString());
}
