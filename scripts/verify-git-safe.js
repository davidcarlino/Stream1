'use strict';

/**
 * Run before the first git push to confirm secrets and database files stay local.
 *
 *   node scripts/verify-git-safe.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
]);

const FORBIDDEN_TRACKED = [
  '.env',
  '.env.local',
  'stream1-secrets.json',
  'certs/stream1-codesign.pfx',
];

const FORBIDDEN_GLOBS = [
  /(^|[\\/])\.env\.local$/i,
  /(^|[\\/])\.env$/i,
  /stream1-secrets\.json$/i,
  /(^|[\\/])data[\\/]db[\\/]/i,
  /(^|[\\/])db[\\/]WiredTiger/i,
  /\.wt$/i,
  /mongod\.log$/i,
  /\.pfx$/i,
  /(^|[\\/])dist[\\/]/i,
  /(^|[\\/])build[\\/]/i,
  /(^|[\\/])vendor[\\/]/i,
];

const SECRET_PATTERNS = [
  { name: 'Google OAuth secret', re: /GOCSPX-[A-Za-z0-9_-]{10,}/ },
  { name: 'Facebook app secret', re: /FACEBOOK_APP_SECRET=[0-9a-f]{20,}/i },
  { name: 'Bearer / GitHub token', re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: 'MongoDB Atlas URI', re: /mongodb(\+srv)?:\/\/[^\s'"]+:[^\s'"]+@/i },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }

  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    out.push(rel);
  }
  return out;
}

function readGitignorePatterns() {
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function matchesGitignore(relPath, patterns) {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    if (pattern.endsWith('/')) {
      if (normalized.startsWith(pattern) || normalized.includes(`/${pattern.slice(0, -1)}/`)) {
        return true;
      }
      continue;
    }
    if (pattern.startsWith('*')) {
      if (normalized.endsWith(pattern.slice(1))) return true;
      continue;
    }
    if (normalized === pattern || normalized.endsWith(`/${pattern}`)) return true;
  }
  return false;
}

function gitTrackedFiles() {
  const result = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const errors = [];
  const warnings = [];

  for (const rel of FORBIDDEN_TRACKED) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    if (!readGitignorePatterns().some((pattern) => matchesGitignore(rel, [pattern]))) {
      errors.push(`"${rel}" exists but is not covered by .gitignore.`);
    }
  }

  const gitignore = readGitignorePatterns();
  if (!gitignore.includes('.env')) {
    errors.push('.gitignore must ignore .env');
  }
  if (!gitignore.includes('stream1-secrets.json')) {
    errors.push('.gitignore must ignore stream1-secrets.json');
  }
  if (!gitignore.includes('data/')) {
    errors.push('.gitignore must ignore data/');
  }

  const tracked = gitTrackedFiles();
  const candidateFiles = tracked || walk(root).filter((rel) => !matchesGitignore(rel, gitignore));

  for (const rel of candidateFiles) {
    for (const rule of FORBIDDEN_GLOBS) {
      if (rule.test(rel)) {
        errors.push(`Sensitive path would be committed: ${rel}`);
        break;
      }
    }
  }

  for (const rel of candidateFiles) {
    if (rel.endsWith('.example')) continue;
    if (!/\.(js|json|txt|md|html|css|ps1|env|yml|yaml|xml|svg|png|jpg|ico)$/i.test(rel)) {
      continue;
    }
    let text;
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch (err) {
      continue;
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(text)) {
        errors.push(`${pattern.name} found in ${rel}`);
      }
    }
  }

  if (fs.existsSync(path.join(root, '.env'))) {
    warnings.push('.env exists locally (good). It must never be committed — only .env.example goes to GitHub.');
  }

  if (tracked && tracked.length === 0) {
    warnings.push('Git repo has no tracked files yet. Run verify again after git add.');
  }

  console.log('STREAM1 git safety check\n');
  if (warnings.length) {
    console.log('Notes:');
    warnings.forEach((msg) => console.log(`  - ${msg}`));
    console.log('');
  }

  if (errors.length) {
    console.error('BLOCKED — fix these before pushing:\n');
    errors.forEach((msg) => console.error(`  x ${msg}`));
    process.exit(1);
  }

  console.log('OK — no secrets/database paths detected in files that would be pushed.');
  console.log('Still never commit: .env, stream1-secrets.json, data/, dist/, vendor/, certs/*.pfx');
}

main();
