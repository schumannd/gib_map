window.onload = function() {
    load_date(new Date())

    $('.day_div').on('click', function() {
        var one_day = 24 * 60 * 60 * 1000;
        var num_days = this.dataset.days
        var date = new Date(new Date().getTime() + num_days * one_day);
        load_date(date);
    })
}

load_date = function(date) {
    var date_string = date.getFullYear() + '-' + (date.getMonth()+1) + '-' + date.getDate();
    fetch(date_string + '.json')
      .then(response => response.json())
      .then(json => {
        display_locations(json);
    });
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

      marker = new google.maps.Marker({
        position: new google.maps.LatLng(location[0].lat, location[0].lng),
        map: map
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
