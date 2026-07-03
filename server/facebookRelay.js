'use strict';

/**
 * Facebook simulcast relay.
 *
 * ATEM pushes ONE feed to YouTube. YouTube's API cannot forward that feed to
 * Facebook, so this relay pulls the public YouTube live HLS (resolved with
 * yt-dlp) and re-pushes it, without re-encoding (-c copy), to the Facebook
 * live video's RTMPS ingest using ffmpeg.
 *
 * Limitation: yt-dlp can only read public/unlisted broadcasts. A PRIVATE
 * YouTube stream cannot be relayed — the UI/log surfaces this clearly.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveYtDlp } = require('./videoDownload');
const simulcastLog = require('./simulcastLog');

let current = null; // { broadcastId, liveVideoId, proc, startedAt, stopping }

function resolveFfmpeg() {
  const candidates = [
    process.env.STREAM1_FFMPEG_PATH,
    // Packaged exe: extraResources land unpacked at resources/vendor/.
    process.resourcesPath ? path.join(process.resourcesPath, 'vendor', 'ffmpeg', 'ffmpeg.exe') : null,
    path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe'),
    path.join(process.cwd(), 'vendor', 'ffmpeg', 'ffmpeg.exe'),
    path.join(__dirname, '..', 'bin', 'ffmpeg.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'ffmpeg';
}

function ffmpegAvailable() {
  return resolveFfmpeg() !== 'ffmpeg';
}

/** Resolve the direct HLS manifest URL of a live YouTube watch page. */
function resolveYouTubeHls(watchUrl) {
  return new Promise((resolve, reject) => {
    const ytdlp = resolveYtDlp();
    const child = spawn(ytdlp, ['-g', '-f', 'best', '--no-warnings', watchUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', (e) =>
      reject(new Error(e.code === 'ENOENT' ? 'yt-dlp not found — run: npm run fetch:ytdlp' : e.message))
    );
    child.on('close', (code) => {
      const url = out.trim().split(/\r?\n/).filter(Boolean)[0];
      if (code === 0 && url) return resolve(url);
      const detail = (err || '').trim().split(/\r?\n/).slice(-2).join(' ');
      reject(
        new Error(
          /private|members.only|sign in/i.test(detail)
            ? 'YouTube broadcast is private — Facebook relay needs a public or unlisted stream.'
            : detail || `Could not resolve the YouTube live feed (yt-dlp exit ${code}).`
        )
      );
    });
  });
}

/**
 * Start relaying a live YouTube broadcast into a Facebook RTMPS ingest.
 * Stops any previous relay first (one simulcast at a time).
 */
async function start({ broadcastId, liveVideoId, watchUrl, ingestUrl }) {
  await stop('replaced by a new stream');

  const ffmpeg = resolveFfmpeg(); // falls back to PATH; spawn 'error' reports if missing

  simulcastLog.info(`Resolving YouTube live feed for ${broadcastId}…`);
  const hlsUrl = await resolveYouTubeHls(watchUrl);
  simulcastLog.info('YouTube feed resolved. Starting ffmpeg relay to Facebook…');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-re',
    '-i', hlsUrl,
    '-c', 'copy',
    '-f', 'flv',
    ingestUrl,
  ];

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  current = { broadcastId, liveVideoId, proc, startedAt: new Date(), stopping: false };

  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  proc.on('error', (err) => {
    simulcastLog.error(
      err.code === 'ENOENT'
        ? 'ffmpeg was not found. Run: npm run fetch:ffmpeg (or set STREAM1_FFMPEG_PATH).'
        : `ffmpeg failed to start: ${err.message}`
    );
    if (current && current.proc === proc) current = null;
  });

  proc.on('close', (code) => {
    const wasStopping = current && current.proc === proc && current.stopping;
    if (current && current.proc === proc) current = null;
    if (wasStopping || code === 0) {
      simulcastLog.info('Facebook relay stopped.');
      return;
    }
    const tail = stderrTail.trim().split(/\r?\n/).slice(-3).join(' | ');
    simulcastLog.error(`Facebook relay exited unexpectedly (code ${code}). ${tail || ''}`.trim());
  });

  simulcastLog.info(`Relay running: YouTube ${broadcastId} → Facebook live video ${liveVideoId}.`);
  return { started: true };
}

/** Stop the current relay (if any). */
async function stop(reason) {
  if (!current || !current.proc) return { stopped: false };
  const c = current;
  c.stopping = true;
  simulcastLog.info(`Stopping Facebook relay${reason ? ` (${reason})` : ''}…`);
  try {
    c.proc.kill();
  } catch (err) {
    /* already gone */
  }
  current = null;
  return { stopped: true };
}

function status() {
  if (!current) return { running: false };
  return {
    running: true,
    broadcastId: current.broadcastId,
    liveVideoId: current.liveVideoId,
    startedAt: current.startedAt,
  };
}

module.exports = { start, stop, status, resolveFfmpeg, ffmpegAvailable };
