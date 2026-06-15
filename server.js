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
    purseMode: "top3", quotaCap: 36, seasonPoints: [10, 8, 6, 5, 4, 3, 2, 1], rollingWindow: 0
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

app.post("/api/sync", async (req, res) => {
  const username = process.env.GHIN_USERNAME, password = process.env.GHIN_PASSWORD;
  if (!username || !password)
    return res.status(400).json({ error: "GHIN_USERNAME / GHIN_PASSWORD are not set in Railway variables." });

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
  try { writeData(data); } catch (e) { return res.status(500).json({ error: "saved sync but failed to persist: " + e.message }); }
  res.json({ updated, errors });
});

/* ---------- serve the single-page app (no other static assets) ---------- */
const INDEX = path.join(__dirname, "index.html");
app.get("*", (req, res) => res.sendFile(INDEX));

app.listen(PORT, () => {
  console.log(`Dogfight League running on :${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`GHIN sync: ${process.env.GHIN_USERNAME ? "configured" : "NOT configured (set GHIN_USERNAME/GHIN_PASSWORD)"}`);
});
