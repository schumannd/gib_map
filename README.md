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

**Expect 2–4 hours** for the first full 7-day crawl on GitHub Actions. Your log showing ~4 listings in the first 40 s is normal — that's mostly fetch time, not slowness.

**Later runs** are much faster: `cache.pickle` skips most geocoding, and many listings share addresses. Daily runs often finish in **30–60 minutes**, sometimes less.

The workflow timeout is 6 hours, which is enough even with Cloudflare retry waits.

## Deploying with GitHub Actions + GitHub Pages (recommended, free)

This runs the crawler on a schedule and hosts the map as a static site — no server required.

### 1. Push the repository to GitHub

If you haven't already:

```bash
git remote add origin git@github.com:YOUR_USER/gib_map.git
git push -u origin master
```

The workflow file is already included at [`.github/workflows/crawl.yml`](.github/workflows/crawl.yml).

### 2. Enable GitHub Pages

1. Open your repo on GitHub → **Settings** → **Pages**
2. Under **Build and deployment** → **Source**, choose **Deploy from a branch**
3. Branch: **master** (or **main**), folder: **/ (root)**
4. Save

After a minute or two the map will be live at:

`https://YOUR_USER.github.io/gib_map/`

### 3. Enable the scheduled crawler

GitHub Actions runs automatically from the workflow:

- **Daily** at 05:00 UTC (`cron: '0 5 * * *'`)
- On **manual trigger**: repo → **Actions** → **Crawl and update map data** → **Run workflow**

Each successful run commits updated `days.js` and `cache.pickle`. Pages picks up the new data on the next deploy (usually within a minute).

**First run:** trigger the workflow manually and let it run — see [How long does a crawl take?](#how-long-does-a-crawl-take) above. Watch the log for lines like `[42/125]` to track progress within each day.

### 4. Google Maps API key

The map uses the Google Maps JavaScript API. In [Google Cloud Console](https://console.cloud.google.com/):

1. Create or use an API key with **Maps JavaScript API** enabled
2. Replace the key in `index.html`
3. Restrict the key to your Pages URL, e.g. `https://YOUR_USER.github.io/*`

### 5. Workflow details

The workflow (`.github/workflows/crawl.yml`):

| Setting | Value |
|---------|-------|
| Runner | `ubuntu-latest` |
| Timeout | 6 hours (enough for a full 7-day crawl) |
| Throttle wait | 10 minutes (`GIB_THROTTLE_WAIT_MINUTES`) |
| Committed files | `days.js`, `cache.pickle` |

To change the schedule, edit the `cron` line in the workflow file. [Cron syntax helper](https://crontab.guru/).

**Private repos:** GitHub Actions minutes count against your quota. Public repos get free unlimited minutes for standard runners.

## Generated files

| File | Purpose |
|------|---------|
| `days.js` | Frontend data for all crawled days (committed by Actions) |
| `YYYY-MM-DD.json` | Raw data per day (local only, gitignored) |
| `crawl_state.json` | Resume checkpoint (temporary, gitignored) |
| `cache.pickle` | Geocoding cache (committed by Actions) |

## Troubleshooting

- **Empty map** — run the **Crawl and update map data** workflow manually and confirm `days.js` was committed.
- **Crawler stops mid-run** — re-run the workflow; it resumes from `crawl_state.json` within the same job. If the job timed out, just trigger it again.
- **Workflow failed** — open **Actions** → failed run → read logs. Common causes: Cloudflare throttling (increase `GIB_THROTTLE_WAIT_MINUTES` in the workflow), Nominatim rate limits.
- **Pages shows old data** — check that the crawl workflow committed to the same branch Pages deploys from.
- **Map loads but no markers** — Google Maps API key may not allow your `github.io` domain.

## Alternatives

- **Local cron + GitHub Pages** — run `python crawl_gib.py` on your machine on a schedule, commit and push `days.js` yourself.
- **PythonAnywhere** — paid plans can run the crawler, but free accounts block outbound access to `gratis-in-berlin.de` (proxy 403).
