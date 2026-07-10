'use strict';

/**
 * Restream-mode stream lifecycle.
 *
 * Create: resolve the template as usual, store a pending local record, and
 * (if this event is the one due next) push title/description + destination
 * toggles to Restream. Restream creates the actual platform broadcasts when
 * ATEM starts pushing the permanent Restream key.
 *
 * Arm (schedule-aware): when several pending events exist (e.g. 3pm + 8pm),
 * STREAM1 picks the one whose scheduled time is due (early window before
 * start → late window after). At 2:45pm ATEM go-live arms the 3pm event —
 * not the 8pm one — and re-pushes that template's title to Restream.
 *
 * Link (hybrid): YouTube stays connected for metadata. Once Restream has
 * created a NEW YouTube broadcast, we attach it to the armed/due pending
 * record and apply playlist/thumbnail/privacy. Ended (complete/revoked)
 * YouTube videos are NEVER linked or reused.
 *
 * Permanent Restream RTMP key stays the same forever. A new YouTube video per
 * wedding/funeral requires a Restream "YouTube Events" destination (not
 * "Stream Now"), and previous lives must be fully ended.
 */

const store = require('./store');
const restream = require('./restream');
const youtube = require('./youtube');
const facebook = require('./facebook');
const coverImages = require('./coverImages');
const simulcastLog = require('./simulcastLog');
const { AppError } = require('./middleware/errors');
const { facebookAllowedForPrivacy, normalizeStreamTo } = require('./streamDestinations');

// Never include complete/revoked — those videos must not be reused.
const LINKABLE_STATES = new Set(['live', 'liveStarting', 'testStarting', 'testing', 'ready', 'created']);
const ENDED_STATES = new Set(['complete', 'revoked']);
const ON_AIR_STATES = new Set(['live', 'liveStarting', 'testStarting', 'testing']);
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How early before scheduled start we treat an event as "due".
 * At 1:25pm with a 2pm wedding + 4pm funeral → arm the 2pm wedding.
 */
const EARLY_ARM_MS = 90 * 60 * 1000;
/**
 * How long after scheduled start we still send ATEM to THAT event (streamer late).
 * Example: 1pm + 5pm pending, go-live at 1:10 → still arm 1pm, not 5pm.
 */
const LATE_ARM_MS = 15 * 60 * 1000;

/** Videos where YouTube returned Forbidden for privacy/title — stop retrying. */
const youtubeWriteForbidden = new Map(); // videoId -> { at, reason }
const FORBIDDEN_TTL_MS = 6 * 60 * 60 * 1000;

function markYouTubeWriteForbidden(videoId, reason) {
  if (!videoId) return;
  youtubeWriteForbidden.set(String(videoId), { at: Date.now(), reason: String(reason || 'forbidden') });
}

function isYouTubeWriteForbidden(videoId) {
  if (!videoId) return false;
  const hit = youtubeWriteForbidden.get(String(videoId));
  if (!hit) return false;
  if (Date.now() - hit.at > FORBIDDEN_TTL_MS) {
    youtubeWriteForbidden.delete(String(videoId));
    return false;
  }
  return true;
}

function isForbiddenErr(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  return code === 'forbidden' || /forbidden|not authorized|insufficient/i.test(msg);
}

/**
 * Block Create Stream when Restream YouTube destination and STREAM1's connected
 * YouTube channel don't match — privacy/title updates will always 403.
 * Also requires YouTube to be connected when YouTube is a destination.
 */
async function assertRestreamYouTubeWritable({ streamTo } = {}) {
  const wantsYt = !(streamTo && streamTo.youtube === false);
  if (!wantsYt) return { ok: true };

  if (!(await store.hasYouTubeAuth())) {
    throw new AppError(
      'YouTube is not connected in STREAM1. Connect the same YouTube channel Restream streams to in Settings, then try again. Without it, privacy (unlisted/private) and titles cannot be applied.',
      { status: 409, code: 'youtube_not_connected' }
    );
  }

  const settings = await store.getSettings();
  const stream1ChannelId = settings.youtube && settings.youtube.channelId;
  const stream1Title = (settings.youtube && settings.youtube.channelTitle) || 'connected channel';

  let channels = [];
  try {
    channels = await restream.listChannels();
  } catch (err) {
    throw new AppError(
      `Could not read Restream destinations: ${(err && err.message) || err}`,
      { status: 502, code: 'restream_error' }
    );
  }

  const ytChannels = channels.filter(restream.isYouTubeChannel);
  if (!ytChannels.length) {
    throw new AppError(
      'No YouTube destination is connected in Restream. Add YouTube (Events) in the Restream dashboard, then Refresh in Settings.',
      { status: 409, code: 'restream_no_youtube' }
    );
  }

  const restreamIds = ytChannels
    .map((c) => c.youtubeChannelId)
    .filter(Boolean);

  // If we can compare UC ids and none match STREAM1's channel → hard block.
  if (stream1ChannelId && restreamIds.length) {
    const match = restreamIds.some(
      (id) => String(id).toLowerCase() === String(stream1ChannelId).toLowerCase()
    );
    if (!match) {
      const rsLabel =
        ytChannels.map((c) => c.displayName || c.youtubeChannelId || c.id).join(', ') || 'Restream YouTube';
      throw new AppError(
        `YouTube channel mismatch. STREAM1 is connected as "${stream1Title}" but Restream streams to "${rsLabel}". ` +
          `Reconnect YouTube in STREAM1 Settings with the SAME channel Restream uses — otherwise privacy/title updates are Forbidden and the stream stays public.`,
        { status: 409, code: 'youtube_channel_mismatch' }
      );
    }
  }

  // Soft probe: can we at least list broadcasts? (auth alive)
  try {
    await youtube.listBroadcasts(1);
  } catch (err) {
    if (isForbiddenErr(err) || (err && err.code === 'oauth_expired')) {
      throw new AppError(
        `YouTube connection cannot manage live videos (${(err && err.message) || 'forbidden'}). Reconnect YouTube in Settings with the channel owner account that Restream streams to.`,
        { status: 409, code: 'youtube_forbidden' }
      );
    }
    throw err;
  }

  return { ok: true, stream1ChannelId, restreamIds };
}

function pendingCoverKey(recordId) {
  return `stream-${recordId}`;
}

function startMs(record) {
  const raw = record && (record.scheduledStartTime || record.createdAt);
  const t = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pick which pending Restream event should own the next ATEM go-live.
 *
 * NEVER use "closest absolute time" — that can pick a later funeral over an
 * earlier wedding. Always prefer the soonest upcoming / currently-due event.
 *
 *   1) Running late: start <= now <= start+15min → earliest of those
 *   2) Upcoming within early window: now < start <= now+90min → earliest
 *   3) Any future event → earliest
 *   4) All past late window → newest by schedule (fallback only)
 */
function pickDuePendingStream(pending, now = Date.now()) {
  const list = (pending || []).filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  const withStart = list.map((r) => ({ r, t: startMs(r) }));

  // 1) Currently due or within late grace — earliest start wins (1pm over 5pm).
  const runningOrLate = withStart
    .filter(({ t }) => t <= now && now <= t + LATE_ARM_MS)
    .sort((a, b) => a.t - b.t);
  if (runningOrLate.length) return runningOrLate[0].r;

  // 2) Upcoming soon (within early arm window) — soonest first.
  const early = withStart
    .filter(({ t }) => now < t && t <= now + EARLY_ARM_MS)
    .sort((a, b) => a.t - b.t);
  if (early.length) return early[0].r;

  // 3) Any future event — soonest first (covers "create both, go live early").
  const future = withStart.filter(({ t }) => t > now).sort((a, b) => a.t - b.t);
  if (future.length) return future[0].r;

  // 4) Everything is past the late window — newest by schedule.
  return withStart.sort((a, b) => b.t - a.t)[0].r;
}

async function listFreshPending() {
  return (await store.listRestreamPendingStreams()).filter(
    (r) =>
      !r.endedAt &&
      Date.now() - new Date(r.createdAt).getTime() < PENDING_MAX_AGE_MS
  );
}

/**
 * Mark a Restream-mode local stream as finished so it leaves "Next streams"
 * and is never armed/linked again. Optionally retire its YouTube/FB ids.
 */
async function markStreamEnded(record, { reason = 'ended', retire = true } = {}) {
  if (!record || !record.id || record.endedAt) return record;
  const patch = {
    endedAt: new Date(),
    endedReason: String(reason || 'ended').slice(0, 80),
    restreamPending: false,
  };
  const updated = await store.updateStreamById(record.id, patch);

  if (retire) {
    const settings = await store.getSettings();
    const retired = new Set(
      ((settings.restream && settings.restream.retiredBroadcastIds) || []).map(String)
    );
    const retiredFb = new Set(
      ((settings.restream && settings.restream.retiredFacebookLiveIds) || []).map(String)
    );
    const bid = record.broadcastId ? String(record.broadcastId) : '';
    if (bid && !bid.startsWith('restream-pending-')) retired.add(bid);
    if (record.facebookLiveVideoId) retiredFb.add(String(record.facebookLiveVideoId));

    const clearArmed =
      String((settings.restream && settings.restream.armedStreamId) || '') === String(record.id);
    await store.updateSettings({
      restream: {
        retiredBroadcastIds: Array.from(retired).slice(-200),
        retiredFacebookLiveIds: Array.from(retiredFb).slice(-200),
        ...(clearArmed
          ? { armedStreamId: null, armedAt: null, armedTitle: null }
          : {}),
      },
    });
  }

  simulcastLog.info(
    `Restream: marked "${record.title || record.id}" finished (${reason}) — removed from Next streams.`
  );
  return updated;
}

/**
 * When Restream goes offline (or YouTube marks a linked video complete), settle
 * the stream that just finished so Stream Test "Next streams" drops it.
 *
 * Tracks lastLiveArmedStreamId while live so an early finish (before schedule)
 * still clears the armed pending event.
 */
async function settleFinishedStreams({ restreamLive = null, liveVideoId = null } = {}) {
  const settings = await store.getSettings();
  if (!settings.restream || !settings.restream.enabled) return { settled: 0 };

  let settled = 0;

  // Remember which armed event owned the current Restream session.
  if (restreamLive === true && settings.restream.armedStreamId) {
    if (String(settings.restream.lastLiveArmedStreamId || '') !== String(settings.restream.armedStreamId)) {
      await store.updateSettings({
        restream: { lastLiveArmedStreamId: settings.restream.armedStreamId },
      });
    }
    // While live, still retire any OTHER linked videos that YouTube already ended.
  }

  // Explicit offline after a live session: finish the stream that was on air.
  if (restreamLive === false && settings.restream.lastLiveArmedStreamId) {
    const id = settings.restream.lastLiveArmedStreamId;
    try {
      const rec = await store.getStreamById(id);
      if (rec && !rec.endedAt) {
        await markStreamEnded(rec, { reason: 'restream_offline', retire: true });
        settled += 1;
      }
    } catch (_) { /* ignore */ }
    await store.updateSettings({
      restream: {
        lastLiveArmedStreamId: null,
        armedStreamId: null,
        armedAt: null,
        armedTitle: null,
      },
    });
  }

  // Linked (or pending-with-matching-YT) streams whose YouTube life is complete.
  if (await store.hasYouTubeAuth()) {
    let broadcasts = [];
    try {
      broadcasts = await youtube.listBroadcasts(50);
    } catch (_) {
      broadcasts = [];
    }
    const byId = new Map(broadcasts.map((b) => [String(b.id), b]));
    const liveId = liveVideoId && restreamLive ? String(liveVideoId) : null;
    const streams = await store.listStreams();

    for (const s of streams) {
      if (!s.viaRestream || s.endedAt || s.hidden) continue;

      // Linked stream: end when YouTube says complete (and it is not the current live).
      if (!s.restreamPending) {
        const bid = s.broadcastId ? String(s.broadcastId) : '';
        if (!bid || bid.startsWith('restream-pending-')) continue;
        if (liveId && bid === liveId) continue;
        let life = '';
        const cached = byId.get(bid);
        if (cached) life = (cached.status && cached.status.lifeCycleStatus) || '';
        else {
          try {
            const b = await youtube.getBroadcast(bid);
            life = (b && b.status && b.status.lifeCycleStatus) || '';
          } catch (_) { /* ignore */ }
        }
        if (ENDED_STATES.has(life)) {
          await markStreamEnded(s, { reason: `youtube_${life}`, retire: true });
          settled += 1;
        }
        continue;
      }

      // Still pending, but a matching YouTube video already ended (early finish /
      // link missed). Only when Restream is not live — never kill the next event.
      if (restreamLive === false && s.title) {
        const recTitle = String(s.title).trim().toLowerCase();
        const createdMs = new Date(s.createdAt || 0).getTime() - 60 * 60 * 1000;
        const match = broadcasts.find((b) => {
          const bt = ((b.snippet && b.snippet.title) || '').trim().toLowerCase();
          const st = (b.status && b.status.lifeCycleStatus) || '';
          if (!bt || bt !== recTitle || !ENDED_STATES.has(st)) return false;
          const pub = new Date((b.snippet && b.snippet.publishedAt) || 0).getTime();
          return Number.isFinite(pub) && pub >= createdMs;
        });
        if (match) {
          await markStreamEnded(s, {
            reason: `youtube_${(match.status && match.status.lifeCycleStatus) || 'complete'}`,
            retire: true,
          });
          settled += 1;
        }
      }
    }
  }

  return { settled };
}

/**
 * Configure Restream destinations for an event: set titles/descriptions and
 * toggle YouTube/Facebook channels to match `streamTo`.
 */
/**
 * Configure Restream destinations for an event.
 *
 * Privacy gate: Facebook destinations are only enabled when privacy is Public.
 * Unlisted/Private → every Restream Facebook channel is forced OFF.
 * When Facebook is allowed and ticked, ALL Facebook channels get the event
 * title via PATCH /user/channel-meta (same as YouTube) so Restream posts the
 * live with that title as the post text.
 */
async function configureDestinations({
  title,
  description,
  streamTo,
  privacy = 'unlisted',
  endLeftovers = true,
} = {}) {
  const effective = normalizeStreamTo(streamTo || {}, privacy);
  const channels = await restream.listChannels();
  await store.updateSettings({
    restream: { channels, channelsRefreshedAt: new Date() },
  });

  const warnings = [];
  const youtubeChannels = channels.filter(restream.isYouTubeChannel);
  const facebookChannels = channels.filter(restream.isFacebookChannel);

  if (Boolean(streamTo && streamTo.facebook) && !facebookAllowedForPrivacy(privacy)) {
    warnings.push(
      'Facebook was requested but privacy is not Public — all Restream Facebook destinations stay OFF.'
    );
    simulcastLog.info(
      `Restream: privacy "${privacy}" blocks Facebook — forcing ${facebookChannels.length} Facebook channel(s) OFF.`
    );
  }

  if (effective.youtube && youtubeChannels.length === 0) {
    warnings.push('No YouTube destination is connected in Restream — add it in the Restream dashboard.');
  }
  if (effective.facebook && facebookChannels.length === 0) {
    warnings.push('No Facebook destination is connected in Restream — add it in the Restream dashboard.');
  }

  const streamNow = youtubeChannels.filter((c) => c.youtubeKind === 'stream_now');
  if (effective.youtube && streamNow.length) {
    warnings.push(
      'Your Restream YouTube destination is "Stream Now", which often reuses the SAME YouTube video every time. ' +
        'In the Restream dashboard, remove it and add "YouTube" / "YouTube Events" instead, then Refresh here. ' +
        'Keep the same Restream stream key in ATEM — only the destination type needs to change.'
    );
  }

  if (endLeftovers && effective.youtube && (await store.hasYouTubeAuth())) {
    try {
      const ended = await endLeftoverYouTubeLives();
      if (ended > 0) {
        simulcastLog.info(`Restream: ended ${ended} leftover YouTube live broadcast(s) before "${title}".`);
      }
    } catch (err) {
      warnings.push(
        `Could not end a previous YouTube live before starting this one: ${(err && err.message) || err}`
      );
    }
  }

  // Same for Facebook when that destination is ticked — Restream creates the FB
  // live, but leftover LIVE videos on the page must be ended so the next go-live
  // gets a brand-new Facebook live (not the previous one).
  if (endLeftovers && effective.facebook) {
    try {
      const endedFb = await endLeftoverFacebookLives();
      if (endedFb > 0) {
        simulcastLog.info(`Restream: ended ${endedFb} leftover Facebook live video(s) before "${title}".`);
      }
    } catch (err) {
      warnings.push(
        `Could not end a previous Facebook live before starting this one: ${(err && err.message) || err}`
      );
    }
  }

  try {
    const status = await restream.getStreamingStatus();
    if (status && status.live) {
      warnings.push(
        'Restream still shows a live feed. Fully stop ATEM and confirm the previous YouTube/Facebook lives have ended ' +
          'before the next service — otherwise the feed can land on the old video even with a new title.'
      );
    }
  } catch (_) {
    /* non-fatal */
  }

  // Toggle EVERY YouTube and Facebook Restream channel to match this event.
  for (const channel of channels) {
    const isYt = restream.isYouTubeChannel(channel);
    const isFb = restream.isFacebookChannel(channel);
    if (!isYt && !isFb) continue;

    const wanted = isYt ? Boolean(effective.youtube) : Boolean(effective.facebook);
    try {
      if (channel.active !== wanted) {
        await restream.setChannelActive(channel.id, wanted);
      }
    } catch (err) {
      warnings.push(
        `Could not update the ${isYt ? 'YouTube' : 'Facebook'} destination "${channel.displayName}" in Restream: ${(err && err.message) || err}`
      );
    }
  }

  // Push event title to every enabled destination via official channel-meta API.
  // For Facebook this becomes the live post title/text Restream sends with the feed.
  const wantedChannelIds = channels
    .filter((ch) => {
      const isYt = restream.isYouTubeChannel(ch);
      const isFb = restream.isFacebookChannel(ch);
      if (!isYt && !isFb) return false;
      return isYt ? Boolean(effective.youtube) : Boolean(effective.facebook);
    })
    .map((ch) => ch.id);

  try {
    const pushed = await restream.pushEventTitles({
      title,
      description,
      channelIds: wantedChannelIds,
    });
    if (pushed.channels > 0) {
      const fbOn = effective.facebook ? facebookChannels.length : 0;
      simulcastLog.info(
        `Restream: pushed event title to ${pushed.channels} destination(s) → "${title}"` +
          ` (YouTube: ${effective.youtube ? 'on' : 'off'}, Facebook channels: ${fbOn}).`
      );
    }
    if (!pushed.stream) {
      simulcastLog.info(
        `Restream: Autodetect dashboard label stays "Stream via RTMP…" (API has no title write). ` +
          `Destination titles were set to "${title}".`
      );
    }
    for (const w of pushed.warnings || []) {
      if (!/HTTP 404|not found/i.test(w)) warnings.push(w);
    }
  } catch (err) {
    warnings.push(`Could not push event title to Restream: ${(err && err.message) || err}`);
  }

  return { channels, warnings, streamTo: effective };
}

/**
 * End every YouTube broadcast still on-air and remember those ids so we never
 * link a pending STREAM1 event to them again.
 */
async function endLeftoverYouTubeLives() {
  if (!(await store.hasYouTubeAuth())) return 0;

  const broadcasts = await youtube.listBroadcasts(50);
  const settings = await store.getSettings();
  const retired = new Set(
    ((settings.restream && settings.restream.retiredBroadcastIds) || []).map(String)
  );

  let ended = 0;
  for (const b of broadcasts) {
    const st = (b.status && b.status.lifeCycleStatus) || '';
    if (ENDED_STATES.has(st)) {
      retired.add(String(b.id));
      continue;
    }
    if (!ON_AIR_STATES.has(st)) continue;
    try {
      await youtube.transitionBroadcast(b.id, 'complete');
      retired.add(String(b.id));
      ended += 1;
      simulcastLog.info(`Restream: force-ended YouTube broadcast ${b.id} (${st}) — will not reuse.`);
    } catch (err) {
      simulcastLog.warn(
        `Restream: could not end leftover YouTube broadcast ${b.id}: ${(err && err.message) || err}`
      );
      // Still retire it so we refuse to link a pending event to this id.
      retired.add(String(b.id));
    }
  }

  // Cap the retired list so settings stay small.
  const retiredList = Array.from(retired).slice(-200);
  await store.updateSettings({
    restream: { retiredBroadcastIds: retiredList },
  });

  return ended;
}

/**
 * End leftover Facebook page lives (Restream mode + direct relay). Retires
 * those live video ids so we never treat them as the current live again.
 */
async function endLeftoverFacebookLives() {
  const settings = await store.getSettings();
  const pageId = settings.facebook && settings.facebook.pageId;
  if (!pageId || !(await store.hasFacebookAuth())) return 0;

  const retired = new Set(
    ((settings.restream && settings.restream.retiredFacebookLiveIds) || []).map(String)
  );

  // Always retire the currently tracked active live if any.
  if (settings.facebook && settings.facebook.activeLiveVideoId) {
    const activeId = String(settings.facebook.activeLiveVideoId);
    try {
      await facebook.endLiveVideo(pageId, activeId);
      simulcastLog.info(`Restream: force-ended tracked Facebook live ${activeId}.`);
    } catch (err) {
      simulcastLog.warn(
        `Restream: could not end tracked Facebook live ${activeId}: ${(err && err.message) || err}`
      );
    }
    retired.add(activeId);
    await store.updateSettings({
      facebook: { activeLiveVideoId: null, activeLiveVideoUrl: null },
    });
  }

  let ended = 0;
  try {
    const result = await facebook.endLeftoverLiveVideos(pageId);
    ended = result.ended || 0;
    for (const v of result.videos || []) {
      const st = String(v.status || '').toUpperCase();
      if (st === 'VOD' || st === 'PROCESSING') retired.add(String(v.id));
      else if (ended > 0) retired.add(String(v.id));
    }
  } catch (err) {
    simulcastLog.warn(`Restream: Facebook leftover scan failed: ${(err && err.message) || err}`);
  }

  // Also retire any facebookLiveVideoId stored on recent local stream records.
  try {
    const streams = await store.listStreams();
    for (const s of streams) {
      if (s.facebookLiveVideoId) retired.add(String(s.facebookLiveVideoId));
    }
  } catch (_) {}

  await store.updateSettings({
    restream: { retiredFacebookLiveIds: Array.from(retired).slice(-200) },
  });

  return ended;
}

function isRetiredId(settings, videoId) {
  const list = (settings.restream && settings.restream.retiredBroadcastIds) || [];
  return list.map(String).includes(String(videoId));
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

/** Apply playlist / thumbnail / privacy / title to the broadcast Restream created. */
async function applyYouTubeExtras(record, broadcastId) {
  const notes = [];

  const writeBlocked = isYouTubeWriteForbidden(broadcastId);

  // If Restream left the Autodetect RTMP label on YouTube, rename to the template title.
  if (record.title && !writeBlocked) {
    try {
      const b = await youtube.getBroadcast(broadcastId);
      const current = (b && b.snippet && b.snippet.title) || '';
      if (restream.isGenericAutodetectTitle(current) || !current.trim()) {
        await youtube.updateBroadcastTitle(broadcastId, record.title, {
          description: record.description,
        });
        notes.push(`title → ${record.title}`);
      }
    } catch (err) {
      if (isForbiddenErr(err)) {
        markYouTubeWriteForbidden(broadcastId, err.message);
        notes.push('title FORBIDDEN (skipped further retries)');
      }
      simulcastLog.warn(
        `Restream link: could not rename YouTube title on ${broadcastId}: ${(err && err.message) || err}`
      );
    }
  }

  if (record.privacy) {
    if (writeBlocked || isYouTubeWriteForbidden(broadcastId)) {
      notes.push(`privacy SKIPPED (YouTube Forbidden — reconnect matching channel)`);
    } else {
      try {
        const result = await youtube.ensureBroadcastPrivacy(broadcastId, record.privacy, {
          attempts: 3,
          delayMs: 1500,
        });
        notes.push(
          result.alreadySet
            ? `privacy already ${record.privacy}`
            : `privacy → ${record.privacy}`
        );
      } catch (err) {
        if (isForbiddenErr(err)) {
          markYouTubeWriteForbidden(broadcastId, err.message);
          notes.push(`privacy FORBIDDEN (wanted ${record.privacy}) — stop retrying`);
        } else {
          notes.push(`privacy FAILED (wanted ${record.privacy})`);
        }
        simulcastLog.warn(
          `Restream link: could not set privacy on ${broadcastId} to ${record.privacy}: ${(err && err.message) || err}`
        );
      }
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

/**
 * As soon as Restream exposes a YouTube video id (even before full link),
 * push the armed/due event's privacy so the live doesn't stay public.
 */
async function applyPrivacyToVideoId(videoId, privacy) {
  if (!videoId || !privacy) return { ok: false };
  if (!['public', 'unlisted', 'private'].includes(privacy)) return { ok: false };
  if (!(await store.hasYouTubeAuth())) return { ok: false };
  if (isYouTubeWriteForbidden(videoId)) {
    return { ok: false, forbidden: true, skipped: true };
  }
  try {
    const b = await youtube.getBroadcast(videoId);
    const current = (b && b.status && b.status.privacyStatus) || '';
    if (current === privacy) return { ok: true, alreadySet: true };
    await youtube.ensureBroadcastPrivacy(videoId, privacy, { attempts: 2, delayMs: 1200 });
    simulcastLog.info(`Restream: early privacy → ${privacy} on ${videoId} (was ${current || '?'}).`);
    return { ok: true };
  } catch (err) {
    if (isForbiddenErr(err)) {
      markYouTubeWriteForbidden(videoId, err.message);
      simulcastLog.warn(
        `Restream: YouTube Forbidden on ${videoId} — will not keep retrying privacy/title. Reconnect the matching channel owner in Settings.`
      );
      return { ok: false, forbidden: true, error: (err && err.message) || String(err) };
    }
    simulcastLog.warn(
      `Restream: early privacy set failed on ${videoId} → ${privacy}: ${(err && err.message) || err}`
    );
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

/**
 * If Restream is live with a YouTube destination, apply the due/armed event
 * privacy immediately (does not wait for full pending→broadcast link).
 */
async function enforceLivePreviewPrivacy(restreamPreview) {
  if (!restreamPreview || !restreamPreview.youtubeVideoId) return { fixed: 0 };
  const settings = await store.getSettings();
  if (!settings.restream || !settings.restream.enabled) return { fixed: 0 };

  let privacy = null;
  let title = null;
  let description = null;
  if (settings.restream.armedStreamId) {
    try {
      const armed = await store.getStreamById(settings.restream.armedStreamId);
      if (armed) {
        if (armed.privacy) privacy = armed.privacy;
        if (armed.title) title = armed.title;
        if (armed.description) description = armed.description;
      }
    } catch (_) {}
  }
  if (!title || !privacy) {
    const pending = await listFreshPending();
    const due = pickDuePendingStream(pending);
    if (due) {
      if (!privacy && due.privacy) privacy = due.privacy;
      if (!title && due.title) title = due.title;
      if (!description && due.description) description = due.description;
    }
  }
  // Also try a stream already linked to this video id.
  if (!title || !privacy) {
    const local = await store.getStreamByBroadcastId(restreamPreview.youtubeVideoId);
    if (local) {
      if (!privacy && local.privacy) privacy = local.privacy;
      if (!title && local.title) title = local.title;
      if (!description && local.description) description = local.description;
    }
  }

  const videoId = restreamPreview.youtubeVideoId;
  const writeBlocked = isYouTubeWriteForbidden(videoId);

  // Keep overwriting Restream Autodetect / RTMP default while live.
  if (title) {
    try {
      await restream.pushEventTitles({ title, description });
    } catch (_) { /* non-fatal */ }

    // If YouTube still shows the Autodetect label, rename it to the template title.
    if (!writeBlocked) {
      try {
        const b = await youtube.getBroadcast(videoId);
        const current = (b && b.snippet && b.snippet.title) || '';
        if (restream.isGenericAutodetectTitle(current) || !current.trim()) {
          await youtube.updateBroadcastTitle(videoId, title, { description });
          simulcastLog.info(
            `Restream: renamed YouTube Autodetect title → "${title}" on ${videoId}.`
          );
        }
      } catch (err) {
        if (isForbiddenErr(err)) {
          markYouTubeWriteForbidden(videoId, err.message);
        } else {
          simulcastLog.warn(
            `Restream: could not rename live YouTube title on ${videoId}: ${(err && err.message) || err}`
          );
        }
      }
    }
  }

  if (!privacy) return { fixed: 0, titleFixed: Boolean(title) };

  const result = await applyPrivacyToVideoId(restreamPreview.youtubeVideoId, privacy);
  if (result.ok && !result.alreadySet) {
    simulcastLog.info(
      `Restream: enforced live privacy ${privacy} for "${title || restreamPreview.title || 'event'}" (${restreamPreview.youtubeVideoId}).`
    );
    return { fixed: 1, privacy };
  }
  return { fixed: 0, privacy, alreadySet: Boolean(result.alreadySet) };
}

/**
 * Re-apply privacy on linked Restream streams whose YouTube privacy still
 * doesn't match the template/event choice (Restream often creates as public).
 */
async function enforceLinkedPrivacy() {
  const settings = await store.getSettings();
  if (!settings.restream || !settings.restream.enabled) return { fixed: 0 };
  if (!(await store.hasYouTubeAuth())) return { fixed: 0 };

  const streams = await store.listStreams();
  const candidates = streams.filter(
    (s) =>
      s.viaRestream &&
      !s.restreamPending &&
      !s.endedAt &&
      s.broadcastId &&
      !String(s.broadcastId).startsWith('restream-pending-') &&
      s.privacy &&
      ['public', 'unlisted', 'private'].includes(s.privacy)
  );
  if (!candidates.length) return { fixed: 0 };

  // Only check recent / still-relevant streams (last 48h or still live-ish).
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const recent = candidates.filter((s) => {
    const t = new Date(s.linkedAt || s.createdAt || 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  if (!recent.length) return { fixed: 0 };

  let fixed = 0;
  for (const record of recent.slice(0, 8)) {
    if (isYouTubeWriteForbidden(record.broadcastId)) continue;
    try {
      const b = await youtube.getBroadcast(record.broadcastId);
      if (!b) continue;
      const life = (b.status && b.status.lifeCycleStatus) || '';
      if (ENDED_STATES.has(life)) continue;

      const currentTitle = (b.snippet && b.snippet.title) || '';
      if (
        record.title
        && (restream.isGenericAutodetectTitle(currentTitle) || !currentTitle.trim())
      ) {
        try {
          await youtube.updateBroadcastTitle(record.broadcastId, record.title, {
            description: record.description,
          });
          simulcastLog.info(
            `Restream: corrected Autodetect YouTube title on ${record.broadcastId} → "${record.title}".`
          );
          fixed += 1;
        } catch (err) {
          if (isForbiddenErr(err)) markYouTubeWriteForbidden(record.broadcastId, err.message);
          else {
            simulcastLog.warn(
              `Restream: title re-check failed for ${record.broadcastId}: ${(err && err.message) || err}`
            );
          }
        }
      }

      if (isYouTubeWriteForbidden(record.broadcastId)) continue;
      const current = (b.status && b.status.privacyStatus) || '';
      if (!record.privacy || current === record.privacy) continue;

      await youtube.ensureBroadcastPrivacy(record.broadcastId, record.privacy, {
        attempts: 2,
        delayMs: 1200,
      });
      simulcastLog.info(
        `Restream: corrected YouTube privacy on ${record.broadcastId} from ${current || '?'} → ${record.privacy} ("${record.title}").`
      );
      fixed += 1;
    } catch (err) {
      if (isForbiddenErr(err)) markYouTubeWriteForbidden(record.broadcastId, err.message);
      else {
        simulcastLog.warn(
          `Restream: privacy re-check failed for ${record.broadcastId}: ${(err && err.message) || err}`
        );
      }
    }
  }
  return { fixed };
}

/**
 * Find the Facebook live Restream created for this go-live and return fields
 * to store on the STREAM1 record. Skips retired Facebook live ids.
 */
async function attachFacebookLiveFromRestream(record, settings) {
  const retiredFb = new Set(
    ((settings.restream && settings.restream.retiredFacebookLiveIds) || []).map(String)
  );

  let preview = null;
  try {
    preview = await restream.resolveLivePreview([]);
  } catch (_) {}

  let liveId = preview && preview.facebookLiveVideoId ? String(preview.facebookLiveVideoId) : null;
  let permalink = (preview && preview.facebookPermalink) || null;

  if (liveId && retiredFb.has(liveId)) {
    simulcastLog.warn(`Restream: Facebook live ${liveId} is retired — ignoring for "${record.title}".`);
    liveId = null;
    permalink = null;
  }

  // Fallback: newest non-retired LIVE video on the connected page whose title matches.
  const pageId = settings.facebook && settings.facebook.pageId;
  if ((!liveId || !permalink) && pageId && (await store.hasFacebookAuth())) {
    try {
      const videos = await facebook.listLiveVideos(pageId, { limit: 10 });
      const recTitle = String(record.title || '').trim().toLowerCase();
      const match =
        videos.find((v) => {
          if (!v || !v.id || retiredFb.has(String(v.id))) return false;
          const st = String(v.status || '').toUpperCase();
          if (st === 'VOD' || st === 'PROCESSING') return false;
          const vt = String(v.title || '').trim().toLowerCase();
          return vt && vt === recTitle;
        }) ||
        videos.find((v) => {
          if (!v || !v.id || retiredFb.has(String(v.id))) return false;
          const st = String(v.status || '').toUpperCase();
          return st === 'LIVE' || st === 'LIVE_STOPPED';
        });
      if (match) {
        liveId = String(match.id);
        permalink = match.permalink || permalink;
      }
    } catch (err) {
      simulcastLog.warn(`Restream: Facebook live list failed: ${(err && err.message) || err}`);
    }
  }

  if (!liveId && !permalink) return null;

  // Track as the active Restream-created Facebook live (no local ffmpeg relay).
  if (liveId) {
    await store.updateSettings({
      facebook: {
        activeLiveVideoId: liveId,
        activeLiveVideoUrl: permalink || null,
      },
    });
  }

  return {
    ...(liveId ? { facebookLiveVideoId: liveId } : {}),
    ...(permalink ? { facebookPermalink: permalink } : {}),
  };
}

let arming = false;

/**
 * Ensure Restream's channel title/destinations match the pending event that
 * should own the next (or current) ATEM go-live, based on schedule.
 *
 * Called from monitor polls and after creating a new Restream-mode stream.
 * Returns { armed, record, warnings, pushed }.
 */
async function syncArmedPending({ forcePush = false, restreamLive = null } = {}) {
  if (arming) return { armed: false, skipped: true };
  arming = true;
  try {
    const settings = await store.getSettings();
    if (!settings.restream || !settings.restream.enabled) {
      return { armed: false };
    }
    if (!(await store.hasRestreamAuth())) return { armed: false };

    const pending = await listFreshPending();
    if (pending.length === 0) {
      if (settings.restream.armedStreamId) {
        await store.updateSettings({ restream: { armedStreamId: null, armedAt: null } });
      }
      return { armed: false };
    }

    const due = pickDuePendingStream(pending);
    if (!due) return { armed: false };

    // While Restream is already live on an armed pending event, do not jump to a
    // later event (e.g. stay on 2pm wedding even if pickDue briefly prefers 4pm).
    let chosen = due;
    if (restreamLive === true && settings.restream.armedStreamId) {
      const armedStillPending = pending.find(
        (p) => String(p.id) === String(settings.restream.armedStreamId)
      );
      if (armedStillPending) {
        const armedStart = startMs(armedStillPending);
        const dueIsLater = startMs(due) > armedStart;
        // Stick with the armed event while live unless pickDue found an EARLIER one.
        if (dueIsLater || String(due.id) === String(armedStillPending.id)) {
          chosen = armedStillPending;
        }
      }
    }

    const alreadyArmed = String(settings.restream.armedStreamId || '') === String(chosen.id);
    // CRITICAL: never re-push / end leftovers while Restream is already live on
    // the same armed event — that was killing brand-new YouTube lives (~9s).
    const shouldPush = forcePush || !alreadyArmed;

    let warnings = [];
    let pushed = false;
    if (shouldPush) {
      const streamTo = normalizeStreamTo(
        chosen.streamTo || { youtube: true, facebook: false },
        chosen.privacy
      );
      // Persist gated streamTo so history / Next streams stay accurate.
      if (Boolean(chosen.streamTo && chosen.streamTo.facebook) !== streamTo.facebook) {
        try {
          await store.updateStreamById(chosen.id, { streamTo });
          chosen.streamTo = streamTo;
        } catch (_) { /* non-fatal */ }
      }
      // Only end leftover lives when switching to a NEW event (or force). Never
      // while Restream is already receiving for this same armed event.
      const endLeftovers = !restreamLive || !alreadyArmed;
      const result = await configureDestinations({
        title: chosen.title,
        description: chosen.description || '',
        streamTo,
        privacy: chosen.privacy || 'unlisted',
        endLeftovers,
      });
      warnings = result.warnings || [];
      pushed = true;
      await store.updateSettings({
        restream: {
          armedStreamId: chosen.id,
          armedAt: new Date(),
          armedTitle: chosen.title || null,
        },
      });
      simulcastLog.info(
        `Restream: armed pending "${chosen.title}" (scheduled ${chosen.scheduledStartTime || 'n/a'}) for next ATEM go-live.`
      );
    }

    return { armed: true, record: chosen, warnings, pushed };
  } catch (err) {
    simulcastLog.warn(`Restream arm failed: ${(err && err.message) || err}`);
    return { armed: false, error: (err && err.message) || String(err) };
  } finally {
    arming = false;
  }
}

let linking = false;

/**
 * Attach pending Restream-mode records to NEW YouTube broadcasts Restream
 * created. Never links complete/revoked/retired video ids.
 */
async function linkPendingStreams() {
  if (linking) return { linked: 0 };
  linking = true;
  try {
    const settings = await store.getSettings();
    if (!settings.restream || !settings.restream.enabled) return { linked: 0 };

    const pending = await listFreshPending();
    if (pending.length === 0) return { linked: 0 };
    if (!(await store.hasYouTubeAuth())) return { linked: 0 };

    // Prefer linking the schedule-due event first.
    const due = pickDuePendingStream(pending);
    const ordered = due
      ? [due, ...pending.filter((p) => String(p.id) !== String(due.id))]
      : pending;

    const broadcasts = await youtube.listBroadcasts(50);
    const byId = new Map(broadcasts.map((b) => [b.id, b]));

    // Retire anything YouTube already marked ended.
    const retired = new Set(
      ((settings.restream && settings.restream.retiredBroadcastIds) || []).map(String)
    );
    for (const b of broadcasts) {
      const st = (b.status && b.status.lifeCycleStatus) || '';
      if (ENDED_STATES.has(st)) retired.add(String(b.id));
    }

    const known = new Set(
      (await store.listStreams())
        .filter((s) => !s.restreamPending)
        .map((s) => String(s.broadcastId))
    );
    // Also treat retired ids as known/unusable.
    for (const id of retired) known.add(id);

    let restreamCreated = [];
    try {
      restreamCreated = await restream.getRecentYouTubeVideosFromRestream();
    } catch (_) {}

    // Drop Restream-reported videos that are already ended/retired.
    restreamCreated = restreamCreated.filter((c) => {
      if (!c || !c.videoId) return false;
      if (retired.has(String(c.videoId)) || known.has(String(c.videoId))) return false;
      const b = byId.get(c.videoId);
      if (b) {
        const st = (b.status && b.status.lifeCycleStatus) || '';
        if (ENDED_STATES.has(st)) return false;
      }
      return true;
    });

    let linked = 0;
    for (const record of ordered) {
      let match = null;
      const recTitle = String(record.title || '').trim();

      if (restreamCreated.length) {
        let rcMatch = restreamCreated.find((c) => {
          const ct = String(c.title || '').trim();
          return ct && (ct === recTitle || ct.toLowerCase() === recTitle.toLowerCase());
        });
        // Only auto-adopt the single Restream video when this record is the due one.
        if (
          !rcMatch &&
          due &&
          String(record.id) === String(due.id) &&
          restreamCreated.length === 1
        ) {
          rcMatch = restreamCreated[0];
        }
        if (rcMatch && !known.has(String(rcMatch.videoId))) {
          match = { id: rcMatch.videoId };
        }
      }

      if (!match) {
        match = broadcasts.find((b) => {
          const state = (b.status && b.status.lifeCycleStatus) || '';
          const title = (b.snippet && b.snippet.title) || '';
          return (
            !known.has(String(b.id)) &&
            LINKABLE_STATES.has(state) &&
            title.trim() === recTitle &&
            new Date((b.snippet && b.snippet.publishedAt) || 0).getTime() >=
              new Date(record.createdAt).getTime() - 60 * 60 * 1000
          );
        });
      }

      if (!match) continue;

      const vid = match.id;
      if (known.has(String(vid)) || retired.has(String(vid))) {
        simulcastLog.warn(`Restream: refusing to link "${record.title}" to ended/retired video ${vid}.`);
        continue;
      }

      // Double-check live status from YouTube before adopting.
      let life = (byId.get(vid) && byId.get(vid).status && byId.get(vid).status.lifeCycleStatus) || '';
      if (!life) {
        try {
          const fresh = await youtube.getBroadcast(vid);
          life = (fresh && fresh.status && fresh.status.lifeCycleStatus) || '';
        } catch (_) {}
      }
      if (ENDED_STATES.has(life)) {
        retired.add(String(vid));
        known.add(String(vid));
        simulcastLog.warn(
          `Restream: YouTube video ${vid} is already ${life} — will not link or reuse for "${record.title}".`
        );
        continue;
      }
      if (life && !LINKABLE_STATES.has(life)) {
        simulcastLog.warn(
          `Restream: skipping YouTube video ${vid} (status ${life}) for "${record.title}".`
        );
        continue;
      }

      known.add(String(vid));
      simulcastLog.info(`Restream: linked "${record.title}" to YouTube broadcast ${vid}.`);

      const patch = {
        broadcastId: vid,
        restreamPending: false,
        watchUrl: `https://www.youtube.com/watch?v=${vid}`,
        linkedAt: new Date(),
      };

      // Facebook only when privacy is Public — otherwise Restream FB channels stay off.
      if (record.streamTo && record.streamTo.facebook && facebookAllowedForPrivacy(record.privacy)) {
        try {
          const fbInfo = await attachFacebookLiveFromRestream(record, settings);
          if (fbInfo) {
            Object.assign(patch, fbInfo);
            simulcastLog.info(
              `Restream: attached Facebook live ${fbInfo.facebookLiveVideoId || '(permalink only)'} to "${record.title}".`
            );
            // Best-effort: Restream-created FB lives may ignore Page-token privacy edits.
            const pageId = settings.facebook && settings.facebook.pageId;
            if (pageId && fbInfo.facebookLiveVideoId && record.privacy) {
              try {
                await facebook.updateLiveVideoPrivacy(pageId, fbInfo.facebookLiveVideoId, record.privacy);
                simulcastLog.info(
                  `Restream: requested Facebook privacy → ${record.privacy} on ${fbInfo.facebookLiveVideoId}.`
                );
              } catch (err) {
                simulcastLog.warn(
                  `Restream: could not set Facebook privacy on ${fbInfo.facebookLiveVideoId}: ${(err && err.message) || err}`
                );
              }
            }
          }
        } catch (err) {
          simulcastLog.warn(
            `Restream: could not attach Facebook live for "${record.title}": ${(err && err.message) || err}`
          );
        }
      } else if (record.streamTo && record.streamTo.facebook && !facebookAllowedForPrivacy(record.privacy)) {
        simulcastLog.info(
          `Restream: skipping Facebook attach for "${record.title}" — privacy is ${record.privacy} (Public required).`
        );
      }

      await store.updateStreamById(record.id, patch);

      if (String(settings.restream.armedStreamId || '') === String(record.id)) {
        await store.updateSettings({ restream: { armedStreamId: null, armedAt: null } });
      }

      // Apply privacy first (before playlist/thumb) so unlisted sticks ASAP while live.
      const notes = await applyYouTubeExtras({ ...record, id: record.id }, vid);
      if (notes.length) simulcastLog.info(`Restream: applied ${notes.join(', ')} to ${vid}.`);
      linked += 1;

      // Only link one pending per Restream go-live cycle (the due event).
      break;
    }

    if (retired.size) {
      await store.updateSettings({
        restream: { retiredBroadcastIds: Array.from(retired).slice(-200) },
      });
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

/** Background polling — arm due event + link when Restream creates the YT video. */
function startLinkPolling() {
  if (linkTimer) return;
  linkTimer = setInterval(() => {
    (async () => {
      let restreamLive = null;
      try {
        if (await store.hasRestreamAuth()) {
          const st = await restream.getStreamingStatus();
          restreamLive = Boolean(st && st.live);
        }
      } catch (_) {}
      await syncArmedPending({ restreamLive });
      await linkPendingStreams();
      await enforceLinkedPrivacy();
      await settleFinishedStreams({ restreamLive });
    })().catch(() => {});
  }, 30 * 1000);
  if (linkTimer.unref) linkTimer.unref();
}

module.exports = {
  configureDestinations,
  savePendingCover,
  linkPendingStreams,
  syncArmedPending,
  pickDuePendingStream,
  endLeftoverYouTubeLives,
  endLeftoverFacebookLives,
  enforceLinkedPrivacy,
  enforceLivePreviewPrivacy,
  assertRestreamYouTubeWritable,
  settleFinishedStreams,
  markStreamEnded,
  startLinkPolling,
  EARLY_ARM_MS,
  LATE_ARM_MS,
};
