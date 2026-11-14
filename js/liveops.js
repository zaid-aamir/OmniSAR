// Live Ops: the game loop. Three "days" replay real 2026 NISAR passes on their real dates.
// Each day: a title card, the top-bar date counts up, red alert rods rise where passes land.
// Each event (one pass over one case): an alert banner, the globe flies there, the case terrain
// opens on the latest processed pass on or before that date, then evidence cards deal in one by
// one. The player calls each card against a timer: Real change / Trap / Wait for next pass.
// Then the case's own final question, a confidence pick (Strong / Moderate / Weak), and the
// reveal of OmniSAR's real verdict from the case's numbers file.
//
// Honesty rules built in here:
//   - the day plan (cases/liveops.json) only names cards and dates; every card's text, image and
//     right answer come from cases/<id>.json, every number from cases/<id>.numbers.json
//   - a card is only dealt if its availableOn date (the last pass or data it uses) is on or before
//     the event date; anything else is dropped at load with a console warning, never shown early
//   - "Wait for next pass" is right only on cards listed in liveops.json "waitEligible", each
//     backed by a quote from that card's own caption
//   - the reveal says when OmniSAR processed the case, so nobody mistakes it for a live result
//
// API (see reports/liveops_contract.md, section 4):
//   createLiveOps({ globe, markers, terrain, panel, hud, effects, ripples, data }) -> { start, stop }
//   events on window: liveops:day { day, date } · liveops:end { score, best } · liveops:exit {}
//                     liveops:traplab { trap }  (a trap button on the end screen; the app opens the Trap Lab)

import { esc, announce } from './util.js';
import { loadTraps } from './trapcard.js';

// Each event shows the globe with its red ripples for at least this long before the terrain opens
const GLOBE_RIPPLE_MS = 3000;

// Timing for each speed. normal ≈ 4–5 min for a quick player, fast ≈ 90 s (see the report)
const SPEEDS = {
  normal: { cardS: 20, dayCardMs: 2200, countMs: 1200, bannerMs: 1700, flyS: 1.6, flipMs: 450,
    dealGapMs: 250, rightHoldMs: 1800, wrongHoldMs: 5000, dayEndMs: 4000, rodsMs: 700 },
  fast: { cardS: 10, dayCardMs: 900, countMs: 400, bannerMs: 600, flyS: 0.6, flipMs: 300,
    dealGapMs: 50, rightHoldMs: 500, wrongHoldMs: 2000, dayEndMs: 1500, rodsMs: 200 },
};
// Scoring (the same at both speeds)
const POINTS = { right: 100, perSecondLeft: 5, wrong: -50, finalRight: 100, confidence: 150 };
const BEST_KEY = 'omnisar.liveops.best';
const CASE_DISTANCE = 1.45;          // how close the globe camera flies to a case (same as classic mode)
const DAY_DISTANCE = 2.6;            // day intro: far enough out to see the day's rods rise
const HOME_DISTANCE = 3.2;           // end screen (same as classic mode's home view)
const CONFIDENCE = ['Strong', 'Moderate', 'Weak'];
const CANCEL = Symbol('liveops-cancelled');
// The honesty line (exact text from the contract), repeated under each day's queue
const HONESTY = 'A replay of real 2026 NISAR passes on their real dates. In reality, processed NISAR data reaches users days after a pass.';

// "15 Sep 2026": a fixed month table (some browsers' en-GB says "Sept")
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const fmtUp = (iso) => fmtDate(iso).toUpperCase();
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const badgeWord = (b) => CONFIDENCE.find((w) => new RegExp(`^${w}\\b`, 'i').test(String(b || '').trim())) || null;

function readBest() {
  try { return Math.max(0, Number(localStorage.getItem(BEST_KEY)) || 0); } catch { return 0; }
}
function writeBest(n) {
  try { localStorage.setItem(BEST_KEY, String(n)); } catch { /* storage blocked: best only for this visit */ }
}

// One play-through. Everything it waits for goes through waitFor(), so stop() can cancel it all.
function makeRun() {
  const waits = new Set();
  const run = {
    alive: true,
    terrainOpened: false,
    // setup(done) starts something and may return a cleanup function
    waitFor(setup) {
      return new Promise((resolve, reject) => {
        if (!run.alive) { reject(CANCEL); return; }
        let cleanup = null, open = true;
        const entry = {
          cancel() { if (!open) return; open = false; waits.delete(entry); cleanup?.(); reject(CANCEL); },
        };
        waits.add(entry);
        const done = (v) => { if (!open) return; open = false; waits.delete(entry); cleanup?.(); resolve(v); };
        const c = setup(done);
        if (open) cleanup = c || null; else c?.();
      });
    },
    sleep(ms) { return run.waitFor((done) => { const t = setTimeout(done, ms); return () => clearTimeout(t); }); },
    guard(p) { return run.waitFor((done) => { Promise.resolve(p).then(done, () => done(undefined)); }); },
    cancel() { run.alive = false; [...waits].forEach((w) => w.cancel()); },
  };
  return run;
}

export function createLiveOps({ globe, markers, terrain, panel, hud, effects, ripples, data }) {
  const root = panel.root;
  const byId = Object.fromEntries(data.cases.map((c) => [c.id, c]));
  const cache = new Map();             // caseId -> Promise<{ mystery, numbers }>
  let planPromise = null;
  let run = null;                      // the current play-through
  let keyHandler = null;               // number keys while a question is on screen
  let banner = null;
  let S = SPEEDS.normal;               // speed of the current run
  let st = null;                       // score and history of the current run (for api.debug)

  // ---------- data ----------
  function loadCase(id) {
    if (!cache.has(id)) {
      const c = byId[id];
      cache.set(id, Promise.all([
        fetch(c.mysteryFile).then((r) => r.json()),
        c.numbersPath ? fetch(c.numbersPath).then((r) => r.json()) : null,
      ]).then(([mystery, numbers]) => ({ mystery, numbers })));
      cache.get(id).catch(() => cache.delete(id));
    }
    return cache.get(id);
  }

  // The day plan, checked against the case files: a card that is missing, pending, has no image
  // or isn't available by the event date is dropped (and logged), never shown.
  function loadPlan() {
    planPromise ??= (async () => {
      const plan = await fetch('cases/liveops.json').then((r) => r.json());
      for (const d of plan.days) {
        for (const ev of d.events) {
          ev.isLastOfDay = ev === d.events[d.events.length - 1];   // its button says "Day summary"
          const { mystery } = await loadCase(ev.caseId);
          ev.deal = [];
          for (const id of ev.cards) {
            const card = mystery.evidence.find((e) => e.id === id);
            const why = !card ? 'not in the case file' : card.pending ? 'pending' : !card.src ? 'no image'
              : !(card.bin === 'real' || card.bin === 'trap') ? 'no answer'
              : !card.availableOn ? 'no availableOn date' : card.availableOn > ev.date ? `available only from ${card.availableOn}` : null;
            if (why) { console.warn(`Live Ops: card ${ev.caseId}/${id} left out of ${ev.id}: ${why}`); continue; }
            ev.deal.push(card);
          }
          // the case's last question before its verdict
          const steps = mystery.steps;
          const vi = steps.findIndex((s) => s.type === 'verdict');
          const last = steps.slice(0, vi < 0 ? steps.length : vi).reverse().find((s) => s.type === 'choice');
          ev.finalChoice = last ? mystery.choices[last.choice] : null;
        }
      }
      return plan;
    })();
    planPromise.catch(() => { planPromise = null; });   // a failed load is retried on the next start
    return planPromise;
  }

  // ---------- small UI helpers (shared by every run) ----------
  // Number keys: 1..n press the nth button of the question on screen
  function onKey(e) {
    if (!keyHandler || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    if (document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (keyHandler(e.key)) e.preventDefault();
  }
  function keysFor(buttons) {
    keyHandler = (key) => {
      const i = Number(key) - 1;
      if (!(i >= 0 && i < buttons.length) || buttons[i].disabled) return false;
      buttons[i].click();
      return true;
    };
  }

  // The red INCOMING banner over the globe (visual; screen readers get the same text once)
  function showBanner(text, sub) {
    hideBanner(true);
    const host = document.getElementById('globe-area') || document.body;
    banner = document.createElement('div');
    banner.className = 'lo-banner';
    banner.setAttribute('aria-hidden', 'true');
    banner.innerHTML = `<span class="lo-banner-stripes"></span><p class="lo-banner-main">${esc(text)}</p><p class="lo-banner-sub">${esc(sub)}</p>`;
    host.appendChild(banner);
    announce(`${text}. ${sub}`);
  }
  function hideBanner(now = false) {
    const b = banner;
    banner = null;
    if (!b) return;
    if (now) { b.remove(); return; }
    b.classList.add('is-leaving');
    setTimeout(() => b.remove(), 350);
  }

  function leaveTerrain() {
    if (terrain.isOpen) terrain.close();
    globe.setPaused(false);
  }

  const currentRun = () => run;

  // ---------- the game ----------
  // Each play-through gets its own copy of these functions, bound to ITS run, score state and
  // speed, so a cancelled run (Replay, stop) can never write into the next one.
  function makeGame(run, st, S) {
    const view = (cls, html) => {
      if (!run.alive) throw CANCEL;        // a cancelled run never draws again
      const el = document.createElement('div');
      el.className = `lo ${cls}`;
      el.innerHTML = html;
      root.replaceChildren(el);            // a new child = a new view (the HUD plays its sweep)
      return el;
    };
    const scoreHTML = () => `<p class="lo-score" aria-label="Score">SCORE <b class="lo-score-n">${st.shown}</b></p>`;

    // Score counts up (or down) to the new value on every score readout on screen
    function addScore(delta) {
      const from = st.score;
      st.score = Math.max(0, st.score + delta);
      st.dayScore += st.score - from;
      const to = st.score, t0 = performance.now(), ms = 600;
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / ms);
        st.shown = Math.round(from + (to - from) * (1 - (1 - k) ** 3));
        root.querySelectorAll('.lo-score-n').forEach((el) => { el.textContent = st.shown; });
        if (k < 1 && run?.alive) requestAnimationFrame(tick); else st.shown = to;
      };
      requestAnimationFrame(tick);
    }

    // The HUD date in the top bar counts up from one date to the next (about 10 steps)
    async function countHud(day, from, to, ms) {
      const n = Math.max(0, daysBetween(from, to));
      if (n === 0) { hud.setDay(day, to); return; }
      const steps = Math.min(10, n);
      for (let k = 1; k <= steps; k++) {
        hud.setDay(day, addDays(from, Math.round((n * k) / steps)));
        if (k < steps) await run.sleep(ms / steps);
      }
    }

    async function play(startDay) {
      const plan = await run.guard(loadPlan());
      const traps = await run.guard(loadTraps());
      st.trapTitle = (id) => traps.traps.find((t) => t.id === id)?.title || `Trap #${id}`;
      st.trap = (id) => traps.traps.find((t) => t.id === id) || null;
      st.limit = (id) => traps.limits.find((t) => t.id === id) || null;
      st.wait = plan.waitEligible || {};
      effects.setAlarm(true);
      const days = plan.days.filter((d) => d.day >= startDay);
      const before = plan.days.filter((d) => d.day < startDay).pop();
      let prev = before ? before.events[before.events.length - 1].date : (data.window?.start || days[0].date);
      for (const d of days) {
        await runDay(d, prev, d === days[days.length - 1]);
        prev = d.events[d.events.length - 1].date;
      }
      await endGame(days);
    }

    async function runDay(d, prevDate, isLast) {
      st.dayScore = 0;
      st.dayNo = d.day;
      const n = d.events.length;
      leaveTerrain();
      markers.setEvents([]);
      const first = byId[d.events[0].caseId].centre;
      globe.flyTo(first[0], first[1], DAY_DISTANCE, S.flyS);
      view('lo-intro', `
        <p class="eyebrow">LIVE OPS · DAY ${d.day} OF 3</p>
        <h2 class="lo-title" tabindex="-1">${n} incoming</h2>
        ${scoreHTML()}
        <ol class="lo-queue-list">${d.events.map((e) => `<li><b>${esc(byId[e.caseId].name)}</b> · ${esc(fmtDate(e.date))}</li>`).join('')}</ol>
        <p class="evidence-caption">${esc(HONESTY)}</p>`);
      window.dispatchEvent(new CustomEvent('liveops:day', { detail: { day: d.day, date: d.date } }));
      const title = `DAY ${d.day} · ${fmtUp(d.date)} · ${n} INCOMING`;
      await Promise.all([run.guard(effects.dayCard(title, { ms: S.dayCardMs })), countHud(d.day, prevDate, d.date, S.countMs)]);
      st.lastDate = d.date;
      markers.setEvents(d.events.map((e) => ({ id: e.id, caseId: e.caseId, lat: byId[e.caseId].centre[0], lon: byId[e.caseId].centre[1] })));
      await run.sleep(S.rodsMs);
      for (let k = 0; k < n; k++) await runEvent(d, k);
      await dayEnd(d, isLast);
    }

    async function runEvent(d, k) {
      const ev = d.events[k];
      const c = byId[ev.caseId];
      const { numbers } = await run.guard(loadCase(ev.caseId));
      const left = d.events.length - k - 1;
      const queue = left ? `${left} more incoming` : 'last one today';
      const tracks = [...new Set(c.passes.filter((p) => p.date === ev.date)
        .map((p) => `track ${p.track} ${p.direction === 'A' ? 'ascending' : 'descending'}`))].join(' + ');
      ev.deal.forEach((card) => { const im = new Image(); im.src = card.src; });   // load while we fly
      leaveTerrain();
      const el = view('lo-event', `
        <div class="lo-head">
          <p class="eyebrow">DAY ${d.day} · EVENT ${k + 1} OF ${d.events.length}</p>
          ${scoreHTML()}
        </div>
        <h2 class="lo-title" tabindex="-1">${esc(c.name)} <span class="lo-place">${esc(c.place)}</span></h2>
        <p class="lo-when">NISAR pass · ${esc(fmtDate(ev.date))}${tracks ? ` · ${esc(tracks)}` : ''}</p>
        <p class="lo-queue">${esc(queue)}</p>
        <p class="lo-question">“${esc(c.question)}”</p>
        <p class="lo-terrain-note evidence-caption"></p>
        <ol class="lo-deck" aria-label="Cards in this event">${ev.deal.map((card, i) => `<li class="lo-slot" data-i="${i}"><span class="sr-only">Card ${i + 1}</span></li>`).join('')}</ol>
        <div class="lo-stage"></div>`);
      const stage = el.querySelector('.lo-stage');
      // countdown to the pass, the alert, the flight, the ripples
      await countHud(d.day, st.lastDate || ev.date, ev.date, S.countMs / 2);
      st.lastDate = ev.date;
      showBanner(`INCOMING · NISAR pass · ${c.name} · ${fmtDate(ev.date)}`, `${c.place}${tracks ? ` · ${tracks}` : ''} · ${queue}`);
      markers.flare(ev.id);
      globe.flyTo(c.centre[0], c.centre[1], CASE_DISTANCE, S.flyS);
      ripples.add(ev.id, c.centre[0], c.centre[1]);
      // the globe stays on screen with the ripples running for at least 3 s before the terrain opens
      await run.sleep(Math.max(GLOBE_RIPPLE_MS, S.bannerMs, S.flyS * 1000));
      hideBanner();
      // the case terrain, on the latest processed pass on or before the event date
      const opening = terrain.open(c, numbers?.files?.grid, { numbers, onBackToGlobe: leaveTerrain });
      run.terrainOpened = true;
      // stopped while the grid was loading: close it again, unless a newer run already uses the terrain
      opening.then(() => { const now = currentRun(); if (!run.alive && !(now && now.alive && now.terrainOpened)) leaveTerrain(); });
      const opened = await run.guard(opening);
      const note = el.querySelector('.lo-terrain-note');
      let shown = null;
      if (opened) {
        globe.setPaused(true);
        shown = terrain.showLayerAt(c.id, ev.date, { blendMs: 500 });
        terrain.setAlert(c.centre[0], c.centre[1]);         // the alert ring keeps spreading on the terrain
      }
      note.textContent = !opened ? 'This case has no terrain grid.'
        : !shown ? `Terrain: no processed pass on or before ${fmtDate(ev.date)}.`
          : shown.exact ? `Terrain: the processed pass of ${fmtDate(shown.date)}.`
            : `Terrain: no processed layer for ${fmtDate(ev.date)} yet; showing the latest processed pass before it, ${fmtDate(shown.date)}.`;
      st.log.push({ event: ev.id, date: ev.date, terrain: shown, state: terrain.state });
      // the cards
      for (let i = 0; i < ev.deal.length; i++) {
        el.querySelectorAll('.lo-slot').forEach((s, j) => s.classList.toggle('is-current', j === i));
        await runCard(stage, ev, ev.deal[i], i, el.querySelector(`.lo-slot[data-i="${i}"]`));
        if (i < ev.deal.length - 1) await run.sleep(S.dealGapMs);
      }
      el.querySelectorAll('.lo-slot').forEach((s) => s.classList.remove('is-current'));
      await finalChoice(stage, ev, c);
      await confidencePick(stage, ev, c, numbers);
      ripples.remove(ev.id);
      terrain.setAlert(null);
      markers.setSolved(ev.id);
    }

    // ----- one evidence card, against the clock -----
    async function runCard(stage, ev, card, i, slot) {
      const total = S.cardS;
      const amberAt = total / 2, redAt = total / 4;            // 10 s and 5 s at normal speed
      const isNisar = /^NISAR/.test(card.source || '');
      stage.innerHTML = `
        <article class="lo-card" tabindex="-1" aria-labelledby="lo-card-title" data-case="${esc(ev.caseId)}" data-card="${esc(card.id)}" style="--flip-ms:${S.flipMs}ms">
          <div class="lo-card-top">
            <p class="eyebrow">CARD ${i + 1} OF ${ev.deal.length}</p>
            <div class="lo-timer" role="timer" aria-label="${total} seconds to answer">
              <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="lo-ring-bg" cx="22" cy="22" r="19"/><circle class="lo-ring" cx="22" cy="22" r="19" pathLength="100"/></svg>
              <span class="lo-timer-n" aria-hidden="true">${total}</span>
            </div>
          </div>
          <h3 id="lo-card-title">${esc(card.title)}</h3>
          <img src="${esc(card.src)}" alt="${esc(card.caption)}" decoding="async">
          <p class="evidence-caption">${esc(card.caption)}</p>
          <p class="evidence-source"><span class="tag ${isNisar ? 'tag-nisar' : ''}">${esc(card.source)}</span></p>
          <div class="lo-answers" role="group" aria-label="Your call (keys 1, 2, 3)">
            <button class="lo-answer" data-a="real"><kbd>1</kbd> Real change</button>
            <button class="lo-answer" data-a="trap"><kbd>2</kbd> Trap</button>
            <button class="lo-answer" data-a="wait"><kbd>3</kbd> Wait for next pass</button>
          </div>
          <div class="lo-feedback" role="status"></div>
        </article>`;
      const art = stage.querySelector('.lo-card');
      // the answer bar sticks just above the panel's foot readout, so it is never scrolled out of view
      const foot = document.querySelector('.panel-foot');
      root.closest('.panel')?.style.setProperty('--lo-foot', `${foot ? foot.offsetHeight : 0}px`);
      const ring = art.querySelector('.lo-timer');
      const num = art.querySelector('.lo-timer-n');
      const buttons = [...art.querySelectorAll('.lo-answer')];
      art.focus({ preventScroll: true });
      art.scrollIntoView?.({ block: 'nearest' });
      announce(`Card ${i + 1} of ${ev.deal.length}: ${card.title}. ${total} seconds. Keys 1 real change, 2 trap, 3 wait for next pass.`);
      const t0 = performance.now();
      const answer = await run.waitFor((done) => {
        let phase = '';
        const tick = () => {
          const leftS = Math.max(0, total - (performance.now() - t0) / 1000);
          ring.style.setProperty('--left', (leftS / total).toFixed(4));
          num.textContent = Math.ceil(leftS);
          const p = leftS <= redAt ? 'is-red' : leftS <= amberAt ? 'is-amber' : '';
          if (p !== phase) {
            ring.classList.remove('is-amber', 'is-red');
            if (p) ring.classList.add(p);
            if (p) announce(`${Math.ceil(leftS)} seconds left`);
            phase = p;
          }
          if (leftS <= 0) done({ a: 'timeout', leftS: 0, tookS: total });
        };
        tick();
        const iv = setInterval(tick, 100);
        buttons.forEach((b) => { b.onclick = () => done({ a: b.dataset.a, leftS: Math.max(0, total - (performance.now() - t0) / 1000), tookS: (performance.now() - t0) / 1000, btn: b }); });
        keysFor(buttons);
        return () => { clearInterval(iv); keyHandler = null; };
      });
      buttons.forEach((b) => { b.disabled = true; b.classList.toggle('is-picked', b === answer.btn); });
      ring.classList.add('is-stopped');

      // judge it
      const eligibleQuote = st.wait[`${ev.caseId}/${card.id}`] || null;
      const right = answer.a === card.bin || (answer.a === 'wait' && !!eligibleQuote);
      const trap = card.bin === 'trap' ? st.trap(card.trap) : null;
      const trapLine = trap ? `Trap #${trap.id} · ${trap.title}` : '';
      let head, body = '', delta;
      if (right) {
        const secs = Math.ceil(answer.leftS);
        delta = POINTS.right + secs * POINTS.perSecondLeft;
        head = `Right · +${delta}`;
        if (answer.a === 'wait') body = `Two single dates aren’t enough here: “${eligibleQuote}” More passes let a median outvote one bad date. This card is ${trapLine}.`;
        else body = card.bin === 'real' ? 'Real change: the evidence on the card holds up.' : `${trapLine}.`;
        effects.burst(answer.btn || art);
        if (card.id === ev.teachCard) {
          effects.toast(`Trap ${ev.teachTrap} dodged: ${st.trapTitle(ev.teachTrap)}`);
          st.dodged.add(ev.teachTrap);
        }
      } else {
        delta = POINTS.wrong;
        head = `${answer.a === 'timeout' ? 'Time’s up' : 'Not quite'} · ${delta}`;
        if (card.bin === 'real') {
          body = answer.a === 'wait'
            ? 'No need to wait: this card is a real change, and the evidence on it holds up.'
            : 'This one is a real change: the evidence on the card holds up.';
        } else {
          const lead = answer.a === 'wait' ? 'Another pass won’t fix this one. It’s a trap:' : answer.a === 'real' ? 'Not real. It’s a trap:' : 'It’s a trap:';
          body = `${lead} ${trapLine}. What fools you: ${trap?.fools || ''} How OmniSAR handles it: ${trap?.handling || ''}`;
          st.caughtBy.add(card.trap);
        }
        effects.shake();
      }
      st.cards.push({ event: ev.id, card: card.id, answer: answer.a, right, tookS: answer.tookS });
      addScore(delta);
      if (slot) {
        slot.classList.add(right ? 'is-right' : 'is-wrong');
        slot.querySelector('.sr-only').textContent = `Card ${i + 1}: ${right ? 'right' : 'wrong'}`;
      }
      const fb = art.querySelector('.lo-feedback');
      fb.className = `lo-feedback ${right ? 'ok' : 'bad'}`;
      fb.innerHTML = `<p class="reply-head">${esc(head)}</p><p>${esc(body)}</p><button class="ghost-btn lo-continue">Continue ▶</button>`;
      const cont = fb.querySelector('.lo-continue');
      cont.focus({ preventScroll: true });
      fb.scrollIntoView?.({ block: 'nearest' });
      if (card.bin === 'trap') terrain.replayFreeze?.(true);     // the change replay holds on AFTER while a trap card shows
      await run.waitFor((done) => {
        const t = setTimeout(done, right ? S.rightHoldMs : S.wrongHoldMs);
        cont.onclick = done;
        return () => clearTimeout(t);
      });
      terrain.replayFreeze?.(false);
    }

    // ----- the case's own last question before its verdict -----
    async function finalChoice(stage, ev, c) {
      const ch = ev.finalChoice;
      if (!ch) return;
      stage.innerHTML = `
        <section class="lo-final">
          <p class="eyebrow">YOUR CALL · ${esc(c.name.toUpperCase())}</p>
          <h3 class="lo-q" tabindex="-1">${esc(ch.prompt)}</h3>
          <div class="options lo-options">${ch.options.map((o, i) => `<button class="option" data-i="${i}"><kbd>${i + 1}</kbd> ${esc(o.text)}</button>`).join('')}</div>
          <div class="lo-reply"></div>
        </section>`;
      const q = stage.querySelector('.lo-q');
      q.focus({ preventScroll: true });
      q.scrollIntoView?.({ block: 'nearest' });
      const buttons = [...stage.querySelectorAll('.lo-options .option')];
      const i = await run.waitFor((done) => {
        buttons.forEach((b) => { b.onclick = () => done(Number(b.dataset.i)); });
        keysFor(buttons);
        return () => { keyHandler = null; };
      });
      const o = ch.options[i];
      buttons.forEach((b, j) => {
        b.disabled = true;
        if (ch.options[j].correct) b.classList.add('is-correct');
        else if (j === i) b.classList.add('is-wrong');
      });
      const lim = o.limit ? st.limit(o.limit) : null;
      if (o.correct) { addScore(POINTS.finalRight); effects.burst(buttons[i]); } else effects.shake();
      st.finals.push({ event: ev.id, right: !!o.correct });
      const reply = stage.querySelector('.lo-reply');
      reply.innerHTML = `
        <div class="reply ${o.correct ? 'reply-right' : 'reply-wrong'}" role="status">
          <p class="reply-head">${o.correct ? `Correct · +${POINTS.finalRight}` : 'Not quite: the right answer is marked'}</p>
          <p>${esc(o.reply)}</p>
          ${lim ? `<p class="evidence-caption">${esc(lim.title)}</p>` : ''}
        </div>
        <button class="primary-btn lo-continue">Rate the evidence ▶</button>`;
      const cont = reply.querySelector('.lo-continue');
      cont.focus({ preventScroll: true });
      reply.scrollIntoView?.({ block: 'nearest' });
      await run.waitFor((done) => { cont.onclick = done; keyHandler = (k) => (k === 'Enter' ? (done(), true) : false); return () => { keyHandler = null; }; });
    }

    // ----- confidence, then OmniSAR's real verdict -----
    async function confidencePick(stage, ev, c, numbers) {
      stage.innerHTML = `
        <section class="lo-conf">
          <p class="eyebrow">CONFIDENCE · ${esc(c.name.toUpperCase())}</p>
          <h3 class="lo-q" tabindex="-1">How strong is the evidence?</h3>
          <p class="evidence-caption">Pick the badge you think OmniSAR gave this case. A match earns +${POINTS.confidence}.</p>
          <div class="lo-conf-row">${CONFIDENCE.map((w, i) => `<button class="ghost-btn lo-conf-btn" data-w="${w}"><kbd>${i + 1}</kbd> ${w}</button>`).join('')}</div>
        </section>`;
      stage.querySelector('.lo-q').focus({ preventScroll: true });
      const buttons = [...stage.querySelectorAll('.lo-conf-btn')];
      const pick = await run.waitFor((done) => {
        buttons.forEach((b) => { b.onclick = () => done(b.dataset.w); });
        keysFor(buttons);
        return () => { keyHandler = null; };
      });
      const badge = numbers?.badge || null;
      const word = badgeWord(badge);
      const match = !!word && word === pick;
      if (match) addScore(POINTS.confidence);
      st.confidence.push({ event: ev.id, pick, badge, match });
      const measured = numbers?.measured || [];
      const keys = (ev.keyNumbers || []).map((label) => measured.find((m) => m.label === label)).filter(Boolean);
      const generated = numbers?.generated ? fmtDate(numbers.generated.slice(0, 10)) : null;
      const verdictLine = !badge ? 'This case has no verdict yet: evidence pending.'
        : match ? `You picked ${pick}: a match · +${POINTS.confidence}`
          : word ? `You picked ${pick}. OmniSAR’s badge is ${word}: no bonus.`
            : `You picked ${pick}. OmniSAR’s badge is “${badge}”, which is none of the three: there is no independent check yet, so no bonus is possible here.`;
      stage.innerHTML = `
        <section class="lo-reveal">
          <p class="eyebrow">OMNISAR’S VERDICT${generated ? ` · PROCESSED ${esc(generated.toUpperCase())}` : ''}</p>
          <h3 class="lo-q" tabindex="-1">${badge ? `<span class="tag tag-nisar lo-badge">Evidence: ${esc(badge)}</span>` : 'Evidence pending'}</h3>
          <p class="lo-match ${match ? 'ok' : ''}">${esc(verdictLine)}</p>
          ${keys.length ? `<dl class="facts lo-facts">${keys.map((m) => `<div><dt>${esc(m.label)}</dt><dd><strong>${esc(m.value)}</strong> ${esc(m.unit || '')}</dd></div>`).join('')}</dl>` : ''}
          ${numbers?.check?.text ? `<p class="evidence-caption"><b>${esc(numbers.check.label || 'Check')}:</b> ${esc(numbers.check.text)}</p>` : ''}
          ${numbers?.badge_reason ? `<p class="evidence-caption"><b>Why this badge:</b> ${esc(numbers.badge_reason)}</p>` : ''}
          <p class="evidence-caption">Measured from the passes in the case’s chain of custody, after the fact. Every number above comes from the case’s numbers file.</p>
          <button class="primary-btn lo-continue">${ev.isLastOfDay ? 'Day summary ▶' : 'Next ▶'}</button>
        </section>`;
      if (match) effects.burst(stage.querySelector('.lo-match'));
      const cont = stage.querySelector('.lo-continue');
      stage.querySelector('.lo-q').focus({ preventScroll: true });
      await run.waitFor((done) => { cont.onclick = done; keyHandler = (k) => (k === 'Enter' && document.activeElement !== cont ? (done(), true) : false); return () => { keyHandler = null; }; });
    }

    async function dayEnd(d, isLast) {
      leaveTerrain();
      const taught = d.events.map((e) => e.teachTrap);
      const el = view('lo-dayend', `
        <p class="eyebrow">LIVE OPS · DAY ${d.day} COMPLETE</p>
        <h2 class="lo-title" tabindex="-1">Day ${d.day}: ${st.dayScore >= 0 ? '+' : ''}${st.dayScore}</h2>
        ${scoreHTML()}
        <h3 class="wt-sub">Traps learned today</h3>
        <ul class="lo-trap-list">${taught.map((t) => `<li><span class="${st.dodged.has(t) ? 'recap-ok' : 'recap-bad'}">${st.dodged.has(t) ? '✓ dodged' : '✗ caught you'}</span> #${t} ${esc(st.trapTitle(t))}</li>`).join('')}</ul>
        <button class="primary-btn lo-next">${isLast ? 'Results ▶' : 'Next day ▶'}</button>
        <p class="evidence-caption lo-auto">Continues by itself in ${Math.round(S.dayEndMs / 1000)} s.</p>`);
      const btn = el.querySelector('.lo-next');
      btn.focus({ preventScroll: true });
      await run.waitFor((done) => { const t = setTimeout(done, S.dayEndMs); btn.onclick = done; return () => clearTimeout(t); });
    }

    async function endGame(days) {
      leaveTerrain();
      const lastEv = days[days.length - 1].events.slice(-1)[0];
      const at = byId[lastEv.caseId].centre;
      globe.flyTo(at[0], at[1], HOME_DISTANCE, S.flyS);
      effects.setAlarm(false);
      const best0 = readBest();
      const best = Math.max(best0, st.score);
      if (st.score > best0) writeBest(st.score);
      const taught = days.flatMap((d) => d.events.map((e) => e.teachTrap));
      const n = st.cards.length;
      const avg = n ? st.cards.reduce((a, x) => a + x.tookS, 0) / n : 0;
      const rightN = st.cards.filter((x) => x.right).length;
      const caught = [...st.caughtBy].sort((a, b) => a - b);
      const trapBtn = (t) => `<button class="ghost-btn lo-trap-btn" data-trap="${t}">#${t} ${esc(st.trapTitle(t))}</button>`;
      const el = view('lo-end', `
        <p class="eyebrow">LIVE OPS · COMPLETE</p>
        <h2 class="lo-title" tabindex="-1">Score ${st.score}</h2>
        <p class="lo-best">${st.score > best0 ? 'New best score!' : `Best: ${best}`}</p>
        <dl class="facts lo-facts">
          <div><dt>Cards right</dt><dd><strong>${rightN}</strong> of ${n}</dd></div>
          <div><dt>Average response time</dt><dd><strong>${avg.toFixed(1)}</strong> s per card</dd></div>
          <div><dt>Final calls right</dt><dd><strong>${st.finals.filter((f) => f.right).length}</strong> of ${st.finals.length}</dd></div>
          <div><dt>Confidence matched OmniSAR</dt><dd><strong>${st.confidence.filter((f) => f.match).length}</strong> of ${st.confidence.length}</dd></div>
        </dl>
        <h3 class="wt-sub">The ${taught.length} traps you learned</h3>
        <div class="lo-trap-grid">${taught.map(trapBtn).join('')}</div>
        <h3 class="wt-sub">Traps that caught you</h3>
        ${caught.length ? `<div class="lo-trap-grid">${caught.map(trapBtn).join('')}</div>` : '<p class="panel-text">None. Every trap card was called right.</p>'}
        <p class="evidence-caption">Each trap opens in the Trap Lab.</p>
        <div class="lo-end-actions">
          <button class="primary-btn lo-replay">Replay</button>
          <button class="ghost-btn lo-exit">Back to globe</button>
        </div>`);
      el.querySelectorAll('.lo-trap-btn').forEach((b) => b.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('liveops:traplab', { detail: { trap: Number(b.dataset.trap) } }));
      }));
      const speed = st.speed;
      el.querySelector('.lo-replay').addEventListener('click', () => api.start({ speed, day: 1 }));
      el.querySelector('.lo-exit').addEventListener('click', () => {
        api.stop();
        window.dispatchEvent(new CustomEvent('liveops:exit', { detail: {} }));
      });
      el.querySelector('.lo-title').focus({ preventScroll: true });
      announce(`Live Ops complete. Score ${st.score}. ${st.score > best0 ? 'New best score.' : `Best ${best}.`}`);
      window.dispatchEvent(new CustomEvent('liveops:end', { detail: { score: st.score, best } }));
    }

    return play;
  }

  const api = {
    start({ speed = 'normal', day = 1 } = {}) {
      api.stop();
      S = SPEEDS[speed] || SPEEDS.normal;
      const startDay = Math.min(3, Math.max(1, Math.round(Number(day)) || 1));
      st = { speed: SPEEDS[speed] ? speed : 'normal', score: 0, shown: 0, dayScore: 0, cards: [], finals: [], confidence: [],
        dodged: new Set(), caughtBy: new Set(), log: [], lastDate: null };
      run = makeRun();
      document.addEventListener('keydown', onKey);
      const r = run;
      makeGame(r, st, S)(startDay).catch((err) => {
        if (err === CANCEL || !r.alive) return;
        console.error('Live Ops stopped:', err);
        root.innerHTML = '<div class="lo"><p class="eyebrow">LIVE OPS</p><h2 class="lo-title">Live Ops could not continue</h2><p class="panel-text">A case file could not be loaded. Check your connection and press Replay.</p><button class="primary-btn lo-replay">Replay</button></div>';
        root.querySelector('.lo-replay').addEventListener('click', () => api.start({ speed, day: startDay }));
      });
    },
    stop() {
      if (run) run.cancel();
      run = null;
      keyHandler = null;
      document.removeEventListener('keydown', onKey);
      hideBanner(true);
      markers.setEvents([]);
      ripples.clear();
      leaveTerrain();
      root.replaceChildren();
    },
    // read-only view of the current run, for tests and the browser console
    get debug() { return st ? { score: st.score, cards: st.cards, finals: st.finals, confidence: st.confidence, log: st.log, speed: st.speed } : null; },
  };
  return api;
}
