'use strict';

/**
 * Symmetric encryption for secrets stored at rest (the YouTube refresh token).
 *
 * AES-256-GCM with a random 12-byte IV per encryption and the built-in auth
 * tag, so stored values are both confidential and tamper-evident. The key comes
 * from TOKEN_ENCRYPTION_KEY (never stored in the database). If someone gains
 * read access to Mongo but not the .env key, the refresh token stays useless.
 */

const crypto = require('crypto');
const config = require('./config');

const ALGO = 'aes-256-gcm';

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, config.tokenEncryptionKey, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store IV + tag + ciphertext together, base64-encoded.
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  };
}

function decrypt(payload) {
  if (!payload || !payload.iv || !payload.tag || !payload.data) {
    throw new Error('Malformed encrypted payload');
  }
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, config.tokenEncryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
