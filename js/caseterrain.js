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
//   - CHANGE REPLAY (js/replay.js) loops BEFORE -> fade -> AFTER -> CHANGE on the verdict's own passes
//     whenever a terrain is open (in Live Ops only after showLayerAt, so never past the event date).
//     The blend runs in the block shader: before/after colours are per-block attributes (aColA/aColB)
//     and one uniform (uMix) mixes them, so no colours are rewritten on the CPU each frame.
//   - Sea (no data, ground at or below 0 m) is ONE flat, dark, see-through water plane; land blocks
//     with no data are drawn hatched grey. The legend names the sea ("Pacific Ocean (not analysed)").

import * as THREE from 'three';
import { OrbitControls } from '../lib/three/OrbitControls.js';
import { esc, setShown, reducedMotion } from './util.js';
import { colourFor, legendGradient } from './datacolours.js';
import { createInspector } from './inspector.js';
import { flashRule, missingPassDates, addPasses } from './terraintime.js';
import { createSiAgent } from './siagent.js';
import { createReplay, buildPlan, loadReplayConfig } from './replay.js';

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
  geo.setAttribute('aFaceUv', geo.attributes.uv.clone());      // 0..1 across each face: the replay outline
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
  // Every overlay sits in ONE layer, a CSS grid with named regions (css/terrainlayout.css), so they
  // can never pile on top of each other when the terrain gets narrower:
  //   title (top-left)            si (top-right: the SI Agent trigger)
  //   main  (popovers dock here)  side (SI Agent panel, block inspector: dock here, right-aligned)
  //   bar   (bottom: stepper · pass banner · ⓘ Source · legend; wraps on narrow terrain)
  // Container queries on the terrain width rearrange the bar (>= 900 px one row; 640-899 the banner
  // gets its own row and the legend goes compact; < 640 the banner text goes short).
  view.innerHTML = `
    <div class="tv-overlay">
      <div class="terrain-hud terrain-top">
        <div class="tv-title-text">
          <p class="eyebrow" id="tv-case"></p>
          <p class="terrain-layer" id="tv-layer"></p>
          <p class="terrain-when" id="tv-when"></p>
        </div>
        <button class="ghost-btn" id="tv-globe">↩ Globe</button>
      </div>
      <div class="tv-si-slot" id="tv-si-slot"></div>
      <div class="tv-dock tv-main" id="tv-main">
        <div class="terrain-hud rp-label" id="rp-label" role="status" hidden></div>
        <div class="terrain-hud tv-pop" id="tv-pop" role="dialog" aria-label="Source and legend details" tabindex="-1" hidden>
          <div class="tv-pop-legend" id="tv-pop-legend"></div>
          <p class="tv-pop-label">Source</p>
          <p class="terrain-note" id="tv-note"></p>
        </div>
      </div>
      <div class="tv-dock tv-side" id="tv-side"></div>
      <div class="tv-bar" id="tv-bar">
        <div class="terrain-hud terrain-stepper" role="group" aria-label="Pass stepper">
          <button class="ghost-btn" id="tv-prev" aria-label="Previous layer">◀</button>
          <span id="tv-step"></span>
          <button class="ghost-btn" id="tv-next" aria-label="Next layer">▶</button>
        </div>
        <div class="tv-bar-extra" id="tv-bar-extra"></div>
        <div class="terrain-hud terrain-pass" id="tv-pass" role="status" aria-live="polite">
          <p class="tp-main"><span id="tv-pass-main" class="tp-long"></span><span id="tv-pass-short" class="tp-short" aria-hidden="true"></span></p>
          <p class="tp-sub" id="tv-pass-sub"></p>
          <p class="tp-key" id="tv-pass-key" hidden><span class="tp-swatch" aria-hidden="true"></span><span id="tv-pass-key-text"></span></p>
        </div>
        <button class="terrain-hud tv-src-btn" id="tv-src" aria-haspopup="dialog" aria-expanded="false" aria-controls="tv-pop">ⓘ Source</button>
        <div class="terrain-hud terrain-legend" id="tv-legend"></div>
      </div>
    </div>
    <div class="terrain-tip" id="tv-tip" hidden></div>`;
  container.appendChild(view);
  const $ = (id) => view.querySelector('#' + id);
  const inspector = createInspector(view);       // "What did the radar hit?" box (js/inspector.js)
  $('tv-side').appendChild(view.querySelector('.inspector'));     // the inspector docks in the side region
  // "SI Agent" overview + questions dropdown (js/siagent.js): trigger top-right, panel in the side region
  const siAgent = createSiAgent({ view, triggerSlot: $('tv-si-slot'), panelSlot: $('tv-side'), onOpen: () => closePop(false) });

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
  let sliderDate = null, onLayerDate = null, isOpenNow = false, widthEventDue = false;
  let tops = null, maxTop = 0;
  let caseId = null, method = null;
  let blend = null;                  // { from, to, t0 } while block colours move to a new layer
  let seaMesh = null, seaShare = 0, noDataCount = 0, seaName = null, blockH = null;
  let numbersNow = null, replayCfg = null, replayLimit = null, replayBanner = null, replaySink = null;
  let glide = null, homeView = null;     // CHANGE: the camera glides to the flashing cluster and back
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

  // ----- Change Replay on the GPU: per-block before/after colours, one blend uniform -----
  const replayU = {
    uMix: { value: 0 },          // 0 = before colours, 1 = after colours
    uReplayOn: { value: 0 },     // 0 = the stepper's layer (instance colours), 1 = the replay's pair
    uChgOn: { value: 0 },        // CHANGE phase: flash + rise + grey (eased 0..1)
    uRise: { value: 0.22 },      // flashing blocks grow 22% taller in the CHANGE phase
    uTime: { value: 0 },         // seconds, for the flash
    uFlashHz: { value: 1.5 },    // flashes per second (limit: 3)
    uSinkOn: { value: 0 },       // Jakarta: blocks move down by the measured motion (exaggerated)
    uHatch: { value: 20 },       // stripes per km for no-data land
  };
  function patchReplay(shader) {
    Object.assign(shader.uniforms, replayU);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
      attribute vec3 aColA; attribute vec3 aColB; attribute float aChg; attribute float aSinkA; attribute float aSinkB;
      attribute float aNoData; attribute vec2 aFaceUv;
      uniform float uMix; uniform float uReplayOn; uniform float uChgOn; uniform float uRise; uniform float uSinkOn;
      varying float vChg; varying vec2 vFaceUv; varying float vNoData; varying vec3 vWPos;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
      if (uReplayOn > 0.5) vColor.xyz = color.xyz * mix(aColA, aColB, uMix);
      // CHANGE: every block NOT past the threshold turns a flat 25% grey (keeping its face shading)
      vColor.xyz = mix(vColor.xyz, vec3(0.051) * color.x, uChgOn * uReplayOn * (1.0 - step(0.5, aChg)));`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      transformed.y *= 1.0 + step(0.5, aChg) * uRise * uChgOn * uReplayOn;       // CHANGE: flashing blocks rise
      transformed.y += uSinkOn * mix(aSinkA, aSinkB, uMix);                      // Jakarta: measured motion
      vChg = aChg; vFaceUv = aFaceUv; vNoData = aNoData;
      vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
      uniform float uChgOn; uniform float uReplayOn; uniform float uTime; uniform float uHatch; uniform float uFlashHz;
      varying float vChg; varying vec2 vFaceUv; varying float vNoData; varying vec3 vWPos;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      if (vNoData > 0.5) {                                                       // no-data land: hatched grey
        float st = step(0.5, fract((vWPos.x + vWPos.z) * uHatch));
        diffuseColor.rgb = mix(vec3(0.05), vec3(0.16), st);
      }
      // CHANGE: blocks past the threshold flash between their own colour and RED (the radar value fell,
      // #FF3B30), CYAN (it rose, #66FCF1) or ORANGE (a trap, #FF9F0A), 1.5 times a second, and glow (emissive)
      vec3 flashCol = vChg > 2.5 ? vec3(1.0, 0.354, 0.003) : mix(vec3(1.0, 0.0423, 0.0296), vec3(0.133, 0.973, 0.879), step(1.5, vChg));
      float flashK = step(0.5, vChg) * uChgOn * uReplayOn * (0.5 + 0.5 * sin(uTime * 6.2831853 * uFlashHz));
      diffuseColor.rgb = mix(diffuseColor.rgb, flashCol, flashK);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      totalEmissiveRadiance += flashCol * flashK * 0.8;`);
  }
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
    // Blocks with data in at least one layer are drawn; land with no data is drawn hatched grey;
    // sea (no data, ground at or below 0 m) is left to the one water plane below
    cells = [];
    const noData = new Set();
    let sea = 0;
    for (let i = 0; i < rows * cols; i++) {
      if (grid.layers.some((l) => l.values[i] != null)) cells.push(i);
      else if (grid.elev_dm[i] > 0) { cells.push(i); noData.add(i); }
      else sea++;
    }
    seaShare = sea / (rows * cols);
    noDataCount = noData.size;
    const blockMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    blockMaterial.onBeforeCompile = (shader) => { patchAlert(shader); patchReplay(shader); };   // alert ring + change replay
    mesh = new THREE.InstancedMesh(blockGeometry(), blockMaterial, cells.length);
    mesh.setColorAt(0, colour);                               // creates the per-block colour buffer
    blend = null;
    tops = new Float32Array(rows * cols);                     // block top heights, for picking a block by click
    blockH = new Float32Array(cells.length);
    const m = new THREE.Matrix4();
    cells.forEach((i, k) => {
      const r = Math.floor(i / cols), c = i % cols;
      const h = ((BASE_M + elev[i]) * exaggeration) / 1000;
      tops[i] = noData.has(i) ? 0 : h;                         // no-data blocks can't be hovered or inspected
      blockH[k] = h;
      m.makeScale(km * GAP, h, km * GAP);
      m.setPosition((c - cols / 2 + 0.5) * km, 0, (r - rows / 2 + 0.5) * km);
      mesh.setMatrixAt(k, m);
    });
    // per-block attributes for the change replay (filled when a replay starts)
    const g = mesh.geometry, N = cells.length;
    const inst = (size) => new THREE.InstancedBufferAttribute(new Float32Array(N * size), size);
    g.setAttribute('aColA', inst(3));
    g.setAttribute('aColB', inst(3));
    g.setAttribute('aChg', inst(1));
    g.setAttribute('aSinkA', inst(1));
    g.setAttribute('aSinkB', inst(1));
    const nd = inst(1);
    cells.forEach((i, k) => { if (noData.has(i)) nd.array[k] = 1; });
    g.setAttribute('aNoData', nd);
    replayU.uHatch.value = 2 / km;                            // about 2 stripes per block
    scene.add(mesh);
    maxTop = tops.reduce((a, v) => Math.max(a, v), 0);
    // the sea: ONE flat, dark, slightly see-through plane under the land blocks (not analysed)
    if (seaMesh) { scene.remove(seaMesh); seaMesh.geometry.dispose(); seaMesh.material.dispose(); seaMesh = null; }
    if (sea > 0) {
      seaMesh = new THREE.Mesh(new THREE.PlaneGeometry(cols * km, rows * km),
        new THREE.MeshBasicMaterial({ color: 0x0b2a40, transparent: true, opacity: 0.72, depthWrite: false }));
      seaMesh.rotation.x = -Math.PI / 2;
      seaMesh.position.y = (BASE_M * exaggeration) / 1000 / 2;
      seaMesh.renderOrder = -1;
      scene.add(seaMesh);
    }
    if (flashMesh) { scene.remove(flashMesh); flashMesh.geometry.dispose(); flashMesh.material.dispose(); }
    flashMesh = new THREE.InstancedMesh(ringGeometry(),
      new THREE.MeshBasicMaterial({ color: FLASH_COLOUR, transparent: true, depthWrite: false }), cells.length);
    flashMesh.count = 0;
    flashMesh.visible = false;
    flashMesh.frustumCulled = false;                          // its blocks change every switch
    flashMesh.renderOrder = 1;
    scene.add(flashMesh);
    const span = Math.max(rows, cols) * km;
    glide = null; homeView = null;
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
      ${layer.note ? `<p class="legend-note">${esc(layer.note)}</p>` : ''}
      ${legendExtras()}`;
    $('tv-legend').title = [layer.what, layer.note].filter(Boolean).join(' · ');
    // the popover repeats the legend's title and note (on narrow terrain the legend shows only its bar)
    $('tv-pop-legend').innerHTML = `<p class="tv-pop-label">Legend</p><p class="tv-pop-what">${esc(layer.what)}</p>
      ${layer.note ? `<p class="legend-note">${esc(layer.note)}</p>` : ''}${legendExtras()}`;
    $('tv-note').textContent =
      `${grid.block_text} · heights exaggerated ×${exaggeration} (${grid.height_source}) · values: ${layer.source}`;
    updateWhen();
  }

  // Legend rows for what is NOT data: the sea plane (named per case) and hatched no-data land
  function legendExtras() {
    const rows = [];
    if (seaShare > 0.005) rows.push(`<p class="legend-extra"><span class="sw-sea" aria-hidden="true"></span>${esc(seaName || 'Sea')} (not analysed)</p>`);
    if (noDataCount > 0) rows.push(`<p class="legend-extra"><span class="sw-hatch" aria-hidden="true"></span>Land with no data (masked)</p>`);
    return rows.join('');
  }

  // The line under the layer name (which pass is on screen, the next processed pass, the gap)
  // and the large pass label on the terrain
  function updateWhen() {
    const layer = grid.layers[layerIndex];
    const parts = [];
    let main, short, sub = '';
    const inGap = sliderDate && sliderDate >= GAP_DATES[0] && sliderDate <= GAP_DATES[1];
    if (isDated(layer)) {
      const same = grid.layers.filter((l) => isDated(l) && family(l) === family(layer)).map((l) => l.date).sort();
      const next = same.find((d) => d > layer.date);
      if (sliderDate && sliderDate < layer.date) parts.push(`No processed pass on or before ${fmtDate(sliderDate)} · showing the first, ${fmtDate(layer.date)}`);
      else parts.push(`Showing the pass of ${fmtDate(layer.date)}`);
      parts.push(next ? `next processed pass ${fmtDate(next)}` : 'no later processed pass');
      if (layer.leftOut) parts.push(`left out of the verdict: ${layer.leftOut}`);
      main = `Pass ${same.indexOf(layer.date) + 1} of ${same.length} · ${fmtDate(layer.date)}`;
      short = `Pass ${same.indexOf(layer.date) + 1}/${same.length} · ${fmtShort(layer.date)}`;
      if (sliderDate && sliderDate < layer.date) sub = `No processed pass before ${fmtDate(layer.date)}`;
      else if (sliderDate && sliderDate > layer.date) sub = next ? `No new pass until ${fmtDate(next)}` : 'No later processed pass';
      if (layer.leftOut) sub = [sub, 'Left out of the verdict (interference check)'].filter(Boolean).join(' · ');
    } else {
      parts.push(`Not a single pass (${layer.date || 'no date'}): reach it with ◀ ▶`);
      const r = rangeOf(layer);
      main = r ? `Change: ${fmtShort(r[0])} → ${fmtDate(r[1])}` : layer.label;
      short = r ? `${fmtShort(r[0])} → ${fmtShort(r[1])}` : layer.label;
      sub = r ? layer.label : 'Not a pass: the same on every date';
    }
    if (inGap) {
      parts.push(`${fmtDate(sliderDate)} is inside NASA's 27 Jul – 10 Aug 2026 data gap: no NISAR data`);
      if (isDated(layer)) sub = [sub, 'Slider is inside NASA’s 27 Jul – 10 Aug data gap'].filter(Boolean).join(' · ');
    }
    $('tv-when').textContent = parts.join(' · ');
    $('tv-when').title = parts.join(' · ');      // the line is cut to two lines on narrow terrain
    if (replayBanner) ({ main, short, sub = '' } = replayBanner);   // the change replay's phase
    // the title box follows the replay (which pass is on screen); with the replay paused by the stepper,
    // it shows the stepper's layer again
    $('tv-layer').textContent = replayBanner?.title || layer.label;
    if (replayBanner?.when) { $('tv-when').textContent = replayBanner.when; $('tv-when').title = replayBanner.when; }
    const mainEl = $('tv-pass-main');
    if (mainEl.textContent !== main) {
      mainEl.textContent = main;
      const line = mainEl.parentElement;
      if (replayBanner) line.classList.remove('is-new');      // no pop on every replay phase
      else {
      line.classList.remove('is-new');
      void line.offsetWidth;                    // restart the little "new pass" pop
      line.classList.add('is-new');
      }
    }
    $('tv-pass-short').textContent = short;     // shown instead of the long text on narrow terrain
    $('tv-pass-sub').textContent = sub;
    $('tv-pass-sub').hidden = !sub;
    const rule = isDated(layer) && flashRule(caseId, layer, method);
    const keyText = replayBanner ? (replayBanner.key || '') : (rule ? `Cyan outline: ${rule.text}` : '');
    $('tv-pass-key').dataset.swatch = replayBanner?.swatch || '';      // red / cyan / both flash swatch
    $('tv-pass-key').hidden = !keyText;
    $('tv-pass-key-text').textContent = keyText;
    $('tv-pass').dataset.phase = replayBanner?.phase || '';
    // the banner's lines end in "…" when the bar is tight; the tooltip has the whole text
    $('tv-pass').title = [main, sub, keyText].filter(Boolean).join('\n');
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
    replay.suspend();                          // a person's hand on the stepper pauses the change replay
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
    const layer = replay.currentLayer() || grid.layers[layerIndex];
    const v = layer.values[i];
    tip.innerHTML = `
      <strong>${v == null ? 'no data' : `${(v / 10).toFixed(1)} ${esc(layer.unit)}`}</strong>
      <span>${esc(layer.label)}</span>
      <span>${esc(layer.source)}</span>
      <span>ground ${(Math.max(0, grid.elev_dm[i] / 10)).toFixed(0)} m (Terrarium)</span>`;
    placeTip(e.clientX, e.clientY);
  }

  // Put the hover tooltip next to the pointer where it covers no overlay: try right-below, left-below,
  // right-above, left-above (it flips near edges), clamp it inside the terrain, and hide it if no
  // spot is free. Overlays = every box in the overlay layer plus the open SI panel / popovers.
  const OVERLAYS = '.tv-overlay .terrain-hud:not([hidden]), .si-trigger:not([hidden]), .si-panel:not([hidden])';
  function placeTip(clientX, clientY) {
    const tip = $('tv-tip');
    const vr = view.getBoundingClientRect();
    tip.style.visibility = 'hidden';
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const M = 6;                                         // keep this far from any overlay
    const boxes = [...view.querySelectorAll(OVERLAYS)].map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height);
    const x = clientX - vr.left, y = clientY - vr.top;
    const tries = [[x + 14, y + 14], [x - 14 - w, y + 14], [x + 14, y - 14 - h], [x - 14 - w, y - 14 - h]];
    for (const [tx, ty] of tries) {
      const l = Math.min(Math.max(8, tx), vr.width - 8 - w), t = Math.min(Math.max(8, ty), vr.height - 8 - h);
      const L = vr.left + l, T = vr.top + t;
      const hit = boxes.some((r) => L < r.right + M && L + w > r.left - M && T < r.bottom + M && T + h > r.top - M);
      if (!hit) {
        tip.style.left = `${l}px`;
        tip.style.top = `${t}px`;
        tip.style.visibility = '';
        return true;
      }
    }
    tip.hidden = true;
    tip.style.visibility = '';
    return false;
  }

  // colour blend + outline fade, done in the render loop
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  function animate(now) {
    // the alert ring fades in/out over ~0.4 s and keeps its 1.2 s rhythm
    alertOn += ((alertLatLon ? 1 : 0) - alertOn) * 0.12;
    if (alertOn < 0.002 && !alertLatLon) alertOn = 0;
    alertU.uAlertOn.value = alertOn;
    alertU.uAlertT.value = (now - alertT0) / 1000;
    replayU.uTime.value = now / 1000;
    replay.tick(now);
    if (glide) {                                       // camera glide (about 1 s, eased)
      const u = Math.min(1, (now - glide.start) / glide.ms), e = ease(u);
      camera.position.lerpVectors(glide.p0, glide.p1, e);
      controls.target.lerpVectors(glide.t0, glide.t1, e);
      if (u >= 1) glide = null;
    }
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
    if (widthEventDue) {
      widthEventDue = false;
      requestAnimationFrame(() => { if (isOpenNow) window.dispatchEvent(new CustomEvent('omnisar:terrain', { detail: { open: true } })); });
    }
  });

  // ----- Change Replay (js/replay.js): this adapter is how it draws -----
  const isLive = () => document.body.classList.contains('mode-live');
  function sinkOf(layer) {
    const a = new Float32Array(cells.length);
    if (!replaySink) return a;
    cells.forEach((i, k) => {
      const v = layer.values[i];
      // metres of world height for this motion, then as a share of this block's own (scaled) height
      a[k] = v == null ? 0 : ((v / 10 / 1000) * replaySink.factor / 1000) / blockH[k];
    });
    return a;
  }
  const replay = createReplay({
    slot: $('tv-bar-extra'),
    onTrapToggle: (on) => startReplay({ trap: on }),
    adapter: {
      setPair(a, b) {
        const g = mesh.geometry;
        g.attributes.aColA.array.set(coloursOf(a)); g.attributes.aColA.needsUpdate = true;
        g.attributes.aColB.array.set(coloursOf(b)); g.attributes.aColB.needsUpdate = true;
        g.attributes.aSinkA.array.set(sinkOf(a)); g.attributes.aSinkA.needsUpdate = true;
        g.attributes.aSinkB.array.set(sinkOf(b)); g.attributes.aSinkB.needsUpdate = true;
      },
      setMix(t) { replayU.uMix.value = t; },
      setChange(c) { replayU.uChgOn.value = c; },
      setMask(mask) {
        const arr = mesh.geometry.attributes.aChg;
        cells.forEach((i, k) => { arr.array[k] = mask[i]; });
        arr.needsUpdate = true;
      },
      setOn(on, plan) {
        replaySink = on ? plan?.sink || null : replaySink;
        replayU.uReplayOn.value = on ? 1 : 0;
        replayU.uSinkOn.value = on && plan?.sink ? 1 : 0;
        if (on && flashMesh) flashMesh.visible = false;
      },
      setBanner(b) { replayBanner = b; if (grid?.layers[layerIndex]) updateWhen(); },
      setLabel(text) { const el = $('rp-label'); el.textContent = text || ''; el.hidden = !text; },
      // CHANGE: glide to frame the largest flashing cluster; null = glide back to where the view was.
      // In Live Ops it stays put while a card is waiting for an answer (no moving target mid-question).
      focus(cluster) {
        if (!grid) return;
        const startGlide = (p1, t1) => {
          glide = { p0: camera.position.clone(), t0: controls.target.clone(), p1, t1, start: performance.now(), ms: 1000 };
        };
        if (!cluster) {
          if (homeView) startGlide(homeView.p, homeView.t);
          homeView = null;
          return;
        }
        if (isLive() && document.querySelector('.lo-card .lo-answer:not(:disabled)')) return;
        if (!homeView) homeView = { p: camera.position.clone(), t: controls.target.clone() };
        const km = grid.block_m / 1000;
        const t1 = new THREE.Vector3((cluster.c - grid.cols / 2 + 0.5) * km, 0, (cluster.r - grid.rows / 2 + 0.5) * km);
        const dir = homeView.p.clone().sub(homeView.t).normalize();
        const extent = Math.max(cluster.spanRows, cluster.spanCols) * km;
        const dist = Math.min(homeView.p.distanceTo(homeView.t), Math.max(extent * 1.8, controls.minDistance * 1.5));
        startGlide(t1.clone().addScaledVector(dir, dist), t1);
      },
    },
  });
  // Build and start the replay for the open case (limit = Live Ops event date, trap = Jebel Ali's toggle)
  let replayToken = 0;
  async function startReplay({ trap = false } = {}) {
    const my = ++replayToken;
    replayCfg ||= await loadReplayConfig();
    if (my !== replayToken || !isOpenNow || !grid || !mesh) return;
    const plan = buildPlan({ caseId, grid, numbers: numbersNow, config: replayCfg, limit: replayLimit, trap, flashRule, live: isLive() });
    if (!plan) { replay.stop(); return; }
    // the stepper, legend and inspector follow the AFTER pass; the shader shows the replay's colours
    const li = grid.layers.indexOf(plan.steps[plan.steps.length - 1]);
    if (li >= 0 && li !== layerIndex) { layerIndex = li; paint(null); }
    replay.load(plan);
  }

  $('tv-prev').addEventListener('click', () => stepTo(layerIndex - 1));
  $('tv-next').addEventListener('click', () => stepTo(layerIndex + 1));
  $('tv-globe').addEventListener('click', () => onGlobe?.());

  // ----- "ⓘ Source" popover: the source note (and, on narrow terrain, the legend's title and note) -----
  function onPopDown(e) { if (!$('tv-pop').contains(e.target) && e.target !== $('tv-src')) closePop(false); }
  function openPop() {
    siAgent.close();                                   // one popover at a time
    $('tv-tip').hidden = true;
    $('tv-pop').hidden = false;
    $('tv-src').setAttribute('aria-expanded', 'true');
    $('tv-pop').focus({ preventScroll: true });
    document.addEventListener('pointerdown', onPopDown, true);
  }
  function closePop(returnFocus = true) {
    if ($('tv-pop').hidden) return;
    const had = $('tv-pop').contains(document.activeElement);
    $('tv-pop').hidden = true;
    $('tv-src').setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onPopDown, true);
    if (returnFocus && had) $('tv-src').focus({ preventScroll: true });
  }
  $('tv-src').addEventListener('click', () => ($('tv-pop').hidden ? openPop() : closePop()));
  $('tv-pop').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } });
  view.addEventListener('keydown', (e) => {
    if (e.target !== view) return;                 // keys inside the HUD boxes are theirs
    if (e.key === 'ArrowLeft') $('tv-prev').click();
    if (e.key === 'ArrowRight') $('tv-next').click();
    if (e.key === 'Enter' || e.key === 'i' || e.key === 'I') inspectAt(0, 0);
    if (e.key === ' ') { e.preventDefault(); replay.toggle(); }       // Space: pause / play the change replay
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
        window.dispatchEvent(new CustomEvent('omnisar:terrain', { detail: { open: false } }));
        setShown(view, false);
        return false;
      }
      stopPlay();
      caseId = caseInfo.id;
      method = numbers?.method || null;
      numbersNow = numbers || null;
      seaName = caseInfo.sea || null;
      replay.stop();
      replayLimit = null;
      inspector.setCase(caseInfo, numbers, grid);
      siAgent.setCase(caseInfo, numbers);          // a different case closes it and reloads its content
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
      // the change replay starts at once in classic; in Live Ops it waits for showLayerAt (the event date)
      if (!isLive()) startReplay();
      // the panel moves to its terrain width once the first terrain frame is drawn (that frame compiles the
      // block shader and can block the page for ~0.3 s), so its 250 ms width animation runs smoothly
      widthEventDue = true;
      // the ◀ ▶ stepper is only shown when there are at least two layers to step between
      setShown(view.querySelector('.terrain-stepper'), grid.layers.length > 1, { focusTo: view });
      // the slider jumps to the opening layer's pass (a non-pass layer leaves the slider alone)
      if (isDated(grid.layers[layerIndex])) onLayerDate?.(grid.layers[layerIndex].date);
      return true;
    },
    close() {
      if (!isOpenNow) return;
      stopPlay();
      replayToken++;
      replay.stop();
      setAlert(null);
      alertOn = 0;
      isOpenNow = false;
      closePop(false);
      window.dispatchEvent(new CustomEvent('omnisar:terrain', { detail: { open: false } }));   // panel -> its globe width
      // cross-fade out over the globe, which is already drawing again underneath
      setShown(view, false);
      setTimeout(() => { if (!isOpenNow) running = false; }, reducedMotion() ? 0 : 260);
      $('tv-tip').hidden = true;
      inspector.close();
      siAgent.clear();
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
      replayLimit = iso;                          // the replay never uses a pass after the event date
      startReplay();
      if (pick.i !== layerIndex) {
        const prev = layerIndex;
        layerIndex = pick.i;
        paint(prev, { blendMs, always: true });
      } else updateWhen();
      return { layerId: pick.l.id, date: pick.l.date, exact: pick.l.date === iso };
    },
    inspectAt,
    // Live Ops: hold the change replay on its AFTER phase while a trap card is shown, then carry on
    replayFreeze(on) { replay.freeze(on); },
    // the change replay's controls and state (tests and the browser console)
    replay: {
      get state() { return replay.state; },
      toggle: () => replay.toggle(),
      setSpeed: (x) => replay.setSpeed(x),
      trap: (on) => startReplay({ trap: on }),
    },
    // tests: the screen point (client px) of the top of the flashing block nearest the camera's focus
    replayProbe() {
      const st = replay.state, plan = replay.plan;
      if (!st || !plan?.focus || !grid) return null;
      const km = grid.block_m / 1000, f = plan.focus;
      let best = -1, bd = Infinity;
      cells.forEach((i, k) => {
        if (!plan.mask[i]) return;
        const r = Math.floor(i / grid.cols), c = i % grid.cols, d = (r - f.r) ** 2 + (c - f.c) ** 2;
        if (d < bd) { bd = d; best = k; }
      });
      if (best < 0) return null;
      const i = cells[best], r = Math.floor(i / grid.cols), c = i % grid.cols;
      const v = new THREE.Vector3((c - grid.cols / 2 + 0.5) * km, blockH[best] * (1 + replayU.uRise.value), (r - grid.rows / 2 + 0.5) * km).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height, colour: ['', 'red', 'cyan', 'orange'][plan.mask[i]] };
    },
    // tests: show the hover tooltip as if the pointer were at (clientX, clientY); false = no free spot
    testTip(clientX, clientY) {
      $('tv-tip').innerHTML = '<strong>-12.3 dB</strong><span>Test layer label</span><span>Test source line for the tooltip</span><span>ground 120 m (Terrarium)</span>';
      return placeTip(clientX, clientY);
    },
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
