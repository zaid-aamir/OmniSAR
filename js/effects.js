// effects.js: the big "game moments" of Live Ops. Pure decoration: nothing here shows data.
//
//   startSequence(originEl?)  PLAY pressed: a shockwave ring spreads from the button, then the screen
//                             edge glows red (3 slow pulses, then a faint steady glow) and the alarm is on.
//   setAlarm(on)              alarm on = faint red screen edge + red/black hazard stripes in the top bar;
//                             off = everything fades back to normal (used on the end screen).
//   shake()                   a short, small shake of the whole layout (a wrong answer).
//   burst(element)            a green burst of little blocks around an element (a right answer).
//   toast(text)               a short message near the top of the screen for ~3 s; several stack.
//   dayCard(text, { ms })     a big title card in the middle of the screen ("DAY 2 ...").
//   clear()                   removes toasts, bursts and the day card at once (Live Ops stop()).
//
// Safety rule (Zaid's override of the usual "less motion" setting): everyone gets these effects,
// but NOTHING flashes faster than 3 times a second. The fastest repeating flash here is the day
// card's glitch at 2 per second; the edge pulses are 1 per second; the stripes scroll at 0.5 per second.
// All animations move or fade things (transform / opacity) so the 3D globe underneath keeps its speed.
// Text is always set with textContent, never as HTML.

import { announce } from './util.js';

const RING_MS = 400;          // shockwave grows for this long
const RESOLVE_MS = 450;       // startSequence() resolves here, so the panel and rods can come in
const EDGE_START_MS = 300;    // the red edge starts pulsing as the ring reaches the screen edge
const PULSE_MS = 1000;        // one edge pulse per second (1 Hz) ...
const PULSES = 3;             // ... three times, then a steady faint glow
const ALARM_FADE_MS = 600;    // alarm off: fade back over this long
const SHAKE_MS = 300;
const BURST_MS = 600;
const TOAST_MS = 3000;
const TOAST_MAX = 4;          // more than this and the oldest goes at once
const CARD_OUT_MS = 350;      // the day card's exit animation

// One fixed, click-through layer over the whole window holds every effect
let layer = null;
function fxLayer() {
  if (!layer || !layer.isConnected) {
    layer = make('div', 'fx-layer');
    document.body.appendChild(layer);
  }
  return layer;
}

function make(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

// Restart a CSS animation class (removing and re-adding it in the same frame would do nothing)
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// The centre of an element on screen, or of the window if the element is missing/invisible
function centreOf(el) {
  const r = el?.isConnected ? el.getBoundingClientRect() : null;
  if (r && (r.width || r.height)) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

// ---------- Red screen edge (shared by startSequence and setAlarm) ----------
function edgeEl() {
  const host = fxLayer();
  let el = host.querySelector(':scope > .fx-edge');
  if (!el) {
    el = make('div', 'fx-edge');
    el.setAttribute('aria-hidden', 'true');
    host.prepend(el);                                   // under toasts and cards
    void el.offsetWidth;                                // starts at opacity 0, so switching on fades in
    el.addEventListener('animationend', () => el.classList.remove('is-pulsing'));
  }
  return el;
}

// ---------- startSequence ----------
let ringTimer = 0, edgeTimer = 0, finishRing = null;
export function startSequence(originEl) {
  const origin = originEl || document.getElementById('globe-area');
  const { x, y } = centreOf(origin);
  // The ring grows until it reaches the farthest corner (capped, so the drawing stays small in memory)
  const reach = Math.min(1000, Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)));

  fxLayer().querySelectorAll(':scope > .fx-ring').forEach((r) => r.remove());   // a replay never stacks rings
  const ring = make('div', 'fx-ring');
  ring.setAttribute('aria-hidden', 'true');
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  ring.style.width = ring.style.height = `${Math.round(reach * 2)}px`;
  ring.style.animationDuration = `${RING_MS}ms`;
  fxLayer().appendChild(ring);

  clearTimeout(edgeTimer);
  edgeTimer = setTimeout(() => {
    setAlarm(true);
    replay(edgeEl(), 'is-pulsing');                    // 3 pulses at 1 Hz (CSS), then the steady alarm glow
  }, EDGE_START_MS);

  finishRing?.();                                       // an earlier call still waiting resolves now
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(ringTimer); ring.remove(); finishRing = null; resolve(); };
    finishRing = finish;
    ringTimer = setTimeout(finish, RESOLVE_MS);
  });
}

// ---------- setAlarm ----------
let fadeTimer = 0;
export function setAlarm(on) {
  const body = document.body;
  clearTimeout(fadeTimer);
  if (on) {
    edgeEl();
    body.classList.remove('is-alarm-fading');
    body.classList.add('is-alarm');
    return;
  }
  clearTimeout(edgeTimer);                              // a pending start pulse must not switch it back on
  layer?.querySelector('.fx-edge')?.classList.remove('is-pulsing');
  if (!body.classList.contains('is-alarm')) return;
  body.classList.remove('is-alarm');
  body.classList.add('is-alarm-fading');                // keeps the stripes moving while they fade out
  fadeTimer = setTimeout(() => body.classList.remove('is-alarm-fading'), ALARM_FADE_MS + 50);
}

// ---------- shake ----------
let shakeTimer = 0;
export function shake() {
  const el = document.querySelector('main.layout');
  if (!el) return;
  replay(el, 'fx-shake');
  clearTimeout(shakeTimer);
  shakeTimer = setTimeout(() => el.classList.remove('fx-shake'), SHAKE_MS + 50);
}

// ---------- burst ----------
export function burst(element) {
  const { x, y } = centreOf(element);
  const b = make('div', 'fx-burst');
  b.setAttribute('aria-hidden', 'true');
  b.style.left = `${x}px`;
  b.style.top = `${y}px`;
  b.appendChild(make('span', 'fx-burst-ring'));
  const BITS = 12;                                      // little square "blocks", echoing the voxel globe
  for (let i = 0; i < BITS; i++) {
    const angle = (i / BITS) * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
    const dist = 38 + (i % 3) * 14 + Math.random() * 8;
    const bit = make('span', 'fx-burst-bit');
    bit.style.setProperty('--dx', `${(Math.cos(angle) * dist).toFixed(1)}px`);
    bit.style.setProperty('--dy', `${(Math.sin(angle) * dist).toFixed(1)}px`);
    bit.style.setProperty('--rot', `${Math.round(Math.random() * 180)}deg`);
    b.appendChild(bit);
  }
  fxLayer().appendChild(b);
  setTimeout(() => b.remove(), BURST_MS + 50);
}

// ---------- toast ----------
function toastStack() {
  const host = fxLayer();
  let stack = host.querySelector(':scope > .fx-toasts');
  if (!stack) {
    stack = make('div', 'fx-toasts');
    host.appendChild(stack);
  }
  return stack;
}

function dropToast(t, fast) {
  if (t._gone) return;
  t._gone = true;
  clearTimeout(t._timer);
  t.classList.add('is-leaving');
  setTimeout(() => t.remove(), fast ? 0 : 250);
}

export function toast(text) {
  const stack = toastStack();
  const live = [...stack.children].filter((t) => !t._gone);
  live.slice(0, Math.max(0, live.length - TOAST_MAX + 1)).forEach((t) => dropToast(t, true));

  const t = make('div', 'fx-toast');
  t.setAttribute('role', 'status');
  stack.appendChild(t);
  // Text goes in just after the empty status box exists, so screen readers notice the change and read it
  setTimeout(() => { t.textContent = String(text ?? ''); }, 40);
  t._timer = setTimeout(() => dropToast(t), TOAST_MS);
  return t;
}

// ---------- day card ----------
let currentCard = null;
export function dayCard(text, { ms = 2200 } = {}) {
  currentCard?.finish(true);                            // a new card replaces the old one at once
  const label = String(text ?? '');
  const stay = Number.isFinite(Number(ms)) ? Math.max(0, Number(ms)) : 2200;

  const card = make('div', 'fx-daycard');
  card.setAttribute('aria-hidden', 'true');             // screen readers get it through announce() instead
  const words = make('div', 'fx-daycard-text');
  words.textContent = label;                            // a line break in the text starts a new line on screen
  words.dataset.text = label;                           // the two glitch copies (red/cyan) show this text
  card.appendChild(words);
  fxLayer().appendChild(card);
  announce(label.replace(/\s*\n\s*/g, '. '));

  return new Promise((resolve) => {
    let done = false;
    const handle = {
      finish(now) {
        if (done) return;
        done = true;
        clearTimeout(stayTimer);
        card.classList.add('is-leaving');
        setTimeout(() => {
          card.remove();
          if (currentCard === handle) currentCard = null;
          resolve();
        }, now ? 0 : CARD_OUT_MS);
      },
    };
    currentCard = handle;
    const stayTimer = setTimeout(() => handle.finish(false), stay);
  });
}

// ---------- clear (extra, for liveops.stop()) ----------
// Removes toasts, bursts, rings and the day card at once. It leaves the alarm as it is
// (call setAlarm(false) for that).
export function clear() {
  if (!layer) return;
  layer.querySelectorAll('.fx-toast').forEach((t) => dropToast(t, true));
  layer.querySelectorAll('.fx-burst, .fx-ring').forEach((el) => el.remove());
  currentCard?.finish(true);
}
