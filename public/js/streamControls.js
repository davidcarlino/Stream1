import { api } from './api.js';
import { confirmDialog, toast } from './ui.js';

const ENDED = new Set(['complete', 'revoked']);
const ON_AIR = new Set(['live', 'liveStarting', 'testStarting', 'testing']);

export function canStartStream(row) {
  const lc = row.lifeCycleStatus || '';
  if (ENDED.has(lc) || row.localOnly) return false;
  return lc !== 'live' && row.statusLabel !== 'Live';
}

export function canStopStream(row) {
  const lc = row.lifeCycleStatus || '';
  if (ENDED.has(lc) || row.localOnly) return false;
  return ON_AIR.has(lc) || row.statusLabel === 'Live' || row.statusLabel === 'Starting…';
}

export function isActiveStreamTarget(row, activeBroadcastId) {
  if (!activeBroadcastId) return false;
  return row.broadcastId === activeBroadcastId;
}

export async function startStreamBroadcast(broadcastId) {
  return api.post(`/api/streams/${encodeURIComponent(broadcastId)}/go-live`);
}

export async function stopStreamBroadcast(broadcastId, title) {
  const ok = await confirmDialog(
    'Stop stream',
    `Stop streaming to "${title || 'this broadcast'}" on YouTube? The Streamer can keep sending — this only ends the YouTube event.`,
    { danger: true, confirmText: 'Yes, stop stream' }
  );
  if (!ok) return { ok: false, cancelled: true };
  return api.post(`/api/streams/${encodeURIComponent(broadcastId)}/stop`);
}

export async function wireStreamControl(btn, { broadcastId, title, onDone, busyFn }) {
  btn.onclick = async () => {
    const act = btn.getAttribute('data-act');
    busyFn(btn, true);
    const res =
      act === 'go-live'
        ? await startStreamBroadcast(broadcastId)
        : await stopStreamBroadcast(broadcastId, title);
    busyFn(btn, false, btn.getAttribute('data-label') || btn.textContent);
    if (res.cancelled) return;
    if (!res.ok) return toast(res.error, 'err');
    toast(
      act === 'go-live'
        ? `Streaming to "${title || 'broadcast'}".`
        : `Stopped "${title || 'broadcast'}".`,
      'ok'
    );
    if (onDone) onDone();
  };
}
