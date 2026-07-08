import { api } from '../api.js';
import { h, esc } from '../ui.js';
import { youtubeEmbedIframeHtml } from '../youtubeEmbed.js';

let pollId = null;

function stopPoll() {
  if (pollId) {
    clearInterval(pollId);
    pollId = null;
  }
}

function ingestLabel(status) {
  switch (status) {
    case 'active':
      return { text: 'Receiving video from Streamer', cls: 'ok' };
    case 'created':
      return { text: 'Stream ready — waiting for Streamer', cls: 'warn' };
    case 'inactive':
      return { text: 'No signal from Streamer', cls: 'muted' };
    default:
      return { text: status || 'Unknown', cls: 'muted' };
  }
}

const PREVIEWABLE_STATES = new Set(['live', 'liveStarting', 'testStarting', 'testing', 'ready']);

function hasEmbedPreview(preview, data) {
  if (!preview || !preview.broadcastId) return false;
  if (PREVIEWABLE_STATES.has(preview.lifeCycleStatus)) return true;
  if (preview.viaRestream && data && data.restream && data.restream.live) return true;
  if (data && data.restream && data.restream.live) return true;
  return false;
}

function fmtLogTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour12: false });
}

/** Console log panel for the Facebook simulcast (shown when there is activity). */
function simulcastLogHtml(data) {
  const entries = data.simulcastLog || [];
  const fb = data.facebook || {};
  if (!entries.length && !fb.relayRunning && !fb.activeLiveVideoId) return '';

  const lines = entries.length
    ? entries
        .map(
          (e) =>
            `<div class="simulcast-log-line log-${esc(e.level || 'info')}"><span class="log-time">${esc(fmtLogTime(e.at))}</span>${esc(e.message)}</div>`
        )
        .join('')
    : '<div class="simulcast-log-line log-info">No simulcast activity yet.</div>';

  return `<div class="card section">
      <div class="stream-test-head">
        <h2>Simulcast console</h2>
        <span class="badge ${fb.relayRunning ? 'badge-live' : 'badge-private'}">${fb.relayRunning ? '● Relaying to Facebook' : 'Relay idle'}</span>
      </div>
      <div class="simulcast-log">${lines}</div>
    </div>`;
}

function facebookLiveLink(data, preview) {
  const fb = data.facebook || {};
  return (preview && preview.facebookPermalink) || fb.activeLiveVideoUrl || null;
}

function pickEmbedPreview(data) {
  const rs = data.restreamPreview;
  if (rs && rs.youtubeVideoId && data.restream && data.restream.live) {
    return {
      broadcastId: rs.youtubeVideoId,
      title: rs.title,
      lifeCycleStatus: rs.lifeCycleStatus || 'live',
      statusLabel: 'Live',
      watchUrl: rs.watchUrl || `https://www.youtube.com/watch?v=${rs.youtubeVideoId}`,
      viaRestream: true,
    };
  }
  if (hasEmbedPreview(data.preview, data)) return data.preview;
  if (hasEmbedPreview(data.live, data)) return data.live;
  return null;
}

function paintMonitor(node, data) {
  const ingest = data.ingest || {};
  const live = data.live;
  const preview = pickEmbedPreview(data);
  const broadcast = live || preview || data.preview;
  const ingestInfo = ingestLabel(ingest.streamStatus);

  const previewSection = hasEmbedPreview(preview, data)
    ? `<div class="card section stream-test-preview">
        <div class="stream-test-head">
          <h2>Stream preview</h2>
          <span class="badge badge-live">● ${esc(preview.statusLabel || 'Live')}</span>
        </div>
        ${youtubeEmbedIframeHtml(preview.broadcastId, { autoplay: true })}
        <div class="stream-test-broadcast-name">
          <p class="stream-test-broadcast-label">Current broadcast</p>
          <p class="stream-test-broadcast-title">${esc(preview.title || 'Untitled broadcast')}</p>
          ${preview.templateName ? `<p class="stream-test-broadcast-template">Template: ${esc(preview.templateName)}</p>` : ''}
          <p class="muted stream-test-broadcast-meta">
            ${preview.actualStartTime
              ? `Started ${esc(fmtWhen(preview.actualStartTime))}`
              : preview.scheduledStartTime
                ? `Scheduled ${esc(fmtWhen(preview.scheduledStartTime))}`
                : ''}
            ${preview.privacy ? `${preview.actualStartTime || preview.scheduledStartTime ? ' · ' : ''}${esc(preview.privacy)}` : ''}
          </p>
        </div>
        <div class="btn-row mt stream-test-controls">
          <a class="btn btn-outline btn-sm" href="${esc(preview.watchUrl)}" target="_blank" rel="noopener">View live in YouTube</a>
          ${facebookLiveLink(data, preview)
            ? `<a class="btn btn-outline btn-sm" href="${esc(facebookLiveLink(data, preview))}" target="_blank" rel="noopener">View live in Facebook</a>`
            : ''}
        </div>
      </div>`
    : `<div class="card section center stream-test-preview-empty">
        <h2>No preview available</h2>
        <p class="muted">${data.restream && data.restream.live && data.restreamPreview && !data.restreamPreview.youtubeVideoId
          ? 'Restream is live — waiting for the YouTube watch link (usually within a minute). Refresh to check again.'
          : ingest.streamStatus === 'active' || (data.restream && data.restream.live)
          ? 'Streamer is sending — pick a broadcast below or create one from New Stream.'
          : 'When the Streamer is sending and a broadcast is active, the live preview will appear here.'}</p>
        ${data.recent && !hasEmbedPreview(preview, data)
          ? `<div class="stream-test-recent mt">
              <p><strong>Latest broadcast:</strong> ${esc(data.recent.title || '(untitled)')} — ${esc(data.recent.statusLabel || '')}</p>
            </div>`
          : ''}
      </div>`;

  const fb = data.facebook || {};
  const fbValue = !fb.connected
    ? 'Not connected'
    : fb.relayRunning
      ? 'Live — relaying'
      : fb.activeLiveVideoId
        ? 'Live video created'
        : 'Idle';
  const fbHint = !fb.connected
    ? 'Connect Facebook in Settings to simulcast.'
    : fb.relayRunning
      ? `Streaming to ${fb.pageName || 'the connected page'}.`
      : fb.pageName
        ? `Ready — streams marked "Facebook" post to ${fb.pageName}.`
        : 'Pick a Facebook page in Settings.';

  const rs = data.restream || {};
  const restreamIngestCard = `<section class="card stream-test-stat">
        <h3>Streamer → Restream</h3>
        <p class="stream-test-value ${rs.live ? 'ok' : rs.connected ? 'muted' : 'warn'}">${!rs.connected
          ? 'Not connected'
          : rs.live
            ? 'Live — Restream is receiving'
            : rs.live === false
              ? 'No signal from Streamer'
              : 'Status unknown'}</p>
        <p class="hint">${!rs.connected
          ? 'Reconnect Restream in Settings.'
          : rs.live
            ? 'Restream is sending the feed to the chosen destinations.'
            : rs.pendingCount > 0
              ? `${rs.pendingCount} event${rs.pendingCount === 1 ? '' : 's'} ready — start the Streamer to go live.`
              : 'Start the Streamer (pointed at the Restream stream key) to go live.'}</p>
      </section>`;

  const youtubeIngestCard = `<section class="card stream-test-stat">
        <h3>Streamer → YouTube</h3>
        <p class="stream-test-value ${ingestInfo.cls}">${esc(ingestInfo.text)}</p>
        <p class="hint">${ingest.streamStatus === 'active'
          ? 'YouTube is receiving your encoder feed.'
          : 'Start streaming from the Streamer, or check the stream key in Settings.'}</p>
      </section>`;

  node.querySelector('#monitorBody').innerHTML = `
    <div class="status-grid stream-test-grid">
      ${rs.enabled ? restreamIngestCard : youtubeIngestCard}
      <section class="card stream-test-stat">
        <h3>YouTube broadcast</h3>
        <p class="stream-test-value">${broadcast ? esc(broadcast.statusLabel) : 'None active'}</p>
        <p class="hint">${broadcast ? esc(broadcast.title || '') : 'Create a stream from New Stream before going live.'}</p>
      </section>
      ${rs.enabled ? '' : `<section class="card stream-test-stat">
        <h3>Facebook simulcast</h3>
        <p class="stream-test-value ${fb.relayRunning ? 'ok' : 'muted'}">${esc(fbValue)}</p>
        <p class="hint">${esc(fbHint)}</p>
      </section>`}
    </div>
    ${previewSection}
    ${simulcastLogHtml(data)}`;
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

async function refresh(node) {
  const res = await api.get('/api/streams/monitor/live');
  const body = node.querySelector('#monitorBody');
  if (!res.ok) {
    body.innerHTML = `<div class="card"><p>${esc(res.error)}</p></div>`;
    return;
  }
  paintMonitor(node, res.data);
}

export async function renderStreamTest() {
  stopPoll();

  const node = h(`<div class="stream-test-page">
    <h1>Stream Test</h1>
    <p class="subtitle">Live view — confirm Streamer is sending and YouTube is showing the right title.</p>
    <div class="btn-row mb">
      <button class="btn btn-outline btn-sm" id="refreshMonitor">Refresh now</button>
      <span class="muted" style="align-self:center;font-size:0.9rem">Updates every 10 seconds</span>
    </div>
    <div id="monitorBody"><p class="muted">Loading…</p></div>
  </div>`);

  node.querySelector('#refreshMonitor').onclick = () => refresh(node);
  await refresh(node);
  pollId = setInterval(() => refresh(node), 10000);

  return node;
}

export function teardownStreamTest() {
  stopPoll();
}
