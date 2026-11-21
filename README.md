# OSU音乐 · Songloft 插件

从 [osu!](https://osu.ppy.sh) 搜索谱面，下载 `.osz` 后自动解压、只保留歌曲文件、导入 Songloft 曲库与歌单。不加载谱面、不下载视频与剧情板，只要音乐。

## 功能

- 🔍 **搜索 / URL 导入合一**：搜索框既能按关键词搜谱面，也能直接粘贴 osu! 谱面链接或谱面 ID 精确导入
- ⏱️ 搜索结果显示歌曲时长
- 📦 下载 `.osz` → 自动解压 → 只留主曲音频（`.mp3/.ogg/.wav` 等），丢弃 `.osu`/`.osb`/图片/剧情板
- 🎵 导入曲库，可同时加入指定歌单
- 🎧 文件直接落进 Songloft 音乐库的 `OSU音乐/` 目录，成为正式本地歌曲
- ✏️ 落盘命名可选「歌手 - 歌名」或「歌名 - 歌手」
- 🔄 可选「统一转 MP3」，非 mp3 源转成 320kbps MP3，方便车机 / 音箱播放
- 🔑 需要 osu! Cookie，**由使用者自行填写**，插件不内置任何账号密码

## 安装

### 方式一：插件商店（推荐）

1. Songloft 管理后台 → 插件 → 插件商店
2. 添加 GitHub 源：`https://raw.githubusercontent.com/514475844/songloft-plugin-registry/main/registry.json`
3. 找到 **OSU音乐**，点击安装并启用

### 方式二：手动侧载

1. 从 [Releases](../../releases) 下载最新的 `osu-music.jsplugin.zip`
2. Songloft 管理后台 → 插件 → 上传插件包
3. 启用后进入插件页面

## 首次使用：填写 Cookie

插件本身不需要账号密码，但 osu! 的搜索和下载需要登录态。请自行获取：

1. 浏览器登录 [osu.ppy.sh](https://osu.ppy.sh)
2. 打开开发者工具（F12）→ Network（网络）→ 刷新页面
3. 随便点一个 osu.ppy.sh 的请求，在请求头里复制完整的 `Cookie` 值
4. 粘贴到插件的「账号」页 → 保存

Cookie 只保存在你自己的 Songloft 插件存储里，插件不会把它发送到 osu.ppy.sh 以外的任何地址。**请不要把 Cookie 分享给别人**。

服务端需要能访问 `osu.ppy.sh`，并装有 `wget`、`unzip`（转 MP3 另需 `ffmpeg`）。

## 许可

Apache-2.0 © 2026 514475844
