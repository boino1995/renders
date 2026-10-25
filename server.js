// server.js - IPTV Proxy Panel with External JSON Sources
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
let streams = {};          // { name: { url, userAgent?, referer? } }  (manual)
let externalSources = [];  // [ "http://195.154.119.178:8500/files/streams.json", ... ]

const jsonCache = new Map(); // url -> { data, expires }
const CACHE_TTL = 60_000;    // 60 seconds

// =============================================================
// Dashboard HTML
// =============================================================
const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>IPTV Proxy Panel</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-900 text-white min-h-screen p-6">
<div class="max-w-5xl mx-auto">
  <h1 class="text-3xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">IPTV Proxy Panel</h1>
  <p class="text-gray-400 mb-6 text-sm">Add streams manually, or point to a JSON file — every stream gets a clean <code class="text-blue-300">/stream/:name</code> URL.</p>

  <!-- Manual stream -->
  <section class="bg-gray-800 rounded-xl p-6 shadow-lg mb-6">
    <h2 class="text-lg font-semibold mb-4">➕ Add Manual Stream</h2>
    <form id="addForm" class="space-y-3">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <input id="name" type="text" placeholder="ID (e.g. mbc1)" required pattern="[a-zA-Z0-9_-]+"
               class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
        <input id="url" type="url" placeholder="https://origin.com/stream/index.m3u8" required
               class="md:col-span-2 bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
      </div>
      <details class="text-sm text-gray-400">
        <summary class="cursor-pointer hover:text-gray-300">Advanced (optional headers)</summary>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <input id="userAgent" type="text" placeholder="Custom User-Agent" class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2">
          <input id="referer" type="text" placeholder="Custom Referer" class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2">
        </div>
      </details>
      <button type="submit" class="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded-lg font-medium">Add Stream</button>
    </form>
  </section>

  <!-- External JSON source -->
  <section class="bg-gray-800 rounded-xl p-6 shadow-lg mb-6">
    <h2 class="text-lg font-semibold mb-4">🌐 Add External JSON Source</h2>
    <form id="extForm" class="flex gap-2">
      <input id="extUrl" type="url" placeholder="https://example.com/streams.json" required
             class="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
      <button type="submit" class="bg-green-600 hover:bg-green-700 px-6 py-2 rounded-lg font-medium">Add Source</button>
    </form>
    <p class="text-xs text-gray-500 mt-2">
      Accepted shapes: <code>{ "name": { "url": "…" } }</code> or <code>[{ "name": "…", "url": "…" }]</code>.
      Cache refreshes every 60&nbsp;s.
    </p>
    <div id="extList" class="mt-4 space-y-2"></div>
  </section>

  <!-- All streams -->
  <section class="bg-gray-800 rounded-xl p-6 shadow-lg">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold">📺 All Streams</h2>
      <button onclick="loadAll()" class="text-sm text-blue-400 hover:text-blue-300">↻ Refresh</button>
    </div>
    <div id="groups" class="space-y-6">
      <p class="text-gray-400 text-sm">Loading…</p>
    </div>
  </section>
</div>

<script>
const BASE = window.location.origin;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function streamCard(name, s, fromExternal) {
  const proxyUrl = BASE + '/stream/' + encodeURIComponent(name);
  const badge = fromExternal
    ? '<span class="text-xs bg-green-900 text-green-300 px-2 py-0.5 rounded">external</span>'
    : '<span class="text-xs bg-blue-900 text-blue-300 px-2 py-0.5 rounded">manual</span>';
  const del = fromExternal ? '' :
    '<button onclick="delStream(\\'' + esc(name) + '\\')" class="text-red-400 hover:text-red-300 text-xs">Delete</button>';
  return \`
  <div class="bg-gray-700 rounded-lg p-3">
    <div class="flex items-center justify-between mb-2">
      <div class="flex items-center gap-2"><span class="font-semibold text-blue-300">\${esc(name)}</span>\${badge}</div>
      \${del}
    </div>
    <div class="text-xs text-gray-400 mb-2 truncate">Source: \${esc(s.url)}</div>
    <div class="flex gap-2 items-center">
      <input readonly value="\${esc(proxyUrl)}" onclick="this.select()"
             class="flex-1 bg-gray-900 text-green-400 text-xs font-mono rounded px-3 py-2 truncate">
      <button onclick="copy('\\'' + proxyUrl + '\\'', this)" class="bg-green-600 hover:bg-green-700 px-3 py-2 rounded text-xs font-medium">Copy</button>
    </div>
  </div>\`;
}

async function loadAll() {
  const groupsEl = document.getElementById('groups');
  const extEl = document.getElementById('extList');

  const [ext, all] = await Promise.all([
    fetch('/api/external').then(r => r.json()),
    fetch('/api/all-streams').then(r => r.json()),
  ]);

  // External sources management panel
  if (ext.length === 0) {
    extEl.innerHTML = '<p class="text-gray-500 text-sm">No external sources yet.</p>';
  } else {
    extEl.innerHTML = ext.map((u, i) => \`
      <div class="flex items-center gap-2 bg-gray-700 rounded-lg px-3 py-2">
        <span class="text-xs text-gray-400">\${i + 1}.</span>
        <span class="text-sm flex-1 truncate font-mono">\${esc(u)}</span>
        <button onclick="delExternal(\\'' + encodeURIComponent(u) + '\\')" class="text-red-400 hover:text-red-300 text-xs">Remove</button>
      </div>
    \`).join('');
  }

  // Stream groups
  const sections = [];
  if (all.manual && Object.keys(all.manual).length > 0) {
    sections.push(renderGroup('Manual', all.manual, false));
  }
  for (const [src, items] of Object.entries(all.external || {})) {
    sections.push(renderGroup(src, items, true));
  }
  groupsEl.innerHTML = sections.length
    ? sections.join('')
    : '<p class="text-gray-400 text-sm">No streams configured. Add one above.</p>';
}

function renderGroup(title, items, fromExternal) {
  const names = Object.keys(items);
  const cards = names.map(n => streamCard(n, items[n], fromExternal)).join('');
  return \`
    <div>
      <h3 class="text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wide">
        \${esc(title)} <span class="text-gray-600">(\${names.length})</span>
      </h3>
      <div class="space-y-2">\${cards}</div>
    </div>\`;
}

function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const o = btn.textContent; btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = o, 1200);
  });
}

async function delStream(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  await fetch('/api/streams/' + encodeURIComponent(name), { method: 'DELETE' });
  loadAll();
}

async function delExternal(encodedUrl) {
  if (!confirm('Remove this external source?')) return;
  await fetch('/api/external/' + encodedUrl, { method: 'DELETE' });
  loadAll();
}

document.getElementById('addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    name: document.getElementById('name').value.trim(),
    url: document.getElementById('url').value.trim(),
    userAgent: document.getElementById('userAgent').value.trim() || undefined,
    referer: document.getElementById('referer').value.trim() || undefined,
  };
  const r = await fetch('/api/streams', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if (!r.ok) return alert('Error: ' + (await r.json()).error);
  document.getElementById('url').value = '';
  loadAll();
});

document.getElementById('extForm').addEventListener('submit', async e => {
  e.preventDefault();
  const url = document.getElementById('extUrl').value.trim();
  const r = await fetch('/api/external', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ url })
  });
  if (!r.ok) return alert('Error: ' + (await r.json()).error);
  document.getElementById('extUrl').value = '';
  loadAll();
});

loadAll();
</script>
</body></html>`;

// =============================================================
// JSON parsing helpers
// =============================================================
function normalizeStreams(data) {
  const out = {};
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!item) continue;
      const name = item.name || item.id || item.key;
      const url  = item.url || item.stream_url || item.link || item.hls;
      if (!name || !url) continue;
      out[name] = {
        url,
        userAgent: item.userAgent || item.ua || item['user-agent'],
        referer:   item.referer || item.referrer,
      };
    }
    return out;
  }
  if (data && typeof data === 'object') {
    for (const [name, val] of Object.entries(data)) {
      if (typeof val === 'string') out[name] = { url: val };
      else if (val && typeof val === 'object' && val.url) {
        out[name] = { url: val.url, userAgent: val.userAgent || val.ua, referer: val.referer || val.referrer };
      }
    }
  }
  return out;
}

async function fetchExternalSource(url) {
  const now = Date.now();
  const cached = jsonCache.get(url);
  if (cached && cached.expires > now) return cached.data;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'IPTVProxy/1.0', 'Accept': 'application/json' },
      timeout: 10_000,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    jsonCache.set(url, { data, expires: now + CACHE_TTL });
    return data;
  } catch (err) {
    if (cached) return cached.data; // serve stale
    throw err;
  }
}

async function findStream(name) {
  // Manual first
  if (streams[name]) return { ...streams[name], _origin: 'manual' };
  // Then each external source
  for (const src of externalSources) {
    try {
      const data = await fetchExternalSource(src);
      const normalized = normalizeStreams(data);
      if (normalized[name]) return { ...normalized[name], _origin: src };
    } catch { /* skip dead source */ }
  }
  return null;
}

async function buildAllStreams() {
  const result = { manual: {}, external: {} };
  for (const [n, s] of Object.entries(streams)) {
    result.manual[n] = { url: s.url };
  }
  for (const src of externalSources) {
    try {
      const data = await fetchExternalSource(src);
      const normalized = normalizeStreams(data);
      // Strip names already provided manually
      for (const n of Object.keys(normalized)) {
        if (!streams[n]) {
          result.external[src] = result.external[src] || {};
          result.external[src][n] = normalized[n];
        }
      }
    } catch { /* ignore */ }
  }
  return result;
}

// =============================================================
// API: manual streams
// =============================================================
app.get('/api/streams', (req, res) => res.json(streams));

app.post('/api/streams', (req, res) => {
  const { name, url, userAgent, referer } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'invalid name' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  streams[name] = { url, userAgent, referer };
  res.json({ success: true });
});

app.delete('/api/streams/:name', (req, res) => {
  delete streams[req.params.name];
  res.json({ success: true });
});

// =============================================================
// API: external sources
// =============================================================
app.get('/api/external', (req, res) => res.json(externalSources));

app.post('/api/external', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (externalSources.includes(url)) return res.status(400).json({ error: 'already added' });
  // Verify the URL is fetchable and JSON before saving
  try {
    const data = await fetchExternalSource(url);
    const count = Object.keys(normalizeStreams(data)).length;
    if (count === 0) return res.status(400).json({ error: 'JSON has no recognizable streams' });
  } catch (err) {
    return res.status(400).json({ error: 'cannot fetch JSON: ' + err.message });
  }
  externalSources.push(url);
  res.json({ success: true });
});

app.delete('/api/external/:url', (req, res) => {
  const url = decodeURIComponent(req.params.url);
  externalSources = externalSources.filter(u => u !== url);
  jsonCache.delete(url);
  res.json({ success: true });
});

// =============================================================
// API: merged view for dashboard
// =============================================================
app.get('/api/all-streams', async (req, res) => {
  res.json(await buildAllStreams());
});

// =============================================================
// Clean entry point:  /stream/:name
// =============================================================
app.get('/stream/:name', async (req, res) => {
  const stream = await findStream(req.params.name);
  if (!stream) return res.status(404).send('Stream not found');
  await proxyHandler(req, res, stream.url, stream);
});

// =============================================================
// Internal proxy for segments / sub-playlists
// =============================================================
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');
  // Carry optional per-stream headers through via query params
  await proxyHandler(req, res, targetUrl, {
    userAgent: req.query.ua,
    referer:   req.query.rf,
  });
});

// =============================================================
// Shared proxy handler
// =============================================================
async function proxyHandler(req, res, targetUrl, opts) {
  const headers = { 'User-Agent': opts.userAgent || 'Mozilla/5.0 (compatible; IPTVProxy/1.0)' };
  if (opts.referer) headers['Referer'] = opts.referer;
  if (req.headers.range) headers['Range'] = req.headers.range;

  try {
    const upstream = await fetch(targetUrl, { headers, redirect: 'follow', timeout: 20_000 });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send('Upstream ' + upstream.status);
    }
    const ct = upstream.headers.get('content-type') || '';
    const finalUrl = upstream.url || targetUrl;
    const isM3U8 = ct.includes('mpegurl') || finalUrl.split('?')[0].endsWith('.m3u8');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    if (isM3U8) {
      const text = await upstream.text();
      // Preserve headers on rewritten URLs
      const qs = new URLSearchParams();
      if (opts.userAgent) qs.set('ua', opts.userAgent);
      if (opts.referer)   qs.set('rf', opts.referer);
      const suffix = qs.toString() ? '&' + qs.toString() : '';
      const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;
      const rewritten = rewriteM3U8(text, new URL(finalUrl), proxyBase, suffix);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // Binary stream
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
app.listen(PORT, () => console.log('IPTV Proxy running on ' + PORT));
