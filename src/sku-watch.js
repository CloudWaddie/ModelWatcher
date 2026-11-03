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
export function modelKeyFromName(name) {
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
export function parsePrice(priceStr) {
  const m = String(priceStr || '').match(/([\d.]+)\s+USD per\s+([\d,]+)\s+(\w+)/);
  if (!m) return null;
  return { amount: parseFloat(m[1]), per: parseInt(m[2].replace(/,/g, ''), 10), unit: m[3] };
}

export function formatPrice(price) {
  if (!price) return 'n/a';
  const amt = price.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  if (price.per === 1000000) return `${amt}/1M`;
  if (price.per === 1000) return `${amt}/1K`;
  if (price.per === 1) return `${amt}/unit`;
  return `${amt}/per ${price.per.toLocaleString('en-US')}`;
}

/**
 * One model key covers dozens of SKUs (audio/image/video, batch, flex, priority, cached,
 * contributor, Live...). Picking "the last row seen" made the displayed price depend on
 * the API's row order, which changes between runs. Instead score every candidate SKU and
 * pick the plain standard-tier text one, with a stable tie-break.
 */
export function skuPenalty(name) {
  const n = name.toLowerCase();
  let p = 0;
  if (/\bcach(?:ed|ing)\b/.test(n)) p += 100;                      // cached-input / caching discounts
  if (/batch|\b(flex|priority|contributor|regional)\b/.test(n)) p += 50; // non-standard tiers ("BatchGenerateContent" is one word)
  if (/\b(live|tts|translate)\b|bidi/.test(n)) p += 50;                  // different product sharing the key
  if (/\b(audio|image|video)\b/.test(n) && !/\btext\b/.test(n)) p += 10;  // prefer the text modality
  if (/\b(over|longer|long)\b/.test(n)) p += 20;                   // long-context tier
  return p;
}

/** Keep the best (lowest penalty, then name, then price) candidate per kind, order-independently. */
export function betterCandidate(cur, cand) {
  if (!cur) return cand;
  if (cand.penalty !== cur.penalty) return cand.penalty < cur.penalty ? cand : cur;
  if (cand.name !== cur.name) return cand.name < cur.name ? cand : cur;
  return cand.formatted < cur.formatted ? cand : cur;
}

/** Same data, stable JSON, so unchanged scans produce byte-identical state. */
function modelsEqual(a, b) {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
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
  const candidates = new Map(); // key -> { input: cand|null, output: cand|null }
  const seenSkuIds = new Set();
  let scanComplete = true; // false if any page errored / ended early: a partial scan must never delete or re-price

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
          if (page === 0) scanComplete = false; // a first page with nothing is a failed scan, not an empty catalog
          break;
        }
        const rows = groups.flatMap(g => g[2]);
        for (const row of rows) {
          const [skuId, name, , priceStr] = row;
          if (skuId != null) { if (seenSkuIds.has(skuId)) continue; seenSkuIds.add(skuId); }  // 'gemini' and 'generate' filters overlap
          const key = modelKeyFromName(name);
          if (!key) continue;
          const price = parsePrice(priceStr);
          const isInput = /input token count/i.test(name);
          const isOutput = /output token count/i.test(name);
          const entry = candidates.get(key) || { input: null, output: null };
          if (price && (isInput || isOutput)) {
            const kind = isOutput && !isInput ? 'output' : 'input';
            entry[kind] = betterCandidate(entry[kind], { penalty: skuPenalty(name), name, formatted: formatPrice(price) });
          }
          candidates.set(key, entry);
          total++;
        }
        cursor = typeof r?.[0] === 'string' ? r[0] : null;
        if (!cursor || rows.length < config.scan.pageSize) break;
      } catch (e) {
        console.error(`[${filter}] page ${page + 1} failed:`, e.message);
        scanComplete = false;
        break;
      }
    }
    console.log(`[${filter}] scanned ${total} SKUs`);
  }

  const scanned = new Map();
  for (const [key, c] of candidates) {
    scanned.set(key, { name: key, family: key.split(' ')[0], input: c.input?.formatted ?? null, output: c.output?.formatted ?? null });
  }
  const prevModels = prevState.models ?? {};
  const prevCount = Object.keys(prevModels).length;
  // Suspiciously small scans (rate limit / partial pagination) are treated as incomplete too.
  if (prevCount > 0 && scanned.size < prevCount * 0.9) {
    console.warn(`Scan returned ${scanned.size} models vs ${prevCount} known — treating as incomplete`);
    scanComplete = false;
  }

  if (prevCount === 0) {
    if (!scanComplete || scanned.size === 0) { console.error('First run scan incomplete — not saving a baseline'); process.exit(1); }
    console.log('First run — saving baseline');
    saveState(statePath, { models: Object.fromEntries(scanned), timestamp: Date.now() });
    return;
  }

  // State is "every model ever seen": absence never deletes (retired models stay known), so a
  // flaky scan can never make a known model look new again. Prices only update on complete scans.
  const merged = { ...prevModels };
  const newModels = [];
  for (const [key, model] of scanned) {
    if (!prevModels[key]) { merged[key] = model; newModels.push(model); }
    else if (scanComplete) merged[key] = model;
  }
  console.log(`Scanned ${scanned.size} unique models (${scanComplete ? 'complete' : 'INCOMPLETE'}), ${newModels.length} new`);

  if (newModels.length > 0 && webhookUrl) {
    const payload = buildNotification(newModels);
    const res = await fetch(webhookUrl + '?with_components=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) console.log('Discord notification sent');
    else { console.error('Discord send failed:', res.status, await res.text()); }
  }

  // Only touch the state file when something changed: a rewrite every run (new timestamp) made
  // 832 of 867 historical commits no-ops.
  if (modelsEqual(prevModels, merged)) {
    console.log(`=== SKU scan complete: ${Object.keys(merged).length} models, no changes (state untouched) ===`);
    return;
  }
  saveState(statePath, { models: merged, timestamp: Date.now() });
  console.log(`=== SKU scan complete: ${Object.keys(merged).length} models, state updated ===`);
}

const isCli = process.argv[1] && /sku-watch\.js$/.test(process.argv[1]);
if (isCli) main().catch(err => {
  console.error(err);
  process.exit(1);
});