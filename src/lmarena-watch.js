import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { sendDiscordWebhook, createLMArenaEmbed } from './webhook.js';

const STATE_FILE = 'logs/lmarena-state.json';
const WEBHOOK_URL = process.env.LMARENA_WEBHOOK;

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
      if (old.rank !== m.rank) changes.push(`rank: ${old.rank ?? '?'} → ${m.rank ?? '?'}`);
      if (old.userSelectable !== m.userSelectable) changes.push(`selectable: ${old.userSelectable} → ${m.userSelectable}`);
      if (old.displayName !== m.displayName) changes.push(`name: "${old.displayName}" → "${m.displayName}"`);
      if (old.publicName !== m.publicName) changes.push(`publicName: "${old.publicName}" → "${m.publicName}"`);
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
