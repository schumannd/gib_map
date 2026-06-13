var BERLIN_CENTER_LAT = 52.5170365;
var BERLIN_CENTER_LNG = 13.3888599;
var currentMap = null;
var currentDayIndex = 0;
var currentSearchQuery = '';
var EXPECTED_DAYS = 7;

window.onload = function() {
  buildDayPicker();
  var dataStatus = evaluateDataStatus();

  if (dataStatus.type === 'missing') {
    showEmptyState(dataStatus.title, dataStatus.message);
    return;
  }

  showDataStatus(dataStatus);
  loadDate(0);

  document.getElementById('date_picker').addEventListener('click', function(event) {
    var button = event.target.closest('.day_div');
    if (!button) {
      return;
    }
    loadDate(parseInt(button.dataset.dayIndex, 10));
  });

  document.getElementById('date_picker').addEventListener('keydown', handleDayPickerKeydown);

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
  picker.innerHTML = '';

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

function displayLocations(locations) {
  document.getElementById('map').innerHTML = '';

  currentMap = new google.maps.Map(document.getElementById('map'), {
    zoom: 11,
    center: new google.maps.LatLng(52.520008, 13.404954),
    mapTypeId: google.maps.MapTypeId.ROADMAP,
    fullscreenControl: true,
    streetViewControl: false,
    mapTypeControl: false
  });

  var infowindow = new google.maps.InfoWindow();
  var addresses = Object.keys(locations);
  var bounds = new google.maps.LatLngBounds();
  var hasMarkers = false;

  addresses.forEach(function(address, index) {
    var locationSpots = locations[address];
    var isApproximate =
      locationSpots[0].lat === BERLIN_CENTER_LAT &&
      locationSpots[0].lng === BERLIN_CENTER_LNG;

    var position = new google.maps.LatLng(locationSpots[0].lat, locationSpots[0].lng);
    bounds.extend(position);
    hasMarkers = true;

    var marker = new google.maps.Marker({
      position: position,
      map: currentMap,
      title: locationSpots[0].title,
      icon: isApproximate
        ? 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png'
        : 'https://maps.google.com/mapfiles/ms/icons/red-dot.png'
    });

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

  if (hasMarkers) {
    currentMap.fitBounds(bounds, 48);
    if (addresses.length === 1) {
      currentMap.setZoom(14);
    }
  }
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
