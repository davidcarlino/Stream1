'use strict';

const gmailAuth = require('./auth/gmailAuth');
const { AppError } = require('./middleware/errors');

function encodeMimeWord(value) {
  const text = String(value || '');
  if (/^[\t\x20-\x7e]*$/.test(text)) return text;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

function encodeMimeMessage({ to, subject, body }) {
  const bodyB64 = Buffer.from(String(body || ''), 'utf8').toString('base64');
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeMimeWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyB64,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function parseEmailList(value) {
  return String(value || '')
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function sendPlainEmail({ to, subject, body }) {
  const recipients = parseEmailList(to);
  if (!recipients.length) {
    throw new AppError('Enter at least one email address.', { status: 400, code: 'missing_recipient' });
  }
  for (const addr of recipients) {
    if (!isValidEmail(addr)) {
      throw new AppError(`Invalid email address: ${addr}`, { status: 400, code: 'invalid_email' });
    }
  }

  const subjectText = String(subject || '').trim();
  const bodyText = String(body || '').trim();
  if (!subjectText) {
    throw new AppError('Subject is required.', { status: 400, code: 'missing_subject' });
  }
  if (!bodyText) {
    throw new AppError('Message is required.', { status: 400, code: 'missing_body' });
  }

  const auth = await gmailAuth.getAuthorizedClient();
  const token = await auth.getAccessToken();
  if (!token || !token.token) {
    throw new AppError('Gmail connection lost. Reconnect in Settings.', {
      status: 401,
      code: 'gmail_oauth_expired',
    });
  }

  const raw = encodeMimeMessage({ to: recipients.join(', '), subject: subjectText, body: bodyText });
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = (data.error && data.error.message) || '';
    } catch {
      /* ignore */
    }
    throw new AppError(
      detail ? `Could not send email: ${detail}` : 'Could not send email via Gmail.',
      { status: 502, code: 'gmail_send_failed' }
    );
  }

  return { ok: true, recipients };
}

module.exports = { sendPlainEmail, parseEmailList, isValidEmail };
