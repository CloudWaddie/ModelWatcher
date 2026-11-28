import { withAlertFooter } from './alert-footer.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

const SEARCH_URL = 'https://tmsearch.uspto.gov/prod-v1-0-0/tmsearch';
const TSDR_URL = 'https://tsdr.uspto.gov/';

/**
 * Load configuration from uspto-config.json
 */
function loadConfig() {
  const configPath = join(__dirname, '..', 'uspto-config.json');
  const configContent = readFileSync(configPath, 'utf-8');
  return JSON.parse(configContent);
}

/**
 * Load state from state file
 */
function loadState(statePath) {
  if (existsSync(statePath)) {
    try {
      const data = JSON.parse(readFileSync(statePath, 'utf-8'));
      // Convert arrays back to Sets
      for (const slug in data.companies) {
        if (Array.isArray(data.companies[slug].seenSerials)) {
          data.companies[slug].seenSerials = new Set(data.companies[slug].seenSerials);
        }
      }
      return data;
    } catch (e) {
      console.error('Failed to parse state file, starting fresh:', e.message);
    }
  }
  return { companies: {} };
}

/**
 * Save state to state file
 */
function saveState(statePath, state) {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Convert Sets to arrays for JSON serialization
  const stateToSave = { companies: {} };
  for (const slug in state.companies) {
    stateToSave.companies[slug] = {
      seenSerials: Array.from(state.companies[slug].seenSerials)
    };
  }
  writeFileSync(statePath, JSON.stringify(stateToSave, null, 2));
}

function normalizeOwner(name) {
  return name.split(' (', 1)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchCompanyFilings(company, seenSerials, timeout) {
  const ownerName = company.ownerName ?? company.name;
  const ownerQuery = ownerName.replace(/["\\]/g, '\\$&');
  const response = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeout),
    body: JSON.stringify({
      query: { query_string: { query: `ON:"${ownerQuery}"` } },
      sort: [{ filedDate: 'desc' }],
      size: 100,
      _source: ['filedDate', 'ownerName', 'wordmark']
    })
  });

  if (!response.ok) {
    throw new Error(`USPTO Trademark Search returned HTTP ${response.status}`);
  }

  const result = await response.json();
  const hits = result.hits?.hits;
  if (!Array.isArray(hits) || result.timedOut || result.shardsFailed > 0) {
    throw new Error('USPTO Trademark Search returned incomplete results');
  }

  const filings = new Map();
  const expectedOwner = normalizeOwner(ownerName);
  let matched = 0;

  for (const { id, source } of hits) {
    if (!Array.isArray(source?.ownerName)) {
      throw new Error('USPTO Trademark Search result is missing owner data');
    }
    if (!source.ownerName.some(name => normalizeOwner(name) === expectedOwner)) continue;
    matched++;

    const serial = String(id);
    if (!/^\d{8}$/.test(serial)) {
      throw new Error('USPTO Trademark Search returned an invalid serial number');
    }
    if (seenSerials.has(serial)) continue;

    const date = source.filedDate?.match(/^\d{4}-\d{2}-\d{2}(?=T|$)/)?.[0];
    if (!date) throw new Error(`Filing date missing or invalid for serial ${serial}`);

    filings.set(serial, {
      serial,
      date,
      mark: String(source.wordmark ?? '').trim().slice(0, 256) || 'Symbol/Image',
      url: `${TSDR_URL}#caseNumber=${serial}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`,
      imageUrl: `${TSDR_URL}img/${serial}/large`
    });
  }

  console.log(`Matched ${matched} USPTO records for ${company.name}`);
  return [...filings.values()];
}

/**
 * Send a Discord webhook notification
 */
async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.log('Discord webhook URL not configured, skipping notification');
    return false;
  }

  // Dynamically import axios only when needed (for webhook)
  const { default: axios } = await import('axios');
  
  try {
    await axios.post(webhookUrl, withAlertFooter(payload), {
      headers: { 'Content-Type': 'application/json' }
    });
    return true;
  } catch (err) {
    const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Failed to send Discord webhook:', err.response?.status, details);
    return false;
  }
}

/**
 * Get Discord relative timestamp
 */
function getRelativeTimestamp() {
  const unixSeconds = Math.floor(Date.now() / 1000);
  return `<t:${unixSeconds}:R>`;
}

/**
 * Create Discord message for new trademark filings with embeds and images
 */
function createNewFilingsMessage(company, filings) {
  const embeds = [];
  const companyName = company.name;
  
  // If too many filings, just show summary
  if (filings.length > 10) {
    return {
      username: 'USPTO Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🏛️ New Trademark Filings',
        description: `**${companyName}** filed **${filings.length}** new trademark applications ${getRelativeTimestamp()}!`,
        url: filings[0].url,
        color: 0x2563EB,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'USPTO Trademark Watcher',
          icon_url: LOGO_URL
        }
      }]
    };
  }
  
  // Create an embed for each filing
  for (const filing of filings) {
    const embed = {
      title: filing.mark,
      description: `**Serial:** ${filing.serial}\n**Date:** ${filing.date}`,
      url: filing.url,
      color: 0x2563EB,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'USPTO Trademark Watcher',
        icon_url: LOGO_URL
      }
    };
    
    // Add thumbnail image if available
    if (filing.imageUrl) {
      embed.thumbnail = {
        url: filing.imageUrl
      };
    }
    
    embeds.push(embed);
  }
  
  return {
    username: 'USPTO Watcher',
    avatar_url: LOGO_URL,
    content: `🏛️ **New Trademark Filings from ${companyName}**\n\n${companyName} filed ${filings.length} new trademark application${filings.length > 1 ? 's' : ''} ${getRelativeTimestamp()}!`,
    embeds: embeds
  };
}

/**
 * Main function
 */
async function main() {
  console.log('=== USPTO Trademark Watcher ===');
  console.log('Starting trademark check...');

  const config = loadConfig();
  const statePath = join(__dirname, '..', config.state?.file || 'logs/uspto-state.json');
  const state = loadState(statePath);

  const webhookUrl = process.env[config.webhook?.webhookEnv];

  if (!webhookUrl) {
    console.error(`Webhook URL not configured (${config.webhook?.webhookEnv} env not set), exiting`);
    process.exit(1);
  }

  const companies = config.companies || [];
  console.log(`Watching ${companies.length} company(ies): ${companies.map(c => c.name).join(', ')}`);

  let totalNewFilings = 0;

  for (const company of companies) {
    const seenSerials = state.companies[company.slug]?.seenSerials ?? new Set();

    try {
      const newFilings = await fetchCompanyFilings(
        company, seenSerials, config.scan?.timeout ?? 30000
      );

      if (newFilings.length === 0) {
        console.log(`No new trademark filings for ${company.name}`);
        continue;
      }

      const message = createNewFilingsMessage(company, newFilings);
      if (!await sendDiscordWebhook(webhookUrl, message)) {
        throw new Error('Discord notification was not delivered');
      }

      for (const filing of newFilings) {
        seenSerials.add(filing.serial);
      }
      state.companies[company.slug] = { seenSerials };
      totalNewFilings += newFilings.length;
      console.log(`Sent ${newFilings.length} new trademark filings for ${company.name}`);
    } catch (error) {
      console.error(`USPTO scan failed for ${company.name}: ${error.message}`);
      process.exitCode = 1;
    }
  }

  // Save state
  saveState(statePath, state);

  console.log(`=== Trademark check complete: ${totalNewFilings} new filings ===`);
}

// Run main function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
