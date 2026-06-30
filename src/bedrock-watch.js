import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

function loadConfig() {
  return JSON.parse(readFileSync(join(__dirname, '..', 'bedrock-config.json'), 'utf-8'));
}

function loadOrInit(path) {
  if (!existsSync(path)) return { models: [], timestamp: 0 };
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return { models: [], timestamp: 0 }; }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

async function fetchMarkdown(url, timeout) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseModels(md) {
  const models = [];
  const lines = md.split('\n');
  let currentProvider = null;
  let inTable = false;
  let headerSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const headerMatch = line.match(/^## (.+)/);
    if (headerMatch) {
      currentProvider = headerMatch[1].trim();
      inTable = false;
      headerSeen = false;
      continue;
    }

    if (!currentProvider) continue;

    if (line.startsWith('|') && line.endsWith('|')) {
      if (!inTable) {
        inTable = true;
        headerSeen = false;
        continue;
      }
      if (!headerSeen) {
        headerSeen = true;
        continue;
      }
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length < 3) continue;
      const name = cells[0].replace(/^\[(.+?)\].*$/, '$1').replace(/^\*\*(.+?)\*\*$/, '$1').trim();
      if (!name || name === 'Model name') continue;
      const runtime = cells[1].includes('icon-yes.png');
      const mantle = cells[2].includes('icon-yes.png');
      models.push({ provider: currentProvider, name, runtime, mantle });
    } else {
      inTable = false;
      headerSeen = false;
    }
  }
  return models;
}

function computeModelKey(m) {
  return `${m.provider}::${m.name}`;
}

function diffModels(oldModels, newModels) {
  const oldMap = new Map(oldModels.map(m => [computeModelKey(m), m]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const m of newModels) {
    const key = computeModelKey(m);
    const old = oldMap.get(key);
    if (!old) {
      added.push(m);
    } else if (old.runtime !== m.runtime || old.mantle !== m.mantle) {
      changed.push({ model: m, old });
    }
  }

  for (const m of oldModels) {
    if (!newModels.some(n => computeModelKey(n) === computeModelKey(m))) {
      removed.push(m);
    }
  }

  return { added, removed, changed };
}

function endpointEmoji(val) { return val ? '✅' : '❌'; }

function buildNotification(diff, total) {
  const components = [];
  const lines = [];

  lines.push('# 🏔️ AWS Bedrock — Model Changes');
  lines.push(`Total tracked: **${total}**`);

  components.push({ type: 10, content: lines.join('\n') });

  if (diff.added.length > 0) {
    components.push({ type: 14 });
    components.push({ type: 10, content: `## 🆕 New Models (${diff.added.length})` });
    const byProv = {};
    for (const m of diff.added) {
      if (!byProv[m.provider]) byProv[m.provider] = [];
      byProv[m.provider].push(m);
    }
    for (const [prov, ms] of Object.entries(byProv)) {
      const entries = ms.map(m =>
        `${m.name} — ${endpointEmoji(m.runtime)} runtime · ${endpointEmoji(m.mantle)} mantle`
      ).join('\n');
      components.push({ type: 10, content: `**${prov}**\n${entries}` });
    }
  }

  if (diff.removed.length > 0) {
    components.push({ type: 14 });
    components.push({ type: 10, content: `## 🗑️ Removed Models (${diff.removed.length})` });
    const byProv = {};
    for (const m of diff.removed) {
      if (!byProv[m.provider]) byProv[m.provider] = [];
      byProv[m.provider].push(m);
    }
    for (const [prov, ms] of Object.entries(byProv)) {
      components.push({ type: 10, content: `**${prov}**\n${ms.map(m => m.name).join('\n')}` });
    }
  }

  if (diff.changed.length > 0) {
    components.push({ type: 14 });
    components.push({ type: 10, content: `## 🔄 Endpoint Changes (${diff.changed.length})` });
    const byProv = {};
    for (const c of diff.changed) {
      if (!byProv[c.model.provider]) byProv[c.model.provider] = [];
      byProv[c.model.provider].push(c);
    }
    for (const [prov, cs] of Object.entries(byProv)) {
      const entries = cs.map(c => {
        const m = c.model;
        const o = c.old;
        const parts = [];
        if (o.runtime !== m.runtime) parts.push(`runtime: ${endpointEmoji(o.runtime)} → ${endpointEmoji(m.runtime)}`);
        if (o.mantle !== m.mantle) parts.push(`mantle: ${endpointEmoji(o.mantle)} → ${endpointEmoji(m.mantle)}`);
        return `${m.name} — ${parts.join(', ')}`;
      }).join('\n');
      components.push({ type: 10, content: `**${prov}**\n${entries}` });
    }
  }



  return {
    username: 'Bedrock Watcher',
    avatar_url: LOGO_URL,
    flags: 32768,
    components: [{ type: 17, components }],
  };
}

async function main() {
  console.log('=== Bedrock Model Availability Watcher ===');
  const config = loadConfig();
  const statePath = join(__dirname, '..', config.state.file);
  const prevState = loadOrInit(statePath);
  const webhookUrl = process.env[config.webhook.webhookEnv];

  console.log('Fetching model availability page...');
  const md = await fetchMarkdown(config.scan.url, config.scan.timeout);
  const models = parseModels(md);
  console.log(`Parsed ${models.length} models from ${new Set(models.map(m => m.provider)).size} providers`);

  const diff = diffModels(prevState.models, models);
  const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

  if (!hasChanges && prevState.models.length > 0) {
    console.log('No changes detected');
    saveState(statePath, { models, timestamp: Date.now() });
    return;
  }

  if (prevState.models.length === 0) {
    console.log('First run — saving baseline');
    saveState(statePath, { models, timestamp: Date.now() });
    return;
  }

  console.log(`Changes: +${diff.added.length} new, -${diff.removed.length} removed, ~${diff.changed.length} updated`);

  if (webhookUrl) {
    const payload = buildNotification(diff, models.length);
    const res = await fetch(webhookUrl + '?with_components=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) console.log('Discord notification sent');
    else console.error('Discord send failed:', res.status, await res.text());
  }

  saveState(statePath, { models, timestamp: Date.now() });
  console.log(`=== Bedrock scan complete: ${models.length} models ===`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
