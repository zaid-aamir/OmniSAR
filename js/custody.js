// Chain of custody: everything behind a verdict, in one panel. Every NASA file, its date and
// processing version, the layers read, each processing step, every threshold, the checks and
// their results, and the script version + fingerprint. "Download JSON" saves the same record
// so anyone can check or repeat our work. All of it comes from the case's numbers file.

import { esc } from './util.js';

let dialog = null;

function row(k, v) {
  return `<tr><th>${esc(k)}</th><td>${esc(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`;
}

export function openCustody(caseInfo, numbers) {
  if (!numbers) return;
  dialog ??= Object.assign(document.createElement('dialog'), { className: 'trap-dialog custody-dialog' });
  if (!dialog.isConnected) {
    document.body.appendChild(dialog);
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }
  const p = numbers.provenance || {};
  const m = numbers.method || {};
  const r = numbers.results || {};
  const extra = numbers.custody_extra || [];
  dialog.innerHTML = `
    <article class="trap-card custody">
      <p class="eyebrow">Chain of custody · ${esc(caseInfo.name)}</p>
      <h2 class="trap-title" id="custody-title" tabindex="-1">Everything behind this verdict</h2>
      <h3>NASA files used</h3>
      <ul class="custody-files">
        ${(p.nasa_files || []).map((f) => `<li><code>${esc(f.file)}</code><br><span>${esc(f.date || f.dates || '')} · ${esc(f.direction || '')} · track ${esc(f.track ?? '')} frame ${esc(f.frame ?? '')} · ${esc(f.processing || '')} ${f.product_version ? '· product ' + esc(f.product_version) : ''}</span></li>`).join('')}
      </ul>
      <h3>Layers read</h3>
      <ul>${(p.layers || []).map((l) => `<li><code>${esc(l)}</code></li>`).join('')}</ul>
      <h3>Processing steps</h3>
      <ol>${(p.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <h3>Method and thresholds (fixed before any result: ${esc(m.declared || '')})</h3>
      <table class="custody-table">${Object.entries(m).filter(([k]) => k !== 'declared').map(([k, v]) => row(k, v)).join('')}</table>
      ${extra.length ? `<h3>Not shown in the verdict</h3><table class="custody-table">${extra.map((x) => row(x.label, `${x.value} ${x.unit || ''} — ${x.note || ''}`)).join('')}</table>` : ''}
      <h3>Checks and results</h3>
      <table class="custody-table">${Object.entries(r).map(([k, v]) => row(k, v)).join('')}</table>
      <h3>Software</h3>
      <table class="custody-table">
        ${row('script', `${p.script || ''} v${p.script_version || '?'}`)}
        ${row('script fingerprint (SHA-256 of the script as stored in git, LF line endings)', p.script_sha256 || '')}
        ${p.helpers_sha256 ? row('helpers fingerprint (SHA-256)', p.helpers_sha256) : ''}
        ${row('numbers generated', numbers.generated)}
      </table>
      <div class="custody-actions">
        <button class="ghost-btn" id="custody-dl">Download JSON</button>
        <button class="primary-btn" id="custody-close">Close</button>
      </div>
    </article>`;
  dialog.querySelector('#custody-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('#custody-dl').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ case: caseInfo.id, ...numbers }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `omnisar-${caseInfo.id}-chain-of-custody.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  dialog.setAttribute('aria-labelledby', 'custody-title');
  dialog.showModal();
  // the browser focuses the first button (at the bottom); start the reader at the top instead
  dialog.querySelector('.trap-title').focus();
  dialog.scrollTop = 0;
  dialog.querySelector('.custody').scrollTop = 0;
}
