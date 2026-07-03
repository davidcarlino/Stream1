import { api } from '../api.js';
import { h, esc, toast, copyToClipboard, confirmDialog, busy } from '../ui.js';
import { shareWatchBlock } from '../shareLink.js';
import { openStreamEmail } from '../shareEmail.js';
import { youtubeEmbedIframeHtml } from '../youtubeEmbed.js';
import {
  canStartStream,
  canStopStream,
  isActiveStreamTarget,
  wireStreamControl,
} from '../streamControls.js';
import { downloadStreamRecording } from '../streamDownload.js';

function privacyBadge(p) {
  const cls = { public: 'badge-public', unlisted: 'badge-unlisted', private: 'badge-private' }[p] || 'badge-private';
  return `<span class="badge ${cls}">${esc((p || 'private')[0].toUpperCase() + (p || 'private').slice(1))}</span>`;
}
function statusBadge(row) {
  const label = row.statusLabel || 'Ended';
  const cls = label === 'Live' ? 'badge-live' : label === 'Upcoming' ? 'badge-upcoming' : label === 'Starting…' ? 'badge-warn' : 'badge-ended';
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}
function fmtDate(row) {
  const iso = row.actualStartTime || row.scheduledStartTime;
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function streamWhen(s) {
  return new Date(s.scheduledStartTime || s.actualStartTime || 0).getTime() || 0;
}

function isPastStream(s) {
  const lc = s.lifeCycleStatus || '';
  if (lc === 'complete' || lc === 'revoked') return true;
  if (s.statusLabel === 'Ended' || s.localOnly) return true;
  return false;
}

function upcomingRank(s) {
  const lc = s.lifeCycleStatus || '';
  if (lc === 'live') return 0;
  if (lc === 'liveStarting' || lc === 'testStarting' || lc === 'testing') return 1;
  return 2;
}

function sortUpcoming(a, b) {
  const rank = upcomingRank(a) - upcomingRank(b);
  if (rank !== 0) return rank;
  return streamWhen(a) - streamWhen(b);
}

function sortPast(a, b) {
  return streamWhen(b) - streamWhen(a);
}

function isUpcomingStream(s) {
  return !isPastStream(s);
}

function filterLabel(filter) {
  if (filter === 'upcoming') return 'Upcoming only';
  if (filter === 'past') return 'Past only';
  return 'All';
}

function matchesSearch(s, q) {
  if (!q) return true;
  const hay = `${s.title || ''} ${s.templateName || ''}`.toLowerCase();
  return hay.includes(q);
}

export async function renderHistory(ctx = {}) {
  const isAdmin = ctx.state && ctx.state.user && ctx.state.user.role === 'admin';
  const node = h('<div></div>');
  node._streamsState = { filter: 'all', search: '', streams: [], activeBroadcastId: null };
  await load(node, false, isAdmin);
  return node;
}

async function load(node, forceRefresh, isAdmin) {
  node.innerHTML = `<h1>Streams</h1>
    <p class="subtitle">Upcoming and past broadcasts. Use <strong>Start stream</strong> to send the Streamer feed to the event you chose.</p>
    <div class="streams-toolbar">
      <input type="search" class="streams-search" id="search" placeholder="Search by title or template…" aria-label="Search streams" />
      <div class="streams-toolbar-actions">
        <div class="segmented streams-filter" id="filter" role="group" aria-label="Filter streams">
          <button type="button" data-filter="all" class="active">All</button>
          <button type="button" data-filter="upcoming">Upcoming</button>
          <button type="button" data-filter="past">Past</button>
        </div>
        <button class="btn btn-outline btn-sm" id="refresh">Refresh</button>
      </div>
    </div>
    <div id="rows"><p class="muted">Loading…</p></div>`;

  const state = node._streamsState;
  node.querySelector('#refresh').onclick = () => load(node, true, isAdmin);
  node.querySelector('#search').value = state.search;
  node.querySelector('#search').oninput = (e) => {
    state.search = e.target.value.trim().toLowerCase();
    paintStreams(node, isAdmin);
  };
  node.querySelectorAll('#filter button').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === state.filter);
    btn.onclick = () => {
      state.filter = btn.getAttribute('data-filter');
      node.querySelectorAll('#filter button').forEach((b) => b.classList.toggle('active', b === btn));
      paintStreams(node, isAdmin);
    };
  });

  const res = await api.get('/api/streams' + (forceRefresh ? '?refresh=1' : ''));
  const rows = node.querySelector('#rows');
  if (!res.ok) {
    rows.innerHTML = `<div class="card"><p>${esc(res.error)}</p></div>`;
    return;
  }
  state.streams = res.data.streams || [];
  state.activeBroadcastId = res.data.activeBroadcastId || null;
  paintStreams(node, isAdmin);
}

function paintStreams(node, isAdmin) {
  const state = node._streamsState;
  const rows = node.querySelector('#rows');
  const q = state.search;

  let upcoming = state.streams.filter((s) => isUpcomingStream(s) && matchesSearch(s, q));
  let past = state.streams.filter((s) => isPastStream(s) && matchesSearch(s, q));

  upcoming.sort(sortUpcoming);
  past.sort(sortPast);

  const showUpcoming = state.filter !== 'past';
  const showPast = state.filter !== 'upcoming';

  if (state.filter === 'upcoming') past = [];
  else if (state.filter === 'past') upcoming = [];

  rows.innerHTML = '';

  const visibleUpcoming = showUpcoming ? upcoming : [];
  const visiblePast = showPast ? past : [];

  if (visibleUpcoming.length === 0 && visiblePast.length === 0) {
    const filterNote = state.filter !== 'all' ? ` (${filterLabel(state.filter).toLowerCase()})` : '';
    rows.innerHTML = `<div class="card center"><p class="muted">${state.streams.length === 0
      ? 'No streams yet. Create one from "New Stream".'
      : `No streams match your search${filterNote}.`}</p></div>`;
    return;
  }

  if (visibleUpcoming.length > 0) {
    rows.appendChild(sectionBlock('Upcoming streams', 'Soonest first', visibleUpcoming, node, isAdmin, state.activeBroadcastId));
  }

  if (visiblePast.length > 0) {
    rows.appendChild(sectionBlock('Past streams', 'Newest first', visiblePast, node, isAdmin, state.activeBroadcastId, visibleUpcoming.length > 0));
  }
}

function sectionBlock(title, hint, items, node, isAdmin, activeBroadcastId, spaced = false) {
  const block = h(`<section class="streams-block${spaced ? ' streams-block-spaced' : ''}">
    <header class="streams-block-header">
      <h2 class="section-title">${esc(title)} <span class="section-count">${items.length}</span></h2>
      <p class="section-hint muted">${esc(hint)}</p>
    </header>
    <div class="streams-section"></div>
  </section>`);
  const wrap = block.querySelector('.streams-section');
  items.forEach((s) => wrap.appendChild(rowEl(s, node, isAdmin, activeBroadcastId)));
  return block;
}

function rowEl(s, node, isAdmin, activeBroadcastId) {
  const pending = Boolean(s.restreamPending);
  const showStart = !pending && canStartStream(s);
  const showStop = !pending && canStopStream(s);
  const isTarget = isActiveStreamTarget(s, activeBroadcastId) || s.statusLabel === 'Live';

  const thumb = s.thumbnail
    ? `<img class="stream-thumb" src="${esc(s.thumbnail)}" alt="" />`
    : `<div class="stream-thumb"></div>`;

  const row = h(`<div class="stream-row${isTarget ? ' stream-row-active' : ''}" data-id="${esc(s.broadcastId)}">
    ${thumb}
    <div class="stream-main">
      <p class="stream-title">${esc(s.title || '(untitled)')}</p>
      <div class="stream-meta">
        ${statusBadge(s)} ${privacyBadge(s.privacy)}
        <span>${esc(fmtDate(s))}</span>
        ${s.templateName ? `<span>· ${esc(s.templateName)}</span>` : ''}
        ${pending ? '<span class="badge badge-upcoming">Restream — goes live when ATEM starts</span>' : ''}
        ${isTarget ? '<span class="badge badge-live">On air target</span>' : ''}
        ${s.stuck ? '<span class="badge badge-warn">Stuck — may need recreating</span>' : ''}
      </div>
      <div class="stream-actions mt">
        ${showStart ? '<button class="btn btn-sm btn-go-live" data-act="go-live" data-label="Start stream">Start stream</button>' : ''}
        ${showStop ? '<button class="btn btn-sm btn-danger" data-act="stop" data-label="Stop stream">Stop stream</button>' : ''}
        ${pending ? '' : '<button class="btn btn-sm" data-act="play">Play</button>'}
        ${pending ? '' : '<button class="btn btn-sm btn-outline" data-act="share">Share</button>'}
        ${!pending && isAdmin ? '<button class="btn btn-sm btn-outline" data-act="privacy">Privacy</button>' : ''}
        ${!pending && isPastStream(s) ? '<button class="btn btn-sm btn-outline" data-act="download">Download</button>' : ''}
        ${isAdmin && s.stuck ? '<button class="btn btn-sm btn-danger" data-act="recreate">Cancel &amp; Recreate</button>' : ''}
        ${pending && isAdmin ? '<button class="btn btn-sm btn-danger" data-act="cancel-pending">Cancel event</button>' : ''}
      </div>
      <div class="player-slot"></div>
    </div>
  </div>`);

  const slot = row.querySelector('.player-slot');

  const playBtn = row.querySelector('[data-act="play"]');
  if (playBtn) {
    playBtn.onclick = () => {
      if (slot.innerHTML) { slot.innerHTML = ''; return; }
      const videoId = s.videoId || s.broadcastId;
      slot.innerHTML = youtubeEmbedIframeHtml(videoId, { autoplay: true });
    };
  }

  const cancelPending = row.querySelector('[data-act="cancel-pending"]');
  if (cancelPending) {
    cancelPending.onclick = async () => {
      const ok = await confirmDialog('Cancel event', `Remove "${s.title || 'this event'}"? Nothing has been created on YouTube yet.`, { danger: true, confirmText: 'Remove' });
      if (!ok) return;
      const res = await api.del(`/api/streams/${encodeURIComponent(s.broadcastId)}`);
      if (!res.ok) return toast(res.error, 'err');
      toast('Event removed.', 'ok');
      load(node, true, isAdmin);
    };
  }

  const shareBtn = row.querySelector('[data-act="share"]');
  if (shareBtn) shareBtn.onclick = () => sharePanel(s);
  const downloadBtn = row.querySelector('[data-act="download"]');
  if (downloadBtn) {
    downloadBtn.onclick = () => downloadStreamRecording(s, { busyTarget: downloadBtn });
  }
  row.querySelectorAll('[data-act="go-live"], [data-act="stop"]').forEach((btn) => {
    wireStreamControl(btn, {
      broadcastId: s.broadcastId,
      title: s.title,
      onDone: () => load(node, true, isAdmin),
      busyFn: busy,
    });
  });
  const privacyBtn = row.querySelector('[data-act="privacy"]');
  if (privacyBtn) privacyBtn.onclick = () => privacyPanel(s, node, isAdmin);

  const recreate = row.querySelector('[data-act="recreate"]');
  if (recreate) {
    recreate.onclick = async () => {
      const ok = await confirmDialog(
        'Cancel & Recreate',
        'This deletes the stuck broadcast and creates a fresh one bound to the same stream key. ATEM does not need changing.',
        { danger: true, confirmText: 'Recreate' }
      );
      if (!ok) return;
      const res = await api.del(`/api/streams/${encodeURIComponent(s.broadcastId)}?recreate=1`);
      if (!res.ok) return toast(res.error, 'err');
      toast('Recreated. Ready to stream.', 'ok');
      load(node, true, isAdmin);
    };
  }

  return row;
}

function sharePanel(s) {
  import('../ui.js').then(({ modal }) => {
    modal((close) => {
      const el = h(`<div>
        <h2>Share</h2>
        <p class="muted">Send this link to whoever should watch. Unlisted links work without a Google account.</p>
        ${shareWatchBlock(s.watchUrl, { copyId: 'copy' })}
        <div class="btn-row mt">
          <button type="button" class="btn btn-outline" id="emailBtn">Email</button>
          <a class="btn btn-outline" href="sms:?&body=${encodeURIComponent((s.title ? s.title + ' — ' : '') + s.watchUrl)}">Text</a>
          <button class="btn" id="done">Done</button>
        </div>
      </div>`);
      el.querySelector('#copy').onclick = async () => {
        const ok = await copyToClipboard(s.watchUrl);
        toast(ok ? 'Copied.' : 'Copy manually.', ok ? 'ok' : 'err');
      };
      el.querySelector('#emailBtn').onclick = () => openStreamEmail(s);
      el.querySelector('#done').onclick = () => close(true);
      if (navigator.share) {
        const btn = h('<button class="btn btn-outline">More…</button>');
        btn.onclick = () => navigator.share({ title: s.title || 'Live stream', url: s.watchUrl }).catch(() => {});
        el.querySelector('.btn-row').insertBefore(btn, el.querySelector('#done'));
      }
      return el;
    });
  });
}

function privacyPanel(s, node, isAdmin) {
  import('../ui.js').then(({ modal }) => {
    modal((close) => {
      const el = h(`<div>
        <h2>Change privacy</h2>
        <p class="muted">Update who can see "${esc(s.title || 'this stream')}".</p>
        <div class="segmented" id="pv">
          ${['public','unlisted','private'].map((p) => `<button data-p="${p}" class="${p === s.privacy ? 'active' : ''}">${p[0].toUpperCase()+p.slice(1)}</button>`).join('')}
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="cancel">Cancel</button>
          <button class="btn" id="save">Save</button>
        </div>
      </div>`);
      let choice = s.privacy;
      el.querySelectorAll('#pv button').forEach((b) => {
        b.onclick = () => { choice = b.getAttribute('data-p'); el.querySelectorAll('#pv button').forEach((x) => x.classList.toggle('active', x === b)); };
      });
      el.querySelector('#cancel').onclick = () => close(false);
      el.querySelector('#save').onclick = async (e) => {
        busy(e.target, true);
        const res = await api.put(`/api/streams/${encodeURIComponent(s.broadcastId)}/privacy`, { privacy: choice });
        busy(e.target, false, 'Save');
        if (!res.ok) return toast(res.error, 'err');
        toast('Privacy updated.', 'ok');
        close(true);
        load(node, true, isAdmin);
      };
      return el;
    });
  });
}
