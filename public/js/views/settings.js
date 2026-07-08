import { api } from '../api.js';
import { h, esc, toast, busy, copyToClipboard, confirmDialog } from '../ui.js';
import { startYouTubeConnect } from '../youtubeConnect.js';
import { startFacebookConnect } from '../facebookConnect.js';
import { startRestreamConnect } from '../restreamConnect.js';
import { startGmailConnect } from '../gmailConnect.js';
import { openSmsLogsModal } from '../smsLogs.js';
import { mountProtectedStreamKey, showRevealedStreamKey } from '../streamKeyReveal.js';
import { refreshHealth } from '../health.js';
import { healthState } from '../healthState.js';

export async function renderSettings(ctx = {}) {
  const isAdmin = ctx.state && ctx.state.user && ctx.state.user.role === 'admin';
  const node = h('<div></div>');
  await load(node, isAdmin);
  return node;
}

function readYoutubeParam() {
  const m = location.hash.match(/youtube=([a-z]+)/);
  return m ? m[1] : null;
}

function healthStatusHtml(issues, { isAdmin = false } = {}) {
  if (!issues || issues.length === 0) {
    return '<p class="settings-status-ok">✅ No issues detected.</p>';
  }
  return issues
    .map((issue) => {
      const amber = issue.fix ? '' : ' amber';
      const actions =
        isAdmin && issue.fix === 'reconnect'
          ? '<div class="btn-row"><button type="button" class="btn btn-sm" data-health-reconnect>Reconnect YouTube</button></div>'
          : isAdmin && issue.fix === 'recreate_stream'
            ? '<div class="btn-row"><button type="button" class="btn btn-sm" data-health-recreate>Recreate stream key</button></div>'
            : '';
      return `<div class="settings-status-issue${amber}"><p>${esc(issue.message)}</p>${actions}</div>`;
    })
    .join('');
}

function wireHealthStatus(node, isAdmin) {
  const wrap = node.querySelector('#healthStatus');
  if (!wrap) return;

  const render = (issues) => {
    wrap.innerHTML = healthStatusHtml(issues, { isAdmin });
    const reconnect = wrap.querySelector('[data-health-reconnect]');
    if (reconnect && isAdmin) {
      reconnect.onclick = async (e) => {
        busy(e.target, true, 'Waiting for sign-in…');
        const result = await startYouTubeConnect({ returnTo: 'settings' });
        busy(e.target, false, 'Reconnect YouTube');
        if (result.ok) {
          toast(result.channelTitle ? `Connected as ${result.channelTitle}.` : 'YouTube reconnected.', 'ok');
          await refreshHealth();
          render(healthState.issues);
          return;
        }
        toast(result.error || 'Could not start reconnect.', 'err');
      };
    }
    const recreate = wrap.querySelector('[data-health-recreate]');
    if (recreate && isAdmin) {
      recreate.onclick = async () => {
        const ok = await confirmDialog(
          'Recreate stream key',
          'This creates a NEW stream key. You must enter the new key into ATEM afterwards, or streaming will not work.',
          { danger: true, confirmText: 'Recreate' }
        );
        if (!ok) return;
        const res = await api.post('/api/settings/youtube/recreate-stream');
        if (!res.ok) return toast(res.error, 'err');
        toast('New stream key created — update ATEM.', 'ok');
        await refreshHealth();
        render(healthState.issues);
        load(node, isAdmin);
      };
    }
  };

  render(healthState.issues);
  window.addEventListener('stream1-health', () => render(healthState.issues));
  refreshHealth().then(() => render(healthState.issues));
}

async function load(node, isAdmin) {
  const setRes = await api.get('/api/settings');
  const usersRes = isAdmin ? await api.get('/api/settings/users') : null;
  const s = (setRes.ok && setRes.data.settings) || {};
  const users = (usersRes && usersRes.ok && usersRes.data.users) || [];
  const yt = s.youtube || {};
  const fb = s.facebook || {};
  const rs = s.restream || {};
  const gm = s.gmail || {};
  const cs = s.clicksend || {};

  if (!setRes.ok) {
    node.innerHTML = `<div class="card"><p>${esc(setRes.error || 'Could not load settings.')}</p></div>`;
    return;
  }

  const p = readYoutubeParam();
  if (p === 'connected') toast('YouTube connected.', 'ok');
  else if (p === 'failed' || p === 'invalid' || p === 'denied') toast('YouTube connection did not complete.', 'err');

  if (!isAdmin) {
    node.innerHTML = `
      <h1>Settings</h1>
      <p class="subtitle">System status for this installation. YouTube, Facebook, and Restream are managed by an admin.</p>
      <div class="card section">
        <h2>System status</h2>
        <div id="healthStatus"></div>
      </div>`;
    wireHealthStatus(node, false);
    return;
  }

  const variablesRows = Object.entries(s.variables || {})
    .map(([k, v]) => variableRowHtml(k, v))
    .join('');

  const presetRows = (s.timePresets || [])
    .map((p) => timePresetRowHtml(p.label, p.time))
    .join('');

  const embed = yt.playlists && yt.playlists.sunday
    ? `https://www.youtube.com/embed/videoseries?list=${esc(yt.playlists.sunday.id)}`
    : '';

  const restreamActive = Boolean(rs.enabled && rs.connected);

  node.innerHTML = `
    <h1>Settings</h1>
    <p class="subtitle">Account details, YouTube connection and user logins.</p>

    <div class="card section">
      <h2>System status</h2>
      <div id="healthStatus"></div>
    </div>

    <div class="card section">
      <h2>Church details</h2>
      <div class="field">
        <label>Church name <span class="muted">({church_name})</span></label>
        <input type="text" id="churchName" value="${esc(s.churchName || '')}" />
      </div>
      <div class="field">
        <label>Date format</label>
        <select id="dateFormat">
          <option value="Month D, YYYY" ${s.dateFormat === 'Month D, YYYY' ? 'selected' : ''}>Month D, YYYY (June 29, 2026)</option>
          <option value="DD/MM/YYYY" ${s.dateFormat === 'DD/MM/YYYY' ? 'selected' : ''}>DD/MM/YYYY (29/06/2026)</option>
        </select>
      </div>
      <div class="field">
        <label>Custom variables <span class="muted">— usable as {key} in templates</span></label>
        <div id="vars">${variablesRows}</div>
        <button type="button" class="btn btn-sm btn-outline" id="addVar">+ Add variable</button>
      </div>
      <div class="field">
        <label>Favourite times <span class="muted">— quick-pick buttons on New Stream</span></label>
        <div id="timePresets">${presetRows}</div>
        <button type="button" class="btn btn-sm btn-outline" id="addPreset">+ Add time</button>
        <p class="hint">Shown as one-click buttons when creating a stream. Label is optional (e.g. "Morning").</p>
      </div>
      <button class="btn" id="saveSettings">Save details</button>
    </div>

    <div class="card section">
      <h2>Hidden streams</h2>
      <p class="hint muted">Streams hidden from the Streams page. Hover a stream on the Streams page and click the eye icon to hide it.</p>
      <div id="hiddenStreams"><p class="muted">Loading…</p></div>
    </div>

    <div class="card section">
      <h2>YouTube connection</h2>
      <p>${yt.connected ? `✅ Connected${yt.channelTitle ? ` as <strong>${esc(yt.channelTitle)}</strong>` : ''}.` : '⚠️ Not connected.'}</p>
      <div class="btn-row">
        <button class="btn" id="connect">${yt.connected ? 'Reconnect' : 'Connect YouTube'}</button>
        ${yt.connected ? '<button class="btn btn-danger" id="disconnect">Disconnect</button>' : ''}
      </div>
    </div>

    <div class="card section">
      <h2>Facebook connection</h2>
      <p>${fb.connected ? '✅ Connected.' : '⚠️ Not connected — sign in with the account that manages the church Facebook page.'}</p>
      ${fb.connected && (fb.pages || []).length
        ? `<div class="field">
            <label>Stream to page</label>
            <select id="fbPage">
              ${(fb.pages || [])
                .map((p) => `<option value="${esc(p.id)}" ${p.id === fb.pageId ? 'selected' : ''}>${esc(p.name)}</option>`)
                .join('')}
            </select>
            <p class="hint">Live streams marked "Facebook" are posted to this page.</p>
          </div>`
        : fb.connected
          ? '<p class="hint">No pages found on this account — the account must manage the church Facebook page.</p>'
          : ''}
      <div class="btn-row">
        <button class="btn" id="connectFb">${fb.connected ? 'Reconnect' : 'Connect Facebook'}</button>
        ${fb.connected ? '<button class="btn btn-danger" id="disconnectFb">Disconnect</button>' : ''}
      </div>
      <p class="hint muted">Requires Facebook App Created.</p>
    </div>

    <div class="card section">
      <h2>Email connection</h2>
      <p class="hint">Send stream watch links by email from the Streams page. </p>
      <!--Uses the same Google Cloud app as YouTube — add the Gmail redirect URI in Google Console.-->
      <p>${!gm.configured
    ? '⚠️ Google OAuth is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env).'
    : gm.connected
      ? `✅ Connected${gm.email ? ` as <strong>${esc(gm.email)}</strong>` : ''}.`
      : '⚠️ Not connected — connect the Gmail account that should send stream emails.'}</p>
      <div class="btn-row">
        <button class="btn" id="connectGmail" ${gm.configured ? '' : 'disabled'}>${gm.connected ? 'Reconnect Gmail' : 'Connect Gmail'}</button>
        ${gm.connected ? '<button class="btn btn-danger" id="disconnectGmail">Disconnect</button>' : ''}
      </div>
      <!--<p class="hint muted">In Google Cloud Console, add redirect URI <code>http://localhost:15000/gmail/oauth2callback</code> (or your APP_BASE_URL + <code>/gmail/oauth2callback</code>). Enable the Gmail API for the project.</p>-->
    </div>

    <div class="card section">
      <h2>Text messaging (ClickSend)</h2>
      <p class="hint">Send stream watch links by SMS from the Streams page.</p>
      <p>${cs.configured
    ? '✅ ClickSend credentials are loaded.'
    : '⚠️ Not configured — add <code>CLICKSEND_USERNAME</code> and <code>CLICKSEND_API_KEY</code> to the server <code>.env</code> (next to STREAM1 Server.exe or in your data folder), then reload environment or restart the server.'}</p>
      <div class="field mt">
        <label>Text messaging</label>
        <div class="btn-row">
          <button type="button" class="btn ${cs.enabled ? 'btn-danger' : 'btn-green'}" id="csToggle" ${cs.configured ? '' : 'disabled'}>
            ${cs.enabled ? 'Turn text messaging OFF' : 'Turn text messaging ON'}
          </button>
          <span class="badge ${cs.enabled ? 'badge-on' : 'badge-off'}">${cs.enabled ? 'ON' : 'OFF'}</span>
        </div>
        <p class="hint">${cs.enabled
    ? 'Staff see Share → Text on the Streams page.'
    : 'Share → Text is hidden until you turn this on.'}</p>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-outline" id="csViewLogs">View text logs</button>
      </div>
      <!-- <p class="hint muted">Get your username and API key from the <a href="https://dashboard.clicksend.com/#/account/subaccount" target="_blank" rel="noopener">ClickSend dashboard → API Credentials</a>. Optional: set <code>CLICKSEND_FROM</code> for a custom sender ID (alpha tag or dedicated number).</p> -->
    </div>

    <div class="card section">
      <h2>Restream</h2>
      <p class="hint">Restream takes the single ATEM feed and sends it to YouTube and Facebook itself.
      When Restream mode is ON, streams are created through Restream and the direct YouTube/Facebook
      streaming paths are turned off (YouTube stays connected for playlists, thumbnails and privacy).</p>

      <div class="field">
        <label>Restream app credentials <span class="muted">— from developers.restream.io</span></label>
        <div class="kv-row">
          <input type="text" id="rsClientId" placeholder="Client ID" value="${esc(rs.clientId || '')}" autocomplete="off" />
          <input type="password" id="rsClientSecret" placeholder="Client Secret${rs.configured ? ' (saved — leave blank to keep)' : ''}" autocomplete="off" />
          <button type="button" class="btn btn-sm" id="rsSaveCreds">Save</button>
        </div>
        <p class="hint">${rs.configured
          ? '✅ App credentials are saved.'
          : 'Create an app at developers.restream.io, add redirect URI <code>http://localhost:15000/restream/oauth2callback</code>, then paste the Client ID and Secret here.'}</p>
      </div>

      <p>${rs.connected
        ? `✅ Connected${rs.account ? ` as <strong>${esc(rs.account)}</strong>` : ''}.`
        : '⚠️ Not connected — sign in with the church Restream account.'}</p>
      <div class="btn-row">
        <button class="btn" id="connectRs" ${rs.configured ? '' : 'disabled'}>${rs.connected ? 'Reconnect Restream' : 'Connect Restream'}</button>
        ${rs.connected ? '<button class="btn btn-danger" id="disconnectRs">Disconnect</button>' : ''}
      </div>

      <div class="field mt">
        <label>Restream mode</label>
        <div class="btn-row">
          <button type="button" class="btn ${rs.enabled ? 'btn-danger' : 'btn-green'}" id="rsToggle" ${rs.connected || rs.enabled ? '' : 'disabled'}>
            ${rs.enabled ? 'Turn Restream mode OFF' : 'Turn Restream mode ON'}
          </button>
          <span class="badge ${rs.enabled ? 'badge-on' : 'badge-off'}">${rs.enabled ? 'ON' : 'OFF'}</span>
        </div>
        <p class="hint">${rs.enabled
          ? 'New streams go through Restream. Point ATEM at the Restream server + key below.'
          : 'Streams currently go straight to YouTube (with the optional Facebook relay).'}</p>
      </div>

      ${rs.connected ? `<div class="field">
        <label>Destinations in Restream <button type="button" class="btn btn-sm btn-outline" id="rsRefreshCh">Refresh</button></label>
        <div id="rsChannels">${restreamChannelsHtml(rs.channels)}</div>
        <p class="hint">Connect or remove destinations in the Restream dashboard. "Stream to" choices on New Stream turn these on/off per event.</p>
      </div>` : ''}

      ${rs.enabled && rs.connected ? `<div class="field">
        <label>Restream stream key (for ATEM)</label>
        <div id="rsStreamKeyPanel"></div>
        <p class="hint">While Restream mode is ON, point ATEM at this server URL and stream key — not the YouTube key below.</p>
      </div>` : ''}
    </div>

    <div class="card section${restreamActive ? ' card-inactive' : ''}">
      <h2>Permanent stream key (YouTube) ${restreamActive ? '<span class="badge badge-ended">Restream is handling streaming</span>' : ''}</h2>
      <div id="streamKeyPanel">
        ${restreamActive
    ? '<p class="muted">Restream is connected and handling the live feed to YouTube and Facebook. Use the Restream stream key above for ATEM.</p>'
    : yt.hasStream ? '' : '<p class="muted">No stream key yet.</p>'}
      </div>
      <p class="hint">${restreamActive
        ? 'YouTube still manages titles, privacy and playlists — but ATEM should not use this key while Restream is active.'
        : 'Recreating the key means you must re-enter it into ATEM once.'}</p>
      <button class="btn btn-outline" id="recreate" ${restreamActive ? 'disabled' : ''}>Recreate stream key</button>
    </div>

    ${embed ? `<div class="card section">
      <h2>Website embed</h2>
      <p class="muted">Paste this into the church website once — it always shows the latest Sunday service.</p>
      <div class="readonly-box"><code>${esc(`<iframe width="560" height="315" src="${embed}" frameborder="0" allowfullscreen></iframe>`)}</code>
      <button class="btn btn-sm" data-copy='${esc(`<iframe width="560" height="315" src="${embed}" frameborder="0" allowfullscreen></iframe>`)}'>Copy</button></div>
    </div>` : ''}

    <div class="card section">
      <h2>Staff logins</h2>
      <div id="users"></div>
      <button class="btn btn-outline mt" id="addUser">+ Add user</button>
    </div>`;

  wireDetails(node);
  wireHiddenStreams(node);
  wireYouTube(node, { allowDisconnect: true });
  wireFacebook(node, { allowDisconnect: true });
  wireGmail(node);
  wireClickSend(node, cs);
  wireRestream(node, rs);
  wireStreamKey(node, { restreamEnabled: restreamActive });
  wireUsers(node, users);
  wireHealthStatus(node, true);

  const streamPanel = node.querySelector('#streamKeyPanel');
  if (!restreamActive && yt.hasStream && streamPanel) mountProtectedStreamKey(streamPanel);

  const rsKeyPanel = node.querySelector('#rsStreamKeyPanel');
  if (rsKeyPanel) mountProtectedStreamKey(rsKeyPanel, { provider: 'restream' });

  node.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      const ok = await copyToClipboard(btn.getAttribute('data-copy'));
      toast(ok ? 'Copied.' : 'Copy manually.', ok ? 'ok' : 'err');
    };
  });
}

function variableRowHtml(k, v) {
  return `<div class="kv-row">
    <input type="text" class="var-key" placeholder="key" value="${esc(k)}" />
    <input type="text" class="var-val" placeholder="value" value="${esc(v)}" />
    <button type="button" class="btn btn-sm btn-danger var-del">×</button>
  </div>`;
}

function timePresetRowHtml(label, time) {
  return `<div class="kv-row">
    <input type="text" class="preset-label" placeholder="Label (optional)" value="${esc(label || '')}" />
    <input type="time" class="preset-time" value="${esc(time || '')}" />
    <button type="button" class="btn btn-sm btn-danger preset-del">×</button>
  </div>`;
}

function formatStreamWhen(row) {
  const iso = row.actualStartTime || row.scheduledStartTime;
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function hiddenStreamRowHtml(stream) {
  const when = formatStreamWhen(stream);
  const meta = [stream.statusLabel, when, stream.templateName].filter(Boolean).join(' · ');
  return `<div class="hidden-stream-row" data-id="${esc(stream.broadcastId)}">
    <div class="hidden-stream-main">
      <p class="hidden-stream-title">${esc(stream.title || '(untitled)')}</p>
      <p class="hidden-stream-meta">${esc(meta || 'Hidden stream')}</p>
    </div>
    <button type="button" class="btn btn-sm btn-outline" data-unhide>Unhide</button>
  </div>`;
}

async function wireHiddenStreams(node) {
  const wrap = node.querySelector('#hiddenStreams');
  if (!wrap) return;

  const res = await api.get('/api/streams/hidden');
  if (!res.ok) {
    wrap.innerHTML = `<p class="muted">${esc(res.error || 'Could not load hidden streams.')}</p>`;
    return;
  }

  const streams = res.data.streams || [];
  if (!streams.length) {
    wrap.innerHTML = '<p class="muted">No hidden streams.</p>';
    return;
  }

  wrap.innerHTML = streams.map((stream) => hiddenStreamRowHtml(stream)).join('');
  wrap.querySelectorAll('[data-unhide]').forEach((btn) => {
    btn.onclick = async (e) => {
      const row = e.target.closest('.hidden-stream-row');
      const broadcastId = row && row.getAttribute('data-id');
      if (!broadcastId) return;
      busy(e.target, true, 'Unhide');
      const result = await api.put(`/api/streams/${encodeURIComponent(broadcastId)}/hidden`, { hidden: false });
      busy(e.target, false, 'Unhide');
      if (!result.ok) return toast(result.error, 'err');
      toast('Stream unhidden.', 'ok');
      await wireHiddenStreams(node);
    };
  });
}

function wireDetails(node) {
  const varsWrap = node.querySelector('#vars');
  const presetsWrap = node.querySelector('#timePresets');
  const bindDel = (row) => { row.querySelector('.var-del').onclick = () => row.remove(); };
  const bindPresetDel = (row) => { row.querySelector('.preset-del').onclick = () => row.remove(); };
  varsWrap.querySelectorAll('.kv-row').forEach(bindDel);
  presetsWrap.querySelectorAll('.kv-row').forEach(bindPresetDel);
  node.querySelector('#addVar').onclick = () => {
    const row = h(variableRowHtml('', ''));
    bindDel(row);
    varsWrap.appendChild(row);
  };
  node.querySelector('#addPreset').onclick = () => {
    const row = h(timePresetRowHtml('', '09:00'));
    bindPresetDel(row);
    presetsWrap.appendChild(row);
  };

  node.querySelector('#saveSettings').onclick = async (e) => {
    const variables = {};
    varsWrap.querySelectorAll('.kv-row').forEach((r) => {
      const k = r.querySelector('.var-key').value.trim();
      if (k) variables[k] = r.querySelector('.var-val').value;
    });
    const timePresets = [];
    presetsWrap.querySelectorAll('.kv-row').forEach((r) => {
      const time = r.querySelector('.preset-time').value;
      if (!time) return;
      timePresets.push({
        label: r.querySelector('.preset-label').value.trim(),
        time,
      });
    });
    busy(e.target, true);
    const res = await api.put('/api/settings', {
      churchName: node.querySelector('#churchName').value.trim(),
      dateFormat: node.querySelector('#dateFormat').value,
      variables,
      timePresets,
    });
    busy(e.target, false, 'Save details');
    toast(res.ok ? 'Saved.' : res.error, res.ok ? 'ok' : 'err');
  };
}

function wireYouTube(node, { allowDisconnect = true } = {}) {
  const connect = node.querySelector('#connect');
  connect.onclick = async (e) => {
    const btn = e.target;
    const label = btn.textContent.trim();
    busy(btn, true, 'Waiting for sign-in…');
    const result = await startYouTubeConnect({ returnTo: 'settings' });
    busy(btn, false, label);
    if (result.ok) {
      toast(result.channelTitle ? `Connected as ${result.channelTitle}.` : 'YouTube connected.', 'ok');
      const isAdmin = Boolean(node.querySelector('#saveSettings'));
      load(node, isAdmin);
      return;
    }
    toast(result.error || 'Could not start.', 'err');
  };
  if (!allowDisconnect) return;
  const dis = node.querySelector('#disconnect');
  if (dis) {
    dis.onclick = async () => {
      const ok = await confirmDialog('Disconnect YouTube', 'The app will stop being able to create or manage streams until you reconnect.', { danger: true, confirmText: 'Disconnect' });
      if (!ok) return;
      const res = await api.post('/api/settings/youtube/disconnect');
      if (!res.ok) return toast(res.error, 'err');
      toast('Disconnected.', 'ok');
      const isAdmin = Boolean(node.querySelector('#saveSettings'));
      load(node, isAdmin);
    };
  }
}

function wireGmail(node) {
  const connect = node.querySelector('#connectGmail');
  if (connect) {
    connect.onclick = async (e) => {
      const btn = e.target;
      const label = btn.textContent.trim();
      busy(btn, true, 'Waiting for sign-in…');
      const result = await startGmailConnect({ returnTo: 'settings' });
      busy(btn, false, label);
      if (result.ok) {
        toast(result.email ? `Connected as ${result.email}.` : 'Gmail connected.', 'ok');
        const isAdmin = Boolean(node.querySelector('#saveSettings'));
        load(node, isAdmin);
        return;
      }
      toast(result.error || 'Could not start.', 'err');
    };
  }

  const dis = node.querySelector('#disconnectGmail');
  if (dis) {
    dis.onclick = async () => {
      const ok = await confirmDialog(
        'Disconnect Gmail',
        'STREAM1 will no longer be able to send stream links by email until you reconnect.',
        { danger: true, confirmText: 'Disconnect' }
      );
      if (!ok) return;
      const res = await api.post('/api/settings/gmail/disconnect');
      if (!res.ok) return toast(res.error, 'err');
      toast('Gmail disconnected.', 'ok');
      const isAdmin = Boolean(node.querySelector('#saveSettings'));
      load(node, isAdmin);
    };
  }
}

function wireClickSend(node, cs) {
  const logsBtn = node.querySelector('#csViewLogs');
  if (logsBtn) {
    logsBtn.onclick = () => openSmsLogsModal();
  }

  const toggle = node.querySelector('#csToggle');
  if (!toggle) return;

  toggle.onclick = async (e) => {
    const turningOn = !cs.enabled;
    if (turningOn) {
      const ok = await confirmDialog(
        'Turn text messaging ON',
        'Staff will see Share → Text on the Streams page. Each send delivers one SMS via ClickSend (standard rates apply).',
        { confirmText: 'Turn ON' }
      );
      if (!ok) return;
    } else {
      const ok = await confirmDialog(
        'Turn text messaging OFF',
        'The Text button will be hidden from Share until you turn this back on.',
        { danger: true, confirmText: 'Turn OFF' }
      );
      if (!ok) return;
    }

    busy(e.target, true);
    const res = await api.put('/api/settings/clicksend/mode', { enabled: turningOn });
    busy(e.target, false);
    if (!res.ok) return toast(res.error, 'err');
    toast(turningOn ? 'Text messaging is ON.' : 'Text messaging is OFF.', 'ok');
    load(node, true);
  };
}

function wireFacebook(node, { allowDisconnect = true } = {}) {
  const connect = node.querySelector('#connectFb');
  if (connect) {
    connect.onclick = async (e) => {
      const btn = e.target;
      const label = btn.textContent.trim();
      busy(btn, true, 'Waiting for sign-in…');
      const result = await startFacebookConnect({ returnTo: 'settings' });
      busy(btn, false, label);
      if (result.ok) {
        toast(result.pageName ? `Connected — streaming to ${result.pageName}.` : 'Facebook connected.', 'ok');
        const isAdmin = Boolean(node.querySelector('#saveSettings'));
        load(node, isAdmin);
        return;
      }
      toast(result.error || 'Could not start.', 'err');
    };
  }

  const pageSelect = node.querySelector('#fbPage');
  if (pageSelect) {
    pageSelect.onchange = async () => {
      const res = await api.put('/api/settings/facebook/page', { pageId: pageSelect.value });
      toast(res.ok ? `Streaming to ${res.data.pageName}.` : res.error, res.ok ? 'ok' : 'err');
    };
  }

  if (!allowDisconnect) return;
  const dis = node.querySelector('#disconnectFb');
  if (dis) {
    dis.onclick = async () => {
      const ok = await confirmDialog('Disconnect Facebook', 'Streams will no longer simulcast to Facebook until you reconnect.', { danger: true, confirmText: 'Disconnect' });
      if (!ok) return;
      const res = await api.post('/api/settings/facebook/disconnect');
      if (!res.ok) return toast(res.error, 'err');
      toast('Disconnected.', 'ok');
      const isAdmin = Boolean(node.querySelector('#saveSettings'));
      load(node, isAdmin);
    };
  }
}

function restreamChannelsHtml(channels) {
  const managed = (channels || []).filter((c) => c.platform === 'youtube' || c.platform === 'facebook');
  if (managed.length === 0) {
    return '<p class="muted">No YouTube or Facebook destinations found. Add them in the Restream dashboard, then refresh.</p>';
  }
  return managed
    .map(
      (c) => `<div class="list-row">
        <div class="grow"><strong>${esc(c.displayName || c.platform)}</strong>
          <span class="badge ${c.platform === 'youtube' ? 'badge-live' : 'badge-upcoming'}">${esc(c.platform)}</span>
        </div>
        <span class="badge ${c.active ? 'badge-public' : 'badge-ended'}">${c.active ? 'Enabled' : 'Disabled'}</span>
      </div>`
    )
    .join('');
}

function wireRestream(node, rs) {
  const saveBtn = node.querySelector('#rsSaveCreds');
  if (saveBtn) {
    saveBtn.onclick = async (e) => {
      const clientId = node.querySelector('#rsClientId').value.trim();
      const clientSecret = node.querySelector('#rsClientSecret').value.trim();
      if (!clientId) return toast('Enter the Restream Client ID.', 'err');
      if (!clientSecret && !rs.configured) return toast('Enter the Restream Client Secret.', 'err');
      busy(e.target, true);
      const res = await api.put('/api/settings/restream/credentials', { clientId, clientSecret });
      busy(e.target, false, 'Save');
      if (!res.ok) return toast(res.error, 'err');
      toast('Restream credentials saved.', 'ok');
      load(node, true);
    };
  }

  const connect = node.querySelector('#connectRs');
  if (connect) {
    connect.onclick = async (e) => {
      const btn = e.target;
      const label = btn.textContent.trim();
      busy(btn, true, 'Waiting for sign-in…');
      const result = await startRestreamConnect({ returnTo: 'settings' });
      busy(btn, false, label);
      if (result.ok) {
        toast(result.account ? `Restream connected as ${result.account}.` : 'Restream connected.', 'ok');
        load(node, true);
        return;
      }
      toast(result.error || 'Could not start.', 'err');
    };
  }

  const disconnect = node.querySelector('#disconnectRs');
  if (disconnect) {
    disconnect.onclick = async () => {
      const ok = await confirmDialog(
        'Disconnect Restream',
        'Restream mode will be turned off and streams will go back to the direct YouTube path.',
        { danger: true, confirmText: 'Disconnect' }
      );
      if (!ok) return;
      const res = await api.post('/api/settings/restream/disconnect');
      if (!res.ok) return toast(res.error, 'err');
      toast('Restream disconnected.', 'ok');
      load(node, true);
    };
  }

  const toggle = node.querySelector('#rsToggle');
  if (toggle) {
    toggle.onclick = async (e) => {
      const turningOn = !rs.enabled;
      if (turningOn) {
        const ok = await confirmDialog(
          'Turn Restream mode ON',
          'New streams will be created through Restream (which feeds YouTube and Facebook). ATEM must be re-pointed at the Restream server and stream key — shown in Settings after switching.',
          { confirmText: 'Turn ON' }
        );
        if (!ok) return;
      } else {
        const ok = await confirmDialog(
          'Turn Restream mode OFF',
          'Streams will go back to the direct YouTube path. ATEM must be re-pointed at the YouTube stream key.',
          { danger: true, confirmText: 'Turn OFF' }
        );
        if (!ok) return;
      }
      busy(e.target, true);
      const res = await api.put('/api/settings/restream/mode', { enabled: turningOn });
      busy(e.target, false);
      if (!res.ok) return toast(res.error, 'err');
      toast(turningOn ? 'Restream mode is ON — update the ATEM stream key.' : 'Restream mode is OFF.', 'ok');
      load(node, true);
    };
  }

  const refresh = node.querySelector('#rsRefreshCh');
  if (refresh) {
    refresh.onclick = async (e) => {
      busy(e.target, true);
      const res = await api.post('/api/settings/restream/channels/refresh');
      busy(e.target, false, 'Refresh');
      if (!res.ok) return toast(res.error, 'err');
      const wrap = node.querySelector('#rsChannels');
      if (wrap) wrap.innerHTML = restreamChannelsHtml(res.data.channels);
      toast('Destinations refreshed.', 'ok');
    };
  }
}

function wireStreamKey(node, { restreamEnabled = false } = {}) {
  const btn = node.querySelector('#recreate');
  if (!btn || restreamEnabled) return;
  btn.onclick = async (e) => {
    const ok = await confirmDialog('Recreate stream key', 'This creates a NEW stream key. You must enter the new key into ATEM afterwards, or streaming will not work.', { danger: true, confirmText: 'Recreate' });
    if (!ok) return;
    busy(e.target, true);
    const res = await api.post('/api/settings/youtube/recreate-stream');
    busy(e.target, false, 'Recreate stream key');
    if (!res.ok) return toast(res.error, 'err');
    toast('New stream key created — update ATEM.', 'ok');
    const panel = node.querySelector('#streamKeyPanel');
    if (panel && res.data && res.data.stream) showRevealedStreamKey(panel, res.data.stream);
    else load(node, true);
  };
}

function wireUsers(node, users) {
  const wrap = node.querySelector('#users');
  wrap.innerHTML = '';
  users.forEach((u) => {
    const row = h(`<div class="list-row">
      <div class="grow"><strong>${esc(u.username)}</strong> <span class="badge badge-private">${esc(u.role)}</span></div>
      <button class="btn btn-sm btn-outline" data-act="pw">Reset password</button>
      <button class="btn btn-sm btn-danger" data-act="del">Delete</button>
    </div>`);
    row.querySelector('[data-act="pw"]').onclick = async () => {
      const pw = prompt(`New password for ${u.username} (min 8 chars):`);
      if (!pw) return;
      const res = await api.put(`/api/settings/users/${u.id}/password`, { password: pw });
      toast(res.ok ? 'Password reset.' : res.error, res.ok ? 'ok' : 'err');
    };
    row.querySelector('[data-act="del"]').onclick = async () => {
      const ok = await confirmDialog('Delete user', `Delete "${u.username}"?`, { danger: true, confirmText: 'Delete' });
      if (!ok) return;
      const res = await api.del(`/api/settings/users/${u.id}`);
      if (!res.ok) return toast(res.error, 'err');
      toast('User deleted.', 'ok');
      load(node, true);
    };
    wrap.appendChild(row);
  });

  node.querySelector('#addUser').onclick = async () => {
    const { modal } = await import('../ui.js');
    await modal((close) => {
      const el = h(`<div>
        <h2>Add user</h2>
        <div class="field"><label>Username</label><input type="text" id="u" /></div>
        <div class="field"><label>Password (min 8)</label><input type="password" id="p" /></div>
        <div class="field"><label>Role</label>
          <select id="r"><option value="viewer">Viewer (streams, history, stream test)</option><option value="admin">Admin (full access)</option></select>
        </div>
        <div class="modal-actions">
          <button class="btn btn-outline" id="cancel">Cancel</button>
          <button class="btn" id="save">Create</button>
        </div>
      </div>`);
      el.querySelector('#cancel').onclick = () => close(false);
      el.querySelector('#save').onclick = async (e) => {
        const username = el.querySelector('#u').value.trim();
        const password = el.querySelector('#p').value;
        const role = el.querySelector('#r').value;
        busy(e.target, true);
        const res = await api.post('/api/settings/users', { username, password, role });
        busy(e.target, false, 'Create');
        if (!res.ok) return toast(res.error, 'err');
        toast('User created.', 'ok');
        close(true);
        load(node, true);
      };
      return el;
    });
  };
}
