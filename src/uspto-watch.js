import { withAlertFooter } from './alert-footer.js';
import { load } from 'cheerio';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

const SOURCE_URL = 'https://uspto.report';

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

async function fetchPage(path, timeout) {
  const response = await fetch(new URL(path, SOURCE_URL), {
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return load(await response.text());
}

async function fetchCompanyFilings(companySlug, seenSerials, timeout) {
  const $ = await fetchPage(`/company/${encodeURIComponent(companySlug)}`, timeout);
  const section = $('.company-section').filter((_, element) =>
    $(element).find('h2').text().trim() === 'Trademarks'
  );
  const filings = new Map();
  let hasTrademarkRecords = false;

  for (const link of section.find('.company-list > a')) {
    const path = $(link).attr('href');
    const serial = path?.match(/^\/TM\/(\d+)\/?$/)?.[1];
    if (!serial) continue;
    hasTrademarkRecords = true;
    if (!seenSerials.has(serial)) {
      filings.set(serial, {
        serial,
        mark: $(link).find('strong').text().trim(),
        url: new URL(path, SOURCE_URL).href,
        imageUrl: `${SOURCE_URL}/TM/${serial}/mark.png`
      });
    }
  }

  const trademarkCount = $('.counts .card').filter((_, element) =>
    $(element).find('span').text().trim() === 'Trademark records'
  ).find('strong').text().trim();
  if (!hasTrademarkRecords && trademarkCount !== '0') {
    throw new Error('No trademark records found on the company page');
  }

  for (const filing of filings.values()) {
    const detail = await fetchPage(`/TM/${filing.serial}/`, timeout);
    const heading = detail('main h1').first().text().trim();
    const dateLabel = detail('dt').filter((_, element) =>
      detail(element).text().trim() === 'Filing date'
    );
    if (heading && heading !== 'Untitled trademark' && heading !== filing.serial) {
      filing.mark = heading;
    } else if (!filing.mark || filing.mark === filing.serial) {
      filing.mark = 'Symbol/Image';
    }

    const date = Date.parse(`${dateLabel.next('dd').text().trim()} UTC`);
    if (Number.isNaN(date)) {
      throw new Error(`Filing date missing or invalid for serial ${filing.serial}`);
    }
    filing.date = new Date(date).toISOString().slice(0, 10);
  }

  return [...filings.values()].sort((a, b) => b.date.localeCompare(a.date));
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
  const companySlug = company.slug;
  const companyName = company.name;
  
  // If too many filings, just show summary
  if (filings.length > 10) {
    return {
      username: 'USPTO Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🏛️ New Trademark Filings',
        description: `**${companyName}** filed **${filings.length}** new trademark applications ${getRelativeTimestamp()}!`,
        url: `https://uspto.report/company/${companySlug}`,
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
        company.slug, seenSerials, config.scan?.timeout ?? 30000
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
