from bs4 import BeautifulSoup
from curl_cffi import requests as http
from geopy.geocoders import Nominatim
from datetime import date, timedelta
import json
import time
import os
import _pickle as pickle
import requests as std_requests

geolocator = Nominatim(user_agent='gib_map_crawler')

BASE_URL = 'https://www.gratis-in-berlin.de'
JSON_PATH = os.path.dirname(os.path.abspath(__file__)) + os.sep
CACHE_FILE = 'cache.pickle'
STATE_FILE = 'crawl_state.json'
DAYS_JS_FILE = 'days.js'

CRAWL_DAYS = 7
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

    log('Starting crawler (output unbuffered for CI logs).')
    log('Crawl settings: {0} days, backends={1}, throttle_wait={2} min'.format(
        CRAWL_DAYS, ','.join(FETCH_BACKENDS), THROTTLE_WAIT_MINUTES))

    remove_yesterday()
    crawl_days(CRAWL_DAYS)


def remove_yesterday():
    while True:
        try:
            file_to_remove = (date.today() - timedelta(days=1)).strftime('%Y-%m-%d') + '.json'
            os.remove(JSON_PATH + file_to_remove)
        except OSError:
            break


def crawl_days(days):
    state = load_state()
    start_day = state.get('day_offset', 0)
    today = date.today()

    for day_offset in range(start_day, days):
        target_date = today + timedelta(days=day_offset)
        resume_tip_index = state.get('tip_index', 0) if day_offset == start_day else 0
        partial_data = state.get('partial_data', {}) if day_offset == start_day else {}

        log('Crawling day {0}/{1}: {2}'.format(
            day_offset + 1, days, target_date.strftime('%Y-%m-%d')))

        day_data = get_and_save_data_for_date(
            target_date,
            start_tip_index=resume_tip_index,
            partial_data=partial_data,
        )

        save_state({
            'day_offset': day_offset + 1,
            'tip_index': 0,
            'partial_data': {},
        })
        write_days_js(days)

    clear_state()
    write_days_js(days)
    log('Crawl complete.')


def load_state():
    if not os.path.exists(STATE_FILE):
        return {}

    with open(STATE_FILE, 'r') as f:
        state = json.load(f)

    if state:
        log('Resuming from day {0}, tip {1}'.format(
            state.get('day_offset', 0) + 1,
            state.get('tip_index', 0) + 1,
        ))

    return state


def save_state(state):
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
        json_path = JSON_PATH + date_str + '.json'

        if not os.path.exists(json_path):
            continue

        with open(json_path, 'r') as f:
            data = json.load(f)

        days_array.append({
            'date': date_str,
            'label': day_label(day_offset, target_date),
            'data': data,
        })

    js_content = 'var days = {0};'.format(json.dumps(days_array))
    with open(JSON_PATH + DAYS_JS_FILE, 'w') as f:
        f.write(js_content)


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

        tip_object = {
            'title': title_el.text.strip(),
            'url': BASE_URL + tip_url,
            'lat': lat,
            'lng': lng,
        }

        if lat in taken_locations and lng in taken_locations[lat]:
            final_json[taken_locations[lat][lng]].append(tip_object)
        else:
            taken_locations.setdefault(lat, {})
            taken_locations[lat][lng] = address
            final_json.setdefault(address, []).append(tip_object)

        with open(JSON_PATH + date_str + '.json', 'w') as f:
            json.dump(final_json, f)

        save_state({
            'day_offset': (target_date - date.today()).days,
            'tip_index': tip_index + 1,
            'partial_data': final_json,
        })

    return final_json


def rebuild_taken_locations(final_json):
    taken_locations = {}
    for address, tip_list in final_json.items():
        if not tip_list:
            continue
        lat = tip_list[0]['lat']
        lng = tip_list[0]['lng']
        taken_locations.setdefault(lat, {})
        taken_locations[lat][lng] = address
    return taken_locations


def get_lat_lng(address):
    location = None
    iteration = 0
    while not location:
        location = try_to_get_location(address, iteration)
        iteration += 1
    return location.latitude, location.longitude


def try_to_get_location(address, iteration):
    wrong_words_for_str = ['starße', 'strasße', 'strße', 'strsse', 'straß1']
    if any(word in address for word in wrong_words_for_str):
        for wrong_str in wrong_words_for_str:
            address = address.replace(wrong_str, 'str')

    if iteration == 0:
        cleaned_address = address
    elif iteration == 1:
        cleaned_address = address.replace('s-bahnbogen', '')
    elif iteration == 2:
        cleaned_address = address.replace('haus', '')
    elif iteration == 3:
        cleaned_address = address.split(',')[0]
    elif iteration == 4:
        try:
            cleaned_address = address.split(',')[1]
        except IndexError:
            return None
    elif iteration == 5:
        cleaned_address = address.replace('berlin', '', 1)
    else:
        cleaned_address = 'berlin'

    cached = try_get_cached(cleaned_address)
    if cached:
        return cached

    while True:
        time.sleep(GEOCODE_DELAY_SECONDS)
        try:
            new_location = geolocator.geocode(cleaned_address)
        except Exception as err:
            log('Geocoder error: {0}'.format(err))
            wait_for_throttle(cleaned_address)
            continue

        if new_location is None:
            return None

        cached_location = normalize_location(new_location)
        cache_save(address, cached_location)
        cache_save(cleaned_address, cached_location)
        return cached_location


def try_get_cached(key):
    cache = get_cache()
    if key in cache:
        return tuple_to_location(cache[key])
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
