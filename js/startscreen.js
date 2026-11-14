// The Live Ops start screen: one big round PLAY button in the middle of the spinning Earth,
// with the honesty line under it (the game is a REPLAY of real 2026 NISAR passes, not live data).
//
//   createStartScreen(root, { onPlay }) -> { show(), hide() }
//   - root: the element the overlay goes in (main.js passes #globe-area).
//   - PLAY is a real <button>, so the mouse, Enter and Space all work, and it gets keyboard focus.
//   - Pressing it calls onPlay(button) once. This file does NOT start the game: main.js decides
//     what happens (start effects, panel, alert rods, the game loop).
//   - hide(): the button shrinks into the globe and fades (~400 ms), then the overlay leaves the
//     tab order. show() brings it back (e.g. after "Back to globe" at the end of a game).
// Looks: css/start.css (cyan glow and a slow "breathing" pulse, under 1 per second).

const HONESTY = 'A replay of real 2026 NISAR passes on their real dates. ' +
  'In reality, processed NISAR data reaches users days after a pass.';
const HIDE_MS = 400;

export function createStartScreen(root, { onPlay } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'start-screen';
  overlay.hidden = true;
  overlay.inert = true;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'start-play';
  button.setAttribute('aria-label', 'Play: start Live Ops');
  // a play triangle and the word PLAY (the triangle is decoration; the label above is what screen readers say)
  button.innerHTML = `
    <svg class="start-play-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>
    <span class="start-play-text" aria-hidden="true">PLAY</span>`;

  const honesty = document.createElement('p');
  honesty.className = 'start-honesty';
  honesty.textContent = HONESTY;

  overlay.append(button, honesty);
  root.appendChild(overlay);

  let pressed = false;          // onPlay runs once per show(), even if the button is pressed twice fast
  let hideTimer = null;

  button.addEventListener('click', () => {
    if (pressed) return;
    pressed = true;
    onPlay?.(button);
  });

  return {
    show() {
      clearTimeout(hideTimer);
      pressed = false;
      overlay.classList.remove('is-leaving');
      overlay.hidden = false;
      overlay.inert = false;
      button.focus({ preventScroll: true });
    },
    hide() {
      pressed = true;
      overlay.inert = true;                    // out of the tab order at once; the shrink plays on
      if (overlay.hidden) return;
      overlay.classList.add('is-leaving');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { overlay.hidden = true; }, HIDE_MS);
    },
  };
}
