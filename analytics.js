(function() {
  var endpoint = window.GIB_ANALYTICS;
  if (!endpoint) {
    return;
  }

  window.gibTrack = function(path, title) {
    if (!window.goatcounter || !window.goatcounter.count) {
      return;
    }

    var options = {
      path: path || (window.location.pathname + window.location.search),
      event: Boolean(title)
    };
    if (title) {
      options.title = title;
    }
    window.goatcounter.count(options);
  };

  var script = document.createElement('script');
  script.async = true;
  script.dataset.goatcounter = endpoint;
  script.src = 'https://gc.zgo.at/count.js';
  script.onload = function() {
    if (window.gibTrackQueue) {
      window.gibTrackQueue.forEach(function(item) {
        window.gibTrack(item.path, item.title);
      });
      window.gibTrackQueue = [];
    }
  };
  document.head.appendChild(script);
  window.gibTrackQueue = [];
})();
