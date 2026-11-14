// Small helpers shared by several files.

// Make text safe to put inside HTML (so a stray "<" in a data file can never break the page)
export function esc(text) {
  return String(text).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

// Keyboard support: the minigame and the graph redraw themselves after every answer, which
// would throw keyboard focus back to the top of the page. focusKey() remembers which button
// had focus (by its data-* attributes); restoreFocus() puts focus back on the same button after
// the redraw, or on a sensible fallback if that button is gone (e.g. a card that was just filed).
export function focusKey(host) {
  const el = document.activeElement;
  if (!el || !host.contains(el)) return null;
  const attrs = Object.entries(el.dataset).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}="${CSS.escape(v)}"]`);
  return attrs.length ? attrs.join('') : null;
}

export function restoreFocus(host, key, fallback) {
  if (!key) return;
  const el = host.querySelector(key) || (fallback && host.querySelector(fallback));
  el?.focus({ preventScroll: false });
}
