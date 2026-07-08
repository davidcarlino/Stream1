import { api } from '../api.js';
import { h, busy, toast } from '../ui.js';
import { state, onAuthenticated } from '../app.js';
import { setStreamControlUrl } from '../streamControl.js';
import { setVolumeControlUrl } from '../volumeControl.js';
import { registerElectronLanTrust } from '../lanProxyFrame.js';

export function renderLogin({ firstRun }) {
  const node = h(`<div class="auth-wrap">
    <div class="auth-logo">
      <img src="/assets/img/logos/stream1-dark.svg" alt="STREAM1" />
    </div>
    <p class="auth-sub">${firstRun ? 'Welcome — create the first admin account.' : 'Please log in to continue.'}</p>
    <div class="card">
      <form id="authForm">
        <div class="field">
          <label for="username">Username</label>
          <input id="username" type="text" autocomplete="username" autofocus />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" autocomplete="${firstRun ? 'new-password' : 'current-password'}" />
        </div>
        ${firstRun ? `<div class="field">
          <label for="password2">Confirm password</label>
          <input id="password2" type="password" autocomplete="new-password" />
        </div>` : ''}
        <button class="btn btn-lg" type="submit">${firstRun ? 'Create admin account' : 'Log in'}</button>
      </form>
    </div>
    ${firstRun ? '<p class="hint center mt">This account can manage settings, templates and the YouTube connection.</p>' : ''}
  </div>`);

  const form = node.querySelector('#authForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = node.querySelector('#username').value.trim();
    const password = node.querySelector('#password').value;
    const btn = form.querySelector('button[type="submit"]');

    if (firstRun) {
      const password2 = node.querySelector('#password2').value;
      if (password !== password2) return toast('Passwords do not match.', 'err');
      if (password.length < 8) return toast('Password must be at least 8 characters.', 'err');
    }

    busy(btn, true);
    const url = firstRun ? '/api/auth/register-first' : '/api/auth/login';
    const res = await api.post(url, { username, password });
    busy(btn, false, firstRun ? 'Create admin account' : 'Log in');

    if (!res.ok) return toast(res.error, 'err');

    state.user = res.data.user;
    state.needsFirstUser = false;
    if (res.data.streamControlTabletUrl) setStreamControlUrl(res.data.streamControlTabletUrl);
    if (res.data.volumeControlUrl) setVolumeControlUrl(res.data.volumeControlUrl);
    registerElectronLanTrust({
      stream: res.data.streamControlTabletUrl,
      volume: res.data.volumeControlUrl,
    });
    await onAuthenticated();
  });

  return node;
}
