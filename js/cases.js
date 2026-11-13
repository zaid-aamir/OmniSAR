// Loads the case catalogue (cases/index.json) and the real NISAR pass dates
// (cases/passes.json, made by tools/fetch_pass_dates.py) and joins them.
//
// Honesty rule built in here: a case's status is "Under investigation" unless its
// numbers file really exists. Nothing in the app may claim a change date before that.

async function fileExists(path) {
  try {
    const res = await fetch(path, { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function loadCases() {
  const [index, passes] = await Promise.all([
    fetch('cases/index.json').then((r) => r.json()),
    fetch('cases/passes.json').then((r) => r.json()),
  ]);

  const cases = await Promise.all(index.cases.map(async (c) => {
    const p = passes.cases[c.id] || { passes: [], product: '?' };
    const dates = [...new Set(p.passes.map((x) => x.date))].sort();   // one tick per day, even if 2 frames
    const tracks = [...new Set(p.passes.map((x) => `${x.track}${x.direction === 'A' ? ' asc' : ' desc'}`))];
    const measured = await fileExists(c.numbersFile);
    return {
      ...c,
      product: p.product,
      passes: p.passes,
      passDates: dates,
      tracks,
      status: measured ? 'measured' : 'under-investigation',
    };
  }));

  return { cases, window: passes.window, generated: passes.generated, source: passes.source };
}

export const STATUS_TEXT = {
  'under-investigation': 'Under investigation',
  measured: 'Measured',
};
