import { api } from './api.js';
import { h, esc, toast, modal, busy } from './ui.js';
import { readImageFile, previewImageFile } from './images.js';
import { initPlaylistPicker } from './playlistPicker.js';

function availableVars(settings) {
  const base = ['date', 'time', 'name', 'church_name'];
  const custom = Object.keys(settings.variables || {});
  return [...base, ...custom];
}

/** Open the create/edit template modal. Calls onSaved() after a successful save. */
export async function openTemplateEditor({ template, settings, onSaved }) {
  const isEdit = Boolean(template);
  const t = template || {
    name: '',
    titlePattern: '',
    descriptionPattern: '',
    allowCustomTitle: false,
    allowCustomDescription: false,
    defaultPrivacy: 'unlisted',
    streamTo: { youtube: true, facebook: false },
    defaultTime: '',
    timePresets: [],
    playlistId: null,
    playlistTitle: null,
    emailSubjectPattern: 'Stream link : {title}',
    emailBodyPattern: 'You can watch the live stream here:\n\n{link}\n',
    smsBodyPattern: `{title}

Here is the streaming link for {title}

{link}

Thank you,
{church_name}`,
    extraFields: [],
  };

  const shareChips = ['{title}', '{event_name}', '{link}', '{template}', '{church_name}']
    .map((v) => `<span class="chip" data-var="${esc(v)}">${esc(v)}</span>`)
    .join('');

  const chips = availableVars(settings)
    .map((v) => `<span class="chip" data-var="{${esc(v)}}">{${esc(v)}}</span>`)
    .join('');

  let playlistPicker = null;

  await modal((close) => {
    const el = h(`<div>
      <h2>${isEdit ? 'Edit template' : 'New template'}</h2>
      <div class="field">
        <label>Template name</label>
        <input type="text" id="name" value="${esc(t.name)}" placeholder="e.g. Sunday Morning" />
      </div>
      <div class="field">
        <label class="switch-row">
          <span>Allow custom title on New Stream</span>
          <span class="switch">
            <input type="checkbox" id="allowCustomTitle" ${t.allowCustomTitle ? 'checked' : ''} />
            <span class="switch-slider" aria-hidden="true"></span>
          </span>
        </label>
        <p class="hint">When ON, staff type the YouTube title each time — the title pattern below is hidden.</p>
      </div>
      <div class="field" id="titlePatternWrap">
        <label>Title pattern</label>
        <input type="text" id="title" value="${esc(t.titlePattern)}" placeholder="Sunday Morning Service — {date}" />
        <div class="chips" data-target="title">${chips}</div>
      </div>
      <div class="field">
        <label class="switch-row">
          <span>Allow custom description on New Stream</span>
          <span class="switch">
            <input type="checkbox" id="allowCustomDescription" ${t.allowCustomDescription ? 'checked' : ''} />
            <span class="switch-slider" aria-hidden="true"></span>
          </span>
        </label>
        <p class="hint">When ON, staff type the YouTube description each time — the description pattern below is hidden.</p>
      </div>
      <div class="field" id="descPatternWrap">
        <label>Description pattern</label>
        <textarea id="desc" placeholder="{church_name} livestream, {date} at {time}.">${esc(t.descriptionPattern)}</textarea>
        <div class="chips" data-target="desc">${chips}</div>
      </div>
      <div class="grid grid-2">
        <div class="field">
          <label>Default privacy</label>
          <select id="privacy">
            ${['public', 'unlisted', 'private']
              .map((p) => `<option value="${p}" ${p === t.defaultPrivacy ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`)
              .join('')}
          </select>
        </div>
        <div class="field">
          <label>Default time <span class="muted">(optional)</span></label>
          <input type="time" id="defaultTime" value="${esc(t.defaultTime || '')}" />
          <p class="hint">Pre-fills the time field on New Stream.</p>
        </div>
      </div>
      <div class="field">
        <label>Stream to</label>
        <div class="stream-to-options">
          <label class="stream-to-option">
            <input type="checkbox" id="streamToYoutube" ${(t.streamTo && t.streamTo.youtube) !== false ? 'checked' : ''} /> YouTube
          </label>
          <label class="stream-to-option" id="streamToFacebookWrap">
            <input type="checkbox" id="streamToFacebook" ${t.streamTo && t.streamTo.facebook && t.defaultPrivacy === 'public' ? 'checked' : ''} /> Facebook
          </label>
        </div>
        <p class="hint" id="streamToHint">Facebook is only available when Default privacy is Public. Unlisted/Private templates stay YouTube-only.</p>
      </div>
      <div class="field">
        <label>Favourite times <span class="muted">(up to 3)</span></label>
        <div id="timePresets"></div>
        <button type="button" class="btn btn-sm btn-outline" id="addTimePreset">+ Add time</button>
        <p class="hint">Quick-pick buttons for this template on New Stream — most services use 2 or 3 slots.</p>
      </div>
      <div class="field">
        <label>Default YouTube playlist</label>
        <p class="hint">Synced live from your connected channel. Every stream created from this template is added to the playlist you pick — e.g. Sunday Services, Saturday Night Mass, Funerals &amp; Weddings.</p>
        <div id="playlistPickerHost"></div>
      </div>
      <div class="field">
        <label>Share email — subject</label>
        <input type="text" id="emailSubject" value="${esc(t.emailSubjectPattern || 'Stream link : {title}')}" placeholder="Stream link : {title}" />
        <div class="chips" data-target="emailSubject">${shareChips}</div>
      </div>
      <div class="field">
        <label>Share email — body</label>
        <textarea id="emailBody" rows="4" placeholder="You can watch the live stream here:&#10;&#10;{link}">${esc(t.emailBodyPattern || 'You can watch the live stream here:\n\n{link}\n')}</textarea>
        <div class="chips" data-target="emailBody">${shareChips}</div>
        <p class="hint">Used when someone presses Share → Email. Placeholders: <code>{title}</code> stream name, <code>{link}</code> YouTube URL, <code>{template}</code> template name.</p>
      </div>
      <div class="field">
        <label>Share text — message</label>
        <textarea id="smsBody" rows="6" placeholder="{title}&#10;&#10;Here is the streaming link for {title}&#10;&#10;{link}&#10;&#10;Thank you,&#10;{church_name}">${esc(t.smsBodyPattern || `{title}

Here is the streaming link for {title}

{link}

Thank you,
{church_name}`)}</textarea>
        <div class="chips" data-target="smsBody">${shareChips}</div>
        <p class="hint">Used when someone presses Share → Text. Sends one SMS via ClickSend. Placeholders: <code>{title}</code> / <code>{event_name}</code>, <code>{link}</code>, <code>{church_name}</code> (from Settings → Church name).</p>
      </div>
      <div class="field">
        <label>Default cover image <span class="muted">(optional)</span></label>
        ${isEdit && t.hasCoverImage ? `<img class="cover-preview" id="existingCover" src="/api/templates/${esc(t.id)}/cover" alt="Current cover" />` : ''}
        <input type="file" id="coverFile" accept="image/jpeg,image/png,image/webp" />
        <img class="cover-preview" id="coverPreview" hidden alt="New cover preview" />
        <div class="btn-row mt">
          ${isEdit && t.hasCoverImage ? '<button type="button" class="btn btn-sm btn-outline" id="removeCover">Remove cover</button>' : ''}
        </div>
        <p class="hint">Used on New Stream unless staff pick a different image. YouTube requires a verified channel for custom thumbnails.</p>
      </div>
      <div class="field">
        <label>Extra questions on the New Stream form</label>
        <div id="fields"></div>
        <button type="button" class="btn btn-sm btn-outline" id="addField">+ Add field</button>
        <p class="hint">e.g. a "name" field for funerals/weddings, usable as {name}.</p>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" id="cancel">Cancel</button>
        <button class="btn" id="save">${isEdit ? 'Save changes' : 'Create template'}</button>
      </div>
    </div>`);

    initPlaylistPicker(el.querySelector('#playlistPickerHost'), {
      selectedId: t.playlistId,
      selectedTitle: t.playlistTitle,
    }).then((picker) => {
      playlistPicker = picker;
    });

    el.querySelectorAll('.chips').forEach((group) => {
      const targetId = group.getAttribute('data-target');
      group.querySelectorAll('.chip').forEach((chip) => {
        chip.onclick = () => {
          const input = el.querySelector(`#${targetId}`);
          const v = chip.getAttribute('data-var');
          const start = input.selectionStart ?? input.value.length;
          input.value = input.value.slice(0, start) + v + input.value.slice(input.selectionEnd ?? start);
          input.focus();
        };
      });
    });

    const fieldsWrap = el.querySelector('#fields');
    const addFieldRow = (f = { key: '', label: '', required: false }) => {
      const fr = h(`<div class="kv-row">
        <input type="text" placeholder="key (e.g. name)" value="${esc(f.key)}" data-f="key" />
        <input type="text" placeholder="Question label" value="${esc(f.label)}" data-f="label" />
        <label style="display:flex;align-items:center;gap:6px;margin:0;white-space:nowrap">
          <input type="checkbox" data-f="required" ${f.required ? 'checked' : ''} style="width:auto"/> Required
        </label>
        <button type="button" class="btn btn-sm btn-danger" data-f="remove">×</button>
      </div>`);
      fr.querySelector('[data-f="remove"]').onclick = () => fr.remove();
      fieldsWrap.appendChild(fr);
    };
    (t.extraFields || []).forEach(addFieldRow);
    el.querySelector('#addField').onclick = () => addFieldRow();

    const timePresetsWrap = el.querySelector('#timePresets');
    const addTimeBtn = el.querySelector('#addTimePreset');
    const MAX_TEMPLATE_TIMES = 3;

    const syncAddTimeBtn = () => {
      addTimeBtn.disabled = timePresetsWrap.querySelectorAll('.kv-row').length >= MAX_TEMPLATE_TIMES;
    };

    const addTimeRow = (p = { label: '', time: '' }) => {
      if (timePresetsWrap.querySelectorAll('.kv-row').length >= MAX_TEMPLATE_TIMES) return;
      const row = h(`<div class="kv-row">
        <input type="text" class="preset-label" placeholder="Label (optional)" value="${esc(p.label || '')}" />
        <input type="time" class="preset-time" value="${esc(p.time || '')}" />
        <button type="button" class="btn btn-sm btn-danger preset-del">×</button>
      </div>`);
      row.querySelector('.preset-del').onclick = () => {
        row.remove();
        syncAddTimeBtn();
      };
      timePresetsWrap.appendChild(row);
      syncAddTimeBtn();
    };

    (t.timePresets || []).forEach(addTimeRow);
    syncAddTimeBtn();
    addTimeBtn.onclick = () => addTimeRow();

    const privacySelect = el.querySelector('#privacy');
    const fbCheckbox = el.querySelector('#streamToFacebook');
    const fbWrap = el.querySelector('#streamToFacebookWrap');
    const streamToHint = el.querySelector('#streamToHint');
    const syncFacebookGate = () => {
      const allowFb = privacySelect.value === 'public';
      fbCheckbox.disabled = !allowFb;
      if (!allowFb) fbCheckbox.checked = false;
      fbWrap.classList.toggle('is-disabled', !allowFb);
      streamToHint.textContent = allowFb
        ? 'Public + Facebook: Restream posts the event name on every Facebook destination with the live video feed. YouTube uses the same title.'
        : 'Facebook is only available when Default privacy is Public. Unlisted/Private templates stay YouTube-only.';
    };
    privacySelect.addEventListener('change', syncFacebookGate);
    syncFacebookGate();

    const allowCustomTitle = el.querySelector('#allowCustomTitle');
    const allowCustomDescription = el.querySelector('#allowCustomDescription');
    const titlePatternWrap = el.querySelector('#titlePatternWrap');
    const descPatternWrap = el.querySelector('#descPatternWrap');
    const syncCustomSwitches = () => {
      titlePatternWrap.classList.toggle('hidden', allowCustomTitle.checked);
      descPatternWrap.classList.toggle('hidden', allowCustomDescription.checked);
    };
    allowCustomTitle.addEventListener('change', syncCustomSwitches);
    allowCustomDescription.addEventListener('change', syncCustomSwitches);
    syncCustomSwitches();

    let removeCover = false;
    const coverFileInput = el.querySelector('#coverFile');
    const coverPreview = el.querySelector('#coverPreview');
    coverFileInput.onchange = () => {
      removeCover = false;
      const file = coverFileInput.files && coverFileInput.files[0];
      if (file) previewImageFile(file, coverPreview);
      else coverPreview.hidden = true;
    };
    const removeBtn = el.querySelector('#removeCover');
    if (removeBtn) {
      removeBtn.onclick = () => {
        removeCover = true;
        coverFileInput.value = '';
        coverPreview.hidden = true;
        const existing = el.querySelector('#existingCover');
        if (existing) existing.hidden = true;
      };
    }

    el.querySelector('#cancel').onclick = () => close(false);
    el.querySelector('#save').onclick = async (e) => {
      const extraFields = Array.from(fieldsWrap.querySelectorAll('.kv-row'))
        .map((r) => ({
          key: r.querySelector('[data-f="key"]').value.trim(),
          label: r.querySelector('[data-f="label"]').value.trim(),
          required: r.querySelector('[data-f="required"]').checked,
        }))
        .filter((f) => f.key);

      const defaultTime = el.querySelector('#defaultTime').value;
      const timePresets = [];
      timePresetsWrap.querySelectorAll('.kv-row').forEach((r) => {
        const time = r.querySelector('.preset-time').value;
        if (!time) return;
        timePresets.push({
          label: r.querySelector('.preset-label').value.trim(),
          time,
        });
      });

      const selectedPlaylist = playlistPicker ? playlistPicker.getSelected() : { id: t.playlistId, title: t.playlistTitle };

      const payload = {
        name: el.querySelector('#name').value.trim(),
        allowCustomTitle: allowCustomTitle.checked,
        allowCustomDescription: allowCustomDescription.checked,
        titlePattern: el.querySelector('#title').value.trim(),
        descriptionPattern: el.querySelector('#desc').value,
        defaultPrivacy: el.querySelector('#privacy').value,
        streamTo: {
          youtube: el.querySelector('#streamToYoutube').checked,
          facebook: privacySelect.value === 'public' && fbCheckbox.checked,
        },
        defaultTime: defaultTime || null,
        timePresets,
        playlistId: selectedPlaylist.id,
        playlistTitle: selectedPlaylist.title,
        emailSubjectPattern: el.querySelector('#emailSubject').value.trim(),
        emailBodyPattern: el.querySelector('#emailBody').value,
        smsBodyPattern: el.querySelector('#smsBody').value,
        extraFields,
      };
      if (!payload.name) return toast('Template needs a name.', 'err');
      if (!payload.allowCustomTitle && !payload.titlePattern) {
        return toast('Template needs a title pattern.', 'err');
      }

      busy(e.target, true);
      const res = isEdit
        ? await api.put(`/api/templates/${template.id}`, payload)
        : await api.post('/api/templates', payload);
      if (!res.ok) {
        busy(e.target, false, isEdit ? 'Save changes' : 'Create template');
        return toast(res.error, 'err');
      }

      const templateId = isEdit ? template.id : res.data.template.id;
      const coverFile = coverFileInput.files && coverFileInput.files[0];

      if (removeCover) {
        const delRes = await api.del(`/api/templates/${templateId}/cover`);
        if (!delRes.ok) {
          busy(e.target, false, isEdit ? 'Save changes' : 'Create template');
          return toast(delRes.error, 'err');
        }
      } else if (coverFile) {
        try {
          const image = await readImageFile(coverFile);
          const upRes = await api.put(`/api/templates/${templateId}/cover`, image);
          if (!upRes.ok) {
            busy(e.target, false, isEdit ? 'Save changes' : 'Create template');
            return toast(upRes.error, 'err');
          }
        } catch (err) {
          busy(e.target, false, isEdit ? 'Save changes' : 'Create template');
          return toast(err.message || 'Invalid cover image.', 'err');
        }
      }

      busy(e.target, false, isEdit ? 'Save changes' : 'Create template');
      toast('Saved.', 'ok');
      close(true);
      if (onSaved) onSaved();
    };

    return el;
  });
}
