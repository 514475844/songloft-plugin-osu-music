/// <reference types="@songloft/plugin-sdk" />

// osz 下载与解压（外部命令版）：
// JS 不碰大二进制（jsc 里处理 5MB 会被 interrupted），改为写一个 shell 脚本，
// 由 command.exec 调 wget + unzip 完成下载/解压/筛选，JS 只读结果列表。
//
// 脚本做：wget 带 Cookie 下载 osz → unzip 解压 → find 出音频 →
// 按大小去重（同包多难度共用一首）→ 复制到 clean/ 目录 → 写清单 JSON。
//
// 对外降级：无 wget/unzip 时给明确中文提示。

import { UA, OSU_BASE } from './consts';
import { getCookieString, getSettings } from './consts';
import type { OsuSet } from './search';

export interface ExtractedAudio {
  path: string;
  filename: string;
  title: string;
  artist: string;
  size: number;
}

interface ManifestEntry {
  name: string;
  size: number;
  stem: string;
}

/**
 * 下载并解压一个谱面集，返回留下的音频文件列表。
 */
export async function downloadAndExtract(
  set: OsuSet,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<ExtractedAudio[]> {
  const cookie = await getCookieString();
  if (!cookie) {
    throw new Error('下载需要先粘贴 osu! Cookie：请在浏览器登录 osu.ppy.sh 后，把 Cookie 粘到「账号」页');
  }
  const progress = opts.onProgress || (() => {});
  const settings = await getSettings();
  const id = set.id;
  const workDir = `osz_${id}`;
  const cleanDir = `${workDir}/clean`;
  const manifestPath = `${workDir}/manifest.json`;

  // 检查必需命令
  const chk = await songloft.command.exec('sh', ['-c', 'command -v wget; command -v unzip'], { timeout: 10000 });
  if (!/wget/.test(chk.stdout) || !/unzip/.test(chk.stdout)) {
    throw new Error('服务端缺少 wget 或 unzip，无法下载解压 osz。请联系服务管理员安装');
  }

  progress('正在下载并解压谱面包…');

  // 写脚本（含 Cookie），所有重活交给 shell
  const url = `${OSU_BASE}/beatmapsets/${id}/download?noVideo=1`;
  const keepAll = settings.keep_all_audio ? '1' : '0';
  const script = [
    '#!/bin/sh',
    'set -e',
    `mkdir -p "${workDir}" "${cleanDir}"`,
    `rm -rf "${cleanDir}" && mkdir -p "${cleanDir}"`,
    `rm -f "${workDir}/set.osz" "${manifestPath}"`,
    `wget -q -O "${workDir}/set.osz" -T 150 --user-agent="${UA}" --header="Cookie: $OSU_COOKIE" --header="Referer: ${OSU_BASE}/beatmapsets/${id}" "${url}"`,
    `unzip -o -q -O UTF-8 "${workDir}/set.osz" -d "${workDir}/raw" 2>/dev/null || unzip -o -q "${workDir}/set.osz" -d "${workDir}/raw"`,
    // 找音频文件（mp3/ogg/oga/m4a/wav/flac/aac/opus）
    `find "${workDir}/raw" -type f \\( -iname '*.mp3' -o -iname '*.ogg' -o -iname '*.oga' -o -iname '*.m4a' -o -iname '*.wav' -o -iname '*.flac' -o -iname '*.aac' -o -iname '*.opus' \\) > "${workDir}/audios.txt"`,
    `test -s "${workDir}/audios.txt" || { echo 'NO_AUDIO'; exit 3; }`,
    // 去重：默认按文件大小，同大小只留一个
    `KEEPALL=${keepAll}`,
    `if [ "$KEEPALL" = "1" ]; then`,
    `  while IFS= read -r f; do cp -f "$f" "${cleanDir}/"; done < "${workDir}/audios.txt"`,
    `else`,
    `  # osu! 主曲固定叫 audio.*；其余多为音效(hitnormal 等)。优先只留 audio.*`,
    `  if grep -qiE '/audio\\.(mp3|ogg|oga|m4a|wav|flac|aac|opus)$' "${workDir}/audios.txt"; then`,
    `    grep -iE '/audio\\.(mp3|ogg|oga|m4a|wav|flac|aac|opus)$' "${workDir}/audios.txt" | while IFS= read -r f; do cp -f "$f" "${cleanDir}/"; done`,
    `  else`,
    `    # 没有标准命名时，取体积最大的一个（通常是主曲而非音效）`,
    `    biggest=""`,
    `    maxsz=0`,
    `    while IFS= read -r f; do`,
    `      sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)`,
    `      if [ "$sz" -gt "$maxsz" ]; then maxsz=$sz; biggest=$f; fi`,
    `    done < "${workDir}/audios.txt"`,
    `    [ -n "$biggest" ] && cp -f "$biggest" "${cleanDir}/"`,
    `  fi`,
    `fi`,
    // 清单写成 TSV（每行 name<TAB>size），避开文件名 JSON 转义问题
    `> "${manifestPath}"`,
    `for f in "${cleanDir}"/*; do`,
    `  [ -f "$f" ] || continue`,
    `  n=$(basename "$f")`,
    `  sz=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null)`,
    `  printf '%s\\t%s\\n' "$n" "$sz" >> "${manifestPath}"`,
    `done`,
    // 清理大文件
    `rm -f "${workDir}/set.osz"`,
    `rm -rf "${workDir}/raw"`,
    `echo DONE`,
  ].join('\n');

  await songloft.fs.writeFile('bin/osu_fetch.sh', script, { encoding: 'utf8' });

  const result = await songloft.command.exec('sh', ['bin/osu_fetch.sh'], {
    timeout: 280000,
    env: { OSU_COOKIE: cookie },
  });
  const out = (result.stdout || '') + (result.stderr || '');
  if (/NO_AUDIO/.test(out)) throw new Error('这个谱面包里没有找到音频文件');
  if (result.exitCode !== 0) {
    throw new Error(`下载解压失败：${out.slice(-300)}`);
  }

  // 读清单（TSV）
  let entries: ManifestEntry[] = [];
  try {
    const raw = await songloft.fs.readFile(manifestPath, { encoding: 'utf8' });
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      entries.push({ name: parts[0], size: Number(parts[1]) || 0, stem: '' });
    }
  } catch (e) {
    throw new Error(`读取解压结果失败：${e instanceof Error ? e.message : e}`);
  }
  if (!entries.length) throw new Error('解压后没有可用音频文件');

  const artist = set.artist_unicode || set.artist || 'osu!';
  const title = set.title_unicode || set.title || `Beatmap ${id}`;
  const audios: ExtractedAudio[] = entries.map((e, i) => ({
    path: `${cleanDir}/${e.name}`,
    filename: e.name,
    title: entries.length === 1 ? title : `${title} (${i + 1})`,
    artist,
    size: e.size || 0,
  }));

  progress(`完成：保留 ${audios.length} 首歌曲`);
  return audios;
}
