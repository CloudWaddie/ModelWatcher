import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { saveStateIfChanged } from './state-file.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import https from 'https';
import zlib from 'zlib';
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
  // full/client = main app; glic = the embedded Gemini-in-Chrome surface (namespaced "glic/").
  const re = /https:\/\/www\.gstatic\.com\/bg3\/boq-bard-web\/(full\/client|glic)\/assets\/en\/([A-Za-z0-9_.]+)-messages-([A-Za-z0-9_-]+)\.js/g;
  for (const m of html.matchAll(re)) out[(m[1] === 'glic' ? 'glic/' : '') + m[2]] = { hash: m[3], url: m[0] };
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
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'gzip, deflate, br' },
    }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(httpsGet(new URL(headers.location, url).toString(), redirects - 1));
      }
      if (statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${statusCode}`)); }
      // Some hosts (labs.google) compress even when identity is requested, so always decode.
      const enc = String(headers['content-encoding'] ?? '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
        : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

export async function fetchText(url, retries = 3) {
  let err;
  for (let i = 0; i < retries; i++) {
    try { return await httpsGet(url); }
    catch (e) { err = e; await sleep(1000 * (i + 1)); }
  }
  throw new Error(`fetch ${url} failed: ${err.message}`);
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Take a full snapshot of the live app. `prev` supplies carried-over unions. */
export async function takeSnapshot(cfg, prev = {}) {
  // Static sites (Labs, Flow Music) serve the same page every time: one fetch is enough.
  const n = cfg.mode === 'static' ? 1 : Math.max(1, cfg.samples ?? 6);
  const pages = [];
  for (let i = 0; i < n; i++) {
    pages.push(await fetchText(cfg.targetUrl));
    if (i < n - 1) await sleep(cfg.sampleDelayMs ?? 1500);
  }
  if (cfg.mode === 'static') return takeStaticSnapshot(cfg, prev, pages);
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

  // Toggle bitmasks: individual bits flip per request (A/B buckets). Mask out any bit that
  // ever differs between samples (cumulatively), so only stable gates are compared.
  let toggles = null, togglesNoise;
  const tg = pages.map(parseToggles).filter(Boolean);
  if (tg.length) {
    const hex = (n) => '0x' + (n >>> 0).toString(16);
    const prevNoise = prev.togglesNoise ?? [];
    const noise = tg[0].map((w, i) => {
      let nz = parseInt(prevNoise[i] ?? '0x0', 16) >>> 0;
      for (const t of tg) nz = (nz | (parseInt(t[i] ?? '0x0', 16) ^ parseInt(w, 16))) >>> 0;
      return nz;
    });
    toggles = tg[0].map((w, i) => hex(parseInt(w, 16) & ~noise[i]));
    togglesNoise = noise.map(hex);
  }

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

  let code, codeFiles, codeKeyOut;
  if (cfg.code?.kind === 'bundle') {
    const url = pages.map(p => p.match(/https:\/\/www\.gstatic\.com\/_\/mss\/[^"']+\/m=_b/)?.[0]).find(Boolean);
    if (url && prev.codeKey === url && prev.code) { code = prev.code; }
    else if (url) {
      try { code = extractBundleIds(await fetchText(url)); console.log(`  bundle code: ${Object.entries(code).map(([k, v]) => `${k}=${v.length}`).join(' ')}`); }
      catch (e) { console.error('bundle fetch failed:', e.message); code = prev.code; }
    }
    codeKeyOut = url ?? prev.codeKey;
  } else if (cfg.code && buildKeys.islands) {
    try {
      const base = 'https://www.gstatic.com/bg3/boq-bard-web/islands/assets/';
      const res = await crawlCode(base, buildKeys.islands, prev.codeVersion === CODE_VERSION ? (prev.codeFiles ?? {}) : {}, cfg.code.routePrefixes);
      console.log(`  code crawl: ${Object.keys(res.files).length} chunks (${res.fetched} fetched, ${res.failed} failed)`);
      if (res.failed && res.fetched === 0 && prev.code) { code = prev.code; codeFiles = prev.codeFiles; }
      else {
        code = res.code; codeFiles = res.files;
        code.darkFeatures = darkFeatures(code.enums, strings);
      }
    } catch (e) { console.error('code crawl failed:', e.message); code = prev.code; codeFiles = prev.codeFiles; }
  }
  const docs = cfg.docs ? await snapshotDocs(cfg.docs, prev.docs) : undefined;
  const web = cfg.web ? await snapshotWeb(cfg.web, prev.web) : undefined;

  return {
    timestamp: Date.now(),
    version, buildKeys, flags, config,
    bucketed, bucketedEver, volatile,
    experiments,
    islands: { names: [...islandNames].sort(), chunks },
    bundles, strings,
    ...(toggles ? { toggles, togglesNoise } : {}),
    ...(docs ? { docs } : {}),
    ...(code ? { code, codeVersion: CODE_VERSION, ...(codeFiles ? { codeFiles } : {}), ...(codeKeyOut ? { codeKey: codeKeyOut } : {}) } : {}),
    ...(web ? { web } : {}),
  };
}

// ------------------------------------------------------------- code identifiers

const LIB_CHUNK = /^(katex|react|relay|dist|jsx|compiler|Icon|Button|Text|Pressable|Snackbar)/i;
const DEFAULT_ROUTE_PREFIXES = ['app', 'apps', 'gem', 'gems', 'u', 'share', 'notebook', 'notebooks', 'project', 'projects',
  'library', 'labs', 'usage', 'settings', 'canvas', 'live', 'scheduled-tasks', 'activity', 'extensions', 'mystuff', 'your-day',
  'shopping', 'avatar', 'public-links', 'gemini-spark', 'saved', 'search', 'agent', 'agents', 'skills', 'memory', 'discover'];
export const emptyCode = () => ({ components: [], nodeTypes: [], enums: [], ops: [], routes: [], hosts: [], banners: [], gqlTypes: [], gqlFields: [], gqlOps: [], clientFlags: [], links: [], featureModeIds: [] });

/** Pull trackable identifiers out of one minified chunk. */
const LINK_HOSTS = /^(support\.google\.com|labs\.google(\.com)?|g\.co|goo\.gle|one\.google\.com|miro\.com|ai\.google\.dev|deepmind\.google|blog\.google|[a-z0-9-]+\.withgoogle\.com|store\.google\.com|chromewebstore\.google\.com|workspace\.google\.com|cloud\.google\.com|gemini\.google(\.com)?|myaccount\.google\.com|policies\.google\.com|github\.com|colab\.research\.google\.com|notebooklm\.google(\.com)?|jules\.google|opal\.google)$/;
const ASSET_EXT = /\.(png|webp|svg|jpe?g|gif|mp4|webm|woff2?|css|js|ico)(\?|$)/i;
/** Normalise an outbound link: allow-listed product/help hosts only, tracking params dropped. */
export function normalizeLink(u) {
  u = u.replace(/[.,);'"`]+$/, '');
  const m = u.match(/^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/);
  if (!m || !LINK_HOSTS.test(m[1]) || ASSET_EXT.test(m[2])) return null;
  const q = (m[3] ?? '').replace(/^\?/, '').split('&').filter(x => x && !/^(utm_|hl=|lfhs|source=|authuser=)/.test(x));
  return m[1] + m[2].replace(/\/$/, '') + (q.length ? '?' + q.join('&') : '');
}

export function extractCodeIds(text, routePrefixes = DEFAULT_ROUTE_PREFIXES, stem = '') {
  const uniq = (a) => [...new Set(a)].sort();
  const routeRe = new RegExp('["`\'](/(?:' + routePrefixes.map(x => x.replace(/[-/]/g, '\\$&')).join('|') + ')[a-zA-Z0-9_/\\-:{}$.]*)["`\']', 'g');
  return {
    // Backend schema as compiled into Relay artifacts: types the UI can render, their fields,
    // and persisted-query ids (an id change for the same operation = that query changed).
    gqlTypes: uniq([...text.matchAll(/concreteType:`([^`]+)`/g)].map(m => m[1])),
    gqlFields: /normalization\.graphql|SplitOperation|ReaderFragment|ConcreteRequest/.test(stem + text.slice(0, 4000))
      ? uniq([...text.matchAll(/kind:`(?:ScalarField|LinkedField)`,name:`([^`]+)`/g)].map(m => m[1]).filter(f => !/^__/.test(f)).map(f => `${stem.replace(/\.graphql$/, '').replace(/_normalization$/, '')}.${f}`))
      : [],
    gqlOps: uniq([...text.matchAll(/params:\{id:`([^`]+)`[\s\S]*?name:`([^`]+)`/g)].map(m => `${m[2]}#${m[1].replace(/^\d+\//, '').slice(0, 10)}`)),
    // Server flags the client actually reads, by owning module: a new id = a newly gated feature.
    clientFlags: uniq([...text.matchAll(/get(Boolean|String|Int|Number|Double|Long|Float)Value\(`(\d{6,})`/g)].map(m => `${stem || 'chunk'}:${m[2]}:${m[1][0].toLowerCase()}`)),
    // Help-center topics (support.google.com/gemini?p=lm_agent_browser_data...), Labs products and
    // partner integrations the UI links to: help pages exist before the feature does.
    links: uniq([...text.matchAll(/https?:\/\/[a-zA-Z0-9./_#?=&%:+~-]{6,200}/g)].map(m => normalizeLink(m[0])).filter(Boolean)),
    // Numeric ids of tool modes (VESPER=35, REMY=40...): a new mode or a re-numbering shows up here.
    featureModeIds: uniq([...text.matchAll(/\b(FEATURE_MODE_[A-Z0-9_]+):(\d{1,4})\b/g)].map(m => `${m[1]}=${m[2]}`)),
    enums: uniq((text.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g) ?? []).filter(e => e.length >= 14)),
    ops: uniq(text.match(/\b[A-Z][A-Za-z0-9]{6,}(?:Query|Mutation|Subscription)\b/g) ?? []),
    routes: uniq([...text.matchAll(routeRe)].map(m => m[1]).filter(r => !r.includes('${'))),
    hosts: uniq([...text.matchAll(/["`']((?:[a-z0-9-]+\.)+(?:corp\.google\.com|google\.com|googleapis\.com|goog|withgoogle\.com|googleusercontent\.com|sandbox\.google\.com))["`'\/]/g)].map(m => m[1])),
    // lowercase snake/kebab ids only (UPPER_SNAKE are already in enums, Camel_x are relay fragments)
    banners: uniq([...text.matchAll(/["`']([a-z0-9]+(?:[_-][a-z0-9]+)+)["`']/g)].map(m => m[1])
      .filter(v => v.length <= 70 && /(banner|upsell|promo|announce|nudge|coachmark|whats_?new|spotlight|waitlist)/.test(v))),
  };
}

/**
 * "Dark" features: feature-mode / capability codenames that exist in the code (FEATURE_MODE_BLUEDOG,
 * CAN_ENROLL_IN_AUREUS...) but whose name appears in no user-facing string — i.e. gated or
 * unreleased. Released features (deep research, image generation...) have UI text and drop out.
 */
export function darkFeatures(enums, strings) {
  const text = Object.values(strings).flatMap(c => Object.values(c)).join('\n').toLowerCase();
  const GENERIC = new Set(['in', 'to', 'the', 'tool', 'menu', 'upsell', 'logo', 'quota', 'subscription', 'tier', 'tier1', 'tier2', 'free', 'premium', 'ui', 'by', 'default', 'mode', 'unspecified', 'for', 'of', 'a', 'and']);
  const out = new Set();
  for (const e of enums) {
    let m = e.match(/^FEATURE_MODE_([A-Z0-9_]+)$/);
    const words = m ? m[1].split('_') : (e.match(/^CAN_(?:ENROLL_IN|SEE|USE|ACCESS)_([A-Z0-9_]+?)(?:_IN_TOOL_MENU|_QUOTA|_LOGO|_UPSELL|_SUBSCRIPTION)?$/)?.[1].split('_') ?? null);
    if (!words) continue;
    const key = words.filter(w => !GENERIC.has(w.toLowerCase())).map(w => w.toLowerCase());
    if (!key.length || key.join('').length < 4) continue;
    const phrase = key.join(' ');
    if (!text.includes(phrase) && !key.every(w => text.includes(w))) out.add(`${e} → "${phrase}"`);
  }
  return [...out].sort();
}

export const CODE_VERSION = 4; // bump when extraction regexes change: invalidates cached per-chunk extraction

/** Extract identifiers from AI Studio's single large MakerSuite bundle (Angular + protobuf RPC). */
export function extractBundleIds(text) {
  const uniq = (a) => [...new Set(a)].sort();
  const short = (full) => full.replace(/^google\.internal\.alkali\.applications\.makersuite\.v1\./, '');
  const rpcMethods = uniq([...text.matchAll(/google\.internal\.alkali\.[A-Za-z0-9.]+?\.([A-Za-z0-9]+Service)\/([A-Za-z0-9]+)/g)].map(m => `${m[1]}/${m[2]}`));
  const services = uniq([...text.matchAll(/google\.internal\.alkali\.[A-Za-z0-9.]+/g)].map(m => short(m[0])).filter(x => /Service$|Details$/.test(x)));
  const routes = uniq([...text.matchAll(/path:\s*"([A-Za-z0-9_\/:\-.*]{2,60})"/g)].map(m => m[1]));
  const modelIds = uniq([...text.matchAll(/["']((?:models\/)?(?:gemini|veo|imagen|lyria|gemma|nano-banana|learnlm|deep-research|antigravity|gemini-robotics|omni)[a-z0-9._-]{2,50})["']/gi)].map(m => m[1]));
  const KW = /\b(introducing|now available|coming soon|preview|beta|experimental|deprecat\w*|shut ?down|sunset|will be (?:removed|retired|discontinued)|waitlist|early access|rolling out|upgrade to|free tier|limited time|announc\w+)\b/i;
  const notes = uniq([...text.matchAll(/"((?:[^"\\\n]|\\.){28,260})"/g)].map(m => m[1])
    .filter(x => x.split(' ').length > 4 && /^[A-Za-z0-9 ,.'’:;!?()\/&%-]+$/.test(x) && KW.test(x)));
  return { rpcMethods, services, routes, modelIds, notes };
}

const chunkStem = (file) => file.replace(/-[A-Za-z0-9_-]{6,12}\.js$/, '');

/**
 * Crawl the island chunk import graph from the islands entry file. Extraction
 * is cached per content-hashed filename, so unchanged chunks are never refetched.
 */
export async function crawlCode(base, entryFile, prevFiles = {}, routePrefixes) {
  const refs = (t) => new Set([...t.matchAll(/from"\.\/([^"]+\.js)"|import\(`\.\/([^`]+\.js)`\)|import"\.\/([^"]+\.js)"/g)].map(m => m[1] || m[2] || m[3]));
  const files = {};
  const seen = new Set([entryFile]);
  let frontier = [entryFile];
  let fetched = 0, failed = 0;
  while (frontier.length) {
    const next = new Set();
    await mapLimit(frontier, 16, async (f) => {
      let ids = prevFiles[f];
      let text = null;
      if (!ids || !ids.refs) {
        try { text = await fetchText(base + f); fetched++; } catch { failed++; return; }
        ids = { ...(LIB_CHUNK.test(f) ? emptyCode() : extractCodeIds(text, routePrefixes, chunkStem(f))), refs: [...refs(text)].sort() };
        delete ids.components;
      }
      files[f] = ids;
    });
    for (const f of frontier) for (const r of files[f]?.refs ?? []) if (!seen.has(r)) { seen.add(r); next.add(r); }
    frontier = [...next];
  }
  const agg = emptyCode();
  const stems = [...new Set(Object.keys(files).map(chunkStem))];
  // Relay artifacts: "XNodeView_card_normalization.graphql" names a server-driven response node type.
  agg.nodeTypes = [...new Set(stems.map(x => x.match(/^[A-Za-z0-9]+_([A-Za-z0-9]+)_normalization\.graphql$/)?.[1]).filter(Boolean))].sort();
  agg.components = stems.filter(x => !/\.graphql$|_parameters$/.test(x)).sort();
  for (const k of Object.keys(agg)) if (k !== 'components' && k !== 'nodeTypes') agg[k] = [...new Set(Object.values(files).flatMap(f => f[k] ?? []))].sort();
  return { code: agg, files, fetched, failed };
}

// ------------------------------------------------------------- static sites (Labs)

const stripTags = (x) => x.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

/** Experiment cards on labs.google: hero carousel, experiment carousel and "graduated" cards. */
export function parseLabsCards(rawHtml) {
  const html = rawHtml.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '');
  const cards = {};
  const put = (kind, name, desc, cta, href) => { name = stripTags(name ?? ''); if (name) cards[`${kind}:${name}`] = { desc: stripTags(desc ?? ''), cta: stripTags(cta ?? ''), href: href ?? '' }; };
  for (const m of html.matchAll(/carousel-card__content__title[^>]*>([^<]+)<\/h2>\s*<h3[^>]*carousel-card__content__subtitle[^>]*>([^<]+)<\/h3>\s*<a[^>]*carousel-card__cta[^>]*href="([^"]*)"[^>]*>\s*<span[^>]*carousel-card__cta__label[^>]*>([^<]+)/g)) put('experiment', m[1], m[2], m[4], m[3]);
  for (const m of html.matchAll(/featured-hero__heading[^>]*>([^<]+)<\/h2>\s*<small[^>]*featured-hero__subheading[^>]*>([^<]*)<\/small>\s*<a[^>]*featured-hero__cta[^>]*href="([^"]*)"[^>]*>\s*<span[^>]*>([^<]+)/g)) put('featured', m[1], m[2], m[4], m[3]);
  for (const m of html.matchAll(/graduation-card__headline[^>]*>([^<]+)<\/h3>\s*<p[^>]*graduation-card__description[^>]*>\s*<span[^>]*>([^<]*)<\/span>\s*<\/p>\s*<a[^>]*graduation-card__cta[^>]*href="([^"]*)"/g)) put('graduated', m[1], m[2], '', m[3]);
  return cards;
}

/** Next.js build info: buildId, route table (from _buildManifest) and the en i18n store. */
export function parseNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]);
    const store = d.props?.pageProps?._nextI18Next?.initialI18nStore?.en ?? {};
    const strings = {};
    const flat = (o, pre, out) => { for (const [k, v] of Object.entries(o ?? {})) { if (v && typeof v === 'object') flat(v, pre + k + '.', out); else out[pre + k] = String(v); } };
    for (const [ns, tree] of Object.entries(store)) { strings[ns] = {}; flat(tree, '', strings[ns]); }
    return { buildId: d.buildId ?? null, strings };
  } catch { return null; }
}

export function parseNextRoutes(manifestJs) {
  return [...new Set([...manifestJs.matchAll(/"(\/[A-Za-z0-9_\-/\[\]\.\.]*)":\[/g)].map(m => m[1]))].filter(r => !/^\/(_|404|sitemap)/.test(r)).sort();
}

// ---------------------------------------------------------------- web content

/** Footnote superscripts arrive glued to words ("Genie7", "limits2") and their numbering shuffles per request. */
export const stripFootnotes = (l) => l.replace(/([a-z]{3,})\d{1,2}(?=$|[\s,.;:)])/g, '$1');

export function htmlToLines(html) {
  const t = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/g, '')
    .replace(/<\/?(?:br|p|li|h[1-6]|tr|div|td|th|section|article|header|footer)[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '');
  const decode = (x) => x.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  // Drop volatile page furniture: bare numeric session ids, language-picker blobs, long tracking tokens.
  const NOISE = /^\d{10,}$|^Language\s.*(?:&lrm;|Afrikaans)|^[A-Za-z0-9_-]{32,}$/;
  return t.split('\n').map(l => decode(l).replace(/&[lr]rm;|[\s\u200e\u200f]+/g, ' ').trim()).filter(l => l && !NOISE.test(l));
}

/** Normalise sitemap URLs: drop query, optional country prefix (/xx/...), optional exclude pattern. */
export function normalizeSitemapUrl(u, opts = {}) {
  let url; try { url = new URL(u); } catch { return null; }
  let path = url.pathname;
  if (opts.stripCountry) path = path.replace(/^\/[a-z]{2}(?=\/)/, '');
  if (opts.exclude && new RegExp(opts.exclude).test(path)) return null;
  return url.origin + path;
}

async function fetchSitemap(url, depth = 0) {
  const xml = await fetchText(url);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  if (/<sitemapindex/.test(xml) && depth < 2) {
    const kids = await mapLimit(locs, 4, async (u) => { try { return await fetchSitemap(u, depth + 1); } catch { return []; } });
    return kids.flat();
  }
  return locs;
}

/**
 * Snapshot arbitrary public web pages (line-diffed after an optional start marker)
 * and sitemaps (normalised URL sets). Used for release notes, limits, pricing.
 */
export async function snapshotWeb(web, prev = {}) {
  const pages = {}, sitemaps = {};
  await mapLimit(web.pages ?? [], 4, async (pg) => {
    try {
      let lines = htmlToLines(await fetchText(pg.url)).map(stripFootnotes);
      if (pg.start) {
        const re = new RegExp(pg.start); const i = lines.findIndex(l => re.test(l));
        // keepHead: retain the first N lines (page title / promo banner) ahead of the cut.
        if (i >= 0) lines = [...lines.slice(0, Math.min(pg.keepHead ?? 0, i)), ...lines.slice(i)];
      }
      if (pg.end) { const re = new RegExp(pg.end); const i = lines.findIndex(l => re.test(l)); if (i > 0) lines = lines.slice(0, i); }
      pages[pg.id] = lines;
    } catch (e) { console.error(`web page ${pg.id} failed:`, e.message); if (prev.pages?.[pg.id]) pages[pg.id] = prev.pages[pg.id]; }
  });
  await mapLimit(web.sitemaps ?? [], 2, async (sm) => {
    try {
      const urls = (await fetchSitemap(sm.url)).map(u => normalizeSitemapUrl(u, sm)).filter(Boolean);
      sitemaps[sm.id] = [...new Set(urls)].sort();
    } catch (e) { console.error(`sitemap ${sm.id} failed:`, e.message); if (prev.sitemaps?.[sm.id]) sitemaps[sm.id] = prev.sitemaps[sm.id]; }
  });
  // Pages discovered from a sitemap, keeping only lines that match a pattern. Used for
  // "roadmap language" ("rolling out", "coming months", "beta"...) across marketing pages.
  for (const sp of web.sitemapPages ?? []) {
    const inc = sp.include ? new RegExp(sp.include) : null, exc = sp.exclude ? new RegExp(sp.exclude) : null, keep = new RegExp(sp.keep, 'i');
    const urls = (sitemaps[sp.sitemap] ?? []).filter(u => { const path = new URL(u).pathname; return (!inc || inc.test(path)) && !(exc && exc.test(path)); });
    await mapLimit(urls, 5, async (u) => {
      const id = `${sp.idPrefix ?? 'fwd:'}${new URL(u).pathname}`;
      try {
        const lines = htmlToLines(await fetchText(u)).map(stripFootnotes).filter(l => l.length >= 20 && l.length <= 400 && keep.test(l));
        pages[id] = [...new Set(lines)];
      } catch (e) { console.error(`sitemap page ${id} failed:`, e.message); if (prev.pages?.[id]) pages[id] = prev.pages[id]; }
    });
  }
  return { pages, sitemaps };
}

/** Snapshot for sites without WIZ data (Labs home = Angular SSR, /fx and Flow Music = Next.js). */
async function takeStaticSnapshot(cfg, prev, pages) {
  const html = pages[0];
  const next = parseNextData(html);
  const versionRe = cfg.versionRegex ? new RegExp(cfg.versionRegex) : null;
  const version = (versionRe && html.match(versionRe)?.[1]) || next?.buildId || null;

  let routes = prev.code?.routes ?? [];
  const base = new URL(cfg.targetUrl).origin;
  if (next?.buildId && cfg.nextBase !== undefined) {
    try { routes = parseNextRoutes(await fetchText(`${base}${cfg.nextBase}/_next/static/${next.buildId}/_buildManifest.js`)); }
    catch (e) { console.error('route manifest failed:', e.message); }
  }
  const strings = next?.strings && Object.keys(next.strings).length ? next.strings : (prev.strings ?? {});
  const cards = cfg.cards ? parseLabsCards(html) : undefined;
  const ngVersion = html.match(/ng-version="([^"]+)"/)?.[1];
  const web = cfg.web ? await snapshotWeb(cfg.web, prev.web) : undefined;
  return {
    timestamp: Date.now(), version, buildKeys: { js: ngVersion ? `angular ${ngVersion}` : null },
    flags: {}, config: {}, bucketed: [], volatile: [], experiments: [],
    islands: { names: [], chunks: {} }, bundles: {}, strings,
    code: { ...emptyCode(), routes }, codeVersion: CODE_VERSION,
    ...(cards ? { cards } : {}), ...(web ? { web } : {}),
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

export const EMPTY_SNAPSHOT = { version: null, buildKeys: {}, flags: {}, config: {}, toggles: [], code: emptyCode(), experiments: [], islands: { names: [], chunks: {} }, bundles: {}, strings: {} };

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
    const mk = (v, i) => (v == null ? null : '0x' + ((parseInt(v, 16) & ~parseInt(curr.togglesNoise?.[i] ?? '0x0', 16)) >>> 0).toString(16));
    for (let i = 0; i < idx; i++) if (mk(a[i], i) !== mk(curr.toggles[i], i)) changed.push({ word: i, from: mk(a[i], i), to: mk(curr.toggles[i], i) });
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

  d.code = null;
  if (curr.code) {
    const pc = prev.code ?? emptyCode();
    const out = {};
    for (const k of new Set([...Object.keys(pc), ...Object.keys(curr.code)])) {
      const before = new Set(pc[k] ?? []), after = new Set(curr.code[k] ?? []);
      const added = [...after].filter(x => !before.has(x)), removed = [...before].filter(x => !after.has(x));
      if (added.length || removed.length) out[k] = { added, removed };
    }
    if (Object.keys(out).length) d.code = out;
  }

  d.cards = null;
  if (curr.cards) {
    const pc = prev.cards ?? {};
    const added = [], removed = [], changed = [];
    for (const [k, v] of Object.entries(curr.cards)) {
      if (!(k in pc)) added.push({ key: k, ...v });
      else if (pc[k].cta !== v.cta || pc[k].desc !== v.desc || pc[k].href !== v.href) changed.push({ key: k, from: pc[k], to: v });
    }
    for (const k of Object.keys(pc)) if (!(k in curr.cards)) removed.push({ key: k, ...pc[k] });
    if (added.length || removed.length || changed.length) d.cards = { added, removed, changed };
  }

  d.web = null;
  if (curr.web) {
    const pagesD = [];
    for (const [id, lines] of Object.entries(curr.web.pages)) {
      const had = prev.web?.pages && id in prev.web.pages;
      const before = new Set(prev.web?.pages?.[id] ?? []), after = new Set(lines);
      const added = lines.filter(l => !before.has(l)), removed = [...before].filter(l => !after.has(l));
      if (added.length || removed.length) pagesD.push({ id, added, removed, isNew: !had });
    }
    const maps = [];
    for (const [id, urls] of Object.entries(curr.web.sitemaps)) {
      const before = new Set(prev.web?.sitemaps?.[id] ?? []), after = new Set(urls);
      const added = urls.filter(u => !before.has(u)), removed = [...before].filter(u => !after.has(u));
      if (added.length || removed.length) maps.push({ id, added, removed, isNew: !(prev.web?.sitemaps && id in prev.web.sitemaps) });
    }
    if (pagesD.length || maps.length) d.web = { pages: pagesD, sitemaps: maps };
  }

  d.hasChanges = !!(d.toggles || d.docs || d.code || d.web || d.cards || d.version || d.buildKeys.length || d.flags.length || d.config.length || d.routes.length
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
    segs.push(`# 🌐 ${label}\n${code(curr.version)}${diff.version ? (isBackendVersion(curr.version) ? ' *(new backend build — see alert above)*' : ' *(frontend build changed)*') : ' (unchanged)'}`);
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
  if (on('experiments') && diff.newExperiments.length >= (cfg.experimentAlertMin ?? 150)) {
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
  if (on('cards') && diff.cards) {
    const c = diff.cards;
    const nm = (k) => k.replace(/^[a-z]+:/, '');
    const kindIcon = (k) => ({ experiment: '🧪', featured: '⭐', graduated: '🎓' }[k.split(':')[0]] ?? '•');
    const lines = [
      ...c.added.map(x => `🟢 ${kindIcon(x.key)} **${nm(x.key)}** — ${clip(x.desc, 160)} ${x.cta ? `[${x.cta}]` : ''} ${x.href ? code(x.href) : ''}`),
      ...c.changed.map(x => `🟡 **${nm(x.key)}**: ${x.from.cta !== x.to.cta ? `CTA ${code(x.from.cta || '∅')} → ${code(x.to.cta || '∅')}` : ''}${x.from.href !== x.to.href ? ` link ${code(x.from.href)} → ${code(x.to.href)}` : ''}${x.from.desc !== x.to.desc ? ` desc: ${clip(x.to.desc, 140)}` : ''}`),
      ...c.removed.map(x => `🔴 ${kindIcon(x.key)} **${nm(x.key)}**`),
    ];
    segs.push(`### 🧪 Labs experiments (${c.added.length} new · ${c.changed.length} changed · ${c.removed.length} removed)\n${lines.slice(0, max * 2).join('\n')}`);
  }
  if (on('web') && diff.web) {
    const labels = Object.fromEntries((cfg.web?.pages ?? []).map(p => [p.id, p.label ?? p.id]));
    for (const pg of diff.web.pages) {
      // Pages list newest-first (release notes), so the head of "added" is the freshest content.
      const cap = pg.isNew ? Math.min(max * 2, 40) : max * 2;
      const lines = [...pg.added.slice(0, cap).map(l => `🟢 ${clip(l, 300)}`), ...(pg.isNew ? [] : pg.removed.slice(0, Math.floor(max / 2)).map(l => `🔴 ${clip(l, 200)}`))];
      const extra = pg.added.length + (pg.isNew ? 0 : pg.removed.length) - lines.length;
      segs.push(`### ${pg.id.startsWith('fwd:') ? `🔭 Roadmap language · ${code(pg.id.slice(4))}` : `📰 ${labels[pg.id] ?? pg.id}`}${pg.isNew ? ' — current statements' : ' updated'}\n${lines.join('\n')}${extra > 0 ? `\n*…and ${extra} more lines*` : ''}`);
    }
    for (const sm of diff.web.sitemaps) {
      const lines = [...sm.added.slice(0, max).map(u => `🟢 ${u}`), ...(sm.isNew ? [] : sm.removed.slice(0, max).map(u => `🔴 ${u}`))];
      const extra = sm.added.length + (sm.isNew ? 0 : sm.removed.length) - lines.length;
      segs.push(`### 🗺️ Sitemap ${code(sm.id)} (+${sm.added.length}${sm.isNew ? '' : ` −${sm.removed.length}`})\n${lines.join('\n')}${extra > 0 ? `\n*…and ${extra} more*` : ''}`);
    }
  }
  if (on('code') && diff.code) {
    const HOT = /^(CAN_|IS_|HAS_|FEATURE_MODE_|MODE_CATEGORY_|MODE_PICKER|USER_SUBSCRIPTION|ENABLE_|CLIENT_CONVERSATION_TYPE|CLIENT_CHANNEL|.*(?:TIER|QUOTA|UPSELL|CODENAME).*)/;
    const names = { links: '🔗 Outbound links (help topics / Labs products / partners)', featureModeIds: '🎛️ Tool-mode IDs', darkFeatures: '🕶️ Dark features (in code, no UI text yet)', clientFlags: '🚩 Client feature-flag reads (gated features)', gqlTypes: '🧬 GraphQL types (backend schema)', gqlFields: '🧩 GraphQL fields', gqlOps: '🔌 GraphQL queries changed (persisted id)', rpcMethods: '🔌 RPC methods', services: '🧰 Backend services', modelIds: '🤖 Model IDs', notes: '💬 Announcement-like strings', components: '🧩 Components', nodeTypes: '🧱 Response node types (server-driven UI)', enums: '🏷️ Feature / capability identifiers', ops: '🔌 GraphQL operations', routes: '🛣️ Routes', hosts: '🌍 Hosts', banners: '📢 Banner / upsell IDs' };
    segs.push(`### 🧬 Code changes (island chunks)`);
    for (const k of Object.keys(diff.code)) {
      const title = names[k] ?? k;
      const c = diff.code[k]; if (!c) continue;
      let added = c.added;
      let note = '';
      // A class we've never tracked before arrives as one huge "new" batch: show a sample + the count.
      const seedClass = !(k in (prev?.code ?? {})) || ((prev?.code?.[k] ?? []).length === 0 && c.added.length > max * 4);
      if (seedClass && !firstRun && added.length > 20) { note = `\n*first sighting of this tracker — ${added.length - 20} more not listed*`; added = added.slice(0, 20); }
      if (k === 'enums') {
        // Seed / big batches: lead with the gating & tier identifiers, summarise the rest.
        const hot = added.filter(e => HOT.test(e)), rest = added.filter(e => !HOT.test(e));
        added = (firstRun || rest.length > max * 2) ? hot : added;
        if (added.length < c.added.length) note = `\n*+${c.added.length - added.length} other identifiers not listed*`;
      }
      const lines = [
        ...added.slice(0, max * 2).map(x => `🟢 ${code(x)}`),
        ...(firstRun ? [] : c.removed.slice(0, max).map(x => `🔴 ${code(x)}`)),
      ];
      const more = added.length + (firstRun ? 0 : c.removed.length) - lines.length;
      if (!lines.length && !note) continue;
      segs.push(`**${title}** (+${c.added.length}${firstRun ? '' : ` −${c.removed.length}`})\n${lines.join('\n')}${more > 0 ? `\n*…and ${more} more*` : ''}${note}`);
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
/** True for real server build labels (boq_<app>_<date>.<n>_p<n>); frontend hashes/buildIds are not backend versions. */
export const isBackendVersion = (v) => typeof v === 'string' && /^boq_/.test(v);

export function buildVersionAlert(label, diff, curr) {
  const keys = diff.buildKeys.length
    ? '\n' + diff.buildKeys.filter(b => b.from && b.to).map(b => `${b.key}: ${code(b.from)} → ${code(b.to)}`).join('\n')
    : '';
  return buildPayloads([`# 🚀 ${label} — backend version updated\n${code(diff.version.from)}\n⬇️\n${code(diff.version.to)}${keys}`], 'Gemini Web Watcher')[0];
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
  saveStateIfChanged(path, state);
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

  console.log(`${tag} Fetching ${tcfg.targetUrl} (${tcfg.mode === 'static' ? 1 : tcfg.samples} sample${tcfg.mode === 'static' ? '' : 's'})...`);
  const curr = await takeSnapshot(tcfg, prev ?? {});
  if (!curr.version) throw new Error(`${tag} Server version (${VERSION_KEY}) missing — page format changed?`);
  const nStrings = Object.values(curr.strings).reduce((n, c) => n + Object.keys(c).length, 0);
  const facts = tcfg.mode === 'static'
    ? [curr.cards && `${Object.keys(curr.cards).length} cards`, curr.code?.routes?.length && `${curr.code.routes.length} routes`, nStrings && `${nStrings} strings`]
    : [`${Object.keys(curr.bundles).length} string bundles`, curr.code && `${curr.code.components?.length ?? 0} components`, curr.toggles && `${curr.toggles.length} toggle words`, curr.web && `${Object.keys(curr.web.pages).length} pages`];
  console.log(`${tag} ${curr.version} · ${facts.filter(Boolean).join(' · ')}`);

  const diff = diffSnapshots(firstRun ? EMPTY_SNAPSHOT : prev, curr, { experimentAlertMin: tcfg.experimentAlertMin });
  const label = tcfg.label ?? tcfg.name;

  // 1) Dedicated backend-version alert, sent first and on its own.
  if (!firstRun && diff.version && isBackendVersion(diff.version.to)) {
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
