'use strict';

/**
 * Download ended stream recordings via yt-dlp (YouTube Data API has no file download).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AppError } = require('./middleware/errors');
const youtube = require('./youtube');

function resolveYtDlp() {
  const candidates = [
    process.env.STREAM1_YTDLP_PATH,
    // Packaged exe: extraResources land unpacked at resources/vendor/.
    process.resourcesPath ? path.join(process.resourcesPath, 'vendor', 'yt-dlp', 'yt-dlp.exe') : null,
    path.join(__dirname, '..', 'vendor', 'yt-dlp', 'yt-dlp.exe'),
    path.join(process.cwd(), 'vendor', 'yt-dlp', 'yt-dlp.exe'),
    path.join(__dirname, '..', 'bin', 'yt-dlp.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'yt-dlp';
}

function ytDlpAvailable() {
  const resolved = resolveYtDlp();
  if (resolved !== 'yt-dlp') return true;
  return false;
}

function safeFilename(title) {
  const base = String(title || 'stream')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return base || 'stream';
}

async function assertDownloadable(broadcastId) {
  const broadcast = await youtube.getBroadcast(broadcastId);
  if (!broadcast) {
    throw new AppError('That stream no longer exists on YouTube.', { status: 404, code: 'not_found' });
  }

  const lifeCycle = (broadcast.status && broadcast.status.lifeCycleStatus) || '';
  if (lifeCycle !== 'complete') {
    throw new AppError('Download is only available after the stream has ended.', {
      status: 400,
      code: 'not_ready',
    });
  }

  const video = await youtube.getVideo(broadcastId);
  const processing = video && video.processingDetails && video.processingDetails.processingStatus;
  if (processing && processing !== 'succeeded' && processing !== 'terminated') {
    throw new AppError('YouTube is still processing this recording. Try again in a few minutes.', {
      status: 409,
      code: 'processing',
    });
  }

  return {
    watchUrl: `https://www.youtube.com/watch?v=${broadcastId}`,
    title: (broadcast.snippet && broadcast.snippet.title) || 'stream',
  };
}

function pipeYtDlpToResponse(watchUrl, res) {
  const ytdlp = resolveYtDlp();
  if (ytdlp === 'yt-dlp' && !ytDlpAvailable()) {
    throw new AppError(
      'Recording download is not set up on this server. Run: npm run fetch:ytdlp',
      { status: 503, code: 'ytdlp_missing' }
    );
  }

  const args = [
    '-f',
    'best[ext=mp4]/best[ext=mkv]/best',
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '-o',
    '-',
    watchUrl,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(
        new AppError(err.code === 'ENOENT' ? 'yt-dlp was not found. Run: npm run fetch:ytdlp' : err.message, {
          status: 503,
          code: 'ytdlp_missing',
        })
      );
    });

    child.stdout.on('error', (err) => {
      if (!child.killed) child.kill();
      reject(err);
    });

    child.stdout.pipe(res);

    child.on('close', (code) => {
      if (code === 0 || res.writableEnded) {
        resolve();
        return;
      }
      const detail = (stderr || '').trim();
      const message = /private|unavailable|removed|members.only/i.test(detail)
        ? 'This recording cannot be downloaded from YouTube.'
        : detail || `Download failed (yt-dlp exit ${code}).`;
      reject(new AppError(message, { status: 502, code: 'download_failed' }));
    });

    res.on('close', () => {
      if (!child.killed) child.kill();
    });
  });
}

module.exports = {
  assertDownloadable,
  pipeYtDlpToResponse,
  safeFilename,
  resolveYtDlp,
  ytDlpAvailable,
};
