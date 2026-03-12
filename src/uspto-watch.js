import { Camoufox } from 'camoufox-js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

/**
 * Load configuration from uspto-config.json
 */
function loadConfig() {
  const configPath = './uspto-config.json';
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

/**
 * Fetch trademark filings using Camoufox browser with DOM parsing
 */
async function fetchCompanyFilings(companySlug) {
  console.log(`Fetching USPTO data for ${companySlug}...`);

  let browser;
  try {
    browser = await Camoufox({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    
    await page.goto(`https://uspto.report/company/${companySlug}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for the table to be present
    await page.waitForSelector('table', { timeout: 15000 });

    // Scroll to the bottom to trigger lazy-loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

    // Wait for network activity to cease
    await page.waitForLoadState('networkidle', { timeout: 20000 });

    // Parse using DOM APIs - more robust than regex
    const filings = await page.evaluate(() => {
      const results = [];
      const rows = Array.from(document.querySelectorAll('table tr'));

      for (const row of rows) {
        const link = row.querySelector('a[href^="/TM/"]');
        if (!link) continue;

        const url = link.href;
        const serialMatch = url.match(/\/TM\/(\d+)/);
        const serial = serialMatch ? serialMatch[1] : null;
        if (!serial) continue;

        // Get mark name - prefer text content over div parsing
        const markElement = link.querySelector('div');
        let mark = markElement ? markElement.textContent.trim() : null;
        if (!mark) {
          // Try getting from alt attribute
          const img = link.querySelector('img');
          if (img) mark = img.alt || 'Symbol/Image';
        }

        // Get date
        const dateElement = row.querySelector('div[style*="float: right"]');
        const dateMatch = dateElement ? dateElement.textContent.match(/(\d{4}-\d{2}-\d{2})/) : null;
        const date = dateMatch ? dateMatch[1] : null;

        // Get image
        const img = link.querySelector('img');
        const imageUrl = img && img.src ? img.src : null;

        if (serial && mark && date) {
          results.push({
            serial,
            mark,
            date,
            url,
            imageUrl: imageUrl || `https://uspto.report/TM/${serial}/mark.png`
          });
        }
      }

      // Sort by date (newest first)
      results.sort((a, b) => new Date(b.date) - new Date(a.date));

      return results;
    });
    
    console.log(`Found ${filings.length} trademark filings for ${companySlug}`);
    return filings;
    
  } catch (error) {
    console.error(`Failed to fetch USPTO data for ${companySlug}:`, error.message);
    return [];
  } finally {
    if (browser) {
      await browser.close();
    }
  }
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
    await axios.post(webhookUrl, payload, {
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
  const statePath = config.state?.file || './logs/uspto-state.json';
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
    const filings = await fetchCompanyFilings(company.slug);

    if (filings.length === 0) {
      console.log(`No filings found for ${company.name}`);
      continue;
    }

    // Initialize company state if needed
    if (!state.companies[company.slug]) {
      state.companies[company.slug] = { seenSerials: new Set() };
    }

    // Find new filings using Set for O(1) lookup
    const seenSerials = state.companies[company.slug].seenSerials;
    const newFilings = filings.filter(filing => !seenSerials.has(filing.serial));

    // Sort new filings by date (newest first)
    newFilings.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (newFilings.length > 0) {
      console.log(`Found ${newFilings.length} new trademark filings for ${company.name}`);
      
      // Send webhook notification
      const message = createNewFilingsMessage(company, newFilings);
      await sendDiscordWebhook(webhookUrl, message);

      totalNewFilings += newFilings.length;

      // Update seen serials
      for (const filing of newFilings) {
        seenSerials.add(filing.serial);
      }
    } else {
      console.log(`No new trademark filings for ${company.name}`);
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
