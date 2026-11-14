// The timeline under the globe: 1 Jun -> 10 Nov 2026, one step per day.
//  - The ◀ ▶ buttons jump 12 days = one NISAR repeat cycle (it passes over the same spot every 12 days).
//  - Ticks show the selected case's REAL pass dates (from cases/passes.json).
//  - NASA's data gap (27 Jul - 10 Aug 2026, no NISAR data anywhere) is shaded and labelled.
//  - Moving across a case's pass date tells main.js, which makes that case's beacon pulse.
//  - Every move also reports the date (onDay), so unverified tips appear on their own dates.
//  - While a case terrain is open, the slider picks the terrain layer (main.js connects them):
//    brighter "layer" ticks mark the passes we actually processed, and setDate() lets the
//    terrain's ◀ ▶ stepper move the slider back, so the two always agree.

const DAY = 86400000;
const START = Date.UTC(2026, 5, 1);    // 1 Jun 2026 (months count from 0)
const END = Date.UTC(2026, 10, 10);    // 10 Nov 2026
const TOTAL_DAYS = Math.round((END - START) / DAY);
const GAP = ['2026-07-27', '2026-08-10'];
const REPEAT_DAYS = 12;

const dayOf = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - START) / DAY);
const fmt = (day) => new Date(START + day * DAY).toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
// Position along the track, matching where the slider's 14 px thumb centre sits
const pos = (day) => `calc(7px + (100% - 14px) * ${day / TOTAL_DAYS})`;

export function createTimeline(root, cases, { onCross, onDay }) {
  root.innerHTML = `
    <div class="tl-head">
      <span class="timeline-label">NISAR passes</span>
      <span class="tl-date" id="tl-date"></span>
      <span class="tl-case" id="tl-case">Pick a case to see its passes</span>
      <span class="tl-buttons">
        <button class="tl-btn" id="tl-back" title="Back 12 days (one NISAR repeat)">◀ 12 d</button>
        <button class="tl-btn" id="tl-play" title="Play">▶ Play</button>
        <button class="tl-btn" id="tl-fwd" title="Forward 12 days (one NISAR repeat)">12 d ▶</button>
      </span>
    </div>
    <div class="tl-track">
      <div class="tl-gap" style="left:${pos(dayOf(GAP[0]))}; width:calc((100% - 14px) * ${(dayOf(GAP[1]) - dayOf(GAP[0])) / TOTAL_DAYS})"
           title="No NISAR data was released for 27 Jul – 10 Aug 2026">NASA data gap</div>
      <div class="tl-ticks" id="tl-ticks"></div>
      <div class="tl-ticks" id="tl-layer-ticks"></div>
      <input class="tl-slider" id="tl-slider" type="range" min="0" max="${TOTAL_DAYS}" step="1" value="0"
             aria-label="Date">
      <div class="tl-months" id="tl-months"></div>
    </div>`;

  const slider = root.querySelector('#tl-slider');
  const dateEl = root.querySelector('#tl-date');
  const caseEl = root.querySelector('#tl-case');
  const ticksEl = root.querySelector('#tl-ticks');
  const layerTicksEl = root.querySelector('#tl-layer-ticks');
  const playBtn = root.querySelector('#tl-play');

  // Month labels on the 1st of each month
  const months = root.querySelector('#tl-months');
  for (let m = 5; m <= 10; m++) {
    const d = Math.round((Date.UTC(2026, m, 1) - START) / DAY);
    const span = document.createElement('span');
    span.style.left = pos(d);
    span.textContent = new Date(Date.UTC(2026, m, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    months.appendChild(span);
  }

  // Each case's pass days, for the "crossed a pass" check
  const passDays = cases.map((c) => ({ id: c.id, days: c.passDates.map(dayOf) }));

  let current = 0;
  let selected = null;

  // Header text: the case's pass count, or the pass details when the slider sits on a pass date
  function updateCaseText() {
    if (!selected) {
      caseEl.textContent = 'Pick a case to see its passes';
      return;
    }
    const here = selected.passes.filter((p) => dayOf(p.date) === current)
      .map((p) => `track ${p.track} ${p.direction === 'A' ? 'ascending' : 'descending'}, frame ${p.frame}`);
    caseEl.textContent = here.length
      ? `${selected.name}: NISAR passed over today — ${here.join('; ')}`
      : `${selected.name}: ${selected.passDates.length} NISAR passes (${selected.product}) in this window`;
    caseEl.classList.toggle('on-pass', here.length > 0);
  }

  function setDay(day) {
    day = Math.max(0, Math.min(TOTAL_DAYS, day));
    const lo = Math.min(current, day);
    const hi = Math.max(current, day);
    if (day !== current) {
      for (const c of passDays) {
        // passes strictly after where we were, up to and including where we are now
        if (c.days.some((d) => (day > current ? d > lo && d <= hi : d >= lo && d < hi))) onCross(c.id);
      }
    }
    current = day;
    onDay?.(new Date(START + day * DAY).toISOString().slice(0, 10));
    slider.value = day;
    dateEl.textContent = fmt(day);
    updateCaseText();
  }

  slider.addEventListener('input', () => setDay(Number(slider.value)));
  root.querySelector('#tl-back').addEventListener('click', () => setDay(current - REPEAT_DAYS));
  root.querySelector('#tl-fwd').addEventListener('click', () => setDay(current + REPEAT_DAYS));

  // Play: one day every 80 ms (about 13 seconds for the whole window)
  let timer = null;
  function stop() { clearInterval(timer); timer = null; playBtn.textContent = '▶ Play'; }
  playBtn.addEventListener('click', () => {
    if (timer) return stop();
    if (current >= TOTAL_DAYS) setDay(0);
    playBtn.textContent = '❚❚ Pause';
    timer = setInterval(() => {
      if (current >= TOTAL_DAYS) return stop();
      setDay(current + 1);
    }, 80);
  });

  setDay(0);

  return {
    // Move the slider to a date (used by the terrain stepper). Same as the player moving it.
    setDate(iso) { if (dayOf(iso) !== current) setDay(dayOf(iso)); },
    get date() { return new Date(START + current * DAY).toISOString().slice(0, 10); },
    // Show or hide the whole bar (hidden when it would change nothing in the open view)
    setVisible(show) { root.hidden = !show; if (!show) stop(); },
    // Brighter ticks for the passes that have a processed terrain layer (or none with null)
    setLayerTicks(dates) {
      layerTicksEl.innerHTML = '';
      for (const iso of dates || []) {
        const tick = document.createElement('span');
        tick.className = 'tl-tick tl-tick-layer';
        tick.style.left = pos(dayOf(iso));
        tick.title = `Processed pass: ${fmt(dayOf(iso))}`;
        layerTicksEl.appendChild(tick);
      }
    },
    refresh() { setDay(current); onDay?.(new Date(START + current * DAY).toISOString().slice(0, 10)); },
    // Show one case's real passes as ticks (or none with null)
    setCase(c) {
      selected = c;
      ticksEl.innerHTML = '';
      if (c) {
        for (const iso of c.passDates) {
          const tick = document.createElement('span');
          tick.className = 'tl-tick';
          tick.style.left = pos(dayOf(iso));
          ticksEl.appendChild(tick);
        }
      }
      updateCaseText();
    },
  };
}
