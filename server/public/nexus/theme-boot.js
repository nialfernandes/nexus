// The approval page's look, applied before the first paint. A render-blocking script in the head, so the page is
// never drawn in the wrong look first. Nothing here reads or writes any storage: the look follows the device.
//
// The page is dark when the device is in dark mode; the result is the class `dark` on <html>, which the token block in
// approve.css keys on. The class follows the device while the page is open.
(function () {
  var html = document.documentElement;
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function paint() {
    html.classList.toggle('dark', !!query && query.matches);
  }

  if (query) {
    if (query.addEventListener) query.addEventListener('change', paint);
    else if (query.addListener) query.addListener(paint);
  }
  paint();
})();
