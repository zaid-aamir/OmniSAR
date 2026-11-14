// Red alert ripples on the globe (Live Ops). VISUAL ONLY: no data, no measurement, no forecast.
//
// When a new radar pass needs checking somewhere, Live Ops calls ripples.add(id, lat, lon).
// From that spot, red rings spread out over the globe's blocks, like ripples on a pond:
//   - one new ring every 1.2 s; each ring travels ~4,500 km along the Earth's surface and fades;
//   - a block that a ring passes turns a little red, then fades back to its own colour behind the ring;
//     the further from the source, the fainter: strength = exp(-distance / 2,500 km);
//   - blocks within ~300-400 km of the source keep a steady (not pulsing) red glow.
// ripples.remove(id) fades a source out over 0.6 s; ripples.clear() fades all of them out.
// Up to 3 sources at once: a 4th add() fades out the oldest one. add() with an id that is already
// there moves that source (the old spot fades out, the new spot starts fresh rings).
//
// HOW (why it is fast): the ~41,000 blocks are drawn by the GPU with one shader (js/globe.js).
// We add a few lines to that shader (globe.addShaderHook). Each frame the CPU only updates a handful
// of numbers ("uniforms": where each source is, when it started, how strong it is, what time it is).
// The GPU then works out, for every block at once: how far is this block from each source
// (great-circle distance, from the angle between the two directions from the Earth's centre),
// and is a ring passing it right now?
//
// SAFETY (flashing): each block is only ever lit by the rings of ONE source, the nearest one whose rings
// have reached it. So every block brightens and fades exactly once per 1.2 s = 0.83 times per second,
// never faster, even with 3 sources. Every change is a smooth curve, never a hard on/off.
//
// FALLBACK: if the shader can't be changed (old globe, or the GPU refuses the new shader), each source
// gets one still, soft red disc on the globe instead (no moving rings). Test it with ?ripplefallback
// (forces the disc) or ?ripplefallback=compile (feeds the GPU a broken shader to test the real failure path).

import * as THREE from 'three';
import { latLonToVector } from './globe.js';

// ---------- The numbers that shape the effect ----------
const EARTH_RADIUS_KM = 6371;
const MAX_SOURCES = 3;            // at most 3 alerts ripple at once
const SLOTS = 6;                  // shader slots: 3 active + room for up to 3 still fading out
const RING_PERIOD_S = 1.2;        // one new ring every 1.2 s  -> each block pulses at 1 / 1.2 = 0.83 Hz
const RING_SPEED_KM_S = 1300;     // how fast a ring travels over the surface (rings are 1,560 km apart)
const RING_FADE_FROM_KM = 3000;   // rings start to fade out here...
const RING_MAX_KM = 4500;         // ...and are gone here
const FALLOFF_KM = 2500;          // tint strength = exp(-distance / 2500 km)
const RING_RISE = 0.14;           // a block takes 14% of a period (~0.17 s) to brighten: a smooth curve, not a blink
const RING_TAIL = 3.5;            // then fades out over the rest of the period (bigger = shorter tail)
const RING_LEVEL = 0.5;           // how red a ring makes a block (0..1) right next to the source: 'slightly red'
const GLOW_FULL_KM = 250;         // steady glow at full strength inside this distance...
const GLOW_EDGE_KM = 420;         // ...fading to nothing here
const GLOW_LEVEL = 0.9;
const FADE_IN_MS = 350;
const FADE_OUT_MS = 600;
const ALERT_RED = new THREE.Color('#ff3b30');   // the same alert red family as the rods and the edge glow

// The ring's brightness over one period, as a share of the period (0 = the ring front arrives):
// rises smoothly, then fades. We divide by its highest value so the peak is exactly 1.
const pulseShape = (p) => {
  const x = Math.min(1, p / RING_RISE);
  return x * x * (3 - 2 * x) * Math.pow(1 - p, RING_TAIL);
};
let PULSE_PEAK = 0;
for (let i = 0; i <= 1000; i++) PULSE_PEAK = Math.max(PULSE_PEAK, pulseShape(i / 1000));

const f = (n) => n.toFixed(6);    // write a JS number into GLSL as a float literal

// ---------- The shader lines we add to the globe's block shader ----------
const VERTEX_DECL = /* glsl */`
  uniform vec4 uRipSrc[${SLOTS}];     // xyz = source direction (unit vector), w = strength 0..1
  uniform float uRipStart[${SLOTS}];  // when each source started (seconds)
  uniform float uRipTime;             // now (seconds)
  uniform float uRipOn;               // 0 = no sources at all: skip the work
  varying float vRipple;              // how red this block is right now (0..1), same for the whole block
`;
const VERTEX_BODY = /* glsl */`
  vRipple = 0.0;
  if (uRipOn > 0.5) {
    // The block's centre: the instance transform moves the box to its own place on the globe
    #ifdef USE_INSTANCING
      vec3 blockDir = normalize((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz);
    #else
      vec3 blockDir = normalize((modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz);
    #endif
    float glow = 0.0;
    float ownerKm = 1e9, ownerSince = 0.0, ownerStrength = 0.0;
    for (int i = 0; i < ${SLOTS}; i++) {
      float strength = uRipSrc[i].w;
      if (strength <= 0.0) continue;
      // great-circle distance: angle between the two directions x Earth radius
      // (2*asin(chord/2) is the same angle as acos(dot) but stays accurate for very small distances)
      float angle = 2.0 * asin(clamp(length(blockDir - uRipSrc[i].xyz) * 0.5, 0.0, 1.0));
      float km = angle * ${f(EARTH_RADIUS_KM)};
      glow = max(glow, strength * (1.0 - smoothstep(${f(GLOW_FULL_KM)}, ${f(GLOW_EDGE_KM)}, km)));
      // seconds since the FIRST ring of this source reached this block (negative = not reached yet)
      float since = uRipTime - uRipStart[i] - km / ${f(RING_SPEED_KM_S)};
      if (since >= 0.0 && km < ownerKm) { ownerKm = km; ownerSince = since; ownerStrength = strength; }
    }
    float ring = 0.0;
    if (ownerStrength > 0.0) {
      float p = fract(ownerSince / ${f(RING_PERIOD_S)});                 // where we are in this block's 1.2 s cycle
      float pulse = smoothstep(0.0, ${f(RING_RISE)}, p) * pow(1.0 - p, ${f(RING_TAIL)}) / ${f(PULSE_PEAK)};
      float reach = 1.0 - smoothstep(${f(RING_FADE_FROM_KM)}, ${f(RING_MAX_KM)}, ownerKm);
      ring = ownerStrength * pulse * exp(-ownerKm / ${f(FALLOFF_KM)}) * reach;
    }
    vRipple = clamp(max(glow * ${f(GLOW_LEVEL)}, ring * ${f(RING_LEVEL)}), 0.0, 1.0);
  }
`;
const FRAGMENT_DECL = /* glsl */`
  uniform vec3 uRipColour;
  varying float vRipple;
`;
// Before the lights are worked out: mix the block's own colour towards red, plus a little red light
// of its own (emissive) so the alert reads as a glow. With no sources vRipple is exactly 0 and
// nothing changes: the blocks keep their Blue Marble colours.
const FRAGMENT_BODY = /* glsl */`
  if (vRipple > 0.0) {
    diffuseColor.rgb = mix(diffuseColor.rgb, uRipColour, vRipple * 0.55);
    totalEmissiveRadiance += uRipColour * vRipple * 0.35;
  }
`;

// Adds the lines above to the shader. Returns false if a line we attach to is missing.
function patchShader(shader, uniforms, { broken = false } = {}) {
  const anchors = [
    [shader.vertexShader, '#include <common>'],
    [shader.vertexShader, '#include <begin_vertex>'],
    [shader.fragmentShader, '#include <common>'],
    [shader.fragmentShader, '#include <emissivemap_fragment>'],
  ];
  if (!anchors.every(([src, a]) => src.includes(a))) return false;
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}${broken ? '\n  this is not GLSL;' : ''}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAGMENT_BODY}`);
  return true;
}

// ---------- Fallback: one still, soft red disc per source ----------
// A thin curved cap that hugs the globe just above the tallest block, brightest in the middle.
// Additive blending = it adds red light on top; it never hides the blocks' colours.
const HALO_RADIUS = 1.037;                       // tallest block top ≈ 1.034 (globe radius = 1)
const HALO_ANGLE = 900 / EARTH_RADIUS_KM;        // the disc reaches ~900 km from the source
function createHalo(dir) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uColour: { value: ALERT_RED }, uStrength: { value: 0 } },
    vertexShader: /* glsl */`
      varying float vCentre;
      void main() {
        vCentre = uv.y;                          // 1 at the source, 0 at the disc's edge
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColour;
      uniform float uStrength;
      varying float vCentre;
      void main() {
        float a = pow(vCentre, 1.6) * 0.75 + smoothstep(0.7, 1.0, vCentre) * 0.35;   // soft edge, brighter core
        gl_FragColor = vec4(uColour * a * uStrength, 1.0);
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
  const geo = new THREE.SphereGeometry(HALO_RADIUS, 48, 12, 0, Math.PI * 2, 0, HALO_ANGLE);   // a cap around +Y
  const mesh = new THREE.Mesh(geo, material);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);                      // turn +Y to the source
  mesh.name = 'alert halo (visual only)';
  mesh.renderOrder = 2;
  return mesh;
}

// ---------- The ripple controller ----------
const instances = new WeakMap();   // one controller per globe (a second createRipples call returns the same one)

// createRipples(globe, { now }) -> { add(id, lat, lon), remove(id), clear(), mode, activeIds() }
//   globe: from createGlobe.  now: optional clock in milliseconds (tests use it to freeze time).
export function createRipples(globe, { now = () => performance.now(), fallback } = {}) {
  if (instances.has(globe)) return instances.get(globe);

  const param = new URLSearchParams(location.search).get('ripplefallback');   // null = not in the URL
  const forceFallback = fallback === true || (param !== null && param !== 'compile');
  const t0 = now();
  const seconds = () => (now() - t0) / 1000;

  // Uniforms shared by the land and ocean block shaders
  const uniforms = {
    uRipSrc: { value: Array.from({ length: SLOTS }, () => new THREE.Vector4(0, 1, 0, 0)) },
    uRipStart: { value: new Array(SLOTS).fill(0) },
    uRipTime: { value: 0 },
    uRipOn: { value: 0 },
    uRipColour: { value: ALERT_RED },
  };

  let mode = 'fallback';
  if (!forceFallback && typeof globe.addShaderHook === 'function') {
    const broken = param === 'compile';
    const ok = globe.addShaderHook(broken ? 'ripples-broken-test' : 'ripples',
      (shader) => patchShader(shader, uniforms, { broken }));
    if (ok) mode = 'shader';
    else console.warn('ripples: block shader could not be patched, using the still red halo instead');
  }

  // Each slot = one source (or one still fading out). strength eases from 'from' to 'to'.
  const slots = Array.from({ length: SLOTS }, () => ({
    id: null, dir: null, start: 0, from: 0, to: 0, changed: 0, ms: 1, strength: 0, halo: null,
  }));
  const active = new Map();   // id -> slot, in the order they were added (oldest first)

  const ease = (x) => x * x * (3 - 2 * x);
  function fadeTo(slot, to, ms) {
    const t = now();
    slot.from = slot.strength;
    slot.to = to;
    slot.changed = t;
    slot.ms = ms;
  }
  function freeSlot() {
    let best = slots.find((s) => s.id === null && s.strength === 0 && s.to === 0);
    if (!best) {   // all busy (very fast adds): take over the faintest one that is fading out
      best = slots.filter((s) => s.id === null).sort((a, b) => a.strength - b.strength)[0] || slots[0];
      releaseHalo(best);
    }
    return best;
  }
  function releaseHalo(slot) {
    if (!slot.halo) return;
    globe.scene.remove(slot.halo);
    slot.halo.geometry.dispose();
    slot.halo.material.dispose();
    slot.halo = null;
  }

  function add(id, lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.warn(`ripples.add('${id}'): lat/lon must be numbers`);
      return;
    }
    if (active.has(id)) remove(id);                                // moving: old spot fades out
    else if (active.size >= MAX_SOURCES) remove(active.keys().next().value);   // 4th: the oldest fades out
    const slot = freeSlot();
    slot.id = id;
    slot.dir = latLonToVector(lat, lon).normalize();
    slot.start = seconds();
    slot.strength = 0;
    fadeTo(slot, 1, FADE_IN_MS);
    if (mode === 'fallback') {
      slot.halo = createHalo(slot.dir);
      globe.scene.add(slot.halo);
    }
    active.set(id, slot);
  }

  function remove(id) {
    const slot = active.get(id);
    if (!slot) return;
    active.delete(id);
    slot.id = null;                // the slot keeps fading; it is free again once it reaches 0
    fadeTo(slot, 0, FADE_OUT_MS);
  }

  function clear() {
    [...active.keys()].forEach(remove);
  }

  // Every frame: ease each slot's strength and copy the few numbers the GPU needs. No per-block work here.
  globe.onFrame(() => {
    const t = now();
    let any = false;
    slots.forEach((slot, i) => {
      const k = Math.min(1, Math.max(0, (t - slot.changed) / slot.ms));
      slot.strength = slot.from + (slot.to - slot.from) * ease(k);
      if (k === 1 && slot.to === 0) {
        slot.strength = 0;
        if (slot.id === null) releaseHalo(slot);
      }
      if (slot.strength > 0) any = true;
      if (mode === 'shader') {
        const v = uniforms.uRipSrc.value[i];
        if (slot.dir) v.set(slot.dir.x, slot.dir.y, slot.dir.z, slot.strength);
        else v.w = 0;
        uniforms.uRipStart.value[i] = slot.start;
      } else if (slot.halo) {
        slot.halo.material.uniforms.uStrength.value = slot.strength;
      }
    });
    uniforms.uRipTime.value = seconds();
    uniforms.uRipOn.value = any ? 1 : 0;
  });

  const api = {
    add, remove, clear,
    get mode() { return mode; },              // 'shader' (moving rings) or 'fallback' (still halos)
    activeIds: () => [...active.keys()],      // ids still rippling, oldest first (handy for tests)
  };
  instances.set(globe, api);
  return api;
}
