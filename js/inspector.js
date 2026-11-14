// "What did the radar hit?" — click a block of a case terrain (or press Enter / I for the block in
// the middle of the view) to see its real values for every pass, a small time series, and the
// LIKELY bounce type from a simple HH/HV rule (declared in why_log.md, Sat 14 Nov 13:00, before
// any value was computed). Always labelled "likely, not proof".
//
// Values: assets/cases/<case>/inspect.json (HH and HV per pass, same blocks as the terrain, made
// by tools/build_inspector.py). Jakarta is InSAR (no HH/HV): it shows its measured millimetres only.

import { esc, announce } from './util.js';
import { trapChip, wireTrapChips } from './trapcard.js';

// The declared rule (thresholds reused from the Tonle Sap METHOD; see why_log.md 13:00)
export const BOUNCE_RULE = {
  smooth: { hhMax: -16, hvMax: -22 },
  double: { hhMin: -5, gapMin: 10 },
  volume: { hvMin: -16, gapMax: 10 },
};
export function bounceType(hh, hv) {
  if (hh == null || hv == null) return null;
  const r = BOUNCE_RULE;
  if (hh <= r.smooth.hhMax && hv <= r.smooth.hvMax) return 'smooth';
  if (hh >= r.double.hhMin && hh - hv >= r.double.gapMin) return 'double';
  if (hv >= r.volume.hvMin && hh - hv < r.volume.gapMax) return 'volume';
  return 'none';
}
const BOUNCE_TEXT = {
  smooth: 'Smooth surface (calm water or smooth sand): the beam glances off like a mirror, little comes back.',
  double: 'Double bounce (buildings, or water around trunks): ground then wall sends the beam straight back.',
  volume: 'Volume (leaves, crops): the beam scatters around inside the canopy.',
  none: 'No clear type by this simple rule.',
};
const BOUNCE_NAME = { smooth: 'Smooth surface', double: 'Double bounce', volume: 'Volume', none: 'No clear type' };

const fmt = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const v10 = (v) => (v == null ? null : v / 10);

// three tiny scenes: mirror-like glance, scatter inside a canopy, ground-then-wall corner
function diagram(type) {
  const on = (t) => (t === type ? 'is-on' : '');
  return `
    <svg class="bounce-svg" viewBox="0 0 300 92" role="img" aria-label="Three bounce paths; highlighted: ${esc(BOUNCE_NAME[type] || 'none')}">
      <g class="bp ${on('smooth')}"><line x1="8" y1="78" x2="92" y2="78" class="ground"/>
        <path class="ray" d="M14 14 L50 76 L86 14"/><text x="50" y="90">smooth</text></g>
      <g class="bp ${on('volume')}"><line x1="108" y1="78" x2="192" y2="78" class="ground"/>
        <path class="tree" d="M150 78 V54 M136 54 Q150 22 164 54 Z"/>
        <path class="ray" d="M114 14 L146 42 L156 34 L142 46 L118 18"/><text x="150" y="90">volume</text></g>
      <g class="bp ${on('double')}"><line x1="208" y1="78" x2="292" y2="78" class="ground"/>
        <path class="wall" d="M262 78 V36"/>
        <path class="ray" d="M214 18 L246 76 L262 58 L222 22"/><text x="250" y="90">double bounce</text></g>
    </svg>`;
}

function sparkline(series, unit) {
  const pts = series.flatMap((s) => s.points.filter((p) => p.v != null));
  if (pts.length < 2) return '';
  const W = 260, H = 70, L = 30, R = 6, T = 6, B = 16;
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.d)))].sort();
  const lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  const span = hi - lo || 1;
  const px = (d) => L + (xs.length === 1 ? 0.5 : xs.indexOf(d) / (xs.length - 1)) * (W - L - R);
  const py = (v) => T + (1 - (v - lo) / span) * (H - T - B);
  const col = ['var(--data-nisar)', '#E0B44C'];
  return `
    <svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Values across passes (${esc(unit)})">
      <text x="${L - 4}" y="${py(hi) + 4}" text-anchor="end">${hi.toFixed(1)}</text>
      <text x="${L - 4}" y="${py(lo)}" text-anchor="end">${lo.toFixed(1)}</text>
      <text x="${L}" y="${H - 3}">${esc(fmt(xs[0]))}</text><text x="${W - R}" y="${H - 3}" text-anchor="end">${esc(fmt(xs[xs.length - 1]))}</text>
      ${series.map((s, k) => {
        const p = s.points.filter((q) => q.v != null);
        return `<polyline fill="none" stroke="${col[k]}" stroke-width="2" points="${p.map((q) => `${px(q.d)},${py(q.v)}`).join(' ')}"/>
          ${p.map((q) => `<circle cx="${px(q.d)}" cy="${py(q.v)}" r="3" fill="${col[k]}"><title>${esc(s.name)} ${esc(fmt(q.d))}: ${q.v.toFixed(1)} ${esc(unit)}</title></circle>`).join('')}`;
      }).join('')}
    </svg>
    <p class="spark-key">${series.map((s, k) => `<span style="color:${col[k]}">● ${esc(s.name)}</span>`).join(' ')} <span>(${esc(unit)})</span></p>`;
}

export function createInspector(view) {
  const box = document.createElement('section');
  box.className = 'terrain-hud inspector';
  box.hidden = true;
  box.setAttribute('aria-labelledby', 'insp-title');
  view.appendChild(box);
  let data = null, dataFor = null, info = null, numbers = null, grid = null;

  async function load() {
    if (dataFor === info.id) return data;
    dataFor = info.id;
    // HH/HV exist only for radar-image (GCOV) cases; InSAR cases (Jakarta) use their own grid instead
    const gcov = /GCOV/.test(numbers?.provenance?.collection || '');
    data = gcov ? await fetch(`assets/cases/${info.id}/inspect.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
    return data;
  }

  function where(i) {
    const c = grid.corners_latlon;
    if (!c) return '';
    const r = Math.floor(i / grid.cols) / Math.max(grid.rows - 1, 1), q = (i % grid.cols) / Math.max(grid.cols - 1, 1);
    const lat = c.nw[0] + (c.sw[0] - c.nw[0]) * r + (c.ne[0] - c.nw[0]) * q;
    const lon = c.nw[1] + (c.ne[1] - c.nw[1]) * q + (c.sw[1] - c.nw[1]) * r;
    return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}`;
  }

  async function inspect(i) {
    const d = await load();
    const flagged = new Set(Object.keys(numbers?.quality_control?.excluded_passes || {}));
    let html;
    if (d) {
      const rows = d.passes.map((p) => ({ p, hh: v10(d.hh[p][i]), hv: v10(d.hv[p][i]) }));
      const latest = [...rows].reverse().find((r) => r.hh != null && r.hv != null && !flagged.has(r.p));
      const type = latest ? bounceType(latest.hh, latest.hv) : null;
      html = `
        <table class="insp-table">
          <thead><tr><th>Pass</th><th>HH</th><th>HV</th><th>Likely bounce</th></tr></thead>
          <tbody>${rows.map((r) => `<tr${flagged.has(r.p) ? ' class="is-flagged"' : ''}><td>${esc(fmt(r.p))}${flagged.has(r.p) ? ' <span class="pending-text">flagged</span>' : ''}</td>
            <td>${r.hh == null ? '—' : `${r.hh.toFixed(1)} dB`}</td><td>${r.hv == null ? '—' : `${r.hv.toFixed(1)} dB`}</td>
            <td>${esc(BOUNCE_NAME[bounceType(r.hh, r.hv)] || 'no data')}</td></tr>`).join('')}</tbody>
        </table>
        ${flagged.size ? '<p class="evidence-caption">“Flagged” = left out of the verdict by our interference check (still shown here).</p>' : ''}
        ${sparkline([{ name: 'HH', points: rows.map((r) => ({ d: r.p, v: r.hh })) }, { name: 'HV', points: rows.map((r) => ({ d: r.p, v: r.hv })) }], 'dB')}
        ${type ? `
          <p class="insp-type"><strong>${esc(BOUNCE_NAME[type])}</strong> on ${esc(fmt(latest.p))}: ${esc(BOUNCE_TEXT[type])}
            ${type === 'smooth' ? trapChip(11) : ''}</p>
          ${diagram(type)}
          <p class="insp-rule">Likely, by a simple HH/HV rule, not proof: smooth if HH ≤ −16 and HV ≤ −22 dB; double bounce if HH ≥ −5 dB and HH is ≥ 10 dB above HV; volume if HV ≥ −16 dB and HH is less than 10 dB above HV.</p>` : '<p class="evidence-caption">No pass with both HH and HV for this block.</p>'}`;
    } else {
      // InSAR case (or no inspector file): the terrain grid's own dated layers, measured values only
      const layers = grid.layers.filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.date || ''));
      const unit = layers[0]?.unit || '';
      const rows = layers.map((l) => ({ p: l.date, v: v10(l.values[i]), label: l.label }));
      html = `
        <table class="insp-table">
          <thead><tr><th>Pass</th><th>Measured</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${esc(fmt(r.p))}</td><td>${r.v == null ? 'masked' : `${r.v.toFixed(1)} ${esc(unit)}`}</td></tr>`).join('')}</tbody>
        </table>
        ${sparkline([{ name: layers[0]?.what?.split(',')[0] || 'value', points: rows.map((r) => ({ d: r.p, v: r.v })) }], unit)}
        <p class="evidence-caption">${info.id === 'jakarta' ? 'Ground motion from radar timing (InSAR), relative to central Jakarta. No HH/HV here, so no bounce type.' : 'No HH/HV file for this case yet.'}</p>`;
    }
    box.innerHTML = `
      <div class="insp-head"><h3 class="wt-sub" id="insp-title" tabindex="-1">What did the radar hit?</h3>
        <button class="ghost-btn insp-close" aria-label="Close the block inspector">✕</button></div>
      <p class="evidence-caption">Block at ${esc(where(i))} · ${esc(grid.block_text || '')}</p>
      ${html}`;
    box.dataset.block = String(i);            // which block is shown (used by our checks)
    box.hidden = false;
    box.querySelector('.insp-close').addEventListener('click', close);
    wireTrapChips(box);
    announce(`Block inspector: ${box.querySelector('.insp-type strong')?.textContent || 'values for every pass'}`);
  }

  function close() {
    const had = box.contains(document.activeElement);
    box.hidden = true;
    if (had) view.focus();
  }

  return {
    setCase(caseInfo, nums, g) { info = caseInfo; numbers = nums; grid = g; close(); },
    inspect,
    close,
  };
}
