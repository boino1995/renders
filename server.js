// server.js - Minimal IPTV Proxy Panel (Single File)
const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory storage for demo purposes
// (Resets on restart. For production, replace with a database or KV store)
let sources = [];

// --- Embedded Dashboard HTML ---
const dashboardHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IPTV Proxy Panel</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-900 text-white min-h-screen p-6">
    <div class="max-w-3xl mx-auto">
        <h1 class="text-3xl font-bold mb-6 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
            IPTV Proxy Dashboard
        </h1>
        
        <div class="bg-gray-800 rounded-xl p-6 shadow-lg mb-6">
            <h2 class="text-xl font-semibold mb-4">Add Playlist Source</h2>
            <form id="addForm" class="flex gap-2">
                <input id="name" type="text" placeholder="Name" required
                       class="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <input id="url" type="url" placeholder="https://example.com/playlist.m3u8" required
                       class="flex-[2] bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <button type="submit"
                        class="bg-blue-600 hover:bg-blue-700 px-6 py-2 rounded-lg font-medium transition">
                    Add
                </button>
            </form>
        </div>

        <div class="bg-gray-800 rounded-xl p-6 shadow-lg">
            <h2 class="text-xl font-semibold mb-4">Your Sources</h2>
            <ul id="sourceList" class="space-y-2">
                <li class="text-gray-400">Loading...</li>
            </ul>
        </div>
    </div>

    <script>
        const API_BASE = '/api';

        async function loadSources() {
            const res = await fetch(API_BASE + '/sources');
            const data = await res.json();
            const list = document.getElementById('sourceList');
            if (data.length === 0) {
                list.innerHTML = '<li class="text-gray-400">No sources added yet.</li>';
                return;
            }
            list.innerHTML = data.map(s => \`
                <li class="flex items-center justify-between bg-gray-700 p-3 rounded-lg">
                    <div>
                        <span class="font-medium">\${s.name}</span>
                        <span class="text-gray-400 text-sm ml-2 truncate max-w-xs">\${s.url}</span>
                    </div>
                    <div class="space-x-2">
                        <a href="/proxy?url=\${encodeURIComponent(s.url)}" target="_blank"
                           class="text-blue-400 hover:text-blue-300 text-sm">Proxy Link</a>
                        <button onclick="deleteSource('\${s.name}')"
                                class="text-red-400 hover:text-red-300 text-sm">Delete</button>
                    </div>
                </li>
            \`).join('');
        }

        async function deleteSource(name) {
            if (!confirm('Delete this source?')) return;
            await fetch(API_BASE + '/sources/' + encodeURIComponent(name), { method: 'DELETE' });
            loadSources();
        }

        document.getElementById('addForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('name').value;
            const url = document.getElementById('url').value;
            await fetch(API_BASE + '/sources', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, url })
            });
            document.getElementById('url').value = '';
            loadSources();
        });

        loadSources();
    </script>
</body>
</html>
`;

// --- API Routes for Dashboard ---
app.get('/api/sources', (req, res) => {
    res.json(sources);
});

app.post('/api/sources', (req, res) => {
    const { name, url } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
    // Remove existing with same name
    sources = sources.filter(s => s.name !== name);
    sources.push({ name, url });
    res.json({ success: true });
});

app.delete('/api/sources/:name', (req, res) => {
    sources = sources.filter(s => s.name !== req.params.name);
    res.json({ success: true });
});

// --- Proxy Route ---
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing "url" parameter');

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; IPTVProxy/1.0)',
            },
            redirect: 'follow',
            timeout: 15000,
        });

        const contentType = response.headers.get('content-type') || '';

        // If it's an M3U8 playlist, rewrite relative URLs
        if (contentType.includes('application/vnd.apple.mpegurl') ||
            contentType.includes('application/x-mpegurl') ||
            targetUrl.endsWith('.m3u8')) {
            
            let text = await response.text();
            const baseUrl = new URL(targetUrl);
            const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

            text = text.split('\n').map(line => {
                if (line.trim() === '' || line.startsWith('#')) return line;
                try {
                    const absolute = new URL(line.trim(), baseUrl).href;
                    return proxyBase + encodeURIComponent(absolute);
                } catch {
                    return line;
                }
            }).join('\n');

            res.setHeader('Content-Type', contentType);
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(text);
        }

        // For binary segments, stream the response directly
        res.setHeader('Content-Type', contentType || 'video/mp2t');
        res.setHeader('Access-Control-Allow-Origin', '*');
        // Forward Range headers for seeking
        if (response.headers.get('accept-ranges')) {
            res.setHeader('Accept-Ranges', response.headers.get('accept-ranges'));
        }
        if (response.headers.get('content-range')) {
            res.setHeader('Content-Range', response.headers.get('content-range'));
        }

        response.body.pipe(res);

    } catch (err) {
        res.status(502).send(`Proxy error: ${err.message}`);
    }
});

// --- Serve Dashboard at Root ---
app.get('/', (req, res) => {
    res.send(dashboardHTML);
});

// --- Start Server ---
app.listen(PORT, () => {
    console.log(`IPTV Proxy Panel running on port ${PORT}`);
});