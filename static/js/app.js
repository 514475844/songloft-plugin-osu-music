/* OSU音乐 前端逻辑 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var API = location.origin + '/api/v1/jsplugin/osu-music';
  var TOKEN = '';

  var state = {
    results: [],
    page: 1,
    query: '',
    selected: null,
    playlists: []
  };

  function api(path, options) {
    options = options || {};
    var url = API + path + (path.indexOf('?') < 0 ? '?' : '&') + 'access_token=' + encodeURIComponent(TOKEN);
    var init = { method: options.method || 'GET', headers: { 'Accept': 'application/json' } };
    // 下载+解压 osz 是长任务，放宽宿主默认 30s 超时（上限 5 分钟）
    if (options.long) init.headers['X-Plugin-Timeout-Ms'] = '300000';
    if (options.body !== undefined) {
      init.method = options.method || 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); } catch (e) { j = { error: t.slice(0, 200) }; }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, 3000);
  }

  // ---- 页签 ----
  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
      btn.classList.add('active');
      var tab = btn.getAttribute('data-tab');
      $('tab-' + tab).classList.add('active');
      if (tab === 'account') refreshAccount();
    });
  });

  // ---- 找歌 ----
  function looksLikeUrl(q) {
    return /osu\.ppy\.sh|beatmapsets|\/b\//i.test(q) || /^\d{4,}$/.test(q);
  }

  function renderResults() {
    var box = $('search-results');
    box.innerHTML = '';
    if (!state.results.length) return;
    state.results.forEach(function (s) {
      var item = document.createElement('div');
      item.className = 'item' + (state.selected && state.selected.id === s.id ? ' selected' : '');
      var coverHtml = s.cover
        ? '<img class="cover" src="' + esc(s.cover) + '" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'" />' +
          '<div class="cover-ph" style="display:none">♪</div>'
        : '<div class="cover-ph">♪</div>';
      var tags = '<span class="tag">' + esc(s.status || '') + '</span>';
      if (s.bpm) tags += '<span class="tag gray">' + Math.round(s.bpm) + ' BPM</span>';
      if (s.duration) tags += '<span class="tag gray">' + fmtTime(s.duration) + '</span>';
      tags += '<span class="tag gray">' + (s.beatmaps ? s.beatmaps.length : 0) + ' 难度</span>';
      item.innerHTML = coverHtml +
        '<div class="meta">' +
          '<div class="title">' + esc(s.artist) + ' — ' + esc(s.title) + '</div>' +
          '<div class="sub">谱面作者：' + esc(s.creator) + '</div>' +
          '<div class="tags">' + tags + '</div>' +
        '</div>' +
        '<div class="item-actions"><button class="btn btn-primary btn-import">导入</button></div>';
      item.querySelector('.btn-import').addEventListener('click', function (e) {
        e.stopPropagation();
        chooseSet(s);
      });
      item.addEventListener('click', function () { chooseSet(s); });
      box.appendChild(item);
    });
  }

  function doSearch(page) {
    var q = $('search-input').value.trim();
    if (!q) { toast('请输入关键词或 osu! 链接'); return; }
    state.query = q;
    state.page = page || 1;
    $('search-hint').style.display = 'none';
    $('search-status').style.display = 'block';
    $('search-status').textContent = '正在查找…';
    $('search-more').style.display = 'none';

    // URL / 谱面 ID → 直接定位单个谱面集
    if (looksLikeUrl(q)) {
      api('/api/extract', { body: { url: q } }).then(function (j) {
        state.results = j.set ? [j.set] : [];
        afterResults('找不到该谱面，请检查链接或 ID');
      }).catch(function (e) {
        $('search-status').textContent = '解析失败：' + e.message;
        $('search-hint').style.display = 'block';
      });
      return;
    }

    // 关键词 → 普通搜索
    api('/api/search', { body: { q: q, page: state.page } }).then(function (j) {
      state.results = j.items || [];
      afterResults('没有找到结果');
      $('search-more').style.display = state.results.length >= 20 ? 'block' : 'none';
    }).catch(function (e) {
      $('search-status').textContent = '搜索失败：' + e.message;
      $('search-hint').style.display = 'block';
    });
  }

  function afterResults(emptyMsg) {
    renderResults();
    $('search-status').style.display = state.results.length ? 'none' : 'block';
    $('search-status').textContent = state.results.length ? '' : emptyMsg;
    if (!state.results.length) $('search-hint').style.display = 'block';
  }

  $('search-btn').addEventListener('click', function () { doSearch(1); });
  $('search-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(1); });
  $('search-more-btn').addEventListener('click', function () { doSearch(state.page + 1); });

  // ---- 导入选项（合并到找歌页） ----
  function loadPlaylists() {
    api('/api/playlists').then(function (j) {
      state.playlists = j.playlists || [];
      var sel = $('import-playlist-select');
      var cur = sel.value;
      sel.innerHTML = '<option value="">不加入歌单</option>';
      state.playlists.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id; o.textContent = p.name;
        sel.appendChild(o);
      });
      sel.value = cur;
    }).catch(function () {});
  }

  function chooseSet(set) {
    state.selected = set;
    renderResults();
    $('import-panel').style.display = 'block';
    $('import-preview').innerHTML = '<strong>' + esc(set.artist) + ' — ' + esc(set.title) + '</strong>' +
      '<div class="sub">谱面作者：' + esc(set.creator) + ' · ' + (set.beatmaps ? set.beatmaps.length : 0) + ' 个难度' +
      (set.duration ? ' · ' + fmtTime(set.duration) : '') + '</div>';
    $('import-status').style.display = 'none';
    $('import-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('import-go').addEventListener('click', function () {
    var set = state.selected;
    if (!set) return;
    var btn = this;
    btn.disabled = true;
    $('import-status').style.display = 'block';
    $('import-status').textContent = '正在下载并解压，请稍候…';
    var body = {
      set: set,
      import: !$('import-only').checked,
      convert_mp3: $('import-mp3').checked,
      playlist_id: $('import-playlist-select').value ? Number($('import-playlist-select').value) : undefined,
      playlist_name: $('import-playlist-name').value.trim() || undefined
    };
    api('/api/import', { body: body, long: true }).then(function (j) {
      var audios = j.audios || [];
      var msg = '完成：提取 ' + audios.length + ' 首';
      if (!body.import) msg += '（未导入曲库）';
      else {
        msg += '，导入 ' + j.imported + ' 首';
        if (j.skipped) msg += '，跳过重复 ' + j.skipped + ' 首';
        if (j.downloaded) msg += '，已存入音乐库 ' + j.downloaded + ' 首';
        if (j.failed && j.failed.length) msg += '，失败 ' + j.failed.length + ' 首';
      }
      $('import-status').textContent = msg;
      toast(msg);
      audios.forEach(function (a) { pushLog(a.title, a.filename); });
      btn.disabled = false;
    }).catch(function (e) {
      $('import-status').textContent = '失败：' + e.message;
      toast('导入失败：' + e.message);
      btn.disabled = false;
    });
  });

  // ---- 状态日志（本地记录） ----
  function pushLog(title, file) {
    try {
      var logs = JSON.parse(localStorage.getItem('osu_logs') || '[]');
      logs.unshift({ title: title, file: file, time: Date.now() });
      logs = logs.slice(0, 50);
      localStorage.setItem('osu_logs', JSON.stringify(logs));
      renderLog();
    } catch (e) {}
  }

  function renderLog() {
    var box = $('status-log');
    var logs = [];
    try { logs = JSON.parse(localStorage.getItem('osu_logs') || '[]'); } catch (e) {}
    if (!logs.length) { box.textContent = '还没有导入记录。'; return; }
    box.innerHTML = logs.map(function (l) {
      var d = new Date(l.time);
      return '<div class="sub">' + esc(d.toLocaleString()) + ' · ' + esc(l.title) + '</div>';
    }).join('');
  }

  // ---- 账号 ----
  function refreshAccount() {
    api('/api/account/status').then(function (j) {
      $('account-status').textContent = j.logged_in ? '已配置 Cookie，可以下载。' : '未配置 Cookie，搜索可用、下载不可用。';
      $('account-mini').textContent = j.logged_in ? '已登录' : '未登录';
    }).catch(function () {});
  }

  $('cookie-save').addEventListener('click', function () {
    var v = $('cookie-input').value.trim();
    if (!v) { toast('请先粘贴 Cookie'); return; }
    api('/api/account/cookie', { body: { cookie: v } }).then(function () {
      toast('Cookie 已保存');
      refreshAccount();
    }).catch(function (e) { toast('保存失败：' + e.message); });
  });

  $('cookie-clear').addEventListener('click', function () {
    api('/api/account/logout', { body: {} }).then(function () {
      $('cookie-input').value = '';
      toast('Cookie 已清除');
      refreshAccount();
    }).catch(function (e) { toast('清除失败：' + e.message); });
  });

  // ---- 设置 ----
  function loadSettings() {
    api('/api/settings').then(function (s) {
      $('set-name-order').value = s.name_order || 'artist-title';
      $('set-embed').checked = !!s.embed_metadata;
      $('set-keepall').checked = !!s.keep_all_audio;
      $('set-mp3').checked = !!s.convert_mp3;
      $('import-mp3').checked = !!s.convert_mp3;
    }).catch(function () {});
  }

  $('set-save').addEventListener('click', function () {
    api('/api/settings', { body: {
      name_order: $('set-name-order').value,
      embed_metadata: $('set-embed').checked,
      keep_all_audio: $('set-keepall').checked,
      convert_mp3: $('set-mp3').checked
    } }).then(function () {
      $('set-status').style.display = 'block';
      $('set-status').textContent = '设置已保存';
      $('import-mp3').checked = $('set-mp3').checked;
      toast('设置已保存');
    }).catch(function (e) { toast('保存失败：' + e.message); });
  });

  // ---- 工具 ----
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(sec) {
    sec = Math.round(sec || 0);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // 宿主注入 JWT，兼容几种方式
  function acquireToken(done) {
    var tries = 0;
    function finish(t) {
      TOKEN = typeof t === 'string' ? t : '';
      if (TOKEN) { try { localStorage.setItem('osu.token', TOKEN); } catch (e) {} }
      done();
    }
    function poll() {
      var t = '';
      try { t = window.SongloftPlugin && window.SongloftPlugin.getAuthToken && window.SongloftPlugin.getAuthToken(); } catch (e) {}
      if (!t) { try { t = window.getAccessToken && window.getAccessToken(); } catch (e) {} }
      if (t && typeof t.then === 'function') { t.then(finish, function () { finish(''); }); return; }
      if (t) { finish(t); return; }
      if (++tries < 12) { setTimeout(poll, 300); return; }
      var q = /[?&]access_token=([^&#]+)/.exec(location.search);
      if (q) { finish(decodeURIComponent(q[1])); return; }
      var cached = '';
      try { cached = localStorage.getItem('osu.token') || ''; } catch (e) {}
      if (cached) { finish(cached); return; }
      fetch(API + '/api/token').then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (d) { finish(d.token || d.access_token || ''); })
        .catch(function () { finish(''); });
    }
    poll();
  }

  // 启动
  acquireToken(function () {
    loadSettings();
    loadPlaylists();
    renderLog();
    refreshAccount();
  });
})();
