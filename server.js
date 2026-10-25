// server.js - IPTV Panel with Xtream Codes users (all streams for every user)
const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================================
// In-memory state
// =============================================================
let streams = {};            // { name: { url, userAgent?, referer? } }
let externalSources = ["http://195.154.119.178:8500/files/streams.json"];    // [ "http://195.154.119.178:8500/files/streams.json", ... ]
let users = {"ssss":{"password":"ssss","createdAt":1792966152}};              // { username: { password, createdAt } }

const jsonCache = new Map();
const CACHE_TTL = 60_000;

const now = () => Math.floor(Date.now() / 1000);

// =============================================================
// Helpers
// =============================================================
function normalizeStreams(data) {
  const out = {};
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item) continue;
      const name = item.name || item.id || item.key;
      const url  = item.url || item.stream_url || item.link || item.hls;
      if (name && url) out[name] = {
        url,
        userAgent: item.userAgent || item.ua || item['user-agent'],
        referer:   item.referer   || item.referrer,
      };
    }
    return out;
  }
  if (data && typeof data === 'object') {
    for (const [name, val] of Object.entries(data)) {
      if (typeof val === 'string') out[name] = { url: val };
      else if (val && val.url) out[name] = {
        url: val.url,
        userAgent: val.userAgent || val.ua,
        referer:   val.referer   || val.referrer,
      };
    }
  }
  return out;
}

async function fetchExternalSource(url) {
  const cached = jsonCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.data;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'IPTVProxy/1.0' }, timeout: 10_000 });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    jsonCache.set(url, { data, expires: Date.now() + CACHE_TTL });
    return data;
  } catch (err) {
    if (cached) return cached.data; // serve stale
    throw err;
  }
}

async function getAllStreams() {
  const all = { ...streams };
  for (const src of externalSources) {
    try {
      const data = await fetchExternalSource(src);
      const normalized = normalizeStreams(data);
      for (const [name, s] of Object.entries(normalized)) {
        if (!all[name]) all[name] = s; // manual wins
      }
    } catch { /* skip dead source */ }
  }
  return all;
}

async function findStream(name) {
  const all = await getAllStreams();
  return all[name] || null;
}

// =============================================================
// Dashboard HTML
// =============================================================
const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IPTV Panel · Xtream Codes</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-900 text-white min-h-screen p-6">
<div class="max-w-6xl mx-auto">
  <h1 class="text-3xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">IPTV Panel</h1>
  <p class="text-gray-400 mb-6 text-sm">Xtream Codes–compatible · Every user gets every stream automatically.</p>

  <div class="flex gap-2 mb-6 border-b border-gray-700 pb-2">
    <button onclick="showTab('streams')" id="tab-streams" class="px-4 py-2 rounded-t font-medium bg-blue-600">Streams</button>
    <button onclick="showTab('users')"   id="tab-users"   class="px-4 py-2 rounded-t font-medium text-gray-400 hover:text-white">Users</button>
  </div>

  <!-- Streams Tab -->
  <div id="pane-streams">
    <section class="bg-gray-800 rounded-xl p-6 shadow-lg mb-6">
      <h2 class="text-lg font-semibold mb-4">➕ Add Manual Stream</h2>
      <form id="addStreamForm" class="space-y-3">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input id="sName" type="text" placeholder="ID (e.g. mbc1)" required pattern="[a-zA-Z0-9_-]+" class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2">
          <input id="sUrl" type="url" placeholder="https://origin.com/stream/index.m3u8" required class="md:col-span-2 bg-gray-700 border border-gray-600 rounded-lg px-4 py-2">
        </div>
        <details class="text-sm text-gray-400">
          <summary class="cursor-pointer">Advanced headers</summary>
          <div class="grid grid-cols-2 gap-3 mt-2">
            <input id="sUA"  type="text" placeholder="User-Agent" class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2">
            <input id="sRef" type="text" placeholder="Referer"   class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2">
          </div>
        </details>
        <button type="submit" class="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded-lg font-medium">Add Stream</button>
      </form>
    </section>

    <section class="bg-gray-800 rounded-xl p-6 shadow-lg mb-6">
      <h2 class="text-lg font-semibold mb-4">🌐 External JSON Sources</h2>
      <form id="extForm" class="flex gap-2 mb-3">
        <input id="extUrl" type="url" placeholder="https://example.com/streams.json" required class="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-4 py-2">
        <button type="submit" class="bg-green-600 hover:bg-green-700 px-6 py-2 rounded-lg font-medium">Add Source</button>
      </form>
      <div id="extList" class="space-y-2 text-sm"></div>
    </section>

    <section class="bg-gray-800 rounded-xl p-6 shadow-lg">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold">📺 All Streams (<span id="streamCount">0</span>)</h2>
        <button onclick="loadStreams()" class="text-sm text-blue-400 hover:text-blue-300">↻ Refresh</button>
      </div>
      <div id="streamList" class="space-y-2"></div>
    </section>
  </div>

  <!-- Users Tab -->
  <div id="pane-users" class="hidden">
    <section class="bg-gray-800 rounded-xl p-6 shadow-lg mb-6">
      <h2 class="text-lg font-semibold mb-4">➕ Create User</h2>
      <p class="text-sm text-gray-400 mb-3">Every user gets access to <b class="text-white">all streams</b> automatically.</p>
      <form id="userForm" class="space-y-3">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input id="uName" type="text" placeholder="Username" required class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2">
          <input id="uPass" type="text" placeholder="Password" required class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2">
        </div>
        <button type="submit" class="bg-purple-600 hover:bg-purple-700 px-6 py-2 rounded-lg font-medium">Create User</button>
      </form>
    </section>

    <section class="bg-gray-800 rounded-xl p-6 shadow-lg">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-semibold">👥 Users (<span id="userCount">0</span>)</h2>
        <button onclick="loadUsers()" class="text-sm text-blue-400 hover:text-blue-300">↻ Refresh</button>
      </div>
      <div id="userList" class="space-y-3"></div>
    </section>
  </div>
</div>

<script>
const BASE = window.location.origin;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function showTab(t) {
  ['streams','users'].forEach(x => {
    document.getElementById('pane-' + x).classList.toggle('hidden', x !== t);
    document.getElementById('tab-' + x).className = 'px-4 py-2 rounded-t font-medium ' + (x === t ? 'bg-blue-600' : 'text-gray-400 hover:text-white');
  });
  if (t === 'users') loadUsers();
}

async function loadStreams() {
  const [manual, external, all] = await Promise.all([
    fetch('/api/streams').then(r => r.json()),
    fetch('/api/external').then(r => r.json()),
    fetch('/api/all-streams').then(r => r.json()),
  ]);

  document.getElementById('extList').innerHTML = external.length
    ? external.map(u => \`<div class="flex items-center gap-2 bg-gray-700 rounded px-3 py-1">
        <span class="flex-1 truncate font-mono text-xs">\${esc(u)}</span>
        <button onclick="delExt('\${encodeURIComponent(u)}')" class="text-red-400 text-xs">Remove</button>
      </div>\`).join('')
    : '<p class="text-gray-500 text-sm">None added.</p>';

  const names = Object.keys(all);
  document.getElementById('streamCount').textContent = names.length;
  document.getElementById('streamList').innerHTML = names.length
    ? names.map(n => {
        const s = all[n];
        const isManual = !!manual[n];
        return \`<div class="bg-gray-700 rounded p-3">
          <div class="flex justify-between items-center mb-1">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-blue-300">\${esc(n)}</span>
              <span class="text-xs \${isManual ? 'bg-blue-900 text-blue-300' : 'bg-green-900 text-green-300'} px-2 py-0.5 rounded">\${isManual ? 'manual' : 'external'}</span>
            </div>
            \${isManual ? \`<button onclick="delStream('\${esc(n)}')" class="text-red-400 text-xs">Delete</button>\` : ''}
          </div>
          <div class="text-xs text-gray-400 truncate mb-1">\${esc(s.url)}</div>
          <input readonly value="\${BASE}/stream/\${encodeURIComponent(n)}" onclick="this.select()" class="w-full bg-gray-900 text-green-400 text-xs font-mono rounded px-2 py-1">
        </div>\`;
      }).join('')
    : '<p class="text-gray-500 text-sm">No streams yet.</p>';
}

async function delStream(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  await fetch('/api/streams/' + encodeURIComponent(name), { method: 'DELETE' });
  loadStreams();
}
async function delExt(enc) {
  if (!confirm('Remove this source?')) return;
  await fetch('/api/external/' + enc, { method: 'DELETE' });
  loadStreams();
}

document.getElementById('addStreamForm').onsubmit = async e => {
  e.preventDefault();
  const body = {
    name: sName.value.trim(), url: sUrl.value.trim(),
    userAgent: sUA.value.trim() || undefined, referer: sRef.value.trim() || undefined,
  };
  const r = await fetch('/api/streams', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!r.ok) return alert((await r.json()).error);
  sUrl.value = ''; sUA.value = ''; sRef.value = '';
  loadStreams();
};
document.getElementById('extForm').onsubmit = async e => {
  e.preventDefault();
  const r = await fetch('/api/external', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ url: extUrl.value.trim() }) });
  if (!r.ok) return alert((await r.json()).error);
  extUrl.value = ''; loadStreams();
};

async function loadUsers() {
  const usersData = await fetch('/api/users').then(r => r.json());
  const keys = Object.keys(usersData);
  document.getElementById('userCount').textContent = keys.length;
  const list = document.getElementById('userList');

  if (keys.length === 0) {
    list.innerHTML = '<p class="text-gray-500 text-sm">No users yet.</p>';
    return;
  }

  list.innerHTML = keys.map(u => {
    const data = usersData[u];
    const playlistUrl = \`\${BASE}/get.php?username=\${encodeURIComponent(u)}&password=\${encodeURIComponent(data.password)}&type=m3u_plus&output=ts\`;
    return \`<div class="bg-gray-700 rounded p-4">
      <div class="flex justify-between items-center mb-2">
        <div>
          <span class="font-bold text-purple-300">\${esc(u)}</span>
          <span class="text-xs text-gray-400 ml-2">pass: \${esc(data.password)}</span>
        </div>
        <button onclick="delUser('\${esc(u)}')" class="text-red-400 text-sm">Delete</button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs mb-2">
        <div class="bg-gray-900 rounded p-2">
          <div class="text-gray-500 mb-1">Server URL</div>
          <div class="font-mono text-blue-300 truncate" title="\${BASE}">\${BASE}</div>
        </div>
        <div class="bg-gray-900 rounded p-2">
          <div class="text-gray-500 mb-1">Username</div>
          <div class="font-mono text-blue-300 truncate">\${esc(u)}</div>
        </div>
        <div class="bg-gray-900 rounded p-2">
          <div class="text-gray-500 mb-1">Password</div>
          <div class="font-mono text-blue-300 truncate">\${esc(data.password)}</div>
        </div>
      </div>

      <div class="flex gap-2 items-center">
        <input readonly value="\${playlistUrl}" onclick="this.select()" class="flex-1 bg-gray-900 text-green-400 text-xs font-mono rounded px-2 py-1 truncate">
        <button onclick="copy('\${playlistUrl}', this)" class="bg-green-600 hover:bg-green-700 px-3 py-1 rounded text-xs">Copy M3U</button>
      </div>
      <p class="text-xs text-gray-500 mt-2">Works with TiviMate, IPTV Smarters, OTT Navigator — choose "Xtream Codes API".</p>
    </div>\`;
  }).join('');
}

document.getElementById('userForm').onsubmit = async e => {
  e.preventDefault();
  const body = { username: uName.value.trim(), password: uPass.value.trim() };
  const r = await fetch('/api/users', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!r.ok) return alert((await r.json()).error);
  uName.value = ''; uPass.value = '';
  loadUsers();
};

async function delUser(name) {
  if (!confirm('Delete user "' + name + '"?')) return;
  await fetch('/api/users/' + encodeURIComponent(name), { method: 'DELETE' });
  loadUsers();
}

function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const o = btn.textContent; btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = o, 1200);
  });
}

loadStreams();
showTab('streams');
</script>
</body></html>`;

// =============================================================
// API: Streams
// =============================================================
app.get('/api/streams', (req, res) => res.json(streams));
app.post('/api/streams', (req, res) => {
  const { name, url, userAgent, referer } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'invalid name (only a-z, A-Z, 0-9, _ and -)' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  streams[name] = { url, userAgent, referer };
  res.json({ success: true });
});
app.delete('/api/streams/:name', (req, res) => { delete streams[req.params.name]; res.json({ success: true }); });

app.get('/api/external', (req, res) => res.json(externalSources));
app.post('/api/external', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (externalSources.includes(url)) return res.status(400).json({ error: 'already added' });
  try {
    const data = await fetchExternalSource(url);
    if (Object.keys(normalizeStreams(data)).length === 0) return res.status(400).json({ error: 'no recognizable streams in JSON' });
  } catch (err) { return res.status(400).json({ error: 'cannot fetch: ' + err.message }); }
  externalSources.push(url);
  res.json({ success: true });
});
app.delete('/api/external/:url', (req, res) => {
  const url = decodeURIComponent(req.params.url);
  externalSources = externalSources.filter(u => u !== url);
  jsonCache.delete(url);
  res.json({ success: true });
});

app.get('/api/all-streams', async (req, res) => res.json(await getAllStreams()));

// =============================================================
// API: Users
// =============================================================
app.get('/api/users', (req, res) => res.json(users));
app.post('/api/users', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return res.status(400).json({ error: 'username: only a-z, A-Z, 0-9, _ and -' });
  if (users[username]) return res.status(400).json({ error: 'user already exists' });
  users[username] = { password, createdAt: now() };
  res.json({ success: true });
});
app.delete('/api/users/:name', (req, res) => {
  delete users[req.params.name];
  res.json({ success: true });
});

// =============================================================
// XTREAM CODES COMPATIBLE ENDPOINTS
// =============================================================

// ---------- player_api.php ----------
app.all('/player_api.php', async (req, res) => {
  const { username, password, action } = { ...req.query, ...req.body };
  const user = users[username];

  if (!user || user.password !== password) {
    return res.status(401).json({ user_info: { auth: 0 } });
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;

  if (!action || action === 'get_account_info') {
    return res.json({
      user_info: {
        username,
        password,
        message: 'Welcome to IPTV Panel',
        auth: 1,
        status: 'Active',
        exp_date: null,
        is_trial: '0',
        active_cons: '1',
        created_at: String(user.createdAt),
        max_connections: '10',
        allowed_output_formats: ['ts'],
      },
      server_info: {
        url: baseUrl,
        port: req.socket.localPort || 443,
        https_port: 443,
        server_protocol: req.protocol,
        rtmp_port: '1935',
        timezone: 'UTC',
        timestamp_now: now(),
        time_now: new Date().toISOString().slice(0, 19).replace('T', ' '),
      },
    });
  }

  if (action === 'get_live_categories') {
    return res.json([{ category_id: '1', category_name: 'Live TV', parent_id: 0 }]);
  }

  if (action === 'get_live_streams') {
    const all = await getAllStreams();
    const list = Object.keys(all).map((name, i) => ({
      num: i + 1,
      name,
      stream_type: 'live',
      stream_id: name,
      stream_icon: '',
      epg_channel_id: name,
      added: String(user.createdAt),
      category_id: '1',
      custom_sid: '',
      tv_archive: 0,
      // Filled so TiviMate/Smarters skip URL construction and use this directly
      direct_source: `${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(name)}.m3u8`,
      tv_archive_duration: 0,
    }));
    return res.json(list);
  }

  if (action === 'get_vod_categories' || action === 'get_series' || action === 'get_series_categories' || action === 'get_vod_streams') {
    return res.json([]);
  }

  return res.json([]);
});

// ---------- get.php (M3U playlist) ----------
app.get('/get.php', async (req, res) => {
  const { username, password } = req.query;
  const user = users[username];
  if (!user || user.password !== password) {
    return res.status(401).send('#EXTM3U\n# Authentication failed');
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const all = await getAllStreams();

  let m3u = '#EXTM3U\n';
  for (const name of Object.keys(all)) {
    const streamUrl = `${baseUrl}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(name)}.m3u8`;
    m3u += `#EXTINF:-1 tvg-id="${name}" tvg-name="${name}" group-title="Live TV",${name}\n`;
    m3u += `${streamUrl}\n`;
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.send(m3u);
});

// ---------- Live stream proxy (Xtream path) ----------
// /live/:username/:password/:streamId(.m3u8|.ts|...)
app.get('/live/:username/:password/:streamId', async (req, res) => {
  const { username, password } = req.params;

  // Strip extension so "mbc1.m3u8" and "mbc1.ts" both resolve to "mbc1"
  const streamId = req.params.streamId.replace(/\.(m3u8|ts|mp4|mkv|m4s|aac)$/i, '');

  const user = users[username];
  if (!user || user.password !== password) return res.status(401).send('Unauthorized');

  // No stream-assignment check: every user can access every stream
  const stream = await findStream(streamId);
  if (!stream) return res.status(404).send('Stream not found');

  await proxyHandler(req, res, stream.url, stream);
});

// ---------- Public clean stream (no auth, for direct testing) ----------
app.get('/stream/:name', async (req, res) => {
  const stream = await findStream(req.params.name);
  if (!stream) return res.status(404).send('Stream not found');
  await proxyHandler(req, res, stream.url, stream);
});

// ---------- Internal segment proxy ----------
app.get('/proxy', async (req, res) => {
  if (!req.query.url) return res.status(400).send('Missing url');
  await proxyHandler(req, res, req.query.url, { userAgent: req.query.ua, referer: req.query.rf });
});

// =============================================================
// Shared proxy handler
// =============================================================
async function proxyHandler(req, res, targetUrl, opts = {}) {
  const headers = { 'User-Agent': opts.userAgent || 'Mozilla/5.0 (compatible; IPTVProxy/1.0)' };
  if (opts.referer) headers['Referer'] = opts.referer;
  if (req.headers.range) headers['Range'] = req.headers.range;

  try {
    const upstream = await fetch(targetUrl, { headers, redirect: 'follow', timeout: 20_000 });
    if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status).send('Upstream ' + upstream.status);

    const ct = upstream.headers.get('content-type') || '';
    const finalUrl = upstream.url || targetUrl;
    const isM3U8 = ct.includes('mpegurl') || finalUrl.split('?')[0].endsWith('.m3u8');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    if (isM3U8) {
      const text = await upstream.text();
      const qs = new URLSearchParams();
      if (opts.userAgent) qs.set('ua', opts.userAgent);
      if (opts.referer)   qs.set('rf', opts.referer);
      const suffix = qs.toString() ? '&' + qs.toString() : '';
      const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;
      const rewritten = rewriteM3U8(text, new URL(finalUrl), proxyBase, suffix);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    for (const h of ['accept-ranges', 'content-range', 'content-length']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('-'), v);
    }
    upstream.body.pipe(res);
  } catch (err) {
    res.status(502).send('Proxy error: ' + err.message);
  }
}

function rewriteM3U8(text, baseUrl, proxyBase, suffix) {
  return text.split('\n').map(raw => {
    const line = raw.trim();
    if (!line) return raw;
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP') || line.startsWith('#EXT-X-MEDIA')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        try { return `URI="${proxyBase}${encodeURIComponent(new URL(uri, baseUrl).href)}${suffix}"`; }
        catch { return m; }
      });
    }
    if (line.startsWith('#')) return raw;
    try { return proxyBase + encodeURIComponent(new URL(line, baseUrl).href) + suffix; }
    catch { return raw; }
  }).join('\n');
}

// =============================================================
app.get('/', (req, res) => res.send(dashboardHTML));
app.listen(PORT, () => console.log('IPTV Panel (Xtream Codes) on ' + PORT));
