from bs4 import BeautifulSoup
from curl_cffi import requests as http
from geopy.geocoders import Nominatim
from datetime import date, timedelta, datetime, timezone
import json
import re
import time
import os
import _pickle as pickle
import requests as std_requests

geolocator = Nominatim(user_agent='gib_map_crawler')

BASE_URL = 'https://www.gratis-in-berlin.de'
ROOT_PATH = os.path.dirname(os.path.abspath(__file__)) + os.sep
DATA_DIR = os.path.join(ROOT_PATH, 'data')
CACHE_FILE = os.path.join(ROOT_PATH, 'cache.pickle')
STATE_FILE = os.path.join(DATA_DIR, 'crawl_state.json')
DAYS_JS_FILE = os.path.join(ROOT_PATH, 'days.js')

BERLIN_CENTER_LAT = 52.5170365
BERLIN_CENTER_LNG = 13.3888599
GERMANY_BOUNDS = {
    'min_lat': 47.27,
    'max_lat': 55.06,
    'min_lng': 5.87,
    'max_lng': 15.04,
}
STREET_WORD_PATTERN = (
    r'(?:str\.?|straße|strasse|weg|platz|allee|damm|ufer|pfad|gasse|ring|steig|hof|ufer)'
)

CRAWL_DAYS = 7
EVENT_SCHEMA_VERSION = 2
META_KEY = '_meta'
FETCH_RETRIES = 5
REQUEST_DELAY_SECONDS = 0.5
GEOCODE_DELAY_SECONDS = 2
THROTTLE_WAIT_MINUTES = int(os.environ.get('GIB_THROTTLE_WAIT_MINUTES', '5'))
FETCH_BACKENDS = [
    backend.strip()
    for backend in os.environ.get('GIB_FETCH_BACKEND', 'curl_cffi,curl_cffi_plain,requests').split(',')
    if backend.strip()
]

FETCH_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
}

WEEKDAYS_DE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

CACHE = None


def log(message):
    print(message, flush=True)


class CachedLocation(object):
    def __init__(self, latitude, longitude):
        self.latitude = latitude
        self.longitude = longitude


def main():
    abspath = os.path.abspath(__file__)
    dname = os.path.dirname(abspath)
    os.chdir(dname)
    ensure_data_dir()
    migrate_legacy_json_files()

    log('Starting crawler (output unbuffered for CI logs).')
    log('Crawl settings: {0} days, backends={1}, throttle_wait={2} min'.format(
        CRAWL_DAYS, ','.join(FETCH_BACKENDS), THROTTLE_WAIT_MINUTES))

    bootstrapped = bootstrap_data_from_days_js(CRAWL_DAYS)
    if bootstrapped:
        log('Bootstrapped {0} day file(s) from days.js'.format(bootstrapped))

    reconciled = reconcile_day_files_with_days_js(CRAWL_DAYS)
    if reconciled:
        log('Reconciled {0} day file(s) with days.js (schema v{1})'.format(
            reconciled, EVENT_SCHEMA_VERSION))

    clean_stale_day_files(CRAWL_DAYS)
    log_data_dir_status(CRAWL_DAYS)
    crawl_days(CRAWL_DAYS)


def ensure_data_dir():
    if not os.path.isdir(DATA_DIR):
        os.makedirs(DATA_DIR)


def day_json_path(target_date):
    date_str = target_date.strftime('%Y-%m-%d')
    return os.path.join(DATA_DIR, date_str + '.json')


def migrate_legacy_json_files():
    if not os.path.isdir(DATA_DIR):
        return

    for filename in os.listdir(ROOT_PATH):
        if not filename.endswith('.json') or len(filename) != 15:
            continue
        try:
            date.fromisoformat(filename.replace('.json', ''))
        except ValueError:
            continue

        legacy_path = os.path.join(ROOT_PATH, filename)
        target_path = os.path.join(DATA_DIR, filename)
        if not os.path.exists(target_path):
            os.rename(legacy_path, target_path)
            log('Moved legacy data file into data/: {0}'.format(filename))

    legacy_state = os.path.join(ROOT_PATH, 'crawl_state.json')
    if os.path.exists(legacy_state) and not os.path.exists(STATE_FILE):
        os.rename(legacy_state, STATE_FILE)
        log('Moved legacy crawl_state.json into data/')


def load_days_js():
    if not os.path.exists(DAYS_JS_FILE):
        return []

    with open(DAYS_JS_FILE, 'r') as f:
        content = f.read().strip()

    if not content.startswith('var days'):
        return []

    content = content.split('=', 1)[1].strip()
    if ';\nvar daysMeta' in content:
        content = content.split(';\nvar daysMeta', 1)[0].strip()
    content = content.rstrip(';')
    return json.loads(content)


def load_days_meta():
    if not os.path.exists(DAYS_JS_FILE):
        return {}

    with open(DAYS_JS_FILE, 'r') as f:
        content = f.read().strip()

    if ';\nvar daysMeta' not in content:
        return {}

    meta_part = content.split(';\nvar daysMeta', 1)[1].strip()
    meta_part = meta_part.split('=', 1)[1].strip().rstrip(';')
    return json.loads(meta_part)


def day_data_fingerprint(data):
    event_count = 0
    location_count = 0
    for _, tip_list in iter_day_data(data):
        location_count += 1
        event_count += len(tip_list)
    return event_count, location_count


def bootstrap_data_from_days_js(window_days):
    days_array = load_days_js()
    if not days_array:
        return 0

    days_meta = load_days_meta()
    stamp_schema = days_meta.get('schemaVersion', 0) >= EVENT_SCHEMA_VERSION

    today = date.today()
    keep_dates = {
        (today + timedelta(days=offset)).isoformat()
        for offset in range(window_days)
    }
    bootstrapped = 0

    for day in days_array:
        day_date = day.get('date')
        if day_date not in keep_dates:
            continue

        path = day_json_path(date.fromisoformat(day_date))
        if os.path.exists(path):
            continue

        data = json.loads(json.dumps(day.get('data', {})))
        if stamp_schema:
            stamp_day_schema(data)

        with open(path, 'w') as f:
            json.dump(data, f)
        log('Bootstrapped {0} from days.js ({1} locations)'.format(
            os.path.basename(path), len(day.get('data', {}))))
        bootstrapped += 1

    return bootstrapped


def reconcile_day_files_with_days_js(window_days):
    """Restore cached day files from the deployed days.js snapshot (no recrawl)."""
    days_meta = load_days_meta()
    if days_meta.get('schemaVersion', 0) < EVENT_SCHEMA_VERSION:
        return 0

    days_array = load_days_js()
    if not days_array:
        return 0

    days_by_date = {day['date']: day for day in days_array if day.get('date')}
    today = date.today()
    reconciled = 0

    for day_offset in range(window_days):
        target_date = today + timedelta(days=day_offset)
        date_str = target_date.isoformat()
        day_entry = days_by_date.get(date_str)
        if not day_entry:
            continue

        reference_data = day_entry.get('data', {})
        if not reference_data:
            continue

        path = day_json_path(target_date)
        if os.path.exists(path):
            try:
                with open(path, 'r') as f:
                    disk_data = json.load(f)
            except (json.JSONDecodeError, OSError):
                disk_data = {}
            if get_day_file_schema(disk_data) >= EVENT_SCHEMA_VERSION:
                continue

        hydrated = json.loads(json.dumps(reference_data))
        stamp_day_schema(hydrated)
        with open(path, 'w') as f:
            json.dump(hydrated, f)
        events, locations = day_data_fingerprint(hydrated)
        log('Reconciled {0} from days.js ({1} events, {2} locations)'.format(
            date_str, events, locations))
        reconciled += 1

    return reconciled


def get_day_file_incomplete_reason(target_date):
    path = day_json_path(target_date)
    if not os.path.exists(path):
        return 'missing file'

    try:
        with open(path, 'r') as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as err:
        return 'unreadable ({0})'.format(err)

    if not list(iter_day_data(data)):
        return 'no locations'

    if count_events_in_data(data) <= 0:
        return 'no events'

    schema = get_day_file_schema(data)
    if schema < EVENT_SCHEMA_VERSION:
        return 'schema v{0} (need v{1})'.format(schema, EVENT_SCHEMA_VERSION)

    return None


def is_day_file_complete(target_date):
    return get_day_file_incomplete_reason(target_date) is None


def log_data_dir_status(window_days):
    today = date.today()
    if not os.path.isdir(DATA_DIR):
        log('data/ directory is empty (no cache restored yet)')
        return

    on_disk = sorted(
        filename for filename in os.listdir(DATA_DIR)
        if filename.endswith('.json') and filename != 'crawl_state.json'
    )
    log('data/ contains {0} day file(s): {1}'.format(
        len(on_disk), ', '.join(on_disk) if on_disk else 'none'))

    for day_offset in range(window_days):
        target_date = today + timedelta(days=day_offset)
        date_str = target_date.strftime('%Y-%m-%d')
        if is_day_file_complete(target_date):
            path = day_json_path(target_date)
            with open(path, 'r') as f:
                data = json.load(f)
            log('  {0}: ready ({1} events, {2} locations)'.format(
                date_str, count_events_in_data(data), len(list(iter_day_data(data)))))
        else:
            reason = get_day_file_incomplete_reason(target_date) or 'unknown'
            log('  {0}: missing or incomplete ({1})'.format(date_str, reason))

    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r') as f:
            state = json.load(f)
        log('crawl_state.json: {0}'.format(state))
    else:
        log('crawl_state.json: none')


def clean_stale_day_files(days):
    today = date.today()
    keep_dates = {
        (today + timedelta(days=offset)).strftime('%Y-%m-%d')
        for offset in range(days)
    }

    if not os.path.isdir(DATA_DIR):
        return

    for filename in os.listdir(DATA_DIR):
        if not filename.endswith('.json') or filename == 'crawl_state.json':
            continue
        if filename.replace('.json', '') not in keep_dates:
            os.remove(os.path.join(DATA_DIR, filename))
            log('Removed stale data file {0}'.format(filename))


def crawl_days(days):
    today = date.today()
    state = load_state()
    start_day, state = resolve_start_day(state, days, today)

    if start_day >= days:
        log('All {0} days already on disk for {1} — regenerating days.js only'.format(
            days, today.isoformat()))
        write_days_js(days)
        clear_state()
        log('Crawl complete.')
        return

    if start_day > 0:
        log('Incremental crawl: skipping {0} finished day(s), crawling from day {1}/{2}'.format(
            start_day, start_day + 1, days))
    else:
        log('Full crawl window: {0} through {1}'.format(
            today.isoformat(), (today + timedelta(days=days - 1)).isoformat()))

    for day_offset in range(start_day, days):
        target_date = today + timedelta(days=day_offset)
        resume_tip_index = state.get('tip_index', 0) if day_offset == start_day else 0
        partial_data = state.get('partial_data', {}) if day_offset == start_day else {}

        if (resume_tip_index > 0 or partial_data) and is_day_file_complete(target_date):
            log('Day {0}/{1} already complete — ignoring stale resume state for {2}'.format(
                day_offset + 1, days, target_date.strftime('%Y-%m-%d')))
            resume_tip_index = 0
            partial_data = {}

        if resume_tip_index == 0 and not partial_data and is_day_file_complete(target_date):
            log('Day {0}/{1} already on disk, skipping: {2}'.format(
                day_offset + 1, days, target_date.strftime('%Y-%m-%d')))
            save_state({
                'crawl_start_date': today.isoformat(),
                'day_offset': day_offset + 1,
                'tip_index': 0,
                'partial_data': {},
            })
            write_days_js(days)
            continue

        log('Crawling day {0}/{1}: {2}'.format(
            day_offset + 1, days, target_date.strftime('%Y-%m-%d')))

        get_and_save_data_for_date(
            target_date,
            start_tip_index=resume_tip_index,
            partial_data=partial_data,
        )

        save_state({
            'crawl_start_date': today.isoformat(),
            'day_offset': day_offset + 1,
            'tip_index': 0,
            'partial_data': {},
        })
        write_days_js(days)

    clear_state()
    write_days_js(days)
    log('Crawl complete.')


def resolve_start_day(state, days, today):
    if state and state.get('crawl_start_date') != today.isoformat():
        log('Crawl state is from a previous run date — starting fresh')
        state = {}

    if state:
        start_day = state.get('day_offset', 0)
        if state.get('tip_index', 0) > 0 or state.get('partial_data'):
            target_date = today + timedelta(days=start_day)
            if is_day_file_complete(target_date):
                log('Resume state points at complete day {0} — skipping it'.format(
                    start_day + 1))
                start_day += 1
                state = {
                    'crawl_start_date': today.isoformat(),
                    'day_offset': start_day,
                    'tip_index': 0,
                    'partial_data': {},
                }
            else:
                log('Resuming interrupted day {0} at tip {1}'.format(
                    start_day + 1, state.get('tip_index', 0) + 1))
                return start_day, state

        for day_offset in range(start_day):
            target_date = today + timedelta(days=day_offset)
            if not is_day_file_complete(target_date):
                log('Missing data for day {0}, recrawling from there'.format(day_offset + 1))
                return day_offset, {}

        if start_day > 0:
            log('Resuming from day {0}/{1}'.format(start_day + 1, days))
        return start_day, state

    start_day = 0
    for day_offset in range(days):
        target_date = today + timedelta(days=day_offset)
        if is_day_file_complete(target_date):
            log('Found completed day {0}/{1} on disk: {2}'.format(
                day_offset + 1, days, target_date.strftime('%Y-%m-%d')))
            start_day = day_offset + 1
        else:
            break

    if start_day > 0:
        log('Skipping {0} already-finished day(s)'.format(start_day))

    return start_day, {}


def load_state():
    if not os.path.exists(STATE_FILE):
        return {}

    with open(STATE_FILE, 'r') as f:
        return json.load(f)


def save_state(state):
    ensure_data_dir()
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f)


def clear_state():
    if os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)


def day_label(day_offset, target_date):
    if day_offset == 0:
        return 'Heute'
    if day_offset == 1:
        return 'Morgen'
    weekday = WEEKDAYS_DE[target_date.weekday()]
    return '{0} {1}.'.format(weekday, target_date.strftime('%d.%m'))


def write_days_js(days):
    today = date.today()
    days_array = []

    for day_offset in range(days):
        target_date = today + timedelta(days=day_offset)
        date_str = target_date.strftime('%Y-%m-%d')
        json_path = day_json_path(target_date)

        if not os.path.exists(json_path):
            continue

        with open(json_path, 'r') as f:
            data = json.load(f)

        days_array.append({
            'date': date_str,
            'label': day_label(day_offset, target_date),
            'data': export_day_data(data),
        })

    days_meta = build_days_meta(days_array, days)
    js_content = 'var days = {0};\nvar daysMeta = {1};'.format(
        json.dumps(days_array, ensure_ascii=False),
        json.dumps(days_meta, ensure_ascii=False),
    )
    with open(DAYS_JS_FILE, 'w') as f:
        f.write(js_content)
    log('Wrote {0} ({1} day(s))'.format(DAYS_JS_FILE, len(days_array)))
    log_crawl_summary(days_array, days_meta)


def count_events_in_data(data):
    total = 0
    for key, tip_list in iter_day_data(data):
        total += len(tip_list)
    return total


def iter_day_data(data):
    for key, tip_list in data.items():
        if key == META_KEY:
            continue
        yield key, tip_list


def export_day_data(data):
    return {key: tip_list for key, tip_list in iter_day_data(data)}


def get_day_file_schema(data):
    meta = data.get(META_KEY)
    if isinstance(meta, dict):
        return meta.get('schema', 0)
    return 0


def parse_start_time_from_text(text):
    normalized = ' '.join(text.split())
    match = re.search(r'Anfangszeit:\s*(\d{1,2}):(\d{2})', normalized, re.I)
    if match:
        return '{0:02d}:{1}'.format(int(match.group(1)), match.group(2))
    match = re.search(r'\bab\s+(\d{1,2}):(\d{2})', normalized, re.I)
    if match:
        return '{0:02d}:{1}'.format(int(match.group(1)), match.group(2))
    match = re.search(r'(\d{1,2}):(\d{2})\s*Uhr', normalized)
    if match:
        return '{0:02d}:{1}'.format(int(match.group(1)), match.group(2))
    return None


def extract_event_start_time(tip_soup):
    map_tipp = tip_soup.find('div', 'mapTipp')
    date_el = None
    if map_tipp:
        date_el = map_tipp.find_next('div', 'dateTipp')
    if not date_el:
        date_el = tip_soup.find('span', 'field_date_from')
    if not date_el:
        return None
    return parse_start_time_from_text(date_el.get_text(' ', strip=True))


def stamp_day_schema(day_data):
    day_data[META_KEY] = {'schema': EVENT_SCHEMA_VERSION}
    return day_data


def build_days_meta(days_array, window_days):
    return {
        'generatedAt': datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'windowStart': date.today().isoformat(),
        'windowDays': window_days,
        'schemaVersion': EVENT_SCHEMA_VERSION,
        'days': [{
            'date': day['date'],
            'label': day['label'],
            'events': count_events_in_data(day['data']),
            'locations': len(list(iter_day_data(day['data']))),
        } for day in days_array],
    }


def log_crawl_summary(days_array, days_meta):
    if not days_array:
        log('Crawl summary: no days written')
        return

    log('Crawl summary:')
    total_events = 0
    total_locations = 0
    for day_info in days_meta['days']:
        total_events += day_info['events']
        total_locations += day_info['locations']
        log('  {0} ({1}): {2} events, {3} locations'.format(
            day_info['label'], day_info['date'], day_info['events'], day_info['locations']))
    log('  Total: {0} events, {1} locations across {2} days'.format(
        total_events, total_locations, len(days_array)))

    summary_path = os.environ.get('GITHUB_STEP_SUMMARY')
    if not summary_path:
        return

    lines = [
        '## Crawl summary',
        '',
        '| Day | Date | Events | Locations |',
        '| --- | --- | ---: | ---: |',
    ]
    for day_info in days_meta['days']:
        lines.append('| {0} | {1} | {2} | {3} |'.format(
            day_info['label'], day_info['date'], day_info['events'], day_info['locations']))
    lines.extend([
        '',
        '**Total:** {0} events, {1} locations ({2} days)'.format(
            total_events, total_locations, len(days_array)),
        '',
        'Generated at: `{0}`'.format(days_meta['generatedAt']),
    ])
    with open(summary_path, 'a') as summary_file:
        summary_file.write('\n'.join(lines) + '\n')


def fetch_url(url):
    log('Fetching {0}'.format(url))

    while True:
        throttled = False

        for attempt in range(FETCH_RETRIES):
            for backend in FETCH_BACKENDS:
                try:
                    html = fetch_with_backend(url, backend)
                except Exception as err:
                    if is_proxy_blocked_error(err):
                        raise proxy_blocked_error(url)
                    log('Request error ({0}/{1}, {2}): {3}'.format(
                        attempt + 1, FETCH_RETRIES, backend, err))
                    continue

                if not is_cloudflare_challenge(html):
                    return html

                log('Cloudflare challenge ({0}/{1}, {2})'.format(
                    attempt + 1, FETCH_RETRIES, backend))

            if attempt + 1 >= FETCH_RETRIES:
                throttled = True
                break
            time.sleep(3 * (attempt + 1))

        if not throttled:
            raise RuntimeError('Failed to fetch {0}'.format(url))

        wait_for_throttle(url)


def get_proxies():
    proxy = (
        os.environ.get('https_proxy') or os.environ.get('HTTPS_PROXY') or
        os.environ.get('http_proxy') or os.environ.get('HTTP_PROXY')
    )
    if proxy:
        return {'http': proxy, 'https': proxy}
    return None


def fetch_with_backend(url, backend):
    if backend == 'curl_cffi':
        return fetch_with_curl_cffi(url, impersonate='chrome120')
    if backend == 'curl_cffi_plain':
        return fetch_with_curl_cffi(url, impersonate=None)
    if backend == 'requests':
        return fetch_with_requests(url)
    raise ValueError('Unknown fetch backend: {0}'.format(backend))


def fetch_with_curl_cffi(url, impersonate='chrome120'):
    kwargs = {'timeout': 30, 'headers': FETCH_HEADERS}
    proxies = get_proxies()
    if proxies:
        kwargs['proxies'] = proxies
    if impersonate:
        kwargs['impersonate'] = impersonate
    response = http.get(url, **kwargs)
    return response.text


def fetch_with_requests(url):
    response = std_requests.get(
        url,
        headers=FETCH_HEADERS,
        proxies=get_proxies(),
        timeout=30,
    )
    response.raise_for_status()
    return response.text


def is_proxy_blocked_error(err):
    message = str(err)
    return (
        ('CONNECT tunnel failed' in message and '403' in message) or
        'Tunnel connection failed: 403' in message or
        '403 Forbidden' in message
    )


def proxy_blocked_error(url):
    host = BASE_URL.replace('https://', '').replace('http://', '')
    return RuntimeError(
        'Outbound access to {0} is blocked (HTTP proxy returned 403).\n\n'
        'On PythonAnywhere FREE accounts, only allowlisted sites are reachable — '
        '{1} is not on that list.\n\n'
        'Options:\n'
        '  1. Upgrade to a paid PythonAnywhere plan (unrestricted outbound access), '
        'then open a new Bash console and retry.\n'
        '  2. Run the crawler locally (or via GitHub Actions) and upload the generated '
        'days.js and YYYY-MM-DD.json files to PythonAnywhere.\n'
        '  3. On paid accounts, try: export GIB_FETCH_BACKEND=requests\n\n'
        'See https://help.pythonanywhere.com/pages/403ForbiddenError/\n'
        'Failed URL: {2}'.format(host, host, url)
    )


def wait_for_throttle(context):
    wait_seconds = THROTTLE_WAIT_MINUTES * 60
    log('Throttled on {0}. Waiting {1} minutes before retrying...'.format(
        context, THROTTLE_WAIT_MINUTES))
    time.sleep(wait_seconds)


def is_cloudflare_challenge(html):
    soup = BeautifulSoup(html, 'html.parser')
    title = soup.title.text.lower() if soup.title else ''
    return 'moment' in title or len(html) < 20000


def get_and_save_data_for_date(target_date, start_tip_index=0, partial_data=None):
    date_str = target_date.strftime('%Y-%m-%d')
    html_doc = fetch_url(BASE_URL + '/kalender/tagestipps/' + date_str)
    soup = BeautifulSoup(html_doc, 'html.parser')
    tipps = soup.find(id='tipps-overview')

    if not tipps:
        raise RuntimeError('Could not find tipps-overview for {0}'.format(date_str))

    tip_elements = tipps.find_all('li')
    log('{0} listings found'.format(len(tip_elements)))

    final_json = partial_data or {}
    taken_locations = rebuild_taken_locations(final_json)

    for tip_index, tip in enumerate(tip_elements):
        if tip_index < start_tip_index:
            continue

        tip_url = tip.find('a').attrs['href']
        time.sleep(REQUEST_DELAY_SECONDS)

        tip_html_doc = fetch_url(BASE_URL + tip_url)
        tip_soup = BeautifulSoup(tip_html_doc, 'html.parser')

        map_tipp = tip_soup.find('div', 'mapTipp')
        title_el = tip_soup.find('span', 'fc_item_title')
        if not map_tipp or not title_el:
            continue

        address = ''.join(map_tipp.text.split(' - ')[:-1])
        address = ' '.join(address.strip().lower().split())
        log('[{0}/{1}] {2}'.format(tip_index + 1, len(tip_elements), address))

        lat, lng = get_lat_lng(address)

        start_time = extract_event_start_time(tip_soup)
        tip_object = {
            'title': title_el.text.strip(),
            'url': BASE_URL + tip_url,
            'lat': lat,
            'lng': lng,
        }
        if start_time:
            tip_object['startTime'] = start_time

        if lat in taken_locations and lng in taken_locations[lat]:
            final_json[taken_locations[lat][lng]].append(tip_object)
        else:
            taken_locations.setdefault(lat, {})
            taken_locations[lat][lng] = address
            final_json.setdefault(address, []).append(tip_object)

        stamp_day_schema(final_json)

        with open(day_json_path(target_date), 'w') as f:
            json.dump(final_json, f)

        save_state({
            'crawl_start_date': date.today().isoformat(),
            'day_offset': (target_date - date.today()).days,
            'tip_index': tip_index + 1,
            'partial_data': final_json,
        })

    return final_json


def rebuild_taken_locations(final_json):
    taken_locations = {}
    for address, tip_list in iter_day_data(final_json):
        if not tip_list:
            continue
        lat = tip_list[0]['lat']
        lng = tip_list[0]['lng']
        taken_locations.setdefault(lat, {})
        taken_locations[lat][lng] = address
    return taken_locations


def get_lat_lng(address):
    for query in build_geocode_queries(address):
        location = geocode_query(query, address)
        if location:
            return location.latitude, location.longitude

    log('Could not geocode in Germany, using approximate Berlin center: {0}'.format(address))
    return BERLIN_CENTER_LAT, BERLIN_CENTER_LNG


def is_in_germany(lat, lng):
    return (
        GERMANY_BOUNDS['min_lat'] <= lat <= GERMANY_BOUNDS['max_lat'] and
        GERMANY_BOUNDS['min_lng'] <= lng <= GERMANY_BOUNDS['max_lng']
    )


def normalize_address(address):
    wrong_words_for_str = ['starße', 'strasße', 'strße', 'strsse', 'straß1']
    normalized = ' '.join(address.lower().split())
    for wrong_str in wrong_words_for_str:
        normalized = normalized.replace(wrong_str, 'str')
    return normalized


def extract_plz(address):
    match = re.search(r'\b(\d{5})\b', address)
    return match.group(1) if match else None


def build_geocode_queries(address):
    address = normalize_address(address)
    plz = extract_plz(address)
    queries = []

    if plz:
        queries.append('{0}, deutschland'.format(address))
        queries.append('{0}, berlin, deutschland'.format(address))

        for part in reversed([part.strip() for part in address.split(',') if part.strip()]):
            cleaned = re.sub(r'\b{0}\b'.format(plz), '', part).strip()
            cleaned = re.sub(r'\bberlin\b', '', cleaned).strip()
            cleaned = re.sub(r'\s+', ' ', cleaned)
            if len(cleaned) >= 4:
                queries.append('{0}, {1} berlin, deutschland'.format(cleaned, plz))

        street_match = re.search(
            r'([\wäöüß\.\-]+' + STREET_WORD_PATTERN + r'\.?\s*\d+)',
            address,
        )
        if street_match:
            queries.append('{0}, {1} berlin, deutschland'.format(
                street_match.group(1).strip(), plz))

        street_before_plz = re.search(
            r'([\wäöüß\.\-]+' + STREET_WORD_PATTERN + r'\.?\s*\d*)\s+' + plz,
            address,
        )
        if street_before_plz:
            queries.append('{0}, {1} berlin, deutschland'.format(
                street_before_plz.group(1).strip(), plz))

        queries.append('{0} berlin, deutschland'.format(plz))
    else:
        queries.append('{0}, berlin, deutschland'.format(address))
        queries.append('{0}, deutschland'.format(address))
        queries.append(address)

    unique_queries = []
    seen = set()
    for query in queries:
        query = re.sub(r'\s+', ' ', query).strip(' ,')
        if query and query not in seen:
            seen.add(query)
            unique_queries.append(query)
    return unique_queries


def geocode_query(query, original_address):
    cached = try_get_cached(query)
    if cached:
        return cached

    while True:
        time.sleep(GEOCODE_DELAY_SECONDS)
        try:
            new_location = geolocator.geocode(query, country_codes='de')
        except Exception as err:
            log('Geocoder error: {0}'.format(err))
            wait_for_throttle(query)
            continue

        if new_location is None:
            return None

        cached_location = normalize_location(new_location)
        if not is_in_germany(cached_location.latitude, cached_location.longitude):
            log('Rejected geocode outside Germany for {0!r}: {1}, {2}'.format(
                query, cached_location.latitude, cached_location.longitude))
            return None

        cache_save(query, cached_location)
        if query != original_address:
            cache_save(original_address, cached_location)
        return cached_location


def try_get_cached(key):
    cache = get_cache()
    if key not in cache:
        return None

    location = tuple_to_location(cache[key])
    if location and is_in_germany(location.latitude, location.longitude):
        return location

    log('Removing cached geocode outside Germany for {0!r}'.format(key))
    del cache[key]
    with open(CACHE_FILE, 'wb') as f:
        pickle.dump(cache, f)
    return None


def cache_save(key, value_obj):
    cache = get_cache()
    cache[key] = location_to_tuple(value_obj)
    with open(CACHE_FILE, 'wb') as f:
        pickle.dump(cache, f)


def location_to_tuple(location):
    normalized = normalize_location(location)
    if normalized is None:
        return None
    return (normalized.latitude, normalized.longitude)


def tuple_to_location(value):
    if value is None:
        return None
    if isinstance(value, CachedLocation):
        return value
    if isinstance(value, tuple):
        return CachedLocation(value[0], value[1])
    return normalize_location(value)


def normalize_location(location):
    if location is None:
        return None
    if isinstance(location, CachedLocation):
        return location
    if isinstance(location, tuple):
        return CachedLocation(location[0], location[1])

    latitude = getattr(location, 'latitude', None)
    longitude = getattr(location, 'longitude', None)
    if latitude is not None and longitude is not None:
        return CachedLocation(latitude, longitude)

    point = getattr(location, '_point', None)
    if isinstance(point, dict) and '_tuple' in point:
        latitude, longitude = point['_tuple'][1]
        return CachedLocation(latitude, longitude)
    if point is not None:
        latitude = getattr(point, 'latitude', None)
        longitude = getattr(point, 'longitude', None)
        if latitude is not None and longitude is not None:
            return CachedLocation(latitude, longitude)

    location_tuple = getattr(location, '_tuple', None)
    if location_tuple:
        latitude, longitude = location_tuple[1]
        return CachedLocation(latitude, longitude)

    raise ValueError('Could not normalize location: {0}'.format(location))


def get_cache():
    global CACHE
    if CACHE is not None:
        return CACHE

    if not os.path.exists(CACHE_FILE):
        CACHE = {}
        return CACHE

    try:
        with open(CACHE_FILE, 'rb') as f:
            CACHE = CacheUnpickler(f).load()
    except (ValueError, AttributeError, pickle.UnpicklingError):
        CACHE = load_legacy_cache()

    CACHE = {
        key: location_to_tuple(value)
        for key, value in CACHE.items()
        if value is not None
    }

    valid_cache = {}
    removed = 0
    for key, value in CACHE.items():
        lat, lng = value
        if is_in_germany(lat, lng):
            valid_cache[key] = value
        else:
            removed += 1

    if removed:
        log('Purged {0} cached geocode(s) outside Germany'.format(removed))
        with open(CACHE_FILE, 'wb') as f:
            pickle.dump(valid_cache, f)

    CACHE = valid_cache
    return CACHE


class CacheUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if name == 'CachedLocation':
            return CachedLocation
        return pickle.Unpickler.find_class(self, module, name)


def load_legacy_cache():
    class LegacyPoint(object):
        def __setstate__(self, state):
            if isinstance(state, dict):
                self.__dict__.update(state)
                return
            if len(state) == 2:
                self.latitude, self.longitude = state
            else:
                self.latitude, self.longitude, self.altitude = state

    class LegacyLocation(object):
        def __setstate__(self, state):
            if isinstance(state, dict):
                self.__dict__.update(state)
                return
            if len(state) == 2:
                self._address, self._point = state
                self._raw = None
            else:
                self._address, self._point, self._raw = state

    class LegacyCacheUnpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if name == 'CachedLocation':
                return CachedLocation
            if module == 'geopy.point' and name == 'Point':
                return LegacyPoint
            if module == 'geopy.location' and name == 'Location':
                return LegacyLocation
            return pickle.Unpickler.find_class(self, module, name)

    with open(CACHE_FILE, 'rb') as f:
        return LegacyCacheUnpickler(f).load()


if __name__ == '__main__':
    main()
