/** STREAM CONTROL side panel — direct iframe to ATEM / Companion tablet URL. */

import { loadControlFrame, unloadControlFrame } from './lanProxyFrame.js';

const FRAME_ID = 'streamControlFrame';

let open = false;
let controlUrl = null;

export function setStreamControlUrl(url) {
  if (!url || typeof url !== 'string') return;
  controlUrl = url;
  if (open) loadStreamControlFrame();
  else unloadStreamControlFrame();
}

export function initStreamControl() {
  const tab = document.getElementById('streamControlTab');
  if (!tab) return;

  window.addEventListener('stream1-close-stream', closeStreamControl);

  tab.onclick = () => {
    if (open) closeStreamControl();
    else openStreamControl();
  };
}

export function showStreamControlTab(visible) {
  const tab = document.getElementById('streamControlTab');
  if (!tab) return;
  tab.hidden = !visible;
  if (!visible) closeStreamControl();
}

function loadStreamControlFrame() {
  loadControlFrame(FRAME_ID, controlUrl);
}

function unloadStreamControlFrame() {
  unloadControlFrame(FRAME_ID);
}

function openStreamControl() {
  const tab = document.getElementById('streamControlTab');
  const panel = document.getElementById('streamControlPanel');
  if (!tab || !panel) return;

  window.dispatchEvent(new Event('stream1-close-volume'));

  loadStreamControlFrame();
  open = true;
  document.body.classList.add('stream-control-open');
  panel.setAttribute('aria-hidden', 'false');
  tab.setAttribute('aria-expanded', 'true');
  tab.title = 'Close stream control panel';
}

function closeStreamControl() {
  const tab = document.getElementById('streamControlTab');
  const panel = document.getElementById('streamControlPanel');
  if (!tab || !panel) return;

  unloadStreamControlFrame();
  open = false;
  document.body.classList.remove('stream-control-open');
  panel.setAttribute('aria-hidden', 'true');
  tab.setAttribute('aria-expanded', 'false');
  tab.title = 'Open stream control panel';
}

export function isStreamControlOpen() {
  return open;
}
