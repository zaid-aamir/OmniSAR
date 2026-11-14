// OmniSAR entry point. Loads the case data, starts each part, and connects them:
//   pick a case (beacon or list) -> camera flies there, panel shows its card, timeline shows its passes
//   timeline crosses a pass date -> that case's beacon pulses

import { createGlobe } from './globe.js';
import { loadCases } from './cases.js';
import { createMarkers } from './markers.js';
import { createTimeline } from './timeline.js';
import { createPanel } from './panel.js';
import { loadMystery } from './engine.js';
import { runWalkthrough } from './walkthrough.js';
import { createCaseTerrain } from './caseterrain.js';

const params = new URLSearchParams(location.search);
const HOME_DISTANCE = 3.2;
const CASE_DISTANCE = 1.45;

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
    `· colours: NASA Blue Marble · heights: AWS Terrarium`;
  area.appendChild(note);

  const panel = createPanel(document.getElementById('panel-inner'), data.cases, {
    onPick: selectCase,
    onBack: backToGlobe,
    onOpen: openMystery,
  });
  const markers = createMarkers(globe, data.cases, { onSelect: selectCase });
  const timeline = createTimeline(document.getElementById('timeline'), data.cases, {
    onCross: (id) => markers.pulse(id),
  });

  // Case terrain: the local blocky view of a case box (covers the globe while open)
  const terrain = createCaseTerrain(area);
  function showGlobe() {
    terrain.close();
    globe.setPaused(false);
  }

  function selectCase(id) {
    showGlobe();
    const c = byId[id];
    globe.flyTo(c.centre[0], c.centre[1], CASE_DISTANCE);
    panel.showCase(c);
    timeline.setCase(c);
  }

  function backToGlobe() {
    showGlobe();
    // pull back out to the home distance, staying above the same part of the world
    const dir = globe.camera.position.clone().normalize();
    const lat = Math.asin(dir.y) * 180 / Math.PI;
    const lon = Math.atan2(-dir.z, dir.x) * 180 / Math.PI;
    globe.flyTo(lat, lon, HOME_DISTANCE, 1.2);
    panel.showHome();
    timeline.setCase(null);
  }

  async function openMystery(id) {
    const c = byId[id];
    if (!c.mysteryFile) {
      panel.note('This mystery’s case file is still being written.');
      return;
    }
    const mystery = await loadMystery(c);
    runWalkthrough(panel.root, mystery, { onExit: () => { showGlobe(); panel.showCase(c); } });
    // Opening a case moves the view down to its blocky terrain, if the case has a grid yet
    const opened = await terrain.open(c, mystery.numbers?.files?.grid, { onBackToGlobe: showGlobe });
    if (opened) globe.setPaused(true);
  }

  // ?case=<id> opens straight onto a case (for testing and screenshots)
  if (byId[params.get('case')]) {
    selectCase(params.get('case'));
    if (params.has('play')) openMystery(params.get('case'));   // ?case=jebel-ali&play opens the walkthrough
  }

  window.omnisar = { globe, data, selectCase, terrain };   // handy for poking at things in the browser console
}

start();
