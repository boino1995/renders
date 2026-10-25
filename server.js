// server.js — ClusterCore port (single file, ESM)
import express from "express";
import path from "path";
import fs from "fs";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import crypto from "crypto";
import { spawn } from "child_process";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PORT     = process.env.PORT || 3000;
const DB_PATH  = process.env.DB_PATH || path.join(__dirname, "data", "cluster.db");
const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function auditLog(level, message) {
  try {
    db.prepare("INSERT INTO audit_logs (level, message) VALUES (?, ?)").run(level, message);
  } catch { /* ignore */ }
}

function syncJson(filename, data) {
  const jsonStr = JSON.stringify(data, null, 2);
  const localPath = path.join(DATA_DIR, filename);
  try { fs.writeFileSync(localPath, jsonStr); } catch (e) { console.error("sync local:", e.message); }
  const ext = process.env.EXTERNAL_JSON_PATH;
  if (ext) {
    try {
      if (!fs.existsSync(ext)) fs.mkdirSync(ext, { recursive: true });
      fs.writeFileSync(path.join(ext, filename), jsonStr);
    } catch (e) { console.error("sync external:", e.message); }
  }
}

// -------------------------------------------------------------
// Schema
// -------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    node TEXT,
    profile TEXT,
    category TEXT DEFAULT 'Uncategorized',
    logo TEXT,
    headers TEXT DEFAULT '{}',
    status TEXT DEFAULT 'offline',
    last_check DATETIME
  );
  CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, url TEXT NOT NULL, token TEXT
  );
  CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    args TEXT DEFAULT '[]', logo TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY, password TEXT NOT NULL,
    status TEXT DEFAULT 'Active', exp_date TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    level TEXT, message TEXT
  );
  CREATE TABLE IF NOT EXISTS category_logos (
    category TEXT PRIMARY KEY, logo_url TEXT NOT NULL
  );
`);

// Migrations (idempotent)
for (const col of ["category", "logo"]) {
  try { db.prepare(`SELECT ${col} FROM streams LIMIT 1`).get(); }
  catch { db.exec(`ALTER TABLE streams ADD COLUMN ${col} TEXT`); }
}

// -------------------------------------------------------------
// M3U fetch (from external source, refreshed every 30s)
// -------------------------------------------------------------
let m3uFetchInterval = null;

async function fetchExternalM3U() {
  const url = process.env.M3U_SOURCE_URL;
  if (!url) return;
  console.log(`[M3U] fetching ${url}`);
  try {
    const resp = await axios.get(url, { timeout: 30000, responseType: "text" });
    const content = typeof resp.data === "string" ? resp.data : String(resp.data);
    const lines = content.split(/\r?\n/);

    const fetched = [];
    let cur = null, idCounter = 600;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXTINF:")) {
        cur = {
          name: (line.match(/,(.*)$/) || [, "Unnamed"])[1].trim(),
          category: (line.match(/group-title="([^"]*)"/) || [, "Uncategorized"])[1],
          logo: (line.match(/tvg-logo="([^"]*)"/) || [, null])[1],
          id: (line.match(/tvg-id="([^"]*)"/) || [, null])[1],
        };
      } else if (!line.startsWith("#") && cur) {
        cur.url = line;
        cur.id = cur.id || (idCounter <= 900 ? String(idCounter++) : crypto.createHash("md5").update(line).digest("hex").slice(0, 16));
        fetched.push(cur);
        cur = null;
      }
    }

    if (fetched.length > 0) {
      const stmt = db.prepare("INSERT OR REPLACE INTO streams (id, name, url, category, logo, headers, status) VALUES (?, ?, ?, ?, ?, ?, ?)");
      db.transaction(() => {
        for (const s of fetched) stmt.run(s.id, s.name, s.url, s.category, s.logo, "{}", "online");
      })();
      const all = db.prepare("SELECT id, name, url, node, profile, category, headers FROM streams").all();
      syncJson("streams.json", all);
      auditLog("SYSTEM", `Auto-fetched ${fetched.length} streams from M3U`);
    }
  } catch (e) {
    console.error("[M3U] error:", e.message);
  }
}

// -------------------------------------------------------------
// Express app
// -------------------------------------------------------------
const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "50mb" }));

// --- Auth middleware ---
const adminAuth = (req, res, next) => {
  const pass = process.env.ADMIN_PASSWORD || "admin";
  if (req.headers["x-admin-auth"] === pass) return next();
  res.status(403).json({ status: "error", message: "Admin access required" });
};

const clientAuth = (req, res, next) => {
  const hdr = req.headers["x-client-auth"];
  if (!hdr) return res.status(403).json({ status: "error", message: "Client access required" });
  try {
    const [u, p] = Buffer.from(hdr, "base64").toString().split(":");
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(u, p);
    if (!user) return res.status(403).json({ status: "error", message: "Invalid client credentials" });
    req.user = user;
    next();
  } catch {
    res.status(403).json({ status: "error", message: "Invalid auth format" });
  }
};

// --- Auth endpoints ---
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === (process.env.ADMIN_USERNAME || "admin") && password === (process.env.ADMIN_PASSWORD || "admin")) {
    auditLog("SECURITY", `Admin login: ${username}`);
    return res.json({ status: "success", user: { username, token: process.env.ADMIN_PASSWORD || "admin" } });
  }
  auditLog("SECURITY", `Failed admin login: ${username}`);
  res.status(401).json({ status: "error", message: "Invalid admin credentials" });
});

app.post("/api/client/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password);
  if (!user) return res.status(401).json({ status: "error", message: "Invalid credentials" });
  if (user.status !== "Active") return res.status(403).json({ status: "error", message: `Account is ${user.status}` });
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  auditLog("SECURITY", `Client login: ${username}`);
  res.json({ status: "success", user: { ...user, token } });
});

app.post("/api/logout", (req, res) => {
  const { username, role } = req.body || {};
  auditLog("SECURITY", `${role === "admin" ? "Admin" : "Client"} logout: ${username}`);
  res.json({ status: "success" });
});

// --- Client-facing ---
app.get("/api/client/streams", clientAuth, (req, res) => {
  res.json(db.prepare("SELECT id, name, category, status, logo FROM streams").all());
});

// --- Streams (admin) ---
app.get("/api/streams", adminAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM streams").all();
  res.json(rows.map(s => {
    let headers = {};
    try { headers = s.headers ? JSON.parse(s.headers) : {}; } catch {}
    return { ...s, headers };
  }));
});

app.post("/api/streams", adminAuth, (req, res) => {
  const streams = req.body;
  const ins = db.prepare("INSERT INTO streams (id, name, url, node, profile, category, logo, headers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM streams").run();
    for (const s of streams) {
      let headers = s.headers || {};
      if (typeof headers === "string") { try { headers = JSON.parse(headers); } catch { headers = {}; } }
      ins.run(s.id, s.name, s.url, s.node, s.profile, s.category || "Uncategorized", s.logo || null, JSON.stringify(headers));
    }
  })();
  syncJson("streams.json", streams.map(({ status, last_check, ...r }) => r));
  auditLog("INFO", `Updated streams (${streams.length})`);
  res.json({ status: "success" });
});

app.post("/api/streams/fetch", adminAuth, async (req, res) => {
  await fetchExternalM3U();
  res.json({ message: "M3U fetch triggered" });
});

// --- Category logos ---
app.get("/api/category-logos", adminAuth, (req, res) => res.json(db.prepare("SELECT * FROM category_logos").all()));
app.post("/api/category-logos", adminAuth, (req, res) => {
  db.prepare("INSERT OR REPLACE INTO category_logos (category, logo_url) VALUES (?, ?)").run(req.body.category, req.body.logo_url);
  res.json({ status: "success" });
});

// --- Nodes ---
app.get("/api/nodes", adminAuth, (req, res) => res.json(db.prepare("SELECT * FROM nodes").all()));
app.post("/api/nodes", adminAuth, (req, res) => {
  const nodes = req.body;
  db.transaction(() => {
    db.prepare("DELETE FROM nodes").run();
    const ins = db.prepare("INSERT INTO nodes (name, url, token) VALUES (?, ?, ?)");
    for (const n of nodes) ins.run(n.name, n.url, n.token);
  })();
  syncJson("nodes.json", nodes);
  res.json({ status: "success" });
});

// --- Profiles ---
app.get("/api/profiles", adminAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM profiles").all();
  res.json(rows.map(p => { let args = []; try { args = p.args ? JSON.parse(p.args) : []; } catch {} return { ...p, args }; }));
});
app.post("/api/profiles", adminAuth, (req, res) => {
  const profiles = req.body;
  db.transaction(() => {
    db.prepare("DELETE FROM profiles").run();
    const ins = db.prepare("INSERT INTO profiles (id, name, args, logo) VALUES (?, ?, ?, ?)");
    for (const p of profiles) {
      let args = p.args || [];
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = []; } }
      ins.run(p.id, p.name, JSON.stringify(args), p.logo || null);
    }
  })();
  syncJson("profiles.json", profiles);
  res.json({ status: "success" });
});

// --- Users ---
app.get("/api/users", adminAuth, (req, res) => res.json(db.prepare("SELECT * FROM users").all()));
app.post("/api/users", adminAuth, (req, res) => {
  const users = req.body;
  db.transaction(() => {
    db.prepare("DELETE FROM users").run();
    const ins = db.prepare("INSERT INTO users (username, password, status, exp_date) VALUES (?, ?, ?, ?)");
    for (const u of users) ins.run(u.username, u.password, u.status || "Active", u.exp_date || null);
  })();
  syncJson("users.json", users);
  res.json({ status: "success" });
});

// --- Audit logs ---
app.get("/api/logs", adminAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100").all());
});

// --- Health checks ---
app.get("/api/check-health/:id", adminAuth, async (req, res) => {
  const stream = db.prepare("SELECT * FROM streams WHERE id = ?").get(req.params.id);
  if (!stream) return res.json({ status: "offline", msg: "Stream not found" });
  if (!stream.node) {
    try {
      const head = await axios.head(stream.url, { timeout: 2000 });
      return res.json({ status: head.status < 400 ? "online" : "offline", viewers: 0 });
    } catch { return res.json({ status: "offline" }); }
  }
  const node = db.prepare("SELECT * FROM nodes WHERE url = ?").get(stream.node);
  if (!node) return res.json({ status: "offline", msg: "Node not found" });
  try {
    const r = await axios.get(`${node.url}/api/node_status/${stream.id}`, {
      headers: { Authorization: `Bearer ${node.token || ""}`, "X-Panel-Secret": "ClusterX-Core" },
      timeout: 3000,
    });
    res.json({ status: r.data.active ? "online" : "offline", viewers: r.data.clients || 0 });
  } catch (e) { res.json({ status: "offline", error: e.message }); }
});

app.get("/api/node-health/:id", adminAuth, async (req, res) => {
  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(req.params.id);
  if (!node) return res.status(404).json({ status: "offline", error: "Node not found" });
  try {
    const r = await axios.get(`${node.url}/health`, {
      headers: { Authorization: `Bearer ${node.token || ""}`, "X-Panel-Secret": "ClusterX-Core" },
      timeout: 5000,
    });
    res.json({ status: "online", details: r.data });
  } catch (e) { res.json({ status: "offline", error: e.message }); }
});

// -------------------------------------------------------------
// Xtream Codes API
// -------------------------------------------------------------
app.get("/player_api.php", (req, res) => {
  const { username, password, action, category_id } = req.query;
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password);
  if (!user) return res.json({ user_info: { auth: 0, status: "Invalid" } });

  const streams = db.prepare("SELECT * FROM streams").all();
  const categories = [...new Set(streams.map(s => s.category || "Uncategorized"))];
  const host = req.get("host");

  if (!action) {
    return res.json({
      user_info: {
        auth: 1, status: user.status,
        exp_date: user.exp_date || "1924905600",
        max_connections: "0", active_cons: "0", is_trial: "0", created_at: "1609459200",
      },
      server_info: { url: host, port: String(PORT), server_protocol: "http", timezone: "GMT", timestamp: Math.floor(Date.now() / 1000) },
    });
  }

  if (action === "get_live_categories") {
    return res.json(categories.map((cat, i) => ({ category_id: String(i + 1), category_name: cat, parent_id: 0 })));
  }

  if (action === "get_live_streams") {
    let filtered = streams;
    if (category_id) {
      const catName = categories[parseInt(category_id, 10) - 1];
      filtered = streams.filter(s => (s.category || "Uncategorized") === catName);
    }
    return res.json(filtered.map(s => ({
      num: s.id, name: s.name, stream_type: "live", stream_id: s.id,
      stream_icon: s.logo || "", epg_channel_id: "", added: "1609459200",
      category_id: String(categories.indexOf(s.category || "Uncategorized") + 1),
      custom_sid: "", tv_archive: 0, direct_source: "", tv_archive_duration: 0, thumbnail: "",
    })));
  }

  res.json([]);
});

// -------------------------------------------------------------
// M3U playlist
// -------------------------------------------------------------
app.get("/get.php", (req, res) => {
  const { username, password } = req.query;
  const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(username, password);
  if (!user) return res.status(401).send("Auth Failed");

  const streams = db.prepare("SELECT * FROM streams").all();
  const host = req.get("host");
  let out = "#EXTM3U\n";
  for (const s of streams) {
    out += `#EXTINF:-1 tvg-id="${s.id}" group-title="${s.category || "Live"}",${s.name}\n`;
    out += `http://${host}/${username}/${password}/${s.id}.ts\n`;
  }
  res.setHeader("Content-Type", "audio/x-mpegurl");
  res.setHeader("Content-Disposition", "attachment; filename=playlist.m3u");
  res.send(out);
});

// -------------------------------------------------------------
// Proxy tunnel  /:u/:p/:file
// -------------------------------------------------------------
app.get("/:u/:p/:file", async (req, res, next) => {
  const { u, p, file } = req.params;
  if (["api", "src", "node_modules", "assets", "dist"].includes(u) || file === "favicon.ico" || file.includes("php")) return next();

  const user = db.prepare("SELECT * FROM users WHERE username = ? AND password = ?").get(u, p);
  if (!user) { auditLog("SECURITY", `Blocked unauthorized ${file} (u=${u})`); return res.status(403).send("Auth Failed"); }
  if (user.status !== "Active") return res.status(403).send("Account is " + user.status);
  if (user.exp_date && parseInt(user.exp_date, 10) < Math.floor(Date.now() / 1000)) return res.status(403).send("Account Expired");

  const streamId = file.split(".")[0];
  const stream = db.prepare("SELECT * FROM streams WHERE id = ?").get(streamId);
  if (!stream) return res.status(404).send("Stream not found");

  if (!stream.node) {
    try {
      let headers = {};
      try { headers = stream.headers ? JSON.parse(stream.headers) : {}; } catch {}

      // YouTube branch (yt-dlp + ffmpeg)
      if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(stream.url)) {
        const ytDlp = process.env.YT_DLP_PATH || "yt-dlp";
        const args = ["--no-playlist", "--no-part", "--no-cache-dir", "--no-warnings",
                      "-f", "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/best[ext=mp4]/best"];
        const cookiePath = process.env.YT_COOKIES_FILE || path.join(DATA_DIR, "cookies.txt");
        if (fs.existsSync(cookiePath)) args.push("--cookies", cookiePath);
        args.push("--impersonate", "chrome");
        if (process.env.YOUTUBE_PO_TOKEN) args.push("--extractor-args", `youtube:po_token=${process.env.YOUTUBE_PO_TOKEN}`);
        args.push("-o", "-", stream.url);

        const yt = spawn(ytDlp, args);
        const ff = spawn("ffmpeg", ["-i", "pipe:0", "-c", "copy", "-f", "mpegts", "pipe:1"]);

        const kill = () => { try { yt.kill(); } catch {} try { ff.kill(); } catch {} };
        req.on("close", kill); res.on("close", kill);

        yt.stdout.pipe(ff.stdin);
        ff.stdout.pipe(res);

        yt.stdout.on("error", e => { if (e.code !== "EPIPE") console.error("yt stdout:", e.message); });
        ff.stdin.on("error", e => { if (e.code !== "EPIPE") console.error("ff stdin:", e.message); });
        yt.stderr.on("data", d => { const m = d.toString(); if (m.includes("ERROR")) console.error("yt-dlp:", m); });
        yt.on("error", e => { console.error("spawn yt-dlp:", e.message); if (!res.headersSent) res.status(503).send("YouTube unreachable"); });

        res.setHeader("Content-Type", "video/mp2t");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Cache-Control", "no-cache, no-store");
        return;
      }

      // Generic HTTP stream
      const upstream = await axios({ method: "get", url: stream.url, responseType: "stream", timeout: 15000, headers, decompress: false });
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Cache-Control", "no-cache, no-store");
      upstream.data.on("error", e => { if (e.code !== "EPIPE") upstream.data.destroy(); });
      upstream.data.pipe(res);
      req.on("close", () => upstream.data.destroy());
    } catch (e) {
      if (!res.headersSent) res.status(503).send("Source unreachable");
    }
    return;
  }

  // Edge-node branch
  const node = db.prepare("SELECT * FROM nodes WHERE url = ?").get(stream.node);
  if (!node) return res.status(502).send("Node unconfigured");
  try {
    const edge = await axios({
      method: "get", url: `${node.url}/${u}/${p}/${file}`,
      responseType: "stream", timeout: 15000,
      headers: { Authorization: `Bearer ${node.token || ""}` }, decompress: false,
    });
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Cache-Control", "no-cache, no-store");
    edge.data.on("error", e => { if (e.code !== "EPIPE") edge.data.destroy(); });
    edge.data.pipe(res);
    req.on("close", () => edge.data.destroy());
  } catch { res.status(503).send("Edge unreachable"); }
});

// -------------------------------------------------------------
// Embedded admin dashboard (replaces the Vite frontend)
// -------------------------------------------------------------
app.get("/", (req, res) => res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>ClusterCore</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-900 text-white p-6">
<div class="max-w-4xl mx-auto">
  <h1 class="text-2xl font-bold mb-4 text-blue-400">ClusterCore · Admin</h1>
  <p class="text-gray-400 text-sm mb-6">Use the API endpoints below (all require <code>X-Admin-Auth</code> header):</p>
  <ul class="space-y-2 text-sm font-mono text-gray-300">
    <li>GET  /api/streams</li>
    <li>POST /api/streams</li>
    <li>POST /api/streams/fetch</li>
    <li>GET  /api/users · POST /api/users</li>
    <li>GET  /api/nodes · POST /api/nodes</li>
    <li>GET  /api/profiles · POST /api/profiles</li>
    <li>GET  /api/category-logos · POST /api/category-logos</li>
    <li>GET  /api/logs</li>
    <li>GET  /player_api.php?username=…&password=…</li>
    <li>GET  /get.php?username=…&password=…</li>
  </ul>
</div></body></html>`));

// -------------------------------------------------------------
// Boot
// -------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  auditLog("SYSTEM", "ClusterCore initialized");
  console.log(`Listening on :${PORT}`);
  if (!m3uFetchInterval) {
    fetchExternalM3U();
    m3uFetchInterval = setInterval(fetchExternalM3U, 30_000);
  }
});
