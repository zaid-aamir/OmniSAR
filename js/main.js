// OmniSAR entry point. Loads the case data, starts each part, and connects them.
// Two modes, chosen by the address (URL):
//
//   LIVE OPS (default, or ?mode=live): the game. It starts with only the slowly spinning globe,
//     the top bar and one big PLAY button with the honesty line ("a replay of real 2026 NISAR
//     passes ..."). No panel, no markers yet. Pressing PLAY swaps the body class is-prestart ->
//     is-live: the start screen collapses, the case-files panel slides in, the alert rods show.
//     ?mode=live&autostart presses PLAY for you. &speed=fast and &day=N are read for the game.
//     PLAY also starts the start effects (js/effects.js: shockwave, red edge pulses, hazard top bar)
//     and the game loop (js/liveops.js), which uses the alert ripples on the globe (js/ripples.js).
//
//   CLASSIC (?mode=classic, no button leads here): the v6.2 case mode. Pick a case (beacon or
//     list) -> the camera flies there and the panel shows its card -> open the mystery ->
//     walkthrough + blocky case terrain, stepped with the terrain's own ◀ ▶ buttons.
//     ?mode=classic&case=<id> opens a case, &play also opens its mystery, &tour runs the tour.
//
// v7: the timeline slider under the globe is gone (js/timeline.js is an empty stub now).
// index.html already puts the mode classes on <body> before the first paint; start() repeats it.

import { createGlobe } from './globe.js';
import { loadCases } from './cases.js';
import { createMarkers } from './markers.js';
import { createPanel } from './panel.js';
import { loadMystery } from './engine.js';
import { runWalkthrough } from './walkthrough.js';
import { createCaseTerrain } from './caseterrain.js';
import { createHud } from './hud.js';
import { showTrapLab } from './traplab.js';
import { setTrapLabOpener } from './trapcard.js';
import { startGlossary } from './glossary.js';
import { showInfo } from './about.js';
import { runTour } from './tour.js';
import { createStartScreen } from './startscreen.js';
import * as effects from './effects.js';
import { makeResizable } from './panelresize.js';
import { createRipples } from './ripples.js';
import { createLiveOps } from './liveops.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'classic' ? 'classic' : 'live';
const HOME_DISTANCE = 3.2;
const CASE_DISTANCE = 1.45;

// Live Ops options for the game (used at the integration hook): &speed=fast, &day=1..3
const LIVE_OPTIONS = {
  speed: params.get('speed') === 'fast' ? 'fast' : 'normal',
  day: Math.min(3, Math.max(1, Math.round(Number(params.get('day'))) || 1)),
};

const body = document.body;
body.classList.add(`mode-${MODE}`);
if (MODE === 'live' && !body.classList.contains('is-live')) body.classList.add('is-prestart');

// Show "Palette N" in the title bar only when a palette was chosen in the URL,
// so the screenshots say which palette they are.
if (params.has('palette')) {
  const chip = document.getElementById('palette-chip');
  chip.textContent = 'Palette ' + document.documentElement.dataset.palette;
  chip.hidden = false;
}

// Where the camera starts. Default: Africa / the Middle East.
// ?at=lat,lon,distance overrides it (useful for screenshots), e.g. ?at=30,85,1.6
function startView() {
  const at = (params.get('at') || '').split(',').map(Number);
  if (at.length === 3 && at.every(Number.isFinite)) {
    return { lat: at[0], lon: at[1], distance: Math.min(5, Math.max(1.25, at[2])) };
  }
  return { lat: 22, lon: 45, distance: HOME_DISTANCE };
}

async function start() {
  const area = document.getElementById('globe-area');
  const placeholder = document.getElementById('globe-placeholder');
  const panelEl = document.getElementById('panel');
  const panelRoot = document.getElementById('panel-inner');
  if (MODE === 'live') panelEl.inert = true;       // before Play the panel can't be tabbed to or read out

  const data = await loadCases();
  const byId = Object.fromEntries(data.cases.map((c) => [c.id, c]));

  let globe;
  try {
    globe = await createGlobe(area, startView());
  } catch (err) {
    console.error(err);
    placeholder.textContent = 'The 3D globe could not start in this browser (WebGL needed).';
    return;
  }
  placeholder.remove();

  // Corner note: be upfront that mountains are stretched and how big a block is
  const note = document.createElement('div');
  note.className = 'globe-note';
  note.textContent =
    `Heights exaggerated ×${globe.meta.heightExaggeration} · one block ≈ ${globe.meta.cellDeg}° ` +
    `· colours: NASA Blue Marble · heights: AWS Terrarium · glow, stars, lighting: visual only`;
  area.appendChild(note);

  const hud = createHud(data.cases);          // panel frame + the top bar's DAY readout
  startGlossary();                            // dotted radar words with one-line definitions
  // Case terrain: the local blocky view of a case box (covers the globe while open)
  const terrain = createCaseTerrain(area);
  // The side panel can be made wider or narrower (drag its left edge, or ←/→ on the handle)
  makeResizable(document.getElementById('panel'), { min: 280, maxFraction: 0.6, storageKey: 'omnisar.panelW' });

  const app = MODE === 'live'
    ? startLive({ area, panelEl, panelRoot, data, globe, hud, terrain })
    : startClassic({ area, data, byId, globe, hud, terrain });

  // the app's own controls, used by the tour and by tests (and handy in the browser console)
  window.omnisar = app;
}

// ---------------------------------------------------------------------------------------------
// LIVE OPS: the start state, then the game (js/liveops.js)
// ---------------------------------------------------------------------------------------------
function startLive({ area, panelEl, panelRoot, data, globe, hud, terrain }) {
  const markers = createMarkers(globe, data.cases, { live: true });   // no case beacons, no tips

  // Until the game fills it, the panel says plainly that it is waiting (no invented content)
  function showPanelIdle() {
    panelRoot.innerHTML = `
      <p class="eyebrow">Live Ops</p>
      <h1 class="panel-title">Case files</h1>
      <p class="panel-text">Standing by for the first NISAR pass.</p>`;
  }

  // Trap Lab (from a trap card, or a trap on the end screen). It opens ON TOP of whatever the panel
  // shows (the game or its end screen stays underneath, hidden), and "Back" brings that back.
  function openTrapLab(focus = null) {
    hud.expand();
    panelRoot.querySelector(':scope > .lab-host')?.remove();
    const under = [...panelRoot.children];
    under.forEach((el) => { el.hidden = true; });
    const host = document.createElement('div');
    host.className = 'lab-host';
    panelRoot.append(host);
    showTrapLab(host, data.cases, {
      focus,
      onBack: () => {
        host.remove();
        under.forEach((el) => { el.hidden = false; });
        panelRoot.querySelector('button, [tabindex]')?.focus();
      },
    });
  }
  setTrapLabOpener(openTrapLab);
  window.addEventListener('liveops:traplab', (e) => openTrapLab(e.detail?.trap ?? null));

  // The red alert ripples (in the globe's own shader) and the game loop
  const ripples = createRipples(globe);
  const liveops = createLiveOps({ globe, markers, terrain, panel: { root: panelRoot }, hud, effects, ripples, data });
  let playing = false;

  const startScreen = createStartScreen(area, { onPlay });

  // The start state: spinning globe, PLAY button, nothing else
  function showStartState() {
    body.classList.remove('is-live');
    body.classList.add('is-prestart');
    panelEl.inert = true;
    markers.setEvents([]);
    markers.setVisible(false);
    hud.setCase(null);
    hud.setDay(null, null);
    terrain.close();
    globe.setPaused(false);
    globe.controls.autoRotate = true;
    showPanelIdle();
    startScreen.show();
  }

  // PLAY: shockwave from the button, red edge pulses + hazard top bar (effects), the button
  // collapses, the panel slides in, the rods can show, and the game starts (speed/day from the URL)
  function onPlay(buttonEl) {     // buttonEl = the PLAY button, or null with ?autostart
    if (playing) return;
    playing = true;
    effects.startSequence(buttonEl || undefined);
    startScreen.hide();
    body.classList.replace('is-prestart', 'is-live');
    panelEl.inert = false;
    globe.controls.autoRotate = false;
    markers.setVisible(true);
    hud.setDay(null, null);
    liveops.start(LIVE_OPTIONS);
  }

  // "Back to globe" on the end screen: stop everything and return to the PLAY button
  window.addEventListener('liveops:exit', () => {
    liveops.stop();
    effects.setAlarm(false);
    effects.clear();
    playing = false;
    showStartState();
  });

  showStartState();
  // ?mode=live&autostart: the same start path as pressing PLAY, without showing the button first
  if (params.has('autostart')) onPlay(null);

  return { mode: MODE, globe, data, terrain, markers, hud, startScreen, openTrapLab, liveOptions: LIVE_OPTIONS, liveops, ripples, effects };
}

// ---------------------------------------------------------------------------------------------
// CLASSIC: the v6.2 case mode, without the timeline slider
// ---------------------------------------------------------------------------------------------
function startClassic({ area, data, byId, globe, hud, terrain }) {
  const panel = createPanel(document.getElementById('panel-inner'), data.cases, {
    onPick: selectCase,
    onBack: backToGlobe,
    onOpen: openMystery,
    onAction: (a) => {
      if (a === 'traplab') openTrapLab();
      else if (a === 'tour') runTour(app);
      else showInfo(panel.root, a, { onBack: backToGlobe });          // nasa / challenge / about
    },
  });

  // Trap Lab: from the home screen, and from every trap card ("Open in the Trap Lab")
  function openTrapLab(focus = null) {
    hud.expand();
    showTrapLab(panel.root, data.cases, { focus, onBack: backToGlobe, onPick: selectCase });
  }
  setTrapLabOpener(openTrapLab);

  const markers = createMarkers(globe, data.cases, { onSelect: selectCase, onTip: (t) => panel.showTip(t) });
  // Unverified tips: a saved snapshot of NASA EONET natural events (tools/fetch_eonet.py).
  // With no timeline any more, all tips show at once. If the file is missing the globe shows none.
  fetch('cases/eonet.json').then((r) => (r.ok ? r.json() : null)).then((e) => {
    if (!e) return;
    markers.setTips(e.events);
    panel.setTipCount(e.events.length);             // the home note says how many grey tips there are
  }).catch(() => {});

  function showGlobe() {
    terrain.close();
    globe.setPaused(false);
  }

  function selectCase(id) {
    showGlobe();
    const c = byId[id];
    globe.flyTo(c.centre[0], c.centre[1], CASE_DISTANCE);
    markers.pulse(id);                              // the picked case's beacon pulses once
    panel.showCase(c);
    hud.setCase(c);
    hud.expand();                                   // a picked case always shows its card
  }

  function backToGlobe() {
    showGlobe();
    // pull back out to the home distance, staying above the same part of the world
    const dir = globe.camera.position.clone().normalize();
    const lat = Math.asin(dir.y) * 180 / Math.PI;
    const lon = Math.atan2(-dir.z, dir.x) * 180 / Math.PI;
    globe.flyTo(lat, lon, HOME_DISTANCE, 1.2);
    panel.showHome();
    hud.setCase(null);
  }

  async function openMystery(id) {
    const c = byId[id];
    if (!c.mysteryFile) {
      panel.note('This mystery’s case file is still being written.');
      return;
    }
    // loading state: the button says what's happening, and a failure is said plainly
    const btn = panel.root.querySelector('#open-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="loading-text">Opening case file</span>'; }
    let mystery;
    try {
      mystery = await loadMystery(c);
    } catch (err) {
      console.error(err);
      if (btn) { btn.disabled = false; btn.textContent = 'Open mystery'; }
      panel.note('This case file could not be loaded. Check your connection and try again.');
      return;
    }
    runWalkthrough(panel.root, mystery, {
      onExit: (how) => { showGlobe(); if (how?.finished && panel.allDone()) panel.showEnd(); else panel.showCase(c); },
    });
    // Opening a case moves the view down to its blocky terrain, if the case has a grid yet.
    // The terrain's own ◀ ▶ stepper picks the pass (there is no slider to follow any more).
    const opened = await terrain.open(c, mystery.numbers?.files?.grid, {
      onBackToGlobe: showGlobe,
      onLayerDate: () => {},
      numbers: mystery.numbers,                      // the inspector marks passes left out by quality control
    });
    if (opened) globe.setPaused(true);
  }

  // ?mode=classic&case=<id> opens straight onto a case (for testing and screenshots)
  if (byId[params.get('case')]) {
    selectCase(params.get('case'));
    if (params.has('play')) openMystery(params.get('case'));   // &play opens the walkthrough
  }

  const app = { mode: MODE, globe, data, selectCase, terrain, markers, hud, startScreen: null, openTrapLab, openMystery, backToGlobe };
  if (params.has('tour')) setTimeout(() => runTour(app), 1500);    // &tour starts the hands-free demo
  return app;
}

start();
