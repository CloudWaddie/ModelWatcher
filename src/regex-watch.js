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

/**
 * Load configuration from regex-config.json
 */
function loadConfig() {
  const configPath = join(__dirname, '..', 'regex-config.json');
  const configContent = readFileSync(configPath, 'utf-8');
  return JSON.parse(configContent);
}

/**
 * Validate URL format
 */
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate all URLs in config on startup
 */
function validateUrls(config) {
  const pages = config.pages || [];
  const invalidUrls = [];
  
  for (const page of pages) {
    if (!page.url || !isValidUrl(page.url)) {
      invalidUrls.push({ name: page.name, url: page.url });
    }
  }
  
  if (invalidUrls.length > 0) {
    console.error('Invalid URLs found in config:');
    for (const invalid of invalidUrls) {
      console.error(`  - ${invalid.name}: ${invalid.url}`);
    }
    return false;
  }
  
  return true;
}

/**
 * Load state from state file
 */
function loadState(statePath) {
  if (existsSync(statePath)) {
    try {
      const data = JSON.parse(readFileSync(statePath, 'utf-8'));
      // Convert arrays back to Sets for matchedStrings
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

/**
 * Save state to state file
 */
function saveState(statePath, state) {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Convert Sets to arrays for JSON serialization
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

/**
 * Check if response is binary based on content-type
 */
function isBinaryResponse(contentType) {
  if (!contentType) return false;
  const binaryTypes = [
    'image/',
    'application/pdf',
    'application/zip',
    'application/gzip',
    'application/octet-stream',
    'audio/',
    'video/'
  ];
  return binaryTypes.some(type => contentType.toLowerCase().startsWith(type));
}

/**
 * Run regex pattern with timeout
 */
function runRegexWithTimeout(pattern, text, timeout = REGEX_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Regex timeout'));
    }, timeout);
    
    try {
      const regex = new RegExp(pattern, 'gi');
      const matches = [];
      let match;
      
      while ((match = regex.exec(text)) !== null) {
        matches.push(match[0]);
        // Prevent infinite loops on zero-length matches
        if (match[0].length === 0) {
          regex.lastIndex++;
        }
      }
      
      clearTimeout(timer);
      resolve(matches);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

/**
 * Extract capture groups from regex matches
 */
function extractCaptureGroups(pattern, text) {
  const results = [];
  try {
    const regex = new RegExp(pattern, 'gi');
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      // If there are capture groups, extract them
      if (match.length > 1) {
        for (let i = 1; i < match.length; i++) {
          if (match[i]) {
            results.push(match[i]);
          }
        }
      } else {
        // No capture groups, use the full match
        results.push(match[0]);
      }
      
      // Prevent infinite loops on zero-length matches
      if (match[0].length === 0) {
        regex.lastIndex++;
      }
    }
  } catch (e) {
    console.error('Regex extraction error:', e.message);
  }
  
  return results;
}

/**
 * Check if a string looks like binary content
 */
function looksLikeBinary(text) {
  // Check for null bytes or high concentration of non-printable characters
  if (!text) return false;
  const sample = text.slice(0, 1000);
  const nonPrintable = sample.split('').filter(char => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== '\n' && char !== '\r' && char !== '\t';
  }).length;
  
  return nonPrintable / sample.length > 0.1;
}

/**
 * Launch Camoufox browser with retry logic
 */
async function launchBrowser(maxRetries = 2) {
  let lastError;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    attempt++;
    let browser;
    
    try {
      const camoufoxOptions = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      };
      
      browser = await Camoufox(camoufoxOptions);
      return browser;
      
    } catch (error) {
      lastError = error;
      console.error(`Browser launch attempt ${attempt} failed:`, error.message);
      
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          // Ignore close errors
        }
      }
      
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`Retrying browser launch in ${delay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  console.error('All browser launch attempts failed:', lastError?.message);
  throw lastError;
}

/**
 * Process a single URL - navigate and extract regex matches
 */
async function processUrl(page, url, patterns, timeout) {
  const results = {
    url,
    success: false,
    patterns: {}
  };
  
  try {
    const responses = [];
    const pendingHandlers = [];
    
    const responseHandler = async (response) => {
      const handlerPromise = (async () => {
        try {
          const contentType = response.headers()['content-type'] || '';
          const status = response.status();
          
          if (status < 200 || status >= 300) return;
          if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return;
          if (isBinaryResponse(contentType)) return;
          
          let body;
          try {
            body = await response.text();
          } catch (e) {
            return;
          }
          
          if (body.length > MAX_RESPONSE_SIZE) {
            body = body.slice(0, MAX_RESPONSE_SIZE);
          }
          
          if (looksLikeBinary(body)) return;
          
          responses.push(body);
        } catch (e) {
        }
      })();
      pendingHandlers.push(handlerPromise);
    };
    
    page.on('response', responseHandler);
    
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout
    });
    
    await page.waitForTimeout(2000);
    
    page.removeListener('response', responseHandler);
    await Promise.all(pendingHandlers);
    
    const pageContent = await page.content();
    responses.push(pageContent);
    
    // Process each pattern
    for (const patternConfig of patterns) {
      const pattern = typeof patternConfig === 'string' ? patternConfig : patternConfig.pattern;
      const patternId = typeof patternConfig === 'string' ? patternConfig : (patternConfig.id || patternConfig.pattern);
      const hasCaptureGroups = /\((?!\?:)/.test(pattern);
      
      const matchedStrings = new Set();
      let matchCount = 0;
      
      // Run regex on all collected responses
      for (const body of responses) {
        try {
          let matches;
          
          if (hasCaptureGroups) {
            // Extract capture groups
            matches = extractCaptureGroups(pattern, body);
          } else {
            // Run simple regex
            matches = await runRegexWithTimeout(pattern, body);
          }
          
          for (const match of matches) {
            matchedStrings.add(match);
          }
          
          matchCount += matches.length;
        } catch (e) {
          console.error(`Regex error for pattern ${patternId}:`, e.message);
        }
      }
      
      results.patterns[patternId] = {
        count: matchCount,
        matchedStrings: Array.from(matchedStrings),
        uniqueCount: matchedStrings.size,
        timestamp: Date.now()
      };
    }
    
    results.success = true;
    
  } catch (error) {
    results.error = error.message;
    console.error(`Error processing ${url}:`, error.message);
  }
  
  return results;
}

/**
 * Send a Discord webhook notification
 */
async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.log('Discord webhook URL not configured, skipping notification');
    return false;
  }

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
 * Create Discord embed for regex matches
 */
function createMatchesEmbed(pageName, url, patternResults) {
  const fields = [];
  
  for (const [patternId, result] of Object.entries(patternResults)) {
    const count = result.count;
    const uniqueStrings = result.matchedStrings || [];
    
    // Format matched strings as bullet points
    let stringsValue = '';
    if (uniqueStrings.length > 0) {
      // Show up to 20 unique strings
      const displayStrings = uniqueStrings.slice(0, 20);
      stringsValue = displayStrings.map(s => `- \`${s}\``).join('\n');
      
      if (uniqueStrings.length > 20) {
        stringsValue += `\n... and ${uniqueStrings.length - 20} more`;
      }
    } else {
      stringsValue = '(no matches)';
    }
    
    fields.push({
      name: `Pattern: ${patternId}`,
      value: `**Count:** ${count}\n**Unique:** ${result.uniqueCount}\n\n${stringsValue}`
    });
  }
  
  return {
    username: 'Regex Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🔍 Regex Match Detected',
      description: `**${pageName}** ${getRelativeTimestamp()}`,
      url,
      color: 0x8B5CF6,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Regex Watcher',
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Detect changes between current and previous state
 */
function detectChanges(currentResults, previousState, url) {
  const changes = {
    hasChanges: false,
    changes: []
  };
  
  const prevUrlState = previousState[url] || {};
  const prevPatterns = prevUrlState.patterns || {};
  
  for (const [patternId, currentResult] of Object.entries(currentResults.patterns)) {
    const prevResult = prevPatterns[patternId];
    
    const currentCount = currentResult.count || 0;
    const prevCount = prevResult?.count || 0;
    
    // Check for count changes (increase OR decrease)
    if (currentCount !== prevCount) {
      changes.hasChanges = true;
      changes.changes.push({
        patternId,
        previousCount: prevCount,
        currentCount,
        changeType: currentCount > prevCount ? 'increase' : 'decrease',
        matchedStrings: currentResult.matchedStrings
      });
    }
  }
  
  return changes;
}

/**
 * Main function
 */
async function main() {
  console.log('=== Regex Watcher ===');
  console.log('Starting regex scan...');

  const config = loadConfig();
  
  // Validate URLs on startup
  if (!validateUrls(config)) {
    console.error('URL validation failed, exiting');
    process.exit(1);
  }
  
  console.log(`Validated ${config.pages?.length || 0} URL(s)`);

  const statePath = join(__dirname, '..', config.state?.file || 'logs/regex-state.json');
  const previousState = loadState(statePath);

  const webhookUrl = process.env[config.webhook?.webhookEnv];

  if (!webhookUrl) {
    console.error(`Webhook URL not configured (${config.webhook?.webhookEnv} env not set), exiting`);
    process.exit(1);
  }

  const pages = config.pages || [];
  const timeout = config.settings?.timeout || DEFAULT_TIMEOUT;
  const delay = config.settings?.delay || DEFAULT_DELAY;
  
  console.log(`Watching ${pages.length} page(s)`);

  let browser;
  let hasChanges = false;

  try {
    // Launch browser with retry
    browser = await launchBrowser(2);
    const page = await browser.newPage();

    for (let i = 0; i < pages.length; i++) {
      const pageConfig = pages[i];
      console.log(`Processing ${i + 1}/${pages.length}: ${pageConfig.name}`);
      
      try {
        // Process URL and get results
        const results = await processUrl(page, pageConfig.url, pageConfig.patterns, timeout);
        
        if (!results.success) {
          console.log(`Failed to process ${pageConfig.name}: ${results.error}`);
          continue;
        }
        
        // Detect changes
        const changes = detectChanges(results, previousState, pageConfig.url);
        
        if (changes.hasChanges) {
          console.log(`Changes detected for ${pageConfig.name}:`);
          for (const change of changes.changes) {
            const emoji = change.changeType === 'increase' ? '📈' : '📉';
            console.log(`  ${emoji} Pattern "${change.patternId}": ${change.previousCount} -> ${change.currentCount}`);
          }
          
          // Send webhook notification
          const embed = createMatchesEmbed(pageConfig.name, pageConfig.url, results.patterns);
          await sendDiscordWebhook(webhookUrl, embed);
          
          hasChanges = true;
        } else {
          console.log(`No changes for ${pageConfig.name}`);
        }
        
        // Update state
        previousState[pageConfig.url] = {
          patterns: results.patterns
        };
        
      } catch (error) {
        console.error(`Error processing ${pageConfig.name}:`, error.message);
        // Continue with next URL
      }
      
      // Delay between URLs (except for last)
      if (i < pages.length - 1) {
        console.log(`Waiting ${delay}ms before next URL...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

  } catch (error) {
    console.error('Browser error:', error.message);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  // Save state
  saveState(statePath, previousState);

  console.log(`=== Regex scan complete ===`);
}

// Run main function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
