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

function buildNotifications(diff, total) {
  const payloads = [];
  const common = {
    username: 'Bedrock Watcher',
    avatar_url: LOGO_URL,
    flags: 32768,
  };

  const header = `# 🏔️ AWS Bedrock — Model Changes\nTotal tracked: **${total}**`;
  payloads.push({ ...common, components: [{ type: 17, components: [{ type: 10, content: header }] }] });

  const DISCORD_LIMIT = 2000;

  const processSection = (title, items, lineBuilder) => {
    if (items.length === 0) return;
    
    payloads.push({ ...common, components: [{ type: 17, components: [{ type: 10, content: `## ${title} (${items.length})` }] }] });
    
    const byProv = {};
    for (const item of items) {
      const provider = item.provider || item.model.provider;
      if (!byProv[provider]) byProv[provider] = [];
      byProv[provider].push(item);
    }

    for (const [prov, ms] of Object.entries(byProv)) {
      let currentContent = `**${prov}**\n`;
      for (const m of ms) {
        const line = lineBuilder(m);
        if (currentContent.length + line.length > DISCORD_LIMIT - 50) {
          payloads.push({ ...common, components: [{ type: 17, components: [{ type: 10, content: currentContent.trim() }] }] });
          currentContent = `**${prov} (cont.)**\n`;
        }
        currentContent += line;
      }
      payloads.push({ ...common, components: [{ type: 17, components: [{ type: 10, content: currentContent.trim() }] }] });
    }
  };

  processSection('🆕 New Models', diff.added, m => `${m.name} — ${endpointEmoji(m.runtime)} runtime · ${endpointEmoji(m.mantle)} mantle\n`);
  processSection('🗑️ Removed Models', diff.removed, m => `${m.name}\n`);
  processSection('🔄 Endpoint Changes', diff.changed, c => {
    const parts = [];
    if (c.old.runtime !== c.model.runtime) parts.push(`runtime: ${endpointEmoji(c.old.runtime)} → ${endpointEmoji(c.model.runtime)}`);
    if (c.old.mantle !== c.model.mantle) parts.push(`mantle: ${endpointEmoji(c.old.mantle)} → ${endpointEmoji(c.model.mantle)}`);
    return `${c.model.name} — ${parts.join(', ')}\n`;
  });

  return payloads;
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

  const diff = diffModels(prevState.models, models);
  const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

  if (!hasChanges && prevState.models.length > 0) {
    saveState(statePath, { models, timestamp: Date.now() });
    return;
  }

  if (prevState.models.length === 0) {
    saveState(statePath, { models, timestamp: Date.now() });
    return;
  }

  if (webhookUrl) {
    const payloads = buildNotifications(diff, models.length);
    for (const payload of payloads) {
      await fetch(webhookUrl + '?with_components=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
  }

  saveState(statePath, { models, timestamp: Date.now() });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
