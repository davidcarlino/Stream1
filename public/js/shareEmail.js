import { api } from './api.js';
import { modal, esc, toast, busy } from './ui.js';

const DEFAULT_SUBJECT = 'Stream Link: {title}';
const DEFAULT_BODY = `Hi there,

below is the link for {title}

{link}

Thank you`;

function subst(pattern, vars) {
  return String(pattern || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function buildStreamEmail({
  title,
  watchUrl,
  emailSubjectPattern,
  emailBodyPattern,
  templateName,
}) {
  const vars = {
    title: title || 'Live stream',
    link: watchUrl || '',
    template: templateName || '',
  };
  const subject = subst(emailSubjectPattern || DEFAULT_SUBJECT, vars);
  const body = subst(emailBodyPattern || DEFAULT_BODY, vars);
  return { subject, body };
}

async function fetchEmailStatus() {
  const res = await api.get('/api/email/status');
  if (!res.ok) {
    return { configured: false, connected: false, email: null, error: res.error };
  }
  return { ...res.data, error: null };
}

function emailSetupRequiredModal({ configured, connected }) {
  return modal((close) => {
    let title = 'Email not connected';
    let message = 'You must set up your email OAuth in Settings before sending stream links by email.';
    if (!configured) {
      title = 'Email not configured';
      message =
        'Gmail sending is not set up on this STREAM1 Server yet. An admin must add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server .env, then connect Gmail in Settings.';
    } else if (!connected) {
      message =
        'Connect the church Gmail account in Settings before sending stream links. STREAM1 will send email on your behalf through that account.';
    }

    const el = document.createElement('div');
    el.innerHTML = `
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(message)}</p>
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

function composeEmailModal(stream, defaults) {
  return modal((close) => {
    const el = document.createElement('div');
    el.innerHTML = `
      <h2>Email stream link</h2>
      <p class="muted">Send from the Gmail account connected in Settings.</p>
      <div class="field">
        <label for="emailTo">To</label>
        <input type="text" id="emailTo" placeholder="name@example.com" autocomplete="email" />
        <p class="hint">Separate multiple addresses with commas.</p>
      </div>
      <div class="field">
        <label for="emailSubject">Subject</label>
        <input type="text" id="emailSubject" value="${esc(defaults.subject)}" />
      </div>
      <div class="field">
        <label for="emailBody">Message</label>
        <textarea id="emailBody" rows="8">${esc(defaults.body)}</textarea>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" data-cancel>Cancel</button>
        <button type="button" class="btn" data-send>Send email</button>
      </div>`;

    const toInput = el.querySelector('#emailTo');
    const subjectInput = el.querySelector('#emailSubject');
    const bodyInput = el.querySelector('#emailBody');
    const sendBtn = el.querySelector('[data-send]');

    toInput.focus();
    el.querySelector('[data-cancel]').onclick = () => close(false);

    sendBtn.onclick = async () => {
      const to = toInput.value.trim();
      const subject = subjectInput.value.trim();
      const body = bodyInput.value.trim();
      if (!to) return toast('Enter at least one email address.', 'err');
      if (!subject) return toast('Subject is required.', 'err');
      if (!body) return toast('Message is required.', 'err');

      busy(sendBtn, true);
      const res = await api.post('/api/email/send', { to, subject, body });
      busy(sendBtn, false, 'Send email');

      if (!res.ok) {
        toast(res.error || 'Could not send email.', 'err');
        return;
      }

      toast('Email sent.', 'ok');
      close(true);
    };

    return el;
  });
}

/** Check Gmail OAuth, then open compose dialog and send via the server. */
export async function openStreamEmail(stream) {
  const status = await fetchEmailStatus();
  if (status.error) {
    toast(status.error, 'err');
    return;
  }

  if (!status.configured || !status.connected) {
    await emailSetupRequiredModal(status);
    return;
  }

  const defaults = buildStreamEmail({
    title: stream.title,
    watchUrl: stream.watchUrl,
    emailSubjectPattern: stream.emailSubjectPattern,
    emailBodyPattern: stream.emailBodyPattern,
    templateName: stream.templateName,
  });

  await composeEmailModal(stream, defaults);
}
