/** Draggable width for stream / volume side panels (25%–50%, default 40%). */

const STORAGE_KEY = 'stream1-side-panel-width';
const MIN_PCT = 25;
const MAX_PCT = 50;
const DEFAULT_PCT = 40;

let widthPct = readStoredWidth();
let dragging = false;

function readStoredWidth() {
  const stored = parseFloat(localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(stored) && stored >= MIN_PCT && stored <= MAX_PCT) return stored;
  return DEFAULT_PCT;
}

function clampWidth(value) {
  return Math.min(MAX_PCT, Math.max(MIN_PCT, value));
}

function applyWidth(pct) {
  widthPct = clampWidth(pct);
  document.documentElement.style.setProperty('--side-panel-width', `${widthPct}%`);
  localStorage.setItem(STORAGE_KEY, String(widthPct));
}

function onPointerMove(event) {
  if (!dragging) return;
  const shell = document.getElementById('shell');
  if (!shell) return;
  const rect = shell.getBoundingClientRect();
  const fromRight = rect.right - event.clientX;
  const pct = (fromRight / rect.width) * 100;
  applyWidth(pct);
}

function stopDrag() {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('side-panel-resizing');
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', stopDrag);
  window.removeEventListener('pointercancel', stopDrag);
}

function startDrag(event) {
  if (event.button !== 0) return;
  dragging = true;
  document.body.classList.add('side-panel-resizing');
  event.preventDefault();
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);
}

function attachHandle(panelId) {
  const panel = document.getElementById(panelId);
  if (!panel || panel.querySelector('.side-panel-resize-handle')) return;

  const handle = document.createElement('div');
  handle.className = 'side-panel-resize-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize side panel');
  handle.title = 'Drag to resize panel';
  handle.addEventListener('pointerdown', startDrag);
  panel.prepend(handle);
}

export function initSidePanelResize() {
  applyWidth(widthPct);
  attachHandle('volumeControlPanel');
  attachHandle('streamControlPanel');
}

export function getSidePanelWidthPct() {
  return widthPct;
}
