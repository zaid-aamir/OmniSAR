// Chooses the colour palette from the address bar: index.html?palette=1 ... ?palette=9.
// Default is palette 4. Runs before the page draws (plain script, not a module).
(function () {
  var n = parseInt(new URLSearchParams(location.search).get('palette'), 10);
  if (n >= 1 && n <= 9) {
    document.documentElement.setAttribute('data-palette', String(n));
  }
})();
