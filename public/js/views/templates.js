import { api } from '../api.js';
import { h, esc, toast, confirmDialog } from '../ui.js';
import { openTemplateEditor } from '../templateEditor.js';

export async function renderTemplates() {
  const node = h('<div></div>');
  // Return immediately so Templates appears on click while lists fetch.
  void load(node);
  return node;
}

async function load(node) {
  node.innerHTML = `<h1>Templates</h1><p class="subtitle">Reusable stream setups. Create one per kind of event.</p>
    <div class="btn-row mb"><button class="btn" id="new">+ New template</button></div>
    <div class="card" id="list"><p class="muted">Loading…</p></div>`;

  const [tplRes, setRes] = await Promise.all([api.get('/api/templates'), api.get('/api/settings')]);
  const templates = (tplRes.ok && tplRes.data.templates) || [];
  const settings = (setRes.ok && setRes.data.settings) || {};

  node.querySelector('#new').onclick = () =>
    openTemplateEditor({ settings, onSaved: () => load(node) });

  const list = node.querySelector('#list');
  if (templates.length === 0) {
    list.innerHTML = `<p class="muted">No templates yet.</p>`;
    return;
  }
  list.innerHTML = '';
  templates.forEach((t) => {
    const timeNote = t.defaultTime ? ` · default ${esc(t.defaultTime)}` : '';
    const presetsNote = (t.timePresets && t.timePresets.length)
      ? ` · ${t.timePresets.length} time${t.timePresets.length === 1 ? '' : 's'}`
      : '';
    const customNote = [
      t.allowCustomTitle ? 'custom title' : null,
      t.allowCustomDescription ? 'custom description' : null,
    ].filter(Boolean).join(' · ');
    const patternLine = t.allowCustomTitle
      ? 'Custom title each time'
      : esc(t.titlePattern);
    const rowEl = h(`<div class="list-row">
      <div class="grow">
        <strong>${esc(t.name)}</strong>
        <div class="muted" style="font-size:0.9rem">${patternLine}</div>
        <div class="muted" style="font-size:0.85rem">${esc(t.defaultPrivacy)}${t.playlistTitle ? ` · Playlist: ${esc(t.playlistTitle)}` : ' · no playlist'}${timeNote}${presetsNote}${t.hasCoverImage ? ' · cover set' : ''}${customNote ? ` · ${esc(customNote)}` : ''}</div>
      </div>
      <button class="btn btn-sm btn-outline" data-act="edit">Edit</button>
      <button class="btn btn-sm btn-danger" data-act="del">Delete</button>
    </div>`);
    rowEl.querySelector('[data-act="edit"]').onclick = () =>
      openTemplateEditor({ template: t, settings, onSaved: () => load(node) });
    rowEl.querySelector('[data-act="del"]').onclick = async () => {
      const ok = await confirmDialog('Delete template', `Delete "${t.name}"? This cannot be undone.`, { danger: true, confirmText: 'Delete' });
      if (!ok) return;
      const res = await api.del(`/api/templates/${t.id}`);
      if (!res.ok) return toast(res.error, 'err');
      toast('Template deleted.', 'ok');
      load(node);
    };
    list.appendChild(rowEl);
  });
}
