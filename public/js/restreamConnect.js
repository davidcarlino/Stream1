import { api } from './api.js';
import { toast } from './ui.js';

const POLL_MS = 2000;
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Start Restream OAuth: server opens Chrome, user signs in there, we poll
 * until the token pair is stored. Mirrors youtubeConnect.js.
 */
export async function startRestreamConnect({ returnTo = 'settings' } = {}) {
  const res = await api.post('/api/setup/connect-restream', { returnTo });
  if (!res.ok) {
    return { ok: false, error: res.error || 'Could not start connection.' };
  }

  const { state, url, opened, usedChrome } = res.data;
  if (!state) {
    return { ok: false, error: 'Server did not return an OAuth state.' };
  }

  if (!opened && url) {
    window.open(url, '_blank', 'noopener');
  }

  toast(
    usedChrome
      ? 'Chrome opened — sign in with the church Restream account.'
      : 'A browser window opened — sign in with the church Restream account.',
    'ok'
  );

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, POLL_MS));
    // eslint-disable-next-line no-await-in-loop
    const st = await api.get(`/api/setup/restream-oauth-status?state=${encodeURIComponent(state)}`);
    if (!st.ok) continue;

    const { status, channelTitle } = st.data;
    if (status === 'pending') continue;

    if (status === 'connected') {
      return { ok: true, status, account: channelTitle };
    }
    if (status === 'expired') {
      return { ok: false, status, error: 'Sign-in timed out. Try again.' };
    }
    return {
      ok: false,
      status,
      error:
        status === 'denied'
          ? 'You declined access or closed the sign-in window.'
          : 'Restream connection did not complete. Try again.',
    };
  }

  return { ok: false, status: 'timeout', error: 'Sign-in timed out. Try again.' };
}
