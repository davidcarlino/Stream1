'use strict';

/**
 * Destination rules shared by New Stream, templates, and Restream arming.
 *
 * Facebook is only allowed when YouTube privacy is Public.
 * Unlisted / Private → Facebook must stay off (UI + server + Restream channels).
 */

const { AppError } = require('./middleware/errors');

function facebookAllowedForPrivacy(privacy) {
  return String(privacy || '').toLowerCase() === 'public';
}

/**
 * Normalize streamTo and force Facebook off unless privacy is public.
 * Always keeps at least YouTube on if both would be off.
 */
function normalizeStreamTo(raw = {}, privacy) {
  const streamTo = {
    youtube: raw.youtube === undefined ? true : Boolean(raw.youtube),
    facebook: Boolean(raw.facebook),
  };
  if (!facebookAllowedForPrivacy(privacy)) {
    streamTo.facebook = false;
  }
  if (!streamTo.youtube && !streamTo.facebook) streamTo.youtube = true;
  return streamTo;
}

/** Hard reject when a client still sends facebook:true with unlisted/private. */
function assertFacebookAllowed(privacy, wantsFacebook) {
  if (wantsFacebook && !facebookAllowedForPrivacy(privacy)) {
    throw new AppError(
      'Facebook is only allowed when privacy is Public. Unlisted and Private streams stay YouTube-only.',
      { status: 400, code: 'facebook_requires_public' }
    );
  }
}

module.exports = {
  facebookAllowedForPrivacy,
  normalizeStreamTo,
  assertFacebookAllowed,
};
