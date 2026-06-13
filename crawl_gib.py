from bs4 import BeautifulSoup
from curl_cffi import requests as http
from geopy.geocoders import Nominatim
from datetime import date, timedelta
import json
import time
import os
import _pickle as pickle

geolocator = Nominatim(user_agent='gib_map_crawler')

BASE_URL = 'https://www.gratis-in-berlin.de'
JSON_PATH = os.path.dirname(os.path.abspath(__file__)) + os.sep
CACHE_FILE = 'cache.pickle'

CACHE = None


class CachedLocation(object):
    def __init__(self, latitude, longitude):
        self.latitude = latitude
        self.longitude = longitude


def fetch_url(url, retries=5):
    for attempt in range(retries):
        try:
            response = http.get(url, impersonate='chrome120', timeout=30)
        except http.errors.RequestsError:
            time.sleep(3 * (attempt + 1))
            continue

        if not is_cloudflare_challenge(response.text):
            return response.text

        time.sleep(3 * (attempt + 1))

    raise RuntimeError('Failed to fetch {0}'.format(url))


def is_cloudflare_challenge(html):
    soup = BeautifulSoup(html, 'html.parser')
    title = soup.title.text.lower() if soup.title else ''
    return 'moment' in title or len(html) < 20000


def main():
    abspath = os.path.abspath(__file__)
    dname = os.path.dirname(abspath)

    os.chdir(dname)
    remove_yesterday()
    update_next_days(3)


def remove_yesterday():
    while True:
        try:
            file_to_remove = (date.today() - timedelta(days=1)).strftime('%Y-%m-%d') + '.json'
            os.remove(JSON_PATH + file_to_remove)
        except:
            break


def update_next_days(days):
    today = date.today()
    file_names = ['heute', 'morgen', 'uebermorgen'];
    for day in range(days):
        json_data = get_and_save_data_for_date(today + timedelta(days=day))

        # New save as js file.
        js_file_content = "var {0} = {1};".format(file_names[day], json.dumps(json_data))
        with open(JSON_PATH + file_names[day] + '.js', 'w') as f:
            f.write(js_file_content);


def get_and_save_data_for_date(date):
    date_str = date.strftime('%Y-%m-%d')
    html_doc = fetch_url(BASE_URL + '/kalender/tagestipps/' + date_str)
    soup = BeautifulSoup(html_doc, 'html.parser')
    tipps = soup.find(id='tipps-overview')
    final_json = {}

    if not tipps:
        raise RuntimeError('Could not find tipps-overview for {0}'.format(date_str))

    print(len(tipps.find_all('li')))
    taken_locations = {}

    for tip in tipps.find_all('li'):
        tip_url = tip.find('a').attrs['href']
        time.sleep(0.5)

        tip_html_doc = fetch_url(BASE_URL + tip_url)
        tip_soup = BeautifulSoup(tip_html_doc, 'html.parser')

        map_tipp = tip_soup.find('div', 'mapTipp')
        title_el = tip_soup.find('span', 'fc_item_title')
        if not map_tipp or not title_el:
            continue

        address = ''.join(map_tipp.text.split(' - ')[:-1])
        # Lower, strip and remove duplicate spaces
        address = " ".join(address.strip().lower().split())
        print(address.encode('utf-8'))

        lat, lng = get_lat_lng(address)

        # Check if these coordinates are already used. If yes, use that address and append the object.

        tip_object = {
            'title': title_el.text.strip(),
            'url': BASE_URL + tip_url,
            'lat': lat,
            'lng': lng
        }

        if lat in taken_locations.keys():
            if lng in taken_locations[lat].keys():
                final_json[taken_locations[lat][lng]].append(tip_object)
                continue

        # If no, record them and create the adress with the object object
        taken_locations[lat] = taken_locations.get(lat, {})
        taken_locations[lat][lng] = address
        final_json[address] = [tip_object]
    json.dump(final_json, open(JSON_PATH + date_str + '.json','w'))
    return final_json


def get_lat_lng(address):
    
    location = None
    i = 0
    while not location:
        location = try_to_get_location(address, i)
        i += 1

    return location.latitude, location.longitude


def try_to_get_location(address, iteration):
    wrong_words_for_str = ['starße', 'strasße', 'strße', 'strsse', 'straß1']
    if any([word in address for word in wrong_words_for_str]):
        for wrong_str in wrong_words_for_str:
            address = address.replace(wrong_str, 'str')

    # Try several adress cleaning steps
    if iteration == 0:
        cleaned_address = address
    if iteration == 1:
        cleaned_address = address.replace('s-bahnbogen', '')
    if iteration == 2:
        cleaned_address = address.replace('haus', '')
    if iteration == 3:
        cleaned_address = address.split(',')[0]
    if iteration == 4:
        try:
            cleaned_address = address.split(',')[1]
        except:
            return None
    if iteration == 5:
        cleaned_address = address.replace('berlin', '', 1)
    if iteration > 5:
        cleaned_address = 'berlin'

    # Check our cache
    cached = try_get_cached(cleaned_address)
    if cached:
        return cached

    # If cache failed, query geopy API
    time.sleep(2)
    new_location = geolocator.geocode(cleaned_address)
    if new_location is None:
        return None
    cached_location = normalize_location(new_location)
    cache_save(address, cached_location)
    cache_save(cleaned_address, cached_location)
    return cached_location


def try_get_cached(key):
    cache = get_cache()
    if key in cache.keys():
        return tuple_to_location(cache[key])
    return None


def cache_save(key, value_obj):
    cache = get_cache()
    cache[key] = location_to_tuple(value_obj)
    with open(CACHE_FILE,'wb') as f:
        pickle.dump(cache,f)


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
