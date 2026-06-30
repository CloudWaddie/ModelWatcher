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
 * Group models by their display name (falls back to publicName, then name).
 * Returns a Map<displayName, models[]>.
 */
function groupByDisplayName(models) {
  const groups = new Map();
  for (const m of models) {
    const key = m.displayName || m.publicName || m.name || 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  return groups;
}

/**
 * Compute a variant group profile for a set of models sharing the same displayName.
 * Returns { count, capabilitiesUnion, capabilitiesIntersection, providers, ranks, orgs }
 */
function computeGroupProfile(models) {
  const capsUnion = {};
  const capsIntersection = {};
  const providers = new Set();
  const ranks = new Set();
  const orgs = new Set();

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    if (m.provider) providers.add(m.provider);
    if (m.rank != null) ranks.add(m.rank);
    if (m.organization) orgs.add(m.organization);

    const caps = m.capabilities;
    if (i === 0) {
      deepMerge(capsIntersection, caps, true);
    } else {
      deepIntersect(capsIntersection, caps);
    }
    deepMerge(capsUnion, caps, false);
  }

  return {
    count: models.length,
    capabilitiesUnion: capsUnion,
    capabilitiesIntersection: capsIntersection,
    providers: [...providers],
    ranks: [...ranks].sort((a, b) => a - b),
    orgs: [...orgs],
  };
}

/**
 * Deep merge src into target (object assignment, overriding).
 */
function deepMerge(target, src, isFirst) {
  if (!src || typeof src !== 'object') return;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], v, isFirst);
    } else {
      target[k] = v;
    }
  }
}

/**
 * Deep intersect src into target — after call, target[k] is only truthy
 * if it was truthy in both target and src for all variants.
 */
function deepIntersect(target, src) {
  if (!src || typeof src !== 'object') return;
  for (const [k, v] of Object.entries(target)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (src[k] && typeof src[k] === 'object') {
        deepIntersect(v, src[k]);
      } else {
        target[k] = undefined;
      }
    } else if (v && !src[k]) {
      target[k] = undefined;
    }
  }
}

/**
 * Diff model group profiles between old and new model sets.
 * Returns { variantChanges, convergence, newGroups, removedGroups }
 */
function diffModelGroups(oldModels, newModels) {
  const oldGroups = groupByDisplayName(oldModels);
  const newGroups = groupByDisplayName(newModels);

  const results = {
    variantChanges: [],
    convergence: [],
    newGroups: [],
    removedGroups: [],
  };

  for (const [name, newVariants] of newGroups) {
    const oldVariants = oldGroups.get(name);
    if (!oldVariants) {
      results.newGroups.push({ displayName: name, profile: computeGroupProfile(newVariants) });
      continue;
    }

    const oldProfile = computeGroupProfile(oldVariants);
    const newProfile = computeGroupProfile(newVariants);

    // Detect variant count changes
    if (oldProfile.count !== newProfile.count) {
      results.variantChanges.push({
        displayName: name,
        oldCount: oldProfile.count,
        newCount: newProfile.count,
        oldRanks: oldProfile.ranks,
        newRanks: newProfile.ranks,
        oldProviders: oldProfile.providers,
        newProviders: newProfile.providers,
      });
    }

    // Detect capability convergence — intersection gained new capabilities
    // Only meaningful for 2+ variants (single variant is just an update)
    if (newProfile.count >= 2) {
      const oldKeys = extractBoolKeys(oldProfile.capabilitiesIntersection);
      const newKeys = extractBoolKeys(newProfile.capabilitiesIntersection);
      const gained = newKeys.filter(k => !oldKeys.includes(k));
      if (gained.length > 0) {
        results.convergence.push({
          displayName: name,
          variantCount: newProfile.count,
          allNowHave: gained,
        });
      }
    }
  }

  for (const [name, oldVariants] of oldGroups) {
    if (!newGroups.has(name)) {
      results.removedGroups.push({ displayName: name, profile: computeGroupProfile(oldVariants) });
    }
  }

  return results;
}

/**
 * Extract boolean-key paths from a nested capabilities object.
 * e.g. { inputCapabilities: { text: true, image: true } } → ['inputCapabilities.text', 'inputCapabilities.image']
 */
function extractBoolKeys(obj, prefix = '') {
  const keys = [];
  if (!obj || typeof obj !== 'object') return keys;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...extractBoolKeys(v, path));
    } else if (v === true) {
      keys.push(path);
    }
  }
  return keys;
}

/**
 * Find models that were "revealed" — went from having no organization to having one.
 * Returns array of { model, oldOrg, newOrg, oldName, newName, oldProvider, newProvider }.
 */
function findRevealedModels(oldModels, newModels) {
  const oldMap = new Map(oldModels.map(m => [modelKey(m), m]));
  const revealed = [];

  for (const m of newModels) {
    const old = oldMap.get(modelKey(m));
    if (old && !old.organization && m.organization) {
      revealed.push({
        model: normalizeModel(m),
        oldOrg: old.organization,
        newOrg: m.organization,
        oldName: old.publicName || old.displayName || old.name,
        newName: m.publicName || m.displayName || m.name,
        oldProvider: old.provider,
        newProvider: m.provider,
        oldSelectable: old.userSelectable,
        newSelectable: m.userSelectable,
      });
    }
  }

  return revealed;
}

/**
 * Find POSSIBLE reveal matches — a stealth model (no org) was removed,
 * and a new model appeared with similar capabilities.
 * Returns array of { removed, added, matchScore }.
 */
function findPossibleReveals(oldModels, newModels) {
  const oldMap = new Map(oldModels.map(m => [modelKey(m), m]));
  const removedStealth = oldModels.filter(m => !oldMap.has(modelKey(m)) && !m.organization);
  const addedModels = newModels.filter(m => !oldMap.has(modelKey(m)));

  const possible = [];
  for (const rem of removedStealth) {
    for (const add of addedModels) {
      if (areEqual(rem.capabilities, add.capabilities)) {
        possible.push({
          removed: normalizeModel(rem),
          added: normalizeModel(add),
          match: 'capabilities match exactly',
          matchScore: 'high',
        });
      }
    }
  }

  return possible;
}

/**
 * Compute variant capability matrix for a group of models.
 * Returns an array of { path, count, total, emoji, label } for display.
 */
function computeVariantCapMatrix(models) {
  const counts = {};
  const emojiMap = {
    'inputCapabilities.text': '📝',
    'inputCapabilities.image': '🖼️',
    'inputCapabilities.file': '📎',
    'inputCapabilities.video': '🎬',
    'inputCapabilities.audio': '🎤',
    'outputCapabilities.text': '💬',
    'outputCapabilities.web': '🌐',
    'outputCapabilities.image': '🎨',
    'outputCapabilities.video': '📹',
    'outputCapabilities.search': '🔍',
  };
  const labelMap = {
    'inputCapabilities.text': 'text input',
    'inputCapabilities.image': 'image input',
    'inputCapabilities.file': 'file input',
    'inputCapabilities.video': 'video input',
    'inputCapabilities.audio': 'audio input',
    'outputCapabilities.text': 'text output',
    'outputCapabilities.web': 'web output',
    'outputCapabilities.image': 'image output',
    'outputCapabilities.video': 'video output',
    'outputCapabilities.search': 'search output',
  };

  // Collect all possible capability paths
  const allPaths = new Set();
  for (const m of models) {
    const keys = extractBoolKeys(m.capabilities);
    keys.forEach(k => allPaths.add(k));
  }

  // Count how many variants have each capability
  for (const path of allPaths) {
    let count = 0;
    const parts = path.split('.');
    for (const m of models) {
      let val = m.capabilities;
      let found = true;
      for (const p of parts) {
        if (val && typeof val === 'object' && p in val) {
          val = val[p];
        } else {
          found = false;
          break;
        }
      }
      if (found && val === true) count++;
    }
    counts[path] = {
      count,
      total: models.length,
      emoji: emojiMap[path] || '🔹',
      label: labelMap[path] || path,
    };
  }

  return Object.entries(counts)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([, v]) => v);
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

  // Compute grouped model diffs for variant tracking and convergence
  const groupDiff = diffModelGroups(oldModels, newModels);

  // Find revealed models (gained organization)
  const revealed = findRevealedModels(oldModels, newModels);

  // Find POSSIBLE reveals (stealth removed + new model with same caps)
  const possibleReveals = findPossibleReveals(oldModels, newModels);

  // Attach capability matrix to variant changes
  for (const vc of groupDiff.variantChanges) {
    const groupName = vc.displayName;
    // Fetch all new variants for this group to compute matrix
    const newGroup = groupByDisplayName(newModels).get(groupName);
    if (newGroup && newGroup.length > 1) {
      vc.capMatrix = computeVariantCapMatrix(newGroup);
    }
  }

  return { added, removed, changed, groupDiff, revealed, possibleReveals };
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
