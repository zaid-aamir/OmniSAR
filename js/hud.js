// The "mission control" frame around the side panel:
//   - a top bar with a collapse button and two small status readouts (which case file is open,
//     and how many cases are solved), and a foot readout (the timeline date, or the next real
//     NISAR pass over the open case). Every number here is real: it comes from the case list,
//     the player's progress and the real pass dates. Nothing is decorative.
//   - the collapse button folds the panel into a thin rail so the globe / terrain gets the room
//   - a short "boot-up" sweep each time the panel shows a new view (js/motion.js)

import { esc, announce } from './util.js';
import { finishedCount } from './progress.js';
import { bootPanel } from './motion.js';

const fmt = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();

export function createHud(cases) {
  const panel = document.getElementById('panel');
  const inner = document.getElementById('panel-inner');
  const layout = panel.closest('.layout');
  const ids = cases.map((c) => c.id);

  const bar = document.createElement('div');
  bar.className = 'panel-bar';
  bar.innerHTML = `
    <button class="panel-toggle" id="panel-toggle" aria-expanded="true" aria-controls="panel-inner" aria-label="Hide the case panel">
      <span aria-hidden="true">⟩</span>
    </button>
    <span class="hud-readout" id="hud-case"></span>
    <span class="hud-readout hud-right" id="hud-solved"></span>`;
  const foot = document.createElement('div');
  foot.className = 'panel-foot';
  foot.innerHTML = '<span class="hud-readout" id="hud-date"></span>';
  panel.prepend(bar);
  panel.append(foot);
  panel.classList.add('hud-frame');

  let current = null;
  let date = '2026-06-01';

  function render() {
    const n = current ? ids.indexOf(current.id) + 1 : 0;
    bar.querySelector('#hud-case').textContent = current ? `CASE ${String(n).padStart(2, '0')} · ${current.name.toUpperCase()}` : 'CASE FILES';
    bar.querySelector('#hud-solved').textContent = `SOLVED ${finishedCount(ids)}/${ids.length}`;
    const next = current?.passDates.find((d) => d > date);          // strictly after the timeline date
    foot.querySelector('#hud-date').innerHTML = current
      ? `TIMELINE <b>${esc(fmt(date))}</b> · NEXT NISAR PASS <b>${next ? esc(fmt(next)) : 'NONE IN WINDOW'}</b>`
      : `TIMELINE <b>${esc(fmt(date))}</b>`;
  }

  // ----- collapse / expand -----
  const toggle = bar.querySelector('#panel-toggle');
  function setCollapsed(collapsed) {
    layout.classList.toggle('panel-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Show the case panel' : 'Hide the case panel');
    toggle.firstElementChild.textContent = collapsed ? '⟨' : '⟩';
    inner.inert = collapsed;               // folded content leaves the tab order and screen readers
    foot.inert = collapsed;
  }
  toggle.addEventListener('click', () => setCollapsed(!layout.classList.contains('panel-collapsed')));

  // ----- boot-up sweep when the panel shows a NEW view (not when an answer redraws the same step) -----
  let signature = '';
  new MutationObserver(() => {
    const sig = [inner.querySelector('.eyebrow')?.textContent, inner.querySelector('h1, h2')?.textContent].join('|');
    if (sig === signature) return;
    signature = sig;
    bootPanel(panel, inner);
    render();                               // the solved count may have changed
    // Screen readers: say which view opened, unless focus already moved to its heading (read anyway)
    setTimeout(() => {
      if (!inner.contains(document.activeElement)) {
        const head = inner.querySelector('h1, h2')?.textContent.trim();
        if (head) announce(`Panel: ${head}`);
      }
    }, 120);
  }).observe(inner, { childList: true });

  render();
  return {
    setCase(c) { current = c; render(); },
    setDate(iso) { date = iso; render(); },
    expand() { setCollapsed(false); },
  };
}
