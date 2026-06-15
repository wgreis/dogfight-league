# Dogfight League Tracker

A self-hosted golf dogfight league: quota points, weekly purse, skins, and season standings — with a one-click **live handicap sync from GHIN**. Built to run on [Railway](https://railway.app).

## What's in here

```
dogfight-league/
├── server.js            Express server: serves the app, stores data, syncs GHIN
├── package.json
├── railway.json         Railway build/deploy config
├── .env.example         the variables you'll set in Railway
├── .gitignore
└── index.html           the entire tracker UI (one file, no build step)
```

The whole league (players, rounds, scores, settings) is stored as a single JSON file on the server, so **everyone in the group sees the same data** — not just whoever's browser entered it.

---

## Deploy to Railway

### Option A — from GitHub (recommended)
1. Put this folder in a GitHub repo (e.g. create a repo, drop these files in, commit).
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo.
3. Railway auto-detects Node and runs `npm install` then `node server.js`.
4. Add the variables and volume below, then open the generated URL.

### Option B — from your machine with the Railway CLI
```bash
npm i -g @railway/cli
railway login
cd dogfight-league
railway init          # create/link a project
railway up            # deploy
```

### Required: environment variables
In Railway → your service → **Variables**, add (see `.env.example`):

| Variable          | Required | What it does |
|-------------------|----------|--------------|
| `GHIN_USERNAME`   | for sync | Your GHIN login (the email or GHIN number you use in the GHIN app) |
| `GHIN_PASSWORD`   | for sync | Your GHIN password |
| `LEAGUE_PASSWORD` | optional | If set, the whole site asks for this one shared password |
| `DATA_DIR`        | optional | Where data is stored. Defaults to `/data` |

> `PORT` is provided automatically by Railway — don't set it.

### Required for data to survive restarts: add a Volume
Railway containers have an ephemeral filesystem, so attach a volume or your league data resets on redeploy.

1. Railway → your service → **Variables/Settings → Volumes → New Volume**.
2. Set the **Mount path** to `/data`.
3. Redeploy. That's it — the app writes `league.json` there.

---

## Using it

1. Open your Railway URL. Go to **Settings → Load sample data** to see a full example, then **Erase everything** when you're ready for real.
2. On **Players**, add each guy with his **GHIN number** and a starting handicap.
3. Click **⟳ Sync from GHIN** — the server logs into GHIN, pulls each player's current Handicap Index, and updates quotas (`36 − handicap`) automatically.
4. After each round: **Rounds & Scores → New Round**, enter points (and hole-by-hole scores if you're running skins). Standings, purse, and skins calculate live.

### Keeping handicaps current
Hit **Sync from GHIN** before each round day. (You could also add a Railway cron service later to call `POST /api/sync` on a schedule — ask if you want that wired up.)

---

## A few honest notes on the GHIN sync

- GHIN has **no public/official API** for individuals. This uses the same endpoint the GHIN mobile app uses, via the community [`ghin`](https://www.npmjs.com/package/ghin) library. It works today but is **unofficial** and could change if GHIN changes their backend.
- Use your own GHIN credentials. They live only in your Railway variables (never in the code or the page).
- For a fully sanctioned long-term setup, the proper route is the USGA's **GPA (Golfer Product Access)** program — an application/approval process. Happy to help you apply if you want to go that way.

## Run locally (optional)
```bash
cd dogfight-league
npm install
GHIN_USERNAME=you GHIN_PASSWORD=secret npm start
# open http://localhost:3000
```

## Endpoints
- `GET /api/data` — current league JSON
- `PUT /api/data` — save league JSON
- `POST /api/sync` — refresh handicaps from GHIN (needs the two GHIN vars)
