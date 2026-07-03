'use strict';

/**
 * Restream-mode stream lifecycle.
 *
 * Create: resolve the template as usual, push title/description to each
 * Restream destination (channel meta) and enable/disable YouTube/Facebook
 * channels to match the event's "stream to" choice. Restream creates the
 * actual platform broadcasts when ATEM starts pushing.
 *
 * Link (hybrid): YouTube stays connected for metadata. Once Restream has
 * created the YouTube broadcast, `linkPendingStreams` finds it (by title,
 * newest first), attaches it to the local record, and applies the template
 * extras Restream can't set: playlist, thumbnail, per-event privacy.
 */

const store = require('./store');
const restream = require('./restream');
const youtube = require('./youtube');
const coverImages = require('./coverImages');
const simulcastLog = require('./simulcastLog');

const LINKABLE_STATES = new Set(['live', 'liveStarting', 'testStarting', 'testing', 'ready', 'created', 'complete']);
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // stop matching week-old records

function pendingCoverKey(recordId) {
  return `stream-${recordId}`;
}

/**
 * Configure Restream destinations for an event: set titles/descriptions and
 * toggle YouTube/Facebook channels to match `streamTo`.
 * Returns { channels, warnings } — throws only if Restream is unreachable.
 */
async function configureDestinations({ title, description, streamTo }) {
  const channels = await restream.listChannels();
  await store.updateSettings({
    restream: { channels, channelsRefreshedAt: new Date() },
  });

  const warnings = [];
  const youtubeChannels = channels.filter(restream.isYouTubeChannel);
  const facebookChannels = channels.filter(restream.isFacebookChannel);

  if (streamTo.youtube && youtubeChannels.length === 0) {
    warnings.push('No YouTube destination is connected in Restream — add it in the Restream dashboard.');
  }
  if (streamTo.facebook && facebookChannels.length === 0) {
    warnings.push('No Facebook destination is connected in Restream — add it in the Restream dashboard.');
  }

  for (const channel of channels) {
    const isYt = restream.isYouTubeChannel(channel);
    const isFb = restream.isFacebookChannel(channel);
    if (!isYt && !isFb) continue; // leave other platforms alone

    const wanted = isYt ? Boolean(streamTo.youtube) : Boolean(streamTo.facebook);
    try {
      if (wanted) {
        await restream.setChannelMeta(channel.id, { title, description });
      }
      if (channel.active !== wanted) {
        await restream.setChannelActive(channel.id, wanted);
      }
    } catch (err) {
      warnings.push(
        `Could not update the ${isYt ? 'YouTube' : 'Facebook'} destination "${channel.displayName}" in Restream: ${(err && err.message) || err}`
      );
    }
  }

  return { channels, warnings };
}

/** Save a per-event cover so it can be applied once the broadcast exists. */
function savePendingCover(recordId, cover) {
  if (!cover) return false;
  try {
    coverImages.saveTemplateCover(pendingCoverKey(recordId), cover.buffer, cover.mimeType);
    return true;
  } catch (err) {
    return false;
  }
}

/** Apply playlist / thumbnail / privacy to the broadcast Restream created. */
async function applyYouTubeExtras(record, broadcastId) {
  const notes = [];

  if (record.privacy) {
    try {
      await youtube.updateBroadcastPrivacy(broadcastId, record.privacy);
      notes.push(`privacy → ${record.privacy}`);
    } catch (err) {
      simulcastLog.warn(`Restream link: could not set privacy on ${broadcastId}: ${(err && err.message) || err}`);
    }
  }

  if (record.playlistId) {
    try {
      await youtube.addToPlaylist(record.playlistId, broadcastId);
      notes.push('playlist added');
    } catch (err) {
      simulcastLog.warn(`Restream link: could not add ${broadcastId} to playlist: ${(err && err.message) || err}`);
    }
  }

  let cover = coverImages.readTemplateCover(pendingCoverKey(record.id));
  if (!cover && record.templateId) cover = coverImages.readTemplateCover(record.templateId);
  if (cover) {
    try {
      await youtube.setThumbnail(broadcastId, cover.buffer, cover.mimeType);
      notes.push('thumbnail set');
    } catch (err) {
      simulcastLog.warn(`Restream link: could not set thumbnail on ${broadcastId}: ${(err && err.message) || err}`);
    }
  }
  coverImages.deleteTemplateCover(pendingCoverKey(record.id));

  return notes;
}

let linking = false;

/**
 * Try to attach pending Restream-mode records to the YouTube broadcasts that
 * Restream created. Safe to call often (no-ops fast when nothing is pending).
 */
async function linkPendingStreams() {
  if (linking) return { linked: 0 };
  linking = true;
  try {
    const settings = await store.getSettings();
    if (!settings.restream || !settings.restream.enabled) return { linked: 0 };

    const pending = (await store.listRestreamPendingStreams()).filter(
      (r) => Date.now() - new Date(r.createdAt).getTime() < PENDING_MAX_AGE_MS
    );
    if (pending.length === 0) return { linked: 0 };
    if (!(await store.hasYouTubeAuth())) return { linked: 0 };

    const broadcasts = await youtube.listBroadcasts(25);
    const known = new Set(
      (await store.listStreams()).filter((s) => !s.restreamPending).map((s) => s.broadcastId)
    );

    let linked = 0;
    for (const record of pending) {
      const match = broadcasts.find((b) => {
        const state = (b.status && b.status.lifeCycleStatus) || '';
        const title = (b.snippet && b.snippet.title) || '';
        return (
          !known.has(b.id) &&
          LINKABLE_STATES.has(state) &&
          title.trim() === String(record.title || '').trim() &&
          // Only broadcasts newer than the record — never adopt old videos.
          new Date((b.snippet && b.snippet.publishedAt) || 0).getTime() >=
            new Date(record.createdAt).getTime() - 60 * 60 * 1000
        );
      });
      if (!match) continue;

      known.add(match.id);
      simulcastLog.info(`Restream: linked "${record.title}" to YouTube broadcast ${match.id}.`);

      await store.updateStreamById(record.id, {
        broadcastId: match.id,
        restreamPending: false,
        watchUrl: `https://www.youtube.com/watch?v=${match.id}`,
        linkedAt: new Date(),
      });

      const updated = { ...record, id: record.id };
      const notes = await applyYouTubeExtras(updated, match.id);
      if (notes.length) simulcastLog.info(`Restream: applied ${notes.join(', ')} to ${match.id}.`);
      linked += 1;
    }
    return { linked };
  } catch (err) {
    simulcastLog.warn(`Restream link check failed: ${(err && err.message) || err}`);
    return { linked: 0, error: (err && err.message) || String(err) };
  } finally {
    linking = false;
  }
}

let linkTimer = null;

/** Background link polling — cheap no-op unless Restream mode has pending events. */
function startLinkPolling() {
  if (linkTimer) return;
  linkTimer = setInterval(() => {
    linkPendingStreams().catch(() => {});
  }, 60 * 1000);
  if (linkTimer.unref) linkTimer.unref();
}

module.exports = {
  configureDestinations,
  savePendingCover,
  linkPendingStreams,
  startLinkPolling,
};
