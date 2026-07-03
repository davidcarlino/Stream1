'use strict';

/**
 * Local secret management for the offline exe build.
 *
 * The session-signing secret and the token-at-rest encryption key are generated
 * once and stored alongside the chosen data folder (stream1-secrets.json), so
 * the whole setup is self-contained and portable with the database — no manual
 * .env editing required. The file is created with owner-only permissions where
 * the OS supports it.
 *
 * Note: because this is a single-user, fully-local, offline tool, the
 * encryption key living next to the data is an accepted trade-off (it protects
 * the stored YouTube refresh token from casual disk inspection / backup leaks,
 * not from someone with full access to this folder).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_NAME = 'stream1-secrets.json';

function loadOrCreate(dataDir) {
  const file = path.join(dataDir, FILE_NAME);

  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed.sessionSecret && /^[0-9a-f]{64}$/i.test(parsed.tokenEncryptionKey || '')) {
        return parsed;
      }
    } catch (err) {
      // Fall through and regenerate a valid file.
    }
  }

  const secrets = {
    sessionSecret: crypto.randomBytes(48).toString('hex'),
    tokenEncryptionKey: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch (err) {
    // chmod is a no-op / may throw on some Windows setups — non-fatal.
  }
  return secrets;
}

module.exports = { loadOrCreate };
