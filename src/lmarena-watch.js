import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sendDiscordWebhook, createLMArenaEmbed, capabilityEmoji } from './webhook.js';

const STATE_FILE = 'logs/lmarena-state.json';
const WEBHOOK_URL = process.env.LMARENA_WEBHOOK;

// Static field configuration for model diffing
const DIFF_FIELDS = [
  { key: 'rank', label: 'rank' },
  { key: 'userSelectable', label: 'selectable' },
  { key: 'displayName', label: 'name' },
  { key: 'publicName', label: 'publicName' },
  { key: 'organization', label: 'organization' },
  { key: 'provider', label: 'provider' },
  { key: 'rankByModality', label: 'rankByModality' },
  { key: 'capabilities', label: 'capabilities' }
];

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { models: [], lastCheck: 0 };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function modelKey(m) {
  return m.id || m.publicName || m.name;
}

function normalizeModel(m) {
  return {
    id: m.id,
    publicName: m.publicName,
    name: m.name,
    displayName: m.displayName,
    organization: m.organization,
    provider: m.provider,
    userSelectable: m.userSelectable,
    rank: m.rank,
    rankByModality: m.rankByModality,
    capabilities: m.capabilities,
  };
}

/**
 * Deep equality check for any two values
 * Handles arrays, objects, and primitives correctly
 */
function areEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  
  // Fast path for arrays
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!areEqual(a[i], b[i])) return false;
    }
    return true;
  }
  
  // Object comparison
  if (a && b && typeof a === 'object') {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
      if (!areEqual(a[keysA[i]], b[keysB[i]])) return false;
    }
    return true;
  }
  
  return false;
}

/**
 * Get nested property path changes for deep diffs
 * Returns array of {path, oldVal, newVal} for changed nested properties
 */
function getNestedChanges(oldVal, newVal, prefix = '') {
  const changes = [];
  if (typeof oldVal !== 'object' || typeof newVal !== 'object' || !oldVal || !newVal) {
    return changes;
  }
  
  const allKeys = new Set([...Object.keys(oldVal || {}), ...Object.keys(newVal || {})]);
  for (const key of allKeys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const oldNested = oldVal?.[key];
    const newNested = newVal?.[key];
    
    if (!areEqual(oldNested, newNested)) {
      if (typeof oldNested === 'object' && typeof newNested === 'object' && oldNested && newNested) {
        changes.push(...getNestedChanges(oldNested, newNested, path));
      } else {
        changes.push({ path, oldVal: oldNested, newVal: newNested });
      }
    }
  }
  return changes;
}

/**
 * Format a value for display in diffs
 * Strings are quoted, capabilities use emojis, objects are JSONified
 */
function formatVal(v, key) {
  if (key === 'capabilities') {
    return capabilityEmoji(v);
  }
  if (typeof v === 'string') {
    return `"${v}"`;
  }
  if (typeof v === 'object' && v !== null) {
    return JSON.stringify(v);
  }
  return String(v ?? '?');
}

/**
 * Generate a diff message for a single field change
 * For capabilities, also show nested changes if structure changes
 */
function generateFieldDiff(field, oldVal, newVal) {
  const oldEmoji = formatVal(oldVal, field.key);
  const newEmoji = formatVal(newVal, field.key);
  let message = `${field.label}: ${oldEmoji} → ${newEmoji}`;
  
  // For capabilities, if the structure changed deeply, append nested details
  if (field.key === 'capabilities' && typeof oldVal === 'object' && typeof newVal === 'object') {
    const nestedChanges = getNestedChanges(oldVal, newVal, 'capabilities');
    if (nestedChanges.length > 0 && oldEmoji === newEmoji) {
      // If emojis are the same but structure changed, add structural details
      const details = nestedChanges.map(c => {
        const oldStr = formatVal(c.oldVal, 'value');
        const newStr = formatVal(c.newVal, 'value');
        return `${c.path}: ${oldStr} → ${newStr}`;
      }).join(' | ');
      message += ` (${details})`;
    }
  }
  
  return message;
}

function diffModels(oldModels, newModels) {
  const oldMap = new Map(oldModels.map(m => [modelKey(m), m]));
  const newMap = new Map(newModels.map(m => [modelKey(m), normalizeModel(m)]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, m] of newMap) {
    if (!oldMap.has(key)) {
      added.push(m);
    } else {
      const old = oldMap.get(key);
      const changes = [];
      
      for (const field of DIFF_FIELDS) {
        if (!areEqual(old[field.key], m[field.key])) {
          changes.push(generateFieldDiff(field, old[field.key], m[field.key]));
        }
      }

      if (changes.length > 0) {
        changed.push({ model: m, changes });
      }
    }
  }

  for (const [key, m] of oldMap) {
    if (!newMap.has(key)) {
      removed.push(m);
    }
  }

  return { added, removed, changed };
}

async function main() {
  console.log('=== LM Arena Model Watcher ===');

  if (!WEBHOOK_URL) {
    console.log('LMARENA_WEBHOOK not set, skipping notifications');
  }

  // Run Python scraper
  console.log('Scraping LM Arena models...');
  let result;
  try {
    const output = execSync('python src/lmarena-watch.py', {
      encoding: 'utf8',
      timeout: 180000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    result = JSON.parse(output);
  } catch (err) {
    console.error('Failed to scrape models:', err.stderr || err.message);
    process.exit(1);
  }

  if (result.error) {
    console.error('Scraper returned error:', result.error);
    process.exit(0); // graceful fail
  }

  const models = result.models;
  if (!models || !Array.isArray(models)) {
    console.error('Invalid model data from scraper');
    process.exit(0); // graceful fail
  }

  console.log(`Scraped ${models.length} models`);

  const state = loadState();
  const diff = diffModels(state.models, models);

  const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

  if (!hasChanges && state.models.length > 0) {
    console.log('No model changes detected');
    saveState({ models, lastCheck: Date.now() });
    return;
  }

  if (state.models.length === 0) {
    console.log('First run - saving baseline without sending notifications');
    saveState({ models, lastCheck: Date.now() });
    return;
  }

  console.log(`Changes: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} updated`);

  // Send Discord notification
  if (WEBHOOK_URL && hasChanges) {
    const payload = createLMArenaEmbed(diff, models.length);
    await sendDiscordWebhook(WEBHOOK_URL, payload);
    console.log('Discord notification sent');
  }

  saveState({ models, lastCheck: Date.now() });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
