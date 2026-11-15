// The Live Ops case picker: after PLAY, the player chooses which case to play, over the globe.
//
//   createCasePicker(root, { onPick, onPlayAll }) -> { show(cases), hide(), isOpen }
//   - root: the element the overlay goes in (main.js passes #globe-area, like the PLAY screen).
//   - show(cases): cases come from liveops.pickerCases(): { id, name, place, question, dateText, solved }.
//     One card per case: place, country, the date of the NISAR pass it replays, and its question.
//     A case's score and evidence badge appear ONLY once it is solved (solved = { score, badge }),
//     so the picker never gives away a result before the player has made the call.
//   - "Play all days in order" runs the full Day 1 -> Day 2 -> Day 3 game (onPlayAll()).
//   - Keyboard: every card is a real <button> (Tab, Enter, Space), and keys 1-5 pick a case directly.
// Looks: css/casepicker.css. Text is escaped; nothing here invents a number.

import { esc, announce } from './util.js';

const HIDE_MS = 300;

export function createCasePicker(root, { onPick, onPlayAll } = {}) {
  const overlay = document.createElement('section');
  overlay.className = 'case-picker';
  overlay.setAttribute('aria-labelledby', 'cp-title');
  overlay.hidden = true;
  overlay.inert = true;
  root.appendChild(overlay);

  let open = false;
  let chosen = false;                 // one choice per show(), even if a key and a click land together
  let hideTimer = null;

  function choose(fn) {
    if (chosen || !open) return;
    chosen = true;
    fn();
  }

  // Number keys 1..5 pick that case (not while typing, and not while a dialog is open)
  function onKey(e) {
    if (!open || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    if (document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const btn = overlay.querySelector(`.cp-case[data-key="${e.key}"]`);
    if (!btn) return;
    e.preventDefault();
    btn.click();
  }

  function render(cases) {
    const done = cases.filter((c) => c.solved);
    const total = done.reduce((a, c) => a + (c.solved.score || 0), 0);
    overlay.innerHTML = `
      <div class="cp-inner">
        <p class="eyebrow cp-eyebrow">LIVE OPS · CASE FILES</p>
        <h2 class="cp-title" id="cp-title">Choose a case</h2>
        <p class="cp-sub">${done.length
          ? `Solved ${done.length} of ${cases.length} · total score <b>${total}</b>`
          : `Each case replays one real NISAR pass. Press 1–${cases.length} or pick a card.`}</p>
        <ol class="cp-grid">
          ${cases.map((c, i) => `
          <li>
            <button type="button" class="cp-case${c.solved ? ' is-solved' : ''}" data-id="${esc(c.id)}" data-key="${i + 1}"
              aria-label="${esc(`${i + 1}: ${c.name}, ${c.place}. NISAR pass ${c.dateText}. ${c.question}${c.solved ? ` Solved, score ${c.solved.score}${c.solved.badge ? `, evidence ${c.solved.badge}` : ''}.` : ''}`)}">
              <span class="cp-top" aria-hidden="true"><kbd>${i + 1}</kbd>${c.solved ? '<span class="cp-solved">✓ Solved</span>' : ''}</span>
              <span class="cp-name" aria-hidden="true">${esc(c.name)}</span>
              <span class="cp-place" aria-hidden="true">${esc(c.place)}</span>
              <span class="cp-date" aria-hidden="true">NISAR pass · ${esc(c.dateText)}</span>
              <span class="cp-q" aria-hidden="true">“${esc(c.question)}”</span>
              ${c.solved ? `<span class="cp-result" aria-hidden="true">Score <b>${esc(c.solved.score)}</b>${c.solved.badge ? ` <span class="tag tag-nisar">Evidence: ${esc(c.solved.badge)}</span>` : ''}</span>` : ''}
            </button>
          </li>`).join('')}
        </ol>
        <button type="button" class="primary-btn cp-all">Play all days in order <span class="cp-all-sub">Day 1 → Day 2 → Day 3</span></button>
      </div>`;
    overlay.querySelectorAll('.cp-case').forEach((b) => b.addEventListener('click', () => choose(() => onPick?.(b.dataset.id))));
    overlay.querySelector('.cp-all').addEventListener('click', () => choose(() => onPlayAll?.()));
  }

  return {
    show(cases) {
      clearTimeout(hideTimer);
      render(cases);
      chosen = false;
      open = true;
      overlay.classList.remove('is-leaving');
      overlay.hidden = false;
      overlay.inert = false;
      document.addEventListener('keydown', onKey);
      // focus the first unsolved case (or the first case when all are solved)
      (overlay.querySelector('.cp-case:not(.is-solved)') || overlay.querySelector('.cp-case'))?.focus({ preventScroll: true });
      announce(`Choose a case. ${cases.length} cases. Keys 1 to ${cases.length}, or Play all days in order.`);
    },
    hide() {
      open = false;
      chosen = true;
      document.removeEventListener('keydown', onKey);
      overlay.inert = true;
      if (overlay.hidden) return;
      overlay.classList.add('is-leaving');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { overlay.hidden = true; }, HIDE_MS);
    },
    get isOpen() { return open; },
  };
}
