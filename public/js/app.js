import { api } from './api.js';
import { toast, mount, h } from './ui.js';
import { renderLogin } from './views/login.js';
import { renderSetup } from './views/setup.js';
import { renderNewStream } from './views/newstream.js';
import { renderStreamTest, teardownStreamTest } from './views/streamtest.js';
import { renderHistory } from './views/history.js';
import { renderTemplates } from './views/templates.js';
import { renderSettings } from './views/settings.js';
import { initStreamControl, setStreamControlUrl, showStreamControlTab } from './streamControl.js';
import { initVolumeControl, setVolumeControlUrl, showVolumeControlTab } from './volumeControl.js';
import { initSidePanelResize } from './sidePanelResize.js';
import { refreshHealth, startHealthPolling, stopHealthPolling, setHealthAuthGetter } from './health.js';

export const state = {
  user: null,
  needsFirstUser: false,
  setupComplete: false,
};

const ROUTES = {
  new: { label: 'New Stream', render: renderNewStream },
  'stream-test': { label: 'Stream Test', render: renderStreamTest, navClass: 'nav-stream-test' },
  streams: { label: 'Streams', render: renderHistory },
  templates: { label: 'Templates', render: renderTemplates, adminOnly: true },
  settings: { label: 'Settings', render: renderSettings },
  setup: { label: 'Setup', render: renderSetup, hidden: true },
  history: { label: 'Streams', render: renderHistory, hidden: true },
};

export function navigate(route) {
  const target = route || 'new';
  if (location.hash !== `#/${target}`) {
    location.hash = `#/${target}`;
  } else {
    handleRoute();
  }
}

function currentRoute() {
  const m = location.hash.match(/^#\/([a-z-]+)/);
  return m ? m[1] : 'new';
}

function isAdmin() {
  return state.user && state.user.role === 'admin';
}

/* ------------------------------ App chrome ------------------------------- */

function renderChrome() {
  const topbar = document.getElementById('topbar');
  const nav = document.getElementById('nav');
  const whoami = document.getElementById('whoami');
  const logoutBtn = document.getElementById('logoutBtn');

  if (!state.user) {
    topbar.hidden = true;
    nav.innerHTML = '';
    whoami.textContent = '';
    logoutBtn.hidden = true;
    showStreamControlTab(false);
    showVolumeControlTab(false);
    return;
  }

  showStreamControlTab(true);
  showVolumeControlTab(true);

  topbar.classList.remove('topbar-login');
  topbar.hidden = false;
  logoutBtn.hidden = false;
  whoami.textContent = `${state.user.username} (${state.user.role})`;
  nav.innerHTML = '';
  for (const [key, r] of Object.entries(ROUTES)) {
    if (r.hidden) continue;
    if (r.adminOnly && !isAdmin()) continue;
    const a = h(`<a href="#/${key}"${r.navClass ? ` class="${r.navClass}"` : ''}>${r.label}</a>`);
    nav.appendChild(a);
  }
  highlightNav();
}

function highlightNav() {
  const active = currentRoute();
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === `#/${active}`);
  });
}

/* ------------------------------- Routing --------------------------------- */

async function handleRoute() {
  if (state.needsFirstUser) return renderView(() => renderLogin({ firstRun: true }));
  if (!state.user) return renderView(() => renderLogin({ firstRun: false }));

  // Force admins through setup until it's complete.
  if (!state.setupComplete) {
    if (isAdmin()) return renderView(renderSetup);
    return renderView(() =>
      h(`<div class="card center"><h2>Setup not finished</h2>
        <p class="muted">An administrator needs to finish first-time setup before streams can be created.</p></div>`)
    );
  }

  let key = currentRoute();
  if (key === 'history') key = 'streams';
  let route = ROUTES[key];
  if (key !== 'stream-test') teardownStreamTest();
  if (!route || (route.adminOnly && !isAdmin())) {
    key = 'new';
    route = ROUTES.new;
  }
  highlightNav();
  await renderView(route.render);
}

async function renderView(renderFn) {
  try {
    const node = await renderFn({ state, navigate, refreshHealth });
    if (node) mount(node);
  } catch (err) {
    mount(h(`<div class="card"><h2>Something went wrong</h2><p class="muted">Please reload the page.</p></div>`));
  }
}

/* -------------------------------- Session -------------------------------- */

export async function loadSession() {
  const res = await api.get('/api/auth/session');
  if (res.ok) {
    state.user = res.data.user;
    state.needsFirstUser = res.data.needsFirstUser;
    if (res.data.streamControlTabletUrl) setStreamControlUrl(res.data.streamControlTabletUrl);
    if (res.data.volumeControlUrl) setVolumeControlUrl(res.data.volumeControlUrl);
  }
  if (state.user) {
    const s = await api.get('/api/setup/status');
    if (s.ok) state.setupComplete = s.data.setupComplete;
  }
  renderChrome();
}

export async function onAuthenticated() {
  const s = await api.get('/api/setup/status');
  if (s.ok) state.setupComplete = s.data.setupComplete;
  renderChrome();
  startHealthPolling();
  navigate(state.setupComplete ? 'new' : 'setup');
}

async function logout() {
  await api.post('/api/auth/logout');
  state.user = null;
  stopHealthPolling();
  renderChrome();
  navigate('new');
  handleRoute();
}

/* ------------------------------ Health export ---------------------------- */

export { refreshHealth };

/* --------------------------------- Boot ---------------------------------- */

async function boot() {
  setHealthAuthGetter(() => ({ user: state.user, setupComplete: state.setupComplete }));
  initStreamControl();
  initVolumeControl();
  initSidePanelResize();
  document.getElementById('logoutBtn').onclick = logout;
  window.addEventListener('hashchange', handleRoute);
  await loadSession();
  if (state.user && state.setupComplete) startHealthPolling();
  await handleRoute();
}

boot();
