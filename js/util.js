// Small helpers shared by several files.

// Make text safe to put inside HTML (so a stray "<" in a data file can never break the page)
export function esc(text) {
  return String(text).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
