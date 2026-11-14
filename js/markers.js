// Case beacons on the globe: one block-style column per case, standing at the case centre.
// Hover shows the name; click (without dragging) selects the case.
// A beacon "pulses" (a flat see-through square grows and fades at its foot) when the timeline
// crosses one of that case's real NISAR pass dates.
//
// Colour = the fixed "pending" data colour while a case is under investigation.
// A beacon never claims a change date; it only marks where a question is being asked.
//
// "Unverified tips" (NASA EONET natural events) are thin grey columns. Each one appears only once
// the timeline reaches its date. They are tips, not findings: nothing about them is checked.

import * as THREE from 'three';
import { latLonToVector } from './globe.js';

const COLUMN_WIDTH = 0.009;   // globe radius = 1, so ~0.5° wide (Jebel Ali and Al Ain are only ~0.7° apart)
const COLUMN_HEIGHT = 0.12;
const PULSE_MS = 1400;
const HIT_PX = 22;            // how close (in screen pixels) the pointer must be to hover a beacon
const TIP_WIDTH = 0.005;
const TIP_HEIGHT = 0.06;
const PING_MS = 2400;         // soft radar ping: one ring every PING_EVERY ms, growing and fading
const PING_EVERY = 4200;
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function cssColour(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Box turned so its "up" points straight out of the globe at (lat, lon)
function orientedMatrix(lat, lon, size, lift) {
  const up = latLonToVector(lat, lon);
  const lambda = THREE.MathUtils.degToRad(lon);
  const east = new THREE.Vector3(-Math.sin(lambda), 0, -Math.cos(lambda));
  const third = new THREE.Vector3().crossVectors(east, up);
  const m = new THREE.Matrix4().makeBasis(east, up, third);
  m.scale(size);
  m.setPosition(up.clone().multiplyScalar(1 + lift));
  return m;
}

export function createMarkers(globe, cases, { onSelect, onTip }) {
  const pending = new THREE.Color(cssColour('--data-pending'));
  const measured = new THREE.Color(cssColour('--data-nisar'));
  const group = new THREE.Group();
  globe.scene.add(group);

  const box = new THREE.BoxGeometry(1, 1, 1);
  const pingGeometry = new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2);   // flat, in the beacon's ground plane
  const beacons = cases.map((c) => {
    const [lat, lon] = c.centre;
    const colour = c.status === 'measured' ? measured : pending;

    // the column standing on the ground, on a dark foot plate so it reads as a block with an edge
    const column = new THREE.Mesh(box, new THREE.MeshLambertMaterial({ color: colour }));
    column.matrixAutoUpdate = false;
    column.matrix.copy(orientedMatrix(lat, lon,
      new THREE.Vector3(COLUMN_WIDTH, COLUMN_HEIGHT, COLUMN_WIDTH), 0.002 + COLUMN_HEIGHT / 2));
    const foot = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: 0x05070a }));
    foot.matrixAutoUpdate = false;
    foot.matrix.copy(orientedMatrix(lat, lon,
      new THREE.Vector3(COLUMN_WIDTH * 2.2, 0.004, COLUMN_WIDTH * 2.2), 0.002));

    // the pulse: a flat see-through square at the foot of the column, hidden until needed
    const ring = new THREE.Mesh(box, new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0, depthWrite: false,
    }));
    ring.matrixAutoUpdate = false;
    ring.visible = false;
    const ringBase = orientedMatrix(lat, lon, new THREE.Vector3(1, 1, 1), 0.006);

    // the idle radar ping: a thin, faint ring that grows from the beacon's foot and fades (decoration only)
    const ping = new THREE.Mesh(pingGeometry, new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    }));
    ping.matrixAutoUpdate = false;
    ping.visible = false;

    group.add(column, foot, ring, ping);
    return {
      id: c.id, name: c.name, column, ring, ringBase, pulseStart: -1, ping,
      top: latLonToVector(lat, lon, 1.002 + COLUMN_HEIGHT),
      normal: latLonToVector(lat, lon),
    };
  });

  // --- Unverified tips (EONET), added later with setTips() ---
  const tipMaterial = new THREE.MeshLambertMaterial({ color: new THREE.Color(cssColour('--data-unverified') || '#8a8f98') });
  let tips = [];
  function setTips(list) {
    tips = list.map((t) => {
      const column = new THREE.Mesh(box, tipMaterial);
      column.matrixAutoUpdate = false;
      column.matrix.copy(orientedMatrix(t.lat, t.lon, new THREE.Vector3(TIP_WIDTH, TIP_HEIGHT, TIP_WIDTH), 0.002 + TIP_HEIGHT / 2));
      column.visible = false;
      group.add(column);
      return { ...t, kind: 'tip', column, top: latLonToVector(t.lat, t.lon, 1.002 + TIP_HEIGHT), normal: latLonToVector(t.lat, t.lon) };
    });
  }
  // Show only the tips whose date the timeline has reached
  function setDate(iso) {
    for (const t of tips) t.column.visible = t.date <= iso;
  }

  // --- Pulses ---
  const ringScale = new THREE.Matrix4();
  globe.onFrame(() => {
    const now = performance.now();
    const still = reduceMotion();
    beacons.forEach((b, k) => {
      const t = ((now + k * 830) % PING_EVERY) / PING_MS;   // staggered, so the beacons don't ping together
      b.ping.visible = !still && t < 1;
      if (!b.ping.visible) return;
      const s = 0.01 + 0.032 * t;
      ringScale.makeScale(s, 1, s);
      b.ping.matrix.multiplyMatrices(b.ringBase, ringScale);
      b.ping.material.opacity = 0.42 * Math.pow(1 - t, 1.6);
    });
    for (const b of beacons) {
      if (b.pulseStart < 0) continue;
      const t = (now - b.pulseStart) / PULSE_MS;
      if (t >= 1) {
        b.pulseStart = -1;
        b.ring.visible = false;
        continue;
      }
      const s = 0.012 + 0.07 * t;                 // grows from ~0.7° to ~4.7° wide
      ringScale.makeScale(s, 0.003, s);
      b.ring.matrix.multiplyMatrices(b.ringBase, ringScale);
      b.ring.material.opacity = 0.55 * (1 - t);
      b.ring.visible = true;
    }
  });

  // --- Hover label + click ---
  const area = globe.renderer.domElement.parentElement;
  const label = document.createElement('div');
  label.className = 'beacon-label';
  label.hidden = true;
  area.appendChild(label);

  const screen = new THREE.Vector3();
  const toCamera = new THREE.Vector3();

  // Which beacon is under the pointer? Projects each beacon's top to the screen and picks
  // the nearest one within HIT_PX. Beacons on the far side of the globe are skipped.
  function beaconAt(clientX, clientY) {
    const rect = globe.renderer.domElement.getBoundingClientRect();
    let best = null;
    let bestD = HIT_PX;
    // case beacons first, so a tip right next to a case never steals its click
    for (const b of [...beacons, ...tips.filter((t) => t.column.visible)]) {
      if (best && b.kind === 'tip') break;
      toCamera.copy(globe.camera.position).sub(b.top);
      if (toCamera.dot(b.normal) <= 0) continue;            // behind the globe
      screen.copy(b.top).project(globe.camera);
      const x = rect.left + ((screen.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - screen.y) / 2) * rect.height;
      const d = Math.hypot(x - clientX, y - clientY);
      if (d < bestD) { bestD = d; best = { b, x: x - rect.left, y: y - rect.top }; }
    }
    return best;
  }

  const canvas = globe.renderer.domElement;
  canvas.addEventListener('pointermove', (e) => {
    const hit = beaconAt(e.clientX, e.clientY);
    canvas.style.cursor = hit ? 'pointer' : '';
    label.hidden = !hit;
    if (hit) {
      label.textContent = hit.b.kind === 'tip' ? `Unverified tip: ${hit.b.title}` : hit.b.name;
      label.style.left = `${hit.x}px`;
      label.style.top = `${hit.y}px`;
    }
  });
  canvas.addEventListener('pointerleave', () => { label.hidden = true; });

  // A click is a press and release that barely moved (otherwise it was a drag)
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const hit = beaconAt(e.clientX, e.clientY);
    if (hit) (hit.b.kind === 'tip' ? onTip?.(hit.b) : onSelect(hit.b.id));
  });

  return {
    setTips,
    setDate,
    pulse(id) {
      const b = beacons.find((x) => x.id === id);
      if (b) b.pulseStart = performance.now();
    },
  };
}
