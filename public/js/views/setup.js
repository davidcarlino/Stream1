import { api } from '../api.js';
import { h, busy, toast, esc, copyToClipboard, mount } from '../ui.js';
import { startYouTubeConnect } from '../youtubeConnect.js';
import { openTemplateEditor } from '../templateEditor.js';
import { mountProtectedStreamKey, showRevealedStreamKey } from '../streamKeyReveal.js';

// One-page first-run wizard. Each step is enabled once the previous is done.
export async function renderSetup() {
  const node = h('<div></div>');
  await paint(node);
  return node;
}

function readYoutubeParam() {
  const m = location.hash.match(/youtube=([a-z]+)/);
  return m ? m[1] : null;
}

async function paint(node) {
  const [statusRes, settingsRes, tplRes] = await Promise.all([
    api.get('/api/setup/status'),
    api.get('/api/settings'),
    api.get('/api/templates'),
  ]);
  const status = statusRes.ok ? statusRes.data : {};
  const settings = settingsRes.ok ? settingsRes.data.settings : {};
  const templates = (tplRes.ok && tplRes.data.templates) || [];
  const yt = (settings && settings.youtube) || {};

  const ytParam = readYoutubeParam();
  if (ytParam === 'connected') toast('YouTube connected.', 'ok');
  else if (ytParam === 'failed' || ytParam === 'denied' || ytParam === 'invalid') toast('YouTube connection did not complete. Try again.', 'err');

  const done = {
    yt: status.youtubeConnected,
    stream: status.hasStream,
    playlists: status.hasPlaylists,
    templates: status.templatesSeeded,
  };

  const embed = yt.playlists && yt.playlists.sunday
    ? `<iframe width="560" height="315" src="https://www.youtube.com/embed/videoseries?list=${esc(yt.playlists.sunday.id)}" frameborder="0" allowfullscreen></iframe>`
    : '';

  const templateListHtml = done.templates && templates.length
    ? `<div class="mt" id="setupTemplates">${templates.map((t) => `
        <div class="list-row">
          <div class="grow"><strong>${esc(t.name)}</strong>
            <div class="muted" style="font-size:0.85rem">${esc(t.titlePattern)}</div>
          </div>
          <button class="btn btn-sm btn-outline" data-edit-id="${esc(t.id)}">Edit</button>
        </div>`).join('')}</div>
      <div class="btn-row mt">
        <button class="btn btn-outline btn-sm" id="btnAddTemplate">+ Add template</button>
      </div>`
    : '';

  node.innerHTML = `
    <h1>First-time setup</h1>
    <p class="subtitle">Complete these steps once. After this, creating a stream takes seconds.</p>
    <div class="steps">
      <span class="step-pill ${done.yt ? 'done' : 'active'}">1 · YouTube</span>
      <span class="step-pill ${done.stream ? 'done' : done.yt ? 'active' : ''}">2 · Stream key</span>
      <span class="step-pill ${done.playlists ? 'done' : done.stream ? 'active' : ''}">3 · Playlists</span>
      <span class="step-pill ${done.templates ? 'done' : done.playlists ? 'active' : ''}">4 · Templates</span>
      <span class="step-pill ${done.templates ? 'active' : ''}">5 · Finish</span>
    </div>

    <div class="card">
      <h2>1 · Connect the church YouTube account</h2>
      ${done.yt
        ? `<p>✅ Connected${yt.channelTitle ? ` as <strong>${esc(yt.channelTitle)}</strong>` : ''}.</p>`
        : `<p class="muted">Chrome will open for Google sign-in. Use the account that owns the church's YouTube channel and approve the permissions.</p>`}
      <div class="btn-row mt">
        <button class="btn" id="btnConnect">${done.yt ? 'Reconnect' : 'Connect YouTube account'}</button>
      </div>
    </div>

    <div class="card">
      <h2>2 · Create the permanent stream key</h2>
      <p class="muted">This is entered into ATEM <strong>once</strong> and never changes again.</p>
      ${done.stream ? '<div class="mt" id="setupStreamKeyPanel"></div>' : ''}
      <div class="btn-row mt">
        <button class="btn ${done.yt ? '' : ''}" id="btnStream" ${done.yt ? '' : 'disabled'}>
          ${done.stream ? 'Recreate stream key' : 'Create stream key'}
        </button>
      </div>
    </div>

    <div class="card">
      <h2>3 · Create the two playlists</h2>
      <p class="muted">"Sunday Services" (public, shown on the website) and "Funerals &amp; Weddings" (unlisted, private link only).</p>
      ${done.playlists ? `<p>✅ ${esc((yt.playlists.sunday || {}).title)} &amp; ${esc((yt.playlists.private_events || {}).title)}</p>` : ''}
      <div class="btn-row mt">
        <button class="btn" id="btnPlaylists" ${done.yt ? '' : 'disabled'}>
          ${done.playlists ? 'Recreate playlists' : 'Create playlists'}
        </button>
      </div>
      ${done.playlists && embed ? `<div class="mt">
        <label>Website embed code for "Sunday Services" (paste into your website once):</label>
        <div class="readonly-box"><code>${esc(embed)}</code><button class="btn btn-sm" id="btnCopyEmbed">Copy</button></div>
      </div>` : ''}
    </div>

    <div class="card">
      <h2>4 · Add starter templates</h2>
      <p class="muted">Sunday Morning, Sunday Evening, Saturday Night Mass, Funeral and Wedding — edit or add more before you finish.</p>
      ${done.templates ? '<p>✅ Templates added.</p>' : ''}
      ${templateListHtml}
      <div class="btn-row mt">
        <button class="btn" id="btnTemplates" ${done.playlists ? '' : 'disabled'}>
          ${done.templates ? 'Re-add starter templates' : 'Add starter templates'}
        </button>
      </div>
    </div>

    <div class="card">
      <h2>5 · Church name</h2>
      <p class="muted">Used in stream titles/descriptions via the <code>{church_name}</code> variable.</p>
      <div class="field mt">
        <input type="text" id="churchName" value="${esc(settings.churchName || '')}" placeholder="e.g. Grace Community Church" />
      </div>
      <button class="btn btn-outline" id="btnSaveName">Save name</button>
    </div>

    <button class="btn btn-green btn-lg mt" id="btnFinish"
      ${done.yt && done.stream && done.playlists && done.templates ? '' : 'disabled'}>
      Finish setup
    </button>
    ${done.yt && done.stream && done.playlists && done.templates ? '' : '<p class="hint center mt">Complete steps 1–4 to finish.</p>'}
  `;

  wire(node, { settings, templates });
}

function wire(node, { settings, templates }) {
  const reload = () => paint(node);

  const setupStreamPanel = node.querySelector('#setupStreamKeyPanel');
  if (setupStreamPanel) mountProtectedStreamKey(setupStreamPanel);

  const connectBtn = node.querySelector('#btnConnect');
  connectBtn.onclick = async (e) => {
    const btn = e.target;
    const label = btn.textContent.trim();
    busy(btn, true, 'Waiting for sign-in…');
    const result = await startYouTubeConnect({ returnTo: 'setup' });
    busy(btn, false, label);
    if (result.ok) {
      toast(result.channelTitle ? `Connected as ${result.channelTitle}.` : 'YouTube connected.', 'ok');
      reload();
      return;
    }
    toast(result.error || 'YouTube connection did not complete.', 'err');
  };

  const streamBtn = node.querySelector('#btnStream');
  if (streamBtn && !streamBtn.disabled) {
    streamBtn.onclick = async (e) => {
      busy(e.target, true);
      const res = await api.post('/api/setup/create-stream');
      busy(e.target, false);
      if (!res.ok) return toast(res.error, 'err');
      toast('Stream key ready.', 'ok');
      if (res.data && res.data.stream && setupStreamPanel) {
        showRevealedStreamKey(setupStreamPanel, res.data.stream);
      } else {
        reload();
      }
    };
  }

  const playlistBtn = node.querySelector('#btnPlaylists');
  if (playlistBtn && !playlistBtn.disabled) {
    playlistBtn.onclick = async (e) => {
      busy(e.target, true);
      const res = await api.post('/api/setup/create-playlists', {});
      busy(e.target, false);
      if (!res.ok) return toast(res.error, 'err');
      toast('Playlists ready.', 'ok');
      reload();
    };
  }

  const tplBtn = node.querySelector('#btnTemplates');
  if (tplBtn && !tplBtn.disabled) {
    const tplLabel = tplBtn.textContent.trim();
    tplBtn.onclick = async (e) => {
      busy(e.target, true);
      const res = await api.post('/api/setup/seed-templates', {});
      busy(e.target, false, tplLabel);
      if (!res.ok) return toast(res.error, 'err');
      toast(res.data && res.data.seeded === false ? 'Templates already exist — edit them below.' : 'Templates added.', 'ok');
      reload();
    };
  }

  node.querySelectorAll('[data-edit-id]').forEach((btn) => {
    btn.onclick = () => {
      const t = templates.find((x) => x.id === btn.getAttribute('data-edit-id'));
      if (t) openTemplateEditor({ template: t, settings, onSaved: reload });
    };
  });
  const addTpl = node.querySelector('#btnAddTemplate');
  if (addTpl) {
    addTpl.onclick = () => openTemplateEditor({ settings, onSaved: reload });
  }

  node.querySelector('#btnSaveName').onclick = async (e) => {
    const churchName = node.querySelector('#churchName').value.trim();
    busy(e.target, true);
    const res = await api.put('/api/settings', { churchName });
    busy(e.target, false, 'Save name');
    toast(res.ok ? 'Saved.' : res.error, res.ok ? 'ok' : 'err');
  };

  node.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      const ok = await copyToClipboard(btn.getAttribute('data-copy'));
      toast(ok ? 'Copied.' : 'Select and copy manually.', ok ? 'ok' : 'err');
    };
  });

  const copyEmbed = node.querySelector('#btnCopyEmbed');
  if (copyEmbed) {
    copyEmbed.onclick = async () => {
      const code = node.querySelector('.readonly-box code');
      const ok = await copyToClipboard(code ? code.textContent : '');
      toast(ok ? 'Embed code copied.' : 'Select and copy manually.', ok ? 'ok' : 'err');
    };
  }

  const finish = node.querySelector('#btnFinish');
  if (finish && !finish.disabled) {
    finish.onclick = async (e) => {
      busy(e.target, true);
      const res = await api.post('/api/setup/complete');
      if (!res.ok) {
        busy(e.target, false, 'Finish setup');
        return toast(res.error, 'err');
      }
      toast('Setup complete!', 'ok');
      // Clean reload starts health polling and lands on New Stream.
      location.hash = '#/new';
      location.reload();
    };
  }
}
