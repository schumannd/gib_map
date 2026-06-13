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

## Deploying to PythonAnywhere

These steps assume a PythonAnywhere **Web** + **Tasks** setup on a paid plan (scheduled tasks require at least a Hacker plan; check current PythonAnywhere limits).

### 1. Upload the project

In a Bash console on PythonAnywhere:

```bash
cd ~
git clone https://github.com/YOUR_USER/gib_map.git
cd gib_map
python3.10 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Or upload the files via the **Files** tab into `/home/YOUR_USERNAME/gib_map`.

### 2. Run the crawler once manually

```bash
cd ~/gib_map
source .venv/bin/activate
python crawl_gib.py
```

This creates `days.js` and dated `YYYY-MM-DD.json` files. Re-run after interruptions — progress is saved in `crawl_state.json`.

Optional: increase the throttle wait if you hit rate limits often:

```bash
export GIB_THROTTLE_WAIT_MINUTES=10
python crawl_gib.py
```

### 3. Serve the map as a static site

1. Open the **Web** tab → **Add a new web app** → **Manual configuration** → choose your Python version.
2. Under **Static files**, add:

| URL | Directory |
|-----|-----------|
| `/` | `/home/YOUR_USERNAME/gib_map/` |

3. Set **Website home directory** / ensure `index.html` is served from that folder.
4. Reload the web app.

Your map will be available at `https://YOUR_USERNAME.pythonanywhere.com/`.

### 4. Schedule daily crawls

1. Open the **Tasks** tab.
2. Create a **Scheduled task** (daily), e.g. `06:00` UTC:

```bash
cd /home/YOUR_USERNAME/gib_map && .venv/bin/python crawl_gib.py >> /home/YOUR_USERNAME/gib_map/crawl.log 2>&1
```

3. After the task runs, reload the web app if needed (usually not required for static files).

### 5. Google Maps API key

The map uses the Google Maps JavaScript API. Replace the key in `index.html` with your own, and restrict it to your domain in the [Google Cloud Console](https://console.cloud.google.com/).

## Generated files

| File | Purpose |
|------|---------|
| `days.js` | Frontend data for all crawled days |
| `YYYY-MM-DD.json` | Raw data per day |
| `crawl_state.json` | Resume checkpoint (temporary) |
| `cache.pickle` | Geocoding cache |

## Troubleshooting

- **Empty map** — run `python crawl_gib.py` and confirm `days.js` exists.
- **Crawler stops mid-run** — run it again; it resumes from `crawl_state.json`.
- **Cloudflare / throttling** — the crawler waits and retries; increase `GIB_THROTTLE_WAIT_MINUTES` if needed.
- **Geocoding errors** — check `crawl.log`; Nominatim may rate-limit heavy usage.
