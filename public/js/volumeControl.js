/** VOLUME CONTROL side panel — direct iframe to TSC / UCI viewer URL. */

import { loadControlFrame, unloadControlFrame } from './lanProxyFrame.js';

const FRAME_ID = 'volumeControlFrame';

let open = false;
let controlUrl = null;

export function setVolumeControlUrl(url) {
  if (!url || typeof url !== 'string') return;
  controlUrl = url;
  if (open) loadVolumeControlFrame();
  else unloadVolumeControlFrame();
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

function loadVolumeControlFrame() {
  loadControlFrame(FRAME_ID, controlUrl);
}

function unloadVolumeControlFrame() {
  unloadControlFrame(FRAME_ID);
}

function openVolumeControl() {
  const tab = document.getElementById('volumeControlTab');
  const panel = document.getElementById('volumeControlPanel');
  if (!tab || !panel) return;

  window.dispatchEvent(new Event('stream1-close-stream'));

  loadVolumeControlFrame();
  open = true;
  document.body.classList.add('volume-control-open');
  panel.setAttribute('aria-hidden', 'false');
  tab.setAttribute('aria-expanded', 'true');
  tab.title = 'Close volume control panel';
}

function closeVolumeControl() {
  const tab = document.getElementById('volumeControlTab');
  const panel = document.getElementById('volumeControlPanel');
  if (!tab || !panel) return;

  unloadVolumeControlFrame();
  open = false;
  document.body.classList.remove('volume-control-open');
  panel.setAttribute('aria-hidden', 'true');
  tab.setAttribute('aria-expanded', 'false');
  tab.title = 'Open volume control panel';
}

export function isVolumeControlOpen() {
  return open;
}
