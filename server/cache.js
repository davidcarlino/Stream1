'use strict';

/**
 * Tiny in-memory TTL cache with explicit invalidation.
 *
 * Used to avoid hammering YouTube quota on repeated History/health reads, while
 * guaranteeing freshness: any write that changes underlying data calls
 * invalidate(), so the cache "flushes if something's changed".
 */

const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > entry.ttl) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key, value, ttlMs) {
  store.set(key, { value, at: Date.now(), ttl: ttlMs });
  return value;
}

/** Invalidate one key, all keys with a prefix, or everything (no arg). */
function invalidate(keyOrPrefix) {
  if (keyOrPrefix === undefined) {
    store.clear();
    return;
  }
  if (store.has(keyOrPrefix)) store.delete(keyOrPrefix);
  for (const k of store.keys()) {
    if (k.startsWith(keyOrPrefix)) store.delete(k);
  }
}

module.exports = { get, set, invalidate };
