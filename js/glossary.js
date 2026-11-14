// Glossary tooltips for radar words, everywhere text appears (side panel, trap cards, dialogs).
// The first time a word appears in a view it gets a dotted underline; hover it or reach it with
// Tab to read a one-sentence definition. The definitions live in one hidden list, linked with
// aria-describedby (screen readers read them as a description, never in the middle of a sentence),
// and one shared floating box shows them on screen. Words inside buttons, links, headings,
// code and measured values are left alone.

export const TERMS = [
  ['backscatter', /\bbackscatter\b/i, 'The part of the radar beam that bounces back to the satellite; bright = a lot came back.'],
  ['HH', /\bHH\b/, 'Sent and received with horizontal waves: strong from walls, flooded trunks and bare ground facing the satellite.'],
  ['HV', /\bHV\b/, 'Sent horizontal, received vertical: only things that scramble the wave, like leaves and crops, send much back.'],
  ['L-band', /\bL-band\b/i, 'Radar with 24 cm waves (NISAR): long enough to pass through leaves and dry sand.'],
  ['C-band', /\bC-band\b/i, 'Radar with 5.6 cm waves (Sentinel-1): stopped by leaves, so it sees the top of a canopy.'],
  ['InSAR', /\bInSAR\b/, 'Comparing the timing of two radar passes to measure ground motion of millimetres.'],
  ['coherence', /\bcoherence\b/i, 'How stable the radar signal stayed between two passes, 0 to 1; low coherence means the phase is noise.'],
  ['speckle', /\bspeckle\b/i, 'The grainy salt-and-pepper look of every radar image, from waves adding up inside one pixel.'],
  ['median', /\bmedian\b/i, 'The middle value of several: one strange date can’t pull it far, unlike an average.'],
  ['double bounce', /\bdouble[- ]bounce\b/i, 'The beam hits flat ground, then a wall or trunk, and comes straight back: very bright in HH.'],
  ['dB', /\bdB\b/, 'Decibels: a log scale; every 3 dB is double (or half) the radar power.'],
];

const SKIP = 'button, a, h1, h2, h3, code, strong, .tag, .eyebrow, .gloss, svg, input, label, summary, .sr-only, .legend-ticks, .hud-readout, .tl-head, .gb-step, .gb-big, .tour-cap';

// one hidden definition per term, shared by every marked word
let pool = null, tip = null;
function setup() {
  if (pool) return;
  pool = Object.assign(document.createElement('div'), { hidden: true, id: 'gloss-pool' });
  pool.innerHTML = TERMS.map(([key, , def], k) => `<span id="gloss-def-${k}">${def}</span>`).join('');
  tip = Object.assign(document.createElement('div'), { className: 'gloss-tip', hidden: true });
  tip.setAttribute('aria-hidden', 'true');
  document.body.append(pool, tip);
  const show = (e) => {
    const g = e.target.closest?.('.gloss');
    if (!g) return;
    (g.closest('dialog') || document.body).appendChild(tip);    // inside an open dialog, or it would sit under it
    tip.textContent = document.getElementById(g.getAttribute('aria-describedby')).textContent;
    tip.hidden = false;
    const r = g.getBoundingClientRect();
    const w = Math.min(260, window.innerWidth - 16);
    tip.style.maxWidth = `${w}px`;
    tip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 6)}px`;
  };
  const hide = (e) => { if (e.target.closest?.('.gloss')) tip.hidden = true; };
  document.addEventListener('mouseover', show);
  document.addEventListener('focusin', show);
  document.addEventListener('mouseout', hide);
  document.addEventListener('focusout', hide);
}

function glossify(container, seen) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (!n.nodeValue.trim() || n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    for (const [k, [key, re]] of TERMS.entries()) {
      if (seen.has(key)) continue;
      const m = re.exec(node.nodeValue);
      if (!m) continue;
      seen.add(key);
      const after = node.splitText(m.index);
      after.nodeValue = after.nodeValue.slice(m[0].length);
      const span = document.createElement('span');
      span.className = 'gloss';
      span.dataset.term = key;
      span.tabIndex = 0;
      span.setAttribute('aria-describedby', `gloss-def-${k}`);
      span.textContent = m[0];
      node.parentNode.insertBefore(span, after);
      break;                       // the rest of this text node is handled on the next pass
    }
  }
}

// Watch the page: whenever a panel view or dialog is (re)drawn, mark the first use of each word
export function startGlossary() {
  setup();
  let busy = false;
  let queued = false;
  const run = () => {
    queued = false;
    busy = true;
    for (const c of document.querySelectorAll('#panel-inner, dialog[open] .trap-card, .terrain-legend')) {
      // "first use" = words already marked in what is on screen now (a redraw removes old marks)
      const seen = new Set([...c.querySelectorAll('.gloss')].map((g) => g.dataset.term));
      for (let pass = 0; pass < TERMS.length; pass++) {
        const before = seen.size;
        glossify(c, seen);
        if (seen.size === before) break;
      }
    }
    busy = false;
  };
  new MutationObserver(() => {
    if (busy || queued) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(document.body, { subtree: true, childList: true });
  run();
}
