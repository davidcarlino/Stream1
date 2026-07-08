import { api } from '../api.js';
import { h, esc, busy, toast, copyToClipboard, mount } from '../ui.js';
import { shareWatchBlock } from '../shareLink.js';
import { openStreamEmail } from '../shareEmail.js';
import { openStreamSms, isSmsShareAvailable } from '../shareSms.js';
import { readImageFile, previewImageFile } from '../images.js';
import { openTemplateEditor } from '../templateEditor.js';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nowHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Mirror of the server templateEngine so the preview updates instantly.
function formatDate(iso, pref) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  if (pref === 'DD/MM/YYYY') return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
function formatTime(t) {
  if (!t || !/^\d{1,2}:\d{2}$/.test(t)) return t || '';
  let [h, m] = t.split(':'); h = parseInt(h, 10);
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}
function buildVars(settings, form) {
  const v = {};
  for (const [k, val] of Object.entries(settings.variables || {})) v[k] = val == null ? '' : String(val);
  v.church_name = settings.churchName || v.church_name || '';
  v.date = formatDate(form.date, settings.dateFormat);
  v.time = formatTime(form.time);
  for (const [k, val] of Object.entries(form)) {
    if (k === 'date' || k === 'time') continue;
    if (val) v[k] = String(val);
  }
  return v;
}
function subst(pattern, vars) {
  return String(pattern || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export async function renderNewStream(ctx = {}) {
  const isAdmin = ctx.state && ctx.state.user && ctx.state.user.role === 'admin';
  const [tplRes, setRes] = await Promise.all([api.get('/api/templates'), api.get('/api/settings')]);
  const templates = (tplRes.ok && tplRes.data.templates) || [];
  const settings = (setRes.ok && setRes.data.settings) || {};

  const node = h('<div></div>');

  if (templates.length === 0) {
    node.innerHTML = `<div class="card center">
      <h2>No templates yet</h2>
      <p class="muted">${isAdmin
        ? 'Create a template first to start a stream.'
        : 'An administrator needs to create stream templates before you can start a stream.'}</p>
      ${isAdmin ? '<a class="btn mt" href="#/templates">Go to Templates</a>' : ''}
    </div>`;
    return node;
  }

  renderPicker(node, templates, settings, isAdmin, ctx);
  return node;
}

function renderPicker(node, templates, settings, isAdmin, ctx) {
  node.innerHTML = `
    <h1>New Stream</h1>
    <p class="subtitle">Pick what you're streaming today${isAdmin ? ', or create a new template' : ''}.</p>
    <div class="grid grid-cards" id="picker"></div>`;
  const picker = node.querySelector('#picker');
  templates.forEach((t) => {
    const card = h(`<div class="pick-card" role="button" tabindex="0">
      ${esc(t.name)}
      <span class="pc-privacy">${esc(t.defaultPrivacy)}</span>
    </div>`);
    card.onclick = () => renderForm(node, t, templates, settings, isAdmin, ctx);
    card.onkeydown = (e) => { if (e.key === 'Enter') card.click(); };
    picker.appendChild(card);
  });

  if (isAdmin) {
    const addCard = h(`<div class="pick-card pick-card-new" role="button" tabindex="0">
      + New template
      <span class="pc-privacy">Add Saturday Night Mass, etc.</span>
    </div>`);
    addCard.onclick = () => {
      openTemplateEditor({
        settings,
        onSaved: () => renderNewStream(ctx).then((n) => mount(n)),
      });
    };
    addCard.onkeydown = (e) => { if (e.key === 'Enter') addCard.click(); };
    picker.appendChild(addCard);
  }
}

function initialTime(template, settings) {
  if (template.defaultTime) return template.defaultTime;
  return nowHM();
}

function timePresetsHtml(presets, formatTime) {
  if (!presets || presets.length === 0) return '';
  return `<div class="chips time-presets" id="timePresets">
    ${presets
      .map((p) => {
        const label = p.label || formatTime(p.time);
        return `<button type="button" class="chip" data-time="${esc(p.time)}">${esc(label)}</button>`;
      })
      .join('')}
  </div>`;
}

function templateTimePresets(template, settings) {
  if (template.timePresets && template.timePresets.length > 0) return template.timePresets;
  return settings.timePresets || [];
}

function renderForm(node, template, templates, settings, isAdmin, ctx) {
  const restreamOn = Boolean(settings.restream && settings.restream.enabled);
  const extra = template.extraFields || [];
  const extraHtml = extra
    .map(
      (f) => `<div class="field">
        <label for="xf_${esc(f.key)}">${esc(f.label)}${f.required ? ' *' : ''}</label>
        <input type="text" id="xf_${esc(f.key)}" data-key="${esc(f.key)}" />
      </div>`
    )
    .join('');

  node.innerHTML = `
    <button class="btn btn-sm btn-outline mb" id="back">← Back</button>
    <h1>${esc(template.name)}</h1>
    ${restreamOn ? '<p class="hint mb">Restream mode is ON — this stream is sent through Restream to the destinations you tick below.</p>' : ''}
    <div class="card">
      <div class="grid grid-2">
        <div class="field">
          <label for="date">Date</label>
          <input type="date" id="date" value="${todayISO()}" />
        </div>
        <div class="field">
          <label for="time">Time</label>
          <input type="time" id="time" value="${initialTime(template, settings)}" />
          ${timePresetsHtml(templateTimePresets(template, settings), formatTime)}
        </div>
      </div>
      ${extraHtml}
      <div class="field">
        <label for="coverImage">Cover image <span class="muted">(optional)</span></label>
        ${template.hasCoverImage
          ? `<p class="hint">Template default below — pick a file to use a custom cover for this event.</p>
             <img class="cover-preview" src="/api/templates/${esc(template.id)}/cover" alt="Template default cover" />`
          : '<p class="hint">Sets the YouTube thumbnail for this stream.</p>'}
        <input type="file" id="coverImage" accept="image/jpeg,image/png,image/webp" />
        <img class="cover-preview" id="coverPreview" hidden alt="Cover preview" />
        <p class="hint">JPEG, PNG or WebP, max 2 MB. Your YouTube channel must be verified for custom thumbnails.</p>
      </div>
      <div class="field">
        <label>Privacy</label>
        <div class="segmented" id="privacy">
          ${['public','unlisted','private'].map((p) => `<button type="button" data-p="${p}" class="${p === template.defaultPrivacy ? 'active' : ''}">${p[0].toUpperCase()+p.slice(1)}</button>`).join('')}
        </div>
        <p class="hint">${template.playlistTitle
          ? `Added to YouTube playlist: <strong>${esc(template.playlistTitle)}</strong> when the stream is created.`
          : 'No YouTube playlist set — edit the template to choose one (e.g. Sunday Services, Weddings).'}</p>
      </div>
      <div class="field">
        <label>Stream to</label>
        <div class="stream-to-options">
          <label class="stream-to-option">
            <input type="checkbox" id="streamToYoutube" ${(template.streamTo && template.streamTo.youtube) !== false ? 'checked' : ''} /> YouTube
          </label>
          <label class="stream-to-option">
            <input type="checkbox" id="streamToFacebook" ${template.streamTo && template.streamTo.facebook ? 'checked' : ''} /> Facebook
          </label>
        </div>
        <p class="hint">${restreamOn
          ? 'Restream sends the one ATEM feed to each ticked destination — titles are set automatically from this template.'
          : 'Facebook simulcasts the YouTube feed to the connected page when the Streamer goes live (public/unlisted streams only).'}</p>
      </div>
    </div>

    <div class="card mt">
      <h2>Preview</h2>
      <div class="field"><label>Title</label><div class="readonly-box"><code id="pvTitle"></code></div></div>
      <div class="field"><label>Description</label><div class="readonly-box"><code id="pvDesc" style="white-space:pre-wrap"></code></div></div>
    </div>

    <button class="btn btn-green btn-lg mt" id="create">Create Stream</button>`;

  let privacy = template.defaultPrivacy;

  const getForm = () => {
    const form = {
      date: node.querySelector('#date').value,
      time: node.querySelector('#time').value,
    };
    node.querySelectorAll('[data-key]').forEach((inp) => { form[inp.getAttribute('data-key')] = inp.value.trim(); });
    return form;
  };

  const updatePreview = () => {
    const vars = buildVars(settings, getForm());
    node.querySelector('#pvTitle').textContent = subst(template.titlePattern, vars);
    node.querySelector('#pvDesc').textContent = subst(template.descriptionPattern, vars);
  };

  node.querySelectorAll('#date, #time, [data-key]').forEach((inp) => inp.addEventListener('input', updatePreview));
  const timeInput = node.querySelector('#time');
  node.querySelectorAll('#timePresets .chip').forEach((chip) => {
    chip.onclick = () => {
      timeInput.value = chip.getAttribute('data-time');
      timeInput.dispatchEvent(new Event('input', { bubbles: true }));
    };
  });
  node.querySelectorAll('#privacy button').forEach((b) => {
    b.onclick = () => {
      privacy = b.getAttribute('data-p');
      node.querySelectorAll('#privacy button').forEach((x) => x.classList.toggle('active', x === b));
    };
  });
  node.querySelector('#back').onclick = () => renderPicker(node, templates, settings, isAdmin, ctx);
  const coverInput = node.querySelector('#coverImage');
  const coverPreview = node.querySelector('#coverPreview');
  coverInput.onchange = () => {
    const file = coverInput.files && coverInput.files[0];
    if (file) previewImageFile(file, coverPreview);
    else coverPreview.hidden = true;
  };
  updatePreview();

  node.querySelector('#create').onclick = async (e) => {
    for (const f of extra) {
      if (f.required && !node.querySelector(`#xf_${CSS.escape(f.key)}`).value.trim()) {
        return toast(`Please fill in "${f.label}".`, 'err');
      }
    }
    busy(e.target, true);
    const payload = {
      templateId: template.id,
      privacy,
      streamTo: {
        youtube: node.querySelector('#streamToYoutube').checked,
        facebook: node.querySelector('#streamToFacebook').checked,
      },
      form: getForm(),
    };
    const coverFile = coverInput.files && coverInput.files[0];
    if (coverFile) {
      try {
        const image = await readImageFile(coverFile);
        payload.coverImageBase64 = image.imageBase64;
        payload.coverImageMime = image.mimeType;
      } catch (err) {
        busy(e.target, false, 'Create Stream');
        return toast(err.message || 'Invalid cover image.', 'err');
      }
    }
    const res = await api.post('/api/streams', payload);
    busy(e.target, false, 'Create Stream');
    if (!res.ok) {
      toast(res.error, 'err');
      return;
    }
    renderConfirm(node, res.data, settings);
  };
}

function renderConfirm(node, data, settings = {}) {
  const url = data.watchUrl;
  const smsOn = isSmsShareAvailable(settings.clicksend);

  // Restream mode: the YouTube link doesn't exist until Restream creates the
  // broadcast (when ATEM starts). Show clear instructions instead of a link.
  if (data.viaRestream || !url) {
    node.innerHTML = `
      <div class="confirm">
        <div class="big-check">✓</div>
        <h1>You're all set</h1>
        <p class="mb"><strong>Just start streaming from the Streamer as usual.</strong><br/>
        Restream picks up the feed and goes live on the destinations you chose.</p>
        ${data.warning ? `<p class="badge badge-warn">${esc(data.warning)}</p>` : ''}
        <p class="hint">The YouTube watch link appears on the <strong>Streams</strong> page shortly after the stream goes live.</p>
        <div class="btn-row mt" style="justify-content:center">
          <a class="btn btn-outline" href="#/streams">Go to Streams</a>
          <button class="btn" id="another">Create another</button>
        </div>
      </div>`;
    node.querySelector('#another').onclick = () => renderNewStream().then((n) => mount(n));
    return;
  }

  const shareStream = {
    title: data.title || (data.stream && data.stream.title),
    watchUrl: url,
    templateName: data.templateName,
    emailSubjectPattern: data.emailSubjectPattern,
    emailBodyPattern: data.emailBodyPattern,
    smsBodyPattern: data.smsBodyPattern,
  };
  node.innerHTML = `
    <div class="confirm">
      <div class="big-check">✓</div>
      <h1>You're all set</h1>
      <p class="mb"><strong>Just start streaming from the Streamer as usual.</strong><br/>
      YouTube will go live automatically — don't touch YouTube Studio.</p>
      ${data.warning ? `<p class="badge badge-warn">${esc(data.warning)}</p>` : ''}
      ${shareWatchBlock(url)}
      <div class="btn-row mt" style="justify-content:center">
        <button type="button" class="btn btn-outline" id="emailShare">Email link</button>
        ${smsOn ? '<button type="button" class="btn btn-outline" id="textShare">Text link</button>' : ''}
        <a class="btn btn-outline" href="${esc(url)}" target="_blank" rel="noopener">Open on YouTube</a>
        <button class="btn" id="another">Create another</button>
      </div>
    </div>`;
  node.querySelector('#copyLink').onclick = async () => {
    const ok = await copyToClipboard(url);
    toast(ok ? 'Link copied.' : 'Select and copy manually.', ok ? 'ok' : 'err');
  };
  node.querySelector('#emailShare').onclick = () => openStreamEmail(shareStream);
  const textShare = node.querySelector('#textShare');
  if (textShare) textShare.onclick = () => openStreamSms(shareStream);
  node.querySelector('#another').onclick = () => renderNewStream().then((n) => mount(n));
}
