import axios from 'axios';
import { saveStateIfChanged } from './state-file.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use GitHub raw URL for logo
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

/**
 * Load configuration from designarena-config.json
 * @returns {Object} Configuration object
 */
function loadConfig() {
  const configPath = join(__dirname, '..', 'designarena-config.json');
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
  saveStateIfChanged(statePath, state, 2);
}

/**
 * Fetch models from designarena.ai API
 * @returns {Promise<Object>} API response with models
 */
async function fetchModels(scanConfig) {
  const url = scanConfig?.apiUrl || 'https://www.designarena.ai/api/registry';
  console.log('Fetching models from designarena.ai...');
  
  try {
    const response = await axios.get(url, {
      timeout: scanConfig?.timeout || 30000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ModelWatcher/1.0'
      }
    });
    
    const data = response.data;
    const modelsData = data.models || {};
    const providersData = data.providers || {};
    const pricingData = data.pricing || {};
    
    const models = Object.entries(modelsData).map(([id, model]) => ({
      id,
      ...model
    }));
    
    const providers = Object.entries(providersData).map(([id, provider]) => ({
      id,
      ...provider
    }));
    
    const pricing = Object.entries(pricingData).map(([id, price]) => ({
      id,
      ...price
    }));
    
    console.log(`Found ${models.length} models, ${providers.length} providers, ${pricing.length} pricing entries from designarena.ai`);
    return { success: true, models, providers, pricing };
  } catch (error) {
    console.error('Failed to fetch designarena.ai models:', error.message);
    return { success: false, error: error.message };
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
 * Create Discord embed for new models
 * @param {Array} addedModels - Array of new models
 * @returns {Object} Discord embed object
 */
function createNewModelsEmbed(addedModels) {
  const maxPerField = 15;
  const maxTotal = 30;
  const fields = [];
  
  // If too many models, just show count
  if (addedModels.length > maxTotal) {
    return {
      username: 'Design Arena Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🆕 New Models Detected',
        description: `**Design Arena** added **${addedModels.length}** new models ${getRelativeTimestamp()}!\n\nFull list: [logs/designarena-state.json](https://github.com/CloudWaddie/ModelWatcher/blob/master/logs/designarena-state.json)`,
        color: 0x10B981,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Design Arena Watcher',
          icon_url: LOGO_URL
        }
      }]
    };
  }
  
  for (let i = 0; i < addedModels.length; i += maxPerField) {
    const chunk = addedModels.slice(i, i + maxPerField);
    const modelList = chunk.map(m => `${m.id} (${m.provider})`).join('\n');
    const label = addedModels.length > maxPerField 
      ? `New Models (${i + 1}-${Math.min(i + maxPerField, addedModels.length)})`
      : 'New Models';
    
    fields.push({
      name: label,
      value: '```\n' + modelList + '\n```'
    });
  }

  return {
    username: 'Design Arena Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🆕 New Models Detected',
      description: `**Design Arena** just added ${addedModels.length} new model${addedModels.length > 1 ? 's' : ''} ${getRelativeTimestamp()}!`,
      color: 0x10B981,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Design Arena Watcher',
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Create Discord embed for removed models
 * @param {Array} removedModels - Array of removed models
 * @returns {Object} Discord embed object
 */
function createRemovedModelsEmbed(removedModels) {
  const maxPerField = 15;
  const maxTotal = 30;
  const fields = [];
  
  if (removedModels.length > maxTotal) {
    return {
      username: 'Design Arena Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🗑️ Models Removed',
        description: `**Design Arena** removed **${removedModels.length}** models ${getRelativeTimestamp()}.\n\nFull list: [logs/designarena-state.json](https://github.com/CloudWaddie/ModelWatcher/blob/master/logs/designarena-state.json)`,
        color: 0xEF4444,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Design Arena Watcher',
          icon_url: LOGO_URL
        }
      }]
    };
  }
  
  for (let i = 0; i < removedModels.length; i += maxPerField) {
    const chunk = removedModels.slice(i, i + maxPerField);
    const modelList = chunk.map(m => m.id).join('\n');
    const label = removedModels.length > maxPerField 
      ? `Removed Models (${i + 1}-${Math.min(i + maxPerField, removedModels.length)})`
      : 'Removed Models';
    
    fields.push({
      name: label,
      value: '```\n' + modelList + '\n```'
    });
  }

  return {
    username: 'Design Arena Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🗑️ Models Removed',
      description: `**Design Arena** removed ${removedModels.length} model${removedModels.length > 1 ? 's' : ''} ${getRelativeTimestamp()}.`,
      color: 0xEF4444,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Design Arena Watcher',
        icon_url: LOGO_URL
      }
    }]
  };
}

function createProviderChangesEmbed(providers) {
  const maxPerField = 15;
  const maxTotal = 30;
  const fields = [];
  
  const added = providers.added || [];
  const removed = providers.removed || [];
  
  if (added.length === 0 && removed.length === 0) {
    return null;
  }
  
  if (added.length + removed.length > maxTotal) {
    return {
      username: 'Design Arena Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🏢 Providers Changed',
        description: `**Design Arena** had **${added.length}** providers added and **${removed.length}** removed ${getRelativeTimestamp()}`,
        color: 0x8B5CF6,
        timestamp: new Date().toISOString(),
        footer: { text: 'Design Arena Watcher', icon_url: LOGO_URL }
      }]
    };
  }
  
  if (added.length > 0) {
    const addedList = added.map(p => `${p.id} (${p.displayName || 'N/A'})`).join('\n');
    fields.push({ name: `Added Providers (${added.length})`, value: '```\n' + addedList + '\n```' });
  }
  
  if (removed.length > 0) {
    const removedList = removed.map(p => p.id).join('\n');
    fields.push({ name: `Removed Providers (${removed.length})`, value: '```\n' + removedList + '\n```' });
  }
  
  return {
    username: 'Design Arena Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🏢 Providers Changed',
      description: `**Design Arena** had ${added.length} providers added and ${removed.length} removed ${getRelativeTimestamp()}`,
      color: 0x8B5CF6,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'Design Arena Watcher', icon_url: LOGO_URL }
    }]
  };
}

function createPricingChangesEmbed(pricing) {
  const maxPerField = 15;
  const maxTotal = 30;
  const fields = [];
  
  const added = pricing.added || [];
  const removed = pricing.removed || [];
  
  if (added.length === 0 && removed.length === 0) {
    return null;
  }
  
  if (added.length + removed.length > maxTotal) {
    return {
      username: 'Design Arena Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '💰 Pricing Changed',
        description: `**Design Arena** had **${added.length}** pricing entries added and **${removed.length}** removed ${getRelativeTimestamp()}`,
        color: 0xF59E0B,
        timestamp: new Date().toISOString(),
        footer: { text: 'Design Arena Watcher', icon_url: LOGO_URL }
      }]
    };
  }
  
  if (added.length > 0) {
    const addedList = added.map(p => p.id).join('\n');
    fields.push({ name: `Added Pricing (${added.length})`, value: '```\n' + addedList + '\n```' });
  }
  
  if (removed.length > 0) {
    const removedList = removed.map(p => p.id).join('\n');
    fields.push({ name: `Removed Pricing (${removed.length})`, value: '```\n' + removedList + '\n```' });
  }
  
  return {
    username: 'Design Arena Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '💰 Pricing Changed',
      description: `**Design Arena** had ${added.length} pricing entries added and ${removed.length} removed ${getRelativeTimestamp()}`,
      color: 0xF59E0B,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'Design Arena Watcher', icon_url: LOGO_URL }
    }]
  };
}

/**
 * Detect changes between current and previous state
 * @param {Array} currentModels - Current models from API
 * @param {Array} previousModels - Previous models from state
 * @param {Array} currentProviders - Current providers from API
 * @param {Array} previousProviders - Previous providers from state
 * @param {Array} currentPricing - Current pricing from API
 * @param {Array} previousPricing - Previous pricing from state
 * @returns {Object} Changes detected
 */
function detectChanges(currentModels, previousModels, currentProviders, previousProviders, currentPricing, previousPricing) {
  const currentModelIds = new Set(currentModels.map(m => m.id));
  const previousModelIds = new Set(previousModels.map(m => m.id));
  
  const addedModels = currentModels.filter(m => !previousModelIds.has(m.id));
  const removedModels = previousModels.filter(m => !currentModelIds.has(m.id));
  
  const currentProviderIds = new Set(currentProviders.map(p => p.id));
  const previousProviderIds = new Set(previousProviders.map(p => p.id));
  
  const addedProviders = currentProviders.filter(p => !previousProviderIds.has(p.id));
  const removedProviders = previousProviders.filter(p => !currentProviderIds.has(p.id));
  
  const currentPricingIds = new Set(currentPricing.map(p => p.id));
  const previousPricingIds = new Set(previousPricing.map(p => p.id));
  
  const addedPricing = currentPricing.filter(p => !previousPricingIds.has(p.id));
  const removedPricing = previousPricing.filter(p => !currentPricingIds.has(p.id));
  
  return {
    hasChanges: addedModels.length > 0 || removedModels.length > 0 || addedProviders.length > 0 || removedProviders.length > 0 || addedPricing.length > 0 || removedPricing.length > 0,
    models: { added: addedModels, removed: removedModels },
    providers: { added: addedProviders, removed: removedProviders },
    pricing: { added: addedPricing, removed: removedPricing },
    summary: {
      modelsAdded: addedModels.length,
      modelsRemoved: removedModels.length,
      providersAdded: addedProviders.length,
      providersRemoved: removedProviders.length,
      pricingAdded: addedPricing.length,
      pricingRemoved: removedPricing.length
    }
  };
}

/**
 * Main function to check designarena.ai and post notifications
 */
async function main() {
  console.log('=== Design Arena Watcher ===');
  console.log('Starting model check...');
  
  const config = loadConfig();
  const statePath = join(__dirname, '..', config.state?.file || 'logs/designarena-state.json');
  const previousState = loadState(statePath);
  
  const webhookUrl = process.env[config.webhook?.webhookEnv];
  
  if (!webhookUrl) {
    console.error(`Webhook URL not configured (${config.webhook?.webhookEnv} env not set), exiting`);
    process.exit(1);
  }
  
  // Fetch current models
  const result = await fetchModels(config.scan);
  
  if (!result.success) {
    console.error('Failed to fetch models:', result.error);
    process.exit(1);
  }
  
  const currentModels = result.models;
  const currentProviders = result.providers;
  const currentPricing = result.pricing;
  const previousModels = previousState.models || [];
  const previousProviders = previousState.providers || [];
  const previousPricing = previousState.pricing || [];
  
  const changes = detectChanges(currentModels, previousModels, currentProviders, previousProviders, currentPricing, previousPricing);
  
  if (changes.hasChanges) {
    console.log(`Changes detected: ${changes.summary.modelsAdded} models added, ${changes.summary.modelsRemoved} models removed, ${changes.summary.providersAdded} providers added, ${changes.summary.providersRemoved} providers removed, ${changes.summary.pricingAdded} pricing added, ${changes.summary.pricingRemoved} pricing removed`);
    
    if (changes.models.added.length > 0) {
      const embed = createNewModelsEmbed(changes.models.added);
      await sendDiscordWebhook(webhookUrl, embed);
    }
    
    if (changes.models.removed.length > 0) {
      const embed = createRemovedModelsEmbed(changes.models.removed);
      await sendDiscordWebhook(webhookUrl, embed);
    }
    
    if (changes.providers.added.length > 0 || changes.providers.removed.length > 0) {
      const embed = createProviderChangesEmbed(changes.providers);
      await sendDiscordWebhook(webhookUrl, embed);
    }
    
    if (changes.pricing.added.length > 0 || changes.pricing.removed.length > 0) {
      const embed = createPricingChangesEmbed(changes.pricing);
      await sendDiscordWebhook(webhookUrl, embed);
    }
  } else {
    console.log('No changes detected');
  }
  
  const newState = {
    timestamp: Date.now(),
    models: currentModels,
    providers: currentProviders,
    pricing: currentPricing
  };
  saveState(statePath, newState);
  
  console.log(`=== Design Arena scan complete: ${currentModels.length} models ===`);
}

// Run main function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});