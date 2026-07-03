/** Build YouTube embed URLs that work from localhost (avoids player error 153). */
export function youtubeEmbedUrl(videoId, { autoplay = false } = {}) {
  const id = String(videoId || '').trim();
  if (!id) return '';

  const params = new URLSearchParams();
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    params.set('origin', window.location.origin);
  }
  params.set('rel', '0');
  params.set('modestbranding', '1');
  params.set('playsinline', '1');
  if (autoplay) params.set('autoplay', '1');

  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params.toString()}`;
}

export function youtubeEmbedIframeHtml(videoId, { autoplay = false } = {}) {
  const src = youtubeEmbedUrl(videoId, { autoplay });
  if (!src) return '';

  const safeSrc = src
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');

  return `<div class="player-wrap"><iframe
    src="${safeSrc}"
    title="YouTube video player"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen></iframe></div>`;
}
