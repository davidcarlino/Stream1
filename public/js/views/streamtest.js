import { api } from '../api.js';
import { h, esc, toast, copyToClipboard } from '../ui.js';
import { youtubeEmbedIframeHtml } from '../youtubeEmbed.js';

let pollId = null;
/** Invalidates in-flight refresh / poll start when leaving Stream Test. */
let viewGen = 0;

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
    const fromPreview = data.preview && data.preview.broadcastId === rs.youtubeVideoId
      ? data.preview
      : null;
    return {
      broadcastId: rs.youtubeVideoId,
      title: (fromPreview && fromPreview.title) || rs.title,
      templateName: fromPreview && fromPreview.templateName,
      lifeCycleStatus: rs.lifeCycleStatus || 'live',
      statusLabel: 'Live',
      watchUrl: rs.watchUrl || `https://www.youtube.com/watch?v=${rs.youtubeVideoId}`,
      viaRestream: true,
      scheduledStartTime: fromPreview && fromPreview.scheduledStartTime,
      actualStartTime: fromPreview && fromPreview.actualStartTime,
      privacy: fromPreview && fromPreview.privacy,
      facebookPermalink: fromPreview && fromPreview.facebookPermalink,
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
          ${preview.viaRestream || (data.restream && data.restream.enabled)
            ? `<p class="stream-test-broadcast-title">${esc(preview.title || 'Untitled event')}</p>
               <p class="stream-test-broadcast-via">Feed via Restream</p>`
            : `<p class="stream-test-broadcast-label">Current broadcast</p>
               <p class="stream-test-broadcast-title">${esc(preview.title || 'Untitled broadcast')}</p>`}
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
      </div>
      ${upcomingTableHtml(data, { belowPreview: true })}`
    : `<div class="stream-test-empty-row">
        <div class="card section center stream-test-preview-empty">
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
        </div>
        ${upcomingTableHtml(data)}
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

  wireUpcomingCopyLinks(node);
}

function wireUpcomingCopyLinks(node) {
  node.querySelectorAll('[data-copy-url]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = el.getAttribute('data-copy-url');
      if (!url) return;
      const ok = await copyToClipboard(url);
      toast(ok ? 'Link copied' : 'Could not copy link', ok ? 'ok' : 'err');
    });
  });
  node.querySelectorAll('[data-copy-pending]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      toast('YouTube link will appear once this stream goes live.', 'warn');
    });
  });
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtStartTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

const YT_ICON = `<svg class="st-dest-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#ff0000" d="M19.615 3.184c-3.604-.246-11.631-.245-15.23 0-3.897.266-4.356 2.62-4.385 8.816.029 6.185.484 8.549 4.385 8.816 3.6.245 11.626.246 15.23 0 3.897-.266 4.356-2.62 4.385-8.816-.029-6.185-.484-8.549-4.385-8.816zm-10.615 12.816v-8l6.425 4-6.425 4z"/></svg>`;
const FB_ICON = `<svg class="st-dest-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#1877f2" d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg>`;

function privacyLabel(privacy) {
  const p = String(privacy || '').toLowerCase();
  if (p === 'unlisted') return 'Private Link';
  if (p === 'private') return 'Private';
  if (p === 'public') return 'Public';
  return '';
}

function privacyLinkHtml(privacy, watchUrl) {
  const label = privacyLabel(privacy);
  if (!label) return '';
  const kind = String(privacy || '').toLowerCase();
  // Always look like a blue hyperlink. Copy when a watch URL exists; otherwise explain.
  if (watchUrl) {
    return `<button type="button" class="st-privacy st-privacy-link st-privacy-${esc(kind)}"
      data-copy-url="${esc(watchUrl)}"
      title="Click to copy YouTube link">${esc(label)}</button>`;
  }
  return `<button type="button" class="st-privacy st-privacy-link st-privacy-pending st-privacy-${esc(kind)}"
    data-copy-pending="1"
    title="YouTube link appears after this stream goes live">${esc(label)}</button>`;
}

function destIconsHtml(streamTo, privacy, watchUrl, facebookPermalink) {
  const to = streamTo || {};
  const parts = [];
  if (to.youtube !== false) {
    if (watchUrl) {
      parts.push(
        `<a class="st-dest st-dest-link" href="${esc(watchUrl)}" target="_blank" rel="noopener" title="Open on YouTube">${YT_ICON}<span class="sr-only">YouTube</span></a>`
      );
    } else {
      parts.push(
        `<span class="st-dest st-dest-disabled" title="YouTube link appears after go-live">${YT_ICON}<span class="sr-only">YouTube</span></span>`
      );
    }
  }
  if (to.facebook) {
    if (facebookPermalink) {
      parts.push(
        `<a class="st-dest st-dest-link" href="${esc(facebookPermalink)}" target="_blank" rel="noopener" title="Open on Facebook">${FB_ICON}<span class="sr-only">Facebook</span></a>`
      );
    } else {
      parts.push(
        `<span class="st-dest st-dest-disabled" title="Facebook link appears after go-live">${FB_ICON}<span class="sr-only">Facebook</span></span>`
      );
    }
  }
  const privacyHtml = privacyLinkHtml(privacy, watchUrl);
  if (!parts.length && !privacyHtml) return '<span class="muted">—</span>';
  return `<span class="st-dests">${parts.join('')}${privacyHtml}</span>`;
}

function upcomingTableHtml(data, { belowPreview = false } = {}) {
  const rows = Array.isArray(data.upcoming) ? data.upcoming : [];
  const extraClass = belowPreview ? ' stream-test-upcoming-below' : '';
  if (!rows.length) {
    return `<div class="card section stream-test-upcoming${extraClass}">
      <h2>Next streams</h2>
      <p class="muted">No upcoming streams. Create one from New Stream.</p>
    </div>`;
  }

  const body = rows
    .map((s) => {
      const armed = s.armed
        ? '<span class="badge badge-live st-armed">Next</span>'
        : '';
      return `<tr class="${s.armed ? 'st-row-armed' : ''}">
        <td class="st-col-title">
          <div class="st-up-title">${esc(s.title || 'Untitled')}${armed}</div>
          ${s.templateName ? `<div class="st-up-tpl muted">${esc(s.templateName)}</div>` : ''}
        </td>
        <td class="st-col-dest">${destIconsHtml(s.streamTo, s.privacy, s.watchUrl, s.facebookPermalink)}</td>
        <td class="st-col-time">${esc(fmtStartTime(s.scheduledStartTime))}</td>
      </tr>`;
    })
    .join('');

  return `<div class="card section stream-test-upcoming${extraClass}">
    <h2>Next streams</h2>
    <table class="st-upcoming-table">
      <thead>
        <tr>
          <th>Event</th>
          <th>To</th>
          <th>Starts</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}

async function refresh(node) {
  const res = await api.get('/api/streams/monitor/live');
  if (!node.isConnected) return;
  const body = node.querySelector('#monitorBody');
  if (!body) return;
  if (!res.ok) {
    body.innerHTML = `<div class="card"><p>${esc(res.error)}</p></div>`;
    return;
  }
  paintMonitor(node, res.data);
}

export async function renderStreamTest() {
  stopPoll();
  const gen = ++viewGen;

  const node = h(`<div class="stream-test-page">
    <h1>Stream Test</h1>
    <p class="subtitle">Live view — confirm Streamer is sending and YouTube is showing the right title.</p>
    <div class="btn-row mb">
      <button class="btn btn-outline btn-sm" id="refreshMonitor">Refresh now</button>
      <span class="muted" style="align-self:center;font-size:0.9rem">Updates every 10 seconds</span>
    </div>
    <div id="monitorBody"><p class="muted">Loading…</p></div>
  </div>`);

  node.querySelector('#refreshMonitor').onclick = () => {
    if (gen === viewGen) refresh(node);
  };

  // Mount the page shell immediately — /monitor/live can take several seconds
  // (Restream + YouTube). Do not block navigation on that fetch.
  void (async () => {
    await refresh(node);
    if (gen !== viewGen) return;
    pollId = setInterval(() => {
      if (gen !== viewGen) {
        stopPoll();
        return;
      }
      refresh(node);
    }, 10000);
  })();

  return node;
}

export function teardownStreamTest() {
  viewGen += 1;
  stopPoll();
}
