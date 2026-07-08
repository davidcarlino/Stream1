'use strict';

const config = require('./config');
const { AppError } = require('./middleware/errors');

const CLICKSEND_URL = 'https://rest.clicksend.com/v3/sms/send';

function normalizePhone(value) {
  let p = String(value || '').trim().replace(/[\s().-]/g, '');
  if (!p) return '';
  if (/^04\d{8}$/.test(p)) return `+61${p.slice(1)}`;
  if (/^0\d{9,10}$/.test(p)) return `+61${p.slice(1)}`;
  if (/^61\d{9,}$/.test(p)) return `+${p}`;
  if (!p.startsWith('+')) return `+${p}`;
  return p;
}

function isValidE164(value) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

function rejectMultipleRecipients(value) {
  const raw = String(value || '').trim();
  if (/[,;]/.test(raw)) {
    throw new AppError('Enter one mobile number only.', { status: 400, code: 'multiple_recipients' });
  }
}

function extractClickSendMeta(data) {
  const msg = data && data.data && Array.isArray(data.data.messages) ? data.data.messages[0] : null;
  return {
    responseCode: (data && data.response_code) || null,
    responseMsg: (data && data.response_msg) || null,
    httpCode: (data && data.http_code) || null,
    messageId: (msg && (msg.message_id || msg.message_id_global)) || null,
    status: (msg && msg.status) || null,
    statusText: (msg && (msg.status_text || msg.error_text)) || null,
    queuedCount: data && data.data ? data.data.queued_count : null,
    blockedCount: data && data.data ? data.data.blocked_count : null,
  };
}

function attachClickSendContext(err, data) {
  if (data) err.clickSendMeta = extractClickSendMeta(data);
  return err;
}

async function sendSms({ to, body }) {
  const username = config.clicksend.username;
  const apiKey = config.clicksend.apiKey;
  if (!username || !apiKey) {
    throw new AppError(
      'ClickSend is not configured. Add CLICKSEND_USERNAME and CLICKSEND_API_KEY to the server .env.',
      { status: 503, code: 'clicksend_not_configured' }
    );
  }

  rejectMultipleRecipients(to);

  const toInput = String(to || '').trim();
  const phone = normalizePhone(toInput);
  if (!phone) {
    throw new AppError('Enter a mobile number.', { status: 400, code: 'missing_recipient' });
  }
  if (!isValidE164(phone)) {
    throw new AppError('Invalid mobile number. Use Australian mobile format, e.g. 0411222333.', {
      status: 400,
      code: 'invalid_phone',
    });
  }

  const message = String(body || '').trim();
  if (!message) {
    throw new AppError('Message is required.', { status: 400, code: 'missing_body' });
  }
  if (message.length > 1224) {
    throw new AppError('Message is too long for a single SMS.', { status: 400, code: 'message_too_long' });
  }

  const payload = {
    messages: [
      {
        source: 'stream1',
        body: message,
        to: phone,
        ...(config.clicksend.from ? { from: config.clicksend.from } : {}),
      },
    ],
  };

  const auth = Buffer.from(`${username}:${apiKey}`).toString('base64');
  const res = await fetch(CLICKSEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }

  const clickSend = extractClickSendMeta(data);

  if (!res.ok) {
    const detail =
      (data && (data.response_msg || data.message)) ||
      clickSend.statusText ||
      clickSend.status ||
      '';
    throw attachClickSendContext(
      new AppError(
        detail ? `Could not send SMS: ${detail}` : 'Could not send SMS via ClickSend.',
        { status: 502, code: 'clicksend_send_failed' }
      ),
      data
    );
  }

  if (clickSend.status && String(clickSend.status).toUpperCase() === 'FAILED') {
    const detail = clickSend.statusText || 'ClickSend rejected the message.';
    throw attachClickSendContext(
      new AppError(detail, { status: 502, code: 'clicksend_send_failed' }),
      data
    );
  }

  if (data && data.response_code && data.response_code !== 'SUCCESS') {
    throw attachClickSendContext(
      new AppError(data.response_msg || 'ClickSend could not send the SMS.', {
        status: 502,
        code: 'clicksend_send_failed',
      }),
      data
    );
  }

  return { ok: true, to: phone, toInput, clickSend };
}

module.exports = { sendSms, normalizePhone, isValidE164, extractClickSendMeta };
