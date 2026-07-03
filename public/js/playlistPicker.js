import { api } from './api.js';
import { h, esc, toast, modal, busy } from './ui.js';

function privacyLabel(privacy) {
  if (privacy === 'public') return 'Public';
  if (privacy === 'unlisted') return 'Unlisted';
  if (privacy === 'private') return 'Private';
  return privacy || '';
}

function formatPlaylistOption(p) {
  const count = typeof p.itemCount === 'number' ? ` · ${p.itemCount} video${p.itemCount === 1 ? '' : 's'}` : '';
  return `${p.title} · ${privacyLabel(p.privacy)}${count}`;
}

function buildOptions(playlists, selectedId, selectedTitle) {
  const options = ['<option value="">— don\'t add to a playlist —</option>'];
  const ids = new Set(playlists.map((p) => p.id));

  if (selectedId && !ids.has(selectedId)) {
    const label = selectedTitle || 'Previously selected playlist';
    options.push(
      `<option value="${esc(selectedId)}" selected>${esc(label)} (not found on channel — pick another)</option>`
    );
  }

  playlists.forEach((p) => {
    options.push(
      `<option value="${esc(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${esc(formatPlaylistOption(p))}</option>`
    );
  });

  return options.join('');
}

async function openAddPlaylistModal() {
  return modal((close) => {
    const el = h(`<div>
      <h2>New YouTube playlist</h2>
      <p class="muted">Creates the playlist on your connected YouTube channel and selects it for this template.</p>
      <div class="field">
        <label>Playlist name</label>
        <input type="text" id="plTitle" placeholder="e.g. Saturday Night Mass" />
      </div>
      <div class="field">
        <label>Privacy on YouTube</label>
        <select id="plPrivacy">
          <option value="public">Public — visible on channel</option>
          <option value="unlisted">Unlisted — link only</option>
          <option value="private">Private — owner only</option>
        </select>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancel">Cancel</button>
        <button type="button" class="btn" id="create">Create on YouTube</button>
      </div>
    </div>`);

    el.querySelector('#cancel').onclick = () => close(null);
    el.querySelector('#create').onclick = async (e) => {
      const title = el.querySelector('#plTitle').value.trim();
      if (!title) return toast('Playlist needs a name.', 'err');
      const privacy = el.querySelector('#plPrivacy').value;
      busy(e.target, true);
      const res = await api.post('/api/playlists', { title, privacy });
      busy(e.target, false, 'Create on YouTube');
      if (!res.ok) return toast(res.error, 'err');
      toast('Playlist created on YouTube.', 'ok');
      close(res.data.playlist);
    };
    return el;
  });
}

/**
 * Live YouTube playlist picker for template defaults.
 * Returns helpers to read the selection when saving.
 */
export async function initPlaylistPicker(host, { selectedId = '', selectedTitle = '' } = {}) {
  let playlists = [];
  let currentId = selectedId || '';
  let currentTitle = selectedTitle || '';

  host.innerHTML = `
    <div class="playlist-picker">
      <div class="btn-row playlist-picker-toolbar">
        <button type="button" class="btn btn-sm btn-outline" id="refreshPlaylists">↻ Sync from YouTube</button>
        <button type="button" class="btn btn-sm" id="addPlaylist">+ Add playlist</button>
      </div>
      <div id="playlistStatus" class="hint">Loading playlists from your YouTube channel…</div>
      <select id="playlistSelect" class="mt" disabled>
        <option value="">Loading…</option>
      </select>
    </div>`;

  const status = host.querySelector('#playlistStatus');
  const select = host.querySelector('#playlistSelect');
  const refreshBtn = host.querySelector('#refreshPlaylists');
  const addBtn = host.querySelector('#addPlaylist');

  function applySelection() {
    const opt = select.options[select.selectedIndex];
    currentId = select.value || '';
    if (!currentId) {
      currentTitle = '';
      return;
    }
    const pl = playlists.find((p) => p.id === currentId);
    if (pl) {
      currentTitle = pl.title;
      return;
    }
    if (opt && opt.textContent.includes('(not found')) {
      currentTitle = selectedTitle || opt.textContent.replace(/\s*\(not found.*$/, '');
    } else {
      currentTitle = opt ? opt.textContent.split(' · ')[0] : '';
    }
  }

  function paintSelect() {
    select.innerHTML = buildOptions(playlists, currentId, currentTitle);
    select.disabled = false;
    applySelection();
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) {
      status.textContent = 'Loading playlists from your YouTube channel…';
      select.disabled = true;
    }
    refreshBtn.disabled = true;
    const res = await api.get('/api/playlists');
    refreshBtn.disabled = false;

    if (!res.ok) {
      status.textContent = res.error || 'Could not load playlists. Is YouTube connected?';
      select.innerHTML = '<option value="">— unavailable —</option>';
      select.disabled = true;
      return false;
    }

    playlists = res.data.playlists || [];
    if (playlists.length === 0) {
      status.textContent = 'No playlists on this channel yet — create one below.';
    } else {
      status.textContent = `${playlists.length} playlist${playlists.length === 1 ? '' : 's'} on your YouTube channel. Pick where streams from this template are added.`;
    }
    paintSelect();
    return true;
  }

  select.onchange = applySelection;

  refreshBtn.onclick = async (e) => {
    busy(e.target, true, '↻ Sync from YouTube');
    await load({ quiet: true });
    busy(e.target, false, '↻ Sync from YouTube');
    toast('Playlists synced from YouTube.', 'ok');
  };

  addBtn.onclick = async () => {
    const created = await openAddPlaylistModal();
    if (!created) return;
    playlists.push({
      id: created.id,
      title: created.title,
      privacy: created.privacy || 'public',
      itemCount: 0,
    });
    playlists.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    currentId = created.id;
    currentTitle = created.title;
    paintSelect();
    status.textContent = `${playlists.length} playlists on your YouTube channel. Pick where streams from this template are added.`;
  };

  await load();

  return {
    getSelected() {
      applySelection();
      return { id: currentId || null, title: currentTitle || null };
    },
    refresh: () => load({ quiet: true }),
  };
}
