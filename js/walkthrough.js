// The walkthrough: draws the current step of a mystery in the side panel.
// Everything it shows is pre-written text from the case file or real values from the numbers
// file. Each choice has its own reply; a wrong choice shows its explanation (and the trap it
// fell into), then the player tries again. The game rules themselves live in engine.js; the
// sorting game, the cause-and-effect graph and the chain of custody have their own files.

import { esc } from './util.js';
import { trapChip, wireTrapChips } from './trapcard.js';
import { mountMinigame } from './minigame.js';
import { mountGraph } from './graph.js';
import { openCustody } from './custody.js';

const STEP_NAMES = {
  tip: 'The tip', choice: 'Your call', evidence: 'Sort the evidence', toggles: 'Interrogate',
  graph: 'Cause and effect', verdict: 'Verdict', lesson: 'Radar lesson',
};

// Source tag: cyan only for NISAR (a fixed data colour), plain for every other source
export function sourceTag(text) {
  return `<span class="tag ${/^NISAR/.test(text) ? 'tag-nisar' : ''}">${esc(text)}</span>`;
}

// Published sources as links that open in a new tab. Only https links are allowed, so a
// typo or a strange link in a data file can never run code on the page.
export function citationLinks(list) {
  return list.map((c) => {
    const text = `${esc(c.outlet)}, ${esc(c.date)}: “${esc(c.title)}”`;
    return /^https:\/\//.test(c.url)
      ? `<a class="tag cite" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : `<span class="tag cite">${text}</span>`;
  }).join('');
}

export function runWalkthrough(root, mystery, { onExit }) {
  const lastAnswer = {};   // most recent answer per choice, so its reply stays on screen
  const toggleState = {};  // toggle id -> true when switched "on"

  function updateNav() {
    const next = root.querySelector('#wt-next');
    if (next) next.disabled = !mystery.isStepDone();
  }

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
    root.querySelector('#wt-next')?.addEventListener('click', () => { m.next(); render(); });
    root.querySelector('#wt-finish')?.addEventListener('click', onExit);

    root.querySelectorAll('[data-choice]').forEach((btn) => btn.addEventListener('click', () => {
      lastAnswer[`choice:${btn.dataset.choice}`] = m.answerChoice(btn.dataset.choice, Number(btn.dataset.i));
      render();
    }));
    root.querySelectorAll('[data-toggle]').forEach((box) => box.addEventListener('change', () => {
      toggleState[box.dataset.toggle] = box.checked;
      render();
    }));
    root.querySelector('#wt-custody')?.addEventListener('click', () => openCustody(m.info, m.numbers));
    if (step.type === 'evidence') mountMinigame(root.querySelector('#wt-mini'), m, { onChange: () => { updateNav(); wireTrapChips(root); } });
    if (step.type === 'graph') mountGraph(root.querySelector('#wt-graph'), m, { onChange: updateNav });
    wireTrapChips(root);
    root.closest('.panel')?.scrollTo({ top: 0 });
  }

  // ---------- one renderer per step type ----------
  function renderStep(step) {
    switch (step.type) {
      case 'tip': return renderTip();
      case 'choice': return renderChoice(step.choice);
      case 'evidence': return `<h2 class="wt-title">${esc(step.title)}</h2><p class="panel-text">${esc(step.text)}</p><div id="wt-mini"></div>`;
      case 'toggles': return renderToggles(step);
      case 'graph': return `<h2 class="wt-title">${esc(step.title)}</h2><p class="panel-text">${esc(step.text)}</p><div id="wt-graph"></div>`;
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

  // Toggles: each one swaps between two REAL images made from our data. A toggle that can't
  // be real for this case is switched off, with the reason written next to it.
  function renderToggles(step) {
    return `
      <h2 class="wt-title">${esc(step.title)}</h2>
      <p class="panel-text">${esc(step.text)}</p>
      <div class="toggle-list">
        ${mystery.data.toggles.map((t) => {
          const ready = !t.disabled && t.layers?.off?.src && t.layers?.on?.src;
          const on = !!toggleState[t.id];
          const shown = ready ? (on ? t.layers.on : t.layers.off) : null;
          return `
            <div class="toggle-row ${ready ? '' : 'is-off'}">
              <label class="toggle">
                <input type="checkbox" data-toggle="${esc(t.id)}" ${ready ? '' : 'disabled'} ${on ? 'checked' : ''}>
                <span>${esc(t.label)}</span>
              </label>
              ${shown ? `<figure class="toggle-fig"><img src="${esc(shown.src)}" alt="${esc(shown.label)}"><figcaption>Showing: <strong>${esc(shown.label)}</strong></figcaption></figure>` : ''}
              <p class="evidence-caption">${esc(t.explains)}</p>
              ${t.disabled ? `<p class="toggle-reason">${esc(t.disabled)}</p>` : ''}
              <p class="toggle-meta">${!ready && !t.disabled ? '<span class="pending-text">Layers pending</span>' : ''} ${t.trap ? trapChip(t.trap) : ''}</p>
            </div>`;
        }).join('')}
      </div>`;
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
      ${n.badge ? `<p class="badge-line"><span class="tag tag-nisar">Evidence: ${esc(n.badge)}</span> <span class="evidence-caption">${esc(n.badge_reason || '')}</span></p>` : ''}
      <button class="ghost-btn" id="wt-custody">Chain of custody: every file, step and threshold</button>`
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
