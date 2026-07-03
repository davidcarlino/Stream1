/** Same-origin LAN proxy iframes — avoids browser certificate errors on local gear. */

export function lanProxyFrameSrc(panel) {
  return `/api/lan-proxy/${panel}`;
}
