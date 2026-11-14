// Small animations, all short (150-400 ms), all made with transform/opacity only, and all
// switched off when the operating system asks for reduced motion (then things simply appear).
// Nothing here changes what is shown: a counted-up number always ends on the real value from
// the numbers file, and screen readers get that final value straight away.

import { reducedMotion } from './util.js';

// Restart a CSS animation class on an element
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;                       // forces the browser to notice the class went away
  el.classList.add(cls);
}

// A new panel view: a thin scan line sweeps down the panel, the content fades up,
// and the heading's words appear one after another
export function bootPanel(panel, inner) {
  if (reducedMotion()) return;
  replay(panel, 'is-booting');
  replay(inner, 'is-booting');
  const h = inner.querySelector('h1, h2');
  if (h && !h.querySelector('.word') && h.children.length === 0) {
    const words = h.textContent.trim().split(/\s+/);
    const step = Math.min(40, 260 / Math.max(words.length, 1));   // whole heading done in under ~300 ms
    h.innerHTML = words.map((w, i) => `<span class="word" style="animation-delay:${Math.round(i * step)}ms">${w
      .replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])}</span>`).join(' ');
  }
}

// Verdict numbers count up to their real value; then the evidence badge stamps in.
// Each number element: <span data-count="874.5" aria-hidden="true">874.5</span> next to a
// screen-reader copy of the same value, so assistive tech never hears the in-between numbers.
export function countUpAll(root, { then } = {}) {
  const els = [...root.querySelectorAll('[data-count]')];
  if (reducedMotion() || !els.length) { then?.(); return; }
  const MS = 400;
  const start = performance.now();
  const parts = els.map((el) => {
    const text = el.dataset.count;
    const decimals = (text.split('.')[1] || '').length;
    return { el, text, value: Number(text), decimals };
  }).filter((p) => Number.isFinite(p.value));
  function frame(now) {
    const t = Math.min(1, (now - start) / MS);
    const ease = 1 - Math.pow(1 - t, 3);
    for (const p of parts) p.el.textContent = t < 1 ? (p.value * ease).toFixed(p.decimals) : p.text;   // ends on the exact real text
    if (t < 1) requestAnimationFrame(frame);
    else then?.();
  }
  requestAnimationFrame(frame);
}

export function stamp(el) {
  if (!el || reducedMotion()) return;
  replay(el, 'is-stamped');
}

// One-off effect classes (snap, shake, pulse, ...) that remove themselves when done
export function flash(el, cls) {
  if (!el || reducedMotion()) return;
  replay(el, cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}
