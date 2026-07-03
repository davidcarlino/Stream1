'use strict';

/** App login roles. Legacy `staff` is treated as viewer everywhere. */
const ROLE_ADMIN = 'admin';
const ROLE_VIEWER = 'viewer';

function normalizeRole(role) {
  if (role === ROLE_ADMIN) return ROLE_ADMIN;
  return ROLE_VIEWER;
}

function isAdminRole(role) {
  return normalizeRole(role) === ROLE_ADMIN;
}

function sanitizeRole(role) {
  return role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_VIEWER;
}

module.exports = { ROLE_ADMIN, ROLE_VIEWER, normalizeRole, isAdminRole, sanitizeRole };
