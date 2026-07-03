/** STREAM CONTROL side panel — ATEM / streamer tablet iframe (via LAN proxy). */

import { lanProxyFrameSrc } from './lanProxyFrame.js';

let open = false;
let iframeLoaded = false;

export function setStreamControlUrl(url) {
  if (!url || typeof url !== 'string') return;
  const frame = document.getElementById('streamControlFrame');
  if (frame && iframeLoaded) {
    iframeLoaded = false;
    frame.setAttribute('src', lanProxyFrameSrc('stream'));
    iframeLoaded = true;
  }
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

function ensureIframeLoaded() {
  const frame = document.getElementById('streamControlFrame');
  if (!frame || iframeLoaded) return;
  frame.setAttribute('src', lanProxyFrameSrc('stream'));
  iframeLoaded = true;
}

function openStreamControl() {
  const tab = document.getElementById('streamControlTab');
  const panel = document.getElementById('streamControlPanel');
  if (!tab || !panel) return;

  window.dispatchEvent(new Event('stream1-close-volume'));

  ensureIframeLoaded();
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

  open = false;
  document.body.classList.remove('stream-control-open');
  panel.setAttribute('aria-hidden', 'true');
  tab.setAttribute('aria-expanded', 'false');
  tab.title = 'Open stream control panel';
}

export function isStreamControlOpen() {
  return open;
}
