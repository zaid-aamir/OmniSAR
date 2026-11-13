// OmniSAR entry point. Starts each part of the app in order.

import { createGlobe } from './globe.js';

const params = new URLSearchParams(location.search);

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
  return { lat: 22, lon: 45, distance: 3.2 };
}

async function start() {
  const area = document.getElementById('globe-area');
  const placeholder = document.getElementById('globe-placeholder');

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

  window.omnisar = { globe };   // handy for poking at things in the browser console
}

start();
