import { api } from './api.js';
import { modal, esc, toast, busy } from './ui.js';

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function displayNumber(log) {
  const input = log.toInput || '';
  const e164 = log.toE164 || '';
  if (input && e164 && input !== e164) return `${input} → ${e164}`;
  return input || e164 || '—';
}

function clickSendDetail(log) {
  const cs = log.clickSend || {};
  const parts = [];
  if (log.error) parts.push(log.error);
  if (cs.responseMsg) parts.push(cs.responseMsg);
  if (cs.statusText && cs.statusText !== cs.responseMsg) parts.push(cs.statusText);
  if (cs.status) parts.push(`Status: ${cs.status}`);
  if (cs.messageId) parts.push(`ID: ${cs.messageId}`);
  if (cs.blockedCount > 0) parts.push('Blocked by ClickSend');
  return parts.join(' · ') || (log.status === 'sent' ? 'Accepted by ClickSend' : 'No detail recorded');
}

function smsLogRowHtml(log) {
  const ok = log.status === 'sent';
  return `<article class="sms-log-row">
    <div class="sms-log-head">
      <span class="badge ${ok ? 'badge-on' : 'badge-off'}">${ok ? 'Sent' : 'Failed'}</span>
      <time class="sms-log-when">${esc(fmtWhen(log.createdAt))}</time>
    </div>
    <p class="sms-log-meta"><strong>To:</strong> ${esc(displayNumber(log))} · <strong>By:</strong> ${esc(log.sentBy || 'unknown')}</p>
    <p class="sms-log-detail">${esc(clickSendDetail(log))}</p>
    ${log.bodyPreview ? `<p class="sms-log-body">${esc(log.bodyPreview)}</p>` : ''}
  </article>`;
}

export async function openSmsLogsModal() {
  const res = await api.get('/api/sms/logs');
  if (!res.ok) {
    toast(res.error || 'Could not load text logs.', 'err');
    return;
  }

  const logs = res.data.logs || [];

  await modal((close) => {
    const el = document.createElement('div');
    el.className = 'sms-logs-modal';
    el.innerHTML = `
      <h2>Text message log</h2>
      <p class="muted">Recent SMS sends from STREAM1 (newest first). “Sent” means ClickSend accepted the message — check ClickSend dashboard if the recipient did not receive it.</p>
      <div class="sms-log-list" id="smsLogList">
        ${logs.length
          ? logs.map(smsLogRowHtml).join('')
          : '<p class="muted">No texts logged yet. Sends are recorded from now on.</p>'}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="smsLogsRefresh">Refresh</button>
        <button type="button" class="btn" id="smsLogsClose">Close</button>
      </div>`;

    el.querySelector('#smsLogsClose').onclick = () => close(true);

    const refreshBtn = el.querySelector('#smsLogsRefresh');
    refreshBtn.onclick = async () => {
      busy(refreshBtn, true, 'Refreshing…');
      const again = await api.get('/api/sms/logs');
      busy(refreshBtn, false, 'Refresh');
      if (!again.ok) return toast(again.error || 'Could not refresh logs.', 'err');
      const list = el.querySelector('#smsLogList');
      const items = again.data.logs || [];
      list.innerHTML = items.length
        ? items.map(smsLogRowHtml).join('')
        : '<p class="muted">No texts logged yet. Sends are recorded from now on.</p>';
    };

    return el;
  });
}
