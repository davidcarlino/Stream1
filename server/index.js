'use strict';

/**
 * STREAM1 server — CLI entry (development / headless).
 * For the graphical server window, use: npm run gui:server
 */

const readline = require('readline');
const bootstrap = require('./bootstrap');

function line() {
  return '─'.repeat(52);
}

function waitForKey(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function logStatus(status) {
  if (status.dataDir) console.log(`  Database folder: ${status.dataDir}`);
  if (status.mongoRunning) console.log(`  Database ready on 127.0.0.1:${status.mongoPort}`);
  if (status.httpRunning) {
    console.log(`\n  App running at ${status.appUrl}`);
    if (!status.youtubeConfigured) {
      console.log('  (YouTube not configured yet — set GOOGLE_CLIENT_ID/SECRET to enable streaming.)');
    }
    console.log(`\n  Leave this window open. Close it (or press Ctrl+C) to stop.\n${line()}\n`);
  }
  if (status.error) console.error(`  Error: ${status.error}`);
}

async function main() {
  console.log(`\n${line()}\n  STREAM1 — local server\n${line()}\n`);

  await bootstrap.start({
    onStatusChange: (s) => {
      if (s.phase === 'ready') logStatus(s);
    },
  });

  const status = bootstrap.getStatus();
  if (status.phase === 'error') {
    if (process.pkg) await waitForKey('  Press Enter to close...');
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`\n  ${signal} — shutting down...`);
  await bootstrap.shutdown();
  console.log('  Stopped cleanly.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(async (err) => {
  console.error(`\n  Could not start STREAM1:\n  ${err && err.message ? err.message : err}\n`);
  await bootstrap.shutdown().catch(() => {});
  if (process.pkg) await waitForKey('  Press Enter to close...');
  process.exit(1);
});
