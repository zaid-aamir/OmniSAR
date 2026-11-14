// The player's progress across the five cases: which cases are finished, which traps they
// caught and which caught them. Kept in memory, and also in the browser's localStorage so a
// page reload doesn't lose it. If storage is blocked (private window, strict settings), the
// game still works; progress just isn't remembered after a reload.

const KEY = 'omnisar-progress-v1';
let state = {};

try {
  state = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
} catch {
  state = {};
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: memory only */ }
}

// summary = { caught: [trap ids], fell: [trap ids], badge, lessons: [heads] }
export function recordCase(caseId, summary) {
  state[caseId] = { ...summary, done: true };
  save();
}

export function caseProgress(caseId) { return state[caseId] || null; }

export function finishedCount(ids) { return ids.filter((id) => state[id]?.done).length; }

export function resetProgress() {
  state = {};
  save();
}
