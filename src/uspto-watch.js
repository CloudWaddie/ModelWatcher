import { Camoufox } from 'camoufox-js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

/**
 * Get Webshare.io proxy configuration from environment
 * Format: username:password@hostname:port or full proxy URL
 */
function getProxyConfig() {
  const config = loadConfig();
  if (!config.proxy?.enabled) {
    return null;
  }

  const proxyUrl = process.env[config.proxy.urlEnv];
  if (!proxyUrl) {
    return null;
  }
  
  // Parse proxy URL (supports: http://user:pass@host:port or socks5://user:pass@host:port)
  try {
    const url = new URL(proxyUrl);
    // Convert socks5 to http for better browser compatibility
    const protocol = url.protocol === 'socks5:' ? 'http:' : url.protocol;
    return {
      server: `${protocol}//${url.host}`,
      username: url.username,
      password: url.password
    };
  } catch (e) {
    console.error('Invalid proxy URL format:', proxyUrl);
    return null;
  }
}

/**
 * Check if Xvfb is available (for virtual display)
 */
function isXvfbAvailable() {
  try {
    execSync('which Xvfb', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for Cloudflare "Just a moment..." challenge to disappear
 */
async function waitForCloudflareChallenge(page, timeout = 30000) {
  try {
    await page.waitForFunction(
      () => {
        const body = document.body;
        if (!body) return false;
        const text = body.textContent || '';
        // Check for Cloudflare challenge indicators
        if (text.includes('Just a moment') || text.includes('Cloudflare')) {
          return false;
        }
        // Check for cf- scripts
        if (document.querySelector('#cf-ccsp') || document.querySelector('.cf-browser')) {
          return false;
        }
        return true;
      },
      { timeout }
    );
    return true;
  } catch (e) {
    console.log('Cloudflare challenge did not clear within timeout');
    return false;
  }
}

/**
 * Handle and click Turnstile CAPTCHA if present
 */
async function handleCaptcha(page) {
  try {
    // Check for Turnstile (Cloudflare CAPTCHA)
    try {
      const turnstileFrame = page.frameLocator('iframe[src*="turnstile"]');
      // The clickable element inside the Turnstile iframe. This may need adjustment.
      const turnstileElement = turnstileFrame.locator('input[type="checkbox"], #challenge-stage');
      if (await turnstileElement.count() > 0) {
        console.log('Detected Turnstile CAPTCHA, attempting to click...');
        await turnstileElement.first().click({ timeout: 5000 });
        console.log('Clicked Turnstile element');
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      // No Turnstile found or an error occurred, which is acceptable.
    }
    
    // Check for hCaptcha
    const hCaptchaFrame = page.frameLocator('iframe[src*="hcaptcha"], iframe[name*="hcaptcha"]');
    try {
      await hCaptchaFrame.locator('.hcaptcha-checkbox').click({ timeout: 3000 });
      console.log('Clicked hCaptcha');
      await page.waitForTimeout(2000);
    } catch (e) {
      // No hCaptcha found
    }
    
    // Check for reCAPTCHA
    const recaptchaFrame = page.frameLocator('iframe[src*="recaptcha"]');
    try {
      await recaptchaFrame.locator('.recaptcha-checkbox').click({ timeout: 3000 });
      console.log('Clicked reCAPTCHA');
      await page.waitForTimeout(2000);
    } catch (e) {
      // No reCAPTCHA found
    }
    
    return true;
  } catch (error) {
    console.log('CAPTCHA handling error:', error.message);
    return false;
  }
}

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

/**
 * Fetch trademark filings using Camoufox browser with virtual display and CAPTCHA handling
 * Falls back to non-proxy mode if proxy fails (e.g., Cloudflare blocks or quota exceeded)
 */
async function fetchCompanyFilings(companySlug, maxRetries = 3) {
  console.log(`Fetching USPTO data for ${companySlug}...`);

  let lastError;
  const proxyConfig = getProxyConfig();
  let usedProxy = false;
  let proxyFailed = false;
  
  for (let attempt = 1; attempt <= maxRetries || (proxyFailed && attempt === maxRetries + 1); attempt++) {
    let browser;
    try {
      const useVirtualDisplay = isXvfbAvailable();
      
      if (useVirtualDisplay) {
        console.log('Using virtual display (Xvfb) for headless browser');
      }

      const useProxy = proxyConfig && !proxyFailed;
      if (useProxy) {
        console.log(`Using Webshare.io proxy: ${proxyConfig.server}`);
        usedProxy = true;
      } else if (proxyFailed) {
        console.log('Retrying without proxy (proxy previously failed)');
      }

      const camoufoxOptions = {
        headless: useVirtualDisplay ? 'virtual' : true,
        // geoip is heavily recommended when using proxies for proper geolocation routing
        geoip: useProxy ? true : false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      };

      if (useProxy) {
        camoufoxOptions.proxy = proxyConfig;
      }

      browser = await Camoufox(camoufoxOptions);

      const page = await browser.newPage();
      
      await page.goto(`https://uspto.report/company/${companySlug}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      await waitForCloudflareChallenge(page, 30000);
      
      await handleCaptcha(page);
      
      await page.waitForSelector('table', { timeout: 30000 });

      await page.waitForTimeout(3000);

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

      await page.waitForTimeout(2000);

      const filings = await page.evaluate(() => {
        const results = [];
        // Use table.table for specificity - site has multiple tables
        const rows = document.querySelectorAll('table.table tbody tr');

        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 2) continue; // Skip header/invalid rows

          // Get link from FIRST cell
          const firstCell = cells[0];
          const link = firstCell.querySelector('a[href*="/TM/"]');
          if (!link) continue;

          const href = link.getAttribute('href');
          const serialMatch = href.match(/\/TM\/(\d+)/);
          const serial = serialMatch ? serialMatch[1] : null;
          if (!serial) continue;

          // Get mark and date from SECOND cell (contains both)
          const secondCell = cells[1];
          const markDiv = secondCell.querySelector('div[style*="float: left"]');
          let mark = markDiv ? markDiv.textContent.trim() : null;

          // Fallback: use img alt from first cell
          if (!mark) {
            const img = firstCell.querySelector('img');
            if (img) mark = img.alt?.replace(/^"|"$/g, '').trim() || 'Symbol/Image';
          }

          // Get date from second cell's float: right div
          const dateDiv = secondCell.querySelector('div[style*="float: right"]');
          const dateMatch = dateDiv ? dateDiv.textContent.match(/(\d{4}-\d{2}-\d{2})/) : null;
          const date = dateMatch ? dateMatch[1] : null;

          // Get image URL from first cell
          const img = firstCell.querySelector('img');
          const imageUrl = img && img.src ? 'https://uspto.report' + img.getAttribute('src') : null;

          if (serial && mark && date) {
            results.push({
              serial,
              mark,
              date,
              url: 'https://uspto.report' + href,
              imageUrl: imageUrl || `https://uspto.report/TM/${serial}/mark.png`
            });
          }
        }

        results.sort((a, b) => new Date(b.date) - new Date(a.date));

        return results;
      });
      
      console.log(`Found ${filings.length} trademark filings for ${companySlug}`);
      return filings;
    
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxRetries} failed for ${companySlug}:`, error.message);
      
      // Mark proxy as failed if we were using it and got a connection/timeout error
      if (useProxy && ['timeout', 'connect', 'proxy', '403', 'blocked'].some(keyword => error.message.includes(keyword))) {
        console.log('Proxy failed, will retry without proxy');
        proxyFailed = true;
      }
      
      lastError = error;
      
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 2000;
        console.log(`Retrying in ${delay/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
  
  console.error(`All ${maxRetries} attempts failed for ${companySlug}:`, lastError?.message);
  return [];
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
