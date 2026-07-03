'use strict';

const crypto = require('crypto');
const express = require('express');
const store = require('../store');
const youtube = require('../youtube');
const facebook = require('../facebook');
const facebookRelay = require('../facebookRelay');
const restream = require('../restream');
const restreamFlow = require('../restreamFlow');
const simulcastLog = require('../simulcastLog');
const coverImages = require('../coverImages');
const templateEngine = require('../templateEngine');
const cache = require('../cache');
const videoDownload = require('../videoDownload');
const { asyncHandler, AppError } = require('../middleware/errors');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const PRIVACY = ['public', 'unlisted', 'private'];

router.use(requireAuth);

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
function studioUrl(videoId) {
  return `https://studio.youtube.com/video/${videoId}/edit`;
}

const LIVE_BROADCAST_STATES = new Set(['live', 'liveStarting', 'testStarting', 'testing']);
const PREVIEW_BROADCAST_STATES = new Set(['live', 'liveStarting', 'testStarting', 'testing', 'ready']);

// Combine the form's date (YYYY-MM-DD) + time (HH:MM) into an ISO timestamp.
function combineDateTime(date, time) {
  if (!date) return new Date().toISOString();
  const t = /^\d{1,2}:\d{2}$/.test(time || '') ? time : '00:00';
  const dt = new Date(`${date}T${t}:00`);
  if (Number.isNaN(dt.getTime())) return new Date().toISOString();
  // YouTube rejects a scheduled start in the past for a fresh broadcast.
  return dt.getTime() < Date.now() ? new Date().toISOString() : dt.toISOString();
}

// Map a YouTube lifeCycleStatus to a friendly label + a "stuck" flag (§7).
function describeStatus(lifeCycleStatus) {
  switch (lifeCycleStatus) {
    case 'live':
      return { label: 'Live', stuck: false };
    case 'liveStarting':
    case 'testStarting':
      return { label: 'Starting…', stuck: true };
    case 'testing':
    case 'ready':
    case 'created':
      return { label: 'Upcoming', stuck: false };
    case 'complete':
      return { label: 'Ended', stuck: false };
    case 'revoked':
      return { label: 'Cancelled', stuck: false };
    default:
      return { label: lifeCycleStatus || 'Unknown', stuck: false };
  }
}

/* ------------------------------- Create stream --------------------------- */

/**
 * Restream-mode create: no YouTube broadcast is made here. The template still
 * resolves title/description; those are pushed to the Restream destinations
 * and the chosen channels are toggled on/off. Restream creates the platform
 * broadcasts when ATEM starts pushing; the linker then attaches the YouTube
 * broadcast and applies playlist/thumbnail/privacy.
 */
async function createViaRestream(req, res, settings, body) {
  if (!(await store.hasRestreamAuth())) {
    throw new AppError('Restream mode is on but Restream is not connected. Connect it in Settings.', {
      status: 409,
      code: 'restream_not_connected',
    });
  }

  const template = await store.getTemplate(body.templateId);
  if (!template) throw new AppError('Please choose a template.', { status: 400, code: 'no_template' });

  const form = body.form || {};
  for (const field of template.extraFields || []) {
    if (field.required && !String(form[field.key] || '').trim()) {
      throw new AppError(`Please fill in "${field.label}".`, { status: 400, code: 'missing_field' });
    }
  }

  const privacy = PRIVACY.includes(body.privacy) ? body.privacy : template.defaultPrivacy;

  const tplStreamTo = template.streamTo || { youtube: true, facebook: false };
  const rawStreamTo = body.streamTo && typeof body.streamTo === 'object' ? body.streamTo : tplStreamTo;
  const streamTo = {
    youtube: rawStreamTo.youtube === undefined ? true : Boolean(rawStreamTo.youtube),
    facebook: Boolean(rawStreamTo.facebook),
  };
  if (!streamTo.youtube && !streamTo.facebook) streamTo.youtube = true;

  const scheduledStartTime = combineDateTime(form.date, form.time);
  const { title, description, variables } = templateEngine.resolve(template, settings, form);

  // Push titles + destination toggles to Restream.
  const { warnings } = await restreamFlow.configureDestinations({ title, description, streamTo });

  // Per-event cover (kept on disk until the YouTube broadcast exists).
  let cover = null;
  try {
    cover = coverImages.decodeBase64Image(body.coverImageBase64, body.coverImageMime);
  } catch (err) {
    throw new AppError(err.message || 'Invalid cover image.', { status: 400, code: 'invalid_image' });
  }

  const placeholderId = `restream-pending-${crypto.randomBytes(8).toString('hex')}`;
  const record = await store.insertStream({
    broadcastId: placeholderId,
    viaRestream: true,
    restreamPending: true,
    title,
    description,
    privacy,
    scheduledStartTime,
    templateId: template.id,
    templateName: template.name,
    playlistId: template.playlistId || null,
    playlistTitle: template.playlistTitle || null,
    streamTo,
    variables,
    createdBy: req.session.user.username,
    watchUrl: null,
  });

  if (cover) restreamFlow.savePendingCover(record.id, cover);

  simulcastLog.info(`Restream: destinations set for "${title}" (YouTube: ${streamTo.youtube ? 'on' : 'off'}, Facebook: ${streamTo.facebook ? 'on' : 'off'}).`);
  cache.invalidate('history');

  res.status(201).json({
    stream: record,
    viaRestream: true,
    watchUrl: null,
    studioUrl: null,
    title,
    templateName: template.name,
    emailSubjectPattern: template.emailSubjectPattern || null,
    emailBodyPattern: template.emailBodyPattern || null,
    warning: warnings.length ? warnings.join(' ') : null,
  });
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const settings = await store.getSettings();

    if (settings.restream && settings.restream.enabled) {
      return createViaRestream(req, res, settings, body);
    }

    if (!(await store.hasYouTubeAuth())) {
      throw new AppError('YouTube is not connected. Connect it in Settings.', {
        status: 409,
        code: 'youtube_not_connected',
      });
    }
    const streamId = settings.youtube && settings.youtube.streamId;
    if (!streamId) {
      throw new AppError('The persistent stream key has not been set up yet. Ask an admin to finish setup.', {
        status: 409,
        code: 'no_stream',
      });
    }

    const template = await store.getTemplate(body.templateId);
    if (!template) throw new AppError('Please choose a template.', { status: 400, code: 'no_template' });

    // Validate required extra fields.
    const form = body.form || {};
    for (const field of template.extraFields || []) {
      if (field.required && !String(form[field.key] || '').trim()) {
        throw new AppError(`Please fill in "${field.label}".`, { status: 400, code: 'missing_field' });
      }
    }

    const privacy = PRIVACY.includes(body.privacy) ? body.privacy : template.defaultPrivacy;

    // Destinations: form override > template default > YouTube only.
    const tplStreamTo = template.streamTo || { youtube: true, facebook: false };
    const rawStreamTo = body.streamTo && typeof body.streamTo === 'object' ? body.streamTo : tplStreamTo;
    const streamTo = {
      youtube: rawStreamTo.youtube === undefined ? true : Boolean(rawStreamTo.youtube),
      facebook: Boolean(rawStreamTo.facebook),
    };
    if (!streamTo.youtube && !streamTo.facebook) streamTo.youtube = true;

    const scheduledStartTime = combineDateTime(form.date, form.time);
    const { title, description, variables } = templateEngine.resolve(template, settings, form);

    // 1) Create the broadcast (the video/event).
    const broadcast = await youtube.createBroadcast({ title, description, privacyStatus: privacy, scheduledStartTime });
    const broadcastId = broadcast.id;

    // 2) Bind it to the one persistent stream ATEM already points at.
    await youtube.bindBroadcast(broadcastId, streamId);

    // 3) Custom cover / thumbnail (per-event upload, else template default).
    let thumbnailWarning = null;
    let cover = null;
    try {
      cover = coverImages.decodeBase64Image(body.coverImageBase64, body.coverImageMime);
    } catch (err) {
      throw new AppError(err.message || 'Invalid cover image.', { status: 400, code: 'invalid_image' });
    }
    if (!cover) cover = coverImages.readTemplateCover(template.id);
    if (cover) {
      try {
        await youtube.setThumbnail(broadcastId, cover.buffer, cover.mimeType);
      } catch (err) {
        thumbnailWarning =
          'The stream was created but the cover image could not be set. Your YouTube channel may need to be verified for custom thumbnails.';
      }
    }

    // 4) Add the video to the template's playlist (best-effort — a playlist
    //    failure shouldn't invalidate an otherwise-created broadcast).
    let playlistWarning = null;
    if (template.playlistId) {
      try {
        await youtube.addToPlaylist(template.playlistId, broadcastId);
      } catch (err) {
        playlistWarning = 'The broadcast was created but could not be added to its playlist.';
      }
    }

    // 5) Record locally (template + resolved variables YouTube doesn't store).
    const record = await store.insertStream({
      broadcastId,
      title,
      description,
      privacy,
      scheduledStartTime,
      templateId: template.id,
      templateName: template.name,
      playlistId: template.playlistId || null,
      playlistTitle: template.playlistTitle || null,
      streamTo,
      variables,
      createdBy: req.session.user.username,
      watchUrl: watchUrl(broadcastId),
    });

    cache.invalidate('history'); // a new broadcast changes the list
    const warnings = [playlistWarning, thumbnailWarning].filter(Boolean);
    res.status(201).json({
      stream: record,
      watchUrl: watchUrl(broadcastId),
      studioUrl: studioUrl(broadcastId),
      title,
      templateName: template.name,
      emailSubjectPattern: template.emailSubjectPattern || null,
      emailBodyPattern: template.emailBodyPattern || null,
      warning: warnings.length ? warnings.join(' ') : null,
    });
  })
);

/* --------------------------------- History ------------------------------- */

const HISTORY_TTL_MS = 60 * 1000;

function buildPreviewBroadcast(broadcasts, ingestActive) {
  const candidates = broadcasts.filter((b) =>
    PREVIEW_BROADCAST_STATES.has((b.status && b.status.lifeCycleStatus) || '')
  );
  if (!candidates.length) return null;

  const pick =
    candidates.find((b) => b.status && b.status.lifeCycleStatus === 'live') ||
    candidates.find((b) => LIVE_BROADCAST_STATES.has((b.status && b.status.lifeCycleStatus) || '')) ||
    candidates[0];

  const lifeCycleStatus = (pick.status && pick.status.lifeCycleStatus) || '';
  const onAir = lifeCycleStatus === 'live';
  if (!onAir && !ingestActive) return null;

  const st = describeStatus(lifeCycleStatus);
  return {
    broadcastId: pick.id,
    title: pick.snippet && pick.snippet.title,
    lifeCycleStatus,
    statusLabel: st.label,
    scheduledStartTime: pick.snippet && pick.snippet.scheduledStartTime,
    actualStartTime: pick.snippet && pick.snippet.actualStartTime,
    privacy: pick.status && pick.status.privacyStatus,
    watchUrl: watchUrl(pick.id),
  };
}

async function buildHistory() {
  const [broadcasts, local, templates] = await Promise.all([
    youtube.listBroadcasts(50),
    store.listStreams(),
    store.listTemplates(),
  ]);
  const localByBroadcast = new Map(local.map((s) => [s.broadcastId, s]));
  const tplById = new Map(templates.map((t) => [t.id, t]));

  const rows = broadcasts.map((b) => {
    const status = describeStatus(b.status && b.status.lifeCycleStatus);
    const rec = localByBroadcast.get(b.id);
    if (rec) localByBroadcast.delete(b.id);
    const tpl = rec && rec.templateId ? tplById.get(rec.templateId) : null;
    const thumbs = (b.snippet && b.snippet.thumbnails) || {};
    const thumb = (thumbs.medium || thumbs.default || {}).url || null;
    return {
      broadcastId: b.id,
      title: b.snippet && b.snippet.title,
      scheduledStartTime: b.snippet && b.snippet.scheduledStartTime,
      actualStartTime: b.snippet && b.snippet.actualStartTime,
      actualEndTime: b.snippet && b.snippet.actualEndTime,
      privacy: b.status && b.status.privacyStatus,
      statusLabel: status.label,
      lifeCycleStatus: b.status && b.status.lifeCycleStatus,
      stuck: status.stuck,
      thumbnail: thumb,
      watchUrl: watchUrl(b.id),
      studioUrl: studioUrl(b.id),
      videoId: b.id,
      templateId: rec ? rec.templateId : null,
      templateName: rec ? rec.templateName : null,
      emailSubjectPattern: tpl ? tpl.emailSubjectPattern : null,
      emailBodyPattern: tpl ? tpl.emailBodyPattern : null,
      createdBy: rec ? rec.createdBy : null,
    };
  });

  // Include any local records not returned by YouTube (older than 50, etc),
  // plus Restream-mode events still waiting for their YouTube broadcast.
  for (const rec of localByBroadcast.values()) {
    const tpl = rec.templateId ? tplById.get(rec.templateId) : null;
    const pending = Boolean(rec.restreamPending);
    rows.push({
      broadcastId: rec.broadcastId,
      title: rec.title,
      scheduledStartTime: rec.scheduledStartTime,
      privacy: rec.privacy,
      statusLabel: pending ? 'Ready — start ATEM' : 'Ended',
      lifeCycleStatus: pending ? 'ready' : undefined,
      stuck: false,
      thumbnail: null,
      watchUrl: pending ? null : watchUrl(rec.broadcastId),
      studioUrl: pending ? null : studioUrl(rec.broadcastId),
      videoId: pending ? null : rec.broadcastId,
      templateId: rec.templateId || null,
      templateName: rec.templateName,
      emailSubjectPattern: tpl ? tpl.emailSubjectPattern : null,
      emailBodyPattern: tpl ? tpl.emailBodyPattern : null,
      createdBy: rec.createdBy,
      localOnly: true,
      viaRestream: Boolean(rec.viaRestream),
      restreamPending: pending,
    });
  }

  return rows;
}

router.get(
  '/monitor/live',
  asyncHandler(async (req, res) => {
    const settings = await store.getSettings();
    const streamId = settings.youtube && settings.youtube.streamId;
    const restreamMode = Boolean(settings.restream && settings.restream.enabled);

    // In Restream mode, attach any YouTube broadcasts Restream has created
    // since the last poll (applies playlist/thumbnail/privacy on link).
    if (restreamMode) {
      const linkResult = await restreamFlow.linkPendingStreams();
      if (linkResult.linked > 0) cache.invalidate('history');
    }

    let ingest = null;
    if (streamId && (await store.hasYouTubeAuth())) {
      try {
        const s = await youtube.getStream(streamId);
        if (s) {
          ingest = { streamId: s.streamId, streamStatus: s.streamStatus || null };
        }
      } catch (err) {
        ingest = { streamId, streamStatus: null, error: 'Could not read ingest status' };
      }
    }

    let live = null;
    let recent = null;
    let preview = null;
    if (await store.hasYouTubeAuth()) {
      const broadcasts = await youtube.listBroadcasts(25);
      const ingestActive = ingest && ingest.streamStatus === 'active';
      preview = buildPreviewBroadcast(broadcasts, ingestActive);
      if (broadcasts.length) {
        const b0 = broadcasts[0];
        const st0 = describeStatus(b0.status && b0.status.lifeCycleStatus);
        recent = {
          broadcastId: b0.id,
          title: b0.snippet && b0.snippet.title,
          statusLabel: st0.label,
          lifeCycleStatus: b0.status && b0.status.lifeCycleStatus,
        };
      }
      const active = broadcasts.filter((b) =>
        LIVE_BROADCAST_STATES.has((b.status && b.status.lifeCycleStatus) || '')
      );
      const pick =
        active.find((b) => b.status && b.status.lifeCycleStatus === 'live') || active[0];
      if (pick) {
        const st = describeStatus(pick.status && pick.status.lifeCycleStatus);
        live = {
          broadcastId: pick.id,
          title: pick.snippet && pick.snippet.title,
          lifeCycleStatus: pick.status && pick.status.lifeCycleStatus,
          statusLabel: st.label,
          scheduledStartTime: pick.snippet && pick.snippet.scheduledStartTime,
          actualStartTime: pick.snippet && pick.snippet.actualStartTime,
          privacy: pick.status && pick.status.privacyStatus,
          watchUrl: watchUrl(pick.id),
        };
      }
    }

    if (preview) {
      const local = await store.getStreamByBroadcastId(preview.broadcastId);
      if (local && local.templateName) preview.templateName = local.templateName;
      if (local && local.streamTo) preview.streamTo = local.streamTo;
      if (local && local.facebookPermalink) preview.facebookPermalink = local.facebookPermalink;
    }

    const activeBroadcastId = (settings.youtube && settings.youtube.activeBroadcastId) || null;

    // Facebook simulcast status + recent console log for the Stream Test page.
    const fb = settings.facebook || {};
    const relay = facebookRelay.status();
    const facebookStatus = {
      connected: await store.hasFacebookAuth(),
      pageId: fb.pageId || null,
      pageName: fb.pageName || null,
      activeLiveVideoId: fb.activeLiveVideoId || null,
      activeLiveVideoUrl: fb.activeLiveVideoUrl || null,
      relayRunning: relay.running,
      relayBroadcastId: relay.running ? relay.broadcastId : null,
    };

    const restreamStatus = {
      enabled: restreamMode,
      connected: restreamMode ? await store.hasRestreamAuth() : false,
      pendingCount: restreamMode ? (await store.listRestreamPendingStreams()).length : 0,
      live: null,
    };
    if (restreamMode && restreamStatus.connected) {
      try {
        const status = await restream.getStreamingStatus();
        restreamStatus.live = status.live;
      } catch (err) {
        restreamStatus.live = null; // unknown — don't block the monitor
      }
    }

    res.json({
      ingest,
      live,
      recent,
      preview,
      activeBroadcastId,
      facebook: facebookStatus,
      restream: restreamStatus,
      simulcastLog: simulcastLog.recent(50),
      checkedAt: new Date().toISOString(),
    });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const force = req.query.refresh === '1';
    const settings = await store.getSettings();
    const activeBroadcastId = (settings.youtube && settings.youtube.activeBroadcastId) || null;
    if (!force) {
      const cached = cache.get('history');
      if (cached) return res.json({ streams: cached, activeBroadcastId, cached: true });
    }
    const rows = await buildHistory();
    cache.set('history', rows, HISTORY_TTL_MS);
    res.json({ streams: rows, activeBroadcastId, cached: false });
  })
);

router.post(
  '/:id/go-live',
  asyncHandler(async (req, res) => {
    const settings = await store.getSettings();
    const streamId = settings.youtube && settings.youtube.streamId;

    const pendingRecord = await store.getStreamByBroadcastId(req.params.id);
    if (pendingRecord && pendingRecord.restreamPending) {
      throw new AppError(
        'This event goes live automatically when the Streamer (ATEM) starts pushing to Restream — no button needed.',
        { status: 409, code: 'restream_pending' }
      );
    }

    if (!(await store.hasYouTubeAuth())) {
      throw new AppError('YouTube is not connected. Connect it in Settings.', {
        status: 409,
        code: 'youtube_not_connected',
      });
    }
    if (!streamId) {
      throw new AppError('The persistent stream key has not been set up yet. Ask an admin to finish setup.', {
        status: 409,
        code: 'no_stream',
      });
    }

    const broadcastId = req.params.id;
    const updated = await youtube.goLiveBroadcast(broadcastId, streamId);
    await store.updateSettings({ youtube: { activeBroadcastId: broadcastId } });
    cache.invalidate('history');
    cache.invalidate('health');

    // Facebook simulcast (best-effort — never blocks the YouTube go-live).
    const facebookResult = await startFacebookSimulcast(broadcastId, settings);

    const lifeCycleStatus = (updated && updated.status && updated.status.lifeCycleStatus) || null;
    const status = describeStatus(lifeCycleStatus);
    res.json({
      ok: true,
      broadcastId,
      lifeCycleStatus,
      statusLabel: status.label,
      title: updated && updated.snippet && updated.snippet.title,
      facebook: facebookResult,
    });
  })
);

/**
 * If this stream is marked for Facebook, create a live video on the selected
 * page and start the ffmpeg relay from the YouTube feed. Failures are logged
 * to the simulcast console and reported as a warning, never as a hard error.
 */
async function startFacebookSimulcast(broadcastId, settings) {
  // Restream feeds Facebook directly — never run the local relay in that mode.
  if (settings.restream && settings.restream.enabled) return { requested: false };

  const record = await store.getStreamByBroadcastId(broadcastId);
  const wantsFacebook = Boolean(record && record.streamTo && record.streamTo.facebook);
  if (!wantsFacebook) return { requested: false };

  const fb = settings.facebook || {};
  try {
    if (!(await store.hasFacebookAuth())) {
      throw new AppError('Facebook is not connected. Connect it in Settings.', {
        status: 409,
        code: 'facebook_not_connected',
      });
    }
    if (!fb.pageId) {
      throw new AppError('No Facebook page selected. Pick one in Settings.', {
        status: 409,
        code: 'facebook_no_page',
      });
    }

    simulcastLog.info(`Creating Facebook live video on "${fb.pageName || fb.pageId}"…`);
    const live = await facebook.createLiveVideo(fb.pageId, {
      title: record.title,
      description: record.description,
    });
    if (!live.ingestUrl) {
      throw new AppError('Facebook did not return a stream URL for the live video.', {
        status: 502,
        code: 'facebook_error',
      });
    }

    await store.updateSettings({
      facebook: { activeLiveVideoId: live.liveVideoId, activeLiveVideoUrl: live.permalink },
    });
    await store.updateStreamByBroadcastId(broadcastId, {
      facebookLiveVideoId: live.liveVideoId,
      facebookPermalink: live.permalink,
    });

    await facebookRelay.start({
      broadcastId,
      liveVideoId: live.liveVideoId,
      watchUrl: watchUrl(broadcastId),
      ingestUrl: live.ingestUrl,
    });

    return { requested: true, ok: true, liveVideoId: live.liveVideoId, permalink: live.permalink };
  } catch (err) {
    const message = (err && err.message) || 'Facebook simulcast failed.';
    simulcastLog.error(message);
    return { requested: true, ok: false, error: message };
  }
}

router.post(
  '/:id/stop',
  asyncHandler(async (req, res) => {
    const pendingRecord = await store.getStreamByBroadcastId(req.params.id);
    if (pendingRecord && pendingRecord.restreamPending) {
      throw new AppError('This event has not gone live yet — stop the Streamer (ATEM) to end a Restream broadcast.', {
        status: 409,
        code: 'restream_pending',
      });
    }

    if (!(await store.hasYouTubeAuth())) {
      throw new AppError('YouTube is not connected.', { status: 409, code: 'youtube_not_connected' });
    }

    const broadcastId = req.params.id;
    const result = await youtube.stopBroadcast(broadcastId);
    const settings = await store.getSettings();
    if (settings.youtube && settings.youtube.activeBroadcastId === broadcastId) {
      await store.updateSettings({ youtube: { activeBroadcastId: null } });
    }

    // End the Facebook side too (best-effort).
    await stopFacebookSimulcast(broadcastId, settings);

    cache.invalidate('history');
    cache.invalidate('health');

    res.json({ ok: true, ...result, statusLabel: 'Ended' });
  })
);

async function stopFacebookSimulcast(broadcastId, settings) {
  const record = await store.getStreamByBroadcastId(broadcastId);
  const liveVideoId =
    (record && record.facebookLiveVideoId) ||
    (settings.facebook && settings.facebook.activeLiveVideoId) ||
    null;

  const relayStatus = facebookRelay.status();
  if (relayStatus.running && (relayStatus.broadcastId === broadcastId || !liveVideoId)) {
    await facebookRelay.stop('stream stopped');
  }
  if (!liveVideoId) return;

  try {
    const fb = settings.facebook || {};
    if (fb.pageId && (await store.hasFacebookAuth())) {
      await facebook.endLiveVideo(fb.pageId, liveVideoId);
      simulcastLog.info('Facebook live video ended.');
    }
  } catch (err) {
    simulcastLog.warn(`Could not end the Facebook live video: ${(err && err.message) || err}`);
  }
  if (settings.facebook && settings.facebook.activeLiveVideoId === liveVideoId) {
    await store.updateSettings({ facebook: { activeLiveVideoId: null, activeLiveVideoUrl: null } });
  }
}

router.get(
  '/:id/download',
  asyncHandler(async (req, res) => {
    if (!(await store.hasYouTubeAuth())) {
      throw new AppError('YouTube is not connected.', { status: 409, code: 'youtube_not_connected' });
    }

    const { watchUrl, title } = await videoDownload.assertDownloadable(req.params.id);
    const filename = `${videoDownload.safeFilename(title)}.mp4`;

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);

    await videoDownload.pipeYtDlpToResponse(watchUrl, res);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const b = await youtube.getBroadcast(req.params.id);
    if (!b) throw new AppError('That stream no longer exists on YouTube.', { status: 404, code: 'not_found' });
    res.json({ broadcast: b });
  })
);

// Inline privacy editor (§5.2).
router.put(
  '/:id/privacy',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const privacy = (req.body || {}).privacy;
    if (!PRIVACY.includes(privacy)) {
      throw new AppError('Privacy must be public, unlisted or private.', { status: 400, code: 'invalid' });
    }
    await youtube.updateBroadcastPrivacy(req.params.id, privacy);
    await store.updateStreamByBroadcastId(req.params.id, { privacy });
    cache.invalidate('history'); // reflect the change immediately
    res.json({ ok: true, privacy });
  })
);

// Cancel (and optionally recreate) a broadcast — recovery path for a broadcast
// stuck in testStarting/liveStarting (§7.1, §9.5).
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const recreate = req.query.recreate === '1';
    const prior = await store.getStreamByBroadcastId(req.params.id);

    // Pending Restream events only exist locally — just remove the record.
    if (prior && prior.restreamPending) {
      await store.deleteStreamByBroadcastId(req.params.id);
      cache.invalidate('history');
      return res.json({ ok: true, recreated: false });
    }

    await youtube.deleteBroadcast(req.params.id);
    await store.deleteStreamByBroadcastId(req.params.id);
    cache.invalidate('history');

    if (!recreate || !prior) return res.json({ ok: true, recreated: false });

    const settings = await store.getSettings();
    const streamId = settings.youtube && settings.youtube.streamId;
    const broadcast = await youtube.createBroadcast({
      title: prior.title,
      description: prior.description,
      privacyStatus: prior.privacy,
      scheduledStartTime: new Date().toISOString(),
    });
    await youtube.bindBroadcast(broadcast.id, streamId);
    if (prior.playlistId) {
      try {
        await youtube.addToPlaylist(prior.playlistId, broadcast.id);
      } catch (err) {
        /* best-effort */
      }
    }
    const record = await store.insertStream({
      broadcastId: broadcast.id,
      title: prior.title,
      description: prior.description,
      privacy: prior.privacy,
      scheduledStartTime: broadcast.snippet && broadcast.snippet.scheduledStartTime,
      templateId: prior.templateId,
      templateName: prior.templateName,
      playlistId: prior.playlistId,
      playlistTitle: prior.playlistTitle,
      variables: prior.variables,
      createdBy: req.session.user.username,
      watchUrl: watchUrl(broadcast.id),
    });
    cache.invalidate('history');
    res.json({ ok: true, recreated: true, stream: record, watchUrl: watchUrl(broadcast.id) });
  })
);

module.exports = router;
