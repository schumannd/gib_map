window.onload = function() {
    var locations = [
    {
        'title': 'asd',
        'lat': -33.890542,
        'lng': 151.274856,
        'link': 'asd'
    },
    {
        'title': 'asd2',
        'lat': -33.890542,
        'lng': 151.274856,
        'link': 'asd'
    },
    {
        'title': 'asd',
        'lat': -33.923036,
        'lng': 151.259052,
        'link': 'asd'
    },
    ]
    display_locations(locations);
}

get_data = function() {
    ajax_call = {
        type: 'GET',
        url: 'https://www.gratis-in-berlin.de/heute',
        success: function(data) {
            handle_heute_data(data);
        },
        error: function(err) {
            handle_heute_error(err);
        }
    }
    $.ajax(ajax_call);
}

handle_heute_data = function(data) {
    $('body').html(data);
}

handle_heute_error = function(err) {
    asd = err;
}


display_locations = function(locations) {
    var map = new google.maps.Map(document.getElementById('map'), {
      zoom: 10,
      center: new google.maps.LatLng(52.520008, 13.404954),
      mapTypeId: google.maps.MapTypeId.ROADMAP
    });

    var infowindow = new google.maps.InfoWindow();

    var marker, i;

    for (i = 0; i < locations.length; i++) {  
      marker = new google.maps.Marker({
        position: new google.maps.LatLng(locations[i].lat, locations[i].lng),
        map: map
      });

      google.maps.event.addListener(marker, 'click', (function(marker, i) {
        return function() {
          infowindow.setContent('<a href="google.com">' + locations[i].title + '</a>');
          infowindow.open(map, marker);
        }
      })(marker, i));
    }
}
