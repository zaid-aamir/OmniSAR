// The evidence-sorting minigame. Every exhibit card is a real piece of evidence from our analysis.
// The player sorts each one into "Real change" or "Trap" (drag it onto a bin, or use the
// buttons on the card; both work with a keyboard). A "Trap" card must also be named.
//   - right bin (and right trap name)  -> the card is filed
//   - wrong bin or wrong name          -> its trap card opens, and the player tries again
// The correct answers come from the case file (bin + trap), which the processing scripts set
// from our numbers. Cards whose evidence doesn't exist yet show "Evidence pending" and are
// not part of the game. The rules and the score live in engine.js.

import { esc } from './util.js';
import { loadTraps, openTrap } from './trapcard.js';

export async function mountMinigame(host, mystery, { onChange }) {
  const traps = await loadTraps();
  const trapTitle = (id) => traps.traps.find((t) => t.id === id)?.title || `Trap #${id}`;
  const cards = mystery.sortableCards();
  const pending = mystery.data.evidence.filter((e) => !cards.includes(e));
  // The trap names offered: every trap this case's cards use, plus two common decoys
  const nameChoices = [...new Set([...cards.filter((c) => c.trap).map((c) => c.trap), 10, 13])].sort((a, b) => a - b);
  const feedback = {};          // card id -> last message
  let naming = null;            // card id waiting for a trap name

  function cardHTML(e) {
    const done = mystery.isCardSolved(e.id);
    const img = e.src ? `<img src="${esc(e.src)}" alt="${esc(e.caption)}" loading="lazy">` : '';
    const fb = feedback[e.id];
    return `
      <article class="sort-card ${done ? 'is-filed' : ''}" draggable="${!done}" data-card="${esc(e.id)}" tabindex="-1">
        <h3>${esc(e.title)}</h3>
        ${img}
        <p class="evidence-caption">${esc(e.caption)}</p>
        <p class="evidence-source"><span class="tag ${/^NISAR/.test(e.source) ? 'tag-nisar' : ''}">${esc(e.source)}</span></p>
        ${done ? `<p class="sort-filed">Filed: ${e.bin === 'real' ? 'Real change' : `Trap #${e.trap} · ${esc(trapTitle(e.trap))}`}</p>` : `
          <div class="sort-actions" role="group" aria-label="Sort this card">
            <button class="ghost-btn" data-sort="real" data-id="${esc(e.id)}">Real change</button>
            <button class="ghost-btn" data-sort="trap" data-id="${esc(e.id)}">Trap</button>
          </div>`}
        ${naming === e.id ? `
          <fieldset class="trap-names">
            <legend>Which trap is it?</legend>
            ${nameChoices.map((id) => `<button class="option" data-name="${id}" data-id="${esc(e.id)}">#${id} ${esc(trapTitle(id))}</button>`).join('')}
          </fieldset>` : ''}
        ${fb ? `<p class="sort-feedback ${fb.ok ? 'ok' : 'bad'}" role="status">${esc(fb.text)}</p>` : ''}
      </article>`;
  }

  function render() {
    const s = mystery.cardScore();
    host.innerHTML = `
      <div class="sort-bins">
        <div class="sort-bin" data-bin="real"><strong>Real change</strong><span>drop a card here</span></div>
        <div class="sort-bin" data-bin="trap"><strong>Trap</strong><span>drop a card here</span></div>
      </div>
      <p class="sort-score" aria-live="polite">Score: <strong>${s.firstTry}</strong> of ${s.total} right first time · ${s.filed} of ${s.total} filed</p>
      <div class="sort-cards">${cards.map(cardHTML).join('')}</div>
      ${pending.length ? `
        <h3 class="wt-sub">Not in the game yet</h3>
        ${pending.map((e) => `<article class="evidence-card"><h3>${esc(e.title)}</h3><div class="pending-box">Evidence pending</div><p class="evidence-caption">${esc(e.caption)}</p></article>`).join('')}` : ''}`;
    wire();
    onChange?.();
  }

  function sort(id, bin) {
    const card = cards.find((c) => c.id === id);
    if (bin === 'trap' && card.bin === 'trap') {        // right bin: now name the trap
      naming = id;
      feedback[id] = null;
      render();
      host.querySelector(`[data-card="${CSS.escape(id)}"] .trap-names button`)?.focus();
      return;
    }
    const r = mystery.answerCard(id, bin, null);
    naming = null;
    if (r.correct) {
      feedback[id] = { ok: true, text: 'Right: this is a real change, backed by the evidence on the card.' };
    } else if (card.bin === 'trap') {
      feedback[id] = { ok: false, text: `Not real: this one is trap #${card.trap}. Read the trap card, then sort it again.` };
      openTrap(card.trap);
    } else {
      feedback[id] = { ok: false, text: 'This one is a real change: the evidence on the card holds up. Try again.' };
    }
    render();
  }

  function name(id, trapId) {
    const card = cards.find((c) => c.id === id);
    const r = mystery.answerCard(id, 'trap', trapId);
    if (r.correct) {
      naming = null;
      feedback[id] = { ok: true, text: `Right: trap #${card.trap}, ${trapTitle(card.trap)}.` };
    } else {
      feedback[id] = { ok: false, text: `It is a trap, but not #${trapId}. Here is the right trap card; then name it again.` };
      openTrap(card.trap);
    }
    render();
  }

  function wire() {
    host.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => sort(b.dataset.id, b.dataset.sort)));
    host.querySelectorAll('[data-name]').forEach((b) => b.addEventListener('click', () => name(b.dataset.id, Number(b.dataset.name))));
    host.querySelectorAll('.sort-card[draggable="true"]').forEach((el) => {
      el.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', el.dataset.card); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
    });
    host.querySelectorAll('.sort-bin').forEach((bin) => {
      bin.addEventListener('dragover', (ev) => { ev.preventDefault(); bin.classList.add('over'); });
      bin.addEventListener('dragleave', () => bin.classList.remove('over'));
      bin.addEventListener('drop', (ev) => {
        ev.preventDefault();
        bin.classList.remove('over');
        const id = ev.dataTransfer.getData('text/plain');
        if (id && !mystery.isCardSolved(id)) sort(id, bin.dataset.bin);
      });
    });
  }

  render();
}
