// The walkthrough: draws the current step of a mystery in the side panel.
// Everything it shows is pre-written text from the case file or real values from the numbers
// file. Each choice has its own reply; a wrong choice shows its explanation (and the trap it
// fell into), then the player tries again. The game rules themselves live in engine.js; the
// sorting game, the cause-and-effect graph and the chain of custody have their own files.

import { esc, announce, focusKey, restoreFocus } from './util.js';
import { trapChip, wireTrapChips } from './trapcard.js';
import { mountMinigame } from './minigame.js';
import { mountGraph } from './graph.js';
import { openCustody } from './custody.js';
import { recordCase } from './progress.js';
import { countUpAll, stamp } from './motion.js';
import { mountGigabytes } from './gigabytes.js';

// Why "Next" is still disabled on a step (shown next to the button)
const WAIT_REASON = {
  choice: 'Pick the right answer to go on',
  evidence: 'File every card to go on',
  graph: 'Predict every “?” to go on',
};

const STEP_NAMES = {
  tip: 'The tip', choice: 'Your call', evidence: 'Sort the evidence', toggles: 'Interrogate',
  graph: 'Cause and effect', verdict: 'Verdict', lesson: 'What you learned',
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

// Which traps this case put in the player's way, and how they did:
//   caught = met it and never fell for it; fell = picked a trap answer or mis-sorted a trap card at least once
export function trapSummary(mystery) {
  const caught = new Set();
  const fell = new Set();
  for (const [cid, c] of Object.entries(mystery.data.choices)) {
    c.options.forEach((o, i) => {
      const t = o.trap ?? o.limit;
      if (t == null || o.correct) return;
      (mystery.tried.has(`choice:${cid}:${i}`) ? fell : caught).add(t);
    });
  }
  for (const card of mystery.sortableCards()) {
    if (card.bin !== 'trap') continue;
    (mystery.tried.has(`card:${card.id}`) ? fell : caught).add(card.trap);
  }
  for (const t of fell) caught.delete(t);
  const order = (a, b) => (typeof a === 'number' ? a : 99) - (typeof b === 'number' ? b : 99);
  return { caught: [...caught].sort(order), fell: [...fell].sort(order) };
}

export function runWalkthrough(root, mystery, { onExit }) {
  const lastAnswer = {};   // most recent answer per choice, so its reply stays on screen
  const toggleState = {};  // toggle id -> true when switched "on"

  function updateNav() {
    const next = root.querySelector('#wt-next');
    if (next) next.disabled = !mystery.isStepDone();
    const why = root.querySelector('#wt-why');
    if (why) why.hidden = mystery.isStepDone();
  }

  // focus = 'title' (a new step: start reading at its heading), 'reply' (an answer: read the reply),
  // or nothing (keep focus on the same control, e.g. a toggle)
  function render(focus = null) {
    const m = mystery;
    const step = m.step;
    const key = focusKey(root);
    const done = m.isStepDone();
    root.innerHTML = `
      <button class="link-btn" id="wt-exit">← Case card</button>
      <p class="eyebrow">${esc(m.info.name)} · Step ${m.stepIndex + 1} of ${m.steps.length} · ${esc(STEP_NAMES[step.type] || step.type)}</p>
      <div class="wt-progress"><span style="width:${((m.stepIndex + 1) / m.steps.length) * 100}%"></span></div>
      <div class="wt-body">${renderStep(step)}</div>
      <div class="wt-nav">
        ${m.stepIndex === 0 ? '' : '<button class="ghost-btn" id="wt-back">← Back</button>'}
        ${m.isLast
          ? '<button class="primary-btn" id="wt-finish">Finish case</button>'
          : `${WAIT_REASON[step.type] ? `<span class="wt-why" id="wt-why" ${done ? 'hidden' : ''}>${esc(WAIT_REASON[step.type])}</span>` : ''}
             <button class="primary-btn" id="wt-next" ${done ? '' : 'disabled'} ${WAIT_REASON[step.type] ? 'aria-describedby="wt-why"' : ''}>Next →</button>`}
      </div>`;

    root.querySelector('#wt-exit').addEventListener('click', () => onExit());
    root.querySelector('#wt-back')?.addEventListener('click', () => { m.back(); render('title'); });
    root.querySelector('#wt-next')?.addEventListener('click', () => { m.next(); render('title'); });
    root.querySelector('#wt-finish')?.addEventListener('click', () => {
      const s = trapSummary(m);
      recordCase(m.info.id, { ...s, badge: m.numbers?.badge || null, lessons: m.data.lesson.points.map((p) => p.head) });
      onExit({ finished: true });
    });

    root.querySelectorAll('[data-choice]').forEach((btn) => btn.addEventListener('click', () => {
      lastAnswer[`choice:${btn.dataset.choice}`] = m.answerChoice(btn.dataset.choice, Number(btn.dataset.i));
      render('reply');
    }));
    root.querySelectorAll('[data-toggle]').forEach((box) => box.addEventListener('change', () => {
      toggleState[box.dataset.toggle] = box.checked;
      render();
    }));
    root.querySelector('#wt-custody')?.addEventListener('click', () => openCustody(m.info, m.numbers));
    if (step.type === 'evidence') mountMinigame(root.querySelector('#wt-mini'), m, { onChange: () => { updateNav(); wireTrapChips(root); } });
    if (step.type === 'graph') mountGraph(root.querySelector('#wt-graph'), m, { onChange: updateNav });
    if (step.type === 'verdict') mountGigabytes(root.querySelector('#wt-gb'), m.info, m.numbers);
    wireTrapChips(root);
    if (focus !== 'reply') root.closest('.panel')?.scrollTo({ top: 0 });
    // keyboard focus never stays on a control that the redraw removed
    if (focus === 'reply') root.querySelector('.reply')?.focus();
    else if (focus === 'title') root.querySelector('.wt-title')?.focus({ preventScroll: true });
    else restoreFocus(root, key, '.wt-title');
    if (step.type === 'verdict' && focus === 'title') {
      // the real numbers count up to their value, then the evidence badge stamps in
      countUpAll(root, { then: () => stamp(root.querySelector('.badge-line .tag')) });
      const n = m.numbers;
      announce(n ? `Verdict for ${m.info.name}. Evidence: ${n.badge || 'no badge'}.` : `Verdict for ${m.info.name}: evidence pending.`);
    }
  }

  // ---------- one renderer per step type ----------
  function renderStep(step) {
    switch (step.type) {
      case 'tip': return renderTip();
      case 'choice': return renderChoice(step.choice);
      case 'evidence': return `<h2 class="wt-title" tabindex="-1">${esc(step.title)}</h2><p class="panel-text">${esc(step.text)}</p><div id="wt-mini"></div>`;
      case 'toggles': return renderToggles(step);
      case 'graph': return `<h2 class="wt-title" tabindex="-1">${esc(step.title)}</h2><p class="panel-text">${esc(step.text)}</p><div id="wt-graph"></div>`;
      case 'verdict': return renderVerdict();
      case 'lesson': return renderLesson();
      default: return `<p class="panel-text">Unknown step type: ${esc(step.type)}</p>`;
    }
  }

  function renderTip() {
    const tip = mystery.data.tip;
    return `
      <h2 class="wt-title" tabindex="-1">${esc(tip.title)}</h2>
      <p class="case-question">“${esc(mystery.info.question)}”</p>
      ${tip.text.map((p) => `<p class="panel-text">${esc(p)}</p>`).join('')}`;
  }

  // A multiple-choice question. Each option has its own reply.
  function renderChoice(choiceId) {
    const c = mystery.data.choices[choiceId];
    const solved = mystery.solved.has(`choice:${choiceId}`);
    const answer = lastAnswer[`choice:${choiceId}`];
    return `
      <h2 class="wt-title" tabindex="-1">${esc(c.prompt)}</h2>
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
      <div class="reply ${option.correct ? 'reply-right' : 'reply-wrong'}" tabindex="-1" role="status">
        <p class="reply-head">${option.correct ? 'Correct' : 'Not quite — try again'}</p>
        <p>${esc(option.reply)}</p>
        ${trapId != null ? `<p class="reply-trap">You met ${trapChip(trapId, typeof trapId === 'number' ? `Trap #${trapId} — open the card` : 'What radar can’t prove — open the card')}</p>` : ''}
      </div>`;
  }

  // Toggles: each one swaps between two REAL images made from our data. Only toggles that have
  // both real layers for this case are shown as switches; the others would do nothing, so they
  // are listed underneath as plain text with the reason (the reason itself is part of the lesson).
  function renderToggles(step) {
    const ready = (t) => !t.disabled && t.layers?.off?.src && t.layers?.on?.src;
    const live = mystery.data.toggles.filter(ready);
    const off = mystery.data.toggles.filter((t) => !ready(t));
    return `
      <h2 class="wt-title" tabindex="-1">${esc(step.title)}</h2>
      <p class="panel-text">${esc(step.text)}</p>
      <div class="toggle-list">
        ${live.map((t) => {
          const on = !!toggleState[t.id];
          const shown = on ? t.layers.on : t.layers.off;
          return `
            <div class="toggle-row">
              <label class="toggle">
                <input type="checkbox" data-toggle="${esc(t.id)}" ${on ? 'checked' : ''}>
                <span>${esc(t.label)}</span>
              </label>
              <figure class="toggle-fig"><img src="${esc(shown.src)}" alt="${esc(shown.label)}"><figcaption>Showing: <strong>${esc(shown.label)}</strong></figcaption></figure>
              <p class="evidence-caption">${esc(t.explains)}</p>
              ${t.trap ? `<p class="toggle-meta">${trapChip(t.trap)}</p>` : ''}
            </div>`;
        }).join('')}
      </div>
      ${off.length ? `
        <h3 class="wt-sub">Not available for this case</h3>
        <ul class="toggle-unavailable">
          ${off.map((t) => `<li><strong>${esc(t.label)}</strong>: ${esc(t.disabled || 'layers pending')} ${t.trap ? trapChip(t.trap) : ''}</li>`).join('')}
        </ul>` : ''}`;
  }

  // Weak or unchecked evidence is a catch, not a failure: say what was caught and why that is honest.
  // Only the case's own badge reason and check text are used, so it never claims more than the evidence.
  function caught(n) {
    if (/^weak/i.test(n.badge || '')) {
      return `<div class="caught"><p class="reply-head">We caught it</p><p>${esc(n.check?.text || n.badge_reason || '')} Rather than claim more than the radar can carry,
        the badge says Weak: the honest answer for now is “not proven yet”. That is the evidence check doing its job.</p></div>`;
    }
    if (/^unchecked/i.test(n.badge || '')) {
      return `<div class="caught"><p class="reply-head">We caught it</p><p>There is no independent check yet. ${esc(n.check?.text || n.badge_reason || '')}
        So every class here stays labelled “radar only” until a second source agrees or disagrees. Saying so is the honest result.</p></div>`;
    }
    return '';
  }

  // Verdict: real numbers only. No numbers file listed in results.json -> "evidence pending".
  function renderVerdict() {
    const v = mystery.data.verdict;
    const n = mystery.numbers;
    const body = n ? `
      <dl class="facts">
        ${n.measured.map((x) => `<div><dt>${esc(x.label)}</dt><dd><strong>${typeof x.value === 'number'
          ? `<span class="sr-only">${esc(x.value)}</span><span data-count="${esc(x.value)}" aria-hidden="true">${esc(x.value)}</span>`
          : esc(x.value)}</strong> ${esc(x.unit || '')}${x.note ? `<br><span class="evidence-caption">${esc(x.note)}</span>` : ''}</dd></div>`).join('')}
        ${n.check ? `<div><dt>${esc(n.check.label)}</dt><dd>${esc(n.check.text)}</dd></div>` : ''}
      </dl>
      ${n.badge ? `<p class="badge-line"><span class="tag tag-nisar">Evidence: ${esc(n.badge)}</span> <span class="evidence-caption">${esc(n.badge_reason || '')}</span></p>` : ''}
      ${caught(n)}
      <button class="ghost-btn" id="wt-custody">Chain of custody: every file, step and threshold</button>
      <div id="wt-gb"></div>`
      : `<div class="pending-box pending-verdict">${esc(v.pending)}</div>`;
    return `
      <h2 class="wt-title" tabindex="-1">Verdict</h2>
      <p class="case-question">“${esc(mystery.info.question)}”</p>
      ${body}
      <h3 class="wt-sub">What the radar can't prove</h3>
      <ul class="cant-list">${v.cantProve.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p>${trapChip('who-why', 'Why not? Open the card')}</p>`;
  }

  // "What you learned": the radar lesson, then every trap this case put in your way
  function renderLesson() {
    const l = mystery.data.lesson;
    const s = trapSummary(mystery);
    const chips = (list) => list.map((t) => trapChip(t, typeof t === 'number' ? `Trap #${t}` : 'What radar can’t prove')).join(' ');
    return `
      <h2 class="wt-title" tabindex="-1">What you learned</h2>
      <p class="eyebrow">${esc(l.title)}</p>
      ${l.points.map((p) => `<h3 class="wt-sub">${esc(p.head)}</h3><p class="panel-text">${esc(p.text)}</p>`).join('')}
      <h3 class="wt-sub">Traps in this case</h3>
      ${s.caught.length ? `<p class="panel-text"><span class="recap-ok">✓ Caught without falling for them:</span> ${chips(s.caught)}</p>` : ''}
      ${s.fell.length ? `<p class="panel-text"><span class="recap-bad">✗ Fooled you once (now you know):</span> ${chips(s.fell)}</p>` : ''}
      ${!s.caught.length && !s.fell.length ? '<p class="panel-text">This case had no trap questions.</p>' : ''}
      <p class="evidence-caption">Press “Finish case” to save this case to your investigation.</p>`;
  }

  render('title');   // the "Open mystery" button is gone: start at the first step's heading
}
