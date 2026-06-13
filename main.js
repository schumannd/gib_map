var BERLIN_CENTER_LAT = 52.5170365;
var BERLIN_CENTER_LNG = 13.3888599;
var REGION_CENTER = { lat: 52.46, lng: 13.20 };
var REGION_DEFAULT_ZOOM = 10;
var FAVORITES_KEY = 'gib_map_favorites';
var STALE_DATA_HOURS = 24;

var currentMap = null;
var currentDayIndex = 0;
var currentSearchQuery = '';
var selectedAddress = null;
var markerCluster = null;
var userLocationMarker = null;
var infoWindow = null;
var currentMarkers = [];
var addressToMarker = {};
var viewportShouldUpdate = true;
var EXPECTED_DAYS = 7;

window.onload = function() {
  buildDayPicker();
  updateLastUpdated();
  var dataStatus = evaluateDataStatus();

  if (dataStatus.type === 'missing') {
    showEmptyState(dataStatus.title, dataStatus.message);
    return;
  }

  showDataStatus(dataStatus);
  document.getElementById('empty-state').hidden = true;
  document.getElementById('content-area').hidden = false;

  var urlState = parseUrlState();
  if (urlState.q) {
    currentSearchQuery = urlState.q;
    document.getElementById('event-search').value = urlState.q;
    document.getElementById('clear-search').hidden = false;
  }

  var initialDay = urlState.day !== null && days[urlState.day] ? urlState.day : 0;
  loadDate(initialDay, { updateUrl: false });

  var datePicker = document.getElementById('date_picker');
  datePicker.addEventListener('click', function(event) {
    if (event.target.id === 'date_picker-handle') {
      document.body.classList.toggle('day-picker-open');
      return;
    }

    var button = event.target.closest('.day_div');
    if (button) {
      loadDate(parseInt(button.dataset.dayIndex, 10));
      if (window.matchMedia('(max-width: 720px)').matches) {
        document.body.classList.add('day-picker-open');
      }
    }
  });
  datePicker.addEventListener('keydown', handleDayPickerKeydown);

  var searchInput = document.getElementById('event-search');
  var clearSearchButton = document.getElementById('clear-search');
  searchInput.addEventListener('input', function() {
    currentSearchQuery = searchInput.value.trim().toLowerCase();
    clearSearchButton.hidden = !currentSearchQuery;
    viewportShouldUpdate = false;
    loadDate(currentDayIndex);
  });
  clearSearchButton.addEventListener('click', function() {
    searchInput.value = '';
    currentSearchQuery = '';
    clearSearchButton.hidden = true;
    viewportShouldUpdate = false;
    loadDate(currentDayIndex);
    searchInput.focus();
  });

  var headerToggle = document.getElementById('header-toggle');
  headerToggle.addEventListener('click', function() {
    var isOpen = document.body.classList.toggle('header-open');
    headerToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });

  document.getElementById('locate-me').addEventListener('click', locateUser);
  document.getElementById('list-toggle').addEventListener('click', function() {
    document.body.classList.toggle('list-open');
    var open = document.body.classList.contains('list-open');
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  window.addEventListener('popstate', function() {
    var state = parseUrlState();
    currentSearchQuery = state.q;
    document.getElementById('event-search').value = state.q;
    document.getElementById('clear-search').hidden = !state.q;
    if (state.day !== null && days[state.day]) {
      loadDate(state.day, { updateUrl: false });
    }
  });
};

function parseUrlState() {
  var params = new URLSearchParams(window.location.search);
  var day = params.has('day') ? parseInt(params.get('day'), 10) : null;
  if (isNaN(day)) {
    day = null;
  }
  return {
    day: day,
    q: (params.get('q') || '').trim().toLowerCase()
  };
}

function syncUrlState() {
  var params = new URLSearchParams();
  if (currentDayIndex > 0) {
    params.set('day', String(currentDayIndex));
  }
  if (currentSearchQuery) {
    params.set('q', currentSearchQuery);
  }
  var query = params.toString();
  var nextUrl = query ? '?' + query : window.location.pathname;
  history.replaceState(null, '', nextUrl);
}

function getFavorites() {
  try {
    var stored = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch (err) {
    return [];
  }
}

function isFavorite(url) {
  return getFavorites().indexOf(url) !== -1;
}

function toggleFavorite(url) {
  var favorites = getFavorites();
  var index = favorites.indexOf(url);
  if (index === -1) {
    favorites.push(url);
  } else {
    favorites.splice(index, 1);
  }
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  refreshCurrentView({ updateUrl: false });
}

function refreshCurrentView(options) {
  options = options || {};
  if (typeof days === 'undefined' || !days[currentDayIndex]) {
    return;
  }

  var day = days[currentDayIndex];
  var filteredData = filterLocationsByQuery(day.data, currentSearchQuery);
  viewportShouldUpdate = false;
  displayLocations(filteredData);

  if (options.updateUrl !== false) {
    syncUrlState();
  }
}

function getDataGeneratedAt() {
  if (typeof daysMeta !== 'undefined' && daysMeta.generatedAt) {
    return new Date(daysMeta.generatedAt);
  }
  if (typeof days !== 'undefined' && days.length) {
    return new Date(days[days.length - 1].date + 'T12:00:00');
  }
  return null;
}

function updateLastUpdated() {
  var el = document.getElementById('last-updated');
  if (!el) {
    return;
  }

  var generatedAt = getDataGeneratedAt();
  if (!generatedAt || isNaN(generatedAt.getTime())) {
    el.textContent = '';
    return;
  }

  el.textContent = 'Stand: ' + formatDateTime(generatedAt);
}

function formatDateTime(date) {
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function handleDayPickerKeydown(event) {
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.day_div'));
  if (!buttons.length) {
    return;
  }

  var currentIndex = buttons.findIndex(function(button) {
    return button.classList.contains('active');
  });
  if (currentIndex < 0) {
    currentIndex = 0;
  }

  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    loadDate(Math.min(currentIndex + 1, buttons.length - 1));
    buttons[Math.min(currentIndex + 1, buttons.length - 1)].focus();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault();
    loadDate(Math.max(currentIndex - 1, 0));
    buttons[Math.max(currentIndex - 1, 0)].focus();
  } else if (event.key === 'Home') {
    event.preventDefault();
    loadDate(0);
    buttons[0].focus();
  } else if (event.key === 'End') {
    event.preventDefault();
    loadDate(buttons.length - 1);
    buttons[buttons.length - 1].focus();
  }
}

function buildDayPicker() {
  var picker = document.getElementById('date_picker');
  var handle = document.getElementById('date_picker-handle');
  picker.innerHTML = '';
  if (handle) {
    picker.appendChild(handle);
  }

  if (typeof days === 'undefined' || !days.length) {
    return;
  }

  for (var i = 0; i < days.length; i++) {
    var day = days[i];
    var eventCount = countEvents(day.data);
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'day_div';
    button.dataset.dayIndex = i;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', i === currentDayIndex ? 'true' : 'false');
    button.setAttribute('aria-controls', 'map');
    button.id = 'day-tab-' + i;
    button.tabIndex = i === currentDayIndex ? 0 : -1;
    button.innerHTML =
      '<span class="day-label">' + escapeHtml(day.label) + '</span>' +
      '<span class="day-date">' + formatDate(day.date) + '</span>' +
      '<span class="day-count">' + eventCount + '</span>';
    picker.appendChild(button);
  }
}

function formatDate(isoDate) {
  var parts = isoDate.split('-');
  return parts[2] + '.' + parts[1] + '.';
}

function todayIsoDate() {
  var today = new Date();
  var month = String(today.getMonth() + 1).padStart(2, '0');
  var day = String(today.getDate()).padStart(2, '0');
  return today.getFullYear() + '-' + month + '-' + day;
}

function addDaysToIsoDate(isoDate, offset) {
  var parts = isoDate.split('-');
  var date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  date.setDate(date.getDate() + offset);
  var month = String(date.getMonth() + 1).padStart(2, '0');
  var day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + month + '-' + day;
}

function evaluateDataStatus() {
  if (typeof days === 'undefined' || !days.length) {
    return {
      type: 'missing',
      title: 'Noch keine Daten geladen.',
      message: 'Führe python crawl_gib.py aus, um Events zu laden.'
    };
  }

  var messages = [];
  var bannerClass = 'info';
  var today = todayIsoDate();
  var firstDate = days[0].date;
  var dayOffset = daysBetweenIsoDates(today, firstDate);

  if (dayOffset < 0) {
    messages.push('Daten sind veraltet: ältester Tag ist ' + formatDate(firstDate) + '.');
    bannerClass = 'warning';
  } else if (dayOffset > 0) {
    messages.push('Daten beginnen erst am ' + formatDate(firstDate) + '.');
  }

  if (days.length < EXPECTED_DAYS) {
    messages.push('Unvollständige Daten: ' + days.length + ' von ' + EXPECTED_DAYS + ' Tagen geladen.');
    bannerClass = 'warning';
  } else {
    var expectedLastDate = addDaysToIsoDate(today, EXPECTED_DAYS - 1);
    var lastDate = days[days.length - 1].date;
    if (lastDate !== expectedLastDate) {
      messages.push('Daten enden am ' + formatDate(lastDate) + ' statt ' + formatDate(expectedLastDate) + '.');
      bannerClass = 'warning';
    }
  }

  var generatedAt = getDataGeneratedAt();
  if (generatedAt && !isNaN(generatedAt.getTime())) {
    var ageHours = (Date.now() - generatedAt.getTime()) / 3600000;
    if (ageHours > STALE_DATA_HOURS) {
      messages.push('Datenstand älter als ' + STALE_DATA_HOURS + ' Stunden (' + formatDateTime(generatedAt) + ').');
      bannerClass = 'warning';
    }
  }

  if (!messages.length) {
    return { type: 'ok' };
  }

  return {
    type: 'partial',
    bannerClass: bannerClass,
    message: messages.join(' ')
  };
}

function daysBetweenIsoDates(startIso, endIso) {
  var start = new Date(startIso + 'T00:00:00');
  var end = new Date(endIso + 'T00:00:00');
  return Math.round((end - start) / 86400000);
}

function showEmptyState(title, message) {
  document.getElementById('empty-state-title').textContent = title;
  document.getElementById('empty-state-message').textContent = message;
  document.getElementById('empty-state').hidden = false;
  document.getElementById('content-area').hidden = true;
  document.getElementById('data-status').hidden = true;
}

function showDataStatus(status) {
  var banner = document.getElementById('data-status');
  if (!status.message) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.className = 'status-banner ' + (status.bannerClass || 'info');
  banner.textContent = status.message;
}

function countEvents(data) {
  var total = 0;
  for (var address in data) {
    if (data.hasOwnProperty(address)) {
      total += data[address].length;
    }
  }
  return total;
}

function countLocations(data) {
  var total = 0;
  for (var address in data) {
    if (data.hasOwnProperty(address)) {
      total += 1;
    }
  }
  return total;
}

function loadDate(dayIndex, options) {
  options = options || {};
  if (typeof days === 'undefined' || !days[dayIndex]) {
    return;
  }

  currentDayIndex = dayIndex;
  var day = days[dayIndex];
  selectedAddress = null;

  document.querySelectorAll('.day_div').forEach(function(button) {
    var isActive = parseInt(button.dataset.dayIndex, 10) === dayIndex;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    button.tabIndex = isActive ? 0 : -1;
  });

  document.getElementById('map').setAttribute('aria-labelledby', 'day-tab-' + dayIndex);
  document.getElementById('subtitle').textContent = day.label + ' · ' + formatDate(day.date);

  var filteredData = filterLocationsByQuery(day.data, currentSearchQuery);
  var filteredEvents = countEvents(filteredData);
  var totalEvents = countEvents(day.data);

  if (currentSearchQuery) {
    document.getElementById('event-count').textContent =
      filteredEvents + ' / ' + totalEvents + ' Events';
  } else {
    document.getElementById('event-count').textContent = totalEvents + ' Events';
  }
  document.getElementById('location-count').textContent = countLocations(filteredData) + ' Orte';

  displayLocations(filteredData);

  if (options.updateUrl !== false) {
    syncUrlState();
  }

  trackDayView(day);
}

function trackDayView(day) {
  if (!window.goatcounter || !window.goatcounter.count) {
    return;
  }

  window.goatcounter.count({
    path: window.location.pathname + '?day=' + currentDayIndex,
    title: day.label,
    event: true
  });
}

function filterLocationsByQuery(locations, query) {
  if (!query) {
    return locations;
  }

  var filtered = {};
  for (var address in locations) {
    if (!locations.hasOwnProperty(address)) {
      continue;
    }

    var matches = locations[address].filter(function(eventItem) {
      return eventItem.title.toLowerCase().indexOf(query) !== -1 ||
        address.indexOf(query) !== -1;
    });

    if (matches.length) {
      filtered[address] = matches;
    }
  }

  return filtered;
}

function clearUserLocation() {
  if (userLocationMarker) {
    userLocationMarker.setMap(null);
    userLocationMarker = null;
  }

  var locateButton = document.getElementById('locate-me');
  if (locateButton) {
    locateButton.classList.remove('active');
  }
}

function applyMapViewport(map) {
  if (!viewportShouldUpdate) {
    viewportShouldUpdate = true;
    return;
  }

  map.setCenter(REGION_CENTER);
  map.setZoom(REGION_DEFAULT_ZOOM);
}

function showMapError(message) {
  var errorEl = document.getElementById('map-error');
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function hideMapError() {
  document.getElementById('map-error').hidden = true;
}

function ensureMap() {
  if (currentMap) {
    hideMapError();
    return currentMap;
  }

  if (window.mapLoadError) {
    showMapError(window.mapLoadError);
    return null;
  }

  if (typeof google === 'undefined' || !google.maps || !google.maps.Map) {
    showMapError(
      'Google Maps konnte nicht geladen werden. ' +
      'Prüfe den API-Schlüssel in index.html und erlaube deine github.io-Domain.'
    );
    return null;
  }

  hideMapError();
  currentMap = new google.maps.Map(document.getElementById('map'), {
    zoom: REGION_DEFAULT_ZOOM,
    center: REGION_CENTER,
    mapTypeId: google.maps.MapTypeId.ROADMAP,
    fullscreenControl: true,
    streetViewControl: false,
    mapTypeControl: false
  });
  infoWindow = new google.maps.InfoWindow();
  return currentMap;
}

function clearMarkers() {
  currentMarkers.forEach(function(marker) {
    marker.setMap(null);
  });
  currentMarkers = [];
  addressToMarker = {};

  if (markerCluster) {
    markerCluster.clearMarkers();
    markerCluster = null;
  }
}

function buildInfoWindowContent(address, spots) {
  var contentHtml = '<div class="info-window" role="document">';
  contentHtml += '<button type="button" class="info-window-close" aria-label="Infofenster schließen">×</button>';
  contentHtml += '<strong>' + escapeHtml(address) + '</strong><ul>';
  for (var j = 0; j < spots.length; j++) {
    var favoriteClass = isFavorite(spots[j].url) ? ' favorite-active' : '';
    contentHtml += '<li><a href="' + escapeHtml(spots[j].url) + '" target="_blank" rel="noopener">' +
      escapeHtml(spots[j].title) + '</a>' +
      '<button type="button" class="favorite-btn' + favoriteClass + '" data-url="' +
      escapeHtml(spots[j].url) + '" aria-label="Favorit speichern">★</button></li>';
  }
  contentHtml += '</ul></div>';
  return contentHtml;
}

function openInfoWindow(marker, address, spots) {
  if (!infoWindow || !currentMap) {
    return;
  }

  infoWindow.setContent(buildInfoWindowContent(address, spots));
  infoWindow.open(currentMap, marker);

  google.maps.event.addListenerOnce(infoWindow, 'domready', function() {
    var closeButton = document.querySelector('.info-window-close');
    if (closeButton) {
      closeButton.focus();
      closeButton.addEventListener('click', function() {
        infoWindow.close();
      });
    }

    document.querySelectorAll('.info-window .favorite-btn').forEach(function(button) {
      button.addEventListener('click', function(event) {
        event.preventDefault();
        toggleFavorite(button.getAttribute('data-url'));
      });
    });
  });
}

function selectLocation(address, options) {
  options = options || {};
  selectedAddress = address;
  highlightListItem(address);

  var marker = addressToMarker[address];
  if (!marker || !currentMap) {
    return;
  }

  if (options.openInfo !== false) {
    var day = days[currentDayIndex];
    var filteredData = filterLocationsByQuery(day.data, currentSearchQuery);
    openInfoWindow(marker, address, filteredData[address]);
  }

  if (options.pan !== false) {
    currentMap.panTo(marker.getPosition());
    if (currentMap.getZoom() < 13) {
      currentMap.setZoom(13);
    }
  }
}

function highlightListItem(address) {
  document.querySelectorAll('.event-list-item').forEach(function(item) {
    item.classList.toggle('selected', item.dataset.address === address);
  });

  var selected = document.querySelector('.event-list-item.selected');
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function buildEventList(locations) {
  var list = document.getElementById('event-list');
  list.innerHTML = '';

  var entries = [];
  for (var address in locations) {
    if (!locations.hasOwnProperty(address)) {
      continue;
    }
    locations[address].forEach(function(eventItem) {
      entries.push({
        address: address,
        event: eventItem
      });
    });
  }

  entries.sort(function(a, b) {
    var favA = isFavorite(a.event.url) ? 0 : 1;
    var favB = isFavorite(b.event.url) ? 0 : 1;
    if (favA !== favB) {
      return favA - favB;
    }
    return a.event.title.localeCompare(b.event.title, 'de');
  });

  if (!entries.length) {
    list.innerHTML = '<p class="event-list-empty">Keine Events für diese Auswahl.</p>';
    return;
  }

  entries.forEach(function(entry) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'event-list-item';
    item.dataset.address = entry.address;
    if (entry.address === selectedAddress) {
      item.classList.add('selected');
    }

    var favoriteClass = isFavorite(entry.event.url) ? ' favorite-active' : '';
    item.innerHTML =
      '<span class="event-list-title">' + escapeHtml(entry.event.title) + '</span>' +
      '<span class="event-list-address">' + escapeHtml(entry.address) + '</span>' +
      '<span class="event-list-actions">' +
        '<span class="favorite-btn' + favoriteClass + '" data-url="' + escapeHtml(entry.event.url) +
        '" role="button" tabindex="0" aria-label="Favorit speichern">★</span>' +
      '</span>';

    item.addEventListener('click', function(event) {
      if (event.target.closest('.favorite-btn')) {
        event.stopPropagation();
        toggleFavorite(event.target.closest('.favorite-btn').getAttribute('data-url'));
        return;
      }
      selectLocation(entry.address);
    });

    list.appendChild(item);
  });
}

function displayLocations(locations) {
  var map = ensureMap();
  clearUserLocation();
  clearMarkers();

  if (!map) {
    buildEventList(locations);
    return;
  }

  Object.keys(locations).forEach(function(address) {
    var locationSpots = locations[address];
    var isApproximate =
      locationSpots[0].lat === BERLIN_CENTER_LAT &&
      locationSpots[0].lng === BERLIN_CENTER_LNG;

    var position = new google.maps.LatLng(locationSpots[0].lat, locationSpots[0].lng);

    var marker = new google.maps.Marker({
      position: position,
      title: locationSpots[0].title,
      icon: isApproximate
        ? 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png'
        : 'https://maps.google.com/mapfiles/ms/icons/red-dot.png'
    });
    currentMarkers.push(marker);
    addressToMarker[address] = marker;

    google.maps.event.addListener(marker, 'click', (function(markerRef, addressKey) {
      return function() {
        selectLocation(addressKey, { openInfo: true, pan: false });
      };
    })(marker, address));
  });

  if (currentMarkers.length && typeof markerClusterer !== 'undefined' && markerClusterer.MarkerClusterer) {
    markerCluster = new markerClusterer.MarkerClusterer({
      map: map,
      markers: currentMarkers
    });
  } else {
    currentMarkers.forEach(function(marker) {
      marker.setMap(map);
    });
  }

  applyMapViewport(map);
  buildEventList(locations);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function locateUser() {
  if (!navigator.geolocation) {
    window.alert('Geolocation wird von diesem Browser nicht unterstützt.');
    return;
  }

  var button = document.getElementById('locate-me');
  button.disabled = true;

  navigator.geolocation.getCurrentPosition(function(position) {
    button.disabled = false;
    button.classList.add('active');

    var userPosition = new google.maps.LatLng(
      position.coords.latitude,
      position.coords.longitude
    );

    if (!currentMap) {
      return;
    }

    currentMap.panTo(userPosition);
    currentMap.setZoom(Math.max(currentMap.getZoom(), 13));

    if (userLocationMarker) {
      userLocationMarker.setMap(null);
    }

    userLocationMarker = new google.maps.Marker({
      position: userPosition,
      map: currentMap,
      title: 'Meine Position',
      icon: 'https://maps.google.com/mapfiles/ms/icons/green-dot.png',
      zIndex: google.maps.Marker.MAX_ZINDEX + 1
    });

    highlightNearestEvents(userPosition);
  }, function() {
    button.disabled = false;
    button.classList.remove('active');
    window.alert('Position konnte nicht ermittelt werden.');
  }, {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 60000
  });
}

function highlightNearestEvents(userPosition) {
  if (typeof days === 'undefined' || !days[currentDayIndex]) {
    return;
  }

  var dayData = filterLocationsByQuery(days[currentDayIndex].data, currentSearchQuery);
  var nearest = null;
  var nearestDistance = Infinity;

  for (var address in dayData) {
    if (!dayData.hasOwnProperty(address)) {
      continue;
    }

    var spot = dayData[address][0];
    var eventPosition = new google.maps.LatLng(spot.lat, spot.lng);
    var distance = google.maps.geometry.spherical.computeDistanceBetween(
      userPosition,
      eventPosition
    );

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = {
        address: address,
        spot: spot,
        distanceKm: (distance / 1000).toFixed(1)
      };
    }
  }

  if (!nearest) {
    return;
  }

  document.getElementById('subtitle').textContent =
    'Nächstes Event: ' + nearest.spot.title + ' (' + nearest.distanceKm + ' km)';
  selectLocation(nearest.address, { openInfo: false, pan: false });
}
