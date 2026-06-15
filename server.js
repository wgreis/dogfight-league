// Dogfight League Tracker — server for Railway
// Serves the tracker, stores shared league data, and syncs live handicaps from GHIN.
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GhinClient } from "ghin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

/* ---------- optional password gate (set LEAGUE_PASSWORD in Railway to enable) ---------- */
if (process.env.LEAGUE_PASSWORD) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || "";
    const [, b64] = hdr.split(" ");
    const [, pass] = b64 ? Buffer.from(b64, "base64").toString().split(":") : [];
    if (pass === process.env.LEAGUE_PASSWORD) return next();
    res.set("WWW-Authenticate", 'Basic realm="Dogfight League"');
    return res.status(401).send("Authentication required.");
  });
}

/* ---------- data storage (uses a Railway Volume if mounted at /data) ---------- */
function resolveDataDir() {
  const want = process.env.DATA_DIR || "/data";
  try { fs.mkdirSync(want, { recursive: true }); fs.accessSync(want, fs.constants.W_OK); return want; }
  catch { const local = path.join(__dirname, "data"); fs.mkdirSync(local, { recursive: true }); return local; }
}
const DATA_DIR = resolveDataDir();
const DATA_FILE = path.join(DATA_DIR, "league.json");

const SEED = {
  settings: {
    leagueName: "Dogfight League", buyIn: 20, skinsBuyIn: 5, skinsType: "gross",
    purseMode: "top3", quotaCap: 36, seasonPoints: [100, 90, 80, 70, 65, 60, 55, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5], rollingWindow: 0, seasonStart: "2026-07-01", minMatches: 12, countBest: 12
  },
  players: [], rounds: []
};

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return JSON.parse(JSON.stringify(SEED)); }
}
function writeData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

/* ---------- data API ---------- */
app.get("/api/data", (req, res) => res.json(readData()));

app.put("/api/data", (req, res) => {
  if (!req.body || !Array.isArray(req.body.players)) return res.status(400).json({ error: "invalid payload" });
  try { writeData(req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ---------- GHIN live handicap sync ---------- */
// GHIN reports plus-handicaps like "+2.1" (better than scratch) -> treat as negative.
function parseIndex(hi) {
  if (hi == null) return null;
  const s = String(hi).trim();
  if (s === "" || /NH/i.test(s)) return null;          // NH = no handicap established
  if (s.startsWith("+")) return -parseFloat(s.slice(1));
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

async function runSync() {
  const username = process.env.GHIN_USERNAME, password = process.env.GHIN_PASSWORD;
  if (!username || !password) { const e = new Error("GHIN_USERNAME / GHIN_PASSWORD are not set in Railway variables."); e.code = "NO_CREDS"; throw e; }

  const data = readData();
  const client = new GhinClient({ username, password });
  const updated = [], errors = [];

  for (const p of data.players) {
    const ghin = p.ghin ? String(p.ghin).trim() : "";
    if (!ghin) continue;
    try {
      let hi = null;
      try { const h = await client.handicaps.getOne(ghin); hi = h?.handicap_index ?? h?.value ?? h?.hi_value ?? null; }
      catch { /* fall through to golfer lookup */ }
      if (hi == null) { const g = await client.golfers.getOne(ghin); hi = g?.handicap_index ?? g?.hi_value ?? null; }
      const idx = parseIndex(hi);
      if (idx == null) throw new Error("no index returned");
      p.handicap = idx;
      updated.push({ id: p.id, ghin, name: p.name, handicap: idx });
    } catch (e) {
      errors.push({ ghin, name: p.name, error: String(e.message || e) });
    }
  }
  writeData(data);
  return { updated, errors };
}

app.post("/api/sync", async (req, res) => {
  try { res.json(await runSync()); }
  catch (e) { res.status(e.code === "NO_CREDS" ? 400 : 500).json({ error: String(e.message || e) }); }
});

// Scheduled auto-sync: refresh handicaps on boot (every deploy) and on a cycle,
// so indices are current before each play day. Tune cadence with SYNC_INTERVAL_HOURS.
const SYNC_HOURS = Number(process.env.SYNC_INTERVAL_HOURS || 24);
function scheduleAutoSync() {
  if (!process.env.GHIN_USERNAME || !process.env.GHIN_PASSWORD) {
    console.log("[auto-sync] disabled (set GHIN_USERNAME/GHIN_PASSWORD to enable)"); return;
  }
  const run = () => runSync()
    .then(r => console.log(`[auto-sync] ${new Date().toISOString()} updated ${r.updated.length}, errors ${r.errors.length}`))
    .catch(e => console.log("[auto-sync] failed:", e.message));
  setTimeout(run, 30 * 1000);                       // shortly after boot
  setInterval(run, Math.max(1, SYNC_HOURS) * 3600 * 1000); // then on a cycle (default daily)
  console.log(`[auto-sync] enabled: on boot + every ${SYNC_HOURS}h`);
}
scheduleAutoSync();

/* ---------- GHIN golfer search (name -> ghin/index), used for roster setup ----------
   The ghin lib authenticates correctly but omits name params, so we reuse its token
   and call GHIN's golfer search directly with last_name/first_name/state. */
let _ghinClient = null;
async function ghinToken() {
  if (!_ghinClient) _ghinClient = new GhinClient({ username: process.env.GHIN_USERNAME, password: process.env.GHIN_PASSWORD });
  try { await _ghinClient.golfers.search({ last_name: "warmup" }); } catch (e) { /* triggers login */ }
  return _ghinClient.httpClient && _ghinClient.httpClient.accessToken;
}
app.get("/api/search", async (req, res) => {
  if (!process.env.GHIN_USERNAME || !process.env.GHIN_PASSWORD) return res.status(400).json({ error: "GHIN creds not set" });
  try {
    const token = await ghinToken();
    if (!token) return res.status(500).json({ error: "could not authenticate to GHIN" });
    const u = new URL("https://api2.ghin.com/api/v1/golfers.json");
    u.searchParams.set("source", "GHINcom");
    u.searchParams.set("from_ghin", "true");
    u.searchParams.set("per_page", "50");
    u.searchParams.set("page", "1");
    u.searchParams.set("status", "Active");
    u.searchParams.set("sorting_criteria", "full_name");
    u.searchParams.set("order", "asc");
    if (req.query.last)  u.searchParams.set("last_name", req.query.last);
    if (req.query.first) u.searchParams.set("first_name", req.query.first);
    if (req.query.state) u.searchParams.set("state", req.query.state);
    const gr = await fetch(u, { headers: { "Content-Type": "application/json", source: "GHINcom", Authorization: "Bearer " + token } });
    const j = await gr.json().catch(() => ({}));
    const golfers = (j.golfers || []).map(g => ({
      ghin: g.ghin, first: g.first_name, last: g.last_name,
      club: g.club_name, state: g.state, hi: (g.hi_value ?? g.handicap_index)
    }));
    res.json({ golfers, upstream: gr.status });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

/* ---------- serve the single-page app (no other static assets) ---------- */
const INDEX = path.join(__dirname, "index.html");
app.get("*", (req, res) => res.sendFile(INDEX));

app.listen(PORT, () => {
  console.log(`Dogfight League running on :${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`GHIN sync: ${process.env.GHIN_USERNAME ? "configured" : "NOT configured (set GHIN_USERNAME/GHIN_PASSWORD)"}`);
});
