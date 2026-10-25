// server.js - IPTV Proxy Panel with Clean Stream URLs
const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================================
// In-memory stream store
// Format: { "name": { url, userAgent?, referer? } }
// NOTE: resets on restart. For persistence use Render Key Value.
// =============================================================
let streams = {};

// =============================================================
// Dashboard HTML
// =============================================================
const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IPTV Proxy Panel</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-900 text-white min-h-screen p-6">
  <div class="max-w-4xl mx-auto">
    <h1 class="text-3xl font-bold mb-2 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
      IPTV Proxy Panel
    </h1>
    <p class="text-gray-400 mb-6 text-sm">Add a stream URL → get a clean proxy URL you can paste in VLC / TiviMate / Smarters.</p>

    <div class="bg-gray-800 rounded-xl p-6 shadow-lg mb-6">
      <h2 class="text-xl font-semibold mb-4">Add New Stream</h2>
      <form id="addForm" class="space-y-3">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input id="name" type="text" placeholder="ID (e.g. mbc1)" required
                 pattern="[a-zA-Z0-9_-]+"
                 class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
          <input id="url" type="url" placeholder="https://origin.com/stream/index.m3u8" required
                 class="md:col-span-2 bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
        </div>
        <details class="text-sm text-gray-400">
          <summary class="cursor-pointer hover:text-gray-300">Advanced (optional headers)</summary>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
            <input id="userAgent" type="text" placeholder="Custom User-Agent"
                   class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none">
            <input id="referer" type="text" placeholder="Custom Referer"
                   class="bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none">
          </div>
        </details>
        <button type="submit"
                class="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded-lg font-medium transition">
          Add Stream
        </button>
      </form>
    </div>

    <div class="bg-gray-800 rounded-xl p-6 shadow-lg">
      <h2 class="text-xl font-semibold mb-4">Your Streams</h2>
      <div id="streamList" class="space-y-3">
        <p class="text-gray-400 text-sm">Loading...</p>
      </div>
    </div>
  </div>

  <script>
    const API_BASE = '/api';
    const BASE_URL = window.location.origin;

    async function loadStreams() {
      const res = await fetch(API_BASE + '/streams');
      const data = await res.json();
      const list = document.getElementById('streamList');
      const names = Object.keys(data);
      if (names.length === 0) {
        list.innerHTML = '<p class="text-gray-400 text-sm">No streams yet. Add one above.</p>';
        return;
      }
      list.innerHTML = names.map(name => {
        const s = data[name];
        const proxyUrl = BASE_URL + '/stream/' + encodeURIComponent(name);
        return \`
          <div class="bg-gray-700 rounded-lg p-3">
            <div class="flex items-center justify-between mb-2">
              <span class="font-semibold text-blue-300">\${name}</span>
              <button onclick="delStream('\${name}')" class="text-red-400 hover:text-red-300 text-sm">Delete</button>
            </div>
            <div class="text-xs text-gray-400 mb-2 truncate">Source: \${escapeHtml(s.url)}</div>
            <div class="flex gap-2 items-center">
              <input readonly value="\${proxyUrl}"
                     class="flex-1 bg-gray-900 text-green-400 text-xs font-mono rounded px-3 py-2 truncate"
                     onclick="this.select()">
              <button onclick="copy('\${proxyUrl}', this)"
                      class="bg-green-600 hover:bg-green-700 px-3 py-2 rounded text-sm font-medium">
                Copy
              </button>
            </div>
          </div>
        \`;
      }).join('');
    }

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function copy(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = orig, 1500);
      });
    }

    async function delStream(name) {
      if (!confirm('Delete "' + name + '"?')) return;
      await fetch(API_BASE + '/streams/' + encodeURIComponent(name), { method: 'DELETE' });
      loadStreams();
    }

    document.getElementById('addForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        name: document.getElementById('name').value.trim(),
        url: document.getElementById('url').value.trim(),
        userAgent: document.getElementById('userAgent').value.trim() || undefined,
        referer: document.getElementById('referer').value.trim() || undefined,
      };
      const res = await fetch(API_BASE + '/streams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        alert('Error: ' + (err.error || res.statusText));
        return;
      }
      document.getElementById('url').value = '';
      loadStreams();
    });

    loadStreams();
  </script>
</body>
</html>`;

// =============================================================
// API Routes
// =============================================================
app.get('/api/streams', (req, res) => res.json(streams));

app.post('/api/streams', (req, res) => {
  const { name, url, userAgent, referer } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: 'name can only contain letters, numbers, _ and -' });
  }
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'url is not valid' });
  }
  streams[name] = { url, userAgent, referer };
  res.json({ success: true });
});

app.delete('/api/streams/:name', (req, res) => {
  delete streams[req.params.name];
  res.json({ success: true });
});

// =============================================================
// Clean Stream Proxy:  GET /stream/:name
// =============================================================
app.get('/stream/:name', async (req, res) => {
  const stream = streams[req.params.name];
  if (!stream) return res.status(404).send('Stream not found');
  await proxyHandler(req, res, stream.url, stream);
});

// =============================================================
// Segment / Sub-playlist Proxy:  GET /proxy?url=...
// =============================================================
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');
  await proxyHandler(req, res, targetUrl, {});
});

// =============================================================
// Shared proxy handler
// =============================================================
async function proxyHandler(req, res, targetUrl, opts) {
  const headers = {
    'User-Agent': opts.userAgent || 'Mozilla/5.0 (compatible; IPTVProxy/1.0)',
  };
  if (opts.referer) headers['Referer'] = opts.referer;
  if (req.headers.range) headers['Range'] = req.headers.range;

  try {
    const upstream = await fetch(targetUrl, {
      headers,
      redirect: 'follow',
      timeout: 20000,
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send('Upstream error: ' + upstream.status);
    }

    const contentType = upstream.headers.get('content-type') || '';
    const finalUrl = upstream.url || targetUrl;
    const isM3U8 = contentType.includes('mpegurl') || finalUrl.split('?')[0].endsWith('.m3u8');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    if (isM3U8) {
      const text = await upstream.text();
      const baseUrl = new URL(finalUrl);
      const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;
      const rewritten = rewriteM3U8(text, baseUrl, proxyBase);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(rewritten);
    }

    // Binary — stream through, preserving Range/Content-Length for seeking
    res.status(upstream.status);
    res.setHeader('Content-Type', contentType || 'application/octet-stream');
    const ar = upstream.headers.get('accept-ranges');
    const cr = upstream.headers.get('content-range');
    const cl = upstream.headers.get('content-length');
    if (ar) res.setHeader('Accept-Ranges', ar);
    if (cr) res.setHeader('Content-Range', cr);
    if (cl) res.setHeader('Content-Length', cl);
    upstream.body.pipe(res);
  } catch (err) {
    res.status(502).send('Proxy error: ' + err.message);
  }
}

// =============================================================
// M3U8 rewriter — handles segments, sub-playlists, keys, maps, media
// =============================================================
function rewriteM3U8(text, baseUrl, proxyBase) {
  return text.split('\n').map(rawLine => {
    const line = rawLine.trim();
    if (!line) return rawLine;

    // Rewrite URI="..." inside #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP') || line.startsWith('#EXT-X-MEDIA')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        try {
          const abs = new URL(uri, baseUrl).href;
          return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
        } catch { return m; }
      });
    }

    if (line.startsWith('#')) return rawLine;

    // Segment or sub-playlist URL
    try {
      const abs = new URL(line, baseUrl).href;
      return proxyBase + encodeURIComponent(abs);
    } catch {
      return rawLine;
    }
  }).join('\n');
}

// =============================================================
// Dashboard root
// =============================================================
app.get('/', (req, res) => res.send(dashboardHTML));

app.listen(PORT, () => console.log(`IPTV Proxy running on port ${PORT}`));
