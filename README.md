# gib_map

Interactive map of free events in Berlin, powered by data from [gratis-in-berlin.de](https://www.gratis-in-berlin.de).

The Python crawler fetches event listings, geocodes locations, and writes `days.js` for the static frontend.

## Local development

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python crawl_gib.py
python -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000).

The map UI includes an optional **“Ab Uhrzeit”** filter (disabled by default). When enabled, it hides events that start before the selected time (default: 2 hours ago). Events without a parsed start time stay visible. The filter appears only after crawl data includes `startTime` (`daysMeta.schemaVersion` ≥ 2).

The crawler:
- fetches **7 days** of listings (today through today+6)
- **resumes** automatically if interrupted (`data/crawl_state.json` + per-day JSON in `data/`)
- **waits and retries** when throttled (default: 5 minutes; override with `GIB_THROTTLE_WAIT_MINUTES`)

If the crawl stops midway, run `python crawl_gib.py` again — it continues where it left off.

### How long does a crawl take?

Rough math for a **first run** (empty geocoding cache):

| Step | Per listing | × ~875 listings (7 × ~125/day) |
|------|-------------|-------------------------------|
| Detail page fetch | ~1–2 s | ~15–30 min |
| Request delay | 0.5 s | ~7 min |
| Geocoding (cache miss) | 2 s | ~30 min (fewer if addresses repeat) |

**Expect 2–4 hours** for the first full 7-day crawl on GitHub Actions.

**Later runs** are much faster: the geocoding cache skips most lookups. Daily runs often finish in **30–60 minutes** when only the new day is crawled (older days are restored from the Actions cache and reconciled against the deployed `days.js`).

The workflow timeout is 6 hours.

## Deploying with GitHub Actions + GitHub Pages (recommended, free)

**`main`** holds source code only. **`gh-pages`** holds the live site (HTML + generated `days.js`). Crawl data is **not** committed to `main`.

### 1. Push the repository to GitHub

```bash
git push -u origin main
```

The workflow is at [`.github/workflows/crawl.yml`](.github/workflows/crawl.yml).

### 2. Enable GitHub Pages

1. Repo → **Settings** → **Pages**
2. **Source:** Deploy from a branch
3. Branch: **`gh-pages`** / **/ (root)**
4. Save

The map will be at `https://YOUR_USER.github.io/gib_map/` after the first deploy.

> If Pages was previously set to **`main`**, change it to **`gh-pages`**.

### 3. First deploy (get the site online immediately)

The **`gh-pages`** branch is already published with recovered crawl data (~230 KB `days.js` from commit `0a8acf3`).

1. **Settings** → **Pages** → source: **Deploy from a branch** → branch **`gh-pages`** / **`/ (root)`**
2. Site URL: `https://schumannd.github.io/gib_map/`

To redeploy after UI changes on **`main`**, run **Actions** → **Deploy to GitHub Pages** → **Run workflow**. It uses `days.js` from **`gh-pages`** (or recovers from `0a8acf3` in git history if missing).

Pushing changes to `index.html`, `main.js`, or `base.css` on **`main`** also triggers this deploy automatically. After a successful deploy, if no crawl is already running, the **Crawl and deploy map** workflow is dispatched so schema or UI changes that need fresh data get picked up without a manual run.

### 4. Run the crawler (daily updates)

**Actions** → **Crawl and deploy map** → **Run workflow**

- Runs **automatically every day at 05:00 UTC** (see `cron` in [`.github/workflows/crawl.yml`](.github/workflows/crawl.yml))
- Crawls, then deploys static files to **`gh-pages`**
- Geocoding cache and per-day JSON persist via GitHub Actions cache (not in git)
- The workflow **always saves** cache after each run (GitHub's default cache action skips updates on cache hits)
- Before crawling, it **bootstraps `data/` from `gh-pages` `days.js`** when day files are missing
- Pushes to **`main`** that change `index.html`, `main.js`, or `base.css` auto-deploy UI to **`gh-pages`** via [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml), keeping existing `days.js`

#### Daily incremental crawl

Each run covers a rolling **7-day window** (today through today+6). On a normal daily re-run:

1. **Stale day files drop out** — yesterday's "today" JSON is deleted
2. **Six existing days are skipped** — JSON already on disk from the Actions cache
3. **Only the new 7th day is crawled** (~125 listings, ~30–45 min)

If the cache is cold or the window shifted completely, more days may be recrawled. Interrupted runs resume via `data/crawl_state.json`.

The workflow writes a **crawl summary** (events/locations per day) to the Actions job summary. `days.js` includes a `daysMeta.generatedAt` timestamp shown in the UI.

### 5. Google Maps API key

The **"Oops! Something went wrong"** error means the API key does not allow your Pages URL.

In [Google Cloud Console](https://console.cloud.google.com/):

1. Enable **Maps JavaScript API** (billing account required; see note below)
2. API key → **HTTP referrers** → add `https://YOUR_USER.github.io/*`
3. For local dev: `http://localhost/*`
4. Put the key in `index.html` on **`main`**, then run **Deploy to GitHub Pages** (or push to `main`)

Google requires a billing account but gives ~$200/month free Maps credit — this site typically costs **$0**.

### 6. Visitor tracking

Page views are counted by [GoatCounter](https://www.goatcounter.com) via the script tag in `index.html`. Day-tab switches are recorded as events in `main.js`. Dashboard: `https://schumannd.goatcounter.com`

### 7. Workflow details

| Setting | Value |
|---------|-------|
| Deploy target | `gh-pages` branch (not `main`) |
| Geocoding cache | GitHub Actions cache (`cache.pickle`) |
| Crawl progress | GitHub Actions cache (`data/` directory) |
| Timeout | 6 hours |

## Generated files (not on `main`)

| File | Purpose |
|------|---------|
| `days.js` | Frontend data (deployed to `gh-pages` only; includes `daysMeta`) |
| `data/YYYY-MM-DD.json` | Raw data per day (local / CI only) |
| `data/crawl_state.json` | Resume checkpoint (temporary) |
| `cache.pickle` | Geocoding cache (Actions cache only) |

Event data schema is versioned via `daysMeta.schemaVersion` (currently **2**, includes optional `startTime` per event). Older cached crawl files are treated as incomplete and recrawled automatically.

## Troubleshooting

- **No `gh-pages` branch** — run **Deploy to GitHub Pages** once (see step 3 above).
- **Empty map** — confirm Pages uses **`gh-pages`**, not **`main`**.
- **Recover crawl data locally**:
  ```bash
  git fetch origin gh-pages
  git show origin/gh-pages:days.js > days.js
  ```
  Or from git history: `git show 0a8acf3:days.js > days.js`
- **Only 3 events** — old deploy; re-run workflow after crawl completes
- **Map error** — fix API key referrers for `github.io` (see above)
- **Crawler stops mid-run** — re-run workflow; finished days are skipped via cached `data/` files and `data/crawl_state.json`

## Alternatives

- **Local cron** — crawl locally, manually copy files to any static host
- **PythonAnywhere** — paid plans only (free tier blocks the target site)
