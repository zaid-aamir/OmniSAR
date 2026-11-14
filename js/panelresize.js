// panelresize.js: lets the player make the case-files panel wider or narrower.
//
// A thin handle sits on the panel's left edge. You can:
//   - drag it with the mouse, a pen or a finger,
//   - focus it with Tab and press ← (wider) or → (narrower), 20 px a step; Home / End = narrowest / widest,
//   - double-click it to go back to the normal width.
// The width is clamped between `min` px and `maxFraction` of the window, and saved in the browser
// (localStorage) so it is the same after a reload. If the browser blocks storage, it still works,
// it just doesn't remember.
//
// How it works: the page layout is a grid whose right column is `var(--panel-w)`. We only change that
// one CSS variable on the layout. The globe and terrain canvases already watch their own box
// (ResizeObserver), so they redraw at the new size without stretching.
// For screen readers the handle is a "separator" that says the current width in pixels.

const STEP = 20;

export function makeResizable(panelEl, { min = 280, maxFraction = 0.6, storageKey } = {}) {
  const layout = panelEl?.closest('.layout');
  if (!layout) return { reset() {} };

  // The normal width = whatever --panel-w was before we touched it (read once, here).
  // We keep it as written (it may be a CSS formula like clamp(...)), so "reset" brings back the exact original.
  const originalInline = layout.style.getPropertyValue('--panel-w');
  let chosen = null;                // the width the player chose (px), or null = the normal width
  let applied = null;               // the width on screen now (the choice, squeezed into the window)

  // --- the handle ---
  const handle = document.createElement('div');
  handle.className = 'panel-resizer';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize the case panel');
  handle.setAttribute('tabindex', '0');
  handle.title = 'Drag to resize (or ← → keys). Double-click: normal width.';
  if (panelEl.id) handle.setAttribute('aria-controls', panelEl.id);
  if (panelEl.parentElement === layout) layout.insertBefore(handle, panelEl);   // tab order: handle, then panel
  else layout.appendChild(handle);

  // --- sizes ---
  const maxPx = () => Math.max(min, Math.floor(maxFraction * window.innerWidth));
  const clamp = (px) => Math.min(maxPx(), Math.max(min, px));

  // The width the current --panel-w works out to, in px (works even while the panel is hidden or folded)
  function measure() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;height:0;width:var(--panel-w)';
    layout.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    probe.remove();
    return w;
  }

  function updateAria() {
    const now = Math.round(measure());
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(maxPx()));
    handle.setAttribute('aria-valuenow', String(now));
    handle.setAttribute('aria-valuetext', `Panel ${now} pixels wide`);
  }

  // choose = true when the player did it (remember it); false for automatic re-fits after a window resize
  function apply(px, { choose = true } = {}) {
    applied = Math.round(clamp(px));
    layout.style.setProperty('--panel-w', `${applied}px`);
    updateAria();
    if (choose) { chosen = applied; store(applied); }
  }

  // --- storage (always in try/catch: private windows or blocked storage must not break the page) ---
  function load() {
    if (!storageKey) return null;
    try {
      const v = Number(window.localStorage.getItem(storageKey));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  }
  function store(px) {
    if (!storageKey) return;
    try { window.localStorage.setItem(storageKey, String(Math.round(px))); } catch { /* not remembered, still works */ }
  }
  function forget() {
    if (!storageKey) return;
    try { window.localStorage.removeItem(storageKey); } catch { /* nothing to clear */ }
  }

  function reset() {
    chosen = applied = null;
    if (originalInline) layout.style.setProperty('--panel-w', originalInline);
    else layout.style.removeProperty('--panel-w');
    forget();
    updateAria();
  }

  // --- pointer drag (pointer capture: the drag keeps working even if the pointer leaves the handle) ---
  let drag = null;                  // { id, startX, startW, x, frame }
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, startX: e.clientX, startW: applied ?? measure(), x: e.clientX, frame: 0 };
    document.body.classList.add('is-resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX;
    if (drag.frame) return;         // at most one resize per screen frame
    drag.frame = requestAnimationFrame(() => {
      if (!drag) return;
      drag.frame = 0;
      apply(drag.startW + (drag.startX - drag.x), { choose: false });   // the handle is on the left: left = wider
    });
  });
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    cancelAnimationFrame(drag.frame);
    const moved = drag.x !== drag.startX;
    if (moved) apply(drag.startW + (drag.startX - drag.x));
    drag = null;
    document.body.classList.remove('is-resizing');
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('lostpointercapture', endDrag);

  handle.addEventListener('dblclick', (e) => { e.preventDefault(); reset(); });

  // --- keyboard ---
  handle.addEventListener('keydown', (e) => {
    const now = applied ?? measure();
    let next = null;
    if (e.key === 'ArrowLeft') next = now + STEP;
    else if (e.key === 'ArrowRight') next = now - STEP;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = maxPx();
    if (next === null) return;
    e.preventDefault();
    apply(next);
  });

  // --- window resize: keep the chosen width inside the new limits (without overwriting the saved choice) ---
  let resizeFrame = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (chosen !== null) apply(chosen, { choose: false });
      else updateAria();
    });
  });

  // --- start: use the saved width if there is one ---
  const saved = load();
  if (saved !== null) { apply(saved, { choose: false }); chosen = saved; }
  else updateAria();

  return { reset };
}
