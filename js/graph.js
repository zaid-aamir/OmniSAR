// Cause-and-effect graph: the case's chain drawn as glowing nodes joined by links.
//   - hidden nodes show "?" until the player predicts them (each option has its own reply)
//   - clicking an open node opens its exhibit: image, chart, badge, and how we know it:
//       "Measured by <satellite>", "From published sources <citations>", or "Not measured here"
// Charts are drawn from the case's numbers file (real values only). The rule "every hidden
// node must be predicted before you can go on" lives in engine.js.

import { esc, focusKey, restoreFocus } from './util.js';
import { citationLinks, sourceTag } from './walkthrough.js';

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

// A small line-and-dot chart. series = [{ label, points: [{x: 'YYYY-MM-DD', y}] }]
export function chartSVG(chart, numbers) {
  const series = (chart.series || [{ label: chart.label, path: chart.path }]).map((s) => ({
    label: s.label,
    points: (get(numbers, s.path) || []).map((p) => ({ x: p[chart.x], y: p[s.y || chart.y] })).filter((p) => p.y != null),
  })).filter((s) => s.points.length);
  if (!series.length) return '<div class="pending-box">Chart pending</div>';
  const all = series.flatMap((s) => s.points);
  const t = (d) => new Date(d + 'T00:00:00Z').getTime();
  const x0 = Math.min(...all.map((p) => t(p.x))), x1 = Math.max(...all.map((p) => t(p.x)));
  let y0 = Math.min(...all.map((p) => p.y), chart.zero ? 0 : Infinity), y1 = Math.max(...all.map((p) => p.y), chart.zero ? 0 : -Infinity);
  if (y1 - y0 < 1e-6) { y0 -= 1; y1 += 1; }
  const W = 300, H = 150, L = 42, R = 10, T = 12, B = 26;
  const px = (d) => L + (x1 === x0 ? 0.5 : (t(d) - x0) / (x1 - x0)) * (W - L - R);
  const py = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const colours = ['var(--data-nisar)', '#E0B44C'];
  const fmt = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `
    <figure class="chart">
      <figcaption>${esc(chart.title)}</figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.title)}">
        <line x1="${L}" y1="${py(y0)}" x2="${W - R}" y2="${py(y0)}" class="axis"/>
        <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="axis"/>
        ${chart.zero && y0 < 0 && y1 > 0 ? `<line x1="${L}" y1="${py(0)}" x2="${W - R}" y2="${py(0)}" class="zero"/>` : ''}
        <text x="${L - 4}" y="${py(y1) + 4}" text-anchor="end">${y1.toFixed(1)}</text>
        <text x="${L - 4}" y="${py(y0)}" text-anchor="end">${y0.toFixed(1)}</text>
        <text x="${L}" y="${H - 6}">${fmt(all.reduce((a, p) => (t(p.x) < t(a.x) ? p : a)).x)}</text>
        <text x="${W - R}" y="${H - 6}" text-anchor="end">${fmt(all.reduce((a, p) => (t(p.x) > t(a.x) ? p : a)).x)}</text>
        ${series.map((s, k) => `
          <polyline fill="none" stroke="${colours[k % 2]}" stroke-width="2" points="${s.points.map((p) => `${px(p.x)},${py(p.y)}`).join(' ')}"/>
          ${s.points.map((p) => `<circle cx="${px(p.x)}" cy="${py(p.y)}" r="3.5" fill="${colours[k % 2]}"><title>${fmt(p.x)}: ${p.y.toFixed(1)} ${esc(chart.unit)}</title></circle>`).join('')}`).join('')}
      </svg>
      <p class="chart-legend">${series.map((s, k) => `<span style="color:${colours[k % 2]}">● ${esc(s.label)}</span>`).join(' ')} <span>(${esc(chart.unit)})</span></p>
    </figure>`;
}

export function mountGraph(host, mystery, { onChange }) {
  const { nodes, edges } = mystery.data.graph;
  let selected = null;
  const replies = {};

  function nodeOpen(n) { return !n.hidden || mystery.solved.has(`node:${n.id}`); }

  function basisLine(n) {
    if (n.basis === 'measured') return `<p class="node-basis basis-measured">Measured by ${sourceTag(n.source)}</p>`;
    if (n.basis === 'published') {
      return `<p class="node-basis basis-published">From published sources ${n.citation?.length ? citationLinks(n.citation) : '<span class="pending-text">citation pending</span>'}</p>`;
    }
    return `<p class="node-basis basis-none">Not measured here: ${esc(n.notMeasured || 'no data for this link')}</p>`;
  }

  function badge(n) {
    const b = n.opens?.badge;
    if (b === 'numbers') return mystery.numbers?.badge ? `Evidence: ${mystery.numbers.badge}` : 'Evidence pending';
    return b;
  }

  function detail(n) {
    if (!nodeOpen(n)) {
      const r = replies[n.id];
      return `
        <p class="node-prompt">${esc(n.prompt)}</p>
        <div class="options">
          ${n.options.map((o, i) => {
            const tried = mystery.tried.has(`node:${n.id}:${i}`);
            return `<button class="option ${tried ? 'is-wrong' : ''}" data-node="${esc(n.id)}" data-i="${i}" ${tried ? 'disabled' : ''}>${esc(o.text)}</button>`;
          }).join('')}
        </div>
        ${r ? `<div class="reply reply-wrong"><p>${esc(r.reply)}</p></div>` : ''}`;
    }
    const r = replies[n.id];
    const layer = n.opens?.layer;
    const chart = n.opens?.chart;
    const check = n.opens?.check && mystery.numbers?.check ? `<p class="evidence-caption"><strong>${esc(mystery.numbers.check.label)}:</strong> ${esc(mystery.numbers.check.text)}</p>` : '';
    return `
      ${r?.correct ? `<div class="reply reply-right"><p>${esc(r.reply)}</p></div>` : ''}
      <p class="evidence-caption">${esc(n.detail)}</p>
      ${basisLine(n)}
      ${n.locationMatch ? `<p class="pending-text">Location match: ${esc(n.locationMatch)}</p>` : ''}
      ${layer ? `<img class="node-img" src="${esc(layer)}" alt="${esc(n.label)}" loading="lazy">` : (n.basis === 'measured' ? '<div class="pending-box">Exhibit pending</div>' : '')}
      ${chart && mystery.numbers ? chartSVG(chart, mystery.numbers) : ''}
      ${check}
      ${badge(n) ? `<p><span class="tag ${n.basis === 'measured' ? 'tag-nisar' : ''}">${esc(badge(n))}</span></p>` : ''}`;
  }

  function render() {
    const key = focusKey(host);            // keep keyboard focus where it was (see util.js)
    const W = 320, step = 92, H = nodes.length * step;
    const pos = Object.fromEntries(nodes.map((n, i) => [n.id, { x: W / 2, y: 40 + i * step }]));
    host.innerHTML = `
      <div class="graph-wrap">
        <svg class="graph-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">
          <defs><filter id="glow"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
          ${edges.map(([a, b]) => `<line class="graph-link ${nodeOpen(nodes.find((n) => n.id === b)) ? 'lit' : ''}" x1="${pos[a].x}" y1="${pos[a].y}" x2="${pos[b].x}" y2="${pos[b].y}"/>`).join('')}
        </svg>
        <div class="graph-nodes">
          ${nodes.map((n) => `
            <button class="graph-node basis-${esc(n.basis)} ${nodeOpen(n) ? 'open' : 'hidden-node'} ${selected === n.id ? 'selected' : ''}"
                    style="top:${pos[n.id].y}px" data-pick="${esc(n.id)}" aria-expanded="${selected === n.id}"
                    ${nodeOpen(n) ? '' : 'aria-label="Hidden link: predict it"'}>
              ${nodeOpen(n) ? esc(n.label) : '?'}
            </button>`).join('')}
        </div>
      </div>
      <div class="graph-detail" aria-live="polite">
        ${selected ? `<h3 class="wt-sub">${esc(nodeOpen(nodes.find((n) => n.id === selected)) ? nodes.find((n) => n.id === selected).label : 'Hidden link')}</h3>${detail(nodes.find((n) => n.id === selected))}`
                   : '<p class="panel-text">Click a node. A "?" is a hidden link: predict it.</p>'}
      </div>`;
    host.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { selected = b.dataset.pick; render(); }));
    host.querySelectorAll('[data-node]').forEach((b) => b.addEventListener('click', () => {
      replies[b.dataset.node] = mystery.answerNode(b.dataset.node, Number(b.dataset.i));
      render();
    }));
    restoreFocus(host, key, `[data-pick="${CSS.escape(selected || '')}"]`);
    onChange?.();
  }

  // start on the first hidden node, so the player sees what to do
  selected = (nodes.find((n) => n.hidden && !nodeOpen(n)) || nodes[0]).id;
  render();
}
