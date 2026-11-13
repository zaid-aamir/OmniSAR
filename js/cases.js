// Loads the case catalogue (cases/index.json), the real NISAR pass dates
// (cases/passes.json, made by tools/fetch_pass_dates.py) and the list of finished
// measurements (cases/results.json, made by tools/update_results.py), and joins them.
//
// Honesty rule built in here: a case's status is "Under investigation" unless
// results.json lists its numbers file. That list is written by a script that looks at
// which numbers files really exist, so nobody types a status by hand.

export async function loadCases() {
  const [index, passes, results] = await Promise.all([
    fetch('cases/index.json').then((r) => r.json()),
    fetch('cases/passes.json').then((r) => r.json()),
    fetch('cases/results.json').then((r) => r.json()),
  ]);

  const cases = index.cases.map((c) => {
    const p = passes.cases[c.id] || { passes: [], product: '?' };
    const dates = [...new Set(p.passes.map((x) => x.date))].sort();   // one tick per day, even if 2 frames
    const tracks = [...new Set(p.passes.map((x) => `${x.track}${x.direction === 'A' ? ' asc' : ' desc'}`))];
    const numbersPath = results.measured[c.id] || null;
    return {
      ...c,
      product: p.product,
      passes: p.passes,
      passDates: dates,
      tracks,
      numbersPath,                                   // null until the measurements exist
      status: numbersPath ? 'measured' : 'under-investigation',
    };
  });

  return { cases, window: passes.window, generated: passes.generated, source: passes.source };
}

export const STATUS_TEXT = {
  'under-investigation': 'Under investigation',
  measured: 'Measured',
};
