// Trap cards: a pop-up card for one of the 17 data traps (or a "limit": something radar
// can never prove). Text comes from cases/traps.json. Any part of the app can call
// openTrap(8) or openTrap('who-why'), and trapChip(8) makes a small button that opens it.

import { esc } from './util.js';

let trapsPromise = null;
export function loadTraps() {
  trapsPromise ??= fetch('cases/traps.json').then((r) => r.json());
  return trapsPromise;
}

function findTrap(data, id) {
  return data.traps.find((t) => t.id === id) || data.limits.find((t) => t.id === id);
}

// The <dialog> element is made once and reused for every card
let dialog = null;
function getDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'trap-dialog';
  document.body.appendChild(dialog);
  // click outside the card closes it
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  return dialog;
}

export async function openTrap(id) {
  const data = await loadTraps();
  const t = findTrap(data, id);
  if (!t) return;
  const isLimit = typeof t.id === 'string';
  const d = getDialog();
  d.innerHTML = `
    <article class="trap-card">
      <p class="eyebrow">${isLimit ? 'What radar can’t prove' : `Trap #${t.id} · ${esc(data.buckets[t.bucket])}`}</p>
      <h2 class="trap-title">${esc(t.title)}</h2>
      <h3>What fools you</h3><p>${esc(t.fools)}</p>
      <h3>How we proved it</h3><p>${esc(t.proof)}</p>
      ${t.citation?.length ? `<p class="trap-cite">Source: ${t.citation.map((c) => (/^https:\/\//.test(c.url)
        ? `<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.outlet)}, ${esc(c.date)}: “${esc(c.title)}”</a>`
        : `${esc(c.outlet)}, ${esc(c.date)}: “${esc(c.title)}”`)).join('; ')}</p>` : ''}
      <h3>How OmniSAR handles it</h3><p>${esc(t.handling)}</p>
      ${t.inApp ? '' : '<p class="trap-later">This fix is not in this version of the app yet.</p>'}
      <button class="primary-btn" id="trap-close">Got it</button>
    </article>`;
  d.querySelector('#trap-close').addEventListener('click', () => d.close());
  d.showModal();
}

// HTML for a small button that opens a trap card. Wire it up with wireTrapChips(root).
export function trapChip(id, label) {
  const text = label || (typeof id === 'number' ? `Trap #${id}` : 'What radar can’t prove');
  return `<button class="trap-chip" data-trap="${esc(id)}">${esc(text)}</button>`;
}

export function wireTrapChips(root) {
  root.querySelectorAll('.trap-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.trap;
      openTrap(/^\d+$/.test(raw) ? Number(raw) : raw);
    });
  });
}
