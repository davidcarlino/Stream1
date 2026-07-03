/** VOLUME CONTROL side panel — TSC / UCI viewer iframe (via LAN proxy). */

import { lanProxyFrameSrc } from './lanProxyFrame.js';

let open = false;
let iframeLoaded = false;

export function setVolumeControlUrl(url) {
  if (!url || typeof url !== 'string') return;
  const frame = document.getElementById('volumeControlFrame');
  if (frame && iframeLoaded) {
    iframeLoaded = false;
    frame.setAttribute('src', lanProxyFrameSrc('volume'));
    iframeLoaded = true;
  }
}

export function initVolumeControl() {
  const tab = document.getElementById('volumeControlTab');
  if (!tab) return;

  window.addEventListener('stream1-close-volume', closeVolumeControl);

  tab.onclick = () => {
    if (open) closeVolumeControl();
    else openVolumeControl();
  };
}

export function showVolumeControlTab(visible) {
  const tab = document.getElementById('volumeControlTab');
  if (!tab) return;
  tab.hidden = !visible;
  if (!visible) closeVolumeControl();
}

export function closeVolumeControl() {
  const tab = document.getElementById('volumeControlTab');
  const panel = document.getElementById('volumeControlPanel');
  if (!tab || !panel) return;

  open = false;
  document.body.classList.remove('volume-control-open');
  panel.setAttribute('aria-hidden', 'true');
  tab.setAttribute('aria-expanded', 'false');
  tab.title = 'Open volume control panel';
}

function ensureIframeLoaded() {
  const frame = document.getElementById('volumeControlFrame');
  if (!frame || iframeLoaded) return;
  frame.setAttribute('src', lanProxyFrameSrc('volume'));
  iframeLoaded = true;
}

function openVolumeControl() {
  const tab = document.getElementById('volumeControlTab');
  const panel = document.getElementById('volumeControlPanel');
  if (!tab || !panel) return;

  window.dispatchEvent(new Event('stream1-close-stream'));

  ensureIframeLoaded();
  open = true;
  document.body.classList.add('volume-control-open');
  panel.setAttribute('aria-hidden', 'false');
  tab.setAttribute('aria-expanded', 'true');
  tab.title = 'Close volume control panel';
}

export function isVolumeControlOpen() {
  return open;
}
