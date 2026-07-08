/** Direct LAN control iframes — same as opening the URL in a normal browser tab. */

/** Tell Electron to trust configured control-device hosts (self-signed HTTPS). */
export function registerElectronLanTrust({ stream, volume } = {}) {
  if (typeof window === 'undefined' || !window.stream1?.registerLanControlUrls) return;
  window.stream1.registerLanControlUrls({ stream, volume });
}

export function unloadControlFrame(frameId) {
  const frame = document.getElementById(frameId);
  if (!frame) return;
  frame.src = 'about:blank';
}

export function loadControlFrame(frameId, url) {
  const frame = document.getElementById(frameId);
  if (!frame || !url) return false;
  frame.src = url;
  return true;
}
