import axios from 'axios';

// Discord has issues with GitHub raw URLs sometimes, use embed without custom avatar
const LOGO_URL = null;

/**
 * Send a Discord webhook notification
 * @param {string} webhookUrl - Discord webhook URL
 * @param {Object} payload - Embed payload
 * @returns {Promise<boolean>} - Success status
 */
export async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.log('Discord webhook URL not configured, skipping notification');
    return false;
  }

  try {
    const response = await axios.post(webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    return true;
  } catch (err) {
    // Log more details for debugging
    const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Failed to send Discord webhook:', err.response?.status, details);
    return false;
  }
}

/**
 * Create a nicely formatted Discord embed for new models
 * @param {string} endpointName - Name of the endpoint
 * @param {Array} models - Array of new models
 * @returns {Object} - Discord embed object
 */
export function createNewModelsEmbed(endpointName, models) {
  const maxPerField = 15;
  const fields = [];
  
  for (let i = 0; i < models.length; i += maxPerField) {
    const chunk = models.slice(i, i + maxPerField);
    const modelList = chunk.map(m => `• \`${m.id}\``).join('\n');
    const label = models.length > maxPerField 
      ? `New Models (${i + 1}-${Math.min(i + maxPerField, models.length)})`
      : 'New Models';
    
    fields.push({
      name: label,
      value: modelList
    });
  }

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🆕 New Models Detected',
      description: `**${endpointName}** just added ${models.length} new model${models.length > 1 ? 's' : ''}!`,
      color: 0x10B981,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Model Watcher • AI Model Scanner',
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Create Discord embed for removed models
 * @param {string} endpointName - Name of the endpoint
 * @param {Array} models - Array of removed models
 * @returns {Object} - Discord embed object
 */
export function createRemovedModelsEmbed(endpointName, models) {
  const maxPerField = 15;
  const fields = [];
  
  for (let i = 0; i < models.length; i += maxPerField) {
    const chunk = models.slice(i, i + maxPerField);
    const modelList = chunk.map(m => `• \`${m.id}\``).join('\n');
    const label = models.length > maxPerField 
      ? `Removed Models (${i + 1}-${Math.min(i + maxPerField, models.length)})`
      : 'Removed Models';
    
    fields.push({
      name: label,
      value: modelList
    });
  }

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🗑️ Models Removed',
      description: `**${endpointName}** removed ${models.length} model${models.length > 1 ? 's' : ''}.`,
      color: 0xEF4444,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Model Watcher • AI Model Scanner',
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Create Discord embed for updated models
 * @param {string} endpointName - Name of the endpoint
 * @param {Array} updates - Array of updated models with changes
 * @returns {Object} - Discord embed object
 */
export function createUpdatedModelsEmbed(endpointName, updates) {
  const maxPerField = 10;
  const fields = [];
  
  for (let i = 0; i < updates.length; i += maxPerField) {
    const chunk = updates.slice(i, i + maxPerField);
    const changeList = chunk.map(u => {
      const changeKeys = Object.keys(u.changes).join(', ');
      return `• \`${u.model.id}\`\n  ↳ Changed: ${changeKeys}`;
    }).join('\n');
    
    const label = updates.length > maxPerField 
      ? `Updated Models (${i + 1}-${Math.min(i + maxPerField, updates.length)})`
      : 'Updated Models';
    
    fields.push({
      name: label,
      value: changeList
    });
  }

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🔄 Models Updated',
      description: `**${endpointName}** has ${updates.length} model update${updates.length > 1 ? 's' : ''}.`,
      color: 0xF59E0B,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Model Watcher • AI Model Scanner',
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Create Discord embed for endpoint errors
 * @param {string} endpointName - Name of the endpoint
 * @param {string} error - Error message
 * @returns {Object} - Discord embed object
 */
export function createErrorEmbed(endpointName, error) {
  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '⚠️ Endpoint Error',
      description: `Failed to fetch models from **${endpointName}**`,
      color: 0xF97316,
      fields: [
        {
          name: 'Error Details',
          value: `\`\`\`\n${error.substring(0, 500)}\n\`\`\``
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Model Watcher • AI Model Scanner',
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Create a summary embed for scan results with changes
 * @param {Object} summary - Scan summary
 * @param {Array} results - Endpoint results
 * @returns {Object} - Discord embed object
 */
export function createSummaryEmbed(summary, results) {
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  
  const endpointFields = [];
  let currentField = { name: 'Endpoints', value: '' };
  
  for (const result of results) {
    const emoji = result.success ? '🟢' : '🔴';
    const count = result.success ? `${result.models.length} models` : 'Failed';
    const line = `${emoji} **${result.endpoint}**: ${count}`;
    
    if (currentField.value.length + line.length > 1000) {
      endpointFields.push(currentField);
      currentField = { name: 'Endpoints (cont.)', value: '' };
    }
    
    currentField.value += line + '\n';
  }
  
  endpointFields.push(currentField);

  let color = 0x3B82F6;
  if (summary.addedCount > 0 && summary.removedCount === 0) {
    color = 0x10B981;
  } else if (summary.removedCount > 0) {
    color = 0xEF4444;
  }

  const changeEmoji = summary.addedCount > 0 ? '📈' : summary.removedCount > 0 ? '📉' : '➡️';

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🔍 Model Scan Complete',
      description: `${changeEmoji} Scanned **${results.length}** endpoints | ${successCount} success, ${failCount} failed`,
      color,
      fields: [
        {
          name: 'Changes This Scan',
          value: `➕ **${summary.addedCount}** added | ➖ **${summary.removedCount}** removed | 🔄 **${summary.updatedCount}** updated`,
          inline: false
        },
        ...endpointFields
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Model Watcher • Hourly Scan',
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Create a compact summary embed (for when there are no changes)
 * @param {Array} results - Endpoint results
 * @returns {Object} - Discord embed object
 */
export function createCompactSummaryEmbed(results) {
  const successCount = results.filter(r => r.success).length;
  
  const endpointStatus = results.map(r => {
    const emoji = r.success ? '✅' : '❌';
    const count = r.success ? r.models.length : 0;
    return `${emoji} ${r.endpoint}: ${count}`;
  }).join('\n');

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '✅ No Model Changes',
      description: `Scanned **${results.length}** endpoints - no changes detected`,
      color: 0x6B7280,
      fields: [
        {
          name: `Status (${successCount}/${results.length} online)`,
          value: endpointStatus.substring(0, 1024)
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Model Watcher • Hourly Scan',
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Process scan results and send appropriate Discord notifications
 * @param {Object} config - Discord configuration
 * @param {Array} results - Scan results from all endpoints
 * @param {Object} allChanges - Changes detected across all endpoints
 * @returns {Promise<void>}
 */
export async function processNotifications(config, results, allChanges) {
  if (!config.enabled) {
    console.log('Discord notifications disabled');
    return;
  }

  const webhookUrl = process.env[config.webhookEnv];
  const notifyOn = config.notifyOn || [];

  if (!webhookUrl) {
    console.log('Discord webhook URL not set (WEBHOOK env), skipping notifications');
    return;
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  let totalUpdated = 0;
  
  for (const changes of Object.values(allChanges)) {
    if (changes.summary) {
      totalAdded += changes.summary.addedCount;
      totalRemoved += changes.summary.removedCount;
      totalUpdated += changes.summary.updatedCount;
    }
  }

  const hasChanges = totalAdded > 0 || totalRemoved > 0 || totalUpdated > 0;

  const summary = {
    addedCount: totalAdded,
    removedCount: totalRemoved,
    updatedCount: totalUpdated
  };

  // Send summary only if there are changes (not when there's no changes)
  // The detailed embeds (new_model, removed_model, etc.) will be sent below
  if (hasChanges && notifyOn.includes('summary_with_changes')) {
    await sendDiscordWebhook(webhookUrl, createSummaryEmbed(summary, results));
  }

  // Send endpoint errors (skip if API key not configured)
  if (notifyOn.includes('endpoint_error')) {
    for (const result of results) {
      // Skip endpoints that weren't configured (no API key)
      if (!result.success && result.error && result.configured === false) {
        continue;
      }
      if (!result.success && result.error) {
        await sendDiscordWebhook(webhookUrl, createErrorEmbed(result.endpoint, result.error));
      }
    }
  }

  // Send new models notifications
  if (notifyOn.includes('new_model')) {
    for (const [endpoint, changes] of Object.entries(allChanges)) {
      if (changes.added && changes.added.length > 0) {
        await sendDiscordWebhook(webhookUrl, createNewModelsEmbed(endpoint, changes.added));
      }
    }
  }

  // Send removed models notifications
  if (notifyOn.includes('removed_model')) {
    for (const [endpoint, changes] of Object.entries(allChanges)) {
      if (changes.removed && changes.removed.length > 0) {
        await sendDiscordWebhook(webhookUrl, createRemovedModelsEmbed(endpoint, changes.removed));
      }
    }
  }

  // Send updated models notifications
  if (notifyOn.includes('model_updated')) {
    for (const [endpoint, changes] of Object.entries(allChanges)) {
      if (changes.updated && changes.updated.length > 0) {
        await sendDiscordWebhook(webhookUrl, createUpdatedModelsEmbed(endpoint, changes.updated));
      }
    }
  }
}
