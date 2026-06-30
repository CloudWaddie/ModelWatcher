import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

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
  let currentProvider = '';

  for (const line of lines) {
    const providerMatch = line.match(/^##\s+(.+)$/);
    if (providerMatch) {
      currentProvider = providerMatch[1].trim();
      continue;
    }

    const modelMatch = line.match(/^\|\s+([^|]+)\s+\|\s+([^|]+)\s+\|\s+([^|]+)\s+\|$/);
    if (modelMatch && !line.toLowerCase().includes('model name')) {
      models.push({
        name: modelMatch[1].trim(),
        runtime: modelMatch[2].includes('✅'),
        mantle: modelMatch[3].includes('✅'),
        provider: currentProvider
      });
    }
  }
  return models;
}

function diffModels(oldModels, newModels) {
  const added = [];
  const removed = [];
  const changed = [];

  const key = m => `${m.provider}::${m.name}`;
  const oldMap = new Map(oldModels.map(m => [key(m), m]));
  const newMap = new Map(newModels.map(m => [key(m), m]));

  for (const [k, m] of newMap) {
    if (!oldMap.has(k)) {
      added.push(m);
    } else {
      const o = oldMap.get(k);
      if (o.runtime !== m.runtime || o.mantle !== m.mantle) {
        changed.push({ model: m, old: o });
      }
    }
  }

  for (const [k, m] of oldMap) {
    if (!newMap.has(k)) {
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
  const config = JSON.parse(readFileSync(join(__dirname, '../bedrock-config.json'), 'utf8'));
  const statePath = join(__dirname, '..', config.state.file);
  let prevState = { models: [] };
  if (existsSync(statePath)) {
    try {
      prevState = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (e) {
      console.error('Failed to parse state file, starting fresh:', e.message);
    }
  }
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
  console.error(err);
  process.exit(1);
});