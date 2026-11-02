import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import https from 'https';
import { packMessages, postPayload } from './gemini-watch.js';

/**
 * Gemini Web App tracker.
 *
 * Snapshots everything trackable from gemini.google.com/app without logging in:
 * server version + build keys, WIZ_global_data flags/config/routes, experiment
 * IDs, lazy "islands", per-component i18n bundles and every UI string in them
 * (banners, Labs experiments, upsells, new features), then diffs vs. last run.
 *
 * The page is fetched several times per run because Google serves a per-request
 * random sample of experiment IDs / islands / some flags. Anything that differs
 * between samples is treated as bucketed noise; experiment IDs and islands are
 * accumulated as a union so only never-before-seen values are reported.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TEXT_CHAR_LIMIT = 3800;
const EXPERIMENT_KEY = 'znAqjf';
const ISLANDS_KEY = 'pOH7cf';
const VERSION_KEY = 'cfb2h';
const INLINE_LIMIT = 2000;

const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------------------------------------------------------------- extraction

export function parseWiz(html) {
  const m = html.match(/WIZ_global_data = (\{.*?\});<\/script>/s);
  if (m) return JSON.parse(m[1]);
  // AI Studio ships the same data as a bare JSON <script type="application/json">.
  for (const j of html.matchAll(/<script type="application\/json"[^>]*>(\{.*?\})<\/script>/gs)) {
    try { const o = JSON.parse(j[1]); if (VERSION_KEY in o) return o; } catch { /* next */ }
  }
  throw new Error('WIZ_global_data not found in page');
}

export function parseExperimentIds(raw) {
  if (Array.isArray(raw)) return raw.filter(n => Number.isInteger(n) && n >= 1e6);
  if (typeof raw !== 'string') return [];
  const i = raw.indexOf('[');
  if (i < 0) return [];
  return [...new Set((raw.slice(i).match(/\d{7,}/g) || []).map(Number))];
}

export function parseBuildKeys(html) {
  const js = html.match(/boq-[a-z-]+\.[A-Za-z]+\.[a-z_A-Z]+\.([A-Za-z0-9_-]+)\.\d+\.O\/am=/)?.[1] ?? null;
  const css = html.match(/boq-[a-z-]+\.[A-Za-z]+\.([A-Za-z0-9_-]+)\.L\.[A-Za-z0-9]+/)?.[1] ?? null;
  const islands = html.match(/islands\/assets\/(islands-[A-Za-z0-9_-]+\.js)/)?.[1] ?? null;
  return { js, css, islands };
}

/** Feature-toggle bitmask words, e.g. window["_F_toggles_default_MakerSuite"] = [0x8005101, ...]. */
export function parseToggles(html) {
  const m = html.match(/_F_toggles_[A-Za-z0-9_]+"\]\s*=\s*\[([^\]]*)\]/);
  if (!m) return null;
  return m[1].split(',').map(x => x.trim()).filter(Boolean).map(x => '0x' + parseInt(x, 16).toString(16));
}

/** Parse llms.txt into { url -> title } for every docs link. */
export function parseLlmsIndex(text) {
  const out = {};
  for (const m of text.matchAll(/^- \[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gm)) out[m[2]] = m[1];
  return out;
}

export function parseBundleUrls(html) {
  const out = {};
  const re = /https:\/\/www\.gstatic\.com\/bg3\/boq-bard-web\/full\/client\/assets\/en\/([A-Za-z0-9_]+)-messages-([A-Za-z0-9_-]+)\.js/g;
  for (const m of html.matchAll(re)) out[m[1]] = { hash: m[2], url: m[0] };
  return out;
}

export function parseIslandChunks(js) {
  const out = {};
  for (const m of js.matchAll(/"\.\/(?:__generated__\/)?([A-Za-z0-9_]+)\.tsx?":\(\)=>import\(`\.\/([A-Za-z0-9_-]+\.js)`\)/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Render an ICU-ish message AST (as emitted by lingui) into readable text. */
export function renderMessage(v) {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return JSON.stringify(v);
  if (v.length && typeof v[0] === 'string' && v.length === 1 && false) return v[0];
  // [name] variable, [name, "plural"|"select", {...}] branch, or a list of parts
  if (typeof v[0] === 'string' && (v.length === 1 || typeof v[1] === 'string') && v.every((x, i) => i === 0 || typeof x !== 'string' || ['plural', 'select', 'selectordinal', 'number', 'date'].includes(x))
      && v.length <= 3 && (v.length === 1 || ['plural', 'select', 'selectordinal', 'number', 'date'].includes(v[1]))) {
    if (v.length === 1) return `{${v[0]}}`;
    const branches = v[2] && typeof v[2] === 'object' ? Object.entries(v[2]).map(([k, b]) => `${k}{${renderMessage(b)}}`).join(' ') : '';
    return `{${v[0]}, ${v[1]}${branches ? ', ' + branches : ''}}`;
  }
  return v.map(renderMessage).join('');
}

export function parseBundle(text) {
  const m = text.match(/JSON\.parse\("(.*)"\);?\s*$/s);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(JSON.parse('"' + m[1] + '"')); } catch { return null; }
  const out = {};
  for (const [id, val] of Object.entries(obj)) out[id] = renderMessage(val);
  return out;
}

/**
 * Compare N WIZ samples. Keys identical across samples are stable; differing
 * bool/number keys are "bucketed"; differing strings are volatile (tokens).
 */
export function classifyWiz(samples, skipKeys = [EXPERIMENT_KEY, ISLANDS_KEY]) {
  const flags = {}, config = {}, bucketed = [], volatile = [];
  const keys = new Set(samples.flatMap(s => Object.keys(s)));
  for (const k of keys) {
    if (skipKeys.includes(k)) continue;
    const vals = samples.map(s => JSON.stringify(s[k]));
    const same = vals.every(v => v === vals[0]);
    const v = samples[0][k];
    const scalar = typeof v === 'boolean' || typeof v === 'number';
    if (!same) { (scalar ? bucketed : volatile).push(k); continue; }
    if (scalar) { flags[k] = v; continue; }
    const json = JSON.stringify(v);
    if (typeof v === 'string' && /^AIza/.test(v)) config[k] = { kind: 'apikey', hash: sha(v) };
    else if (json.length <= INLINE_LIMIT) config[k] = { kind: 'value', value: v, hash: sha(json) };
    else config[k] = { kind: 'hash', hash: sha(json), preview: clip(json, 120) };
  }
  return { flags, config, bucketed: bucketed.sort(), volatile: volatile.sort() };
}

/**
 * GET a URL as text via node:https. Not global fetch: Gemini's response headers
 * exceed Node's default 16KB limit (HeadersOverflowError), and undici's fetch
 * can't raise it per request while https.request can (maxHeaderSize).
 */
function httpsGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      maxHeaderSize: 1024 * 1024,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity' },
    }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(httpsGet(new URL(headers.location, url).toString(), redirects - 1));
      }
      if (statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchText(url, retries = 3) {
  let err;
  for (let i = 0; i < retries; i++) {
    try { return await httpsGet(url); }
    catch (e) { err = e; await sleep(1000 * (i + 1)); }
  }
  throw new Error(`fetch ${url} failed: ${err.message}`);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Take a full snapshot of the live app. `prev` supplies carried-over unions. */
export async function takeSnapshot(cfg, prev = {}) {
  const n = Math.max(1, cfg.samples ?? 6);
  const pages = [];
  for (let i = 0; i < n; i++) {
    pages.push(await fetchText(cfg.targetUrl));
    if (i < n - 1) await sleep(cfg.sampleDelayMs ?? 1500);
  }
  const wizSamples = pages.map(parseWiz);

  const expKey = cfg.experimentKey ?? EXPERIMENT_KEY;
  const { flags, config, bucketed, volatile } = classifyWiz(wizSamples, [expKey, ISLANDS_KEY, ...(cfg.ignoreKeys ?? [])]);
  const version = wizSamples[0][VERSION_KEY] ?? null;
  // css key omitted on purpose: it varies by user-agent variant and moves with the js key.
  const buildKeys = { js: null, islands: null };
  for (const p of pages) { const b = parseBuildKeys(p); for (const k of Object.keys(buildKeys)) buildKeys[k] ??= b[k]; }

  const seenExp = new Set(prev.experiments ?? []);
  const expNow = new Set();
  for (const w of wizSamples) for (const id of parseExperimentIds(w[expKey])) expNow.add(id);
  const experiments = [...new Set([...seenExp, ...expNow])].sort((a, b) => a - b);

  const islandNames = new Set(prev.islands?.names ?? []);
  for (const w of wizSamples) for (const x of w[ISLANDS_KEY] ?? []) islandNames.add(x);

  // Keys that ever flapped between samples stay ignored, so a flag that happened
  // to look stable this run doesn't surface as "new".
  const bucketedEver = [...new Set([...(prev.bucketedEver ?? prev.bucketed ?? []), ...bucketed])].sort();
  for (const k of bucketedEver) delete flags[k];

  const toggles = pages.map(parseToggles).find(Boolean) ?? null;

  let chunks = {};
  if (buildKeys.islands) {
    try { chunks = parseIslandChunks(await fetchText(`https://www.gstatic.com/bg3/boq-bard-web/islands/assets/${buildKeys.islands}`)); }
    catch (e) { console.error('islands fetch failed:', e.message); chunks = prev.islands?.chunks ?? {}; }
  }

  const bundleUrls = {};
  for (const p of pages) Object.assign(bundleUrls, parseBundleUrls(p));
  const bundles = {};
  for (const [k, v] of Object.entries(bundleUrls)) bundles[k] = v.hash;

  const strings = {};
  const failed = [];
  await mapLimit(Object.entries(bundleUrls), 12, async ([name, b]) => {
    // Reuse previous strings when the content-hashed bundle did not change.
    if (prev.bundles?.[name] === b.hash && prev.strings?.[name]) { strings[name] = prev.strings[name]; return; }
    try {
      const parsed = parseBundle(await fetchText(b.url));
      if (parsed) strings[name] = parsed; else failed.push(name);
    } catch { failed.push(name); }
  });
  for (const name of failed) if (prev.strings?.[name]) { strings[name] = prev.strings[name]; bundles[name] = prev.bundles?.[name] ?? bundles[name]; }

  const docs = cfg.docs ? await snapshotDocs(cfg.docs, prev.docs) : undefined;

  return {
    timestamp: Date.now(),
    version, buildKeys, flags, config,
    bucketed, bucketedEver, volatile,
    experiments,
    islands: { names: [...islandNames].sort(), chunks },
    bundles, strings,
    ...(toggles ? { toggles } : {}),
    ...(docs ? { docs } : {}),
  };
}

const DOC_NOISE = /^> (##? )?(AI Agent Context|Get the complete|Use this file|For the full documentation)/;

/**
 * Snapshot public docs: the llms.txt page index (new model/doc pages appear
 * here first) plus the line content of selected pages (changelog,
 * deprecations, pricing, rate limits, model lists).
 */
export async function snapshotDocs(docs, prev = {}) {
  let index = prev.index ?? {};
  try { index = parseLlmsIndex(await fetchText(docs.base + docs.index)); }
  catch (e) { console.error('docs index fetch failed:', e.message); }
  const pages = {};
  await mapLimit(docs.pages ?? [], 4, async (path) => {
    try {
      const text = await fetchText(docs.base + path);
      pages[path] = text.split('\n').map(l => l.trim()).filter(l => l && !DOC_NOISE.test(l));
    } catch (e) {
      console.error(`docs page ${path} failed:`, e.message);
      if (prev.pages?.[path]) pages[path] = prev.pages[path];
    }
  });
  return { index, pages };
}

// ---------------------------------------------------------------------- diff

export const EMPTY_SNAPSHOT = { version: null, buildKeys: {}, flags: {}, config: {}, toggles: [], experiments: [], islands: { names: [], chunks: {} }, bundles: {}, strings: {} };

const setDiff = (a, b) => [...b].filter(x => !a.has(x));

export function diffSnapshots(prev, curr, { experimentAlertMin = 150 } = {}) {
  const d = {};
  d.version = prev.version !== curr.version ? { from: prev.version, to: curr.version } : null;
  d.buildKeys = Object.keys(curr.buildKeys).filter(k => prev.buildKeys?.[k] !== curr.buildKeys[k])
    .map(k => ({ key: k, from: prev.buildKeys?.[k] ?? null, to: curr.buildKeys[k] }));

  // Flags: only report a real flip of an existing value. Keys appearing/vanishing
  // are almost always bucketing noise, and the first run has nothing to flip from.
  d.flags = [];
  for (const k of Object.keys(curr.flags)) {
    if (k in (prev.flags ?? {}) && prev.flags[k] !== curr.flags[k]) d.flags.push({ key: k, from: prev.flags[k], to: curr.flags[k] });
  }

  d.config = [];
  d.routes = [];
  for (const k of new Set([...Object.keys(prev.config ?? {}), ...Object.keys(curr.config)])) {
    const a = prev.config?.[k], b = curr.config[k];
    if (a?.hash === b?.hash) continue;
    if (!b) continue; // vanished keys are not interesting
    // New keys are noise, except a brand-new backend URL once we have a baseline.
    if (!a) {
      const seeded = Object.keys(prev.config ?? {}).length > 0;
      if (seeded && b.kind === 'value' && typeof b.value === 'string' && /^https?:\/\//.test(b.value)) d.config.push({ key: k, kind: 'url', from: a, to: b });
      continue;
    }
    if (a?.kind === 'value' && b?.kind === 'value' && Array.isArray(a.value) && Array.isArray(b.value)
        && [...a.value, ...b.value].every(x => typeof x === 'string')) {
      const added = setDiff(new Set(a.value), new Set(b.value)), removed = setDiff(new Set(b.value), new Set(a.value));
      d.routes.push({ key: k, added, removed });
    } else {
      d.config.push({ key: k, kind: (b ?? a).kind, from: a, to: b });
    }
  }

  const prevExp = new Set(prev.experiments ?? []);
  d.newExperiments = prevExp.size ? curr.experiments.filter(x => !prevExp.has(x)) : []; // first run: baseline only

  d.newIslands = setDiff(new Set(prev.islands?.names ?? []), new Set(curr.islands.names));
  d.islandChunks = [];
  for (const k of new Set([...Object.keys(prev.islands?.chunks ?? {}), ...Object.keys(curr.islands.chunks)])) {
    const a = prev.islands?.chunks?.[k], b = curr.islands.chunks[k];
    if (a !== b) d.islandChunks.push({ name: k, from: a ?? null, to: b ?? null });
  }

  d.newBundles = setDiff(new Set(Object.keys(prev.bundles ?? {})), new Set(Object.keys(curr.bundles)));
  d.removedBundles = setDiff(new Set(Object.keys(curr.bundles)), new Set(Object.keys(prev.bundles ?? {})));

  d.strings = {};
  for (const comp of new Set([...Object.keys(prev.strings ?? {}), ...Object.keys(curr.strings)])) {
    const a = prev.strings?.[comp] ?? {}, b = curr.strings[comp] ?? {};
    const added = [], removed = [], changed = [];
    for (const id of Object.keys(b)) {
      if (!(id in a)) added.push(b[id]);
      else if (a[id] !== b[id]) changed.push({ from: a[id], to: b[id] });
    }
    for (const id of Object.keys(a)) if (!(id in b)) removed.push(a[id]);
    if (added.length || removed.length || changed.length) d.strings[comp] = { added, removed, changed, isNew: !(comp in (prev.strings ?? {})) };
  }

  d.toggles = null;
  if (curr.toggles) {
    const a = prev.toggles ?? [];
    const idx = Math.max(a.length, curr.toggles.length);
    const changed = [];
    for (let i = 0; i < idx; i++) if (a[i] !== curr.toggles[i]) changed.push({ word: i, from: a[i] ?? null, to: curr.toggles[i] ?? null });
    if (changed.length && Array.isArray(prev.toggles)) d.toggles = changed; // old state without toggles: seed silently
  }

  d.docs = null;
  if (curr.docs) {
    const pi = prev.docs?.index ?? {}, ci = curr.docs.index;
    const newPages = Object.keys(ci).filter(u => !(u in pi)).map(u => ({ url: u, title: ci[u] }));
    const removedPages = Object.keys(pi).filter(u => !(u in ci)).map(u => ({ url: u, title: pi[u] }));
    const pageDiffs = [];
    for (const [path, lines] of Object.entries(curr.docs.pages)) {
      const before = new Set(prev.docs?.pages?.[path] ?? []), after = new Set(lines);
      const added = lines.filter(l => !before.has(l));
      const removed = [...before].filter(l => !after.has(l));
      if ((added.length || removed.length) && (path in (prev.docs?.pages ?? {}))) pageDiffs.push({ path, added, removed });
      else if (added.length && !(path in (prev.docs?.pages ?? {}))) pageDiffs.push({ path, added, removed: [], isNew: true });
    }
    if (newPages.length || removedPages.length || pageDiffs.length) d.docs = { newPages, removedPages, pageDiffs };
  }

  d.hasChanges = !!(d.toggles || d.docs || d.version || d.buildKeys.length || d.flags.length || d.config.length || d.routes.length
    || d.newExperiments.length >= experimentAlertMin || d.newIslands.length || d.islandChunks.length
    || d.newBundles.length || d.removedBundles.length || Object.keys(d.strings).length);
  return d;
}

// -------------------------------------------------------------------- report

const fmtCfg = (c) => (c ? clip(JSON.stringify(c.value ?? c.preview ?? ''), 60) : '∅');
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';

export function buildReportSegments(prev, curr, diff, cfg = {}, { firstRun = false } = {}) {
  const max = cfg.maxItemsPerSection ?? 25;
  const label = cfg.label ?? 'Gemini Web App';
  const hl = new RegExp(cfg.highlightComponentPattern || '(?!)', 'i');
  const T = cfg.trackers ?? {};
  const on = (k) => T[k] !== false;
  const segs = [];
  const stringCount = Object.values(curr.strings).reduce((n, c) => n + Object.keys(c).length, 0);

  if (firstRun) {
    segs.push([
      `# 🌱 ${label} — initial baseline`,
      `Server version: ${code(curr.version)}`,
      `**${Object.keys(curr.flags).length}** flags · **${Object.keys(curr.config).length}** config values · **${curr.experiments.length}** experiment IDs`,
      `**${Object.keys(curr.bundles).length}** string bundles (**${stringCount}** strings) · **${curr.islands.names.length}** islands · **${Object.keys(curr.islands.chunks).length}** page chunks`,
      `Ignored as noisy: ${curr.bucketed.length} bucketed flags, ${curr.volatile.length} volatile tokens`,
      'First run — everything below is reported as new.',
    ].join('\n'));
  } else {
    segs.push(`# 🌐 ${label}\n${code(curr.version)}${diff.version ? ' *(new build — see alert above)*' : ' (unchanged)'}`);
  }

  if (on('buildKeys') && diff.buildKeys.length && (firstRun || !diff.version)) {
    segs.push(`### 🔧 Build keys\n${diff.buildKeys.map(b => `**${b.key}**: ${code(b.from ?? '∅')} → ${code(b.to ?? '∅')}`).join('\n')}`);
  }
  if (on('flags') && diff.flags.length) {
    const lines = diff.flags.slice(0, max * 2).map(f => `${code(f.key)}: ${code(f.from ?? '∅')} → ${code(f.to ?? '∅')}`);
    segs.push(`### 🚩 Flags changed (${diff.flags.length})\n${lines.join('\n')}`);
  }
  if (on('routes') && diff.routes.length) {
    const lines = diff.routes.map(r => `**${r.key}**` + (r.added.length ? `\n🟢 ${r.added.slice(0, max).map(code).join(' ')}` : '') + (r.removed.length ? `\n🔴 ${r.removed.slice(0, max).map(code).join(' ')}` : ''));
    segs.push(`### 🧭 Routes / lists changed\n${lines.join('\n')}`);
  }
  if (on('config') && diff.config.length) {
    const lines = diff.config.slice(0, max).map(c => c.kind === 'apikey' ? `${code(c.key)}: 🔑 API key rotated`
      : `${code(c.key)}: ${code(fmtCfg(c.from))} → ${code(fmtCfg(c.to))}`);
    segs.push(`### ⚙️ Config changed (${diff.config.length})\n${lines.join('\n')}`);
  }
  if (on('experiments') && diff.newExperiments.length) {
    segs.push(`### 🧪 New experiment IDs (${diff.newExperiments.length})\n*Sampled per request — a few may be bucket noise.*\n${diff.newExperiments.slice(0, max * 2).map(code).join(' ')}${diff.newExperiments.length > max * 2 ? ' …' : ''}`);
  }
  if (on('islands') && (diff.newIslands.length || diff.islandChunks.length)) {
    const lines = [
      ...diff.newIslands.map(i => `🟢 island ${code(i)}`),
      ...diff.islandChunks.map(c => !c.from ? `🟢 page ${code(c.name)} added` : !c.to ? `🔴 page ${code(c.name)} removed` : `🔄 page ${code(c.name)} code updated`),
    ];
    segs.push(`### 🏝️ Islands / pages\n${lines.slice(0, max).join('\n')}`);
  }
  if (on('bundles') && (diff.newBundles.length || diff.removedBundles.length)) {
    const lines = [...diff.newBundles.map(b => `🟢 ${code(b)}${hl.test(b) ? ' 🚩' : ''}`), ...diff.removedBundles.map(b => `🔴 ${code(b)}`)];
    segs.push(`### 📦 String bundles\n${lines.slice(0, max * 2).join('\n')}`);
  }
  if (on('toggles') && diff.toggles?.length) {
    segs.push(`### 🎚️ Feature toggles changed\n*Bitmask words — a flipped bit is a feature gate change.*\n${diff.toggles.map(t => `word ${t.word}: ${code(t.from ?? '∅')} → ${code(t.to ?? '∅')}`).join('\n')}`);
  }
  if (on('docs') && diff.docs) {
    const dd = diff.docs;
    if (dd.newPages.length) segs.push(`### 📚 New doc pages (${dd.newPages.length})\n${dd.newPages.slice(0, max * 2).map(p => `🟢 [${clip(p.title, 70)}](${p.url})`).join('\n')}${dd.newPages.length > max * 2 ? `\n*…and ${dd.newPages.length - max * 2} more*` : ''}`);
    if (dd.removedPages.length) segs.push(`### 📕 Removed doc pages (${dd.removedPages.length})\n${dd.removedPages.slice(0, max).map(p => `🔴 ${clip(p.title, 70)} ${code(p.url.replace(/^https?:\/\/[^/]+/, ''))}`).join('\n')}`);
    for (const pd of dd.pageDiffs) {
      if (pd.isNew && firstRun) continue;
      const lines = [...pd.added.slice(0, max).map(l => `🟢 ${clip(l, 220)}`), ...pd.removed.slice(0, Math.floor(max / 2)).map(l => `🔴 ${clip(l, 220)}`)];
      const extra = pd.added.length + pd.removed.length - lines.length;
      segs.push(`### 📄 ${code(pd.path)} updated\n${lines.join('\n')}${extra > 0 ? `\n*…and ${extra} more lines*` : ''}`);
    }
  }
  if (on('strings')) {
    const comps = Object.entries(diff.strings).sort(([a], [b]) => (hl.test(b) - hl.test(a)) || a.localeCompare(b));
    if (comps.length) segs.push(`### 📝 UI string changes (${comps.length} components)`);
    for (const [comp, s] of comps) {
      const lines = [
        ...s.added.slice(0, max).map(t => `🟢 ${clip(t)}`),
        ...s.changed.slice(0, max).map(c => `🟡 ${clip(c.from, 80)} → ${clip(c.to, 80)}`),
        ...s.removed.slice(0, max).map(t => `🔴 ${clip(t)}`),
      ];
      const extra = s.added.length + s.changed.length + s.removed.length - lines.length;
      segs.push(`**${comp}**${hl.test(comp) ? ' 🚩' : ''}${s.isNew ? ' *(new)*' : ''}\n${lines.join('\n')}${extra > 0 ? `\n*…and ${extra} more*` : ''}`);
    }
  }
  return segs;
}

/** Standalone, attention-grabbing alert for a backend/server build change. */
export function buildVersionAlert(label, diff, curr) {
  const keys = diff.buildKeys.length
    ? '\n' + diff.buildKeys.filter(b => b.from && b.to).map(b => `${b.key}: ${code(b.from)} → ${code(b.to)}`).join('\n')
    : '';
  return buildPayloads([`# 🚀 ${label} — backend version updated\n${code(diff.version.from)}\n⬇️\n${code(diff.version.to)}${keys}\n*Detailed change report follows if anything else moved.*`], 'Gemini Web Watcher')[0];
}

export function buildPayloads(segments, username = 'Gemini Web Watcher') {
  // Hard-split any single oversized segment so Discord never rejects a message.
  const safe = segments.flatMap(s => {
    if (s.length <= TEXT_CHAR_LIMIT) return [s];
    const parts = [];
    let cur = '';
    for (const line of s.split('\n')) {
      if (cur.length + line.length + 1 > TEXT_CHAR_LIMIT) { parts.push(cur); cur = ''; }
      cur += (cur ? '\n' : '') + clip(line, TEXT_CHAR_LIMIT - 10);
    }
    if (cur) parts.push(cur);
    return parts;
  });
  const packed = packMessages(safe, TEXT_CHAR_LIMIT);
  return packed.map((segs, i) => {
    const comps = segs.map(c => ({ type: 10, content: c }));
    if (packed.length > 1) comps[comps.length - 1].content += `\n*— part ${i + 1}/${packed.length} —*`;
    return {
      username,
      avatar_url: LOGO_URL,
      flags: 32768,
      components: [{ type: 17, components: comps.flatMap((c, j) => (j ? [{ type: 14 }, c] : [c])) }],
    };
  });
}

// ---------------------------------------------------------------------- main

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

async function runTarget(t, cfg, webhookUrl, webhookOn) {
  const tag = `[${t.name}]`;
  const tcfg = { ...cfg, ...t, trackers: { ...cfg.trackers, ...t.trackers } };
  const statePath = join(__dirname, '..', tcfg.stateFile);

  let prev = null;
  if (existsSync(statePath)) {
    try { prev = JSON.parse(readFileSync(statePath, 'utf8')); }
    catch (e) { console.error(`${tag} Failed to parse state, starting fresh:`, e.message); }
  }
  const firstRun = !prev?.version;

  console.log(`${tag} Taking ${tcfg.samples} samples of ${tcfg.targetUrl}...`);
  const curr = await takeSnapshot(tcfg, prev ?? {});
  if (!curr.version) throw new Error(`${tag} Server version (${VERSION_KEY}) missing — page format changed?`);
  console.log(`${tag} version ${curr.version} · ${Object.keys(curr.flags).length} flags · ${curr.experiments.length} experiments · ${Object.keys(curr.bundles).length} bundles`);

  const diff = diffSnapshots(firstRun ? EMPTY_SNAPSHOT : prev, curr, { experimentAlertMin: tcfg.experimentAlertMin });
  const label = tcfg.label ?? tcfg.name;

  // 1) Dedicated backend-version alert, sent first and on its own.
  if (!firstRun && diff.version) {
    const alert = buildVersionAlert(label, diff, curr);
    if (webhookOn) { await postPayload(webhookUrl, alert, tcfg.name); await sleep(1500); }
    else console.log(`${tag} VERSION CHANGED ${diff.version.from} -> ${diff.version.to} (no webhook configured)`);
  }

  // 2) Full change report (everything else), or the whole thing as new on first run.
  const segs = (firstRun || diff.hasChanges) ? buildReportSegments(prev, curr, diff, tcfg, { firstRun }) : [];
  // A version-only bump yields just the header segment; the alert already covered it.
  if (segs.length > (firstRun ? 0 : 1)) {
    if (webhookOn) {
      const payloads = buildPayloads(segs);
      console.log(`${tag} Sending ${payloads.length} Discord message(s)...`);
      for (const p of payloads) { await postPayload(webhookUrl, p, tcfg.name); await sleep(1500); }
    } else {
      console.log(`${tag} No webhook configured; report:\n` + segs.join('\n\n'));
    }
  } else {
    console.log(`${tag} No changes detected.`);
  }
  saveState(statePath, curr);
  console.log(`${tag} State saved.`);
}

export async function main() {
  const cfg = JSON.parse(readFileSync(join(__dirname, '../gemini-web-config.json'), 'utf8'));
  const webhookUrl = process.env[cfg.webhook.webhookEnv];
  const webhookOn = cfg.webhook.enabled !== false && !!webhookUrl;
  const targets = cfg.targets ?? [{ name: 'gemini', targetUrl: cfg.targetUrl, stateFile: cfg.stateFile }];

  // One target failing must not stop the others; fail the job at the end.
  const errors = [];
  for (const t of targets) {
    try { await runTarget(t, cfg, webhookUrl, webhookOn); }
    catch (e) { console.error(`[${t.name}] FAILED:`, e); errors.push(t.name); }
  }
  if (errors.length) { console.error(`Targets failed: ${errors.join(', ')}`); process.exit(1); }
}

const isCli = process.argv[1] && /gemini-web-watch\.js$/.test(process.argv[1]);
if (isCli) main().catch(err => { console.error(err); process.exit(1); });
