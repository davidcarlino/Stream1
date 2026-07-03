'use strict';

const fs = require('fs');
const path = require('path');
const { projectRoot } = require('./paths');

function readEnvFileValue(key) {
  const roots = [
    path.dirname(process.execPath),
    projectRoot(),
  ];
  for (const root of roots) {
    const envPath = path.join(root, '.env');
    if (!fs.existsSync(envPath)) continue;
    try {
      const text = fs.readFileSync(envPath, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const name = trimmed.slice(0, eq).trim();
        if (name !== key) continue;
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (value) return value;
      }
    } catch (err) {
      /* ignore unreadable .env */
    }
  }
  return null;
}

function getManifestUrl() {
  return (
    process.env.STREAM1_UPDATE_MANIFEST_URL ||
    readEnvFileValue('STREAM1_UPDATE_MANIFEST_URL') ||
    null
  );
}

function updatesEnabled() {
  if (process.env.STREAM1_DISABLE_UPDATES === '1') return false;
  return Boolean(getManifestUrl());
}

module.exports = {
  getManifestUrl,
  updatesEnabled,
};
