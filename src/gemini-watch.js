import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrapeRpcMappings } from '@cloudwaddie/googleinternal';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';
const BAR_WIDTH = 20;

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Shades-grey style progress bar: ▓ filled, ░ empty. */
export function progressBar(pct) {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  return '[' + '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled) + `] ${Math.round(pct)}%`;
}

/**
 * Edit a webhook message (live progress updates). Webhooks may PATCH
 * messages they posted; with_components=true is required to update components.
 */
export async function patchMessage(webhookUrl, messageId, payload) {
  const res = await fetch(`${webhookUrl}/messages/${messageId}?with_components=true`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error('Discord PATCH failed:', res.status, await res.text());
  return res.ok;
}

/** Delete a previously posted webhook message (no-changes runs leave nothing behind). */
export async function deleteMessage(webhookUrl, messageId) {
  const res = await fetch(`${webhookUrl}/messages/${messageId}?with_components=true`, {
    method: 'DELETE',
  });
  if (!res.ok) console.error('Discord DELETE failed:', res.status, await res.text());
  return res.ok;
}

export function buildProgressPayload(p) {
  const pct = p.chunksTotal > 0
    ? (p.chunksExtracted / p.chunksTotal) * 100
    : (p.modulesCompleted / p.modulesTotal) * 100;
  const bar = progressBar(pct);
  const phase = p.chunksTotal > 0 ? 'Extracting RPC mappings' : 'Fetching modules';
  const done = p.chunksTotal > 0 ? p.chunksExtracted : p.modulesCompleted;
  const total = p.chunksTotal > 0 ? p.chunksTotal : p.modulesTotal;
  return {
    username: 'Gemini RPC Watcher',
    avatar_url: LOGO_URL,
    flags: 32768,
    components: [{
      type: 17,
      components: [
        { type: 10, content: `# 🔍 Gemini RPC scan — ${phase}\n${bar}\n\`${done}/${total}\` · **${p.mappingsFound}** RPCs found` },
        { type: 14 },
        { type: 10, content: `Target: \`gemini.google.com\`` },
      ],
    }],
  };
}

/** Service name = path prefix before the first dot (e.g. BardFrontendService). */
function serviceOf(path) {
  const dot = path.indexOf('.');
  return dot > 0 ? path.slice(0, dot) : 'other';
}

function formatEntry(rpcid, path, type) {
  const t = type ? ` \`(${type})\`` : '';
  return `\`${rpcid}\` → \`${path}\`${t}`;
}

/**
 * Build the final diff report as a components-v2 payload.
 * new = rpcid absent from previous state; removed = gone from current;
 * changed = same rpcid, different path (or different call type).
 */
export function buildReport(prev, curr, types) {
  const components = [];
  const lines = [];
  const newIds = [], removedIds = [], changedIds = [];

  for (const [id, path] of curr) {
    if (!(id in prev.mappings)) newIds.push(id);
    else if (prev.mappings[id] !== path) changedIds.push(id);
  }
  for (const id of Object.keys(prev.mappings)) {
    if (!curr.has(id)) removedIds.push(id);
  }

  const header = `# 🔭 Gemini RPC Mappings`;
  const summary = [
    `**${newIds.length} new** · **${removedIds.length} removed** · **${changedIds.length} changed**`,
    `Scanned **${curr.size}** RPCs total`,
  ].join('\n');
  components.push({ type: 10, content: header + '\n' + summary });
  components.push({ type: 14 });

  const grouped = { new: newIds, removed: removedIds, changed: changedIds };
  for (const [kind, ids] of Object.entries(grouped)) {
    if (ids.length === 0) continue;
    const byService = {};
    for (const id of ids) {
      const path = kind === 'removed' ? prev.mappings[id] : curr.get(id);
      const svc = serviceOf(path);
      if (!byService[svc]) byService[svc] = [];
      byService[svc].push(formatEntry(id, path, types.get(id)));
    }
    const label = { new: '🟢 New', removed: '🔴 Removed', changed: '🟡 Changed' }[kind];
    const blocks = Object.entries(byService)
      .map(([svc, entries]) => `**${svc}**\n${entries.join('\n')}`)
      .join('\n\n');
    components.push({ type: 10, content: `### ${label} (${ids.length})\n${blocks}` });
    components.push({ type: 14 });
  }

  if (newIds.length + removedIds.length + changedIds.length === 0) {
    components.push({ type: 10, content: 'No changes detected — all RPC mappings identical to previous scan.' });
  }

  return {
    username: 'Gemini RPC Watcher',
    avatar_url: LOGO_URL,
    flags: 32768,
    components: [{ type: 17, components }],
  };
}

async function main() {
  const config = JSON.parse(readFileSync(join(__dirname, '../gemini-config.json'), 'utf8'));
  const statePath = join(__dirname, '..', config.state.file);
  let prev = { mappings: {}, types: {}, timestamp: 0 };
  if (existsSync(statePath)) {
    try {
      prev = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (e) {
      console.error('Failed to parse state file, starting fresh:', e.message);
    }
  }
  const webhookUrl = process.env[config.webhook.webhookEnv];
  const targetUrl = config.scan.targetUrl;

  let messageId = null;
  let lastPatch = 0;

  const onProgress = async (p) => {
    if (!webhookUrl || config.webhook.enabled === false) return;
    const now = Date.now();
    // Throttle: Discord webhooks allow ~30 requests/min; 5s spacing is safe.
    if (now - lastPatch < 5000) return;
    lastPatch = now;
    if (!messageId) {
      const res = await fetch(`${webhookUrl}?wait=true&with_components=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildProgressPayload(p)),
      });
      if (res.ok) {
        const msg = await res.json();
        messageId = msg.id;
        console.log(`Discord progress message posted (id ${messageId})`);
      } else {
        console.error('Discord POST failed:', res.status, await res.text());
      }
    } else {
      await patchMessage(webhookUrl, messageId, buildProgressPayload(p));
    }
  };

  console.log(`Scanning RPC mappings of ${targetUrl}...`);
  const { mappings, mappingTypes, stats } = await scrapeRpcMappings(targetUrl, onProgress);

  // Final 100% progress patch
  if (messageId && webhookUrl) {
    await patchMessage(webhookUrl, messageId, buildProgressPayload({
      modulesCompleted: 1, modulesTotal: 1, chunksExtracted: 1, chunksTotal: 1, mappingsFound: mappings.size,
    }));
  }

  console.log(`Scanned ${mappings.size} RPCs, ${mappingTypes.size} with known call types (${stats.elapsedMs}ms)`);

  if (!prev.mappings || Object.keys(prev.mappings).length === 0) {
    console.log('First run — saving baseline, no notification');
    if (messageId && webhookUrl) await deleteMessage(webhookUrl, messageId);
    saveState(statePath, {
      mappings: Object.fromEntries(mappings),
      types: Object.fromEntries(mappingTypes),
      timestamp: Date.now(),
    });
    return;
  }

  const hasChanges = [...mappings.keys()].some(id => prev.mappings[id] !== mappings.get(id)) ||
    Object.keys(prev.mappings).some(id => !mappings.has(id)) ||
    [...mappingTypes.keys()].some(id => prev.types?.[id] && prev.types[id] !== mappingTypes.get(id));

  if (messageId && webhookUrl) {
    if (hasChanges) {
      // Turn the progress message into the final report (no extra message spam).
      await patchMessage(webhookUrl, messageId, buildReport(prev, mappings, mappingTypes));
    } else {
      // Nothing changed — clean up the progress message instead of leaving an empty report.
      await deleteMessage(webhookUrl, messageId);
    }
  } else if (hasChanges && webhookUrl) {
    const res = await fetch(`${webhookUrl}?with_components=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildReport(prev, mappings, mappingTypes)),
    });
    if (res.ok) console.log('Discord notification sent');
    else console.error('Discord send failed:', res.status, await res.text());
  } else {
    console.log(hasChanges ? 'Changes detected, but no webhook configured.' : 'No changes detected.');
  }

  saveState(statePath, {
    mappings: Object.fromEntries(mappings),
    types: Object.fromEntries(mappingTypes),
    timestamp: Date.now(),
  });
  console.log(`=== Gemini scan complete: ${mappings.size} RPCs ===`);
}

const isCli = process.argv[1] && /gemini-watch\.js$/.test(process.argv[1]);
if (isCli) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}