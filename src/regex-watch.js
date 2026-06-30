import { Camoufox } from 'camoufox-js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_TIMEOUT = 60000;
const DEFAULT_DELAY = 2500;
const REGEX_TIMEOUT = 10000;

function loadConfig() {
  const configPath = join(__dirname, '..', 'regex-config.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateUrls(config) {
  const pages = config.pages || [];
  for (const page of pages) {
    if (!page.url || !isValidUrl(page.url)) return false;
  }
  return true;
}

function loadState(statePath) {
  if (existsSync(statePath)) {
    try {
      const data = JSON.parse(readFileSync(statePath, 'utf-8'));
      for (const url in data) {
        if (data[url] && data[url].patterns) {
          for (const patternId in data[url].patterns) {
            if (Array.isArray(data[url].patterns[patternId].matchedStrings)) {
              data[url].patterns[patternId].matchedStrings = new Set(data[url].patterns[patternId].matchedStrings);
            }
          }
        }
      }
      return data;
    } catch (e) {
      console.error('Failed to parse state file, starting fresh:', e.message);
    }
  }
  return {};
}

function saveState(statePath, state) {
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stateToSave = {};
  for (const url in state) {
    stateToSave[url] = { patterns: {} };
    if (state[url] && state[url].patterns) {
      for (const patternId in state[url].patterns) {
        const patternData = state[url].patterns[patternId];
        stateToSave[url].patterns[patternId] = {
          count: patternData.count,
          matchedStrings: Array.from(patternData.matchedStrings || []),
          timestamp: patternData.timestamp
        };
      }
    }
  }
  writeFileSync(statePath, JSON.stringify(stateToSave, null, 2));
}

function isBinaryResponse(contentType) {
  if (!contentType) return false;
  const binaryTypes = ['image/', 'application/pdf', 'application/zip', 'application/gzip', 'application/octet-stream', 'audio/', 'video/'];
  return binaryTypes.some(type => contentType.toLowerCase().startsWith(type));
}

function runRegexWithTimeout(pattern, text, timeout = REGEX_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Regex timeout')), timeout);
    try {
      const regex = new RegExp(pattern, 'gi');
      const matches = [];
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push(match[0]);
        if (match[0].length === 0) regex.lastIndex++;
      }
      clearTimeout(timer);
      resolve(matches);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

function extractCaptureGroups(pattern, text) {
  const results = [];
  try {
    const regex = new RegExp(pattern, 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.length > 1) {
        for (let i = 1; i < match.length; i++) if (match[i]) results.push(match[i]);
      } else {
        results.push(match[0]);
      }
      if (match[0].length === 0) regex.lastIndex++;
    }
  } catch (e) {}
  return results;
}

function looksLikeBinary(text) {
  if (!text) return false;
  const sample = text.slice(0, 1000);
  const nonPrintable = sample.split('').filter(char => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== '\n' && char !== '\r' && char !== '\t';
  }).length;
  return nonPrintable / sample.length > 0.1;
}

async function launchBrowser(maxRetries = 2) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let browser;
    try {
      browser = await Camoufox({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
      return browser;
    } catch (error) {
      lastError = error;
      if (browser) await browser.close().catch(() => {});
      if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
    }
  }
  throw lastError;
}

async function processUrl(page, url, patterns, timeout) {
  const results = { url, success: false, patterns: {} };
  try {
    const responses = [];
    const pendingHandlers = [];
    const responseHandler = async (response) => {
      const handlerPromise = (async () => {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (response.status() < 200 || response.status() >= 300) return;
          if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return;
          if (isBinaryResponse(contentType)) return;
          let body = await response.text();
          if (body.length > MAX_RESPONSE_SIZE) body = body.slice(0, MAX_RESPONSE_SIZE);
          if (!looksLikeBinary(body)) responses.push(body);
        } catch (e) {}
      })();
      pendingHandlers.push(handlerPromise);
    };
    page.on('response', responseHandler);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    page.removeListener('response', responseHandler);
    await Promise.all(pendingHandlers);
    responses.push(await page.content());

    for (const patternConfig of patterns) {
      const pattern = typeof patternConfig === 'string' ? patternConfig : patternConfig.pattern;
      const patternId = typeof patternConfig === 'string' ? patternConfig : (patternConfig.id || patternConfig.pattern);
      const hasCaptureGroups = /\((?!\?:)/.test(pattern);
      const matchedStrings = new Set();
      let matchCount = 0;
      for (const body of responses) {
        try {
          const matches = hasCaptureGroups ? extractCaptureGroups(pattern, body) : await runRegexWithTimeout(pattern, body);
          for (const m of matches) matchedStrings.add(m);
          matchCount += matches.length;
        } catch (e) {}
      }
      results.patterns[patternId] = { count: matchCount, matchedStrings: Array.from(matchedStrings), uniqueCount: matchedStrings.size, timestamp: Date.now() };
    }
    results.success = true;
  } catch (error) {
    results.error = error.message;
  }
  return results;
}

async function sendDiscordWebhook(webhookUrl, payload) {
  const { sendDiscordWebhook: send } = await import('./webhook.js');
  return send(webhookUrl, payload);
}

function getRelativeTimestamp() {
  return `<t:\${Math.floor(Date.now() / 1000)}:R>`;
}

function createMatchesPayload(pageName, url, patternResults) {
  const fields = [];
  for (const [patternId, result] of Object.entries(patternResults)) {
    const uniqueStrings = result.matchedStrings || [];
    const stringsValue = uniqueStrings.length > 0 
      ? uniqueStrings.map(s => \`- \`\${s}\`\`).join('\n')
      : '(no matches)';

    const MAX_FIELD = 1000;
    if (stringsValue.length > MAX_FIELD) {
      const chunks = [];
      let current = '';
      for (const line of stringsValue.split('\n')) {
        if (current.length + line.length > MAX_FIELD) {
          chunks.push(current);
          current = line + '\n';
        } else {
          current += line + '\n';
        }
      }
      if (current) chunks.push(current);
      
      chunks.forEach((chunk, i) => {
        fields.push({
          name: \`Pattern: \${patternId.substring(0, 247)} (part \${i+1})\`,
          value: i === 0 ? \`**Count:** \${result.count}\n**Unique:** \${result.uniqueCount}\n\n\${chunk}\` : chunk
        });
      });
    } else {
      fields.push({
        name: \`Pattern: \${patternId.substring(0, 247)}\`,
        value: \`**Count:** \${result.count}\n**Unique:** \${result.uniqueCount}\n\n\${stringsValue}\`
      });
    }
  }
  
  return {
    username: 'Regex Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🔍 Regex Match Detected',
      description: \`**\${pageName}** \${getRelativeTimestamp()}\`,
      url,
      color: 0x8B5CF6,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'Regex Watcher', icon_url: LOGO_URL }
    }]
  };
}

function detectChanges(currentResults, previousState, url) {
  const prevUrlState = previousState[url] || {};
  const prevPatterns = prevUrlState.patterns || {};
  const changes = { hasChanges: false, changes: [] };
  for (const [patternId, currentResult] of Object.entries(currentResults.patterns)) {
    const currentCount = currentResult.count || 0;
    const prevCount = prevPatterns[patternId]?.count || 0;
    if (currentCount !== prevCount) {
      changes.hasChanges = true;
      changes.changes.push({ patternId, previousCount: prevCount, currentCount });
    }
  }
  return changes;
}

async function main() {
  const config = loadConfig();
  if (!validateUrls(config)) process.exit(1);
  const statePath = join(__dirname, '..', config.state?.file || 'logs/regex-state.json');
  const previousState = loadState(statePath);
  const webhookUrl = process.env[config.webhook?.webhookEnv];
  if (!webhookUrl) process.exit(1);

  const browser = await launchBrowser(2);
  const page = await browser.newPage();
  try {
    for (const pageConfig of config.pages) {
      const results = await processUrl(page, pageConfig.url, pageConfig.patterns, config.settings?.timeout || DEFAULT_TIMEOUT);
      if (!results.success) continue;
      const changes = detectChanges(results, previousState, pageConfig.url);
      if (changes.hasChanges) {
        await sendDiscordWebhook(webhookUrl, createMatchesPayload(pageConfig.name, pageConfig.url, results.patterns));
      }
      previousState[pageConfig.url] = { patterns: results.patterns };
    }
  } finally {
    if (browser) await browser.close();
  }
  saveState(statePath, previousState);
}

main().catch(() => process.exit(1));
