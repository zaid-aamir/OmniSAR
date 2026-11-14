// Fixed data colour scales. They never change with the palette, so a colour always means the
// same thing everywhere in the app (terrain blocks, legends, charts):
//   sequential = "how much" (dark blue -> teal -> pale yellow)
//   diverging  = "down / up" or "darker / brighter" (blue <- white -> red)
// The same end colours are used by the Python scripts for the PNG images.

const SEQ = [[13, 8, 135], [33, 102, 172], [32, 164, 160], [122, 209, 81], [253, 231, 37]];
const DOWN = [67, 147, 195];
const MID = [247, 247, 247];
const UP = [214, 96, 77];

function mix(a, b, t) {
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t));
}

export function colourFor(kind, value, [lo, hi]) {
  if (kind === 'diverging') {
    const t = Math.max(-1, Math.min(1, value / Math.max(Math.abs(lo), Math.abs(hi))));
    return t >= 0 ? mix(MID, UP, t) : mix(MID, DOWN, -t);
  }
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo))) * (SEQ.length - 1);
  const i = Math.min(SEQ.length - 2, Math.floor(t));
  return mix(SEQ[i], SEQ[i + 1], t - i);
}

// CSS gradient for a legend bar
export function legendGradient(kind) {
  const stops = kind === 'diverging' ? [DOWN, MID, UP] : SEQ;
  return `linear-gradient(90deg, ${stops.map((c) => `rgb(${c.join(',')})`).join(', ')})`;
}
