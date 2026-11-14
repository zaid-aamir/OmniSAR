// "From gigabytes to your browser": shown in every case's verdict.
//   1. Real sizes: the NASA files behind the verdict (bytes measured on our laptop by
//      tools/build_sizes.py) next to the bytes this case really loaded in YOUR browser, counted by
//      the browser itself (Performance API: resource entries for this case's files).
//   2. The pipeline, built from the case's chain of custody (numbers file -> provenance.steps),
//      each step with a one-line plain-English "why". The steps are the real ones; only the
//      "why" lines are written by us.
//   3. "Get the raw data": links to each NASA file's record (ASF / NASA CMR). A free Earthdata
//      login is needed only to download raw files, never to use OmniSAR.

import { esc, reducedMotion } from './util.js';

// one-line "why" for a processing step, matched by keywords in the step's own wording
const WHY = [
  [/read only the box/i, 'A NISAR file covers a whole frame; we only need the case box, so we read just those rows and columns.'],
  [/mask invalid|mask:/i, 'Edges and failed pixels carry no signal, so they are blanked instead of counted.'],
  [/multilook|speckle/i, 'Radar images are grainy (speckle); averaging small blocks trades a little sharpness for honest values.'],
  [/^dB$|calibrat|\bdB\b/i, 'Radar power spans huge ranges; decibels make it readable and make change a simple subtraction.'],
  [/interference/i, 'One bad date (radio interference) can fake a whole patch of change, so every pass is checked against the rest of the frame.'],
  [/leave out|exclud/i, 'A pass our own check flagged is left out of the rule, and still shown, so it can’t fake change.'],
  [/median/i, 'A median of several passes outvotes one odd date.'],
  [/background/i, 'Removing each date’s smooth regional brightness stops a broad offset from looking like change.'],
  [/classif|rule|open water|flooded|burn|class/i, 'The rule was written down before any result, so the answer can’t be tuned to look good.'],
  [/cluster|hotspot|top 10|patch/i, 'Single pixels are noise; only patches big enough to matter are kept.'],
  [/photo|hls|dswx|check|agreement|modis|perimeter/i, 'A second, independent source checks the radar, which is where the evidence badge comes from.'],
  [/troposphere|ionosphere|corrections/i, 'Air and the ionosphere delay the radar signal; subtracting NASA’s stored correction screens removes fake motion.'],
  [/coherence/i, 'Where the signal changed between passes, the phase is noise, so those pixels are masked.'],
  [/reference/i, 'Motion is measured relative to a stable spot, so a whole-frame offset cancels out.'],
  [/phase|mm|millimetre/i, 'Phase becomes millimetres with the radar wavelength stored in the file.'],
  [/chain|pairs date by date/i, 'Adding pair after pair builds a time series instead of one snapshot.'],
  [/district|two-direction/i, 'Two directions see the ground at different times through different air; if both agree, the motion is real.'],
  [/rain|power/i, 'Rain data adds context; it is regional, so it never decides a pixel.'],
  [/badge/i, 'The badge rule was fixed in advance: it says how much the evidence can bear.'],
  [/slope|terrarium|height/i, 'Steep slopes distort radar; ground heights tell us where.'],
];
const whyFor = (step) => (WHY.find(([re]) => re.test(step)) || [null, ''])[1];

const human = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);

let sizes = null;
const loadSizes = () => (sizes ??= fetch('cases/nasa_file_sizes.json').then((r) => (r.ok ? r.json() : null)).catch(() => null));

// Bytes this case's files have loaded so far in this browser (the browser's own count)
function browserBytes(caseId) {
  const mine = performance.getEntriesByType('resource')
    .filter((e) => e.name.includes(`/assets/cases/${caseId}/`) || e.name.includes(`/cases/${caseId}.`));
  return { bytes: mine.reduce((s, e) => s + (e.encodedBodySize || e.transferSize || 0), 0), files: mine.length };
}

function rawLinks(file) {
  const g = file.replace(/\.h5$/, '');
  const cmr = `https://cmr.earthdata.nasa.gov/search/granules.json?readable_granule_name=${encodeURIComponent(g)}`;
  const asf = `https://search.asf.alaska.edu/#/?searchType=List%20Search&searchList=${encodeURIComponent(g)}`;
  return `<a class="tag cite" href="${esc(asf)}" target="_blank" rel="noopener noreferrer">ASF search</a>
          <a class="tag cite" href="${esc(cmr)}" target="_blank" rel="noopener noreferrer">NASA CMR record</a>`;
}

export async function mountGigabytes(host, caseInfo, numbers) {
  if (!host || !numbers) return;
  const s = await loadSizes();
  const mine = s?.cases?.[caseInfo.id];
  const files = numbers.provenance?.nasa_files || [];
  const total = mine?.total_bytes || 0;
  const missing = mine ? mine.missing.length : files.length;
  const b = browserBytes(caseInfo.id);
  const steps = numbers.provenance?.steps || [];
  host.innerHTML = `
    <section class="gb" aria-labelledby="gb-title">
      <h3 class="wt-sub" id="gb-title">From gigabytes to your browser</h3>
      <p class="gb-line">
        <span class="gb-big">${total ? esc(human(total)) : 'not measured'}</span> of NASA radar files
        <span class="gb-arrow" aria-hidden="true">→</span>
        <span class="gb-big gb-small">${esc(human(b.bytes))}</span> in your browser
      </p>
      <p class="evidence-caption">${files.length} NASA file${files.length === 1 ? '' : 's'} behind this verdict${missing ? ` (${missing} not on our laptop, so their size is not measured)` : ''};
        the browser count is this case's ${b.files} file${b.files === 1 ? '' : 's'} loaded so far, as your browser reports it.</p>
      <ol class="gb-pipe">
        ${steps.map((st, i) => `<li style="--i:${i}"><span class="gb-step">${esc(st)}</span>${whyFor(st) ? `<span class="gb-why">${esc(whyFor(st))}</span>` : ''}</li>`).join('')}
      </ol>
      <details class="gb-raw">
        <summary>Get the raw data (${files.length} NASA file${files.length === 1 ? '' : 's'})</summary>
        <p class="evidence-caption">Downloading a raw file needs a free NASA Earthdata login. OmniSAR itself never needs one.</p>
        <ul>${files.map((f) => `<li><code>${esc(f.file)}</code>${mine?.files?.[f.file] ? ` · ${esc(human(mine.files[f.file]))}` : ' · size not measured'}<br>${rawLinks(f.file)}</li>`).join('')}</ul>
      </details>
    </section>`;
  if (!reducedMotion()) host.querySelector('.gb-pipe')?.classList.add('is-drawing');
}
