// OmniSAR entry point. Starts each part of the app in order.
// Step 1: only shows which palette is active. The globe, timeline and mysteries
// are added in the next steps, each in its own file.

const params = new URLSearchParams(location.search);

// Show "Palette N" in the title bar only when a palette was chosen in the URL,
// so the screenshots say which palette they are.
if (params.has('palette')) {
  const chip = document.getElementById('palette-chip');
  chip.textContent = 'Palette ' + document.documentElement.dataset.palette;
  chip.hidden = false;
}
