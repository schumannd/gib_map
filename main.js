var BERLIN_CENTER_LAT = 52.5170365;
var BERLIN_CENTER_LNG = 13.3888599;
var REGION_BOUNDS = {
  south: 52.34,
  west: 12.92,
  north: 52.60,
  east: 13.52
};
var REGION_CENTER = { lat: 52.47, lng: 13.22 };
var REGION_DEFAULT_ZOOM = 10;
var currentMap = null;
var currentDayIndex = 0;
var currentSearchQuery = '';
var markerCluster = null;
var userLocationMarker = null;
var EXPECTED_DAYS = 7;

window.onload = function() {
  buildDayPicker();
  var dataStatus = evaluateDataStatus();

  if (dataStatus.type === 'missing') {
    showEmptyState(dataStatus.title, dataStatus.message);
    return;
  }

  showDataStatus(dataStatus);
  document.getElementById('empty-state').hidden = true;
  document.getElementById('map').hidden = false;
  loadDate(0);

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
    loadDate(currentDayIndex);
  });
  clearSearchButton.addEventListener('click', function() {
    searchInput.value = '';
    currentSearchQuery = '';
    clearSearchButton.hidden = true;
    loadDate(currentDayIndex);
    searchInput.focus();
  });

  var headerToggle = document.getElementById('header-toggle');
  headerToggle.addEventListener('click', function() {
    var isOpen = document.body.classList.toggle('header-open');
    headerToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });

  document.getElementById('locate-me').addEventListener('click', locateUser);
};

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

  var today = todayIsoDate();
  var firstDate = days[0].date;
  var dayOffset = daysBetweenIsoDates(today, firstDate);

  if (dayOffset < 0) {
    return {
      type: 'stale',
      bannerClass: 'warning',
      message: 'Daten sind veraltet: ältester Tag ist ' + formatDate(firstDate) + '. Bitte Crawler erneut ausführen.'
    };
  }

  if (dayOffset > 0) {
    return {
      type: 'future',
      bannerClass: 'info',
      message: 'Daten beginnen erst am ' + formatDate(firstDate) + '.'
    };
  }

  if (days.length < EXPECTED_DAYS) {
    return {
      type: 'partial',
      bannerClass: 'warning',
      message: 'Unvollständige Daten: ' + days.length + ' von ' + EXPECTED_DAYS + ' Tagen geladen. Crawler ggf. fortsetzen.'
    };
  }

  var expectedLastDate = addDaysToIsoDate(today, EXPECTED_DAYS - 1);
  var lastDate = days[days.length - 1].date;
  if (lastDate !== expectedLastDate) {
    return {
      type: 'partial',
      bannerClass: 'warning',
      message: 'Daten enden am ' + formatDate(lastDate) + ' statt ' + formatDate(expectedLastDate) + '.'
    };
  }

  return { type: 'ok' };
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
  document.getElementById('map').hidden = true;
  document.getElementById('data-status').hidden = true;
  document.body.classList.remove('has-status-banner');
}

function showDataStatus(status) {
  var banner = document.getElementById('data-status');
  if (!status.message) {
    banner.hidden = true;
    document.body.classList.remove('has-status-banner');
    return;
  }

  banner.hidden = false;
  banner.className = 'status-banner ' + (status.bannerClass || 'info');
  banner.textContent = status.message;
  document.body.classList.add('has-status-banner');
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

function loadDate(dayIndex) {
  if (typeof days === 'undefined' || !days[dayIndex]) {
    return;
  }

  currentDayIndex = dayIndex;
  var day = days[dayIndex];

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

function getRegionBounds() {
  return new google.maps.LatLngBounds(
    new google.maps.LatLng(REGION_BOUNDS.south, REGION_BOUNDS.west),
    new google.maps.LatLng(REGION_BOUNDS.north, REGION_BOUNDS.east)
  );
}

function isWithinRegion(lat, lng) {
  return lat >= REGION_BOUNDS.south && lat <= REGION_BOUNDS.north &&
    lng >= REGION_BOUNDS.west && lng <= REGION_BOUNDS.east;
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

function applyMapViewport(map, markerBounds, hasMarkers) {
  var regionBounds = getRegionBounds();
  map.fitBounds(regionBounds, 48);

  if (!hasMarkers) {
    return;
  }

  map.fitBounds(markerBounds, 48);
  google.maps.event.addListenerOnce(map, 'idle', function() {
    var zoom = map.getZoom();
    if (zoom > 15) {
      map.setZoom(15);
    } else if (zoom < REGION_DEFAULT_ZOOM) {
      map.fitBounds(regionBounds, 48);
    }
  });
}

function displayLocations(locations) {
  var mapElement = document.getElementById('map');
  mapElement.innerHTML = '';
  clearUserLocation();

  if (window.mapLoadError) {
    mapElement.innerHTML = '<div class="map-error">' + escapeHtml(window.mapLoadError) + '</div>';
    return;
  }

  if (typeof google === 'undefined' || !google.maps || !google.maps.Map) {
    mapElement.innerHTML =
      '<div class="map-error">Google Maps konnte nicht geladen werden. ' +
      'Prüfe den API-Schlüssel in index.html und erlaube deine github.io-Domain.</div>';
    return;
  }

  currentMap = new google.maps.Map(mapElement, {
    zoom: REGION_DEFAULT_ZOOM,
    center: REGION_CENTER,
    mapTypeId: google.maps.MapTypeId.ROADMAP,
    fullscreenControl: true,
    streetViewControl: false,
    mapTypeControl: false,
    restriction: {
      latLngBounds: getRegionBounds(),
      strictBounds: false
    }
  });

  var infowindow = new google.maps.InfoWindow();
  var addresses = Object.keys(locations);
  var bounds = new google.maps.LatLngBounds();
  var hasMarkers = false;
  var markers = [];

  addresses.forEach(function(address, index) {
    var locationSpots = locations[address];
    var isApproximate =
      locationSpots[0].lat === BERLIN_CENTER_LAT &&
      locationSpots[0].lng === BERLIN_CENTER_LNG;

    var position = new google.maps.LatLng(locationSpots[0].lat, locationSpots[0].lng);
    if (isWithinRegion(locationSpots[0].lat, locationSpots[0].lng)) {
      bounds.extend(position);
      hasMarkers = true;
    }

    var marker = new google.maps.Marker({
      position: position,
      title: locationSpots[0].title,
      icon: isApproximate
        ? 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png'
        : 'https://maps.google.com/mapfiles/ms/icons/red-dot.png'
    });
    markers.push(marker);

    google.maps.event.addListener(marker, 'click', (function(markerRef, addressKey) {
      return function() {
        var spots = locations[addressKey];
        var contentHtml = '<div class="info-window">';
        contentHtml += '<strong>' + escapeHtml(addressKey) + '</strong><ul>';
        for (var j = 0; j < spots.length; j++) {
          contentHtml += '<li><a href="' + escapeHtml(spots[j].url) + '" target="_blank" rel="noopener">' +
            escapeHtml(spots[j].title) + '</a></li>';
        }
        contentHtml += '</ul></div>';
        infowindow.setContent(contentHtml);
        infowindow.open(currentMap, markerRef);
      };
    })(marker, address));
  });

  if (markerCluster) {
    markerCluster.clearMarkers();
    markerCluster = null;
  }

  if (markers.length && typeof markerClusterer !== 'undefined' && markerClusterer.MarkerClusterer) {
    markerCluster = new markerClusterer.MarkerClusterer({
      map: currentMap,
      markers: markers
    });
  } else {
    markers.forEach(function(marker) {
      marker.setMap(currentMap);
    });
  }

  applyMapViewport(currentMap, bounds, hasMarkers);
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
}
