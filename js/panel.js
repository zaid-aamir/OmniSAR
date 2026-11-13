// The side panel. Two views for now:
//  - home: the five case files in mystery order (also a keyboard-friendly way to pick one)
//  - case card: place, question, number of real NISAR passes, status, "Open mystery" + "Back to globe"
// The mystery walkthrough (engine.js, next step) takes over the same panel.

import { STATUS_TEXT } from './cases.js';
import { esc } from './util.js';
import { trapChip, wireTrapChips } from './trapcard.js';

export function statusChip(status) {
  return `<span class="status status-${status}">${esc(STATUS_TEXT[status] || status)}</span>`;
}

export function createPanel(root, cases, { onPick, onBack, onOpen }) {
  function showHome() {
    root.innerHTML = `
      <p class="eyebrow">Case files</p>
      <h1 class="panel-title">Pick a mystery on the globe</h1>
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
                <span class="case-row-name">${esc(c.name)} ${statusChip(c.status)}</span>
                <span class="case-row-q">${esc(c.question)}</span>
              </span>
            </button>
          </li>`).join('')}
      </ol>`;
    root.querySelectorAll('.case-row').forEach((btn) =>
      btn.addEventListener('click', () => onPick(btn.dataset.id)));
  }

  function showCase(c) {
    const asc = c.passes.filter((p) => p.direction === 'A').length;
    const desc = c.passes.filter((p) => p.direction === 'D').length;
    root.innerHTML = `
      <button class="link-btn" id="back-btn">← Back to globe</button>
      <p class="eyebrow">Case file · ${esc(c.place)}</p>
      <h1 class="panel-title">${esc(c.name)}</h1>
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
  }

  function note(text) {
    const el = root.querySelector('#open-note');
    if (el) { el.textContent = text; el.hidden = false; }
  }

  showHome();
  return { showHome, showCase, note, root };
}
