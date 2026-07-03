'use strict';

const { AppError } = require('./errors');
const { isAdminRole } = require('../roles');

/** Require a logged-in app user (any role). */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return next(new AppError('Please log in to continue.', { status: 401, code: 'unauthorized' }));
}

/** Require an admin app user (settings, templates, user management). */
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && isAdminRole(req.session.user.role)) return next();
  return next(
    new AppError('This action requires an admin account.', { status: 403, code: 'forbidden' })
  );
}

module.exports = { requireAuth, requireAdmin };
