import { esc } from './ui.js';

/** Link row + optional QR for a YouTube watch URL. */
export function shareWatchBlock(watchUrl, { copyId = 'copyLink', showQr = true } = {}) {
  const qr = showQr
    ? `<div class="share-qr">
        <img class="share-qr-img" src="/api/qr?url=${encodeURIComponent(watchUrl)}" width="220" height="220" alt="QR code — scan to open on YouTube" />
        <p class="hint share-qr-hint">Scan with a phone camera to open on YouTube</p>
      </div>`
    : '';

  return `${qr}
    <div class="readonly-box"><code>${esc(watchUrl)}</code><button class="btn btn-sm" id="${esc(copyId)}">Copy link</button></div>`;
}
