// Visual-only extras for the globe: the blue atmosphere glow and the starfield.
// Neither of these is data. They are drawn dim and behind/around the blocks so the
// blocks (real data cells) and the case beacons always stay the brightest things on screen.

import * as THREE from 'three';

// ---------- Atmosphere ----------
// A slightly larger see-through ball around the globe. We draw only its inside (BackSide), so it
// shows as a ring of light AROUND the globe and never sits in front of the blocks or beacons.
// For each pixel the shader works out how close that line of sight passes to the Earth's centre:
// right at the globe's edge the glow is strongest, and it fades to nothing at the ball's outer edge.
// Additive blending (light is added on top, never paints over) and no depth writing.
export function createAtmosphere(radius) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uInner: { value: 1.0 },                                   // the globe's sea-level edge
      uOuter: { value: radius },                                // where the glow reaches zero
      uSky: { value: new THREE.Color('#4f9cff') },              // natural sky blue
      uRim: { value: new THREE.Color('#66FCF1') },              // palette cyan, only at the very rim
      uStrength: { value: 0.95 },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uInner, uOuter, uStrength;
      uniform vec3 uSky, uRim;
      varying vec3 vWorld;
      void main() {
        vec3 ray = normalize(vWorld - cameraPosition);
        // shortest distance between this line of sight and the Earth's centre
        float miss = length(cameraPosition + ray * -dot(cameraPosition, ray));
        float h = clamp((miss - uInner) / (uOuter - uInner), 0.0, 1.0);   // 0 = globe edge, 1 = outer edge
        float glow = pow(1.0 - h, 2.4);                                    // strongest at the edge
        vec3 colour = mix(uSky, uRim, pow(glow, 6.0) * 0.55);              // a touch of cyan right at the rim
        gl_FragColor = vec4(colour * glow * uStrength, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,          // drawn after the solid blocks and beacons, so depth testing hides it behind them
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 48), material);
  mesh.name = 'atmosphere (visual only)';
  return mesh;
}

// ---------- Stars ----------
// Procedural (random) stars, not a real catalogue. One THREE.Points object: each star is a small
// round dot whose soft edge is drawn by the shader from its distance to the dot's centre (no image file).
// Most stars are very dim; only a few are a little brighter, bigger or tinted blue/warm.
// A tiny share shimmer so slowly and faintly that it is barely visible.
export function createStars({ count, pixelRatio, shimmer }) {
  const RADIUS = 50;                         // far behind the globe (camera never goes past distance 5)
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const tw = new Float32Array(count * 2);    // shimmer amount, phase
  const tint = new THREE.Color();
  let seed = 20261114;                       // fixed seed: the same sky every load (no flicker between reloads)
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  for (let i = 0; i < count; i++) {
    // an even spread of directions over the whole sphere
    const z = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    pos.set([RADIUS * r * Math.cos(a), RADIUS * z, RADIUS * r * Math.sin(a)], i * 3);

    const b = 0.05 + 0.32 * Math.pow(rand(), 3.2);      // brightness: mostly faint
    const k = rand();
    if (k < 0.07) tint.setRGB(0.72, 0.84, 1.0);           // a few slightly blue
    else if (k < 0.12) tint.setRGB(1.0, 0.86, 0.68);      // a few slightly warm
    else tint.setRGB(1, 1, 1);
    col.set([tint.r * b, tint.g * b, tint.b * b], i * 3);

    size[i] = 1.3 + 1.9 * Math.pow(rand(), 5);           // px; a handful up to ~3 px
    tw.set([shimmer && rand() < 0.04 ? 0.25 : 0, rand() * Math.PI * 2], i * 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColour', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aTw', new THREE.BufferAttribute(tw, 2));

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio } },
    vertexShader: /* glsl */`
      uniform float uTime, uPixelRatio;
      attribute vec3 aColour;
      attribute float aSize;
      attribute vec2 aTw;
      varying vec3 vColour;
      void main() {
        // barely-visible shimmer: at most a 25% dip, over ~10 seconds, on ~4% of stars
        float dip = aTw.x * (0.5 + 0.5 * sin(uTime * 0.0006 + aTw.y));
        vColour = aColour * (1.0 - dip);
        gl_PointSize = aSize * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColour;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;           // 0 at the centre, 1 at the dot's edge
        float soft = 1.0 - smoothstep(0.2, 1.0, d);            // round with a soft edge
        if (soft <= 0.0) discard;
        gl_FragColor = vec4(vColour * soft, 1.0);
        #include <colorspace_fragment>
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,         // the globe (drawn first) hides the stars behind it
  });

  const points = new THREE.Points(geo, material);
  points.name = 'stars (visual only)';
  points.frustumCulled = false;
  points.renderOrder = -1;

  // The stars sit around the camera and turn with it most of the way, so when the globe turns
  // they drift only slowly (gentle parallax). We follow the camera's turn frame by frame
  // (not its absolute angle), so nothing ever jumps after a full spin.
  const group = new THREE.Group();
  group.add(points);
  const lastQ = new THREE.Quaternion();
  const step = new THREE.Quaternion();
  const identity = new THREE.Quaternion();
  let started = false;
  const FOLLOW = 0.9;          // stars move at 10% of the globe's apparent spin

  function update(camera, time) {
    if (started) {
      step.copy(camera.quaternion).multiply(lastQ.invert());   // this frame's turn of the camera
      step.slerpQuaternions(identity, step, FOLLOW);
      group.quaternion.premultiply(step);
    }
    lastQ.copy(camera.quaternion);
    started = true;
    group.position.copy(camera.position);
    material.uniforms.uTime.value = time;
  }
  function setPixelRatio(pr) { material.uniforms.uPixelRatio.value = pr; }

  return { object: group, update, setPixelRatio };
}

// Turn any CSS colour (including color-mix(...), used by some palettes) into a three.js colour,
// by letting the browser paint one pixel with it.
export function cssToColour(css, fallback = '#0B0C10') {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = fallback;
    ctx.fillStyle = css;          // ignored by the browser if it can't read it
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  } catch {
    return new THREE.Color(fallback);
  }
}
