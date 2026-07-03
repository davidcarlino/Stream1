'use strict';

/**
 * Error handling that never leaks internals to the end user (§7.2).
 *
 * Routes throw either an AppError (with a safe, plain-English message + code)
 * or any other error. The technical detail is logged to the server console for
 * the developer; the user only ever sees a short sentence.
 */

class AppError extends Error {
  constructor(message, { status = 400, code = 'error' } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.safe = true;
  }
}

// Wrap async route handlers so thrown/rejected errors reach the error handler.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;

  // Always log the real error for the developer (never sent to the client).
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[warn] ${req.method} ${req.originalUrl} — ${err.message}`);
  }

  const body = {
    error: err.safe ? err.message : 'Something went wrong. Please try again.',
    code: err.code || 'error',
  };
  res.status(status).json(body);
}

module.exports = { AppError, asyncHandler, errorHandler };
