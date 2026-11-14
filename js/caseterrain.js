// Blocky case terrain: when a case opens, the view leaves the globe and shows the case box as
// blocks. Built from the case's grid file (assets/cases/<id>/grid.json, written by the
// processing scripts), so it works for every case:
//   - one block = one radar pixel where possible; above ~60,000 blocks the script merges N×N
//     pixels and the true block size is printed on screen
//   - block COLOUR = the selected layer's real value on a fixed data scale
//     (sequential = "how much", diverging = brighter/darker or up/down)
//   - block HEIGHT = AWS Terrarium ground height, exaggerated (factor shown on screen)
//   - a pass stepper moves through the real layers; hovering a block shows value, date, source

import * as THREE from 'three';
import { OrbitControls } from '../lib/three/OrbitControls.js';
import { esc } from './util.js';
import { colourFor, legendGradient } from './datacolours.js';

const GAP = 0.88;            // block width as a share of its cell (the gap reads as a thin dark edge)
const SIDE_SHADE = 0.7;
const BASE_M = 4;            // every block is at least this tall (metres, before exaggeration)

function blockGeometry() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);                     // origin at the bottom, so scaling y grows upward
  const n = geo.attributes.normal;
  const shade = new Float32Array(n.count * 3);
  for (let i = 0; i < n.count; i++) {
    const s = n.getY(i) > 0.5 ? 1 : n.getY(i) < -0.5 ? 0.4 : SIDE_SHADE;
    shade.set([s, s, s], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(shade, 3));
  return geo;
}

// A "nice" exaggeration so the highest ground is about 6% of the box width (1, 2, 5, 10, 20 ...)
function pickExaggeration(reliefM, widthM) {
  const want = (0.06 * widthM) / Math.max(reliefM, 1);
  const steps = [1, 2, 5, 10, 20, 50, 100];
  return steps.reduce((best, s) => (s <= want ? s : best), 1);
}

export function createCaseTerrain(container) {
  const view = document.createElement('div');
  view.className = 'terrain-view';
  view.hidden = true;
  view.tabIndex = 0;                       // focusable, so the arrow keys can step through layers
  view.setAttribute('aria-label', 'Case terrain: arrow keys change the layer');
  view.innerHTML = `
    <div class="terrain-hud terrain-top">
      <div>
        <p class="eyebrow" id="tv-case"></p>
        <p class="terrain-layer" id="tv-layer"></p>
      </div>
      <button class="ghost-btn" id="tv-globe">↩ Globe</button>
    </div>
    <div class="terrain-hud terrain-stepper" role="group" aria-label="Pass stepper">
      <button class="ghost-btn" id="tv-prev" aria-label="Previous layer">◀</button>
      <span id="tv-step" aria-live="polite"></span>
      <button class="ghost-btn" id="tv-next" aria-label="Next layer">▶</button>
    </div>
    <div class="terrain-hud terrain-legend" id="tv-legend"></div>
    <div class="terrain-tip" id="tv-tip" hidden></div>
    <p class="terrain-note" id="tv-note"></p>`;
  container.appendChild(view);
  const $ = (id) => view.querySelector('#' + id);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  view.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 400);
  scene.add(new THREE.AmbientLight(0xffffff, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(-0.5, 1, 0.6);
  scene.add(sun);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.47;       // can't go under the ground
  controls.screenSpacePanning = false;

  let grid = null, mesh = null, layerIndex = 0, cells = [], exaggeration = 1, onGlobe = null, running = false;
  const colour = new THREE.Color();

  function resize() {
    const { clientWidth: w, clientHeight: h } = view;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(view);

  function build() {
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    const { rows, cols, block_m: bm } = grid;
    const km = bm / 1000;                                   // scene units are kilometres
    const elev = grid.elev_dm.map((v) => Math.max(0, v / 10));  // below sea level drawn flat
    const relief = Math.max(...elev) - Math.min(...elev);
    exaggeration = pickExaggeration(relief, cols * bm);
    // Only blocks that have data in at least one layer are drawn
    cells = [];
    for (let i = 0; i < rows * cols; i++) {
      if (grid.layers.some((l) => l.values[i] != null)) cells.push(i);
    }
    mesh = new THREE.InstancedMesh(blockGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), cells.length);
    const m = new THREE.Matrix4();
    cells.forEach((i, k) => {
      const r = Math.floor(i / cols), c = i % cols;
      const h = ((BASE_M + elev[i]) * exaggeration) / 1000;
      m.makeScale(km * GAP, h, km * GAP);
      m.setPosition((c - cols / 2 + 0.5) * km, 0, (r - rows / 2 + 0.5) * km);
      mesh.setMatrixAt(k, m);
    });
    scene.add(mesh);
    const span = Math.max(rows, cols) * km;
    camera.position.set(0, span * 0.75, span * 0.8);
    controls.target.set(0, 0, 0);
    controls.minDistance = span * 0.08;
    controls.maxDistance = span * 2.2;
    controls.update();
    paint();
  }

  function paint() {
    const layer = grid.layers[layerIndex];
    cells.forEach((i, k) => {
      const v = layer.values[i];
      const rgb = v == null ? [46, 50, 58] : colourFor(layer.kind, v / 10, layer.scale);
      colour.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      mesh.setColorAt(k, colour);
    });
    mesh.instanceColor.needsUpdate = true;
    $('tv-tip').hidden = true;                 // an old tooltip would show the previous layer's value
    $('tv-layer').textContent = layer.label;
    $('tv-step').textContent = `Layer ${layerIndex + 1} of ${grid.layers.length} · ${layer.date}`;
    $('tv-prev').disabled = layerIndex === 0;
    $('tv-next').disabled = layerIndex === grid.layers.length - 1;
    const [lo, hi] = layer.scale;
    $('tv-legend').innerHTML = `
      <p class="legend-title">${esc(layer.what)}</p>
      <div class="legend-bar" style="background:${legendGradient(layer.kind, layer.scale)}"></div>
      <div class="legend-ticks"><span>${lo} ${esc(layer.unit)}</span><span>${layer.kind === 'diverging' ? '0' : ''}</span><span>${hi > 0 && layer.kind === 'diverging' ? '+' : ''}${hi} ${esc(layer.unit)}</span></div>
      ${layer.kind === 'diverging' ? `<div class="legend-ticks"><span>${esc(layer.lowWord || 'darker')}</span><span></span><span>${esc(layer.highWord || 'brighter')}</span></div>` : ''}
      ${layer.note ? `<p class="legend-note">${esc(layer.note)}</p>` : ''}`;
    $('tv-note').textContent =
      `${grid.block_text} · heights exaggerated ×${exaggeration} (${grid.height_source}) · values: ${layer.source}`;
  }

  // ----- hover: which block is under the mouse? -----
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let pending = null;
  renderer.domElement.addEventListener('pointermove', (e) => {
    pending = e;
  });
  renderer.domElement.addEventListener('pointerleave', () => { pending = null; $('tv-tip').hidden = true; });
  function hover() {
    if (!pending || !mesh) return;
    const e = pending; pending = null;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObject(mesh)[0];
    const tip = $('tv-tip');
    if (!hit) { tip.hidden = true; return; }
    const i = cells[hit.instanceId];
    const layer = grid.layers[layerIndex];
    const v = layer.values[i];
    tip.innerHTML = `
      <strong>${v == null ? 'no data' : `${(v / 10).toFixed(1)} ${esc(layer.unit)}`}</strong>
      <span>${esc(layer.label)}</span>
      <span>${esc(layer.source)}</span>
      <span>ground ${(Math.max(0, grid.elev_dm[i] / 10)).toFixed(0)} m (Terrarium)</span>`;
    tip.style.left = `${e.clientX - rect.left + 14}px`;
    tip.style.top = `${e.clientY - rect.top + 14}px`;
    tip.hidden = false;
  }

  renderer.setAnimationLoop(() => {
    if (!running) return;
    controls.update();
    hover();
    renderer.render(scene, camera);
  });

  $('tv-prev').addEventListener('click', () => { if (layerIndex > 0) { layerIndex--; paint(); } });
  $('tv-next').addEventListener('click', () => { if (layerIndex < grid.layers.length - 1) { layerIndex++; paint(); } });
  $('tv-globe').addEventListener('click', () => onGlobe?.());
  view.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') $('tv-prev').click();
    if (e.key === 'ArrowRight') $('tv-next').click();
  });

  return {
    // Show a case's terrain. Returns false if the case has no grid yet (globe stays).
    async open(caseInfo, gridPath, { onBackToGlobe } = {}) {
      if (!gridPath) return false;
      view.hidden = false;                                   // show the view at once, with a loading line
      $('tv-case').textContent = `${caseInfo.name} · case terrain`;
      $('tv-layer').innerHTML = '<span class="loading-text">Loading case terrain</span>';
      try {
        grid = await fetch(gridPath).then((r) => r.json());
      } catch (err) {
        console.error(err);
        view.hidden = true;
        return false;
      }
      layerIndex = Math.max(0, grid.layers.findIndex((l) => l.id === grid.default_layer));
      onGlobe = onBackToGlobe;
      $('tv-case').textContent = `${caseInfo.name} · case terrain`;
      view.hidden = false;
      running = true;
      resize();
      build();
      return true;
    },
    close() {
      view.hidden = true;
      running = false;
      $('tv-tip').hidden = true;
    },
    get isOpen() { return !view.hidden; },
  };
}
