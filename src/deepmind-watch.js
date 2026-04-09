import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Base URL for Google DeepMind model cards
const BASE_URL = 'https://storage.googleapis.com/deepmind-media/Model-Cards';

// Use GitHub raw URL for logo
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

/**
 * Load configuration from config file
 * @param {string} configFile - Config file name
 * @returns {Object} Configuration object
 */
function loadConfig(configFile) {
  const configPath = join(__dirname, '..', configFile);
  const configContent = readFileSync(configPath, 'utf-8');
  return JSON.parse(configContent);
}

/**
 * Load state from state file
 * @param {string} statePath - Path to state file
 * @returns {Object} State object
 */
function loadState(statePath) {
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch (e) {
      console.error('Failed to parse state file, starting fresh:', e.message);
    }
  }
  return {};
}

/**
 * Save state to state file
 * @param {string} statePath - Path to state file
 * @param {Object} state - State object to save
 */
function saveState(statePath, state) {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function generatePermutations(config) {
  const permutations = [];
  
  const patterns = config.patterns || [];
  const versions = config.versions || [];
  const variants = config.variants || {};
  
  for (const pattern of patterns) {
    const baseModel = pattern.split('-')[0];
    const modelVariants = variants[baseModel] || [];
    
    const hasVersion = pattern.includes('{version}');
    const hasVariant = pattern.includes('{variant}');
    
    if (!hasVersion && !hasVariant) {
      permutations.push(pattern);
      continue;
    }
    
    if (hasVersion && hasVariant) {
      for (const version of versions) {
        for (const variant of modelVariants) {
          permutations.push(pattern
            .replace('{version}', version)
            .replace('{variant}', variant));
        }
      }
    } else if (hasVersion) {
      for (const version of versions) {
        permutations.push(pattern.replace('{version}', version));
      }
    } else if (hasVariant) {
      for (const variant of modelVariants) {
        permutations.push(pattern.replace('{variant}', variant));
      }
    }
  }
  
  return [...new Set(permutations)];
}

/**
 * Check if a model card file exists
 * @param {string} filename - Filename to check
 * @returns {Promise<Object>} Result with status
 */
async function checkModelCard(filename) {
  const url = `${BASE_URL}/${filename}`;
  
  try {
    const response = await axios.head(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'ModelWatcher/1.0'
      }
    });
    
    // Check content-length to confirm it's a real file (not an error page)
    const contentLength = response.headers['content-length'];
    if (contentLength && parseInt(contentLength, 10) > 100) {
      return { exists: true, url, filename, status: response.status };
    }
    
    return { exists: false, url, filename, reason: 'empty_or_error' };
  } catch (error) {
    if (error.response?.status === 404) {
      return { exists: false, url, filename, reason: 'not_found' };
    }
    return { exists: false, url, filename, reason: error.message };
  }
}

/**
 * Send a Discord webhook notification
 * @param {string} webhookUrl - Discord webhook URL
 * @param {Object} payload - Embed payload
 * @returns {Promise<boolean>} - Success status
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
 * Get Discord relative timestamp string
 * @returns {string} - Discord timestamp format
 */
function getRelativeTimestamp() {
  const unixSeconds = Math.floor(Date.now() / 1000);
  return `<t:${unixSeconds}:R>`;
}

/**
 * Create Discord embed for new model cards
 * @param {Array} newCards - Array of new model cards
 * @returns {Object} Discord embed object
 */
function createNewCardsEmbed(newCards) {
  const maxPerField = 10;
  const maxTotal = 20;
  const fields = [];
  
  if (newCards.length > maxTotal) {
    return {
      username: 'DeepMind Model Card Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '📄 New Model Card Detected!',
        description: `**DeepMind** released **${newCards.length}** new model card${newCards.length > 1 ? 's' : ''} ${getRelativeTimestamp()}`,
        color: 0x10B981,
        timestamp: new Date().toISOString(),
        footer: { text: 'DeepMind Model Card Watcher', icon_url: LOGO_URL }
      }]
    };
  }
  
  for (let i = 0; i < newCards.length; i += maxPerField) {
    const chunk = newCards.slice(i, i + maxPerField);
    const cardList = chunk.map(c => c.filename).join('\n');
    const label = newCards.length > maxPerField 
      ? `New Cards (${i + 1}-${Math.min(i + maxPerField, newCards.length)})`
      : 'New Model Cards';
    
    fields.push({
      name: label,
      value: '```\n' + cardList + '\n```'
    });
  }
  
  return {
    username: 'DeepMind Model Card Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '📄 New Model Card Detected!',
      description: `**DeepMind** released ${newCards.length} new model card${newCards.length > 1 ? 's' : ''} ${getRelativeTimestamp()}`,
      color: 0x10B981,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'DeepMind Model Card Watcher', icon_url: LOGO_URL }
    }]
  };
}

/**
 * Main function to check DeepMind model cards
 */
async function main() {
  console.log('=== DeepMind Model Card Watcher ===');
  console.log('Starting model card check...');
  
  const config = loadConfig('deepmind-config.json');
  const statePath = join(__dirname, '..', config.state?.file || 'logs/deepmind-state.json');
  const previousState = loadState(statePath);
  
  const webhookUrl = process.env[config.webhook?.webhookEnv];
  
  if (!webhookUrl) {
    console.error(`Webhook URL not configured (${config.webhook?.webhookEnv} env not set), exiting`);
    process.exit(1);
  }
  
  // Generate permutations based on config
  const filenames = generatePermutations(config.permutations);
  console.log(`Checking ${filenames.length} model card permutations...`);
  
  // Check all permutations in parallel
  const results = await Promise.all(
    filenames.map(filename => checkModelCard(filename))
  );
  
  // Filter to only existing cards
  const existingCards = results.filter(r => r.exists);
  console.log(`Found ${existingCards.length} existing model cards`);
  
  // Get previous existing cards
  const previousCards = previousState.cards || [];
  const previousFilenames = new Set(previousCards.map(c => c.filename));
  
  // Find new cards
  const newCards = existingCards.filter(c => !previousFilenames.has(c.filename));
  
  if (newCards.length > 0) {
    console.log(`New model cards detected: ${newCards.map(c => c.filename).join(', ')}`);
    
    const embed = createNewCardsEmbed(newCards);
    await sendDiscordWebhook(webhookUrl, embed);
  } else {
    console.log('No new model cards detected');
  }
  
  // Save state
  const newState = {
    timestamp: Date.now(),
    cards: existingCards
  };
  saveState(statePath, newState);
  
  console.log(`=== DeepMind scan complete: ${existingCards.length} model cards ===`);
}

// Run main function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
