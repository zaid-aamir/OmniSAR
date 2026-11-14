// Time on the case terrain (used by js/caseterrain.js).
//
//  - flashRule(): when the terrain switches from one pass to the next, the blocks whose value moved
//    by more than the case's OWN declared threshold get a brief cyan outline. The thresholds are read
//    from the METHOD block in cases/<id>.numbers.json at run time (never typed in here); this table
//    only says WHICH method value belongs to which kind of layer. A layer with no rule gets no flash.
//  - missingPassDates() / addPasses(): a NISAR pass that our scripts processed (it is in the case's
//    chain of custody, and its block values are in assets/cases/<id>/inspect.json) but that has no
//    layer in grid.json yet becomes a dated layer, so Play can show it. inspect.json is only trusted
//    if it reproduces every pass layer the grid already has EXACTLY (same blocks, same averaging);
//    otherwise nothing is added. Passes that were never processed are never invented.

const RULES = {
  'jebel-ali': { dB: { key: 'X_db', why: 'the case’s change threshold X' } },
  'big-sur': { dB: { key: 'burn_db', why: 'the case’s burn threshold' } },
  'al-ain': { dB: { key: 'crop_present_db', why: 'the case’s crop-present step' } },
  'jakarta': { mm: { key: 'agree_abs_mm', why: 'the case’s ±10 mm agreement tolerance' } },
  'tonle-sap': {
    dB: { lines: [['water_hh_db', 'open-water line'], ['flooded_hh_db', 'flooded-forest line']] },
    // display rule for the flash only (why_log.md, Sat 14 Nov 14:55): not used for any number
    '%': { step: 50 },
  },
};

const isDated = (l) => /^\d{4}-\d{2}-\d{2}$/.test(l?.date || '');
const minus = (n) => String(n).replace('-', '−');
const fmtDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// { test(a, b) -> bool for one block's old and new value, text for the legend line } or null
export function flashRule(caseId, layer, method) {
  const r = RULES[caseId]?.[layer?.unit];
  if (!r || !method) return null;
  if (r.key) {
    const raw = method[r.key];
    if (typeof raw !== 'number') return null;
    const t = Math.abs(raw);
    return {
      test: (a, b) => Math.abs(b - a) > t,
      text: `changed by more than ${t} ${layer.unit} since the pass before (${r.why}; raw pass values)`,
    };
  }
  if (r.lines) {
    const lines = r.lines.filter(([k]) => typeof method[k] === 'number').map(([k, name]) => [method[k], name]);
    if (!lines.length) return null;
    return {
      test: (a, b) => lines.some(([v]) => (a < v) !== (b < v)),
      text: `crossed the ${lines.map(([v, name]) => `${name} (${minus(v)} dB)`).join(' or the ')} since the pass before`,
    };
  }
  if (r.step) {
    return {
      test: (a, b) => Math.abs(b - a) >= r.step,
      text: `at least half the block switched between water and dry since the pass before`,
    };
  }
  return null;
}

// Dates in the chain of custody that have no dated layer in the grid
export function missingPassDates(grid, numbers) {
  const have = new Set(grid.layers.filter(isDated).map((l) => l.date));
  return [...new Set((numbers?.provenance?.nasa_files || []).map((f) => f.date))]
    .filter((d) => isDated({ date: d }) && !have.has(d));
}

// Add the missing processed passes from inspect.json to grid.layers. Returns the dates added.
export function addPasses(grid, numbers, insp, dates) {
  const passes = grid.layers.filter((l) => isDated(l) && l.unit === 'dB');
  if (!insp || !passes.length) return [];
  const ch = /\bHV\b/.test(passes[0].what) ? 'hv' : /\bHH\b/.test(passes[0].what) ? 'hh' : null;
  if (!ch || !passes.every((l) => /\bHV\b/.test(l.what) === (ch === 'hv'))) return [];
  // trust check: every pass the grid already has must match inspect.json block for block
  for (const l of passes) {
    const v = insp[ch]?.[l.date];
    if (!v || v.length !== l.values.length || v.some((x, i) => x !== l.values[i])) return [];
  }
  const added = [];
  for (const d of dates) {
    const values = insp[ch]?.[d];
    if (!values || values.length !== passes[0].values.length) continue;
    const t = passes[0];
    const leftOut = numbers?.quality_control?.excluded_passes?.[d] || null;
    const layer = {
      id: `pass-${d}`, date: d, kind: t.kind, unit: t.unit, scale: t.scale, what: t.what,
      label: `Pass ${fmtDate(d)}${leftOut ? ' (left out of the verdict)' : ''}`,
      source: t.source.replace(t.date, d),
      leftOut, values,
    };
    // after the last pass of the same kind that comes earlier (so the change layer stays last)
    const fam = grid.layers.map((l, i) => ({ l, i })).filter(({ l }) => passes.includes(l));
    const before = fam.filter(({ l }) => l.date < d).pop();
    const at = before ? before.i + 1 : fam[0].i;
    grid.layers.splice(at, 0, layer);
    passes.push(layer);
    added.push(d);
  }
  return added;
}
