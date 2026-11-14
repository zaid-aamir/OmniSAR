// A hands-free, captioned 1-minute tour of CLASSIC mode (?mode=classic&tour, or "Watch a
// 1-minute tour" on the classic home screen; Live Ops does not offer it):
// globe and its markers -> fly into Jebel Ali -> sort a card wrongly so a trap card opens ->
// inspect one block -> Trap Lab -> verdict. It drives the real app (the same buttons a player
// presses), so everything shown is the real thing. Pressing any key, or "Stop tour", stops it.
// v7: the timeline slider is gone, so the tour no longer scrubs it.

import { announce } from './util.js';

class Stopped extends Error {}

export async function runTour(app) {
  if (document.querySelector('.tour-cap')) return;
  const cap = document.createElement('div');
  cap.className = 'tour-cap';
  cap.innerHTML = '<p class="tour-text" role="status" aria-live="polite"></p><button class="ghost-btn" id="tour-stop">Stop tour (any key)</button>';
  document.body.appendChild(cap);
  let stopped = false;
  const stop = () => { stopped = true; };
  const onKey = () => stop();
  window.addEventListener('keydown', onKey, true);
  cap.querySelector('#tour-stop').addEventListener('click', stop);

  const wait = (ms) => new Promise((res, rej) => {
    const t0 = performance.now();
    const tick = () => (stopped ? rej(new Stopped()) : performance.now() - t0 >= ms ? res() : setTimeout(tick, 50));
    tick();
  });
  const say = (text) => { cap.querySelector('.tour-text').textContent = text; };
  const $ = (sel) => document.querySelector(sel);
  const click = async (sel, pause = 700) => { $(sel)?.click(); await wait(pause); };

  const c = app.data.cases.find((x) => x.id === 'jebel-ali');
  const mys = await fetch(c.mysteryFile).then((r) => r.json());
  const right = (choiceId) => mys.choices[choiceId].options.findIndex((o) => o.correct);

  // answer every step correctly until we reach a step of type `until` (or the verdict)
  async function solveTo(until, pause) {
    for (let guard = 0; guard < 20; guard++) {
      const idx = Number(($('#panel-inner .eyebrow')?.textContent.match(/Step (\d+) of/) || [])[1]) - 1;
      const st = mys.steps[idx];
      if (!st || st.type === until) return;
      if (st.type === 'choice') await click(`[data-choice="${st.choice}"][data-i="${right(st.choice)}"]`, pause);
      if (st.type === 'evidence') {
        for (const e of mys.evidence.filter((x) => !x.pending && x.src)) {
          if ($(`[data-card="${e.id}"].is-filed`)) continue;
          await click(`[data-sort="${e.bin}"][data-id="${e.id}"]`, pause / 3);
          if (e.bin === 'trap') await click(`[data-name="${e.trap}"][data-id="${e.id}"]`, pause / 3);
          document.querySelector('dialog[open]')?.close();
        }
      }
      if (st.type === 'graph') {
        for (const n of mys.graph.nodes.filter((x) => x.hidden)) {
          await click(`[data-pick="${n.id}"]`, pause / 3);
          await click(`[data-node="${n.id}"][data-i="${n.options.findIndex((o) => o.correct)}"]`, pause / 3);
        }
      }
      await click('#wt-next', pause);
    }
  }

  try {
    announce('Tour started. Press any key to stop.');
    app.backToGlobe();
    app.globe.controls.autoRotate = true;
    say('OmniSAR: five real radar mysteries on a changing Earth. Every block of this globe is a real NASA data cell.');
    await wait(7000);

    say('Each coloured column is one of our five cases. Grey columns are live-event markers: NASA EONET events nobody has checked with radar.');
    await wait(5500);

    say('Fly into a case: Jebel Ali, Dubai. What appeared here between June and October 2026?');
    app.selectCase('jebel-ali');
    await wait(3500);
    await app.openMystery('jebel-ali');
    await wait(1500);

    say('Answer the questions, then sort the real evidence from the traps.');
    await solveTo('evidence', 1100);
    await wait(800);
    say('Sort a card the wrong way and its trap card opens: this one is interference, not new buildings.');
    await click('[data-sort="real"][data-id="two-date"]', 5500);
    document.querySelector('dialog[open]')?.close();

    say('What did the radar hit? Click any block: its real HH and HV for every pass, and the likely bounce type, not proof.');
    app.terrain.inspectAt(0, 0);
    await wait(6500);

    say('The Trap Lab: all 17 traps, each with a real example from our cases, and switches to try them yourself.');
    app.openTrapLab(8);
    await wait(3000);
    await click('[data-flip="8"]', 4000);

    say('The verdict: real numbers that count up from our files, an evidence badge, and what radar can’t prove.');
    await app.openMystery('jebel-ali');
    await wait(800);
    await solveTo('verdict', 250);
    await wait(9000);

    say('That was OmniSAR. Your turn: pick a case on the globe.');
    await wait(3500);
    app.backToGlobe();
  } catch (e) {
    if (!(e instanceof Stopped)) console.error(e);
  } finally {
    window.removeEventListener('keydown', onKey, true);
    cap.remove();
    announce('Tour stopped.');
  }
}
