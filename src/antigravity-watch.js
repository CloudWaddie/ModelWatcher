import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fetchText, snapshotWeb, parseLlmsIndex, buildPayloads } from './gemini-web-watch.js';
import { postPayload } from './gemini-watch.js';

/**
 * Google Antigravity tracker: CLI (agy), desktop app ("hub"), IDE, VS Code extension, docs and blog.
 *
 * Versions come from public release endpoints (the CLI's manifest API, the download page's
 * storage URLs, the VS Code Marketplace API). When a build changes, the new artifact is
 * downloaded and *statically* scanned (never executed) for pre-release signals: internal model
 * codenames (MODEL_* enums), model ids, JETSKI_/ANTIGRAVITY_ env flags and protobuf packages.
 * Public docs never name these, but the shipped binaries do.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
const uniqSorted = (a) => [...new Set(a)].sort();

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ------------------------------------------------------------------ versions

export function parseDownloadPage(html) {
  const hub = html.match(/antigravity-public\/antigravity-hub\/([0-9][0-9.]*)-(\d+)\//);
  const ide = html.match(/antigravity\/stable\/([0-9][0-9.]*)-(\d+)\//);
  return { hub: hub ? { version: hub[1], build: hub[2] } : null, ide: ide ? { version: ide[1], build: ide[2] } : null };
}

async function snapshotVersions(cfg, prev = {}) {
  const v = { cli: {}, hub: null, ide: null, vscode: null };
  await Promise.all(cfg.cli.platforms.map(async (plat) => {
    try {
      const m = await getJson(`${cfg.cli.manifestBase}/manifests/${plat}.json`);
      v.cli[plat] = { version: m.version, sha512: m.sha512, url: m.url };
    } catch (e) { console.error(`cli manifest ${plat} failed:`, e.message); if (prev.cli?.[plat]) v.cli[plat] = prev.cli[plat]; }
  }));
  try { Object.assign(v, parseDownloadPage(await fetchText(cfg.downloadPage))); }
  catch (e) { console.error('download page failed:', e.message); v.hub = prev.hub ?? null; v.ide = prev.ide ?? null; }
  v.hub ??= prev.hub ?? null; v.ide ??= prev.ide ?? null;
  try {
    const q = await getJson('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=7.1-preview.1' },
      body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: cfg.vscode.itemName }] }], flags: 103 }),
    });
    const ext = q.results?.[0]?.extensions?.[0];
    const latest = ext?.versions?.[0];
    if (latest) v.vscode = { version: latest.version, lastUpdated: latest.lastUpdated, recent: ext.versions.slice(0, 8).map(x => x.version) };
  } catch (e) { console.error('marketplace failed:', e.message); v.vscode = prev.vscode ?? null; }
  return v;
}

// -------------------------------------------------------------- static analysis

/** Pull pre-release signals out of a (Go) binary or bundled JS, statically. */
export function extractBinarySignals(text) {
  const all = (re) => [...text.matchAll(re)].map(m => m[0]);
  const modelEnums = uniqSorted(all(/\bMODEL_[A-Z0-9_]{4,70}\b/g).filter(e => !/PLACEHOLDER_M\d+|\d{4,}/.test(e)));
  const placeholders = new Set(all(/\bMODEL_PLACEHOLDER_M\d+\b/g)).size;
  const modelIds = uniqSorted([
    ...all(/\bgemini-\d+(?:\.\d+)?-(?:pro|flash-lite|flash|ultra|nano|embedding)(?:-(?:low|high|medium|preview|lite|image|live|thinking|exp))*/g),
    ...all(/\bclaude-(?:opus|sonnet|haiku)-\d+(?:-\d+)?/g),
    ...all(/\bnano-banana-\d+(?:\.\d+)?(?:-(?:pro|lite|flash))?/g),
    ...all(/\bgpt-oss-\d+b(?:-maas)?/g),
    ...all(/gemini_api_[a-z0-9_]*(?:rev\d+|v\d[a-z0-9]*)[a-z0-9_]*/g),   // no \b: Go packs it onto the preceding string
    ...all(/\bgemini-v\d[a-z0-9]*-[a-z0-9]+(?:-[a-z0-9]+)?/g),
  ]);
  const env = uniqSorted(all(/\b(?:JETSKI|ANTIGRAVITY)_[A-Z0-9_]{3,80}/g).flatMap(v => v.split(/(?=(?:JETSKI|ANTIGRAVITY)_)/)).filter(v => v.length > 8));
  const protos = uniqSorted(all(/\bgemini_coder\.[A-Z][A-Za-z0-9_]{2,60}/g));
  const providers = uniqSorted(all(/\b(?:gemini-api|blade|evergreen):(?:\/\/)?/g));
  return { modelEnums, modelIds, env, protos, providers, _placeholders: placeholders };
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function analyzeCli(entry) {
  const buf = await download(entry.url);
  const sha = createHash('sha512').update(buf).digest('hex');
  if (entry.sha512 && sha !== entry.sha512) throw new Error('CLI checksum mismatch — refusing to analyze');
  return withTemp((dir) => {
    writeFileSync(join(dir, 'cli.tar.gz'), buf);
    execFileSync('tar', ['-xzf', join(dir, 'cli.tar.gz'), '-C', dir, '--no-same-owner'], { stdio: 'ignore' });
    const bin = readFileSync(join(dir, 'antigravity'));          // read, never execute
    const sig = extractBinarySignals(bin.toString('latin1'));
    return { ...sig, bytes: bin.length };
  });
}

async function analyzeVsix(version, cfg) {
  const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${cfg.itemName.split('.')[0]}/vsextensions/${cfg.itemName.split('.')[1]}/${version}/vspackage`;
  const buf = await download(url);
  return withTemp((dir) => {
    writeFileSync(join(dir, 'x.vsix'), buf);
    execFileSync('unzip', ['-q', '-o', join(dir, 'x.vsix'), 'extension/package.json', 'extension/extension.js', 'extension/CHANGELOG.md', '-d', dir], { stdio: 'ignore' });
    const pkg = JSON.parse(readFileSync(join(dir, 'extension', 'package.json'), 'utf8'));
    const js = readFileSync(join(dir, 'extension', 'extension.js'), 'utf8');
    const sig = extractBinarySignals(js);
    const commands = uniqSorted((pkg.contributes?.commands ?? []).map(c => c.command));
    const settings = uniqSorted(Object.keys(pkg.contributes?.configuration?.properties ?? {}));
    const changelog = existsSync(join(dir, 'extension', 'CHANGELOG.md')) ? readFileSync(join(dir, 'extension', 'CHANGELOG.md'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean) : [];
    return { env: sig.env, commands, settings, changelog };
  });
}

// ------------------------------------------------------------------- snapshot

export async function takeSnapshot(cfg, prev = {}) {
  const versions = await snapshotVersions(cfg, prev.versions);
  const cliEntry = versions.cli.linux_amd64;
  const prevCli = prev.versions?.cli?.linux_amd64;

  let cli = prev.analysis?.cli ?? null;
  if (cfg.analyze?.cli && cliEntry && (!cli || cliEntry.version !== prevCli?.version || cliEntry.sha512 !== prevCli?.sha512)) {
    try { cli = await analyzeCli(cliEntry); console.log(`  analysed CLI ${cliEntry.version}: ${cli.modelEnums.length} model enums, ${cli.env.length} env flags`); }
    catch (e) { console.error('CLI analysis failed:', e.message); }
  }
  let vsix = prev.analysis?.vsix ?? null;
  const vsVer = versions.vscode?.version;
  if (cfg.analyze?.vsix && vsVer && (!vsix || vsix.version !== vsVer)) {
    try { vsix = { version: vsVer, ...(await analyzeVsix(vsVer, cfg.vscode)) }; console.log(`  analysed VS Code extension ${vsVer}: ${vsix.commands.length} commands`); }
    catch (e) { console.error('VSIX analysis failed:', e.message); }
  }

  // Docs / blog / sitemap through the shared page tracker.
  const web = await snapshotWeb(cfg.web, prev.web);
  let docsIndex = prev.docsIndex ?? {};
  try { docsIndex = parseLlmsIndex(await fetchText(cfg.docs.base + cfg.docs.llms)); } catch (e) { console.error('llms.txt failed:', e.message); }
  let blog = prev.blog ?? [];
  try {
    const rss = await fetchText(cfg.docs.base + cfg.docs.rss);
    blog = [...rss.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({
      title: (m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? '').trim(),
      link: (m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '').trim(),
    })).filter(p => p.title);
  } catch (e) { console.error('blog rss failed:', e.message); }

  return { timestamp: Date.now(), versions, analysis: { cli, vsix }, web, docsIndex, blog };
}

// ----------------------------------------------------------------------- diff

const setDelta = (a = [], b = []) => { const A = new Set(a), B = new Set(b); return { added: b.filter(x => !A.has(x)), removed: a.filter(x => !B.has(x)) }; };

export function diffSnapshots(prev, curr) {
  const d = { versions: [], analysis: {}, web: [], docs: null, blog: [] };
  const pv = prev.versions ?? {}, cv = curr.versions;
  const cliOld = pv.cli?.linux_amd64?.version, cliNew = cv.cli.linux_amd64?.version;
  if (cliNew && cliNew !== cliOld) d.versions.push({ product: 'Antigravity CLI (agy)', from: cliOld, to: cliNew });
  for (const [key, label] of [['hub', 'Antigravity desktop app'], ['ide', 'Antigravity IDE']]) {
    if (cv[key] && cv[key].version !== pv[key]?.version) d.versions.push({ product: label, from: pv[key]?.version, to: cv[key].version, build: cv[key].build });
  }
  if (cv.vscode && cv.vscode.version !== pv.vscode?.version) d.versions.push({ product: 'VS Code extension', from: pv.vscode?.version, to: cv.vscode.version });

  const classes = { modelEnums: 'Internal model enums', modelIds: 'Model IDs', env: 'Env flags', protos: 'Protobuf types', providers: 'Model providers' };
  const pa = prev.analysis?.cli ?? {}, ca = curr.analysis?.cli ?? {};
  for (const k of Object.keys(classes)) { const x = setDelta(pa[k], ca[k]); if (x.added.length || x.removed.length) d.analysis[k] = { ...x, label: classes[k], source: 'CLI' }; }
  const pe = prev.analysis?.vsix ?? {}, ce = curr.analysis?.vsix ?? {};
  for (const [k, label] of [['commands', 'Extension commands'], ['settings', 'Extension settings'], ['changelog', 'Extension changelog']]) {
    const x = setDelta(pe[k], ce[k]); if (x.added.length || x.removed.length) d.analysis[`vsix_${k}`] = { ...x, label, source: 'VSIX' };
  }

  for (const [id, lines] of Object.entries(curr.web.pages)) {
    const had = prev.web?.pages && id in prev.web.pages; const x = setDelta(prev.web?.pages?.[id], lines);
    if (x.added.length || (had && x.removed.length)) d.web.push({ id, added: x.added, removed: had ? x.removed : [], isNew: !had });
  }
  const di = setDelta(Object.keys(prev.docsIndex ?? {}), Object.keys(curr.docsIndex));
  if (di.added.length || di.removed.length) d.docs = { added: di.added.map(u => ({ url: u, title: curr.docsIndex[u] })), removed: di.removed };
  const bp = new Set((prev.blog ?? []).map(p => p.link)); d.blog = curr.blog.filter(p => !bp.has(p.link));

  d.hasChanges = !!(d.versions.length || Object.keys(d.analysis).length || d.web.length || d.docs || d.blog.length);
  return d;
}

export const EMPTY = { versions: { cli: {} }, analysis: {}, web: { pages: {} }, docsIndex: {}, blog: [] };

// --------------------------------------------------------------------- report

export function buildSegments(curr, d, { firstRun = false, max = 25 } = {}) {
  const segs = [];
  const cv = curr.versions;
  segs.push(firstRun
    ? `# 🌱 Google Antigravity — initial baseline\nCLI ${code(cv.cli.linux_amd64?.version)} · App ${code(cv.hub?.version)} · IDE ${code(cv.ide?.version)} · VS Code ext ${code(cv.vscode?.version)}`
    : '# 🛸 Google Antigravity');
  if (!firstRun && d.versions.length) segs.push(`### 🚀 New releases\n${d.versions.map(v => `**${v.product}**: ${code(v.from ?? '∅')} → ${code(v.to)}${v.build ? ` (build ${v.build})` : ''}`).join('\n')}`);
  const hot = /MODEL_(GOOGLE|OPENAI|CLAUDE|ALIAS)|JARVIS|COMPUTER_USE|BYOM/;
  // Pure-letter Gemini suffixes (COSMICFORGE, RIFTRUNNER...) are internal codenames, not versioned releases.
  const rank = (e) => (/^MODEL_GOOGLE_GEMINI_[A-Z]+(?:_THINKING_(?:HIGH|LOW))?$/.test(e) && !/(TRAINING|EXAMPLE|FOR_GOOGLE|INTERNAL)/.test(e) ? 0 : /JARVIS|COMPUTER_USE|BYOM|ALIAS_(SHAMU|VISTA)/.test(e) ? 1 : /^MODEL_(GOOGLE|OPENAI)/.test(e) ? 2 : 3);
  for (const [k, c] of Object.entries(d.analysis)) {
    if (k === 'modelEnums') c.added.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const lines = c.added.slice(0, max * 2).map(x => `🟢 ${code(clip(x, 140))}`)
      .concat(firstRun ? [] : c.removed.slice(0, max).map(x => `🔴 ${code(clip(x, 140))}`));
    if (k === 'modelEnums' && firstRun) { const h = c.added.filter(x => hot.test(x)); lines.splice(0, lines.length, ...h.slice(0, max * 2).map(x => `🟢 ${code(x)}`)); }
    const extra = c.added.length + (firstRun ? 0 : c.removed.length) - lines.length;
    segs.push(`### 🔬 ${c.label} — from ${c.source} binary (+${c.added.length}${firstRun ? '' : ` −${c.removed.length}`})\n${lines.join('\n')}${extra > 0 ? `\n*…and ${extra} more*` : ''}`);
  }
  if (d.blog.length) segs.push(`### 📝 Blog\n${d.blog.slice(0, max).map(p => `🟢 [${clip(p.title, 90)}](${p.link})`).join('\n')}`);
  if (d.docs) segs.push(`### 📚 Docs pages (+${d.docs.added.length} −${d.docs.removed.length})\n${d.docs.added.slice(0, max).map(p => `🟢 [${clip(p.title, 70)}](${p.url})`).join('\n')}${d.docs.removed.length ? '\n' + d.docs.removed.slice(0, 10).map(u => `🔴 ${u}`).join('\n') : ''}`);
  for (const p of d.web) {
    const lines = p.added.slice(0, p.isNew ? 20 : max * 2).map(l => `🟢 ${clip(l, 260)}`).concat(p.removed.slice(0, 10).map(l => `🔴 ${clip(l, 200)}`));
    segs.push(`### 📰 ${p.id}${p.isNew ? ' — current content' : ' updated'}\n${lines.join('\n')}`);
  }
  return segs;
}

// ----------------------------------------------------------------------- main

export async function main() {
  const cfg = JSON.parse(readFileSync(join(__dirname, '../antigravity-config.json'), 'utf8'));
  const webhookUrl = process.env[cfg.webhook.webhookEnv];
  const webhookOn = cfg.webhook.enabled !== false && !!webhookUrl;
  const statePath = join(__dirname, '..', cfg.stateFile);
  let prev = null;
  if (existsSync(statePath)) { try { prev = JSON.parse(readFileSync(statePath, 'utf8')); } catch (e) { console.error('bad state, starting fresh:', e.message); } }
  const firstRun = !prev?.versions?.cli;

  console.log('[antigravity] snapshotting...');
  const curr = await takeSnapshot(cfg, prev ?? {});
  if (!curr.versions.cli.linux_amd64) throw new Error('CLI manifest unavailable — endpoint changed?');
  const d = diffSnapshots(firstRun ? EMPTY : prev, curr);

  // Dedicated release alert first (only real version changes, not the first baseline).
  if (!firstRun && d.versions.length) {
    const alert = buildPayloads([`# 🚀 Google Antigravity — new release\n${d.versions.map(v => `**${v.product}**\n${code(v.from ?? '∅')} ⬇️ ${code(v.to)}`).join('\n')}`], 'Antigravity Watcher')[0];
    if (webhookOn) { await postPayload(webhookUrl, alert, 'antigravity'); await sleep(1500); }
    else console.log('[antigravity] RELEASE:', d.versions.map(v => `${v.product} ${v.from} -> ${v.to}`).join('; '));
  }
  const segs = (firstRun || d.hasChanges) ? buildSegments(curr, d, { firstRun, max: cfg.maxItemsPerSection }) : [];
  const worthSending = firstRun ? segs.length > 0 : segs.length > 1 && (Object.keys(d.analysis).length || d.web.length || d.docs || d.blog.length);
  if (worthSending) {
    if (webhookOn) {
      const payloads = buildPayloads(segs, 'Antigravity Watcher');
      console.log(`[antigravity] sending ${payloads.length} message(s)`);
      for (const p of payloads) { await postPayload(webhookUrl, p, 'antigravity'); await sleep(1500); }
    } else console.log('[antigravity] report (no webhook):\n' + segs.join('\n\n'));
  } else console.log('[antigravity] no changes');

  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(curr));
  console.log('[antigravity] state saved');
}

const isCli = process.argv[1] && /antigravity-watch\.js$/.test(process.argv[1]);
if (isCli) main().catch(err => { console.error(err); process.exit(1); });
