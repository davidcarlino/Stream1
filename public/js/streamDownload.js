import { toast, busy } from './ui.js';

/**
 * Save an ended stream recording. In STREAM1 App (Electron) this opens a native
 * Save As dialog; in a plain browser it triggers a file download.
 */
export async function downloadStreamRecording(stream, { busyTarget } = {}) {
  const broadcastId = stream.broadcastId || stream.videoId;
  if (!broadcastId) {
    toast('Missing stream id.', 'err');
    return { ok: false };
  }

  if (busyTarget) busy(busyTarget, true, 'Preparing…');

  try {
    if (window.stream1 && typeof window.stream1.saveStreamDownload === 'function') {
      const result = await window.stream1.saveStreamDownload({
        broadcastId,
        title: stream.title || 'stream',
      });
      if (result.canceled) return { ok: false, canceled: true };
      if (!result.ok) {
        toast(result.error || 'Download failed.', 'err');
        return result;
      }
      toast('Recording saved.', 'ok');
      return result;
    }

    const url = `/api/streams/${encodeURIComponent(broadcastId)}/download`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      let message = 'Download failed.';
      try {
        const data = await res.json();
        if (data && data.error) message = data.error;
      } catch {
        /* not json */
      }
      toast(message, 'err');
      return { ok: false, error: message };
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/i.exec(disposition);
    const filename = match ? match[1] : `${(stream.title || 'stream').replace(/[<>:"/\\|?*]/g, '_')}.mp4`;

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);

    toast('Download started.', 'ok');
    return { ok: true };
  } catch (err) {
    toast(err.message || 'Download failed.', 'err');
    return { ok: false, error: err.message };
  } finally {
    if (busyTarget) busy(busyTarget, false, 'Download');
  }
}
