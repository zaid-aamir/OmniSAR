// The "mission control" frame around the side panel, plus the DAY readout in the top bar:
//   - a panel bar with a collapse button and two small status readouts (which case file is open,
//     and how many cases are solved), and a foot readout: how many real NISAR passes we use and
//     their first and last date (for the open case, or for all five cases). Every number here is
//     real: it comes from the case list, the player's progress and the real pass dates.
//   - setDay(): the Live Ops game's "DAY 2 · 15 SEP 2026" readout in the top bar (#hud-day).
//     The date is a real NISAR pass date chosen by the game; "DAY – · –" while no day runs.
//   - the collapse button folds the panel into a thin rail so the globe / terrain gets the room
//   - a short "boot-up" sweep each time the panel shows a new view (js/motion.js)
// (v7: the timeline slider is gone, so nothing here follows a slider date any more.)

import { esc, announce } from './util.js';
import { finishedCount } from './progress.js';
import { bootPanel } from './motion.js';

// "2026-09-15" -> "15 SEP 2026". Month names are written out here, because the browser's own
// en-GB short month for September changed to "Sept" in newer browsers.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const fmt = (iso) => {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');   // also accepts a full ISO time
  if (Number.isNaN(d.getTime())) return '–';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

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
  // every real pass date over all five cases (one per day), for the foot readout with no case open
  const allDates = [...new Set(cases.flatMap((c) => c.passDates))].sort();

  function render() {
    const n = current ? ids.indexOf(current.id) + 1 : 0;
    bar.querySelector('#hud-case').textContent = current ? `CASE ${String(n).padStart(2, '0')} · ${current.name.toUpperCase()}` : 'CASE FILES';
    bar.querySelector('#hud-solved').textContent = `SOLVED ${finishedCount(ids)}/${ids.length}`;
    const dates = current ? current.passDates : allDates;
    foot.querySelector('#hud-date').innerHTML = dates.length
      ? `NISAR PASSES <b>${dates.length}</b> · <b>${esc(fmt(dates[0]))} – ${esc(fmt(dates[dates.length - 1]))}</b>`
      : 'NISAR PASSES <b>NONE LISTED</b>';
  }

  // ----- top bar: the Live Ops DAY readout -----
  // index.html already has #hud-day in the top bar; it is made here only if a page lacks it.
  let dayEl = document.getElementById('hud-day');
  if (!dayEl) {
    dayEl = Object.assign(document.createElement('span'), { className: 'hud-day', id: 'hud-day' });
    dayEl.setAttribute('aria-live', 'polite');
    (document.querySelector('header.topbar .topbar-right') || document.querySelector('header.topbar'))?.prepend(dayEl);
  }
  // "DAY – · –" when either value is missing, otherwise "DAY 2 · 15 SEP 2026" (en-GB, UTC, capitals).
  // Built from text nodes (never HTML), so the readout can only ever show these words.
  function setDay(day, iso) {
    const on = day != null && iso != null;
    const sep = Object.assign(document.createElement('span'), { className: 'hud-day-sep', textContent: ' · ' });
    dayEl.replaceChildren(`DAY ${on ? day : '–'}`, sep, on ? fmt(iso) : '–');
    dayEl.classList.toggle('is-running', on);
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
    setDay,
    expand() { setCollapsed(false); },
  };
}
