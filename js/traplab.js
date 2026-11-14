// The Trap Lab: all 17 data traps in their 3 groups, in the side panel.
// Each trap opens to show: what fools you, a real before/after example from our own cases (the
// same evidence images the cases use), a "try it" switch where we have two real images to flip
// between, how we proved it, how OmniSAR handles it, and the cases where you meet it.
// Nothing here is made up: images and captions come from the case files (cases/<id>.json) and
// cases/traplab.json (built by tools/build_traplab.py from our processed data). A trap with no
// real example says so and shows text only.

import { esc, announce } from './util.js';
import { loadTraps } from './trapcard.js';

let cache = null;
async function loadAll(cases) {
  cache ??= Promise.all([
    loadTraps(),
    fetch('cases/traplab.json').then((r) => (r.ok ? r.json() : { tryIts: {} })).catch(() => ({ tryIts: {} })),
    ...cases.map((c) => fetch(c.mysteryFile).then((r) => r.json()).then((m) => ({ c, m }))),
  ]).then(([traps, lab, ...mysteries]) => ({ traps, lab, mysteries }));
  return cache;
}

// Everything the cases say about one trap
function collect(id, mysteries, lab) {
  const examples = [];
  const tries = [];
  const meet = new Map();
  for (const { c, m } of mysteries) {
    const hit = () => meet.set(c.id, c);
    for (const e of m.evidence || []) {
      if (e.trap === id) { hit(); if (e.src && !e.pending) examples.push({ src: e.src, caption: e.caption, title: e.title, case: c.name }); }
    }
    for (const t of m.toggles || []) {
      if (t.trap !== id) continue;
      hit();
      if (!t.disabled && t.layers?.off?.src && t.layers?.on?.src) {
        tries.push({ case: c.name, label: t.label, off: t.layers.off, on: t.layers.on, note: t.explains });
      }
    }
    for (const ch of Object.values(m.choices || {})) if (ch.options.some((o) => o.trap === id)) hit();
    if (c.analysis?.trap === id) hit();
  }
  const own = lab.tryIts?.[String(id)];
  if (own) tries.unshift({ case: mysteries.find((x) => x.c.id === own.case)?.c.name || own.case, label: `${own.offWord} ↔ ${own.onWord}`, off: own.off, on: own.on, note: own.note });
  return { examples, tries, meet: [...meet.values()] };
}

export async function showTrapLab(root, cases, { focus = null, onBack, onPick } = {}) {
  root.innerHTML = '<p class="loading-text">Opening the Trap Lab</p>';
  const { traps, lab, mysteries } = await loadAll(cases);
  const open = new Set(focus != null ? [focus] : []);
  const flipped = {};                       // trap id -> index of the try-it showing its "on" image

  function card(t) {
    const { examples, tries, meet } = collect(t.id, mysteries, lab);
    const isOpen = open.has(t.id);
    const body = !isOpen ? '' : `
      <div class="lab-body" id="lab-body-${t.id}">
        <h4 class="lab-h">What fools you</h4><p>${esc(t.fools)}</p>
        <h4 class="lab-h">A real example from our cases</h4>
        ${examples.length ? examples.slice(0, 2).map((e) => `
          <figure class="lab-fig"><img src="${esc(e.src)}" alt="${esc(e.title)}: ${esc(e.caption)}" loading="lazy">
            <figcaption><strong>${esc(e.case)}</strong> · ${esc(e.caption)}</figcaption></figure>`).join('')
          : tries.length ? '<p class="lab-none">Our real example for this trap is the switch below.</p>'
          : '<p class="lab-none">No real example of this trap in our data yet, so this card is text only.</p>'}
        ${tries.length ? tries.map((tr, k) => {
          const on = flipped[t.id] === k;
          const shown = on ? tr.on : tr.off;
          return `
          <div class="lab-try">
            <div class="lab-try-head"><span class="lab-h">Try it · ${esc(tr.case)}</span>
              <button class="ghost-btn lab-flip" data-flip="${t.id}" data-k="${k}" aria-pressed="${on}">Show: ${esc(on ? tr.off.label : tr.on.label)}</button></div>
            <figure class="lab-fig"><img src="${esc(shown.src)}" alt="${esc(shown.label)}"><figcaption>Showing: <strong>${esc(shown.label)}</strong></figcaption></figure>
            ${tr.note ? `<p class="evidence-caption">${esc(tr.note)}</p>` : ''}
          </div>`;
        }).join('') : ''}
        <h4 class="lab-h">How we proved it</h4><p>${esc(t.proof)}</p>
        <h4 class="lab-h">How OmniSAR handles it</h4><p>${esc(t.handling)}</p>
        ${t.inApp ? '' : '<p class="trap-later">This fix is not in this version of the app yet.</p>'}
        <h4 class="lab-h">Where you meet it</h4>
        ${meet.length ? `<p class="lab-cases">${meet.map((c) => `<button class="link-btn lab-case" data-case="${esc(c.id)}">${esc(c.name)} →</button>`).join('')}</p>`
          : '<p class="lab-none">Not in any of the five cases; it matters when you open your own data.</p>'}
      </div>`;
    return `
      <li class="lab-item ${isOpen ? 'is-open' : ''}" id="lab-${t.id}">
        <button class="lab-toggle" data-trap-open="${t.id}" aria-expanded="${isOpen}" aria-controls="lab-body-${t.id}">
          <span class="lab-num">#${t.id}</span><span class="lab-title">${esc(t.title)}</span>
          <span class="lab-flags">${tries.length ? '<span class="lab-tag">try it</span>' : ''}${examples.length || tries.length ? '' : '<span class="lab-tag lab-tag-text">text only</span>'}</span>
        </button>
        ${body}
      </li>`;
  }

  function render(keep) {
    root.innerHTML = `
      <button class="link-btn" id="back-btn">← Back</button>
      <p class="eyebrow">Trap Lab · 17 traps · 3 groups</p>
      <h1 class="panel-title" tabindex="-1">Every way radar data can fool you</h1>
      <p class="panel-text">Each trap comes with a real example from our five cases and, where we have two real images, a switch to try it yourself.</p>
      ${Object.entries(traps.buckets).map(([key, name]) => `
        <h2 class="lab-group">${esc(name)}</h2>
        <ol class="lab-list">${traps.traps.filter((t) => t.bucket === key).map(card).join('')}</ol>`).join('')}`;
    root.querySelector('#back-btn').addEventListener('click', () => onBack?.());
    root.querySelectorAll('[data-trap-open]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.trapOpen);
      open.has(id) ? open.delete(id) : open.add(id);
      render(`[data-trap-open="${id}"]`);
    }));
    root.querySelectorAll('[data-flip]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.flip), k = Number(b.dataset.k);
      flipped[id] = flipped[id] === k ? -1 : k;
      render(`[data-flip="${id}"][data-k="${k}"]`);
      announce(`Showing ${root.querySelector(`[data-flip="${id}"][data-k="${k}"]`)?.closest('.lab-try')?.querySelector('figcaption strong')?.textContent || ''}`);
    }));
    root.querySelectorAll('[data-case]').forEach((b) => b.addEventListener('click', () => onPick?.(b.dataset.case)));
    if (keep) root.querySelector(keep)?.focus();
  }

  render();
  if (focus != null) {
    const el = root.querySelector(`#lab-${focus}`);
    el?.scrollIntoView({ block: 'start' });
    el?.querySelector('.lab-toggle')?.focus({ preventScroll: true });
  } else {
    root.closest('.panel')?.scrollTo({ top: 0 });
    root.querySelector('h1')?.focus({ preventScroll: true });
  }
}
