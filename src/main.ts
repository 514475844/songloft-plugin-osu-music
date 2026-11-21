/// <reference types="@songloft/plugin-sdk" />

import { jsonResponse, createRouter, createMusicUrlHandler, type RouteHandler } from '@songloft/plugin-sdk';
import {
  searchBeatmaps,
  getSetById,
  parseSetId,
  type OsuSet,
} from './search';
import { downloadAndExtract } from './downloader';
import { importAudios, listPlaylists } from './importer';
import {
  getSettings,
  saveSettings,
  setCookieString,
  clearCookie,
  hasCookie,
} from './consts';

const router = createRouter();

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 主程序下载歌曲时通过这个接口拿到真实音频地址；
// 和哔哩音乐一致：插件只解析地址，落盘由主程序写进音乐库目录。
router.post('/api/music/url', createMusicUrlHandler({
  resolveUrl: async (sourceData) => {
    const setId = Number(sourceData.setId);
    const filename = String(sourceData.filename || '');
    if (!setId || !filename || /[\\/]/.test(filename)) {
      throw new Error('音源信息无效');
    }
    const relPath = `osz_${setId}/clean/${filename}`;
    if (!(await songloft.fs.exists(relPath))) {
      throw new Error('临时音频已被清理，请重新导入');
    }
    const info = (await songloft.plugin.getFileUrl(relPath)) as unknown as { url?: string } | string;
    let url = typeof info === 'string' ? info : info?.url || '';
    if (!url) throw new Error('无法获取音频访问地址');
    if (url.startsWith('/')) url = (await songloft.plugin.getHostUrl()) + url;
    return url;
  },
}) as RouteHandler);

// ---- 账号：Cookie ----
router.get('/api/account/status', async () =>
  jsonResponse({ logged_in: await hasCookie() }),
);

router.post('/api/account/cookie', (async (req) => {
  const body = JSON.parse(String(req.body || '{}'));
  const cookie = String(body.cookie || '').trim();
  if (!cookie) return jsonResponse({ error: 'Cookie 不能为空' }, 400);
  await setCookieString(cookie);
  return jsonResponse({ ok: true });
}) as RouteHandler);

router.post('/api/account/logout', async () => {
  await clearCookie();
  return jsonResponse({ ok: true });
});

// ---- 搜索 ----
router.post('/api/search', (async (req) => {
  const body = JSON.parse(String(req.body || '{}'));
  const q = String(body.q || '').trim();
  const page = Math.max(1, Number(body.page) || 1);
  try {
    const result = await searchBeatmaps(q, page);
    return jsonResponse(result);
  } catch (e) {
    return jsonResponse({ error: errMsg(e) }, 502);
  }
}) as RouteHandler);

// ---- URL 提取 ----
router.post('/api/extract', (async (req) => {
  const body = JSON.parse(String(req.body || '{}'));
  const url = String(body.url || '').trim();
  const id = parseSetId(url);
  if (!id) return jsonResponse({ error: '无法从链接中识别谱面集 ID' }, 400);
  try {
    const set = await getSetById(id);
    if (!set) return jsonResponse({ error: '找不到该谱面集，或页面结构变化' }, 404);
    return jsonResponse({ set });
  } catch (e) {
    return jsonResponse({ error: errMsg(e) }, 502);
  }
}) as RouteHandler);

// ---- 下载+解压（只留歌曲，可选导入） ----
// body: { set: OsuSet, import: boolean, playlist_name?, playlist_id? }
router.post('/api/import', (async (req) => {
  const body = JSON.parse(String(req.body || '{}'));
  const set = body.set as OsuSet;
  if (!set || typeof set.id !== 'number') {
    return jsonResponse({ error: '缺少谱面集信息' }, 400);
  }
  try {
    const audios = await downloadAndExtract(set);
    const doImport = body.import !== false;
    if (doImport) {
      const result = await importAudios(audios, set, {
        playlistName: body.playlist_name || undefined,
        playlistId: body.playlist_id || undefined,
        convertMp3: typeof body.convert_mp3 === 'boolean' ? body.convert_mp3 : undefined,
      });
      return jsonResponse({
        audios: audios.map((a) => ({ title: a.title, filename: a.filename, size: a.size })),
        imported: result.count,
        skipped: result.skipped,
        downloaded: result.downloaded,
        failed: result.failed,
        playlist_id: result.playlist_id,
      });
    }
    return jsonResponse({
      audios: audios.map((a) => ({ title: a.title, filename: a.filename, size: a.size })),
      imported: 0,
      skipped: 0,
      downloaded: 0,
      failed: [],
    });
  } catch (e) {
    return jsonResponse({ error: errMsg(e) }, 500);
  }
}) as RouteHandler);

// ---- 歌单列表 ----
router.get('/api/playlists', async () => {
  try {
    return jsonResponse({ playlists: await listPlaylists() });
  } catch (e) {
    return jsonResponse({ error: errMsg(e) }, 500);
  }
});

// ---- 设置 ----
router.get('/api/settings', async () => jsonResponse(await getSettings()));
router.post('/api/settings', (async (req) => {
  const body = JSON.parse(String(req.body || '{}'));
  const updated = await saveSettings(body);
  return jsonResponse(updated);
}) as RouteHandler);

// 宿主通过全局 onHTTPRequest 分发请求（不是 import default）
globalThis.onInit = async () => {
  // 预留：如需注册搜索源给音箱插件，可在此做
};
globalThis.onHTTPRequest = (req) => router.handle(req);
