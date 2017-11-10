from bs4 import BeautifulSoup
import urllib.request
from geopy.geocoders import Nominatim
from datetime import date, timedelta
import json
import time
import os

import _pickle as pickle


geolocator = Nominatim()


BASE_URL = 'https://www.gratis-in-berlin.de'
JSON_PATH = '/var/www/html/gib_map/'
CACHE_FILE = 'cache.pickle'

CACHE = None

def main():
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
    for day in range(days):
        get_and_save_data_for_date(today + timedelta(days=day))


def get_and_save_data_for_date(date):
    date_str = date.strftime('%Y-%m-%d')
    html_doc = urllib.request.urlopen(BASE_URL + '/kalender/tagestipps/' + date_str)
    soup = BeautifulSoup(html_doc, 'html.parser')
    html_doc.close()
    tipps = soup.find(id='tipps-overview')
    final_json = {}

    print(len(tipps.find_all('li')))
    taken_locations = {}

    for tip in tipps.find_all('li'):
        tip_url = tip.find('a').attrs['href']

        tip_html_doc = urllib.request.urlopen(BASE_URL + tip_url)
        tip_soup = BeautifulSoup(tip_html_doc, 'html.parser')

        address = ''.join(tip_soup.find('div', 'mapTipp').text.split(' - ')[:-1])
        # Lower, strip and remove duplicate spaces
        address = " ".join(address.strip().lower().split())
        print(address)

        lat, lng = get_lat_lng(address)

        # Check if these coordinates are already used. If yes, use that address and append the object.

        tip_object = {
            'title': tip_soup.find('span', 'fc_item_title').text.strip(),
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
    cache_save(address, new_location)
    cache_save(cleaned_address, new_location)
    return new_location


def try_get_cached(key):
    cache = get_cache()
    if key in cache.keys():
        return cache[key]
    return None


def cache_save(key, value_obj):
    cache = get_cache()
    cache[key] = value_obj
    with open(CACHE_FILE,'wb') as f:
        pickle.dump(cache,f)


def get_cache():
    with open(CACHE_FILE, 'rb') as f:
        return pickle.load(f)

if __name__ == '__main__':
    main()
