import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

// Key-order-insensitive serialization, so a reshuffled-but-equal object isn't a "change".
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
}

function fingerprint(state) {
  const { timestamp, ...rest } = state ?? {};
  return JSON.stringify(canonical(rest));
}

/**
 * Write a state file, but only when something other than the top-level `timestamp`
 * (or key ordering) changed. Avoids a noise commit every scheduled run.
 * @returns {boolean} true if the file was written
 */
export function saveStateIfChanged(path, state, space) {
  if (existsSync(path)) {
    try {
      if (fingerprint(JSON.parse(readFileSync(path, 'utf8'))) === fingerprint(state)) return false;
    } catch { /* unreadable/corrupt state: fall through and rewrite */ }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, space));
  return true;
}
