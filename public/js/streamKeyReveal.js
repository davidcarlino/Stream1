import { api } from './api.js';
import { h, esc, toast, busy, copyToClipboard } from './ui.js';

function revealedHtml(stream) {
  const backup = stream.backupIngestionAddress
    ? `<label class="mt">Backup server URL:</label>
       <div class="readonly-box"><code>${esc(stream.backupIngestionAddress)}</code>
       <button class="btn btn-sm" data-copy="${esc(stream.backupIngestionAddress)}">Copy</button></div>`
    : '';

  return `<label>Stream key (in ATEM):</label>
    <div class="readonly-box"><code>${esc(stream.streamName || '')}</code>
    <button class="btn btn-sm" data-copy="${esc(stream.streamName || '')}">Copy</button></div>
    <label class="mt">Server URL:</label>
    <div class="readonly-box"><code>${esc(stream.ingestionAddress || '')}</code>
    <button class="btn btn-sm" data-copy="${esc(stream.ingestionAddress || '')}">Copy</button></div>
    ${backup}
    <p class="hint">These hide again when you leave this page.</p>`;
}

function protectedHtml() {
  return `<p class="stream-key-masked">Stream key and server URL are hidden.</p>
    <button type="button" class="btn btn-outline btn-sm" id="btnRevealStream">Show stream key…</button>`;
}

const REVEAL_ENDPOINTS = {
  youtube: '/api/settings/youtube/reveal-stream',
  restream: '/api/settings/restream/reveal-stream',
};

function wireCopyButtons(container) {
  container.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      const ok = await copyToClipboard(btn.getAttribute('data-copy'));
      toast(ok ? 'Copied.' : 'Copy manually.', ok ? 'ok' : 'err');
    };
  });
}

async function promptPassword(provider = 'youtube') {
  const { modal } = await import('./ui.js');
  const endpoint = REVEAL_ENDPOINTS[provider] || REVEAL_ENDPOINTS.youtube;
  return modal((close) => {
    const el = h(`<div>
      <h2>Enter your password</h2>
      <p class="muted">Confirm your identity to view the ATEM stream key and server URL.</p>
      <div class="field">
        <label for="revealPw">Your password</label>
        <input type="password" id="revealPw" autocomplete="current-password" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancel">Cancel</button>
        <button type="button" class="btn" id="ok">Show</button>
      </div>
    </div>`);
    const input = el.querySelector('#revealPw');
    input.focus();
    el.querySelector('#cancel').onclick = () => close(null);
    el.querySelector('#ok').onclick = async (e) => {
      const password = input.value;
      if (!password) return toast('Enter your password.', 'err');
      busy(e.target, true);
      const res = await api.post(endpoint, { password });
      busy(e.target, false, 'Show');
      if (!res.ok) return toast(res.error, 'err');
      close(res.data.stream);
    };
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') el.querySelector('#ok').click();
    };
    return el;
  });
}

/** Hidden placeholder + reveal button when a stream key exists. */
export function mountProtectedStreamKey(panel, { provider = 'youtube' } = {}) {
  if (!panel) return;
  panel.innerHTML = protectedHtml();
  panel.querySelector('#btnRevealStream').onclick = async () => {
    const stream = await promptPassword(provider);
    if (stream) showRevealedStreamKey(panel, stream);
  };
}

/** Show stream key / server fields (after password or right after create). */
export function showRevealedStreamKey(panel, stream) {
  if (!panel || !stream) return;
  panel.innerHTML = revealedHtml(stream);
  wireCopyButtons(panel);
}
