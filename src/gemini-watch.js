import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { scrapeRpcMappings } from '@cloudwaddie/googleinternal';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';
const BAR_WIDTH = 20;

// Discord display components cap total text at 4000 chars per message.
const TEXT_CHAR_LIMIT = 3800;
const MAX_SEGMENTS_PER_CONTAINER = 5;

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

export function buildProgressPayload(p, target = 'gemini.google.com') {
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
        { type: 10, content: `Target: \`${target}\`` },
      ],
    }],
  };
}

/** Split a formatted entry list into chunks that each fit the text limit. */
function chunkEntries(entries, limit) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const e of entries) {
    const l = e.length + 1;
    if (cur.length && len + l > limit) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(e);
    len += l;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Greedily pack text segments into messages that respect per-message limits. */
function packMessages(segments, limit) {
  const messages = [];
  let cur = [];
  let total = 0;
  for (const seg of segments) {
    if (cur.length >= MAX_SEGMENTS_PER_CONTAINER || (cur.length && total + seg.length > limit)) {
      messages.push(cur);
      cur = [];
      total = 0;
    }
    cur.push(seg);
    total += seg.length;
  }
  if (cur.length) messages.push(cur);
  return messages;
}

function payloadForSegments(segments, part, total) {
  const comps = segments.map((s, i) => ({ type: 10, content: s }));
  if (total > 1) comps[comps.length - 1].content += `\n*— part ${part}/${total} —*`;
  return {
    username: 'Gemini RPC Watcher',
    avatar_url: LOGO_URL,
    flags: 32768,
    components: [{
      type: 17,
      components: comps.flatMap((c, i) => (i ? [{ type: 14 }, c] : [c])),
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
 * Build the diff report as an array of components-v2 payloads (one per Discord
 * message, chunked under the 4000-char display-component text limit).
 * new = rpcid absent from previous state; removed = gone from current;
 * changed = same rpcid, different path (or different call type).
 * With `firstRun: true`, the report renders as a full baseline where every
 * current mapping appears under 🟢 New (i.e. the diff as if all were created).
 */
export function buildReportMessages(prev, curr, types, options = {}) {
  const { firstRun = false } = options;
  const newIds = [], removedIds = [], changedIds = [];

  for (const [id, path] of curr) {
    if (!(id in prev.mappings)) newIds.push(id);
    else if (prev.mappings[id] !== path) changedIds.push(id);
  }
  for (const id of Object.keys(prev.mappings)) {
    if (!curr.has(id)) removedIds.push(id);
  }

  const header = firstRun
    ? `# 🌱 Gemini RPC Mappings — initial baseline`
    : `# 🔭 Gemini RPC Mappings`;
  const summary = [
    `**${newIds.length} new** · **${removedIds.length} removed** · **${changedIds.length} changed**`,
    ...(firstRun ? ['First run — full mapping dump'] : []),
    `Scanned **${curr.size}** RPCs total`,
  ].join('\n');
  const segments = [`${header}\n${summary}`];

  const grouped = { new: newIds, removed: removedIds, changed: changedIds };
  const label = { new: '🟢 New', removed: '🔴 Removed', changed: '🟡 Changed' };
  for (const [kind, ids] of Object.entries(grouped)) {
    if (ids.length === 0) continue;
    const byService = {};
    for (const id of ids) {
      const path = kind === 'removed' ? prev.mappings[id] : curr.get(id);
      const svc = serviceOf(path);
      if (!byService[svc]) byService[svc] = [];
      byService[svc].push(formatEntry(id, path, types.get(id)));
    }
    segments.push(`### ${label[kind]} (${ids.length})`);
    for (const [svc, entries] of Object.entries(byService)) {
      for (const chunk of chunkEntries(entries, TEXT_CHAR_LIMIT)) {
        segments.push(`**${svc}**\n${chunk.join('\n')}`);
      }
    }
  }

  if (newIds.length + removedIds.length + changedIds.length === 0) {
    segments.push('No changes detected — all RPC mappings identical to previous scan.');
  }

  const packed = packMessages(segments, TEXT_CHAR_LIMIT);
  return packed.map((m, i) => payloadForSegments(m, i + 1, packed.length));
}

/** First report message only; kept for callers that expect a single payload. */
export function buildReport(prev, curr, types, options = {}) {
  return buildReportMessages(prev, curr, types, options)[0];
}

async function postPayload(webhookUrl, payload, label) {
  const res = await fetch(`${webhookUrl}?with_components=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.ok) console.log(`[${label}] Discord notification sent`);
  else console.error(`[${label}] Discord send failed:`, res.status, await res.text());
  return res.ok;
}

async function runScan(scan, webhookUrl, webhookEnabled) {
  const statePath = join(__dirname, '..', scan.stateFile);
  let prev = { mappings: {}, types: {}, timestamp: 0 };
  if (existsSync(statePath)) {
    try {
      prev = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (e) {
      console.error(`[${scan.name}] Failed to parse state file, starting fresh:`, e.message);
    }
  }
  const firstRun = !prev.mappings || Object.keys(prev.mappings).length === 0;

  let messageId = null;
  let lastPatch = 0;

  const onProgress = async (p) => {
    if (!webhookUrl || !webhookEnabled) return;
    const now = Date.now();
    // Throttle: Discord webhooks allow ~30 requests/min; 5s spacing is safe.
    if (now - lastPatch < 5000) return;
    lastPatch = now;
    if (!messageId) {
      const res = await fetch(`${webhookUrl}?wait=true&with_components=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildProgressPayload(p, scan.targetUrl)),
      });
      if (res.ok) {
        const msg = await res.json();
        messageId = msg.id;
        console.log(`[${scan.name}] Discord progress message posted (id ${messageId})`);
      } else {
        console.error(`[${scan.name}] Discord POST failed:`, res.status, await res.text());
      }
    } else {
      await patchMessage(webhookUrl, messageId, buildProgressPayload(p, scan.targetUrl));
    }
  };

  console.log(`[${scan.name}] Scanning RPC mappings of ${scan.targetUrl}...`);
  const { mappings, mappingTypes, stats } = await scrapeRpcMappings(scan.targetUrl, onProgress);

  // Final 100% progress patch
  if (messageId && webhookUrl && webhookEnabled) {
    await patchMessage(webhookUrl, messageId, buildProgressPayload({
      modulesCompleted: 1, modulesTotal: 1, chunksExtracted: 1, chunksTotal: 1, mappingsFound: mappings.size,
    }, scan.targetUrl));
  }

  console.log(`[${scan.name}] Scanned ${mappings.size} RPCs, ${mappingTypes.size} with known call types (${stats.elapsedMs}ms)`);

  if (firstRun) {
    // No baseline yet — post the full mapping set as a report where every
    // entry is 🟢 New (the diff as if all were created), then save state.
    console.log(`[${scan.name}] First run — posting full mapping baseline`);
    const reports = buildReportMessages(prev, mappings, mappingTypes, { firstRun: true });
    if (messageId && webhookUrl && webhookEnabled) {
      // Turn the progress message into the baseline report header (no extra spam).
      await patchMessage(webhookUrl, messageId, reports[0]);
      for (const part of reports.slice(1)) {
        await postPayload(webhookUrl, part, scan.name);
      }
    } else if (webhookUrl && webhookEnabled) {
      for (const part of reports) {
        await postPayload(webhookUrl, part, scan.name);
      }
    } else {
      console.log(`[${scan.name}] First run — no webhook configured, baseline saved silently`);
    }
    saveState(statePath, {
      mappings: Object.fromEntries(mappings),
      types: Object.fromEntries(mappingTypes),
      timestamp: Date.now(),
    });
    console.log(`[${scan.name}] === First-run baseline saved: ${mappings.size} RPCs ===`);
    return;
  }

  const hasChanges = [...mappings.keys()].some(id => prev.mappings[id] !== mappings.get(id)) ||
    Object.keys(prev.mappings).some(id => !mappings.has(id)) ||
    [...mappingTypes.keys()].some(id => prev.types?.[id] && prev.types[id] !== mappingTypes.get(id));

  if (messageId && webhookUrl && webhookEnabled) {
    if (hasChanges) {
      const reports = buildReportMessages(prev, mappings, mappingTypes);
      // Turn the progress message into the report header (no extra message spam).
      await patchMessage(webhookUrl, messageId, reports[0]);
      for (const part of reports.slice(1)) {
        await postPayload(webhookUrl, part, scan.name);
      }
    } else {
      // Nothing changed — clean up the progress message instead of leaving an empty report.
      await deleteMessage(webhookUrl, messageId);
    }
  } else if (hasChanges && webhookUrl && webhookEnabled) {
    for (const part of buildReportMessages(prev, mappings, mappingTypes)) {
      await postPayload(webhookUrl, part, scan.name);
    }
  } else {
    console.log(`[${scan.name}] ${hasChanges ? 'Changes detected, but no webhook configured.' : 'No changes detected.'}`);
  }

  saveState(statePath, {
    mappings: Object.fromEntries(mappings),
    types: Object.fromEntries(mappingTypes),
    timestamp: Date.now(),
  });
  console.log(`[${scan.name}] === Scan complete: ${mappings.size} RPCs ===`);
}

async function main() {
  const config = JSON.parse(readFileSync(join(__dirname, '../gemini-config.json'), 'utf8'));
  const webhookUrl = process.env[config.webhook.webhookEnv];
  const webhookEnabled = config.webhook.enabled !== false;

  // New shape: scans[] with per-target state file. Falls back to the legacy
  // single scan.targetUrl + state.file shape if scans is absent.
  const scans = config.scans?.length
    ? config.scans
    : [{ name: 'gemini', targetUrl: config.scan?.targetUrl, stateFile: config.state?.file }];

  if (!scans.length) throw new Error('No scans configured in gemini-config.json');

  for (const scan of scans) {
    if (!scan.targetUrl || !scan.stateFile) throw new Error(`Scan "${scan.name}" is missing targetUrl or stateFile`);
    await runScan(scan, webhookUrl, webhookEnabled);
  }
}

const isCli = process.argv[1] && /gemini-watch\.js$/.test(process.argv[1]);
if (isCli) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}