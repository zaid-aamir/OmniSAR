// Everything markers.js draws ON the 3D globe. Two modes (js/main.js picks one):
//
// CLASSIC mode (?mode=classic): one block-style column ("beacon") per case, at the case centre.
//   Hover shows the name; click (without dragging) selects the case. A beacon "pulses" (a flat
//   see-through square grows and fades at its foot) when main.js asks, e.g. when its case is picked.
//   Colour = the fixed "pending" data colour while a case is under investigation, cyan once measured.
//   A beacon never claims a change date; it only marks where a question is being asked.
//   "Unverified tips" (NASA EONET natural events) are thin grey columns. v7: the timeline slider is
//   gone, so all tips show at once. They are tips, not findings: nothing about them is checked.
//
// LIVE OPS mode (default): no beacons and no tips. The game calls setEvents() to raise red ALERT
//   RODS out of the globe where a real NISAR pass is about to be checked; flare(id) makes one rod
//   flash bright once (~1 s, a single flash, never a strobe); setSolved(id) turns it cyan (the
//   "measured" data colour) for good. Rods are not clickable: the game flies to them itself.
//
// setVisible(false) hides everything this file draws (used before Play is pressed).

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
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;   // classic beacons only

// Live Ops alert rods
const ROD_WIDTH = 0.011;
const ROD_HEIGHT = 0.17;
const RISE_MS = 600;          // the rod grows out of the ground in ~0.6 s
const FLARE_MS = 1000;        // one bright flash, up and down once (1 cycle in 1 s = 1 Hz)
const ROD_PING_EVERY = 2000;  // an unsolved rod sends out one fading red ring every 2 s (0.5 Hz)
const ROD_PING_MS = 1600;

function cssColour(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
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

export function createMarkers(globe, cases, { onSelect, onTip, live = false } = {}) {
  const pending = new THREE.Color(cssColour('--data-pending', '#E0B44C'));
  const measured = new THREE.Color(cssColour('--data-nisar', '#22D3EE'));
  const alertRed = new THREE.Color(cssColour('--alert', '#FF3B47'));
  const group = new THREE.Group();
  globe.scene.add(group);
  let shown = true;

  const box = new THREE.BoxGeometry(1, 1, 1);
  const pingGeometry = new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2);   // flat, in the beacon's ground plane

  // --- Classic case beacons (none in Live Ops) ---
  const beacons = (live ? [] : cases).map((c) => {
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

  // --- Unverified tips (EONET), classic only, added later with setTips() ---
  const tipMaterial = new THREE.MeshLambertMaterial({ color: new THREE.Color(cssColour('--data-unverified', '#8a8f98')) });
  let tips = [];
  function setTips(list) {
    if (live) return;                        // Live Ops shows no tips
    for (const t of tips) group.remove(t.column);
    tips = (list || []).map((t) => {
      const column = new THREE.Mesh(box, tipMaterial);
      column.matrixAutoUpdate = false;
      column.matrix.copy(orientedMatrix(t.lat, t.lon, new THREE.Vector3(TIP_WIDTH, TIP_HEIGHT, TIP_WIDTH), 0.002 + TIP_HEIGHT / 2));
      group.add(column);
      return { ...t, kind: 'tip', column, top: latLonToVector(t.lat, t.lon, 1.002 + TIP_HEIGHT), normal: latLonToVector(t.lat, t.lon) };
    });
  }

  // --- Live Ops alert rods ---
  // Each rod: a red column (it rises from height 0), a dark foot plate, a slow red ping ring at its
  // foot, and a one-shot flare ring. Its own materials, so one rod can flare or turn cyan alone.
  const rods = new Map();
  function makeRod(ev) {
    const { lat, lon } = ev;
    const material = new THREE.MeshLambertMaterial({ color: alertRed.clone(), emissive: alertRed.clone(), emissiveIntensity: 0.45 });
    const column = new THREE.Mesh(box, material);
    column.matrixAutoUpdate = false;
    const foot = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: 0x05070a }));
    foot.matrixAutoUpdate = false;
    foot.matrix.copy(orientedMatrix(lat, lon, new THREE.Vector3(ROD_WIDTH * 2.4, 0.004, ROD_WIDTH * 2.4), 0.002));
    const ringBase = orientedMatrix(lat, lon, new THREE.Vector3(1, 1, 1), 0.006);
    const ringMaterial = () => new THREE.MeshBasicMaterial({
      color: alertRed.clone(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
    });
    const ping = new THREE.Mesh(pingGeometry, ringMaterial());
    ping.matrixAutoUpdate = false;
    ping.visible = false;
    const flareRing = new THREE.Mesh(pingGeometry, ringMaterial());
    flareRing.matrixAutoUpdate = false;
    flareRing.visible = false;
    group.add(column, foot, ping, flareRing);
    const rod = {
      id: String(ev.id), caseId: ev.caseId, lat, lon, column, foot, ping, flareRing, ringBase,
      born: performance.now(), flareStart: -1, solved: false, phase: Math.random() * ROD_PING_EVERY,
    };
    placeRod(rod, 0, 1);
    return rod;
  }
  // Size the column for a height fraction h (0..1) and a width factor w
  function placeRod(rod, h, w) {
    const height = Math.max(0.0005, ROD_HEIGHT * h);
    rod.column.matrix.copy(orientedMatrix(rod.lat, rod.lon,
      new THREE.Vector3(ROD_WIDTH * w, height, ROD_WIDTH * w), 0.002 + height / 2));
  }
  function removeRod(rod) {
    group.remove(rod.column, rod.foot, rod.ping, rod.flareRing);
    rod.column.material.dispose();
    rod.ping.material.dispose();
    rod.flareRing.material.dispose();
  }
  // Replace the rods with this list. A rod whose id is still in the list stays as it is
  // (no second rise, solved stays solved); new ids rise; ids no longer listed are removed.
  function setEvents(list) {
    const want = new Map((list || []).map((ev) => [String(ev.id), ev]));
    for (const [id, rod] of rods) if (!want.has(id)) { removeRod(rod); rods.delete(id); }
    for (const [id, ev] of want) if (!rods.has(id)) rods.set(id, makeRod(ev));
  }

  // --- Per-frame animation ---
  const ringScale = new THREE.Matrix4();
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  globe.onFrame(() => {
    if (!shown) return;
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

    // alert rods: rise, slow ping, one-shot flare (no reduced-motion branch: Live Ops has no calm version)
    for (const rod of rods.values()) {
      const rise = Math.min(1, (now - rod.born) / RISE_MS);
      let width = 1;
      let glow = rod.solved ? 0.35 : 0.45;
      if (rod.flareStart >= 0) {
        const f = (now - rod.flareStart) / FLARE_MS;
        if (f >= 1) {
          rod.flareStart = -1;
          rod.flareRing.visible = false;
        } else {
          const bump = Math.sin(Math.PI * f);     // 0 -> 1 -> 0 once: a single flash
          width = 1 + 0.9 * bump;
          glow += 2.2 * bump;
          const s = 0.012 + 0.09 * f;
          ringScale.makeScale(s, 1, s);
          rod.flareRing.matrix.multiplyMatrices(rod.ringBase, ringScale);
          rod.flareRing.material.opacity = 0.9 * (1 - f);
          rod.flareRing.visible = true;
        }
      }
      placeRod(rod, easeOut(rise), width);
      rod.column.material.emissiveIntensity = glow;

      const t = ((now + rod.phase) % ROD_PING_EVERY) / ROD_PING_MS;
      rod.ping.visible = !rod.solved && rise >= 1 && t < 1;
      if (rod.ping.visible) {
        const s = 0.012 + 0.04 * t;
        ringScale.makeScale(s, 1, s);
        rod.ping.matrix.multiplyMatrices(rod.ringBase, ringScale);
        rod.ping.material.opacity = 0.5 * Math.pow(1 - t, 1.6);
      }
    }
  });

  // --- Hover label + click (classic beacons and tips only) ---
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
    if (!shown) return null;
    const rect = globe.renderer.domElement.getBoundingClientRect();
    let best = null;
    let bestD = HIT_PX;
    // case beacons first, so a tip right next to a case never steals its click
    for (const b of [...beacons, ...tips]) {
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
    if (hit) (hit.b.kind === 'tip' ? onTip?.(hit.b) : onSelect?.(hit.b.id));
  });

  return {
    // Show or hide everything drawn here (beacons, tips, rods, the hover label)
    setVisible(show) {
      shown = !!show;
      group.visible = shown;
      if (!shown) { label.hidden = true; canvas.style.cursor = ''; }
    },
    setTips,
    setEvents,
    // One bright flash of that rod (~1 s). Calling it again restarts the flash.
    flare(id) {
      const rod = rods.get(String(id));
      if (rod) rod.flareStart = performance.now();
    },
    // That rod turns cyan (the fixed "measured" data colour) and stops pinging, for good
    setSolved(id) {
      const rod = rods.get(String(id));
      if (!rod) return;
      rod.solved = true;
      rod.column.material.color.copy(measured);
      rod.column.material.emissive.copy(measured);
      rod.flareRing.material.color.copy(measured);
      rod.ping.visible = false;
    },
    pulse(id) {
      const b = beacons.find((x) => x.id === id);
      if (b) b.pulseStart = performance.now();
    },
  };
}
