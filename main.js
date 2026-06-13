var BERLIN_CENTER_LAT = 52.5170365;
var BERLIN_CENTER_LNG = 13.3888599;
var currentMap = null;
var currentDayIndex = 0;

window.onload = function() {
  buildDayPicker();

  if (typeof days === 'undefined' || !days.length) {
    document.getElementById('empty-state').hidden = false;
    document.getElementById('map').hidden = true;
    return;
  }

  loadDate(0);

  $('#date_picker').on('click', '.day_div', function() {
    loadDate(parseInt(this.dataset.dayIndex, 10));
  });
};

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
    button.classList.toggle('active', parseInt(button.dataset.dayIndex, 10) === dayIndex);
  });

  document.getElementById('event-count').textContent = countEvents(day.data) + ' Events';
  document.getElementById('location-count').textContent = countLocations(day.data) + ' Orte';
  document.getElementById('subtitle').textContent = day.label + ' · ' + formatDate(day.date);

  displayLocations(day.data);
}

function displayLocations(locations) {
  $('#map').empty();

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

  addresses.forEach(function(address, index) {
    var locationSpots = locations[address];
    var isApproximate =
      locationSpots[0].lat === BERLIN_CENTER_LAT &&
      locationSpots[0].lng === BERLIN_CENTER_LNG;

    var marker = new google.maps.Marker({
      position: new google.maps.LatLng(locationSpots[0].lat, locationSpots[0].lng),
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
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
