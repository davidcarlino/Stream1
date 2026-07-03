/** Shared YouTube / system health state (shown in Settings, not the top bar). */

export const healthState = { issues: [], loaded: false };

export function notifyHealth() {
  window.dispatchEvent(new CustomEvent('stream1-health', { detail: { ...healthState } }));
}
