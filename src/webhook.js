import axios from 'axios';

// Use GitHub raw URL for logo
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_MODELS_PER_EMBED = 50;

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
    const embeds = payload.embeds || [];
    const allEmbeds = [];

    // Split embeds that have too many models into multiple embeds
    for (const embed of embeds) {
      if (embed.fields && embed.fields.length > 0) {
        // Count total models across all fields
        let totalModels = 0;
        for (const field of embed.fields) {
          const lines = field.value.split('\n').filter(l => l.trim());
          totalModels += lines.length;
        }

        if (totalModels > MAX_MODELS_PER_EMBED) {
          // Split into multiple embeds
          let currentEmbed = { ...embed, fields: [] };
          let currentCount = 0;

          for (const field of embed.fields) {
            const fieldCount = field.value.split('\n').filter(l => l.trim()).length;

            if (currentCount + fieldCount > MAX_MODELS_PER_EMBED && currentEmbed.fields.length > 0) {
              allEmbeds.push(currentEmbed);
              currentEmbed = { ...embed, fields: [] };
              currentCount = 0;
            }

            currentEmbed.fields.push(field);
            currentCount += fieldCount;
          }

          if (currentEmbed.fields.length > 0) {
            allEmbeds.push(currentEmbed);
          }
        } else {
          allEmbeds.push(embed);
        }
      } else {
        allEmbeds.push(embed);
      }
    }

    // Send in chunks of MAX_EMBEDS_PER_MESSAGE
    for (let i = 0; i < allEmbeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
      const chunk = allEmbeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
      const chunkPayload = {
        username: payload.username,
        avatar_url: payload.avatar_url,
        embeds: chunk
      };
      await axios.post(webhookUrl, chunkPayload, {
        headers: { 'Content-Type': 'application/json' }
      });
    }

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
 * Create a nicely formatted Discord embed for new models
 * @param {string} endpointName - Name of the endpoint
 * @param {Array} models - Array of new models
 * @returns {Object} - Discord embed object
 */
export function createNewModelsEmbed(endpointName, models) {
  const maxPerField = 10;
  const maxTotal = 20;
  const fields = [];
  
  // If too many models, just show count
  if (models.length > maxTotal) {
    return {
      username: 'Model Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🆕 New Models Detected',
        description: `**${endpointName}** added **${models.length}** new models ${getRelativeTimestamp()}!\n\nFull list: [logs/state.json](https://github.com/CloudWaddie/ModelWatcher/blob/master/logs/state.json)`,
        color: 0x10B981,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Model Watcher • AI Model Scanner',
          icon_url: LOGO_URL
        }
      }]
    };
  }
  
  for (let i = 0; i < models.length; i += maxPerField) {
    const chunk = models.slice(i, i + maxPerField);
    const modelList = chunk.map(m => m.id).join('\n');
    const label = models.length > maxPerField 
      ? `New Models (${i + 1}-${Math.min(i + maxPerField, models.length)})`
      : 'New Models';
    
    fields.push({
      name: label,
      value: '```\n' + modelList + '\n```'
    });
  }

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🆕 New Models Detected',
      description: `**${endpointName}** just added ${models.length} new model${models.length > 1 ? 's' : ''} ${getRelativeTimestamp()}!`,
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
  const maxPerField = 10;
  const maxTotal = 20;
  const fields = [];
  
  if (models.length > maxTotal) {
    return {
      username: 'Model Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🗑️ Models Removed',
        description: `**${endpointName}** removed **${models.length}** models ${getRelativeTimestamp()}.\n\nFull list: [logs/state.json](https://github.com/CloudWaddie/ModelWatcher/blob/master/logs/state.json)`,
        color: 0xEF4444,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Model Watcher • AI Model Scanner',
          icon_url: LOGO_URL
        }
      }]
    };
  }
  
  for (let i = 0; i < models.length; i += maxPerField) {
    const chunk = models.slice(i, i + maxPerField);
    const modelList = chunk.map(m => m.id).join('\n');
    const label = models.length > maxPerField 
      ? `Removed Models (${i + 1}-${Math.min(i + maxPerField, models.length)})`
      : 'Removed Models';
    
    fields.push({
      name: label,
      value: '```\n' + modelList + '\n```'
    });
  }

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🗑️ Models Removed',
      description: `**${endpointName}** removed ${models.length} model${models.length > 1 ? 's' : ''} ${getRelativeTimestamp()}.`,
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
  const maxTotal = 20;
  const fields = [];
  
  const diffUrl = 'https://github.com/CloudWaddie/ModelWatcher/commits/master/logs/state.json';
  
  if (updates.length > maxTotal) {
    return {
      username: 'Model Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🔄 Models Updated',
        description: `**${endpointName}** has **${updates.length}** model updates ${getRelativeTimestamp()}.\n\nView changes: [GitHub Diff](${diffUrl})`,
        color: 0xF59E0B,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Model Watcher • AI Model Scanner',
          icon_url: LOGO_URL
        }
      }]
    };
  }
  
  for (let i = 0; i < updates.length; i += maxPerField) {
    const chunk = updates.slice(i, i + maxPerField);
    const changeList = chunk.map(u => {
      const changeKeys = Object.keys(u.changes).join(', ');
      return `${u.model.id}: ${changeKeys}`;
    }).join('\n');
    
    const label = updates.length > maxPerField 
      ? `Updated Models (${i + 1}-${Math.min(i + maxPerField, updates.length)})`
      : 'Updated Models';
    
    fields.push({
      name: label,
      value: '```\n' + changeList + '\n```'
    });
  }

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🔄 Models Updated',
      description: `**${endpointName}** has ${updates.length} model update${updates.length > 1 ? 's' : ''} ${getRelativeTimestamp()}.\n\nView changes: [GitHub Diff](${diffUrl})`,
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
      description: `Failed to fetch models from **${endpointName}** ${getRelativeTimestamp()}`,
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
  const diffUrl = 'https://github.com/CloudWaddie/ModelWatcher/commits/master/logs/state.json';

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🔍 Model Scan Complete',
      description: `${changeEmoji} Scanned **${results.length}** endpoints | ${successCount} success, ${failCount} failed ${getRelativeTimestamp()}\n\nView changes: [GitHub Diff](${diffUrl})`,
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
      description: `Scanned **${results.length}** endpoints - no changes detected ${getRelativeTimestamp()}`,
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
 * @param {Array} endpoints - Endpoint configurations (to get group mapping)
 * @returns {Promise<void>}
 */
export async function processNotifications(config, results, allChanges, endpoints) {
  if (!config.enabled) {
    console.log('Discord notifications disabled');
    return;
  }

  const webhooks = config.webhooks || {};
  const embedUrl = config.url || null;

  // Build endpoint -> group mapping
  const endpointGroups = {};
  for (const ep of endpoints) {
    endpointGroups[ep.name] = ep.group || 'default';
  }

  // Group changes by webhook group
  const groupChanges = {};
  const groupResults = {};
  
  for (const [endpointName, changes] of Object.entries(allChanges)) {
    const group = endpointGroups[endpointName] || 'default';
    if (!groupChanges[group]) {
      groupChanges[group] = {};
      groupResults[group] = [];
    }
    groupChanges[group][endpointName] = changes;
  }
  
  for (const result of results) {
    const group = endpointGroups[result.endpoint] || 'default';
    if (!groupResults[group]) {
      groupResults[group] = [];
    }
    groupResults[group].push(result);
  }

  // Process each group
  for (const [groupName, groupConfig] of Object.entries(webhooks)) {
    const webhookUrl = process.env[groupConfig.webhookEnv];
    const notifyOn = groupConfig.notifyOn || [];
    
    if (!webhookUrl) {
      console.log(`Discord webhook for group "${groupName}" not set (${groupConfig.webhookEnv} env), skipping`);
      continue;
    }

    const groupChangesList = groupChanges[groupName] || {};
    const groupResultsList = groupResults[groupName] || [];
    
    // Skip if no results for this group
    if (groupResultsList.length === 0) {
      continue;
    }

    let totalAdded = 0;
    let totalRemoved = 0;
    let totalUpdated = 0;
    
    for (const changes of Object.values(groupChangesList)) {
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

    // Helper to add URL to embed
    const withUrl = (payload) => {
      if (embedUrl && payload.embeds?.[0]) {
        payload.embeds[0].url = embedUrl;
      }
      return payload;
    };

    // Send summary only if there are changes
    if (hasChanges && notifyOn.includes('summary_with_changes')) {
      await sendDiscordWebhook(webhookUrl, withUrl(createSummaryEmbed(summary, groupResultsList)));
    }

    // Send endpoint errors (skip if API key not configured)
    if (notifyOn.includes('endpoint_error')) {
      for (const result of groupResultsList) {
        if (!result.success && result.error && result.configured === false) {
          continue;
        }
        if (!result.success && result.error) {
          await sendDiscordWebhook(webhookUrl, withUrl(createErrorEmbed(result.endpoint, result.error)));
        }
      }
    }

    // Send new models notifications
    if (notifyOn.includes('new_model')) {
      for (const [endpoint, changes] of Object.entries(groupChangesList)) {
        if (changes.added && changes.added.length > 0) {
          await sendDiscordWebhook(webhookUrl, withUrl(createNewModelsEmbed(endpoint, changes.added)));
        }
      }
    }

    // Send removed models notifications
    if (notifyOn.includes('removed_model')) {
      for (const [endpoint, changes] of Object.entries(groupChangesList)) {
        if (changes.removed && changes.removed.length > 0) {
          await sendDiscordWebhook(webhookUrl, withUrl(createRemovedModelsEmbed(endpoint, changes.removed)));
        }
      }
    }

    // Send updated models notifications
    if (notifyOn.includes('model_updated')) {
      for (const [endpoint, changes] of Object.entries(groupChangesList)) {
        if (changes.updated && changes.updated.length > 0) {
          await sendDiscordWebhook(webhookUrl, withUrl(createUpdatedModelsEmbed(endpoint, changes.updated)));
        }
      }
    }
  }
}
