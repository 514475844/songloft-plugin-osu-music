/// <reference types="@songloft/plugin-sdk" />

// 把解压出的音频导入曲库：
// 和哔哩音乐一致，只把音源信息写进曲库（plugin_entry_path + source_data），
// 真正落盘交给主程序的 songs.download，文件进 Docker 里配置的音乐库目录。
// 插件目录只作临时中转，下载成功后删掉 osz_<id>。

import { getSettings, templateForOrder } from './consts';
import type { ExtractedAudio } from './downloader';

export interface ImportResult {
  songs: { id: number; title: string }[];
  count: number;
  skipped: number;
  downloaded: number;
  failed: { title: string; error: string }[];
  playlist_id?: number;
}

/**
 * 拿到插件临时音频的宿主原生文件地址（host/files 路由，主程序直接读取，
 * 不经过插件 JS 调度器）。
 *
 * 关键：把这个地址作为 url 写进歌曲记录后，主程序 songs.download 会自己
 * 抓取它，不再回头调用插件的 /api/music/url —— 彻底避开「下载回调插件、
 * 插件又在等下载」的调度死锁（哔哩音乐正是这个模式）。
 */
async function fileUrl(relPath: string): Promise<string> {
  const info = (await songloft.plugin.getFileUrl(relPath)) as unknown as { url?: string } | string;
  let url = typeof info === 'string' ? info : info?.url || '';
  if (!url) throw new Error('无法获取音频访问地址');
  if (url.startsWith('/')) url = (await songloft.plugin.getHostUrl()) + url;
  return url;
}

async function callHostAPI<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const host = await songloft.plugin.getHostUrl();
  const token = await songloft.plugin.getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const resp = await fetch(host + path, { method, headers, body: payload });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`宿主接口错误 ${resp.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
}

async function addToPlaylist(playlistId: number, songIds: number[]): Promise<void> {
  for (let i = 0; i < songIds.length; i += 50) {
    const batch = songIds.slice(i, i + 50);
    await callHostAPI('POST', `/api/v1/playlists/${playlistId}/songs`, { song_ids: batch });
  }
}

/** 导入解压出的音频列表到曲库，并让主程序下载到音乐库目录 */
export async function importAudios(
  audios: ExtractedAudio[],
  set: { id: number; title: string; artist: string; cover?: string },
  opts: { playlistName?: string; playlistId?: number; convertMp3?: boolean } = {},
): Promise<ImportResult> {
  if (!audios.length) throw new Error('没有可导入的音频');

  const settings = await getSettings();
  const wantMp3 = typeof opts.convertMp3 === 'boolean' ? opts.convertMp3 : settings.convert_mp3;
  const created: { id: number; title: string }[] = [];
  const failed: { title: string; error: string }[] = [];
  let skipped = 0;
  let downloaded = 0;

  for (const a of audios) {
    const dedupKey = `osu:${set.id}:${a.filename}:${a.size}`;
    try {
      // 宿主可直接下载的音频地址。写进 source_url 后，主程序 songs.download
      // 自己抓取落盘，不再回调插件 music/url，避免调度器自锁。
      const relPath = `osz_${set.id}/clean/${a.filename}`;
      const audioUrl = await fileUrl(relPath);
      // 落盘文件名统一按「歌手 - 歌名」或「歌名 - 歌手」生成，转码前后同一套规则。
      // 用 name_order 派生模板，忽略用户可能手填的旧 path_template，避免命名跑偏。
      const dlOpts: { path_template: string; embed_metadata: boolean; format?: string; quality?: string } = {
        path_template: templateForOrder(settings.name_order),
        embed_metadata: settings.embed_metadata,
      };
      // 可选：统一转 MP3（源已是 mp3 则不重复转码）
      if (wantMp3 && !/\.mp3$/i.test(a.filename)) {
        dlOpts.format = 'mp3';
        dlOpts.quality = '320';
      }
      const resp = await callHostAPI<{ songs?: { id: number; title: string; type?: string; file_path?: string }[] }>(
        'POST',
        '/api/v1/songs/remote',
        [
          {
            // 直接给可下载的外链，主程序下载后即为本地歌曲；不声明插件来源，
            // 因此不会触发 auto refresh 回调插件。
            url: audioUrl,
            title: a.title,
            artist: a.artist,
            album: `osu! - ${set.title}`,
            cover_url: set.cover || '',
            duration: 0,
            dedup_key: dedupKey,
          },
        ],
      );
      const songs = resp?.songs || [];
      if (!songs.length) {
        skipped++; // dedup 命中
        continue;
      }
      const song = songs[0];
      created.push({ id: song.id, title: a.title });

      const fresh = await songloft.songs.getById(song.id);
      if (fresh && (fresh.type === 'local' || fresh.file_path)) {
        downloaded++; // 已导入过，文件已在音乐库
        continue;
      }

      // 由主程序下载，文件落到 Docker 挂载的音乐库目录
      const dl = await songloft.songs.download(song.id, dlOpts);
      if (dl.error || dl.status === 'error' || dl.status === 'failed') {
        throw new Error(dl.error || dl.status || '下载失败');
      }
      downloaded++;
    } catch (e: any) {
      failed.push({ title: a.title, error: e?.message || String(e) });
    }
  }

  let finalPlaylistId = opts.playlistId;
  if (opts.playlistName && !finalPlaylistId && created.length) {
    const resp = await callHostAPI<{ id: number }>('POST', '/api/v1/playlists', {
      name: opts.playlistName,
      type: 'normal',
    });
    finalPlaylistId = resp.id;
  }
  if (finalPlaylistId && created.length) {
    await addToPlaylist(finalPlaylistId, created.map((s) => s.id));
  }

  // 全部成功（或重复跳过）后清掉插件目录里的临时文件，避免音乐库存两份
  if (!failed.length) {
    try {
      await songloft.command.exec('sh', ['-c', `rm -rf osz_${set.id}`], { timeout: 15000 });
    } catch (e) {
      // 清理失败不影响导入结果
    }
  }

  return {
    songs: created,
    count: created.length,
    skipped,
    downloaded,
    failed,
    playlist_id: finalPlaylistId,
  };
}

export async function listPlaylists(): Promise<{ id: number; name: string }[]> {
  const resp = await callHostAPI<{ playlists?: { id: number; name: string }[] }>(
    'GET',
    '/api/v1/playlists?limit=200',
  );
  return (resp?.playlists || []).map((p) => ({ id: p.id, name: p.name }));
}
