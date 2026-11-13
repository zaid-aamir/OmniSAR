// The walkthrough: draws the current step of a mystery in the side panel.
// Everything it shows is pre-written text from the case file. Each choice has its own
// reply; a wrong choice shows its explanation (and the trap it fell into), then the
// player tries again. The game rules themselves live in engine.js.

import { esc } from './util.js';
import { trapChip, wireTrapChips } from './trapcard.js';

const STEP_NAMES = {
  tip: 'The tip', choice: 'Your call', evidence: 'Evidence', toggles: 'Interrogate',
  graph: 'Cause and effect', verdict: 'Verdict', lesson: 'Radar lesson',
};

// Source tag: cyan only for NISAR (a fixed data colour), plain for every other source
function sourceTag(text) {
  return `<span class="tag ${/^NISAR/.test(text) ? 'tag-nisar' : ''}">${esc(text)}</span>`;
}

export function runWalkthrough(root, mystery, { onExit }) {
  const lastAnswer = {};   // most recent answer per choice / node, so its reply stays on screen

  function render() {
    const m = mystery;
    const step = m.step;
    root.innerHTML = `
      <button class="link-btn" id="wt-exit">← Case card</button>
      <p class="eyebrow">${esc(m.info.name)} · Step ${m.stepIndex + 1} of ${m.steps.length} · ${esc(STEP_NAMES[step.type] || step.type)}</p>
      <div class="wt-progress"><span style="width:${((m.stepIndex + 1) / m.steps.length) * 100}%"></span></div>
      <div class="wt-body">${renderStep(step)}</div>
      <div class="wt-nav">
        <button class="ghost-btn" id="wt-back" ${m.stepIndex === 0 ? 'disabled' : ''}>← Back</button>
        ${m.isLast
          ? '<button class="primary-btn" id="wt-finish">Finish case</button>'
          : `<button class="primary-btn" id="wt-next" ${m.isStepDone() ? '' : 'disabled'}>Next →</button>`}
      </div>`;

    root.querySelector('#wt-exit').addEventListener('click', onExit);
    root.querySelector('#wt-back').addEventListener('click', () => { m.back(); render(); });
    root.querySelector('#wt-next')?.addEventListener('click', () => { m.next(); render(); root.scrollTop = 0; });
    root.querySelector('#wt-finish')?.addEventListener('click', onExit);

    root.querySelectorAll('[data-choice]').forEach((btn) => btn.addEventListener('click', () => {
      lastAnswer[`choice:${btn.dataset.choice}`] = m.answerChoice(btn.dataset.choice, Number(btn.dataset.i));
      render();
    }));
    root.querySelectorAll('[data-node]').forEach((btn) => btn.addEventListener('click', () => {
      lastAnswer[`node:${btn.dataset.node}`] = m.answerNode(btn.dataset.node, Number(btn.dataset.i));
      render();
    }));
    wireTrapChips(root);
    root.closest('.panel')?.scrollTo({ top: 0 });
  }

  // ---------- one renderer per step type ----------
  function renderStep(step) {
    switch (step.type) {
      case 'tip': return renderTip();
      case 'choice': return renderChoice(step.choice);
      case 'evidence': return renderEvidence(step);
      case 'toggles': return renderToggles(step);
      case 'graph': return renderGraph(step);
      case 'verdict': return renderVerdict();
      case 'lesson': return renderLesson();
      default: return `<p class="panel-text">Unknown step type: ${esc(step.type)}</p>`;
    }
  }

  function renderTip() {
    const tip = mystery.data.tip;
    return `
      <h2 class="wt-title">${esc(tip.title)}</h2>
      <p class="case-question">“${esc(mystery.info.question)}”</p>
      ${tip.text.map((p) => `<p class="panel-text">${esc(p)}</p>`).join('')}`;
  }

  // A multiple-choice question. Each option has its own reply.
  function renderChoice(choiceId) {
    const c = mystery.data.choices[choiceId];
    const solved = mystery.solved.has(`choice:${choiceId}`);
    const answer = lastAnswer[`choice:${choiceId}`];
    return `
      <h2 class="wt-title">${esc(c.prompt)}</h2>
      <div class="options">
        ${c.options.map((o, i) => {
          const tried = mystery.tried.has(`choice:${choiceId}:${i}`);
          const state = solved && o.correct ? 'is-correct' : tried ? 'is-wrong' : '';
          return `<button class="option ${state}" data-choice="${esc(choiceId)}" data-i="${i}"
                    ${solved || tried ? 'disabled' : ''}>${esc(o.text)}</button>`;
        }).join('')}
      </div>
      ${answer ? renderReply(answer) : ''}`;
  }

  function renderReply(option) {
    const trapId = option.trap ?? option.limit ?? null;
    return `
      <div class="reply ${option.correct ? 'reply-right' : 'reply-wrong'}">
        <p class="reply-head">${option.correct ? 'Correct' : 'Not quite — try again'}</p>
        <p>${esc(option.reply)}</p>
        ${trapId != null ? `<p class="reply-trap">You met ${trapChip(trapId, typeof trapId === 'number' ? `Trap #${trapId} — open the card` : 'What radar can’t prove — open the card')}</p>` : ''}
      </div>`;
  }

  // Evidence cards, shown in order. (The sorting game comes in Stage 2.)
  function renderEvidence(step) {
    return `
      <h2 class="wt-title">${esc(step.title)}</h2>
      <p class="panel-text">${esc(step.text)}</p>
      <div class="evidence-list">
        ${mystery.data.evidence.map((e, i) => `
          <article class="evidence-card">
            <p class="evidence-num">Exhibit ${i + 1}</p>
            <h3>${esc(e.title)}</h3>
            ${e.kind === 'image'
              ? (e.src ? `<img src="${esc(e.src)}" alt="${esc(e.caption)}">` : '<div class="pending-box">Evidence pending</div>')
              : ''}
            <p class="evidence-caption">${esc(e.caption)}</p>
            <p class="evidence-source">${sourceTag(e.source)}</p>
          </article>`).join('')}
      </div>`;
  }

  // Toggles: each switches how the evidence is processed. Their layers don't exist yet.
  function renderToggles(step) {
    return `
      <h2 class="wt-title">${esc(step.title)}</h2>
      <p class="panel-text">${esc(step.text)}</p>
      <div class="toggle-list">
        ${mystery.data.toggles.map((t) => {
          const ready = t.layers.off && t.layers.on;
          return `
            <div class="toggle-row">
              <label class="toggle"><input type="checkbox" ${ready ? '' : 'disabled'}><span>${esc(t.label)}</span></label>
              <p class="evidence-caption">${esc(t.explains)}</p>
              <p class="toggle-meta">${ready ? '' : '<span class="pending-text">Layers pending</span>'} ${t.trap ? trapChip(t.trap) : ''}</p>
            </div>`;
        }).join('')}
      </div>`;
  }

  // Cause-and-effect chain. Hidden nodes must be predicted before they are revealed.
  function renderGraph(step) {
    const nodes = mystery.data.graph.nodes;
    return `
      <h2 class="wt-title">${esc(step.title)}</h2>
      <p class="panel-text">${esc(step.text)}</p>
      <ol class="graph">
        ${nodes.map((n) => {
          const open = !n.hidden || mystery.solved.has(`node:${n.id}`);
          const answer = lastAnswer[`node:${n.id}`];
          const basis = n.basis === 'measured' ? 'Measured' : 'Published source';
          return `
            <li class="node ${open ? '' : 'node-hidden'}">
              <div class="node-head">
                <span class="node-label">${open ? esc(n.label) : '?'}</span>
                <span class="node-basis basis-${esc(n.basis)}">${basis}</span>
              </div>
              ${open ? `
                <p class="evidence-caption">${esc(n.detail)}</p>
                <p class="node-meta">
                  ${n.basis === 'measured' ? sourceTag(n.source) : ''}
                  ${n.basis === 'published' ? (n.citation ? `<span class="tag">${esc(n.citation)}</span>` : '<span class="pending-text">Source citation pending</span>') : ''}
                  ${n.basis === 'measured' && !n.opens.layer ? '<span class="pending-text">Layer pending</span>' : ''}
                </p>` : `
                <p class="node-prompt">${esc(n.prompt)}</p>
                <div class="options">
                  ${n.options.map((o, i) => {
                    const tried = mystery.tried.has(`node:${n.id}:${i}`);
                    return `<button class="option ${tried ? 'is-wrong' : ''}" data-node="${esc(n.id)}" data-i="${i}" ${tried ? 'disabled' : ''}>${esc(o.text)}</button>`;
                  }).join('')}
                </div>`}
              ${answer ? `<div class="reply ${answer.correct ? 'reply-right' : 'reply-wrong'}"><p>${esc(answer.reply)}</p></div>` : ''}
            </li>`;
        }).join('<li class="node-arrow" aria-hidden="true">↓</li>')}
      </ol>`;
  }

  // Verdict: real numbers only. No numbers file listed in results.json -> "evidence pending".
  function renderVerdict() {
    const v = mystery.data.verdict;
    const n = mystery.numbers;
    const body = n ? `
      <dl class="facts">
        ${n.measured.map((x) => `<div><dt>${esc(x.label)}</dt><dd><strong>${esc(x.value)}</strong> ${esc(x.unit || '')}${x.note ? `<br><span class="evidence-caption">${esc(x.note)}</span>` : ''}</dd></div>`).join('')}
        ${n.check ? `<div><dt>${esc(n.check.label)}</dt><dd>${esc(n.check.text)}</dd></div>` : ''}
      </dl>
      ${n.badge ? `<p><span class="tag tag-nisar">${esc(n.badge)}</span></p>` : ''}`
      : `<div class="pending-box pending-verdict">${esc(v.pending)}</div>`;
    return `
      <h2 class="wt-title">Verdict</h2>
      <p class="case-question">“${esc(mystery.info.question)}”</p>
      ${body}
      <h3 class="wt-sub">What the radar can't prove</h3>
      <ul class="cant-list">${v.cantProve.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p>${trapChip('who-why', 'Why not? Open the card')}</p>`;
  }

  function renderLesson() {
    const l = mystery.data.lesson;
    return `
      <h2 class="wt-title">${esc(l.title)}</h2>
      ${l.points.map((p) => `<h3 class="wt-sub">${esc(p.head)}</h3><p class="panel-text">${esc(p.text)}</p>`).join('')}`;
  }

  render();
}
