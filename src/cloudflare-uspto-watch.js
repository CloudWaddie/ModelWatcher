import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * Load configuration
 */
function loadConfig() {
  const configPath = join(__dirname, '..', 'cloudflare-uspto-config.json');
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
 * Initiate a Cloudflare crawl job
 * @param {string} accountId - Cloudflare Account ID
 * @param {string} apiToken - Cloudflare API Token
 * @param {string} url - URL to crawl
 * @param {Object} options - Crawl options
 * @returns {Promise<Object>} - Job result object
 */
async function initiateCrawl(accountId, apiToken, url, options = {}) {
  const endpoint = `${CLOUDFLARE_API_BASE}/${accountId}/browser-rendering/crawl`;
  
  const payload = {
    url,
    render: false, // Use static HTML fetch (free during beta)
    formats: ['html', 'markdown'],
    ...options
  };

  const response = await axios.post(endpoint, payload, {
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.data.success) {
    throw new Error(`Crawl initiation failed: ${JSON.stringify(response.data.errors)}`);
  }

  return response.data.result;
}

/**
 * Poll for crawl job results
 * @param {string} accountId - Cloudflare Account ID
 * @param {string} apiToken - Cloudflare API Token
 * @param {string} jobId - Job ID
 * @param {number} maxAttempts - Maximum polling attempts
 * @param {number} delayMs - Delay between polls
 * @returns {Promise<Object>} - Crawl results
 */
async function waitForCrawl(accountId, apiToken, jobId, maxAttempts = 60, delayMs = 5000) {
  const endpoint = `${CLOUDFLARE_API_BASE}/${accountId}/browser-rendering/crawl/${jobId}`;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await axios.get(endpoint, {
      headers: {
        'Authorization': `Bearer ${apiToken}`
      },
      params: { limit: 1 } // Lightweight response for status check
    });

    if (!response.data.success) {
      throw new Error(`Crawl status check failed: ${JSON.stringify(response.data.errors)}`);
    }

    const status = response.data.result.status;
    
    if (status === 'completed') {
      return response.data.result;
    }

    const errorMessages = {
      'errored': 'Crawl job encountered an error',
      'cancelled_due_to_timeout': 'Crawl job timed out',
      'cancelled_due_to_limits': 'Crawl job cancelled due to account limits',
      'cancelled_by_user': 'Crawl job was cancelled'
    };

    if (errorMessages[status]) {
      throw new Error(errorMessages[status]);
    }
    
    // Still running, wait and poll again
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  throw new Error('Crawl job did not complete within timeout');
}

/**
 * Fetch full crawl results
 * @param {string} accountId - Cloudflare Account ID
 * @param {string} apiToken - Cloudflare API Token
 * @param {string} jobId - Job ID
 * @returns {Promise<Array>} - Crawled records
 */
async function getCrawlResults(accountId, apiToken, jobId) {
  const endpoint = `${CLOUDFLARE_API_BASE}/${accountId}/browser-rendering/crawl/${jobId}`;
  
  const response = await axios.get(endpoint, {
    headers: {
      'Authorization': `Bearer ${apiToken}`
    },
    params: { status: 'completed' }
  });

  if (!response.data.success) {
    throw new Error(`Crawl results fetch failed: ${JSON.stringify(response.data.errors)}`);
  }

  return response.data.result.records;
}

/**
 * Fetch trademark filings using Cloudflare Browser Rendering crawl
 */
async function fetchCompanyFilings(companySlug, accountId, apiToken) {
  console.log(`Fetching USPTO data for ${companySlug} via Cloudflare...`);

  try {
    // Initiate crawl
    const job = await initiateCrawl(accountId, apiToken, `https://uspto.report/company/${companySlug}`, {
      limit: 50,
      depth: 1,
      source: 'links'
    });

    console.log(`Crawl job started: ${job.id}`);

    // Wait for completion
    const result = await waitForCrawl(accountId, apiToken, job.id);
    console.log(`Crawl completed: ${result.finished}/${result.total} pages`);

    // Get full results
    const records = await getCrawlResults(accountId, apiToken, job.id);

    // Parse filings from the records
    const filings = [];

    for (const record of records) {
      // Try to parse HTML or markdown content
      const content = record.html || record.markdown || '';
      
      // Extract trademark data using regex patterns
      const serialMatches = content.matchAll(/\/TM\/(\d+)/g);
      
      for (const match of serialMatches) {
        const serial = match[1];
        
        // Try to find the mark name near the serial
        const serialIndex = content.indexOf(`/TM/${serial}`);
        const snippet = content.slice(Math.max(0, serialIndex - 200), serialIndex + 200);
        
        // Look for mark name in the snippet
        const markMatch = snippet.match(/(?:mark|name)["']?\s*[:=]\s*["']?([^"<\n]+)/i) 
          || snippet.match(/<a[^>]*>([^<]+)<\/a>/i);
        const mark = markMatch ? markMatch[1].trim() : `Mark ${serial}`;
        
        // Look for date
        const dateMatch = snippet.match(/(\d{4}-\d{2}-\d{2})/);
        const date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
        
        if (serial && !filings.find(f => f.serial === serial)) {
          filings.push({
            serial,
            mark,
            date,
            url: `https://uspto.report/TM/${serial}`,
            imageUrl: `https://uspto.report/TM/${serial}/mark.png`
          });
        }
      }
    }

    // Sort by date (newest first)
    filings.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    console.log(`Found ${filings.length} trademark filings for ${companySlug}`);
    return filings;

  } catch (error) {
    console.error(`Failed to fetch USPTO data for ${companySlug}:`, error.message);
    return [];
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
 * Create Discord message for new trademark filings
 */
function createNewFilingsMessage(company, filings) {
  const embeds = [];
  const companySlug = company.slug;
  const companyName = company.name;
  
  // If too many filings, just show summary
  if (filings.length > 10) {
    return {
      username: 'USPTO Watcher (Cloudflare)',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🏛️ New Trademark Filings',
        description: `**${companyName}** filed **${filings.length}** new trademark applications ${getRelativeTimestamp()}!`,
        url: `https://uspto.report/company/${companySlug}`,
        color: 0x2563EB,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'USPTO Trademark Watcher (Cloudflare)',
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
        text: 'USPTO Trademark Watcher (Cloudflare)',
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
    username: 'USPTO Watcher (Cloudflare)',
    avatar_url: LOGO_URL,
    content: `🏛️ **New Trademark Filings from ${companyName}**\n\n${companyName} filed ${filings.length} new trademark application${filings.length > 1 ? 's' : ''} ${getRelativeTimestamp()}!`,
    embeds: embeds
  };
}

/**
 * Main function
 */
async function main() {
  console.log('=== USPTO Trademark Watcher (Cloudflare) ===');
  console.log('Starting trademark check via Cloudflare Browser Rendering...');

  const config = loadConfig();
  const statePath = join(__dirname, '..', config.state?.file || 'logs/cloudflare-uspto-state.json');
  const state = loadState(statePath);

  // Get Cloudflare credentials
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!apiToken || !accountId) {
    console.error('Cloudflare credentials not configured. Required env vars:');
    console.error('  - CLOUDFLARE_API_TOKEN');
    console.error('  - CLOUDFLARE_ACCOUNT_ID');
    process.exit(1);
  }

  const webhookUrl = process.env[config.webhook?.webhookEnv];

  if (!webhookUrl) {
    console.error(`Webhook URL not configured (${config.webhook?.webhookEnv} env not set), exiting`);
    process.exit(1);
  }

  const companies = config.companies || [];
  console.log(`Watching ${companies.length} company(ies): ${companies.map(c => c.name).join(', ')}`);

  let totalNewFilings = 0;

  for (const company of companies) {
    const filings = await fetchCompanyFilings(company.slug, accountId, apiToken);

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
