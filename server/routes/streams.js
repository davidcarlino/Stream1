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
const { sydneyDateTimeToIso } = require('../sydneyTime');
const { asyncHandler, AppError } = require('../middleware/errors');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const appAuth = require('../auth/appAuth');
const {
  normalizeStreamTo,
  assertFacebookAllowed,
  facebookAllowedForPrivacy,
} = require('../streamDestinations');

const router = express.Router();
const PRIVACY = ['public', 'unlisted', 'private'];

router.use(requireAuth);

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
function studioUrl(videoId) {
  return `https://studio.youtube.com/video/${videoId}/edit`;
}

function streamThumbnailPath(broadcastId) {
  const id = String(broadcastId || '').trim();
  if (!id || id.startsWith('restream-pending-')) return null;
  return `/api/streams/${encodeURIComponent(id)}/thumbnail`;
}

const LIVE_BROADCAST_STATES = new Set(['live', 'liveStarting', 'testStarting', 'testing']);
const PREVIEW_BROADCAST_STATES = new Set(['live', 'liveStarting', 'testStarting', 'testing', 'ready']);

// Combine the form's date (YYYY-MM-DD) + time (HH:MM) as Australia/Sydney
// wall-clock into a UTC ISO timestamp. Restream mode keeps past times (late
// create); direct YouTube mode bumps past times to "now" (YouTube rejects them).
function combineDateTime(date, time, { allowPast = false } = {}) {
  const iso = sydneyDateTimeToIso(date, time);
  if (!allowPast && new Date(iso).getTime() < Date.now()) return new Date().toISOString();
  return iso;
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
  if (template.allowCustomTitle && !String(form.customTitle || '').trim()) {
    throw new AppError('Please enter a custom title.', { status: 400, code: 'missing_field' });
  }
  if (template.allowCustomDescription && !String(form.customDescription || '').trim()) {
    throw new AppError('Please enter a custom description.', { status: 400, code: 'missing_field' });
  }

  const privacy = PRIVACY.includes(body.privacy) ? body.privacy : template.defaultPrivacy;

  const tplStreamTo = template.streamTo || { youtube: true, facebook: false };
  const rawStreamTo = body.streamTo && typeof body.streamTo === 'object' ? body.streamTo : tplStreamTo;
  assertFacebookAllowed(privacy, Boolean(rawStreamTo.facebook));
  const streamTo = normalizeStreamTo(rawStreamTo, privacy);

  // Block create when STREAM1 cannot manage Restream's YouTube channel
  // (privacy/title updates would be Forbidden and the live stays public).
  await restreamFlow.assertRestreamYouTubeWritable({ streamTo });

  const scheduledStartTime = combineDateTime(form.date, form.time, { allowPast: true });
  const { title, description, variables } = templateEngine.resolve(template, settings, form);

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

  // Schedule-aware: only push this event's title to Restream if it is the one
  // due next (e.g. creating 3pm while 8pm already exists → arm 3pm; creating
  // 8pm while 3pm is still upcoming → keep Restream titled for 3pm).
  const arm = await restreamFlow.syncArmedPending({ forcePush: true });
  const warnings = (arm && arm.warnings) || [];
  if (arm && arm.record && String(arm.record.id) === String(record.id)) {
    simulcastLog.info(
      `Restream: new pending "${title}" is armed for next ATEM go-live (YouTube: ${streamTo.youtube ? 'on' : 'off'}, Facebook: ${streamTo.facebook ? 'on' : 'off'}).`
    );
  } else if (arm && arm.record) {
    warnings.push(
      `Saved for ${scheduledStartTime || 'later'}. Restream is currently armed for "${arm.record.title}" ` +
        `(${arm.record.scheduledStartTime || 'sooner'}). When ATEM goes live near that time, that template is used; ` +
        `this one will arm automatically when its time window arrives.`
    );
    simulcastLog.info(
      `Restream: stored pending "${title}" but kept Restream armed for "${arm.record.title}".`
    );
  } else {
    // Fallback: push this event's meta anyway so a lone pending always works.
    const cfg = await restreamFlow.configureDestinations({
      title,
      description,
      streamTo,
      privacy,
    });
    warnings.push(...(cfg.warnings || []));
    simulcastLog.info(
      `Restream: destinations set for "${title}" (YouTube: ${streamTo.youtube ? 'on' : 'off'}, Facebook: ${streamTo.facebook ? 'on' : 'off'}).`
    );
  }

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
    smsBodyPattern: template.smsBodyPattern || null,
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
    if (template.allowCustomTitle && !String(form.customTitle || '').trim()) {
      throw new AppError('Please enter a custom title.', { status: 400, code: 'missing_field' });
    }
    if (template.allowCustomDescription && !String(form.customDescription || '').trim()) {
      throw new AppError('Please enter a custom description.', { status: 400, code: 'missing_field' });
    }

    const privacy = PRIVACY.includes(body.privacy) ? body.privacy : template.defaultPrivacy;

    // Destinations: form override > template default > YouTube only.
    // Facebook only when privacy is Public.
    const tplStreamTo = template.streamTo || { youtube: true, facebook: false };
    const rawStreamTo = body.streamTo && typeof body.streamTo === 'object' ? body.streamTo : tplStreamTo;
    assertFacebookAllowed(privacy, Boolean(rawStreamTo.facebook));
    const streamTo = normalizeStreamTo(rawStreamTo, privacy);

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
      smsBodyPattern: template.smsBodyPattern || null,
      warning: warnings.length ? warnings.join(' ') : null,
    });
  })
);

/* --------------------------------- History ------------------------------- */

const HISTORY_TTL_MS = 60 * 1000;

function buildPreviewBroadcast(broadcasts, signalActive, activeBroadcastId) {
  const candidates = broadcasts.filter((b) =>
    PREVIEW_BROADCAST_STATES.has((b.status && b.status.lifeCycleStatus) || '')
  );
  if (!candidates.length) return null;

  let pick = null;
  if (activeBroadcastId) {
    pick = candidates.find((b) => b.id === activeBroadcastId);
  }
  if (!pick) {
    pick =
      candidates.find((b) => b.status && b.status.lifeCycleStatus === 'live') ||
      candidates.find((b) => LIVE_BROADCAST_STATES.has((b.status && b.status.lifeCycleStatus) || '')) ||
      candidates[0];
  }

  const lifeCycleStatus = (pick.status && pick.status.lifeCycleStatus) || '';
  const onAir = lifeCycleStatus === 'live';
  // Always show embed when YouTube reports live; otherwise wait for encoder/Restream signal.
  if (!onAir && !signalActive) return null;

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
    const thumb = streamThumbnailPath(b.id);
    return {
      broadcastId: b.id,
      id: rec ? rec.id : null,
      title: b.snippet && b.snippet.title,
      description: (rec && rec.description) || (b.snippet && b.snippet.description) || '',
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
      smsBodyPattern: tpl ? tpl.smsBodyPattern : null,
      createdBy: rec ? rec.createdBy : null,
      viaRestream: Boolean(rec && rec.viaRestream),
      restreamPending: Boolean(rec && rec.restreamPending),
      facebookLiveVideoId: rec ? rec.facebookLiveVideoId : null,
      hidden: Boolean(rec && rec.hidden),
    };
  });

  // Include any local records not returned by YouTube (older than 50, etc),
  // plus Restream-mode events still waiting for their YouTube broadcast.
  for (const rec of localByBroadcast.values()) {
    const tpl = rec.templateId ? tplById.get(rec.templateId) : null;
    const pending = Boolean(rec.restreamPending);
    rows.push({
      broadcastId: rec.broadcastId,
      id: rec.id || null,
      title: rec.title,
      description: rec.description || '',
      scheduledStartTime: rec.scheduledStartTime,
      privacy: rec.privacy,
      statusLabel: pending ? 'Ready — start ATEM' : 'Ended',
      lifeCycleStatus: pending ? 'ready' : undefined,
      stuck: false,
      thumbnail: pending ? null : streamThumbnailPath(rec.broadcastId),
      watchUrl: pending ? null : watchUrl(rec.broadcastId),
      studioUrl: pending ? null : studioUrl(rec.broadcastId),
      videoId: pending ? null : rec.broadcastId,
      templateId: rec.templateId || null,
      templateName: rec.templateName,
      emailSubjectPattern: tpl ? tpl.emailSubjectPattern : null,
      emailBodyPattern: tpl ? tpl.emailBodyPattern : null,
      smsBodyPattern: tpl ? tpl.smsBodyPattern : null,
      createdBy: rec.createdBy,
      localOnly: true,
      viaRestream: Boolean(rec.viaRestream),
      restreamPending: pending,
      hidden: Boolean(rec.hidden),
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

    // In Restream mode: (1) arm the schedule-due pending event's title onto
    // Restream so ATEM go-live hits the right template (3pm vs 8pm), then
    // (2) link any NEW YouTube video Restream created (never reuse ended ones).
    if (restreamMode) {
      let restreamLiveHint = null;
      try {
        if (await store.hasRestreamAuth()) {
          const st = await restream.getStreamingStatus();
          restreamLiveHint = Boolean(st && st.live);
        }
      } catch (_) {}
      await restreamFlow.syncArmedPending({ restreamLive: restreamLiveHint });
      const linkResult = await restreamFlow.linkPendingStreams();
      if (linkResult.linked > 0) cache.invalidate('history');
      // Restream often creates YouTube lives as public — keep correcting until it sticks.
      try {
        await restreamFlow.enforceLinkedPrivacy();
      } catch (_) { /* non-fatal */ }
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

    const activeBroadcastId = (settings.youtube && settings.youtube.activeBroadcastId) || null;

    let restreamLive = null;
    let restreamPreview = null;
    let broadcasts = [];
    if (restreamMode && (await store.hasRestreamAuth())) {
      try {
        if (await store.hasYouTubeAuth()) {
          broadcasts = await youtube.listBroadcasts(25);
        }
        restreamPreview = await restream.resolveLivePreview(broadcasts);
        restreamLive = restreamPreview ? true : false;
        // Don't wait for full link — push unlisted/private as soon as Restream
        // exposes the YouTube video id (Restream often creates as public).
        if (restreamPreview && restreamPreview.youtubeVideoId) {
          try {
            await restreamFlow.enforceLivePreviewPrivacy(restreamPreview);
          } catch (_) { /* non-fatal */ }
        }
      } catch (err) {
        restreamLive = null;
        restreamPreview = null;
      }
    }

    let live = null;
    let recent = null;
    let preview = null;

    if (restreamPreview && restreamPreview.youtubeVideoId) {
      const st = describeStatus(restreamPreview.lifeCycleStatus);
      preview = {
        broadcastId: restreamPreview.youtubeVideoId,
        title: null, // filled below after local/YouTube/armed sources are known
        lifeCycleStatus: restreamPreview.lifeCycleStatus || 'live',
        statusLabel: st.label === 'Upcoming' && restreamLive ? 'Live' : st.label,
        watchUrl: restreamPreview.watchUrl || watchUrl(restreamPreview.youtubeVideoId),
        viaRestream: true,
      };
    }

    if (await store.hasYouTubeAuth()) {
      if (!broadcasts.length) broadcasts = await youtube.listBroadcasts(25);
      const ingestActive = ingest && ingest.streamStatus === 'active';
      const signalActive = ingestActive || restreamLive === true;
      const ytPreview = buildPreviewBroadcast(broadcasts, signalActive, activeBroadcastId);

      if (!preview && ytPreview) {
        preview = ytPreview;
      } else if (restreamLive && ytPreview && preview) {
        // Restream owns the video id; pull schedule/privacy (and title fallback) from YT.
        preview = {
          ...preview,
          statusLabel:
            preview.lifeCycleStatus === 'live'
              ? preview.statusLabel
              : (preview.statusLabel || ytPreview.statusLabel || 'Live'),
          scheduledStartTime: preview.scheduledStartTime || ytPreview.scheduledStartTime,
          actualStartTime: preview.actualStartTime || ytPreview.actualStartTime,
          privacy: preview.privacy || ytPreview.privacy,
          _ytTitle: ytPreview.title || null,
        };
      }
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
      let local = await store.getStreamByBroadcastId(preview.broadcastId);
      if (!local && settings.restream && settings.restream.armedStreamId) {
        try {
          local = await store.getStreamById(settings.restream.armedStreamId);
        } catch (_) { /* ignore */ }
      }
      const ytMatch = broadcasts.find((b) => b.id === preview.broadcastId);
      const ytTitle = (ytMatch && ytMatch.snippet && ytMatch.snippet.title)
        || preview._ytTitle
        || null;
      delete preview._ytTitle;

      // Prefer real event name: local DB → armed schedule → YouTube → Restream.
      // Restream often keeps a generic channel label like
      // "Stream via RTMP (OBS, Vmix, Zoom) with Restream".
      const restreamTitle = restreamPreview && restreamPreview.title;
      const looksGeneric = (t) => {
        const s = String(t || '').toLowerCase();
        return !s
          || s.includes('stream via rtmp')
          || s.includes('obs, vmix')
          || s === 'live stream'
          || s === 'untitled broadcast'
          || s === 'untitled event';
      };
      const eventTitle =
        (local && local.title)
        || (settings.restream && settings.restream.armedTitle)
        || (!looksGeneric(ytTitle) ? ytTitle : null)
        || (!looksGeneric(restreamTitle) ? restreamTitle : null)
        || ytTitle
        || restreamTitle
        || 'Untitled event';
      preview.title = eventTitle;
      if (restreamPreview) restreamPreview = { ...restreamPreview, title: eventTitle };

      if (local && local.templateName) preview.templateName = local.templateName;
      if (local && local.streamTo) preview.streamTo = local.streamTo;
      if (local && local.facebookPermalink) preview.facebookPermalink = local.facebookPermalink;
      // Restream-mode: prefer the live Facebook permalink Restream just created.
      if (restreamPreview && restreamPreview.facebookPermalink) {
        const retiredFb = new Set(
          ((settings.restream && settings.restream.retiredFacebookLiveIds) || []).map(String)
        );
        const fbId = restreamPreview.facebookLiveVideoId
          ? String(restreamPreview.facebookLiveVideoId)
          : null;
        if (!fbId || !retiredFb.has(fbId)) {
          preview.facebookPermalink = restreamPreview.facebookPermalink;
          if (fbId) preview.facebookLiveVideoId = fbId;
        }
      }
    }

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

    const pendingList = restreamMode ? await store.listRestreamPendingStreams() : [];
    const restreamStatus = {
      enabled: restreamMode,
      connected: restreamMode ? await store.hasRestreamAuth() : false,
      pendingCount: pendingList.length,
      live: restreamMode ? restreamLive : null,
      armedStreamId: (settings.restream && settings.restream.armedStreamId) || null,
      armedTitle: (settings.restream && settings.restream.armedTitle) || null,
    };

    // Upcoming / ready events for Stream Test (sorted by scheduled start).
    // Only unfinished events — finished streams must leave this list.
    const upcoming = [];
    const seenUpcoming = new Set();
    const pushUpcoming = (row) => {
      const key = String(row.id || row.watchUrl || row.title || '');
      if (!key || seenUpcoming.has(key)) return;
      seenUpcoming.add(key);
      upcoming.push(row);
    };

    const liveWatchUrl =
      (restreamPreview && restreamPreview.youtubeVideoId && (restreamPreview.watchUrl || watchUrl(restreamPreview.youtubeVideoId)))
      || (preview && preview.watchUrl)
      || (live && live.watchUrl)
      || null;
    const liveFbUrl =
      (preview && preview.facebookPermalink)
      || (restreamPreview && restreamPreview.facebookPermalink)
      || null;
    const liveVideoId =
      (restreamPreview && restreamPreview.youtubeVideoId)
      || (preview && preview.broadcastId)
      || (live && live.broadcastId)
      || null;

    // After Restream live status is known, settle finished events (drop from Next).
    if (restreamMode) {
      try {
        await restreamFlow.settleFinishedStreams({
          restreamLive,
          liveVideoId,
        });
      } catch (_) { /* non-fatal */ }
      // Refresh arming fields after settle may have cleared them.
      const settingsAfter = await store.getSettings();
      restreamStatus.armedStreamId = (settingsAfter.restream && settingsAfter.restream.armedStreamId) || null;
      restreamStatus.armedTitle = (settingsAfter.restream && settingsAfter.restream.armedTitle) || null;
    }

    // Re-read pending after settle so ended rows are gone.
    const pendingForUpcoming = restreamMode
      ? await store.listRestreamPendingStreams()
      : [];
    if (restreamMode) {
      restreamStatus.pendingCount = pendingForUpcoming.length;
    }

    if (restreamMode) {
      for (const rec of pendingForUpcoming) {
        if (rec.endedAt) continue;
        const armed = String(restreamStatus.armedStreamId || '') === String(rec.id);
        // When Restream is already live, attach the live YouTube/FB links to the armed/due row
        // so Public / Private Link can copy immediately.
        const useLiveLinks = Boolean(armed && liveWatchUrl);
        pushUpcoming({
          id: rec.id,
          title: rec.title || 'Untitled event',
          templateName: rec.templateName || null,
          scheduledStartTime: rec.scheduledStartTime || null,
          privacy: rec.privacy || null,
          streamTo: {
            youtube: !(rec.streamTo && rec.streamTo.youtube === false),
            facebook: Boolean(rec.streamTo && rec.streamTo.facebook),
          },
          armed,
          restreamPending: true,
          watchUrl: useLiveLinks ? liveWatchUrl : (rec.watchUrl || null),
          facebookPermalink: useLiveLinks
            ? (liveFbUrl || rec.facebookPermalink || null)
            : (rec.facebookPermalink || null),
        });
      }

      // Only keep a linked Restream stream in "Next" while it is the current live.
      // Finished / VOD linked streams belong on Streams history, not here.
      if (liveVideoId && restreamLive) {
        const locals = await store.listStreams().catch(() => []);
        const liveRec = locals.find(
          (rec) =>
            rec.viaRestream &&
            !rec.restreamPending &&
            !rec.endedAt &&
            !rec.hidden &&
            String(rec.broadcastId || '') === String(liveVideoId)
        );
        if (liveRec) {
          pushUpcoming({
            id: liveRec.id || liveVideoId,
            title: liveRec.title || 'Untitled event',
            templateName: liveRec.templateName || null,
            scheduledStartTime: liveRec.scheduledStartTime || null,
            privacy: liveRec.privacy || null,
            streamTo: {
              youtube: !(liveRec.streamTo && liveRec.streamTo.youtube === false),
              facebook: Boolean(liveRec.streamTo && liveRec.streamTo.facebook),
            },
            armed: true,
            restreamPending: false,
            watchUrl: liveRec.watchUrl || watchUrl(liveVideoId),
            facebookPermalink: liveRec.facebookPermalink || liveFbUrl || null,
          });
        }
      }
    } else if (await store.hasYouTubeAuth()) {
      // Direct YouTube mode: show upcoming (not yet live) broadcasts from YT list.
      const list = broadcasts.length ? broadcasts : await youtube.listBroadcasts(25).catch(() => []);
      const locals = await store.listStreams().catch(() => []);
      const localById = new Map(locals.map((r) => [String(r.broadcastId), r]));
      for (const b of list) {
        const life = (b.status && b.status.lifeCycleStatus) || '';
        if (!['created', 'ready', 'testStarting', 'testing', 'live', 'liveStarting'].includes(life)) continue;
        const local = localById.get(String(b.id));
        if (local && local.endedAt) continue;
        pushUpcoming({
          id: b.id,
          title: (b.snippet && b.snippet.title) || (local && local.title) || 'Untitled',
          templateName: (local && local.templateName) || null,
          scheduledStartTime:
            (b.snippet && b.snippet.scheduledStartTime) ||
            (local && local.scheduledStartTime) ||
            null,
          privacy: (b.status && b.status.privacyStatus) || (local && local.privacy) || null,
          streamTo: {
            youtube: true,
            facebook: Boolean(local && local.streamTo && local.streamTo.facebook),
          },
          armed: false,
          restreamPending: false,
          watchUrl: watchUrl(b.id),
          facebookPermalink: (local && local.facebookPermalink) || null,
        });
      }
    }
    upcoming.sort((a, b) => {
      const ta = a.scheduledStartTime ? new Date(a.scheduledStartTime).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.scheduledStartTime ? new Date(b.scheduledStartTime).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

    res.json({
      ingest,
      live,
      recent,
      preview,
      activeBroadcastId,
      restreamPreview,
      upcoming,
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
      if (cached) {
        return res.json({
          streams: cached.filter((row) => !row.hidden),
          activeBroadcastId,
          cached: true,
        });
      }
    }
    const rows = (await buildHistory()).filter((row) => !row.hidden);
    cache.set('history', rows, HISTORY_TTL_MS);
    res.json({ streams: rows, activeBroadcastId, cached: false });
  })
);

router.get(
  '/hidden',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = (await buildHistory()).filter((row) => row.hidden);
    res.json({ streams: rows });
  })
);

/** Same-origin YouTube thumbnail (avoids CSP / CDN host issues in the browser). */
router.get(
  '/:id/thumbnail',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id || id.startsWith('restream-pending-')) {
      throw new AppError('No thumbnail for this stream.', { status: 404, code: 'not_found' });
    }

    const tryFetch = async (url) => {
      const imgRes = await fetch(url, { redirect: 'follow' });
      if (!imgRes.ok) return null;
      const type = imgRes.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length < 200) return null;
      return { type, buf };
    };

    const candidates = [];
    if (await store.hasYouTubeAuth()) {
      try {
        const map = await youtube.listVideoThumbnails([id]);
        const apiUrl = map.get(id);
        if (apiUrl) candidates.push(apiUrl);
      } catch (err) {
        /* fall through to CDN defaults */
      }
    }
    candidates.push(
      youtube.defaultThumbnailUrl(id),
      `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`
    );

    for (const url of candidates) {
      if (!url) continue;
      // eslint-disable-next-line no-await-in-loop
      const img = await tryFetch(url);
      if (img) {
        res.set('Content-Type', img.type);
        res.set('Cache-Control', 'private, max-age=300');
        return res.send(img.buf);
      }
    }

    throw new AppError('Thumbnail not available.', { status: 404, code: 'not_found' });
  })
);

async function ensureStreamRecordForHide(broadcastId) {
  const existing = await store.getStreamByBroadcastId(broadcastId);
  if (existing) return existing;

  let title = 'Untitled';
  let privacy = 'unlisted';
  let scheduledStartTime = null;
  if (await store.hasYouTubeAuth()) {
    try {
      const broadcast = await youtube.getBroadcast(broadcastId);
      if (broadcast) {
        title = (broadcast.snippet && broadcast.snippet.title) || title;
        privacy = (broadcast.status && broadcast.status.privacyStatus) || privacy;
        scheduledStartTime = broadcast.snippet && broadcast.snippet.scheduledStartTime;
      }
    } catch {
      /* local stub is enough */
    }
  }

  return store.insertStream({
    broadcastId,
    title,
    privacy,
    scheduledStartTime,
    hidden: true,
    hiddenAt: new Date(),
  });
}

router.put(
  '/:id/hidden',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const hidden = Boolean((req.body || {}).hidden);
    const broadcastId = req.params.id;
    let rec = await store.getStreamByBroadcastId(broadcastId);

    if (!rec) {
      if (!hidden) {
        return res.json({ ok: true, hidden: false });
      }
      rec = await ensureStreamRecordForHide(broadcastId);
    } else if (hidden) {
      await store.updateStreamByBroadcastId(broadcastId, { hidden: true, hiddenAt: new Date() });
    } else {
      await store.updateStreamById(rec.id, { hidden: false }, ['hiddenAt']);
    }

    cache.invalidate('history');
    res.json({ ok: true, hidden });
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
  const wantsFacebook =
    Boolean(record && record.streamTo && record.streamTo.facebook) &&
    facebookAllowedForPrivacy(record && record.privacy);
  if (!wantsFacebook) {
    if (record && record.streamTo && record.streamTo.facebook && !facebookAllowedForPrivacy(record.privacy)) {
      simulcastLog.info(
        `Skipping Facebook simulcast for "${record.title}" — privacy is ${record.privacy} (Public required).`
      );
    }
    return { requested: false };
  }

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
      privacy: record.privacy,
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

    // Retire this YouTube video forever — Restream must never feed it again.
    const retired = new Set(
      ((settings.restream && settings.restream.retiredBroadcastIds) || []).map(String)
    );
    retired.add(String(broadcastId));

    // Retire the Facebook live for this stream too (Restream or local relay).
    const recordForFb = await store.getStreamByBroadcastId(broadcastId);
    const retiredFb = new Set(
      ((settings.restream && settings.restream.retiredFacebookLiveIds) || []).map(String)
    );
    if (recordForFb && recordForFb.facebookLiveVideoId) {
      retiredFb.add(String(recordForFb.facebookLiveVideoId));
    }
    if (settings.facebook && settings.facebook.activeLiveVideoId) {
      retiredFb.add(String(settings.facebook.activeLiveVideoId));
    }

    await store.updateSettings({
      restream: {
        retiredBroadcastIds: Array.from(retired).slice(-200),
        retiredFacebookLiveIds: Array.from(retiredFb).slice(-200),
      },
    });
    simulcastLog.info(`Restream: retired ended YouTube broadcast ${broadcastId} — will not reuse.`);

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

// Edit title / date / time for upcoming or Restream-pending streams.
// Pushes to Restream channel meta (and re-arms if this is the due event),
// YouTube broadcast snippet, and Facebook live meta when available.
router.put(
  '/:id/details',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const title = String(body.title || '').trim().slice(0, 100);
    if (!title) {
      throw new AppError('Title is required.', { status: 400, code: 'invalid' });
    }

    const settings = await store.getSettings();
    const restreamMode = Boolean(settings.restream && settings.restream.enabled);
    const id = req.params.id;

    let record = await store.getStreamByBroadcastId(id);
    if (!record && store.getStreamById) {
      try {
        record = await store.getStreamById(id);
      } catch (_) { /* ignore */ }
    }
    if (!record) {
      // Direct YouTube broadcast with no local row yet — allow edit via YT only.
      record = {
        broadcastId: id,
        title: null,
        description: '',
        restreamPending: false,
        viaRestream: false,
        streamTo: { youtube: true, facebook: false },
      };
    }

    const pending = Boolean(record.restreamPending);
    const life = record.lifeCycleStatus || '';
    // Only allow edit before the stream has gone live / ended.
    if (!pending) {
      if (life === 'live' || life === 'liveStarting' || life === 'complete' || life === 'revoked') {
        throw new AppError('This stream has already started or ended — title/time can no longer be edited here.', {
          status: 409,
          code: 'not_editable',
        });
      }
      // Also refuse if YouTube says it's live/ended.
      if (!String(id).startsWith('restream-pending-') && (await store.hasYouTubeAuth())) {
        try {
          const b = await youtube.getBroadcast(id);
          const st = (b && b.status && b.status.lifeCycleStatus) || '';
          if (['live', 'liveStarting', 'complete', 'revoked'].includes(st)) {
            throw new AppError('This stream has already started or ended on YouTube — edit is not allowed.', {
              status: 409,
              code: 'not_editable',
            });
          }
        } catch (err) {
          if (err && err.code === 'not_editable') throw err;
          /* non-fatal probe */
        }
      }
    }

    let scheduledStartTime = record.scheduledStartTime || null;
    if (body.date || body.time) {
      scheduledStartTime = combineDateTime(body.date, body.time, {
        allowPast: Boolean(pending || restreamMode),
      });
    } else if (body.scheduledStartTime) {
      const d = new Date(body.scheduledStartTime);
      if (!Number.isNaN(d.getTime())) scheduledStartTime = d.toISOString();
    }

    const description =
      body.description !== undefined && body.description !== null
        ? String(body.description)
        : record.description || '';

    const patch = {
      title,
      description,
      scheduledStartTime,
      updatedAt: new Date(),
    };

    if (record.id) {
      await store.updateStreamById(record.id, patch);
    } else if (record.broadcastId) {
      await store.updateStreamByBroadcastId(record.broadcastId, patch);
    } else {
      // Create a local audit row so Streams page keeps the edit.
      record = await store.insertStream({
        broadcastId: id,
        title,
        description,
        scheduledStartTime,
        privacy: record.privacy || 'unlisted',
        streamTo: record.streamTo || { youtube: true, facebook: false },
        createdBy: req.session.user.username,
        watchUrl: watchUrl(id),
      });
    }

    const updated = record.id
      ? await store.getStreamById(record.id)
      : await store.getStreamByBroadcastId(record.broadcastId || id);

    const pushed = { restream: false, youtube: false, facebook: false };
    const warnings = [];

    // Restream: push title/description only if this event is (or becomes) the
    // armed/due one — never overwrite Restream meta for a different due event.
    if (restreamMode && (updated.viaRestream || updated.restreamPending)) {
      try {
        const isArmed =
          String((settings.restream && settings.restream.armedStreamId) || '') ===
          String(updated.id || '');

        if (isArmed) {
          const streamTo = normalizeStreamTo(
            updated.streamTo || { youtube: true, facebook: false },
            updated.privacy || 'unlisted'
          );
          const cfg = await restreamFlow.configureDestinations({
            title,
            description,
            streamTo,
            privacy: updated.privacy || 'unlisted',
            endLeftovers: false,
          });
          pushed.restream = true;
          warnings.push(...(cfg.warnings || []));
          await store.updateSettings({ restream: { armedTitle: title } });
        } else if (updated.restreamPending) {
          // Re-evaluate which pending is due; only push if THIS edit is now due.
          const arm = await restreamFlow.syncArmedPending({ forcePush: true });
          if (arm && arm.record && String(arm.record.id) === String(updated.id)) {
            pushed.restream = true;
            warnings.push(...(arm.warnings || []));
          } else {
            // Saved locally; Restream still armed for another event — will pick
            // up this title when its schedule window arrives.
            warnings.push(
              arm && arm.record
                ? `Saved. Restream stays armed for "${arm.record.title}" until its time window; this event will push automatically when due.`
                : 'Saved locally. Restream will receive this title when the event is armed.'
            );
          }
        }
      } catch (err) {
        warnings.push(`Restream: ${(err && err.message) || err}`);
      }
    }

    // YouTube: update broadcast title / schedule when a real video id exists.
    const ytId = updated.broadcastId || id;
    if (
      ytId &&
      !String(ytId).startsWith('restream-pending-') &&
      !updated.restreamPending &&
      (await store.hasYouTubeAuth())
    ) {
      try {
        await youtube.updateBroadcastTitle(ytId, title, {
          description,
          scheduledStartTime,
        });
        pushed.youtube = true;
      } catch (err) {
        warnings.push(`YouTube: ${(err && err.message) || err}`);
      }
    }

    // Facebook: update live video title when we have a linked live id.
    const pageId = settings.facebook && settings.facebook.pageId;
    const fbLiveId = updated.facebookLiveVideoId;
    if (pageId && fbLiveId && (await store.hasFacebookAuth())) {
      try {
        await facebook.updateLiveVideoMeta(pageId, fbLiveId, { title, description });
        pushed.facebook = true;
      } catch (err) {
        warnings.push(`Facebook: ${(err && err.message) || err}`);
      }
    }

    cache.invalidate('history');
    simulcastLog.info(
      `Stream details updated: "${title}" (${ytId}) — restream=${pushed.restream} youtube=${pushed.youtube} facebook=${pushed.facebook}`
    );

    res.json({
      ok: true,
      stream: {
        broadcastId: updated.broadcastId || ytId,
        id: updated.id || null,
        title: updated.title,
        description: updated.description,
        scheduledStartTime: updated.scheduledStartTime,
        restreamPending: Boolean(updated.restreamPending),
      },
      pushed,
      warning: warnings.length ? warnings.join(' ') : null,
    });
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
    await youtube.ensureBroadcastPrivacy(req.params.id, privacy, { attempts: 3, delayMs: 1000 });
    await store.updateStreamByBroadcastId(req.params.id, { privacy });

    const record = await store.getStreamByBroadcastId(req.params.id);
    const settings = await store.getSettings();
    const restreamMode = Boolean(settings.restream && settings.restream.enabled);

    // Restream: if privacy leaves Public, force Facebook off on every Restream FB channel.
    if (restreamMode && record && (record.viaRestream || record.restreamPending)) {
      const nextStreamTo = normalizeStreamTo(record.streamTo || { youtube: true, facebook: false }, privacy);
      if (JSON.stringify(nextStreamTo) !== JSON.stringify(record.streamTo || {})) {
        await store.updateStreamByBroadcastId(req.params.id, { streamTo: nextStreamTo });
      }
      const isArmed =
        String((settings.restream && settings.restream.armedStreamId) || '') === String(record.id || '');
      if (isArmed || !facebookAllowedForPrivacy(privacy)) {
        try {
          await restreamFlow.configureDestinations({
            title: record.title,
            description: record.description || '',
            streamTo: nextStreamTo,
            privacy,
            endLeftovers: false,
          });
        } catch (err) {
          simulcastLog.warn(
            `Restream: could not re-apply destinations after privacy → ${privacy}: ${(err && err.message) || err}`
          );
        }
      }
    }

    // Best-effort Facebook privacy when this stream has a linked FB live (local relay).
    // Restream-owned Facebook lives usually cannot be edited with our Page token.
    const pageId = settings.facebook && settings.facebook.pageId;
    const fbLiveId = record && record.facebookLiveVideoId;
    let facebookPrivacy = null;
    if (pageId && fbLiveId && !restreamMode) {
      try {
        await facebook.updateLiveVideoPrivacy(pageId, fbLiveId, privacy);
        facebookPrivacy = privacy;
      } catch (err) {
        facebookPrivacy = {
          error: (err && err.message) || 'Could not update Facebook privacy',
        };
      }
    }

    cache.invalidate('history'); // reflect the change immediately
    res.json({ ok: true, privacy, facebookPrivacy });
  })
);

// Cancel (and optionally recreate) a broadcast — recovery path for a broadcast
// stuck in testStarting/liveStarting (§7.1, §9.5).
router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    await appAuth.verifyAdminCredentials(body.username, body.password);

    const recreate = req.query.recreate === '1';
    const prior = await store.getStreamByBroadcastId(req.params.id);
    const settings = await store.getSettings();
    const restreamMode = Boolean(settings.restream && settings.restream.enabled);
    const viaRestream = Boolean(prior && prior.viaRestream) || restreamMode;

    // Pending Restream events only exist locally — just remove the record.
    if (prior && prior.restreamPending) {
      await store.deleteStreamByBroadcastId(req.params.id);
      cache.invalidate('history');
      return res.json({ ok: true, recreated: false, youtubeDeleted: false, localOnly: true });
    }

    // Try to remove/end on YouTube. Restream-created lives often refuse
    // liveBroadcasts.delete (insufficientLivePermissions) — we still remove
    // the STREAM1 record so Delete always works in the app.
    let youtubeResult = null;
    let youtubeWarning = null;
    try {
      youtubeResult = await youtube.deleteBroadcast(req.params.id);
    } catch (err) {
      if (viaRestream) {
        youtubeWarning =
          (err && err.message) ||
          'YouTube would not delete this Restream-created video. Removed from STREAM1 only — delete it in YouTube Studio if needed.';
        simulcastLog.warn(
          `Delete ${req.params.id}: YouTube refused — removing local record only. ${(err && err.message) || err}`
        );
      } else {
        throw err;
      }
    }

    // Never reuse this video id for a future Restream link.
    if (viaRestream && req.params.id && !String(req.params.id).startsWith('restream-pending-')) {
      try {
        const retired = new Set(
          ((settings.restream && settings.restream.retiredBroadcastIds) || []).map(String)
        );
        retired.add(String(req.params.id));
        await store.updateSettings({
          restream: { retiredBroadcastIds: Array.from(retired).slice(-200) },
        });
      } catch (_) { /* non-fatal */ }
    }

    await store.deleteStreamByBroadcastId(req.params.id);
    cache.invalidate('history');

    if (!recreate || !prior) {
      return res.json({
        ok: true,
        recreated: false,
        youtubeDeleted: Boolean(youtubeResult && youtubeResult.deleted),
        youtubeEnded: Boolean(youtubeResult && youtubeResult.ended),
        youtubeWarning: youtubeWarning || null,
      });
    }

    if (restreamMode) {
      // In Restream mode we never create the YouTube broadcast directly here.
      return res.json({
        ok: true,
        recreated: false,
        youtubeWarning: youtubeWarning || null,
        note: 'Restream mode is on — no direct YouTube broadcast created. Use New Stream to push a new title to Restream.',
      });
    }

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
      scheduledStartTime: new Date().toISOString(),
      templateId: prior.templateId,
      templateName: prior.templateName,
      playlistId: prior.playlistId || null,
      playlistTitle: prior.playlistTitle || null,
      streamTo: prior.streamTo || { youtube: true, facebook: false },
      variables: prior.variables || {},
      createdBy: req.session.user.username,
      watchUrl: watchUrl(broadcast.id),
    });
    cache.invalidate('history');
    res.status(201).json({ ok: true, recreated: true, stream: record });
  })
);

module.exports = router;
