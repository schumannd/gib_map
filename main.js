
window.onload = function() {
    load_date(0);

    $('.day_div').on('click', function() {
        load_date(this.dataset.days);
    })
}

load_date = function(days_ahead) {
  var data_json = {};
  if(days_ahead == 0) {
    data_json = heute;
  } else if (days_ahead == 1) {
    data_json = morgen;
  } else {
    data_json = uebermorgen;
  }
  display_locations(data_json);

}

display_locations = function(locations) {
  $('#map').empty();
  var map = new google.maps.Map(document.getElementById('map'), {
    zoom: 10,
    center: new google.maps.LatLng(52.520008, 13.404954),
    mapTypeId: google.maps.MapTypeId.ROADMAP
  });

  var infowindow = new google.maps.InfoWindow();

  var marker, i;
  var adresses = [];
  for (var address in locations) {
    if (locations.hasOwnProperty(address)) {
      adresses.push(address);
    }
  }

  for (var i = 0; i < adresses.length; i++) {
    var location = locations[adresses[i]];
    if( location[0].lat == 52.5170365 && location[0].lng == 13.3888599){
      var icon = 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png';
    } else {
      var icon = 'https://maps.google.com/mapfiles/ms/icons/red-dot.png';
    }

    marker = new google.maps.Marker({
      position: new google.maps.LatLng(location[0].lat, location[0].lng),
      map: map,
      icon: icon
    });

    google.maps.event.addListener(marker, 'click', (function(marker, i) {
      return function() {
        var location_spots = locations[adresses[i]];
        var content_html = '';
        for(var j = 0; j < location_spots.length; j++){
          content_html += '- <a href="' + location_spots[j].url + '">' + location_spots[j].title + '</a><br>'
        }
        infowindow.setContent(content_html);
        infowindow.open(map, marker);
      }
    })(marker, i));
  }
}
