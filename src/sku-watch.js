import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GoogleInternal } from '@cloudwaddie/googleinternal';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

// Variant words that, when found AFTER the family keyword in a SKU name,
// mark the end of the model key (everything after is a price variant, not a new model).
const VARIANT_WORDS = new Set([
  'text', 'image', 'video', 'audio', 'count', 'token', 'tokens', 'hours', 'cached', 'storage',
  'batch', 'flex', 'priority', 'regional', 'online', 'predictions', 'native', 'input', 'output',
  'for', 'over', 'generation', 'content', 'live', 'embed', 'music', 'of', 'in', 'per', 'expressed',
  'non', 'thinking', 'short', 'long', 'carry', 'permission', 'preview',
  'when', 'is', 'up', 'to', '128k', 'longer', 'than', 'with', 'models', 'grounding', 'search',
  'query', 'free', 'paid', 'one', 'maps',
]);

// Family keywords that identify a model root in a SKU name.
const FAMILY_RE = /\b(gemini|imagen|veo|lyria|omni|robotics|embed|palm)\b/;

// Workspace/enterprise subscription SKUs are not AI models.
const SUBSCRIPTION_RE = /subscription|term|savings plan|per 1 month|per 1 year/i;

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/**
 * Extract a normalized model key from a SKU name.
 * "Generate content input token count gemini 3.7 flash text" -> "gemini 3.7 flash"
 * "Gemini ER1.6 Text Batch Output - Online Predictions" -> "gemini er1.6"
 * " Imagen 4 fast Generation (output)" -> "imagen 4 fast"
 * "Embed content input token count gemini embedding 2 image batch" -> "gemini embedding 2"
 */
function modelKeyFromName(name) {
  if (SUBSCRIPTION_RE.test(name)) return null;
  const lower = name.toLowerCase().replace(/[_-]/g, ' ');
  // Prefer "gemini" as anchor when present (covers "gemini omni flash", "gemini robotics er 2",
  // "gemini embedding 2"); otherwise use the LAST family keyword match.
  const geminiAt = lower.search(/\bgemini\b/);
  const start = geminiAt >= 0 ? geminiAt : (() => {
    let m, last = null;
    const re = new RegExp(FAMILY_RE.source, 'g');
    while ((m = re.exec(lower)) !== null) last = m;
    return last ? last.index : -1;
  })();
  if (start < 0) return null;
  const words = lower.slice(start).split(/\s+/).filter(Boolean).map(w => w.replace(/[(),./]+$/, ''));
  const key = [];
  for (const w of words) {
    if (key.length > 0 && VARIANT_WORDS.has(w)) break;
    key.push(w);
  }
  // Standardize spacing around version suffixes like "1.6" and drop dangling punctuation
  return key.join(' ').replace(/[(),.]+$/, '').trim();
}

/**
 * Parse a price string like "2.50 USD per 1,000,000 count" -> { amount, per }
 * Handles tiered strings by taking the first rate.
 */
function parsePrice(priceStr) {
  const m = String(priceStr || '').match(/([\d.]+)\s+USD per\s+([\d,]+)\s+(\w+)/);
  if (!m) return null;
  return { amount: parseFloat(m[1]), per: parseInt(m[2].replace(/,/g, ''), 10), unit: m[3] };
}

function formatPrice(price) {
  if (!price) return 'n/a';
  const amt = price.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  if (price.per === 1000000) return `${amt}/1M`;
  if (price.per === 1000) return `${amt}/1K`;
  if (price.per === 1) return `${amt}/unit`;
  return `${amt}/per ${price.per.toLocaleString('en-US')}`;
}

function buildNotification(newModels) {
  const components = [];
  const lines = [];
  lines.push('# 🧮 Google Cloud SKU — New AI Models');
  lines.push(`Detected **${newModels.length}** new model${newModels.length === 1 ? '' : 's'}`);
  components.push({ type: 10, content: lines.join('\n') });
  components.push({ type: 14 });

  const byFamily = {};
  for (const n of newModels) {
    const fam = n.family || 'other';
    if (!byFamily[fam]) byFamily[fam] = [];
    byFamily[fam].push(n);
  }

  for (const [fam, models] of Object.entries(byFamily)) {
    const entries = models.map(m => {
      const name = m.name.charAt(0).toUpperCase() + m.name.slice(1);
      const prices = [];
      if (m.input) prices.push(`in: ${m.input}`);
      if (m.output) prices.push(`out: ${m.output}`);
      return `**${name}** — ${prices.join(' · ')}`;
    }).join('\n');
    components.push({ type: 10, content: `${buildFamilyLabel(fam)}\n${entries}` });
  }

  return {
    username: 'SKU Watcher',
    avatar_url: LOGO_URL,
    flags: 32768,
    components: [{ type: 17, components }],
  };
}

function buildFamilyLabel(fam) {
  return fam.charAt(0).toUpperCase() + fam.slice(1);
}

async function main() {
  const config = JSON.parse(readFileSync(join(__dirname, '../sku-config.json'), 'utf8'));
  const statePath = join(__dirname, '..', config.state.file);
  let prevState = { models: {} };
  if (existsSync(statePath)) {
    try {
      prevState = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch (e) {
      console.error('Failed to parse state file, starting fresh:', e.message);
    }
  }
  const webhookUrl = process.env[config.webhook.webhookEnv];

  const client = new GoogleInternal({});
  const skus = client.registerService('skus', {
    baseUrl: 'https://cloud.google.com/_/GoogleCloudUxWebAppCgcUi/data/batchexecute',
    sourcePath: '/skus',
    responseType: 'chunked',
  });
  skus.register('search', {
    rpcId: 'jBDUmc',
    mapArgs: (d) => [d.filter, d.currency, d.slot3 ?? null, d.limit],
    mapResult: (arr) => arr,
  });

  // New models discovered on this run, keyed by model key for dedupe across filters
  const newModelsByKey = new Map();
  const currentModels = new Map(); // key -> { name, family, input, output }

  console.log('Scanning Google Cloud SKU catalog...');
  for (const filter of config.scan.filters) {
    let cursor = null;
    let total = 0;
    for (let page = 0; page < config.scan.maxPages; page++) {
      try {
        const r = await skus.execute('search', {
          filter,
          currency: config.scan.currency,
          slot3: cursor,
          limit: config.scan.pageSize,
        });
        const groups = r?.[1];
        if (!Array.isArray(groups) || groups.length === 0) {
          console.log(`[${filter}] page ${page + 1}: empty response, stopping`);
          break;
        }
        const rows = groups.flatMap(g => g[2]);
        for (const row of rows) {
          const [skuId, name, , priceStr] = row;
          const key = modelKeyFromName(name);
          if (!key) continue;
          const price = parsePrice(priceStr);
          const isInput = /input token count/i.test(name);
          const isOutput = /output token count/i.test(name);
          const existing = currentModels.get(key) || { name: key, family: key.split(' ')[0], input: null, output: null };
          if (isInput && price) existing.input = formatPrice(price);
          if (isOutput && price) existing.output = formatPrice(price);
          currentModels.set(key, existing);
          if (!prevState.models[key]) {
            newModelsByKey.set(key, existing);
          }
          total++;
        }
        cursor = typeof r?.[0] === 'string' ? r[0] : null;
        if (!cursor || rows.length < config.scan.pageSize) break;
      } catch (e) {
        console.error(`[${filter}] page ${page + 1} failed:`, e.message);
        break;
      }
    }
    console.log(`[${filter}] scanned ${total} SKUs`);
  }

  const newModels = [...newModelsByKey.values()];
  console.log(`Scanned ${currentModels.size} unique models, ${newModels.length} new`);

  if (prevState.models && Object.keys(prevState.models).length === 0) {
    console.log('First run — saving baseline');
    saveState(statePath, { models: Object.fromEntries(currentModels), timestamp: Date.now() });
    return;
  }

  if (newModels.length > 0 && webhookUrl) {
    const payload = buildNotification(newModels);
    const res = await fetch(webhookUrl + '?with_components=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) console.log('Discord notification sent');
    else console.error('Discord send failed:', res.status, await res.text());
  }

  saveState(statePath, { models: Object.fromEntries(currentModels), timestamp: Date.now() });
  console.log(`=== SKU scan complete: ${currentModels.size} models ===`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});