// The blocky globe: one flat-shaded block per grid cell, all drawn in ONE InstancedMesh
// (the GPU draws ~41,000 copies of the same box in one go, each with its own position,
// size and colour). Colours = NASA Blue Marble, heights = AWS Terrarium elevation,
// both prepared by tools/build_globe_assets.py into assets/globe/.

import * as THREE from 'three';
import { OrbitControls } from '../lib/three/OrbitControls.js';

const EARTH_RADIUS_M = 6371000;
const BASE_DEPTH = 0.02;   // how far each block reaches below sea level (globe radius = 1)
const GAP = 0.86;          // block width as a share of its cell: the 14% gap shows as a thin dark edge
const SIDE_SHADE = 0.68;   // block sides are drawn this much darker than the top

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

export async function createGlobe(container, start = { lat: 22, lon: 45, distance: 3.2 }) {
  const { meta, heights, pixels } = await loadAssets();
  const cells = layoutCells(meta);

  // --- Scene, camera, renderer ---
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  camera.position.copy(latLonToVector(start.lat, start.lon, start.distance));

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);   // transparent: the page background (palette) shows through
  container.appendChild(renderer.domElement);

  // --- Lights: soft light from everywhere + one light that follows the camera ---
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.position.set(0.6, 0.8, 1);   // relative to the camera: a little above and to the right
  camera.add(sun);
  scene.add(camera);

  // --- The blocks ---
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.InstancedMesh(makeBlockGeometry(), material, cells.length);

  const m = new THREE.Matrix4();
  const up = new THREE.Vector3();
  const east = new THREE.Vector3();
  const third = new THREE.Vector3();
  const colour = new THREE.Color();
  const cellRad = THREE.MathUtils.degToRad(meta.cellDeg);
  const exaggeration = meta.heightExaggeration;

  cells.forEach((c, i) => {
    const lambda = THREE.MathUtils.degToRad(c.lon);
    up.copy(latLonToVector(c.lat, c.lon));                       // straight out from the centre
    east.set(-Math.sin(lambda), 0, -Math.cos(lambda));           // along the line of latitude
    third.crossVectors(east, up);                                // along the line of longitude

    const top = 1 + (heights[c.index] / EARTH_RADIUS_M) * exaggeration;
    const bottom = 1 - BASE_DEPTH;
    const widthEast = THREE.MathUtils.degToRad(c.widthDeg) * Math.cos(THREE.MathUtils.degToRad(c.lat));

    m.makeBasis(east, up, third);                                // turn the box to face outward
    m.scale(new THREE.Vector3(widthEast * GAP, top - bottom, cellRad * GAP));
    m.setPosition(up.multiplyScalar((top + bottom) / 2));
    mesh.setMatrixAt(i, m);

    const p = c.index * 4;
    colour.setRGB(pixels[p] / 255, pixels[p + 1] / 255, pixels[p + 2] / 255, THREE.SRGBColorSpace);
    mesh.setColorAt(i, colour);
  });
  scene.add(mesh);

  // A dark ball just under the blocks: what you see through the gaps
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(1 - BASE_DEPTH * 0.6, 64, 32),
    new THREE.MeshBasicMaterial({ color: 0x05070a })
  );
  scene.add(core);

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

  // --- Draw every frame; other files can add their own per-frame work ---
  const frameCallbacks = [];
  renderer.setAnimationLoop((time) => {
    controls.update();
    frameCallbacks.forEach((fn) => fn(time));
    renderer.render(scene, camera);
  });

  return {
    scene, camera, controls, renderer, meta,
    blockCount: cells.length,
    onFrame: (fn) => frameCallbacks.push(fn),
  };
}
