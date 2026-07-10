(function () {
  const root = document.getElementById('s1Embed');
  const playerEmpty = document.getElementById('s1PlayerEmpty');
  const emptyMsg = document.getElementById('s1EmptyMsg');
  const refreshLiveBtn = document.getElementById('s1RefreshLive');
  const frame = document.getElementById('s1Frame');
  const liveBadge = document.getElementById('s1LiveBadge');
  const list = document.getElementById('s1List');
  const moreBtn = document.getElementById('s1More');
  const listCol = root && root.querySelector('.s1-list-col');

  const VISIBLE = 5;
  let liveId = null;
  let expanded = false;
  let refreshingLive = false;

  function esc(str) {
    return String(str == null ? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function embedUrl(videoId, { autoplay = false } = {}) {
    const params = new URLSearchParams();
    params.set('rel', '0');
    params.set('modestbranding', '1');
    params.set('playsinline', '1');
    if (autoplay) params.set('autoplay', '1');
    try {
      if (window.location && window.location.origin) params.set('origin', window.location.origin);
    } catch (_) {
      /* ignore */
    }
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`;
  }

  function postHeight() {
    try {
      const h = Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0);
      if (h > 0 && window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'stream1-embed-height', height: h }, '*');
      }
    } catch (_) {
      /* ignore */
    }
  }

  function setEmptyMessage(message) {
    if (emptyMsg) emptyMsg.textContent = message || 'Nothing live right now';
  }

  function showBlack(message) {
    frame.hidden = true;
    frame.removeAttribute('src');
    playerEmpty.hidden = false;
    setEmptyMessage(message || 'Nothing live right now');
    if (refreshLiveBtn) {
      refreshLiveBtn.hidden = false;
      refreshLiveBtn.disabled = false;
      refreshLiveBtn.textContent = 'Refresh';
    }
    liveBadge.hidden = true;
    list.querySelectorAll('.s1-item').forEach((el) => el.classList.remove('is-active'));
    requestAnimationFrame(postHeight);
  }

  function playVideo(videoId, { autoplay = false, isLive = false } = {}) {
    if (!videoId) {
      showBlack();
      return;
    }
    playerEmpty.hidden = true;
    if (refreshLiveBtn) refreshLiveBtn.hidden = true;
    frame.hidden = false;
    frame.src = embedUrl(videoId, { autoplay });
    liveBadge.hidden = !isLive;
    list.querySelectorAll('.s1-item').forEach((el) => {
      el.classList.toggle('is-active', el.getAttribute('data-id') === videoId);
    });
    requestAnimationFrame(postHeight);
  }

  function prependLiveToList(live) {
    if (!live || !live.id || !list) return;
    const existing = list.querySelector(`.s1-item[data-id="${CSS.escape ? CSS.escape(live.id) : live.id}"]`);
    if (existing) {
      existing.classList.add('is-active');
      return;
    }
    const thumb = live.thumbnail
      ? `<img src="${esc(live.thumbnail)}" alt="" loading="lazy" />`
      : '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 's1-item is-active';
    btn.setAttribute('data-id', live.id);
    btn.setAttribute('role', 'listitem');
    btn.innerHTML = `<span class="s1-thumb">${thumb}</span>
      <span class="s1-item-meta">
        <p class="s1-item-title">${esc(live.title || 'Live now')}</p>
      </span>`;
    btn.addEventListener('click', () => {
      playVideo(live.id, { autoplay: true, isLive: live.id === liveId });
    });
    // Remove empty-state note if present.
    const note = list.querySelector(':scope > p');
    if (note) note.remove();
    list.insertBefore(btn, list.firstChild);
    applyOverflow();
  }

  function applyOverflow() {
    const items = [...list.querySelectorAll('.s1-item')];
    items.forEach((el, i) => {
      el.classList.toggle('is-overflow', i >= VISIBLE);
    });
    const needsMore = items.length > VISIBLE;
    moreBtn.hidden = !needsMore;
    if (!needsMore) {
      expanded = false;
      listCol.classList.remove('is-expanded');
      moreBtn.querySelector('span').textContent = 'More';
    }
    requestAnimationFrame(postHeight);
  }

  function renderList(videos) {
    if (!videos.length) {
      list.innerHTML = '<p class="s1-item-date" style="padding:8px 10px;">No recent streams yet.</p>';
      moreBtn.hidden = true;
      requestAnimationFrame(postHeight);
      return;
    }

    list.innerHTML = videos
      .map((v, i) => {
        const thumb = v.thumbnail
          ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy" />`
          : '';
        const date = formatDate(v.publishedAt);
        return `<button type="button" class="s1-item${i >= VISIBLE ? ' is-overflow' : ''}" data-id="${esc(v.id)}" role="listitem">
          <span class="s1-thumb">${thumb}</span>
          <span class="s1-item-meta">
            <p class="s1-item-title">${esc(v.title)}</p>
            ${date ? `<p class="s1-item-date">${esc(date)}</p>` : ''}
          </span>
        </button>`;
      })
      .join('');

    list.querySelectorAll('.s1-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        playVideo(id, { autoplay: true, isLive: id === liveId });
      });
    });

    applyOverflow();
  }

  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      expanded = !expanded;
      listCol.classList.toggle('is-expanded', expanded);
      moreBtn.querySelector('span').textContent = expanded ? 'Less' : 'More';
      if (expanded) {
        listCol.querySelector('.s1-list-wrap').scrollTop = 0;
      }
      requestAnimationFrame(postHeight);
    });
  }

  /** Only re-check for a live stream and swap the left player if one is found. */
  async function refreshLiveOnly() {
    if (refreshingLive || !refreshLiveBtn || playerEmpty.hidden) return;
    refreshingLive = true;
    refreshLiveBtn.disabled = true;
    refreshLiveBtn.textContent = 'Checking…';
    setEmptyMessage('Looking for a live stream…');

    try {
      const res = await fetch(`/api/embed/feed?refresh=1&t=${Date.now()}`, {
        credentials: 'omit',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data && data.error) || 'Could not check for live.');
      }

      const live = data.live && data.live.id ? data.live : null;
      if (live) {
        liveId = live.id;
        prependLiveToList(live);
        playVideo(live.id, { autoplay: true, isLive: true });
        root.dataset.state = 'ready';
        return;
      }

      liveId = null;
      showBlack('Nothing live right now');
    } catch (err) {
      showBlack((err && err.message) || 'Could not check for live.');
    } finally {
      refreshingLive = false;
      if (refreshLiveBtn && !playerEmpty.hidden) {
        refreshLiveBtn.disabled = false;
        refreshLiveBtn.textContent = 'Refresh';
      }
      requestAnimationFrame(postHeight);
    }
  }

  if (refreshLiveBtn) {
    refreshLiveBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      refreshLiveOnly();
    });
  }

  async function load() {
    root.dataset.state = 'loading';
    try {
      const res = await fetch(`/api/embed/feed?refresh=1&t=${Date.now()}`, {
        credentials: 'omit',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data && data.error) || 'Could not load streams.');
      }

      liveId = data.live && data.live.id ? data.live.id : null;
      const videos = Array.isArray(data.videos) ? data.videos.slice() : [];

      if (data.live && data.live.id) {
        const already = videos.some((v) => v.id === data.live.id);
        if (!already) {
          videos.unshift({
            id: data.live.id,
            title: data.live.title || 'Live now',
            publishedAt: null,
            thumbnail: data.live.thumbnail || null,
          });
        }
      }

      renderList(videos);

      if (liveId) {
        playVideo(liveId, { autoplay: false, isLive: true });
      } else {
        showBlack('Nothing live right now');
      }

      root.dataset.state = 'ready';
    } catch (err) {
      root.dataset.state = 'error';
      showBlack((err && err.message) || 'Could not load streams.');
      list.innerHTML = '';
      moreBtn.hidden = true;
    }
    requestAnimationFrame(postHeight);
  }

  load();
  setInterval(load, 90 * 1000);
  window.addEventListener('resize', postHeight);
  if (typeof ResizeObserver !== 'undefined' && root) {
    new ResizeObserver(postHeight).observe(root);
  }
})();
