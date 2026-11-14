// SI Agent: a dropdown in the top-right corner of the case terrain that sums up the open case and
// answers questions about it. It floats OVER the 3D terrain (which keeps rendering around it).
//
//   Overview    the case name, the last processed pass, the badge, 2-3 lines on what we found
//   Measured    one row per number in cases/<id>.numbers.json (click a row: its note, word for word)
//   Ask         4 suggested questions + a typed question box pinned to the bottom of the panel
//   Data used   one row per data source
//
// Answers come in two layers, so a demo never depends on the network:
//   1. OFFLINE (always): pre-written Q&A in cases/<id>.si.json, written only from that case's own
//      files. A typed question is matched to the nearest Q&A by keywords and synonyms.
//   2. GROK (only if js/si-config.js has a proxyUrl): a typed question goes to OUR proxy (a
//      Cloudflare Worker outside this repo, which holds the key), together with this case's data
//      as grounding. If the proxy fails, times out (8 s) or hits its rate limit, the offline answer
//      is shown instead, tagged "offline answer". The browser never sees an API key.
// Suggested questions always use their pre-written, checked answers (instant, never wrong).
// Every answer from the model is put on the page as plain text, never as HTML.
//
// Opening the panel never pauses Live Ops; keys pressed inside the panel stay inside it, so
// typing "1" in the box can't answer a Live Ops card.

import { esc } from './util.js';
import { TERMS } from './glossary.js';
import { SI_CONFIG } from './si-config.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const NO_MATCH = 'I can only answer from this case’s data. Try one of the suggested questions.';
const AI_LABEL = 'AI answer (Grok): can be wrong. The numbers come from OmniSAR’s measured data.';
const MAX_ANSWERS = 6;

// A test-only override, allowed only on this computer: ?siproxy=http://localhost:8787/...
function proxyUrl() {
  const p = new URLSearchParams(location.search).get('siproxy');
  if (p && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return p;
  return SI_CONFIG.proxyUrl || '';
}

// ----- small line icons (stroke = currentColor) -----
const I = (d) => `<svg class="si-ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const ICONS = {
  radar: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 L19 6"/><circle cx="12" cy="12" r="1.2" class="f"/>'),
  area: I('<rect x="4" y="4" width="16" height="16" rx="1.5" stroke-dasharray="3 2.5"/><path d="M8 16 L16 8"/>'),
  pin: I('<path d="M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>'),
  drop: I('<path d="M12 3c3.5 4.6 6 8 6 11a6 6 0 0 1-12 0c0-3 2.5-6.4 6-11z"/>'),
  wave: I('<path d="M3 9c3-3 6 3 9 0s6 3 9 0"/><path d="M3 15c3-3 6 3 9 0s6 3 9 0"/>'),
  check: I('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9"/>'),
  warn: I('<path d="M12 3.5 L21.5 20 H2.5 Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r="0.9" class="f"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
  people: I('<circle cx="9" cy="9" r="3"/><path d="M3.5 19c.7-3 2.9-4.6 5.5-4.6s4.8 1.6 5.5 4.6"/><circle cx="17" cy="9.5" r="2.3"/><path d="M15.5 14.6c2.3.1 4 1.5 4.7 4"/>'),
  mountain: I('<path d="M2.5 19 L9 8 L13 14 L15.5 10.5 L21.5 19 Z"/>'),
  leaf: I('<path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19 L13 11"/>'),
  question: I('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.6"/><circle cx="12" cy="16.8" r="0.9" class="f"/>'),
  file: I('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>'),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9s1.2-6.4 3.8-9z"/>'),
  fire: I('<path d="M12 21a6 6 0 0 0 6-6c0-3.5-2.5-5.5-3.5-9-2 1.5-3 3.5-3 5.5-1-.7-1.7-1.8-2-3-1.8 1.8-3.5 4-3.5 6.5a6 6 0 0 0 6 6z"/>'),
  send: I('<path d="M4 12 L20 4 L14 20 L11.5 13 Z"/><path d="M11.5 13 L20 4"/>'),
};

function measuredIcon(label) {
  if (/rain/i.test(label)) return ICONS.drop;
  if (/wetness|water/i.test(label)) return ICONS.wave;
  if (/people/i.test(label)) return ICONS.people;
  if (/warning|disagree/i.test(label)) return ICONS.warn;
  if (/pass|interference|quality/i.test(label)) return ICONS.clock;
  if (/slope|distort/i.test(label)) return ICONS.mountain;
  if (/pivot|forest/i.test(label)) return ICONS.leaf;
  if (/highway|district|S0\d/i.test(label)) return ICONS.pin;
  if (/burn/i.test(label)) return ICONS.fire;
  if (/published|compared|ascending|descending/i.test(label)) return ICONS.radar;
  return ICONS.area;
}

// ----- offline matching: words -> stems -> shared synonyms -----
const STOP = new Set(('a an the is are was were be been being of in on at to for and or but it its this that these those there here ' +
  'what which how do does did can could should would will i we you me my our your about from with by as than then so if any ' +
  'some much many very really just also into tell me please show give get got has have had any anything thing things ok').split(' '));
const stem = (w) => {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};
const GROUPS = {
  water: 'water flood flooded flooding lake underwater submerged inundated inundation wetland',
  burn: 'burn burned burnt burning fire fires wildfire wildfires scar blaze charred',
  sink: 'sink sinking sank sunk subside subsiding subsidence drop dropping sag settling',
  rain: 'rain rainfall rained precipitation monsoon storm storms downpour',
  sure: 'sure confident confidence certain certainty trust reliable badge accurate accuracy',
  build: 'build built building buildings construct constructed construction structure structures development',
  crop: 'crop crops farm farms farming field fields agriculture harvest',
  forest: 'forest forests tree trees canopy woods woodland',
  air: 'air atmosphere atmospheric humid humidity vapour vapor troposphere ionosphere',
  people: 'people population residents inhabitants person',
  future: 'future predict prediction forecast next tomorrow coming',
  road: 'road highway hwy route',
  slope: 'slope slopes steep hill hills hillside mountain mountains terrain',
  zoom: 'zoom closer detail detailed sharper sharp resolution tile tiles blurry blur pixelated',
  pass: 'pass passes date dates image images imaged acquisition acquisitions',
  photo: 'photo photos picture pictures optical hls landsat',
  dark: 'dark darker black darkness',
  gap: 'gap gaps missing hole',
};
const SYN = {};
for (const [canon, words] of Object.entries(GROUPS)) for (const w of words.split(' ')) SYN[stem(w)] = canon;

function norm(text) {
  return String(text).toLowerCase()
    .replace(/[’']/g, '')
    .replace(/pivot\s+([abcd])\b/g, 'pivot_$1')
    .replace(/[^a-z0-9_\-\s]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map((w) => { const s = stem(w); return SYN[s] || s; })
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function prepare(qa) {
  const kw = new Set(), phrases = [];
  for (const k of qa.keywords || []) {
    const n = norm(k);
    if (n.length > 1) phrases.push(n.join(' '));
    else if (n.length === 1) kw.add(n[0]);
  }
  return { ...qa, _kw: kw, _phrases: phrases, _q: new Set(norm(qa.q)) };
}

// score = 3 per matching phrase + 2 per matching keyword + 1 per other shared word of the question.
// At least 2 points are needed: one keyword, or two words shared with a written question.
export function matchQuestion(text, qas) {
  const toks = norm(text);
  const set = new Set(toks);
  const joined = ' ' + toks.join(' ') + ' ';
  let best = null, bestScore = 0;
  for (const qa of qas) {
    let s = 0;
    for (const p of qa._phrases) if (joined.includes(' ' + p + ' ')) s += 3;
    for (const w of set) {
      if (qa._kw.has(w)) s += 2;
      else if (qa._q.has(w)) s += 1;
    }
    if (s > bestScore) { best = qa; bestScore = s; }
  }
  return bestScore >= 2 ? best : null;
}

// ----- what the model is allowed to use: this case's own data, nothing else -----
function lastPassOf(numbers) {
  const ds = (numbers?.provenance?.nasa_files || []).map((f) => f.date || String(f.dates || '').split('→').pop().trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return ds.pop() || null;
}

function buildContext(caseInfo, numbers, mystery, traps) {
  const cards = (mystery?.evidence || []).filter((e) => !e.pending)
    .map((e) => ({ card: e.title, caption: e.caption, source: e.source, kind: e.bin === 'trap' ? `trap card ${e.trap}` : 'real change' }));
  const ids = new Set();                     // the traps this case's cards point to
  for (const e of mystery?.evidence || []) if (e.trap) ids.add(e.trap);
  const trapCards = (traps?.traps || []).filter((t) => ids.has(t.id))
    .map((t) => ({ trap: t.id, title: t.title, fools: t.fools, handling: t.handling }));
  const limits = (traps?.limits || []).map((t) => ({ title: t.title, handling: t.handling }));
  const ctx = {
    case: { id: caseInfo.id, name: caseInfo.name, place: caseInfo.place, question: caseInfo.question, box_WSEN: caseInfo.box },
    last_processed_pass: lastPassOf(numbers),
    badge: numbers?.badge, badge_reason: numbers?.badge_reason,
    independent_check: numbers?.check?.text,
    measured: (numbers?.measured || []).map(({ label, value, unit, note }) => ({ label, value, unit, note })),
    evidence_cards: cards,
    trap_cards: trapCards,
    what_radar_cant_prove: mystery?.verdict?.cantProve || [],
    limits,
  };
  const text = JSON.stringify(ctx);
  ctx.glossary = TERMS.filter(([, re]) => re.test(text)).map(([term, , def]) => ({ term, def }));
  return ctx;
}

async function askProxy(url, question, context) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SI_CONFIG.timeoutMs || 8000);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ question, context }),
    });
    if (r.status === 429) return { fail: 'rate', why: 'The AI answer limit was reached' };
    if (!r.ok) return { fail: 'error', why: `The AI proxy answered ${r.status}` };
    const j = await r.json();
    if (typeof j?.answer !== 'string' || !j.answer.trim()) return { fail: 'error', why: 'The AI proxy sent no answer' };
    return { answer: j.answer.trim().slice(0, 1500) };
  } catch (err) {
    return err?.name === 'AbortError' ? { fail: 'timeout', why: 'The AI answer took longer than 8 s' } : { fail: 'error', why: 'The AI proxy could not be reached' };
  } finally {
    clearTimeout(timer);
  }
}

const fetchJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });

// ---------------------------------------------------------------------------------------------
// view = the terrain view; triggerSlot = the top-right region of its overlay grid; panelSlot = the
// side region (the panel docks there, so it can never cover the title or the bottom bar).
// onOpen runs when the panel opens (the terrain closes its own popover then: one at a time).
export function createSiAgent({ view, triggerSlot, panelSlot, onOpen } = {}) {
  const host = document.createElement('div');
  host.innerHTML = `
    <button type="button" class="si-trigger" id="si-trigger" aria-haspopup="dialog" aria-expanded="false" aria-controls="si-panel" hidden>
      ${ICONS.radar}<span class="si-trigger-text">SI Agent</span><span class="si-count" id="si-count">0</span>
    </button>
    <div class="si-panel" id="si-panel" role="dialog" aria-label="SI Agent: case overview and questions" tabindex="-1" hidden>
      <div class="si-scroll" id="si-scroll"></div>
      <form class="si-ask" id="si-ask" autocomplete="off">
        <label class="sr-only" for="si-input">Ask about this case</label>
        <input id="si-input" class="si-input" type="text" maxlength="300" placeholder="Ask about this case…">
        <button type="submit" class="si-send" aria-label="Ask">${ICONS.send}</button>
      </form>
    </div>`;
  const trigger = host.querySelector('#si-trigger');
  const panel = host.querySelector('#si-panel');
  triggerSlot.appendChild(trigger);
  panelSlot.appendChild(panel);
  const inside = (el) => !!el && (trigger.contains(el) || panel.contains(el));
  const scroll = panel.querySelector('#si-scroll');
  const form = panel.querySelector('#si-ask');
  const input = panel.querySelector('#si-input');

  let traps = null;              // cases/traps.json, loaded once
  let cur = null;                // { caseInfo, numbers, mystery, si, qas, context }
  let token = 0;                 // a newer setCase() wins over a slower older one
  let open = false, hideTimer = 0;

  // ----- rendering -----
  function render() {
    const { caseInfo, numbers, si } = cur;
    const last = lastPassOf(numbers);
    const badge = numbers?.badge || 'Evidence pending';
    const badgeKind = (badge.split(/\W/)[0] || '').toLowerCase();
    const [w, s, e, n] = caseInfo.box || [];
    const lon = (a, b) => (a < 0 && b < 0 ? `${Math.abs(a)}–${Math.abs(b)}° W` : `${a}–${b}° E`);
    const lat = (a, b) => (a < 0 && b < 0 ? `${Math.abs(b)}–${Math.abs(a)}° S` : `${a}–${b}° N`);
    const measured = numbers?.measured || [];
    const qById = Object.fromEntries(cur.qas.map((q) => [q.id, q]));

    scroll.innerHTML = `
      <h3 class="si-h">Overview</h3>
      <div class="si-card">
        <p class="si-title">${esc(caseInfo.name)}</p>
        <p class="si-chips">
          ${last ? `<span class="si-chip" title="The last NISAR pass processed for this case">${ICONS.clock}Last pass ${esc(fmtDate(last))}</span>` : ''}
          <span class="si-chip si-badge si-badge-${esc(badgeKind)}" title="${esc(numbers?.badge_reason || '')}">${ICONS.check}${esc(badge)}</span>
        </p>
        <p class="si-sum">${esc(si.overview)}</p>
      </div>
      <p class="si-place">${esc(caseInfo.place)}${caseInfo.box ? ` · box ${lon(w, e)}, ${lat(s, n)}` : ''}</p>

      <h3 class="si-h">Measured</h3>
      <ul class="si-rows" role="list">
        ${measured.map((m, k) => {
          const val = `${m.value}${m.unit ? ' ' + m.unit : ''}`;
          return `<li><button type="button" class="si-row" data-m="${k}" title="${esc(`${m.label}: ${val}`)}">
            ${measuredIcon(m.label)}<span class="si-label">${esc(m.label)}</span><span class="si-tag">${esc(val)}</span></button></li>`;
        }).join('')}
      </ul>

      <h3 class="si-h">Ask SI Agent</h3>
      <ul class="si-rows" role="list">
        ${si.suggested.map((id) => qById[id]).filter(Boolean).map((q) =>
          `<li><button type="button" class="si-row si-q" data-q="${esc(q.id)}" title="${esc(q.q)}">${ICONS.question}<span class="si-label">${esc(q.q)}</span></button></li>`).join('')}
      </ul>
      <div class="si-answers" id="si-answers" aria-live="polite"></div>

      <hr class="si-div">
      <h3 class="si-h">Data used</h3>
      <ul class="si-rows" role="list">
        ${(si.dataUsed || []).map((d) => `<li><div class="si-row si-static" tabindex="0" title="${esc(`${d.name} · ${d.meta}`)}">
          ${ICONS[d.icon] || ICONS.file}<span class="si-label">${esc(d.name)}</span><span class="si-meta">${esc(d.meta)}</span></div></li>`).join('')}
      </ul>`;
    trigger.querySelector('#si-count').textContent = String(measured.length);
    trigger.setAttribute('aria-label', `SI Agent: ${measured.length} measured facts for ${caseInfo.name}`);
    trigger.title = `SI Agent · ${caseInfo.name}`;
  }

  function addAnswer({ q, a, kind, used = '', why = '' }) {
    const box = scroll.querySelector('#si-answers');
    if (!box) return null;
    const card = document.createElement('article');
    card.className = `si-ans si-ans-${kind}`;
    const meta = kind === 'ai'
      ? `<p class="si-ans-meta si-ai-label">${esc(AI_LABEL)}</p>`
      : kind === 'wait' ? ''
      : `<p class="si-ans-meta"><span class="si-src">OmniSAR answer</span>${kind === 'fallback' ? `<span class="si-off" title="${esc(why)}">offline answer</span>` : ''}${used ? `<span class="si-used">From: ${esc(used)}</span>` : ''}</p>`;
    card.innerHTML = `<p class="si-ans-q">${esc(q)}</p><p class="si-ans-a"></p>${meta}`;
    card.querySelector('.si-ans-a').textContent = a;          // plain text, never HTML
    box.prepend(card);
    while (box.children.length > MAX_ANSWERS) box.lastElementChild.remove();
    return card;
  }

  async function ask(text, { suggestedId = null } = {}) {
    const q = String(text).trim().slice(0, 300);
    if (!q || !cur) return;
    const mine = cur;
    const offline = suggestedId ? mine.qas.find((x) => x.id === suggestedId) : matchQuestion(q, mine.qas);
    const url = proxyUrl();
    if (suggestedId || !url) {
      if (offline) addAnswer({ q, a: offline.a, kind: 'offline', used: offline.used });
      else addAnswer({ q, a: NO_MATCH, kind: 'offline' });
      return;
    }
    const wait = addAnswer({ q, a: 'Asking…', kind: 'wait' });
    wait?.classList.add('is-waiting');
    const res = await askProxy(url, q, mine.context);
    wait?.remove();
    if (cur !== mine) return;                                // the case changed while waiting
    if (res.answer) addAnswer({ q, a: res.answer, kind: 'ai' });
    else addAnswer({ q, a: offline ? offline.a : NO_MATCH, kind: 'fallback', used: offline?.used || '', why: res.why });
  }

  scroll.addEventListener('click', (e) => {
    const qb = e.target.closest('.si-q');
    if (qb) { ask(qb.querySelector('.si-label').textContent, { suggestedId: qb.dataset.q }); return; }
    const mb = e.target.closest('[data-m]');
    if (mb && cur) {
      const m = cur.numbers.measured[Number(mb.dataset.m)];
      const val = `${m.value}${m.unit ? ' ' + m.unit : ''}`;
      addAnswer({ q: m.label, a: m.note ? `${val}. ${m.note}` : val, kind: 'offline', used: 'Measured (numbers file)' });
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    input.value = '';
    ask(v);
  });

  // ----- size: 75% of the terrain height, and never down over the Live Ops answer buttons -----
  function fit() {
    if (!open) return;
    const vr = view.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const top = pr.top;
    let maxH = Math.min(vr.height * 0.75, panelSlot.getBoundingClientRect().bottom - top);
    for (const el of document.querySelectorAll('.lo-answers')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left < pr.right && r.right > pr.left && r.bottom > top) maxH = Math.min(maxH, r.top - 8 - top);
    }
    panel.style.maxHeight = `${Math.max(160, Math.floor(maxH))}px`;
  }
  const ro = new ResizeObserver(() => fit());
  ro.observe(view);
  window.addEventListener('resize', fit);

  // ----- open / close -----
  function onDocDown(e) { if (open && !inside(e.target)) close(false); }
  function onDocKey(e) { if (open && e.key === 'Escape') { e.preventDefault(); close(true); } }

  function show() {
    if (!cur || open) return;
    open = true;
    clearTimeout(hideTimer);
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('is-on');
    onOpen?.();
    fit();
    requestAnimationFrame(() => panel.classList.add('is-open'));
    panel.focus({ preventScroll: true });
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onDocKey);
  }
  function close(returnFocus = true) {
    if (!open) return;
    open = false;
    const hadFocus = inside(document.activeElement);
    panel.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('is-on');
    hideTimer = setTimeout(() => { if (!open) panel.hidden = true; }, 160);
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey);
    if (returnFocus && hadFocus && !trigger.hidden) trigger.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', () => (open ? close(true) : show()));
  // keys inside the panel are the panel's own (Live Ops listens on the whole page for 1/2/3/Enter)
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    e.stopPropagation();
  });
  trigger.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') e.stopPropagation(); if (e.key === 'Escape') close(true); });
  // focus leaving the panel for somewhere else on the page closes it (it is a popover, not a modal)
  for (const el of [trigger, panel]) {
    el.addEventListener('focusout', (e) => {
      if (open && e.relatedTarget && !inside(e.relatedTarget)) close(false);
    });
  }

  return {
    // A case terrain opened: load that case's SI file and show the trigger with its count.
    async setCase(caseInfo, numbers) {
      close(false);
      const my = ++token;
      trigger.hidden = true;
      cur = null;
      try {
        const [si, mystery, nums, tr] = await Promise.all([
          fetchJson(`cases/${caseInfo.id}.si.json`),
          caseInfo.mysteryFile ? fetchJson(caseInfo.mysteryFile).catch(() => null) : null,
          numbers || (caseInfo.numbersFile ? fetchJson(caseInfo.numbersFile).catch(() => null) : null),
          traps || fetchJson('cases/traps.json').catch(() => null),
        ]);
        if (my !== token) return;
        traps = tr;
        const next = { caseInfo, numbers: nums || { measured: [] }, mystery, si, qas: (si.qa || []).map(prepare) };
        next.context = buildContext(caseInfo, next.numbers, mystery, traps);
        cur = next;
        render();
        trigger.hidden = false;
      } catch (err) {
        if (my === token) console.warn('SI Agent: no SI file for this case', err?.message || err);
      }
    },
    close: () => close(false),
    // the terrain closed: hide everything
    clear() { close(false); token++; cur = null; trigger.hidden = true; },
    get isOpen() { return open; },
    get caseId() { return cur?.caseInfo.id || null; },
    ask,                                  // for tests and the browser console
    get context() { return cur?.context || null; },
  };
}
