// Three plain information views for the side panel: "Powered by NASA data", "How OmniSAR answers
// the challenge" and "About". All facts here match README.md and the processing scripts; every
// link opens only when clicked (the app itself loads nothing from outside its own files).

import { esc } from './util.js';

const link = (url, text) => `<a class="tag cite" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

const NASA = [
  ['NISAR L2 GCOV radar images (NASA-ISRO, via the ASF DAAC)', 'https://search.asf.alaska.edu/', 'Jebel Ali · Big Sur · Tonle Sap · Al Ain'],
  ['NISAR L2 GUNW interferograms, provisional (via the ASF DAAC)', 'https://search.asf.alaska.edu/', 'Jakarta'],
  ['NASA CMR file catalogue (real pass dates)', 'https://cmr.earthdata.nasa.gov/search/', 'all five cases (timeline ticks)'],
  ['NASA GIBS Blue Marble (globe colours)', 'https://nasa-gibs.github.io/gibs-api-docs/', 'the globe'],
  ['NASA HLS photos (Landsat + Sentinel-2, via GIBS)', 'https://www.earthdata.nasa.gov/data/projects/hls', 'Jebel Ali (photo check kit)'],
  ['NASA OPERA RTC-S1 (Sentinel-1 C-band pictures, via GIBS)', 'https://www.earthdata.nasa.gov/data/projects/opera', 'Jebel Ali · Big Sur (L- vs C-band switch)'],
  ['NASA OPERA DSWx-S1 water maps (via GIBS)', 'https://www.earthdata.nasa.gov/data/projects/opera', 'Tonle Sap (independent check)'],
  ['NASA POWER daily rain (MERRA-2 based)', 'https://power.larc.nasa.gov/', 'Big Sur · Tonle Sap'],
  ['NASA EONET natural events', 'https://eonet.gsfc.nasa.gov/', 'grey live-event markers on the globe'],
  ['MODIS MOD13Q1 NDVI (NASA ORNL DAAC web service)', 'https://modis.ornl.gov/data/modis_webservice.html', 'Al Ain (26-year history)'],
  ['NASA AppEEARS (HLS NDVI order)', 'https://appeears.earthdatacloud.nasa.gov/', 'Al Ain: ordered, files not arrived yet, so its check stays "Unchecked"'],
];
const OTHER = [
  ['AWS Terrain Tiles (Terrarium elevation)', 'https://registry.opendata.aws/terrain-tiles/', 'globe and every case terrain (heights)'],
  ['OpenStreetMap (Highway 1 line, Overpass API), © OpenStreetMap contributors, ODbL', 'https://www.openstreetmap.org/copyright', 'Big Sur'],
  ['NIFC WFIGS interagency fire perimeters', 'https://data-nifc.opendata.arcgis.com/', 'Big Sur (independent check)'],
];

function list(rows) {
  return `<ul class="about-list">${rows.map(([name, url, used]) => `<li><strong>${esc(name)}</strong><br>
    <span class="evidence-caption">Used for: ${esc(used)}</span> ${link(url, 'Open')}</li>`).join('')}</ul>`;
}

const VIEWS = {
  nasa: () => `
    <p class="eyebrow">Powered by NASA data</p>
    <h1 class="panel-title" tabindex="-1">Every dataset behind OmniSAR</h1>
    <p class="panel-text">NASA and NASA-partner data, and the cases that use each one. Saved snapshots ship with the app, so it works even if a NASA service is down.</p>
    ${list(NASA)}
    <h2 class="lab-group">Not from NASA</h2>
    ${list(OTHER)}
    <p class="evidence-caption">NASA OPERA DIST (disturbance alerts) is not used in this version.</p>`,
  challenge: () => `
    <p class="eyebrow">How OmniSAR answers the challenge</p>
    <h1 class="panel-title" tabindex="-1">Dancing with the SARs</h1>
    <p class="panel-text">The challenge: “build an interactive application that uses radar remote sensing data from NISAR to track and visualize one or more types of surface change at locations around the world.”</p>
    <dl class="facts about-facts">
      <div><dt>Polarisations</dt><dd>HH and HV drive the rules: HV loss = burned canopy (Big Sur), HV rise = active crops (Al Ain), HH darkness and double bounce = open water and flooded forest (Tonle Sap). Switch HH ↔ HV in the cases; the block inspector shows both for every pass.</dd></div>
      <div><dt>Frequencies</dt><dd>NISAR L-band next to Sentinel-1 C-band (switches in Jebel Ali, Big Sur, Tonle Sap); Tonle Sap's flooded forest is L-band only, and trap #13 explains why.</dd></div>
      <div><dt>Time series</dt><dd>The timeline shows every real 12-day NISAR pass; in a case it steps through the processed passes. Tonle Sap's flood pulse over three passes; Jakarta's chain of 8 interferogram pairs per direction.</dd></div>
      <div><dt>Extra data</dt><dd>Independent checks: NASA HLS photos, OPERA DSWx-S1, NIFC fire perimeters, MODIS NDVI history, NASA POWER rain. See “Powered by NASA data”.</dd></div>
      <div><dt>Storytelling</dt><dd>Five real mysteries in four countries (UAE, USA, Cambodia, Indonesia): sort real evidence from traps, predict hidden causes, and meet the 17 data traps (Trap Lab).</dd></div>
      <div><dt>Interactive summary</dt><dd>Each verdict: measured numbers, an evidence badge, what radar can't prove, the chain of custody and “from gigabytes to your browser”. The end screen sums up all five.</dd></div>
    </dl>`,
  about: () => `
    <p class="eyebrow">About OmniSAR</p>
    <h1 class="panel-title" tabindex="-1">Free, open, and honest about its limits</h1>
    <ul class="about-points">
      <li><strong>Free, no login, no install.</strong> It runs in any modern browser.</li>
      <li><strong>No server.</strong> It is a set of static files; nothing you do is sent anywhere.</li>
      <li><strong>Works even if NASA services are down.</strong> Pass dates, events, rain and pictures are saved snapshots made by our scripts.</li>
      <li><strong>Open source.</strong> ${link('https://github.com/zaid-aamir/OmniSAR', 'Code and processing scripts on GitHub')}</li>
      <li><strong>No AI inside the product.</strong> Every text and every reply is pre-written; every number comes from our processing scripts and NASA files.</li>
      <li><strong>How AI was used.</strong> AI coding assistants helped write the code. The design, the cases, the 17 traps and every check are the team's.</li>
    </ul>`,
};

export function showInfo(root, which, { onBack } = {}) {
  root.innerHTML = `<button class="link-btn" id="back-btn">← Back</button>${VIEWS[which]()}`;
  root.querySelector('#back-btn').addEventListener('click', () => onBack?.());
  root.closest('.panel')?.scrollTo({ top: 0 });
  root.querySelector('h1')?.focus({ preventScroll: true });
}
