// The side panel. Two views for now:
//  - home: the five case files in mystery order (also a keyboard-friendly way to pick one)
//  - case card: place, question, number of real NISAR passes, status, "Open mystery" + "Back to globe"
// The mystery walkthrough (engine.js, next step) takes over the same panel.

import { STATUS_TEXT } from './cases.js';
import { esc } from './util.js';

// After the panel redraws, the button that had focus is gone: move focus to the new heading
// (only when focus was in the panel or nowhere, so we never steal it from the globe or timeline)
function focusHeading(root) {
  const a = document.activeElement;
  if (a && a !== document.body && !root.contains(a) && a.isConnected) return;
  root.querySelector('h1')?.focus({ preventScroll: true });
}
import { trapChip, wireTrapChips } from './trapcard.js';
import { caseProgress, finishedCount, resetProgress } from './progress.js';

export function statusChip(status) {
  return `<span class="status status-${status}">${esc(STATUS_TEXT[status] || status)}</span>`;
}

export function createPanel(root, cases, { onPick, onBack, onOpen, onAction }) {
  let tipCount = 0;
  const ids = cases.map((c) => c.id);
  let started = false;
  function showHome() {
    const done = finishedCount(ids);
    root.innerHTML = `
      <p class="eyebrow">Case files</p>
      <h1 class="panel-title" tabindex="-1">Pick a mystery on the globe</h1>
      <p class="panel-text">
        Each marker is a real place with a real question about how the ground changed.
        Fly in, sort the evidence, and decide what NISAR radar can — and can't — prove.
      </p>
      <ol class="case-list">
        ${cases.map((c, i) => `
          <li>
            <button class="case-row" data-id="${esc(c.id)}">
              <span class="case-num">${i + 1}</span>
              <span class="case-row-text">
                <span class="case-row-name">${esc(c.name)} ${statusChip(c.status)}${caseProgress(c.id)?.done ? ' <span class="solved">✓ solved</span>' : ''}</span>
                <span class="case-row-q">${esc(c.question)}</span>
              </span>
            </button>
          </li>`).join('')}
      </ol>
      ${done ? `<p class="panel-note">${done} of ${cases.length} cases solved.</p>
        <button class="${done === cases.length ? 'primary-btn' : 'ghost-btn'}" id="end-btn">${done === cases.length ? 'Your investigation: all five solved' : 'Your investigation so far'}</button>` : ''}
      <p class="home-legend"><span class="legend-sq legend-case" aria-hidden="true"></span> cyan columns: our five cases ·
        <span class="legend-sq legend-tip" aria-hidden="true"></span> grey columns: live-event markers, NASA EONET natural events nobody has checked with radar</p>
      <nav class="home-actions" aria-label="More">
        <button class="primary-btn" data-action="tour">Watch a 1-minute tour</button>
        <button class="ghost-btn" data-action="traplab">Trap Lab: all 17 traps</button>
        <button class="ghost-btn" data-action="nasa">Powered by NASA data</button>
        <button class="ghost-btn" data-action="challenge">How OmniSAR answers the challenge</button>
        <button class="ghost-btn" data-action="about">About</button>
      </nav>
      ${tipCount ? `<p class="panel-note">Grey columns are ${tipCount} unverified tips: natural events from NASA EONET (fires, floods, storms, volcanoes), 1 Jun – 10 Nov 2026. They appear as the timeline reaches their dates. Nobody has checked them with radar.</p>` : ''}`;
    root.querySelectorAll('.case-row').forEach((btn) =>
      btn.addEventListener('click', () => onPick(btn.dataset.id)));
    root.querySelector('#end-btn')?.addEventListener('click', showEnd);
    root.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', () => onAction?.(b.dataset.action)));
    if (started) focusHeading(root);
    started = true;
  }

  // End screen: every finished case with its badge, the lessons and the traps the player met
  function showEnd() {
    const done = cases.filter((c) => caseProgress(c.id)?.done);
    const caught = new Set(done.flatMap((c) => caseProgress(c.id).caught || []));
    const fell = new Set(done.flatMap((c) => caseProgress(c.id).fell || []));
    for (const t of fell) caught.delete(t);
    const chips = (list) => [...list].map((t) => trapChip(t, typeof t === 'number' ? `#${t}` : 'Limits')).join(' ');
    root.innerHTML = `
      <button class="link-btn" id="back-btn">← Back to globe</button>
      <p class="eyebrow">Your investigation</p>
      <h1 class="panel-title" tabindex="-1">${done.length === cases.length ? 'All five cases solved' : `${done.length} of ${cases.length} cases solved`}</h1>
      <p class="panel-text">You met ${caught.size + fell.size} different traps and caught ${caught.size} of them without falling for them.
        OmniSAR has ${17} numbered traps in all; each card says how we proved it with real data.</p>
      ${caught.size ? `<p class="panel-text"><span class="recap-ok">✓ Caught:</span> ${chips(caught)}</p>` : ''}
      ${fell.size ? `<p class="panel-text"><span class="recap-bad">✗ Fooled you once:</span> ${chips(fell)}</p>` : ''}
      <ol class="end-list">
        ${cases.map((c) => {
          const p = caseProgress(c.id);
          return `<li><strong>${esc(c.name)}</strong> ${p?.done ? `<span class="tag tag-nisar">Evidence: ${esc(p.badge || 'pending')}</span>` : '<span class="pending-text">not solved yet</span>'}
            ${p?.done ? `<br><span class="evidence-caption">Learned: ${p.lessons.map(esc).join(' · ')}</span>` : ''}</li>`;
        }).join('')}
      </ol>
      <h3 class="wt-sub">What radar can't prove, in every case</h3>
      <p class="panel-text">Who did something, why, whether it was allowed, or what will happen next. Radar measures how the ground scatters microwaves and how it moves. ${trapChip('who-why', 'Open the card')}</p>
      <button class="ghost-btn" id="reset-btn">Start again (clear progress)</button>`;
    root.querySelector('#back-btn').addEventListener('click', onBack);
    root.querySelector('#reset-btn').addEventListener('click', () => { resetProgress(); showHome(); });
    wireTrapChips(root);
    root.closest('.panel')?.scrollTo({ top: 0 });       // a new view always starts at its top
    focusHeading(root);
  }

  function showCase(c) {
    const asc = c.passes.filter((p) => p.direction === 'A').length;
    const desc = c.passes.filter((p) => p.direction === 'D').length;
    root.innerHTML = `
      <button class="link-btn" id="back-btn">← Back to globe</button>
      <p class="eyebrow">Case file · ${esc(c.place)}</p>
      <h1 class="panel-title" tabindex="-1">${esc(c.name)}</h1>
      <p class="case-question">“${esc(c.question)}”</p>
      <dl class="facts">
        <div><dt>Status</dt><dd>${statusChip(c.status)}</dd></div>
        <div><dt>NISAR passes</dt><dd>${c.passDates.length} days with data, 1 Jun – 10 Nov 2026</dd></div>
        <div><dt>Directions</dt><dd>${asc} ascending · ${desc} descending pass${desc === 1 ? '' : 'es'}</dd></div>
        <div><dt>Tracks</dt><dd class="mono">${esc(c.tracks.join(', '))}</dd></div>
        <div><dt>Product</dt><dd><span class="tag tag-nisar">NISAR ${esc(c.product)}</span></dd></div>
        ${c.analysis ? `<div><dt>We analyse</dt><dd>
          Track ${esc(c.analysis.track)} ${c.analysis.direction === 'A' ? 'ascending' : 'descending'} only
          (${c.passes.filter((p) => p.track === c.analysis.track && p.direction === c.analysis.direction).length} passes)
          <span class="evidence-caption">${esc(c.analysis.note)}</span>
          ${trapChip(c.analysis.trap)}</dd></div>` : ''}
      </dl>
      <button class="primary-btn" id="open-btn">Open mystery</button>
      <p class="panel-note" id="open-note" hidden></p>`;
    root.querySelector('#back-btn').addEventListener('click', onBack);
    root.querySelector('#open-btn').addEventListener('click', () => onOpen(c.id));
    wireTrapChips(root);
    root.closest('.panel')?.scrollTo({ top: 0 });
    focusHeading(root);
  }

  // An unverified tip from NASA EONET: title, date, source links, and a clear "no check yet"
  function showTip(t) {
    root.innerHTML = `
      <button class="link-btn" id="back-btn">← Back to globe</button>
      <p class="eyebrow">Unverified tip · NASA EONET</p>
      <h1 class="panel-title" tabindex="-1">${esc(t.title)}</h1>
      <dl class="facts">
        <div><dt>Type</dt><dd>${esc(t.category)}</dd></div>
        <div><dt>Date</dt><dd>${esc(t.date)}</dd></div>
        <div><dt>Where</dt><dd class="mono">${t.lat.toFixed(2)}°, ${t.lon.toFixed(2)}°</dd></div>
        <div><dt>Status</dt><dd><span class="status status-unverified">No check yet</span></dd></div>
      </dl>
      <p class="panel-text">This is a tip from NASA's Earth Observatory Natural Event Tracker, which collects reports of natural events from other sources. OmniSAR hasn't looked at it with radar, so there's no mystery and no verdict.</p>
      <p class="panel-text">${t.sources.filter((s) => /^https:\/\//.test(s.url)).map((s) => `<a class="tag cite" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">Source: ${esc(s.id)}</a>`).join(' ')}
        ${/^https:\/\//.test(t.link || '') ? `<a class="tag cite" href="${esc(t.link)}" target="_blank" rel="noopener noreferrer">EONET record</a>` : ''}</p>`;
    root.querySelector('#back-btn').addEventListener('click', onBack);
    root.closest('.panel')?.scrollTo({ top: 0 });
    focusHeading(root);
  }

  function setTipCount(n) {
    tipCount = n;
    if (root.querySelector('.case-list')) showHome();
  }

  function note(text) {
    const el = root.querySelector('#open-note');
    if (el) { el.textContent = text; el.hidden = false; }
  }

  showHome();
  return { showHome, showCase, showTip, showEnd, setTipCount, note, allDone: () => finishedCount(ids) === ids.length, root };
}
