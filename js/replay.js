// Change Replay: while a case terrain is open, it loops the change between the real radar passes the
// verdict uses, so you can SEE what changed without reading a legend:
//
//   BEFORE (2 s)  →  fade (1 s, "no data in between")  →  AFTER (2 s)  →  CHANGE (2.5 s)
//   CHANGE: blocks past the case's own threshold FLASH (1.5 a second, limit 3) and rise a little; every
//   other block dims to 25% grey; the camera glides to the largest flashing cluster (and back at the next
//   BEFORE). RED = the radar value fell (burned, lost, sank); CYAN = it rose (new structures, new water);
//   ORANGE = a trap (Jebel Ali's 28 Oct interference), so red only ever means "fell".
//   A caption gives the key measured number and a legend line says what the flashing colour means.
// Cases with 3+ passes step through each one (Tonle Sap 19 Jun → 30 Aug → 17 Oct; Jakarta's 8 dates,
// with the blocks sinking by the measured motion, exaggerated by a stated factor).
//
// What is real here: every colour is a real pass layer; the fade is only a cross-fade between two real
// passes (the banner says so); the flash rule and every caption number come from the case's numbers
// file (cases/replay.json only says WHICH rule and WHICH measured label). Pass dates come from the
// numbers file too (its NASA files minus passes left out by quality control). In Live Ops the replay
// never uses a pass dated after the event (limit), like the cards' availableOn.
//
// This file only keeps time and draws the controls; js/caseterrain.js does the drawing on the GPU
// (the "adapter": before/after colours as per-block attributes + one blend uniform).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtShort = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const fmtDate = (iso) => `${fmtShort(iso)} ${iso.slice(0, 4)}`;
const isDated = (l) => /^\d{4}-\d{2}-\d{2}$/.test(l?.date || '');
const rangeOf = (l) => { const m = /^(\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})$/.exec(l?.date || ''); return m ? [m[1], m[2]] : null; };
const family = (l) => `${l.kind}|${l.unit}|${(l.scale || []).join(',')}`;

const HOLD_MS = 2000, FADE_MS = 1000, CHANGE_MS = 2500;      // the loop at 1× speed
const MANY_HOLD_MS = 1000, MANY_FADE_MS = 600;                // 5+ passes (Jakarta): shorter steps
const SPEEDS = [0.5, 1, 2];
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

let configPromise = null;
export function loadReplayConfig() {
  configPromise ||= fetch('cases/replay.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return configPromise;
}

// The verdict's own pass dates: every date in the numbers file's NASA files, minus those left out by QC
function verdictDates(numbers) {
  const set = new Set();
  for (const f of numbers?.provenance?.nasa_files || []) {
    if (f.date) set.add(f.date);
    if (f.dates) for (const d of String(f.dates).split('→')) set.add(d.trim());
  }
  return { set, excluded: numbers?.quality_control?.excluded_passes || {} };
}

// Fill a caption template from the numbers file. Any missing value -> null (no caption at all).
function fill(tpl, { numbers, method, dates = {}, layer = null, qc = '', threshold = null }) {
  if (!tpl) return null;
  let missing = false;
  tpl = tpl.replace(/\{threshold\}/g, () => (threshold != null ? String(threshold) : ((missing = true), '')));
  let s = tpl.replace(/\{(date|first|last)\}/g, (_, k) => (dates[k] ? fmtShort(dates[k]) : ((missing = true), '')));
  s = s.replace(/\{layer\}/g, () => (layer?.label ? layer.label : ((missing = true), '')));
  s = s.replace(/\{m:([^}]+)\}/g, (_, label) => {
    const m = (numbers?.measured || []).find((x) => x.label === label);
    if (!m || m.value == null || m.value === 'pending') { missing = true; return ''; }
    return `${m.value}${m.unit ? ' ' + m.unit : ''}`.trim();
  });
  s = s.replace(/\{method:([A-Za-z_]+)(\|abs)?\}/g, (_, k, abs) => {
    const v = method?.[k];
    if (typeof v !== 'number') { missing = true; return ''; }
    return String(abs ? Math.abs(v) : v);
  });
  s = s.replace(/\{badge\}/g, () => numbers?.badge || ((missing = true), ''));
  s = s.replace(/\{badge_reason\}/g, () => numbers?.badge_reason || ((missing = true), ''));
  s = s.replace(/\{qc\}/g, () => qc || ((missing = true), ''));
  return missing ? null : s;
}

// Which passes to loop and which blocks flash. Returns null if fewer than 2 passes qualify.
//   limit: Live Ops event date (no pass after it); trap: Jebel Ali's "Show the trap" version
export function buildPlan({ caseId, grid, numbers, config, limit = null, trap = false, flashRule = null, live = false }) {
  const cfg = config?.cases?.[caseId] || null;
  const method = numbers?.method || null;
  const { set, excluded } = verdictDates(numbers);
  const dated = grid.layers.filter(isDated);
  let fam;
  if (cfg) fam = dated.filter((l) => l.unit === cfg.unit);
  else {                                        // any other case: its largest family of dated layers
    const groups = {};
    for (const l of dated) (groups[family(l)] ||= []).push(l);
    fam = Object.values(groups).sort((a, b) => b.length - a.length)[0] || [];
  }
  const ok = (d) => !limit || d <= limit;
  const byDate = (a, b) => (a.date < b.date ? -1 : 1);
  let steps = fam.filter((l) => (!set.size || set.has(l.date)) && !excluded[l.date] && ok(l.date)).sort(byDate);
  steps = steps.filter((l, k) => k === 0 || l.date !== steps[k - 1].date);
  let trapLayer = null;
  const trapDate = Object.keys(excluded).filter(ok).sort().pop();
  if (cfg?.trap && trapDate) trapLayer = fam.find((l) => l.date === trapDate) || null;
  const trapAvailable = !!(trapLayer && steps.length);
  if (trap) {
    if (!trapAvailable) return null;
    steps = [steps[0], trapLayer];
  }
  if (steps.length < 2) return null;
  const first = steps[0], last = steps[steps.length - 1];

  // ----- the flashing blocks: the same rule the verdict uses (thresholds from the numbers file) -----
  // mask per grid cell: 0 = not past the threshold, 1 = past it and the radar value FELL (red),
  // 2 = past it and the value ROSE (cyan), 3 = a trap (orange). rule.colour: 'red' / 'cyan' / 'orange' for
  // the whole case, 'sign' = per block.
  const rule = trap ? cfg.trap.change : cfg?.change;
  const n = grid.rows * grid.cols;
  const mask = new Uint8Array(n);
  let count = 0, red = 0, cyan = 0, orange = 0;
  const thr = (key) => (typeof method?.[key] === 'number' ? method[key] : null);
  const diff = (i) => last.values[i] - first.values[i];
  let test = null, dir = null;
  if (rule?.layer) {
    const L = grid.layers.find((l) => l.id === rule.layer);
    const r = rangeOf(L);
    // a precomputed layer is only used if it spans exactly the replayed passes (never later data)
    const t = rule.gte ?? (rule.gte_method ? thr(rule.gte_method) : null);
    if (L && r && r[0] === first.date && r[1] === last.date && t != null) test = (i) => L.values[i] != null && L.values[i] / 10 >= t;
  } else if (rule?.diff_abs_gte != null || rule?.diff_abs_method) {
    const t = rule.diff_abs_gte ?? Math.abs(thr(rule.diff_abs_method) ?? NaN);
    if (Number.isFinite(t)) { test = (i) => first.values[i] != null && last.values[i] != null && Math.abs(diff(i)) / 10 >= t; dir = diff; }
  } else if (rule?.last_lte_method) {
    const t = thr(rule.last_lte_method);
    if (t != null) test = (i) => last.values[i] != null && last.values[i] / 10 <= t;
  } else if (!cfg && flashRule) {
    const fr = flashRule(caseId, last, method);
    if (fr) { test = (i) => first.values[i] != null && last.values[i] != null && fr.test(first.values[i] / 10, last.values[i] / 10); dir = diff; }
  }
  const mode = rule?.colour || (cfg ? 'red' : 'sign');
  if (test) {
    for (let i = 0; i < n; i++) {
      if (!test(i)) continue;
      count++;
      if (mode === 'orange') { mask[i] = 3; orange++; continue; }
      const rose = mode === 'cyan' || (mode === 'sign' && dir && dir(i) > 0);
      mask[i] = rose ? 2 : 1;
      if (rose) cyan++; else red++;
    }
  }
  const focus = count ? largestCluster(mask, grid.rows, grid.cols) : null;

  // ----- captions -----
  const dates = { first: first.date, last: last.date };
  const qc = trap ? excluded[last.date] : '';
  let captionTpl = trap ? cfg.trap.caption : cfg?.caption;
  if (live && /\{badge/.test(captionTpl || '')) captionTpl = captionTpl.replace(/\s*·\s*badge \{badge\}: \{badge_reason\}/, '');   // Live Ops asks you to guess the badge
  const caption = fill(captionTpl, { numbers, method, dates, qc }) || '';
  const legend = test ? (fill(rule?.legend || '', { numbers, method, dates, threshold: rule?.diff_abs_gte ?? null }) || '') : '';
  const swatch = orange ? 'orange' : red && cyan ? 'both' : red ? 'red' : cyan ? 'cyan' : '';
  const stepCaptions = steps.map((l) => fill(cfg?.stepCaption, { numbers, method, dates: { ...dates, date: l.date }, layer: l }) || '');

  // Jakarta: blocks sink by the measured motion, exaggerated so the largest value on the scale is maxWorldM
  let sink = null;
  if (cfg?.sink && first.unit === 'mm') {
    const maxMm = Math.max(...first.scale.map(Math.abs));
    sink = { factor: Math.round(cfg.sink.maxWorldM / (maxMm / 1000)) };
  }
  return {
    caseId, trap, steps, mask, count, red, cyan, orange, focus, caption, legend, swatch, stepCaptions, sink,
    label: trap ? cfg.trap.label : null,
    trapAvailable, trapButton: cfg?.trap?.button || null,
  };
}

// The largest group of touching flashing blocks (8 neighbours): where the camera glides in CHANGE
function largestCluster(mask, rows, cols) {
  const seen = new Uint8Array(mask.length), stack = new Int32Array(mask.length);
  let best = null;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0, cnt = 0, sr = 0, sc = 0, r0 = rows, r1 = -1, c0 = cols, c1 = -1;
    stack[sp++] = s; seen[s] = 1;
    while (sp) {
      const i = stack[--sp], r = (i / cols) | 0, c = i % cols;
      cnt++; sr += r; sc += c;
      if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
        const j = rr * cols + cc;
        if (mask[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
      }
    }
    if (!best || cnt > best.blocks) best = { blocks: cnt, r: sr / cnt, c: sc / cnt, spanRows: r1 - r0 + 1, spanCols: c1 - c0 + 1 };
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// The loop and its controls. adapter = { setPair(a, b), setMix(t), setChange(on), setMask(mask),
//   setOn(bool, plan), setBanner(b | null), setLabel(text | null), focus(cluster | null) }
export function createReplay({ slot, adapter, onTrapToggle }) {
  const box = document.createElement('div');
  box.className = 'terrain-hud rp';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Change replay');
  box.hidden = true;
  box.innerHTML = `
    <button type="button" class="ghost-btn rp-play" aria-label="Pause the change replay">❚❚</button>
    <div class="rp-scrub">
      <div class="rp-marks" aria-hidden="true"></div>
      <input type="range" class="rp-range" min="0" max="1000" step="1" value="0" aria-label="Change replay position">
    </div>
    <button type="button" class="ghost-btn rp-speed" aria-label="Replay speed 1×, press to change">1×</button>
    <button type="button" class="ghost-btn rp-trap" aria-pressed="false" hidden></button>`;
  slot.appendChild(box);
  const playBtn = box.querySelector('.rp-play'), range = box.querySelector('.rp-range');
  const marks = box.querySelector('.rp-marks'), speedBtn = box.querySelector('.rp-speed'), trapBtn = box.querySelector('.rp-trap');

  let plan = null, phases = [], total = 0, t = 0, last = 0, playing = true, frozen = false, speed = 1;
  let curPhase = -1, curPair = null, on = false;

  function makePhases(p) {
    const many = p.steps.length >= 5;
    const hold = many ? MANY_HOLD_MS : HOLD_MS, fade = many ? MANY_FADE_MS : FADE_MS;
    const out = [];
    p.steps.forEach((s, k) => {
      if (k > 0) out.push({ kind: 'fade', a: k - 1, b: k, ms: fade });
      out.push({ kind: k === 0 ? 'before' : k === p.steps.length - 1 ? 'after' : 'step', at: k, ms: hold });
    });
    out.push({ kind: 'change', at: p.steps.length - 1, ms: CHANGE_MS });
    let t0 = 0;
    for (const ph of out) { ph.t0 = t0; t0 += ph.ms; }
    return out;
  }

  function bannerFor(ph) {
    const s = plan.steps, sc = plan.stepCaptions;
    const sinkNote = plan.sink ? `motion shown ×${plan.sink.factor} (sinking blocks drop)` : '';
    const join = (...xs) => xs.filter(Boolean).join(' · ');
    if (ph.kind === 'fade') {
      return { main: 'fading between two real passes (no data in between)', short: 'fading · no data between',
        sub: join(`${fmtDate(s[ph.a].date)} → ${fmtDate(s[ph.b].date)}`, sinkNote), phase: 'fade',
        title: `Fading ${fmtShort(s[ph.a].date)} → ${fmtDate(s[ph.b].date)}`,
        when: 'Change replay · a cross-fade between two real passes, no data in between · ◀ ▶ pauses it' };
    }
    if (ph.kind === 'change') {
      return { main: `CHANGE · ${fmtShort(s[0].date)} → ${fmtDate(s[s.length - 1].date)}`, short: `CHANGE · ${fmtShort(s[0].date)} → ${fmtShort(s[s.length - 1].date)}`,
        sub: join(plan.caption, sinkNote), key: plan.legend, swatch: plan.swatch, phase: 'change',
        title: `CHANGE ${fmtShort(s[0].date)} → ${fmtDate(s[s.length - 1].date)}`,
        when: `Change replay · ${plan.legend || 'what changed between the two passes'} · ◀ ▶ pauses it` };
    }
    const d = s[ph.at].date;
    const word = ph.kind === 'before' ? 'BEFORE' : ph.kind === 'after' ? 'AFTER' : 'PASS';
    return { main: `${word} · ${fmtDate(d)}`, short: `${word} · ${fmtShort(d)}`, sub: join(sc[ph.at], sinkNote), phase: ph.kind,
      title: `${word} · ${fmtDate(d)}`, when: `Change replay · ${s[ph.at].label} · ◀ ▶ pauses it` };
  }

  function pairOf(ph) {
    if (ph.kind === 'fade') return [ph.a, ph.b];
    const k = ph.at;
    return k === 0 ? [0, 1] : [k - 1, k];
  }

  function apply(force = false) {
    if (!plan || !on) return;
    let i = phases.findIndex((ph) => t >= ph.t0 && t < ph.t0 + ph.ms);
    if (i < 0) i = phases.length - 1;
    const ph = phases[i], u = Math.min(1, (t - ph.t0) / ph.ms);
    const pair = pairOf(ph);
    if (force || !curPair || pair[0] !== curPair[0] || pair[1] !== curPair[1]) {
      curPair = pair;
      adapter.setPair(plan.steps[pair[0]], plan.steps[pair[1]]);
    }
    const mix = ph.kind === 'fade' ? ease(u) : ph.kind === 'before' ? 0 : 1;
    adapter.setMix(mix);
    adapter.setChange(ph.kind === 'change' ? Math.min(1, (t - ph.t0) / 300) : 0);
    if (force || i !== curPhase) {
      curPhase = i;
      adapter.setBanner(bannerFor(ph));
      adapter.setLabel(plan.label && (ph.kind === 'after' || ph.kind === 'change') ? plan.label : null);
      // the camera glides to the largest flashing cluster in CHANGE, and back at the next BEFORE
      if (ph.kind === 'change') adapter.focus?.(plan.focus);
      else if (ph.kind === 'before') adapter.focus?.(null);
    }
    range.value = String(Math.round((t / total) * 1000));
  }

  function tick(now) {
    const dt = last ? Math.min(100, now - last) : 0;
    last = now;
    if (!plan || !on) return;
    if (playing && !frozen) t = (t + dt * speed) % total;
    apply();
  }

  function setPlaying(p) {
    playing = p;
    playBtn.textContent = p ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', p ? 'Pause the change replay' : 'Play the change replay');
    box.classList.toggle('is-paused', !p);
  }

  function load(p) {
    plan = p;
    curPhase = -1; curPair = null; t = 0; frozen = false;
    if (!p) { stop(); return; }
    phases = makePhases(p);
    total = phases.reduce((a, ph) => a + ph.ms, 0);
    marks.innerHTML = phases.map((ph) => `<span class="rp-mark rp-mark-${ph.kind}" style="left:${((ph.t0 / total) * 100).toFixed(2)}%"></span>`).join('');
    trapBtn.hidden = !p.trapAvailable;
    trapBtn.textContent = p.trap ? 'Back to the real change' : (p.trapButton || 'Show the trap');
    trapBtn.setAttribute('aria-pressed', String(!!p.trap));
    box.classList.toggle('is-trap', !!p.trap);
    box.hidden = false;
    adapter.setMask(p.mask);
    on = true;
    adapter.setOn(true, p);
    setPlaying(true);
    apply(true);
  }

  function stop() {
    on = false;
    plan = null;
    adapter.focus?.(null);
    box.hidden = true;
    adapter.setOn(false, null);
    adapter.setBanner(null);
    adapter.setLabel(null);
  }

  playBtn.addEventListener('click', () => api.toggle());
  speedBtn.addEventListener('click', () => {
    speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    speedBtn.textContent = `${speed}×`;
    speedBtn.setAttribute('aria-label', `Replay speed ${speed}×, press to change`);
  });
  range.addEventListener('input', () => {
    if (!plan) return;
    if (!on) { on = true; adapter.setOn(true, plan); apply(true); }
    t = (Number(range.value) / 1000) * total * 0.9999;
    apply();
  });
  trapBtn.addEventListener('click', () => onTrapToggle?.(!plan?.trap));

  const api = {
    load,
    stop,
    tick,
    // Play / pause. Playing again after the stepper took over turns the replay back on.
    toggle() {
      if (!plan) return;
      if (!on) { on = true; adapter.setOn(true, plan); apply(true); setPlaying(true); return; }
      setPlaying(!playing);
    },
    // The stepper (a person's hand) takes over: the replay pauses and the chosen layer shows
    suspend() {
      if (!plan || !on) return;
      on = false;
      setPlaying(false);
      adapter.focus?.(null);
      adapter.setOn(false, plan);
      adapter.setBanner(null);
      adapter.setLabel(null);
    },
    // Live Ops: hold on the AFTER phase while a trap card is on screen, then carry on
    freeze(f) {
      if (!plan) return;
      frozen = !!f;
      if (frozen) {
        const after = phases.find((ph) => ph.kind === 'after');
        if (after) { t = after.t0 + 1; if (!on) { on = true; adapter.setOn(true, plan); } apply(true); }
      }
    },
    setSpeed(s) { if (SPEEDS.includes(s)) { speed = s; speedBtn.textContent = `${s}×`; } },
    get active() { return !!plan && on; },
    get plan() { return plan; },
    // which layer is on screen now (for the hover tooltip), and a summary for tests
    currentLayer() {
      if (!plan || !on || curPhase < 0) return null;
      const ph = phases[curPhase];
      return plan.steps[ph.kind === 'fade' ? (t - ph.t0 < ph.ms / 2 ? ph.a : ph.b) : ph.at];
    },
    get state() {
      if (!plan) return null;
      const ph = phases[curPhase] || null;
      return { phase: ph?.kind, t: Math.round(t), total, playing, frozen, speed, on, trap: plan.trap,
        dates: plan.steps.map((s) => s.date), outlined: plan.count, red: plan.red, cyan: plan.cyan, orange: plan.orange, focus: plan.focus, legend: plan.legend, caption: plan.caption, label: plan.label,
        sinkFactor: plan.sink?.factor || null, phaseIndex: curPhase, phases: phases.map((p) => ({ kind: p.kind, t0: p.t0, ms: p.ms })) };
    },
  };
  return api;
}

