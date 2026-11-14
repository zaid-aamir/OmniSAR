// The blocky globe: one flat-shaded block per grid cell, drawn as TWO InstancedMeshes
// (land and ocean: the GPU draws ~41,000 copies of the same box in two calls, each copy with its
// own position, size and colour). Colours = NASA Blue Marble, heights = AWS Terrarium elevation,
// both prepared by tools/build_globe_assets.py into assets/globe/.
//
// Every block is still one real data cell. The lights, the atmosphere glow and the stars
// (js/globefx.js) are visual only: they add depth, never new colours or new data.
//
// ?fx=low  -> lighter mode for slow computers: pixel ratio 1, fewer stars, no star shimmer.
// The globe also switches itself to that mode if it measures under ~50 frames per second.

import * as THREE from 'three';
import { OrbitControls } from '../lib/three/OrbitControls.js';
import { createAtmosphere, createStars, cssToColour } from './globefx.js';

const EARTH_RADIUS_M = 6371000;
const BASE_DEPTH = 0.02;   // how far each block reaches below sea level (globe radius = 1)
const GAP = 0.86;          // block width (east-west) as a share of its cell: the 14% gap shows as a thin dark edge
const GAP_NS = 0.95;       // north-south the rows nearly touch: rows have different block counts, so wide gaps
                           // between them looked like dark seam lines (polish list, 14 Nov)
const SIDE_SHADE = 0.74;   // block sides are drawn this much darker than the top, so each block reads as a cube
const ATMOSPHERE_RADIUS = 1.06;   // outside the tallest block (1 + 5426 m × 40 / 6371 km ≈ 1.034)
const AO_RANGE_M = 1500;   // a neighbour this much taller (real metres) gives the full "valley" darkening

// Latitude/longitude (degrees) -> point in 3D. Every file uses this one function,
// so markers and camera moves always line up with the blocks.
export function latLonToVector(lat, lon, radius = 1) {
  const phi = THREE.MathUtils.degToRad(lat);
  const lambda = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    radius * Math.cos(phi) * Math.cos(lambda),
    radius * Math.sin(phi),
    -radius * Math.cos(phi) * Math.sin(lambda)
  );
}

async function loadAssets() {
  const meta = await (await fetch('assets/globe/globe.json')).json();
  const heights = new Int16Array(await (await fetch('assets/globe/height.bin')).arrayBuffer());

  // Read the colour PNG's pixels through an invisible canvas
  const img = new Image();
  img.src = 'assets/globe/colour.png';
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = meta.cols;
  canvas.height = meta.rows;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, meta.cols, meta.rows).data;   // RGBA, 4 bytes per cell

  return { meta, heights, pixels };
}

// A unit box whose top face is full brightness and whose sides are darker.
// The darkness is stored as a per-corner colour and multiplied with each block's own colour.
function makeBlockGeometry() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const normals = geo.attributes.normal;
  const shade = new Float32Array(normals.count * 3);
  for (let i = 0; i < normals.count; i++) {
    const ny = normals.getY(i);
    const s = ny > 0.5 ? 1 : ny < -0.5 ? 0.4 : SIDE_SHADE;   // top / bottom / sides
    shade.set([s, s, s], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(shade, 3));
  return geo;
}

// Rows of cells near the poles are shorter, so we use fewer blocks there.
// That keeps every block roughly square instead of squashing thousands into the poles.
function layoutCells(meta) {
  const cells = [];
  for (let row = 0; row < meta.rows; row++) {
    const lat = 90 - (row + 0.5) * meta.cellDeg;
    const count = Math.max(1, Math.round(meta.cols * Math.cos(THREE.MathUtils.degToRad(lat))));
    for (let k = 0; k < count; k++) {
      const lon = -180 + ((k + 0.5) * 360) / count;
      const col = Math.min(meta.cols - 1, Math.floor((lon + 180) / meta.cellDeg));
      cells.push({ lat, lon, index: row * meta.cols + col, widthDeg: 360 / count });
    }
  }
  return cells;
}

// Fake ambient occlusion, worked out once from the height grid (no extra cost per frame).
// For each cell we look at its 8 neighbours:
//   valley = how much taller the tallest neighbour is (0..1) -> the whole block is a little darker
//   floor  = the lowest neighbour's top -> the block's walls get darker towards where they meet it,
//            like the soft shadow at the foot of a wall. This makes mountain ranges read with depth.
function occlusion(heights, meta, index, toRadius) {
  const row = Math.floor(index / meta.cols);
  const col = index % meta.cols;
  const own = Math.max(0, heights[index]);
  let hi = own;
  let lo = own;
  for (let dr = -1; dr <= 1; dr++) {
    const r = row + dr;
    if (r < 0 || r >= meta.rows) continue;
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const c = (col + dc + meta.cols) % meta.cols;          // wraps around at 180°
      const h = Math.max(0, heights[r * meta.cols + c]);
      hi = Math.max(hi, h);
      lo = Math.min(lo, h);
    }
  }
  return [Math.min(1, (hi - own) / AO_RANGE_M), toRadius(lo)];
}

// The block material: MeshStandardMaterial with flat faces, plus three small additions to its shader:
//   1. the fake ambient occlusion above (per block, from the 'aoData' instance attribute)
//   2. a very faint blue haze on blocks near the globe's edge, so they blend into the atmosphere.
//      It is part of the BLOCK shader, so it can never tint the beacons.
//   3. 'lift': a little extra even light (the block's own colour × lift). Used for the ocean only:
//      the ACES film curve pushes very dark colours towards black, which hid the darkest
//      Blue Marble sea depths on the side away from the key light.
// Lighting only scales brightness; the hue of each block stays its Blue Marble colour.
const sharedUniforms = {
  uHaze: { value: new THREE.Color('#5aa6ff') },
  uHazeStrength: { value: 0.32 },
};
//
// 'hooks' (filled by addShaderHook, see createGlobe below) are extra shader edits from other files,
// e.g. js/ripples.js. They run AFTER the globe's own edits, on both block materials.
function makeBlockMaterial({ roughness, metalness = 0, lift = 0, hooks = [] }) {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness, metalness,
  });
  // three.js reuses a compiled shader if this key is unchanged, so the key names every hook:
  // adding a hook changes the key, which makes three.js compile a new shader with the hook in it.
  material.customProgramCacheKey = () => `globe-blocks|${hooks.map((h) => h.key).join(',')}`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sharedUniforms, { uLift: { value: lift } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aoData;
        varying vec3 vGlobePos;
        varying float vWall, vValley, vFloor;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGlobePos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        vWall = abs(normal.y) < 0.5 ? 1.0 : 0.0;   // 1 on the four side faces
        vValley = aoData.x;
        vFloor = aoData.y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uHaze;
        uniform float uHazeStrength, uLift;
        varying vec3 vGlobePos;
        varying float vWall, vValley, vFloor;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float above = (length(vGlobePos) - vFloor) / 0.006;          // ~950 m (×40) above the lowest neighbour
        float wall = mix(0.6, 1.0, smoothstep(0.0, 1.0, above));     // darker at the foot of a wall
        diffuseColor.rgb *= mix(1.0, wall, vWall) * (1.0 - 0.2 * vValley);`)
      .replace('#include <opaque_fragment>', `
        outgoingLight += diffuseColor.rgb * uLift;
        vec3 toCam = normalize(cameraPosition - vGlobePos);
        float edge = 1.0 - clamp(dot(normalize(vGlobePos), toCam), 0.0, 1.0);   // 0 facing us, 1 at the edge
        outgoingLight = mix(outgoingLight, uHaze * 0.55, pow(edge, 3.0) * uHazeStrength);
        #include <opaque_fragment>`);
    for (const hook of hooks) {
      try {
        if (hook.patch(shader) === true) hook.applied += 1;   // the hook says it found its places in the shader
        else hook.failed = true;
      } catch (err) {
        hook.failed = true;
        console.warn(`globe: shader hook '${hook.key}' failed`, err);
      }
    }
  };
  return material;
}

export async function createGlobe(container, start = { lat: 22, lon: 45, distance: 3.2 }) {
  const { meta, heights, pixels } = await loadAssets();
  const cells = layoutCells(meta);
  const params = new URLSearchParams(location.search);
  let fxLow = params.get('fx') === 'low';

  // --- Scene, camera, renderer ---
  const scene = new THREE.Scene();
  // Solid background in the palette's own page colour, so the additive glow and stars blend predictably
  scene.background = cssToColour(getComputedStyle(container).backgroundColor);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  camera.position.copy(latLonToVector(start.lat, start.lon, start.distance));

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  const pixelRatio = () => (fxLow ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.setPixelRatio(pixelRatio());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // film-like contrast; soft highlights
  renderer.toneMappingExposure = 0.86;   // tuned so blocks keep their old brightness (checked on screenshots)
  container.appendChild(renderer.domElement);

  // --- Lights (all turn with the camera, so the side you look at is always lit: no night side hiding data) ---
  // key: sun from the upper left of the view · fill: hemisphere, faintly cool sky above, faintly warm ground below
  // rim: cool blue from behind, outlining the globe's edge to pair with the atmosphere
  // The key and fill tints are kept very faint on purpose: stronger warm/cool tints measurably shifted the
  // Blue Marble land colours (desert hue moved ~5°), and the colours are data.
  const key = new THREE.DirectionalLight(0xfffdfa, 1.5);
  const fill = new THREE.HemisphereLight(0xf7faff, 0xfcfaf6, 2.5);
  const rim = new THREE.DirectionalLight(0x8fc2ff, 1.4);
  scene.add(key, fill, rim);          // directional lights aim at their target, which stays at the centre
  const KEY_DIR = new THREE.Vector3(-0.55, 0.6, 0.6).normalize();   // in camera space: left, up, towards us
  const RIM_DIR = new THREE.Vector3(0.35, 0.25, -1).normalize();    // from behind the globe
  const UP = new THREE.Vector3(0, 1, 0);
  function placeLights() {
    key.position.copy(KEY_DIR).applyQuaternion(camera.quaternion).multiplyScalar(10);
    rim.position.copy(RIM_DIR).applyQuaternion(camera.quaternion).multiplyScalar(10);
    fill.position.copy(UP).applyQuaternion(camera.quaternion);      // "sky" = the top of the screen
  }

  // --- The blocks: land and ocean in two meshes, so the ocean can be smoother (a soft glint) ---
  const exaggeration = meta.heightExaggeration;
  const toRadius = (h) => 1 + (Math.max(0, h) / EARTH_RADIUS_M) * exaggeration;
  const isOcean = (c) => {
    const p = c.index * 4;
    return heights[c.index] <= 0 && pixels[p + 2] > pixels[p] + 10;   // at sea level AND blue in Blue Marble
  };
  const groups = {
    land: cells.filter((c) => !isOcean(c)),
    ocean: cells.filter(isOcean),
  };
  const shaderHooks = [];   // extra shader edits added later with addShaderHook()
  const materials = {
    land: makeBlockMaterial({ roughness: 0.95, hooks: shaderHooks }),     // matte
    ocean: makeBlockMaterial({ roughness: 0.55, lift: 0.35, hooks: shaderHooks }),   // smoother: catches the key light
  };

  const m = new THREE.Matrix4();
  const up = new THREE.Vector3();
  const east = new THREE.Vector3();
  const third = new THREE.Vector3();
  const size = new THREE.Vector3();
  const colour = new THREE.Color();
  const cellRad = THREE.MathUtils.degToRad(meta.cellDeg);
  const meshes = {};

  for (const [name, list] of Object.entries(groups)) {
    const mesh = new THREE.InstancedMesh(makeBlockGeometry(), materials[name], list.length);   // own copy: holds its own aoData
    mesh.name = `${name} blocks`;
    const ao = new Float32Array(list.length * 2);
    list.forEach((c, i) => {
      const lambda = THREE.MathUtils.degToRad(c.lon);
      up.copy(latLonToVector(c.lat, c.lon));                       // straight out from the centre
      east.set(-Math.sin(lambda), 0, -Math.cos(lambda));           // along the line of latitude
      third.crossVectors(east, up);                                // along the line of longitude

      const top = toRadius(heights[c.index]);
      const bottom = 1 - BASE_DEPTH;
      const widthEast = THREE.MathUtils.degToRad(c.widthDeg) * Math.cos(THREE.MathUtils.degToRad(c.lat));

      m.makeBasis(east, up, third);                                // turn the box to face outward
      m.scale(size.set(widthEast * GAP, top - bottom, cellRad * GAP_NS));
      m.setPosition(up.multiplyScalar((top + bottom) / 2));
      mesh.setMatrixAt(i, m);

      const p = c.index * 4;
      colour.setRGB(pixels[p] / 255, pixels[p + 1] / 255, pixels[p + 2] / 255, THREE.SRGBColorSpace);
      mesh.setColorAt(i, colour);
      ao.set(occlusion(heights, meta, c.index, toRadius), i * 2);
    });
    mesh.geometry.setAttribute('aoData', new THREE.InstancedBufferAttribute(ao, 2));
    scene.add(mesh);
    meshes[name] = mesh;
  }

  // A dark ball just under the blocks: what you see through the gaps
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(1 - BASE_DEPTH * 0.6, 64, 32),
    new THREE.MeshBasicMaterial({ color: 0x05070a })
  );
  scene.add(core);

  // --- Visual-only extras: atmosphere glow + stars (js/globefx.js) ---
  scene.add(createAtmosphere(ATMOSPHERE_RADIUS));
  const stars = createStars({ count: fxLow ? 1500 : 4000, pixelRatio: pixelRatio(), shimmer: !fxLow });
  scene.add(stars.object);

  // --- Mouse / touch controls ---
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 0.8;
  controls.minDistance = 1.25;     // can't fly through the ground
  controls.maxDistance = 5;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35; // slow spin until someone touches the globe
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  // --- Keep the drawing the size of its box ---
  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // --- Speed check: after a short warm-up, measure ~2 s of drawing; under ~50 fps -> switch to the light mode ---
  const fx = { level: fxLow ? 'low (?fx=low)' : 'full', fps: null };
  let lastTime = null;
  let warm = 0, total = 0, frames = 0;
  function watchSpeed(time) {
    if (fx.fps !== null) return;
    const gap = lastTime === null ? null : time - lastTime;
    lastTime = time;
    if (gap === null || gap > 1000) return;    // first frame, or the tab was hidden / the view was paused
    if (warm < 500) { warm += gap; return; }    // ignore the first half second (shaders still warming up)
    total += gap;
    frames += 1;
    if (total < 2000) return;
    fx.fps = Math.round((frames * 1000) / total);
    if (fx.fps < 50 && !fxLow) {
      fxLow = true;
      fx.level = `low (auto, measured ${fx.fps} fps)`;
      renderer.setPixelRatio(1);
      stars.setPixelRatio(1);
      resize();
    }
  }

  // --- Draw every frame; other files can add their own per-frame work ---
  const frameCallbacks = [];
  let paused = false;            // true while the case terrain view covers the globe
  renderer.setAnimationLoop((time) => {
    if (paused) { lastTime = null; return; }
    controls.update();
    frameCallbacks.forEach((fn) => fn(time));
    placeLights();
    stars.update(camera, time);
    renderer.render(scene, camera);
    watchSpeed(time);
  });

  // --- Smooth camera flight to a place ---
  // The camera swings around the globe along a great circle (slerp of its direction)
  // while its distance changes, so it never cuts through the Earth.
  let flight = null;
  function flyTo(lat, lon, distance = 1.6, seconds = 1.6) {
    controls.autoRotate = false;
    flight = {
      fromDir: camera.position.clone().normalize(),
      toDir: latLonToVector(lat, lon),
      fromDist: camera.position.length(),
      toDist: distance,
      start: performance.now(),
      ms: seconds * 1000,
    };
    controls.enabled = false;     // no dragging mid-flight
  }
  const qFrom = new THREE.Quaternion();
  const qStep = new THREE.Quaternion();
  frameCallbacks.push(() => {
    if (!flight) return;
    const t = Math.min(1, (performance.now() - flight.start) / flight.ms);
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;   // slow-fast-slow
    qFrom.setFromUnitVectors(flight.fromDir, flight.toDir);
    qStep.identity().slerp(qFrom, ease);
    const dist = flight.fromDist + (flight.toDist - flight.fromDist) * ease;
    camera.position.copy(flight.fromDir).applyQuaternion(qStep).multiplyScalar(dist);
    camera.lookAt(0, 0, 0);
    if (t === 1) {
      flight = null;
      controls.enabled = true;
    }
  });

  // --- Let other files add to the block shader (used by js/ripples.js for the red alert rings) ---
  // addShaderHook(key, patch) -> true / false
  //   patch(shader) gets the block shader AFTER the globe's own edits (shader.vertexShader,
  //   shader.fragmentShader, shader.uniforms) and must return true if it found the lines it edits.
  //   The globe recompiles both block materials at once and draws one frame to test the result.
  //   If the patch threw, returned false, or the GPU refused to compile it, the hook is taken out again,
  //   the globe goes back to its normal shader, and the answer is false (the caller should use a fallback).
  //   Call it once at start-up, not in the middle of an animation: compiling takes a moment.
  function recompileBlocks() {
    Object.values(materials).forEach((mat) => { mat.needsUpdate = true; });
    renderer.render(scene, camera);   // compiles the new shaders and checks them for errors
  }
  function addShaderHook(key, patch) {
    if (shaderHooks.some((h) => h.key === key)) return true;   // already added
    const hook = { key, patch, applied: 0, failed: false };
    shaderHooks.push(hook);
    let ok = true;
    try {
      recompileBlocks();
      const compiled = Object.values(materials).every((mat) => {
        const program = renderer.properties.get(mat).currentProgram;
        return program && !(program.diagnostics && program.diagnostics.runnable === false);
      });
      ok = compiled && !hook.failed && hook.applied >= Object.keys(materials).length;
    } catch (err) {
      console.warn(`globe: shader hook '${key}' could not be compiled`, err);
      ok = false;
    }
    if (!ok) {
      shaderHooks.splice(shaderHooks.indexOf(hook), 1);
      try { recompileBlocks(); } catch (err) { console.warn('globe: could not restore the block shader', err); }
    }
    return ok;
  }

  return {
    scene, camera, controls, renderer, meta, fx,
    blockCount: cells.length,
    blockMaterials: Object.values(materials),   // [land, ocean]: the two block materials (read-only use, please)
    addShaderHook,
    onFrame: (fn) => frameCallbacks.push(fn),
    setPaused: (p) => { paused = p; },
    flyTo,
  };
}
