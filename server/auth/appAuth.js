'use strict';

/**
 * Local app login (§3): username + password, bcrypt-hashed, session-based.
 * This is the person authenticating to the app — distinct from the YouTube
 * OAuth connection in googleAuth.js.
 */

const bcrypt = require('bcryptjs');
const store = require('../store');
const { AppError } = require('../middleware/errors');
const { ROLE_ADMIN, ROLE_VIEWER, normalizeRole, sanitizeRole, isAdminRole } = require('../roles');

const BCRYPT_ROUNDS = 12;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function validateCredentials(username, password) {
  if (!username || !USERNAME_RE.test(username)) {
    throw new AppError('Username must be 3–32 letters, numbers, dot, dash or underscore.', {
      status: 400,
      code: 'invalid_username',
    });
  }
  if (!password || String(password).length < 8) {
    throw new AppError('Password must be at least 8 characters.', {
      status: 400,
      code: 'weak_password',
    });
  }
}

/**
 * Create a user. The very first user created is always an admin (first-run).
 */
async function createUser({ username, password, role }) {
  validateCredentials(username, password);
  const existing = await store.findUserByUsername(username);
  if (existing) {
    throw new AppError('That username is already taken.', { status: 409, code: 'username_taken' });
  }
  const isFirst = (await store.countUsers()) === 0;
  const passwordHash = await hashPassword(password);
  return store.createUser({
    username,
    passwordHash,
    role: isFirst ? ROLE_ADMIN : sanitizeRole(role),
  });
}

/**
 * Verify a username/password. Returns the safe public user object or throws.
 * Uses a constant-ish path (always runs a bcrypt compare) to reduce user
 * enumeration via timing.
 */
async function verifyLogin(username, password) {
  const user = await store.findUserByUsername(username);
  const hash = user ? user.passwordHash : '$2a$12$0000000000000000000000000000000000000000000000000000';
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!user || !ok) {
    throw new AppError('Incorrect username or password.', { status: 401, code: 'bad_login' });
  }
  return { id: user._id.toString(), username: user.username, role: normalizeRole(user.role) };
}

async function setPassword(userId, password) {
  if (!password || String(password).length < 8) {
    throw new AppError('Password must be at least 8 characters.', {
      status: 400,
      code: 'weak_password',
    });
  }
  const passwordHash = await hashPassword(password);
  const ok = await store.updateUserPassword(userId, passwordHash);
  if (!ok) throw new AppError('User not found.', { status: 404, code: 'not_found' });
  return true;
}

/** Re-check the logged-in user's password (e.g. before showing stream keys). */
async function verifyPasswordForUser(userId, password) {
  const user = await store.findUserById(userId);
  const hash = user ? user.passwordHash : '$2a$12$0000000000000000000000000000000000000000000000000000';
  const ok = await bcrypt.compare(String(password || ''), hash);
  if (!user || !ok) {
    throw new AppError('Incorrect password.', { status: 401, code: 'bad_password' });
  }
  return true;
}

/** Verify an admin username/password (e.g. before deleting a stream). */
async function verifyAdminCredentials(username, password) {
  const user = await verifyLogin(username, password);
  if (!isAdminRole(user.role)) {
    throw new AppError('This action requires an admin account.', { status: 403, code: 'forbidden' });
  }
  return user;
}

module.exports = {
  createUser,
  verifyLogin,
  setPassword,
  verifyPasswordForUser,
  verifyAdminCredentials,
  hashPassword,
  validateCredentials,
};
