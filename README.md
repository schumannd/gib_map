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

The crawler:
- fetches **7 days** of listings (today through today+6)
- **resumes** automatically if interrupted (`crawl_state.json`)
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

**Later runs** are much faster: the geocoding cache skips most lookups. Daily runs often finish in **30–60 minutes**.

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

Your full crawl data lives on the **`master`** branch (commit before we stopped committing data to git). Until a new crawl finishes, deploy from there:

1. **Actions** → **Deploy to GitHub Pages** → **Run workflow**

This creates the **`gh-pages`** branch and publishes the site with:
- `index.html` from **`main`** (your new API key)
- `days.js` from **`origin/master`** (last successful 7-day crawl)

Pushing changes to `index.html`, `main.js`, or `base.css` on **`main`** also triggers this deploy automatically.

### 4. Run the crawler (daily updates)

**Actions** → **Crawl and deploy map** → **Run workflow**

- Runs daily at 05:00 UTC
- Crawls, then deploys static files to **`gh-pages`**
- Geocoding cache persists via GitHub Actions cache (not in git)

### 5. Google Maps API key

The **"Oops! Something went wrong"** error means the API key does not allow your Pages URL.

In [Google Cloud Console](https://console.cloud.google.com/):

1. Enable **Maps JavaScript API** (billing account required; see note below)
2. API key → **HTTP referrers** → add `https://YOUR_USER.github.io/*`
3. For local dev: `http://localhost/*`
4. Put the key in `index.html` on **`main`**, then run **Deploy to GitHub Pages** (or push to `main`)

Google requires a billing account but gives ~$200/month free Maps credit — this site typically costs **$0**.

### 6. Workflow details

| Setting | Value |
|---------|-------|
| Deploy target | `gh-pages` branch (not `main`) |
| Geocoding cache | GitHub Actions cache (`cache.pickle`) |
| Timeout | 6 hours |

## Generated files (not on `main`)

| File | Purpose |
|------|---------|
| `days.js` | Frontend data (deployed to `gh-pages` only) |
| `YYYY-MM-DD.json` | Raw data per day (local / CI only) |
| `crawl_state.json` | Resume checkpoint (temporary) |
| `cache.pickle` | Geocoding cache (Actions cache only) |

## Troubleshooting

- **No `gh-pages` branch** — run **Deploy to GitHub Pages** once (see step 3 above).
- **Empty map** — confirm Pages uses **`gh-pages`**, not **`main`**.
- **Recover crawl data locally** — full 7-day data is on `origin/master`:
  ```bash
  git fetch origin
  git show origin/master:days.js > days.js
  ```
  (Commit `8ae7411` never reached GitHub — it only existed on the Actions runner.)
- **Commit step failed on `main`** — old workflow; data may be on **`origin/master`** instead.
- **Only 3 events** — old deploy; re-run workflow after crawl completes
- **Map error** — fix API key referrers for `github.io` (see above)
- **Crawler stops mid-run** — re-run workflow; resumes within the same job via `crawl_state.json`

## Alternatives

- **Local cron** — crawl locally, manually copy files to any static host
- **PythonAnywhere** — paid plans only (free tier blocks the target site)
