// Blocky case terrain: when a case opens, the view leaves the globe and shows the case box as
// blocks. Built from the case's grid file (assets/cases/<id>/grid.json, written by the
// processing scripts), so it works for every case:
//   - one block = one radar pixel where possible; above ~60,000 blocks the script merges N×N
//     pixels and the true block size is printed on screen
//   - block COLOUR = the selected layer's real value on a fixed data scale
//     (sequential = "how much", diverging = brighter/darker or up/down)
//   - block HEIGHT = AWS Terrarium ground height, exaggerated (factor shown on screen)
//   - a pass stepper moves through the real layers; hovering a block shows value, date, source
//   - v7: there is no timeline slider any more. In classic mode the ◀ ▶ stepper picks the layer;
//     in Live Ops the game picks it with showLayerAt() (below). showDate() is what both use to
//     pick "the latest processed pass on or before a date" (the name "sliderDate" is historical).
//   - player (pass-to-pass Play) is kept but nothing calls it since the slider's Play button went.
//   - Every switch blends the block colours over ~0.5 s, and blocks that moved by more than the
//     case's own declared threshold get a brief cyan outline (rules: js/terraintime.js).
//   - A large label on the terrain always says which pass is showing ("Pass 2 of 3 · 16 Oct 2026"),
//     or "No new pass until <date>" when the chosen date sits after the pass on screen.
//   - Live Ops calls setAlert(lat, lon): a red ring spreads over the blocks from the event's centre
//     block, one ring every 1.2 s (the same rhythm as the globe's ripples), drawn in the blocks'
//     own shader, so no block turns red more than 0.83 times a second (limit: 3). setAlert(null) stops it.
//   - Live Ops calls showLayerAt(caseId, date): the latest processed pass on or before that date,
//     blended in over 500 ms (never a pass from after that date).

import * as THREE from 'three';
import { OrbitControls } from '../lib/three/OrbitControls.js';
import { esc, setShown, reducedMotion } from './util.js';
import { colourFor, legendGradient } from './datacolours.js';
import { createInspector } from './inspector.js';
import { flashRule, missingPassDates, addPasses } from './terraintime.js';

const GAP = 0.88;            // block width as a share of its cell (the gap reads as a thin dark edge)
const SIDE_SHADE = 0.7;
const BASE_M = 4;            // every block is at least this tall (metres, before exaggeration)
const GAP_DATES = ['2026-07-27', '2026-08-10'];   // NASA's NISAR data gap (no data anywhere)
const HOLD_MS = 1500;        // Play: how long each pass stays on screen
const BLEND_MS = 500;        // colour blend from one layer to the next
const FLASH_MS = 1400;       // cyan outline on the blocks that changed (full for 0.4 s, then fades)
const FLASH_COLOUR = 0x66fcf1;

// A layer belongs to ONE pass if its date is a single day (not "A → B", not empty)
const isDated = (l) => /^\d{4}-\d{2}-\d{2}$/.test(l?.date || '');
// Layers of the same kind (same unit, scale and colour scale), e.g. "HH" or "water share"
const family = (l) => `${l.kind}|${l.unit}|${(l.scale || []).join(',')}`;
// "15 Sep 2026" / "15 Sep": a fixed month table (Chrome's en-GB writes "Sept")
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtShort = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const fmtDate = (iso) => `${fmtShort(iso)} ${iso.slice(0, 4)}`;
// "2026-06-18 → 2026-10-16" -> ['2026-06-18', '2026-10-16'] (a layer that spans two dates)
const rangeOf = (l) => { const m = /^(\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})$/.exec(l?.date || ''); return m ? [m[1], m[2]] : null; };

// A flat square frame, drawn on top of a block that changed (the cyan outline)
function ringGeometry() {
  const s = new THREE.Shape([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([x, y]) => new THREE.Vector2(x, y)));
  s.holes.push(new THREE.Path([[-0.3, -0.3], [-0.3, 0.3], [0.3, 0.3], [0.3, -0.3]].map(([x, y]) => new THREE.Vector2(x, y))));
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  return g;
}

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
  view.setAttribute('aria-label', 'Case terrain: arrow keys change the layer; Enter or I inspects the block in the middle of the view');
  view.innerHTML = `
    <div class="terrain-hud terrain-top">
      <div>
        <p class="eyebrow" id="tv-case"></p>
        <p class="terrain-layer" id="tv-layer"></p>
        <p class="terrain-when" id="tv-when"></p>
      </div>
      <button class="ghost-btn" id="tv-globe">↩ Globe</button>
    </div>
    <div class="terrain-hud terrain-pass" id="tv-pass" role="status" aria-live="polite">
      <p class="tp-main" id="tv-pass-main"></p>
      <p class="tp-sub" id="tv-pass-sub"></p>
      <p class="tp-key" id="tv-pass-key" hidden><span class="tp-swatch" aria-hidden="true"></span><span id="tv-pass-key-text"></span></p>
    </div>
    <div class="terrain-hud terrain-stepper" role="group" aria-label="Pass stepper">
      <button class="ghost-btn" id="tv-prev" aria-label="Previous layer">◀</button>
      <span id="tv-step"></span>
      <button class="ghost-btn" id="tv-next" aria-label="Next layer">▶</button>
    </div>
    <div class="terrain-hud terrain-legend" id="tv-legend"></div>
    <div class="terrain-tip" id="tv-tip" hidden></div>
    <p class="terrain-note" id="tv-note"></p>`;
  container.appendChild(view);
  const $ = (id) => view.querySelector('#' + id);
  const inspector = createInspector(view);       // "What did the radar hit?" box (js/inspector.js)

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
  let sliderDate = null, onLayerDate = null, isOpenNow = false;
  let tops = null, maxTop = 0;
  let caseId = null, method = null;
  let blend = null;                  // { from, to, t0 } while block colours move to a new layer
  let flashMesh = null, flashT0 = -1e9;
  let play = null;                   // { seq, k, timer, done } while Play runs
  const colour = new THREE.Color();

  // ----- the red alert ring (Live Ops). Uniforms shared by every terrain material we build -----
  const ALERT_PERIOD_S = 1.2;                       // one ring every 1.2 s, like the globe ripples
  const alertU = {
    uAlertOn: { value: 0 },                         // 0 = off, 1 = on (eased, so it fades in and out)
    uAlertC: { value: new THREE.Vector2() },        // the event's centre, in scene km (x, z)
    uAlertT: { value: 0 },                          // seconds since the alert started
    uAlertMax: { value: 1 },                        // how far a ring travels (km) before it is gone
  };
  let alertOn = 0, alertT0 = 0, alertLatLon = null;
  function patchAlert(shader) {
    Object.assign(shader.uniforms, alertU);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vAlertXZ;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vAlertXZ = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;   // this block's centre
      #else
        vAlertXZ = vec2(0.0);
      #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
      varying vec2 vAlertXZ;
      uniform float uAlertOn; uniform vec2 uAlertC; uniform float uAlertT; uniform float uAlertMax;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      float aD = distance(vAlertXZ, uAlertC);                       // km from the event's centre
      float aPh = fract(uAlertT / ${ALERT_PERIOD_S.toFixed(1)});    // where we are in this ring's 1.2 s
      float aBand = exp(-pow((aD - aPh * uAlertMax) / (uAlertMax * 0.045), 2.0)) * (1.0 - aPh);
      float aCore = 1.0 - smoothstep(uAlertMax * 0.03, uAlertMax * 0.07, aD);   // steady glow at the centre
      float aMix = uAlertOn * clamp(aBand * 0.8 + aCore * 0.55, 0.0, 0.85);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.14, 0.2), aMix);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      totalEmissiveRadiance += vec3(0.9, 0.1, 0.15) * aMix * 0.5;`);
  }
  // Where (lat, lon) falls on this grid, in scene km. The grid's corner blocks carry their lat/lon.
  function alertCentre(lat, lon) {
    const c = grid.corners_latlon, km = grid.block_m / 1000;
    const q = Math.min(1, Math.max(0, (lon - c.nw[1]) / ((c.ne[1] - c.nw[1]) || 1)));
    const r = Math.min(1, Math.max(0, (c.nw[0] - lat) / ((c.nw[0] - c.sw[0]) || 1)));
    return new THREE.Vector2((q * (grid.cols - 1) - grid.cols / 2 + 0.5) * km, (r * (grid.rows - 1) - grid.rows / 2 + 0.5) * km);
  }
  function setAlert(lat, lon) {
    if (lat == null || !grid?.corners_latlon) { alertLatLon = null; return; }
    alertLatLon = [lat, lon];
    alertU.uAlertC.value.copy(alertCentre(lat, lon));
    alertU.uAlertMax.value = Math.hypot(grid.cols, grid.rows) * (grid.block_m / 1000) * 0.6;
    alertT0 = performance.now();
  }

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
    const blockMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    blockMaterial.onBeforeCompile = patchAlert;               // the red alert ring (Live Ops only; off otherwise)
    mesh = new THREE.InstancedMesh(blockGeometry(), blockMaterial, cells.length);
    mesh.setColorAt(0, colour);                               // creates the per-block colour buffer
    blend = null;
    tops = new Float32Array(rows * cols);                     // block top heights, for picking a block by click
    const m = new THREE.Matrix4();
    cells.forEach((i, k) => {
      const r = Math.floor(i / cols), c = i % cols;
      const h = ((BASE_M + elev[i]) * exaggeration) / 1000;
      tops[i] = h;
      m.makeScale(km * GAP, h, km * GAP);
      m.setPosition((c - cols / 2 + 0.5) * km, 0, (r - rows / 2 + 0.5) * km);
      mesh.setMatrixAt(k, m);
    });
    scene.add(mesh);
    maxTop = tops.reduce((a, v) => Math.max(a, v), 0);
    if (flashMesh) { scene.remove(flashMesh); flashMesh.geometry.dispose(); flashMesh.material.dispose(); }
    flashMesh = new THREE.InstancedMesh(ringGeometry(),
      new THREE.MeshBasicMaterial({ color: FLASH_COLOUR, transparent: true, depthWrite: false }), cells.length);
    flashMesh.count = 0;
    flashMesh.visible = false;
    flashMesh.frustumCulled = false;                          // its blocks change every switch
    flashMesh.renderOrder = 1;
    scene.add(flashMesh);
    const span = Math.max(rows, cols) * km;
    camera.position.set(0, span * 0.75, span * 0.8);
    controls.target.set(0, 0, 0);
    controls.minDistance = span * 0.08;
    controls.maxDistance = span * 2.2;
    controls.update();
    paint();
  }

  // Each block's colour for one layer (linear RGB, three numbers per block)
  function coloursOf(layer) {
    const out = new Float32Array(cells.length * 3);
    cells.forEach((i, k) => {
      const v = layer.values[i];
      const rgb = v == null ? [46, 50, 58] : colourFor(layer.kind, v / 10, layer.scale);
      colour.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      out[k * 3] = colour.r; out[k * 3 + 1] = colour.g; out[k * 3 + 2] = colour.b;
    });
    return out;
  }

  // The blocks whose value moved by more than the case's declared threshold get a cyan outline.
  // Only from one pass to the NEXT pass of the same kind (pass -> change is not a step in time,
  // and going back or jumping several passes is not "since the pass before").
  function flash(old, layer) {
    flashMesh.visible = false;
    flashMesh.count = 0;
    if (!old || !isDated(old) || !isDated(layer) || family(old) !== family(layer)) return;
    const same = grid.layers.filter((l) => isDated(l) && family(l) === family(layer)).map((l) => l.date).sort();
    if (same.indexOf(layer.date) !== same.indexOf(old.date) + 1) return;
    const rule = flashRule(caseId, layer, method);
    if (!rule) return;
    const { rows, cols } = grid;
    const km = grid.block_m / 1000;
    const m = new THREE.Matrix4();
    let n = 0;
    for (const i of cells) {
      const a = old.values[i], b = layer.values[i];
      if (a == null || b == null || !rule.test(a / 10, b / 10)) continue;
      m.makeScale(km, 1, km);
      m.setPosition((i % cols - cols / 2 + 0.5) * km, tops[i] + km * 0.02, (Math.floor(i / cols) - rows / 2 + 0.5) * km);
      flashMesh.setMatrixAt(n++, m);
    }
    flashMesh.count = n;
    flashMesh.instanceMatrix.needsUpdate = true;
    flashMesh.visible = n > 0;
    flashT0 = performance.now();
  }

  // Draw layer `layerIndex`. `prev` = the layer that was on screen (null when the grid is new);
  // with a previous layer the colours blend over BLEND_MS and the changed blocks flash.
  // Live Ops passes { blendMs, always: true }: its blend has no reduced-motion branch (Zaid's call).
  function paint(prev = null, { blendMs = BLEND_MS, always = false } = {}) {
    const layer = grid.layers[layerIndex];
    const target = coloursOf(layer);
    const arr = mesh.instanceColor.array;
    const old = prev == null ? null : grid.layers[prev];
    if (old && blendMs > 0 && (always || !reducedMotion())) {
      blend = { from: arr.slice(), to: target, t0: performance.now(), ms: blendMs };
    } else {
      blend = null;
      arr.set(target);
      mesh.instanceColor.needsUpdate = true;
    }
    flash(old, layer);
    $('tv-tip').hidden = true;                 // an old tooltip would show the previous layer's value
    $('tv-layer').textContent = layer.label;
    $('tv-step').textContent = `Layer ${layerIndex + 1} of ${grid.layers.length}`;
    // at either end the button stays visible but disabled, and says why
    $('tv-prev').disabled = layerIndex === 0;
    $('tv-next').disabled = layerIndex === grid.layers.length - 1;
    $('tv-prev').title = layerIndex === 0 ? 'This is the first layer' : 'Previous layer';
    $('tv-next').title = layerIndex === grid.layers.length - 1 ? 'This is the last layer' : 'Next layer';
    const [lo, hi] = layer.scale;
    $('tv-legend').innerHTML = `
      <p class="legend-title">${esc(layer.what)}</p>
      <div class="legend-bar" style="background:${legendGradient(layer.kind, layer.scale)}"></div>
      <div class="legend-ticks"><span>${lo} ${esc(layer.unit)}</span><span>${layer.kind === 'diverging' ? '0' : ''}</span><span>${hi > 0 && layer.kind === 'diverging' ? '+' : ''}${hi} ${esc(layer.unit)}</span></div>
      ${layer.kind === 'diverging' ? `<div class="legend-ticks"><span>${esc(layer.lowWord || 'darker')}</span><span></span><span>${esc(layer.highWord || 'brighter')}</span></div>` : ''}
      ${layer.note ? `<p class="legend-note">${esc(layer.note)}</p>` : ''}`;
    $('tv-note').textContent =
      `${grid.block_text} · heights exaggerated ×${exaggeration} (${grid.height_source}) · values: ${layer.source}`;
    updateWhen();
  }

  // The line under the layer name (which pass is on screen, the next processed pass, the gap)
  // and the large pass label on the terrain
  function updateWhen() {
    const layer = grid.layers[layerIndex];
    const parts = [];
    let main, sub = '';
    const inGap = sliderDate && sliderDate >= GAP_DATES[0] && sliderDate <= GAP_DATES[1];
    if (isDated(layer)) {
      const same = grid.layers.filter((l) => isDated(l) && family(l) === family(layer)).map((l) => l.date).sort();
      const next = same.find((d) => d > layer.date);
      if (sliderDate && sliderDate < layer.date) parts.push(`No processed pass on or before ${fmtDate(sliderDate)} · showing the first, ${fmtDate(layer.date)}`);
      else parts.push(`Showing the pass of ${fmtDate(layer.date)}`);
      parts.push(next ? `next processed pass ${fmtDate(next)}` : 'no later processed pass');
      if (layer.leftOut) parts.push(`left out of the verdict: ${layer.leftOut}`);
      main = `Pass ${same.indexOf(layer.date) + 1} of ${same.length} · ${fmtDate(layer.date)}`;
      if (sliderDate && sliderDate < layer.date) sub = `No processed pass before ${fmtDate(layer.date)}`;
      else if (sliderDate && sliderDate > layer.date) sub = next ? `No new pass until ${fmtDate(next)}` : 'No later processed pass';
      if (layer.leftOut) sub = [sub, 'Left out of the verdict (interference check)'].filter(Boolean).join(' · ');
    } else {
      parts.push(`Not a single pass (${layer.date || 'no date'}): reach it with ◀ ▶`);
      const r = rangeOf(layer);
      main = r ? `Change: ${fmtShort(r[0])} → ${fmtDate(r[1])}` : layer.label;
      sub = r ? layer.label : 'Not a pass: the same on every date';
    }
    if (inGap) {
      parts.push(`${fmtDate(sliderDate)} is inside NASA's 27 Jul – 10 Aug 2026 data gap: no NISAR data`);
      if (isDated(layer)) sub = [sub, 'Slider is inside NASA’s 27 Jul – 10 Aug data gap'].filter(Boolean).join(' · ');
    }
    $('tv-when').textContent = parts.join(' · ');
    const mainEl = $('tv-pass-main');
    if (mainEl.textContent !== main) {
      mainEl.textContent = main;
      mainEl.classList.remove('is-new');
      void mainEl.offsetWidth;                  // restart the little "new pass" pop
      mainEl.classList.add('is-new');
    }
    $('tv-pass-sub').textContent = sub;
    $('tv-pass-sub').hidden = !sub;
    const rule = isDated(layer) && flashRule(caseId, layer, method);
    $('tv-pass-key').hidden = !rule;
    $('tv-pass-key-text').textContent = rule ? `Cyan outline: ${rule.text}` : '';
  }

  // Show layer i; a dated layer moves the timeline slider to its date
  function go(i) {
    if (!grid || i < 0 || i >= grid.layers.length) return;
    if (i !== layerIndex) {
      const prev = layerIndex;
      layerIndex = i;
      paint(prev);
    }
    if (isDated(grid.layers[i])) onLayerDate?.(grid.layers[i].date);
  }
  // The stepper (a person's hand) stops Play first
  function stepTo(i) {
    if (!grid || i < 0 || i >= grid.layers.length || i === layerIndex) return;
    stopPlay();
    go(i);
  }

  // ----- Play: one processed pass after another -----
  // The passes of the same kind as the layer on screen, in date order. From a layer that is not
  // one pass (a change or burn layer, slope): the passes it was made from, then back to that layer.
  function playSequence() {
    const cur = grid.layers[layerIndex];
    let src = cur, endOn = null;
    if (!isDated(cur)) {
      endOn = layerIndex;
      const r = rangeOf(cur);
      src = grid.layers.find((l) => isDated(l) && r && l.date === r[0]) || grid.layers.find(isDated);
      if (!src) return [];
    }
    const passes = grid.layers.map((l, i) => ({ l, i })).filter(({ l }) => isDated(l) && family(l) === family(src))
      .sort((a, b) => (a.l.date < b.l.date ? -1 : 1)).map(({ i }) => i);
    let from = 0;
    if (endOn == null) {
      const k = passes.indexOf(layerIndex);
      from = k >= 0 && k < passes.length - 1 ? k : 0;        // from here on; from the start if at the end
    }
    const seq = passes.slice(from);
    if (endOn != null) seq.push(endOn);
    return seq;
  }
  function startPlay(onDone) {
    stopPlay();
    if (!grid) return false;
    const seq = playSequence();
    if (seq.length < 2) return false;
    play = { seq, k: 0, timer: null, done: onDone };
    const tick = () => {
      if (!play) return;
      go(play.seq[play.k++]);
      if (play.k >= play.seq.length) { const d = play.done; play = null; d?.(); return; }   // ends on the last one
      play.timer = setTimeout(tick, HOLD_MS);
    };
    tick();
    return true;
  }
  function stopPlay() {
    if (!play) return;
    clearTimeout(play.timer);
    const d = play.done;
    play = null;
    d?.();
  }

  // The timeline moved: show the latest processed pass on or before that date, keeping the same
  // kind of layer as the one on screen (from a non-pass layer: the first kind of pass layer)
  function showDate(iso, { select = true } = {}) {
    if (!grid) return;
    sliderDate = iso;
    const cur = grid.layers[layerIndex];
    if (select && !(isDated(cur) && cur.date === iso)) {
      const fam = isDated(cur) ? family(cur) : family(grid.layers.find(isDated) || cur);
      const options = grid.layers.map((l, i) => ({ l, i })).filter(({ l }) => isDated(l) && family(l) === fam)
        .sort((a, b) => (a.l.date < b.l.date ? -1 : 1));
      if (options.length) {
        const pick = [...options].reverse().find(({ l }) => l.date <= iso) || options[0];
        if (pick.i !== layerIndex) { const prev = layerIndex; layerIndex = pick.i; paint(prev); return; }
      }
    }
    updateWhen();
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
    const i = pickBlock(mouse.x, mouse.y);
    const tip = $('tv-tip');
    if (i < 0) { tip.hidden = true; return; }
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

  // colour blend + outline fade, done in the render loop
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  function animate(now) {
    // the alert ring fades in/out over ~0.4 s and keeps its 1.2 s rhythm
    alertOn += ((alertLatLon ? 1 : 0) - alertOn) * 0.12;
    if (alertOn < 0.002 && !alertLatLon) alertOn = 0;
    alertU.uAlertOn.value = alertOn;
    alertU.uAlertT.value = (now - alertT0) / 1000;
    if (blend) {
      const t = Math.min(1, (now - blend.t0) / (blend.ms || BLEND_MS)), e = ease(t);
      const { from, to } = blend, arr = mesh.instanceColor.array;
      for (let j = 0; j < arr.length; j++) arr[j] = from[j] + (to[j] - from[j]) * e;
      mesh.instanceColor.needsUpdate = true;
      if (t >= 1) blend = null;
    }
    if (flashMesh?.visible) {
      const age = now - flashT0;
      if (age >= FLASH_MS) flashMesh.visible = false;
      // reduced motion: the outline simply shows, then goes (no fading)
      else flashMesh.material.opacity = reducedMotion() ? 0.9 : age < 400 ? 1 : 1 - (age - 400) / (FLASH_MS - 400);
    }
  }

  renderer.setAnimationLoop(() => {
    if (!running) return;
    controls.update();
    animate(performance.now());
    hover();
    renderer.render(scene, camera);
  });

  $('tv-prev').addEventListener('click', () => stepTo(layerIndex - 1));
  $('tv-next').addEventListener('click', () => stepTo(layerIndex + 1));
  $('tv-globe').addEventListener('click', () => onGlobe?.());
  view.addEventListener('keydown', (e) => {
    if (e.target !== view) return;                 // keys inside the HUD boxes are theirs
    if (e.key === 'ArrowLeft') $('tv-prev').click();
    if (e.key === 'ArrowRight') $('tv-next').click();
    if (e.key === 'Enter' || e.key === 'i' || e.key === 'I') inspectAt(0, 0);
  });

  // ----- click (not drag) a block to inspect it -----
  // The block is found by walking along the view ray over the blocks' own heights (a heightfield
  // march), which is exact for a grid of blocks and doesn't depend on mesh picking.
  const _p = new THREE.Vector3();
  function pickBlock(nx, ny) {
    if (!mesh || !tops) return -1;
    mouse.set(nx, ny);
    ray.setFromCamera(mouse, camera);
    const { origin, direction } = ray.ray;
    if (direction.y >= 0) return -1;                            // looking up: no ground there
    const { rows, cols } = grid;
    const km = grid.block_m / 1000;
    const t0 = Math.max(0, (maxTop - origin.y) / direction.y);   // where the ray drops below the highest block
    const t1 = (0 - origin.y) / direction.y;                     // where it reaches the ground plane
    for (let t = t0; t <= t1; t += km / 6) {
      _p.copy(direction).multiplyScalar(t).add(origin);
      const c = Math.floor(_p.x / km + cols / 2), r = Math.floor(_p.z / km + rows / 2);
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      const i = r * cols + c;
      if (tops[i] > 0 && _p.y <= tops[i]) return i;
    }
    return -1;
  }
  function inspectAt(nx, ny) {
    const i = pickBlock(nx, ny);
    if (i >= 0) inspector.inspect(i);
  }
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    inspectAt(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  });

  return {
    // Show a case's terrain. Returns false if the case has no grid yet (globe stays).
    async open(caseInfo, gridPath, { onBackToGlobe, onLayerDate: onDate, date, numbers } = {}) {
      if (!gridPath) return false;
      isOpenNow = true;
      setShown(view, true);                                  // cross-fade in at once, with a loading line
      $('tv-case').textContent = `${caseInfo.name} · case terrain`;
      $('tv-layer').innerHTML = '<span class="loading-text">Loading case terrain</span>';
      try {
        grid = await fetch(gridPath).then((r) => r.json());
      } catch (err) {
        console.error(err);
        isOpenNow = false;
        setShown(view, false);
        return false;
      }
      stopPlay();
      caseId = caseInfo.id;
      method = numbers?.method || null;
      inspector.setCase(caseInfo, numbers, grid);
      // processed passes that have block values (inspect.json) but no grid layer yet -> dated layers
      const missing = missingPassDates(grid, numbers);
      if (missing.length) addPasses(grid, numbers, await inspector.data(), missing);
      layerIndex = Math.max(0, grid.layers.findIndex((l) => l.id === grid.default_layer));
      onGlobe = onBackToGlobe;
      onLayerDate = onDate;
      sliderDate = date || null;
      $('tv-case').textContent = `${caseInfo.name} · case terrain`;
      running = true;
      resize();
      build();
      // the ◀ ▶ stepper is only shown when there are at least two layers to step between
      setShown(view.querySelector('.terrain-stepper'), grid.layers.length > 1, { focusTo: view });
      // the slider jumps to the opening layer's pass (a non-pass layer leaves the slider alone)
      if (isDated(grid.layers[layerIndex])) onLayerDate?.(grid.layers[layerIndex].date);
      return true;
    },
    close() {
      if (!isOpenNow) return;
      stopPlay();
      setAlert(null);
      alertOn = 0;
      isOpenNow = false;
      // cross-fade out over the globe, which is already drawing again underneath
      setShown(view, false);
      setTimeout(() => { if (!isOpenNow) running = false; }, reducedMotion() ? 0 : 260);
      $('tv-tip').hidden = true;
      inspector.close();
    },
    get isOpen() { return isOpenNow; },
    showDate,
    // Live Ops: show the latest processed pass on or before isoDate, of the same kind as the layer
    // on screen (from a layer that isn't one pass: the first kind of pass layer), blending over
    // blendMs. Returns { layerId, date, exact } (exact = a layer exists for exactly that date), or
    // null if the terrain isn't open on caseId or no processed pass exists on or before that date
    // (it never shows a later pass than the date asked for).
    showLayerAt(id, iso, { blendMs = BLEND_MS } = {}) {
      if (!grid || !isOpenNow || caseId !== id) return null;
      const cur = grid.layers[layerIndex];
      const fam = isDated(cur) ? family(cur) : family(grid.layers.find(isDated) || cur);
      const pick = grid.layers.map((l, i) => ({ l, i })).filter(({ l }) => isDated(l) && family(l) === fam && l.date <= iso)
        .sort((a, b) => (a.l.date < b.l.date ? -1 : 1)).pop();
      if (!pick) return null;
      stopPlay();
      sliderDate = iso;
      if (pick.i !== layerIndex) {
        const prev = layerIndex;
        layerIndex = pick.i;
        paint(prev, { blendMs, always: true });
      } else updateWhen();
      return { layerId: pick.l.id, date: pick.l.date, exact: pick.l.date === iso };
    },
    inspectAt,
    // Live Ops: a red alert ring spreading from (lat, lon) over the terrain blocks; setAlert(null) stops it
    setAlert(lat, lon) { setAlert(lat, lon); },
    get alertActive() { return !!alertLatLon; },
    // The timeline's Play button drives this while the terrain is open (timeline.setPlayer)
    player: { start: (onDone) => startPlay(onDone), stop: () => stopPlay(), get playing() { return !!play; } },
    // What is on screen right now (read by our checks and handy in the browser console)
    get state() {
      const l = grid?.layers[layerIndex];
      return { layer: l?.id, date: l?.date, layers: grid?.layers.map((x) => x.id), playing: !!play,
        blending: !!blend, outlined: flashMesh?.visible ? flashMesh.count : 0 };
    },
    // the dates of the single-pass layers (for the timeline's "processed pass" ticks)
    get layerDates() { return grid ? [...new Set(grid.layers.filter(isDated).map((l) => l.date))].sort() : []; },
  };
}
