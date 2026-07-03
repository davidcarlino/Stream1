import { api } from './api.js';
import { healthState, notifyHealth } from './healthState.js';

let getAuthState = () => ({ user: null, setupComplete: false });

export function setHealthAuthGetter(getter) {
  getAuthState = getter;
}

export async function refreshHealth() {
  const { user, setupComplete } = getAuthState();
  if (!user || !setupComplete) {
    healthState.issues = [];
    healthState.loaded = false;
    notifyHealth();
    return healthState;
  }
  const res = await api.get('/api/health');
  if (!res.ok) {
    healthState.issues = [];
    healthState.loaded = false;
    notifyHealth();
    return healthState;
  }
  healthState.issues = (res.data && res.data.issues) || [];
  healthState.loaded = true;
  notifyHealth();
  return healthState;
}

let healthTimer = null;

export function startHealthPolling() {
  stopHealthPolling();
  refreshHealth();
  healthTimer = setInterval(refreshHealth, 3 * 60 * 1000);
}

export function stopHealthPolling() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}
