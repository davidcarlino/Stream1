import { api } from './api.js';
import { modal, esc, toast, busy } from './ui.js';

const DEFAULT_SMS_BODY = `{title}

Here is the streaming link for {title}

{link}

Thank you,
{church_name}`;

function subst(pattern, vars) {
  return String(pattern || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function buildStreamSms({
  title,
  watchUrl,
  smsBodyPattern,
  templateName,
  churchName,
}) {
  const eventTitle = title || 'Live stream';
  const vars = {
    title: eventTitle,
    event_name: eventTitle,
    link: watchUrl || '',
    template: templateName || '',
    church_name: churchName || 'St Marys Church',
  };
  const body = subst(smsBodyPattern || DEFAULT_SMS_BODY, vars);
  return { body };
}

async function fetchSmsStatus() {
  const res = await api.get('/api/sms/status');
  if (!res.ok) {
    return { configured: false, enabled: false, error: res.error };
  }
  return { ...res.data, error: null };
}

export function isSmsShareAvailable(status) {
  return Boolean(status && status.configured && status.enabled);
}

function smsSetupRequiredModal() {
  return modal((close) => {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2>Text messaging not configured</h2>
      <p class="muted">ClickSend credentials are not set up on this STREAM1 Server yet. An admin must add <code>CLICKSEND_USERNAME</code> and <code>CLICKSEND_API_KEY</code> to the server <code>.env</code> file, then reload environment in Diagnostics or restart the server.</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" data-cancel>Cancel</button>
        <button type="button" class="btn" data-settings>Go to Settings</button>
      </div>`;
    el.querySelector('[data-cancel]').onclick = () => close(false);
    el.querySelector('[data-settings]').onclick = () => {
      close(true);
      location.hash = '#/settings';
    };
    return el;
  });
}

function composeSmsModal(stream, defaults) {
  return modal((close) => {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2>Text stream link</h2>
      <p class="muted">Sends one SMS via ClickSend. Standard message rates apply.</p>
      <div class="field">
        <label for="smsTo">Mobile number</label>
        <input type="tel" id="smsTo" placeholder="0411222333" autocomplete="tel" inputmode="tel" />
        <p class="hint">Australian mobile format (e.g. 0411222333). One recipient per send.</p>
      </div>
      <div class="field">
        <label for="smsBody">Message</label>
        <textarea id="smsBody" rows="8">${esc(defaults.body)}</textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" data-cancel>Cancel</button>
        <button type="button" class="btn" data-send>Send text</button>
      </div>`;

    const toInput = el.querySelector('#smsTo');
    const bodyInput = el.querySelector('#smsBody');
    const sendBtn = el.querySelector('[data-send]');

    toInput.focus();
    el.querySelector('[data-cancel]').onclick = () => close(false);

    sendBtn.onclick = async () => {
      const to = toInput.value.trim();
      const body = bodyInput.value.trim();
      if (!to) return toast('Enter a mobile number.', 'err');
      if (!body) return toast('Message is required.', 'err');

      busy(sendBtn, true);
      const res = await api.post('/api/sms/send', { to, body });
      busy(sendBtn, false, 'Send text');

      if (!res.ok) {
        toast(res.error || 'Could not send text.', 'err');
        return;
      }

      toast('Text sent.', 'ok');
      close(true);
    };

    return el;
  });
}

/** Check ClickSend config, then open compose dialog and send via the server. */
export async function openStreamSms(stream) {
  const status = await fetchSmsStatus();
  if (status.error) {
    toast(status.error, 'err');
    return;
  }

  if (!status.configured) {
    await smsSetupRequiredModal();
    return;
  }

  if (!status.enabled) {
    toast('Text messaging is turned off. An admin can enable it in Settings.', 'err');
    return;
  }

  let churchName = stream.churchName || '';
  if (!churchName) {
    const settingsRes = await api.get('/api/settings');
    if (settingsRes.ok && settingsRes.data && settingsRes.data.settings) {
      churchName = settingsRes.data.settings.churchName || '';
    }
  }

  const defaults = buildStreamSms({
    title: stream.title,
    watchUrl: stream.watchUrl,
    smsBodyPattern: stream.smsBodyPattern,
    templateName: stream.templateName,
    churchName,
  });

  await composeSmsModal(stream, defaults);
}
