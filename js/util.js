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

// Does the player ask for less motion (operating-system setting)? Animations check this.
export const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Show or hide a control that only makes sense in some views. Hiding: it leaves the tab order
// and screen readers at once (inert), fades/slides out (CSS class .is-hiding), then gets the
// `hidden` attribute. If keyboard focus was inside it, focus moves to `focusTo` first, so focus
// never sits on something that has vanished. Showing is the same in reverse.
export function setShown(el, show, { focusTo } = {}) {
  if (!el) return;
  el.classList.add('can-hide');
  const shown = !el.hidden && !el.classList.contains('is-hiding');
  if (show === shown) return;
  clearTimeout(el._hideTimer);
  if (show) {
    el.hidden = false;
    el.inert = false;
    el.classList.add('is-hiding');                       // start from the hidden pose ...
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('is-hiding')));  // ... then animate in
  } else {
    if (el.contains(document.activeElement)) (typeof focusTo === 'function' ? focusTo() : focusTo)?.focus();
    el.inert = true;
    el.classList.add('is-hiding');
    el._hideTimer = setTimeout(() => { el.hidden = true; }, reducedMotion() ? 0 : 240);
  }
}

// Say something to screen-reader users without moving focus (one shared polite live region).
let liveRegion = null;
export function announce(text) {
  if (!liveRegion) {
    liveRegion = Object.assign(document.createElement('div'), { className: 'sr-only' });
    liveRegion.setAttribute('aria-live', 'polite');
    liveRegion.setAttribute('role', 'status');
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = '';
  setTimeout(() => { liveRegion.textContent = text; }, 60);   // a change, so it is read even if the text repeats
}
