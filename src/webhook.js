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
 * Format a value for display in diff
 * Escapes backticks to prevent breaking Discord code blocks
 */
function formatValue(val) {
  if (val === null || val === undefined) return '(none)';
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

/**
 * Escape backticks in a string for use in Discord code blocks
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeBackticks(str) {
  return str.replace(/`/g, '`\u200b');
}

/**
 * Format a single change as a git diff style string
 * @param {string} key - Property name that changed
 * @param {Object} change - Object with old and new values
 * @returns {string} - Formatted diff string
 */
function formatDiffLine(key, change) {
  const oldVal = escapeBackticks(formatValue(change.old));
  const newVal = escapeBackticks(formatValue(change.new));
  return `-${key}: ${oldVal}\n+${key}: ${newVal}`;
}

/**
 * Create Discord embed for updated models
 * @param {string} endpointName - Name of the endpoint
 * @param {Array} updates - Array of updated models with changes
 * @param {string} commitSha - Optional commit SHA for direct link
 * @returns {Object} - Discord embed object
 */
export function createUpdatedModelsEmbed(endpointName, updates, commitSha = null) {
  const maxPerField = 10;
  const maxTotal = 20;
  const fields = [];
  
  const baseUrl = 'https://github.com/CloudWaddie/ModelWatcher';
  const diffUrl = commitSha 
    ? `${baseUrl}/commit/${commitSha}`
    : `${baseUrl}/commits/master/logs/state.json`;
  
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
      const changeLines = Object.entries(u.changes).map(([key, change]) => {
        return formatDiffLine(key, change);
      }).join('\n');
      return `**${u.model.id}**\n\`\`\`\n${changeLines}\n\`\`\``;
    }).join('\n');
    
    // Truncate if too long (Discord max field value is 1024)
    let truncatedList = changeList;
    if (changeList.length > 1000) {
      truncatedList = changeList.substring(0, 997) + '...';
    }
    
    const label = updates.length > maxPerField 
      ? `Updated Models (${i + 1}-${Math.min(i + maxPerField, updates.length)})`
      : 'Updated Models';
    
    fields.push({
      name: label,
      value: truncatedList
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
 * @param {string} commitSha - Optional commit SHA for direct link
 * @returns {Object} - Discord embed object
 */
export function createSummaryEmbed(summary, results, commitSha = null) {
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
  const baseUrl = 'https://github.com/CloudWaddie/ModelWatcher';
  const diffUrl = commitSha 
    ? `${baseUrl}/commit/${commitSha}`
    : `${baseUrl}/commits/master/logs/state.json`;

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
 * @param {string} commitSha - Optional commit SHA for direct link
 * @returns {Promise<void>}
 */
export async function processNotifications(config, results, allChanges, endpoints, commitSha = null) {
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
      await sendDiscordWebhook(webhookUrl, withUrl(createSummaryEmbed(summary, groupResultsList, commitSha)));
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
          await sendDiscordWebhook(webhookUrl, withUrl(createUpdatedModelsEmbed(endpoint, changes.updated, commitSha)));
        }
      }
    }
  }
}

/**
 * Send a Discord webhook without model-splitting logic (for raw diffs)
 * @param {string} webhookUrl - Discord webhook URL
 * @param {Object} payload - Embed payload
 * @returns {Promise<boolean>} - Success status
 */
export async function sendRawDiffWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.log('Discord webhook URL not configured, skipping notification');
    return false;
  }

  try {
    const embeds = payload.embeds || [];

    // Send in chunks of MAX_EMBEDS_PER_MESSAGE
    for (let i = 0; i < embeds.length; i += MAX_EMBEDS_PER_MESSAGE) {
      const chunk = embeds.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
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
 * Convert simple HTML to Discord-compatible markdown
 */
function htmlToMarkdown(html) {
  if (!html) return html;
  return html
    // Line breaks
    .replace(/<br\s*\/?>\n?/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n\n')
    .replace(/<p>\s*/gi, '')
    // Lists
    .replace(/<ul>\n?/gi, '')
    .replace(/<\/ul>\n?/gi, '')
    .replace(/<ol>\n?/gi, '')
    .replace(/<\/ol>\n?/gi, '')
    .replace(/<li>\n?/gi, '• ')
    .replace(/<\/li>\n?/gi, '\n')
    // Inline formatting
    .replace(/<strong>/gi, '**')
    .replace(/<\/strong>/gi, '**')
    .replace(/<b>/gi, '**')
    .replace(/<\/b>/gi, '**')
    .replace(/<i>/gi, '*')
    .replace(/<\/i>/gi, '*')
    .replace(/<em>/gi, '*')
    .replace(/<\/em>/gi, '*')
    .replace(/<code>/gi, '`')
    .replace(/<\/code>/gi, '`')
    // Links
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>/gi, '[$1]($1)')
    .replace(/<\/a>/gi, '')
    // Strip remaining tags
    .replace(/<[^>]*>/g, '')
    // HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse multiple newlines to max 2
    .replace(/\n{3,}/g, '\n\n')
    // Trim each line
    .split('\n').map(l => l.trim()).join('\n')
    .trim();
}

/**
 * Create a nice Discord embed for a new app version
 * @param {Object} appInfo - App version info
 * @returns {Object} - Discord embed payload
 */
export function createAppVersionEmbed(appInfo) {
  const platformEmoji = appInfo.platform === 'android' ? '🤖' : '🍎';
  const color = appInfo.platform === 'android' ? 0x3DDC84 : 0x5FC9F8;

  const rawDescription = appInfo.description || 'No description available.';
  const rawReleaseNotes = appInfo.recentChanges || 'No release notes available.';

  const description = htmlToMarkdown(rawDescription);
  const releaseNotes = htmlToMarkdown(rawReleaseNotes);

  return {
    username: 'App Version Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: `${platformEmoji} ${appInfo.title} — v${appInfo.version}`,
      url: appInfo.url,
      description: description.length > 300 ? description.substring(0, 297) + '...' : description,
      color,
      thumbnail: {
        url: appInfo.icon
      },
      fields: [
        {
          name: '📝 Release Notes',
          value: releaseNotes.substring(0, 1024) || '(none)'
        },
        {
          name: '🏢 Developer',
          value: appInfo.developer || 'Unknown',
          inline: true
        },
        {
          name: '📦 App ID',
          value: `\`${appInfo.appId}\``,
          inline: true
        },
        {
          name: '🏬 Store',
          value: appInfo.platform === 'android' ? 'Google Play' : 'App Store',
          inline: true
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: `App Version Watcher \u2022 ${appInfo.platform.toUpperCase()}`,
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Create Discord embed(s) for a raw strings diff with red/green highlighting
 * Uses Discord ```diff code blocks so - lines are red and + lines are green
 * @param {string} appId - App package ID
 * @param {string} diffText - Raw diff text
 * @returns {Object} - Discord embed payload
 */
// Organization color map for LM Arena
const ORG_COLORS = {
  openai: 0x10a37f,
  anthropic: 0xd97757,
  google: 0x4285f4,
  xai: 0x1c1c1c,
  meta: 0x0668e1,
  mistral: 0xff7000,
  cohere: 0xd18ee2,
  deepseek: 0x4d6bfa,
  alibaba: 0xff6a00,
  baidu: 0x2932e1,
  microsoft: 0x00a4ef,
  amazon: 0xff9900,
  default: 0x6366f1,
};

function getOrgColor(org) {
  return ORG_COLORS[(org || '').toLowerCase()] || ORG_COLORS.default;
}

/**
 * Format a capability path like "inputCapabilities.image" into a readable label like "image input".
 */
function formatCapPath(path) {
  const map = {
    'inputCapabilities.text': 'text input',
    'inputCapabilities.image': 'image input',
    'inputCapabilities.file': 'file input',
    'inputCapabilities.video': 'video input',
    'inputCapabilities.audio': 'audio input',
    'outputCapabilities.text': 'text output',
    'outputCapabilities.web': 'web output',
    'outputCapabilities.image': 'image output',
    'outputCapabilities.video': 'video output',
    'outputCapabilities.search': 'search output',
  };
  return map[path] || path.replace(/Capabilities\./g, ' ').replace(/\./g, ' ');
}

/**
 * Extract capability emojis from a capabilities object
 * Handles both flat boolean structure and nested object structure
 * @param {Object} cap - Capabilities object with inputCapabilities and outputCapabilities
 * @returns {string} - Space-separated emoji string
 */
export function capabilityEmoji(cap) {
  const parts = [];
  if (!cap) return '';
  const inp = cap.inputCapabilities || {};
  const out = cap.outputCapabilities || {};
  if (inp.text) parts.push('📝');
  if (inp.image) parts.push('🖼️');
  if (inp.file) parts.push('📎');
  if (out.text) parts.push('💬');
  if (out.web) parts.push('🌐');
  if (out.image) parts.push('🎨');
  if (out.search) parts.push('🔍');
  return parts.join(' ');
}

function modelLine(m) {
  const rank = m.rank ? `#${m.rank}` : 'unranked';
  const org = m.organization || 'unknown';
  const caps = capabilityEmoji(m.capabilities);
  const selectable = m.userSelectable ? '✅' : '🔒';
  return `**${m.displayName || m.publicName || m.name}** \`${rank}\` | ${org} ${caps} ${selectable}`;
}

export function createLMArenaEmbed(diff, totalModels) {
  const embeds = [];
  const { groupDiff } = diff || {};

  // Summary embed
  const summaryEmbed = {
    color: 0x8b5cf6,
    title: '🏆 LM Arena Model Changes Detected',
    description: `Total models tracked: **${totalModels}**`,
    fields: [],
    timestamp: new Date().toISOString(),
    footer: {
      text: 'LM Arena Watcher',
      icon_url: LOGO_URL,
    },
  };

  const addedStealth = diff.added.filter(m => !m.organization);
  const addedKnown = diff.added.filter(m => m.organization);
  if (addedStealth.length > 0) {
    summaryEmbed.fields.push({
      name: `🥷 New Stealth Models (${addedStealth.length})`,
      value: addedStealth.length > 10
        ? `${addedStealth.slice(0, 10).map(m => `• ${m.displayName || m.publicName}`).join('\n')}\n...and ${addedStealth.length - 10} more`
        : addedStealth.map(m => `• ${m.displayName || m.publicName}`).join('\n'),
      inline: true,
    });
  }
  if (addedKnown.length > 0) {
    summaryEmbed.fields.push({
      name: `🆕 New Models (${addedKnown.length})`,
      value: addedKnown.length > 10
        ? `${addedKnown.slice(0, 10).map(m => `• ${m.displayName || m.publicName}`).join('\n')}\n...and ${addedKnown.length - 10} more`
        : addedKnown.map(m => `• ${m.displayName || m.publicName}`).join('\n'),
      inline: true,
    });
  }

  if (diff.removed.length > 0) {
    summaryEmbed.fields.push({
      name: `🗑️ Removed Models (${diff.removed.length})`,
      value: diff.removed.length > 10
        ? `${diff.removed.slice(0, 10).map(m => `• ${m.displayName || m.publicName}`).join('\n')}\n...and ${diff.removed.length - 10} more`
        : diff.removed.map(m => `• ${m.displayName || m.publicName}`).join('\n'),
      inline: true,
    });
  }

  if (diff.changed.length > 0) {
    summaryEmbed.fields.push({
      name: `🔄 Updated Models (${diff.changed.length})`,
      value: diff.changed.length > 10
        ? `${diff.changed.slice(0, 10).map(c => `• ${c.model.displayName || c.model.publicName}`).join('\n')}\n...and ${diff.changed.length - 10} more`
        : diff.changed.map(c => `• ${c.model.displayName || c.model.publicName}`).join('\n'),
      inline: true,
    });
  }

  // Revealed models (gained organization)
  if (diff.revealed && diff.revealed.length > 0) {
    summaryEmbed.fields.push({
      name: `🕵️ Revealed Models (${diff.revealed.length})`,
      value: diff.revealed.slice(0, 10).map(r => {
        const nameChange = r.oldName !== r.newName ? ` \`${r.oldName}\`` : '';
        return `•${nameChange} → **${r.newName}** (${r.newOrg})`;
      }).join('\n'),
      inline: true,
    });
  }

  // Possible reveals (stealth removed → new model with same caps)
  if (diff.possibleReveals && diff.possibleReveals.length > 0) {
    summaryEmbed.fields.push({
      name: `🔎 Possible Reveals (${diff.possibleReveals.length})`,
      value: diff.possibleReveals.slice(0, 10).map(pr =>
        `• \`${pr.removed.displayName || pr.removed.publicName}\` → **${pr.added.displayName || pr.added.publicName}** (${pr.match})`
      ).join('\n'),
      inline: true,
    });
  }

  // Group-level changes (variant counts, new groups, removed groups)
  if (groupDiff) {
    if (groupDiff.newGroups.length > 0) {
      summaryEmbed.fields.push({
        name: `📦 New Model Groups (${groupDiff.newGroups.length})`,
        value: groupDiff.newGroups.slice(0, 10).map(g =>
          `• ${g.displayName} (${g.profile.count} variant${g.profile.count > 1 ? 's' : ''})`
        ).join('\n'),
        inline: true,
      });
    }
    if (groupDiff.removedGroups.length > 0) {
      summaryEmbed.fields.push({
        name: `📭 Removed Groups (${groupDiff.removedGroups.length})`,
        value: groupDiff.removedGroups.slice(0, 10).map(g =>
          `• ${g.displayName} (${g.profile.count} variant${g.profile.count > 1 ? 's' : ''})`
        ).join('\n'),
        inline: true,
      });
    }
    if (groupDiff.variantChanges.length > 0) {
      summaryEmbed.fields.push({
        name: `🔀 Variant Changes (${groupDiff.variantChanges.length})`,
        value: groupDiff.variantChanges.slice(0, 10).map(v =>
          `• ${v.displayName}: ${v.oldCount} → ${v.newCount} variants`
        ).join('\n'),
        inline: true,
      });
    }
    if (groupDiff.convergence.length > 0) {
      summaryEmbed.fields.push({
        name: `🎯 Capability Convergence (${groupDiff.convergence.length})`,
        value: groupDiff.convergence.slice(0, 10).map(c =>
          `• ${c.displayName}: **${c.allNowHave.map(formatCapPath).join(', ')}** now across all ${c.variantCount} variants`
        ).join('\n'),
        inline: true,
      });
    }
  }

  embeds.push(summaryEmbed);

  // Detail embeds for new stealth models (no organization — potential future reveals)
  if (addedStealth.length > 0) {
    const lines = addedStealth.map(m => {
      const caps = capabilityEmoji(m.capabilities);
      return `**${m.displayName || m.publicName || m.name}**${caps ? ' ' + caps : ''} \`${m.rank ? '#' + m.rank : 'unranked'}\``;
    });
    let chunk = [];
    let chunkLen = 0;
    const chunks = [];
    for (const line of lines) {
      if (chunkLen + line.length > 900 && chunk.length > 0) {
        chunks.push(chunk.join('\n'));
        chunk = [line];
        chunkLen = line.length;
      } else {
        chunk.push(line);
        chunkLen += line.length + 1;
      }
    }
    if (chunk.length) chunks.push(chunk.join('\n'));
    for (let i = 0; i < chunks.length; i++) {
      embeds.push({
        color: 0x6b7280,
        title: i === 0 ? `🥷 New Stealth Models` : `🥷 New Stealth Models (cont.)`,
        description: chunks[i],
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Detail embeds for new known models (group by org)
  if (addedKnown.length > 0) {
    const byOrg = {};
    for (const m of addedKnown) {
      const org = m.organization || 'Unknown';
      if (!byOrg[org]) byOrg[org] = [];
      byOrg[org].push(m);
    }

    for (const [org, models] of Object.entries(byOrg)) {
      const lines = models.map(modelLine);
      // Split into chunks if needed (field value limit ~950)
      let chunk = [];
      let chunkLen = 0;
      const chunks = [];
      for (const line of lines) {
        if (chunkLen + line.length > 900 && chunk.length > 0) {
          chunks.push(chunk.join('\n'));
          chunk = [line];
          chunkLen = line.length;
        } else {
          chunk.push(line);
          chunkLen += line.length + 1;
        }
      }
      if (chunk.length) chunks.push(chunk.join('\n'));

      for (let i = 0; i < chunks.length; i++) {
        embeds.push({
          color: getOrgColor(org),
          title: i === 0 ? `🆕 New — ${org}` : `🆕 New — ${org} (cont.)`,
          description: chunks[i],
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // Detail embeds for removed models
  if (diff.removed.length > 0) {
    const byOrg = {};
    for (const m of diff.removed) {
      const org = m.organization || 'Unknown';
      if (!byOrg[org]) byOrg[org] = [];
      byOrg[org].push(m);
    }

    for (const [org, models] of Object.entries(byOrg)) {
      const lines = models.map(m => `**${m.displayName || m.publicName || m.name}** \`${m.rank ? '#' + m.rank : 'unranked'}\``);
      let chunk = [];
      let chunkLen = 0;
      const chunks = [];
      for (const line of lines) {
        if (chunkLen + line.length > 900 && chunk.length > 0) {
          chunks.push(chunk.join('\n'));
          chunk = [line];
          chunkLen = line.length;
        } else {
          chunk.push(line);
          chunkLen += line.length + 1;
        }
      }
      if (chunk.length) chunks.push(chunk.join('\n'));

      for (let i = 0; i < chunks.length; i++) {
        embeds.push({
          color: 0xef4444,
          title: i === 0 ? `🗑️ Removed — ${org}` : `🗑️ Removed — ${org} (cont.)`,
          description: chunks[i],
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // Detail embeds for updated models
  if (diff.changed.length > 0) {
    const byOrg = {};
    for (const c of diff.changed) {
      const org = c.model.organization || 'Unknown';
      if (!byOrg[org]) byOrg[org] = [];
      byOrg[org].push(c);
    }

    for (const [org, changes] of Object.entries(byOrg)) {
      const lines = changes.map(c => {
        const m = c.model;
        const changeStr = c.changes.join(', ');
        return `**${m.displayName || m.publicName || m.name}**\n${changeStr}`;
      });
      let chunk = [];
      let chunkLen = 0;
      const chunks = [];
      for (const line of lines) {
        if (chunkLen + line.length > 900 && chunk.length > 0) {
          chunks.push(chunk.join('\n'));
          chunk = [line];
          chunkLen = line.length;
        } else {
          chunk.push(line);
          chunkLen += line.length + 1;
        }
      }
      if (chunk.length) chunks.push(chunk.join('\n'));

      for (let i = 0; i < chunks.length; i++) {
        embeds.push({
          color: 0xf59e0b,
          title: i === 0 ? `🔄 Updated — ${org}` : `🔄 Updated — ${org} (cont.)`,
          description: chunks[i],
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // Detail embeds for revealed models
  if (diff.revealed && diff.revealed.length > 0) {
    for (const r of diff.revealed) {
      const details = [];
      details.push(`🆔 \`${r.model.id}\``);
      if (r.oldName !== r.newName) {
        details.push(`📛 Codename: \`${r.oldName}\` → **${r.newName}**`);
      }
      details.push(`🏢 Organization: **(none)** → **${r.newOrg}**`);
      if (r.newProvider && r.oldProvider !== r.newProvider) {
        details.push(`⚙️ Provider: ${r.oldProvider || '(none)'} → **${r.newProvider}**`);
      }
      if (r.oldSelectable !== r.newSelectable) {
        details.push(`🔓 Selectable: ${r.oldSelectable ? '✅' : '🔒'} → ${r.newSelectable ? '✅' : '🔒'}`);
      }
      const caps = capabilityEmoji(r.model.capabilities);
      if (caps) details.push(`🎯 Capabilities: ${caps}`);

      embeds.push({
        color: 0xf59e0b,
        title: `🕵️ ${r.oldName} → ${r.newName} by ${r.newOrg}`,
        description: details.join('\n'),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Detail embeds for variant count changes
  if (groupDiff && groupDiff.variantChanges.length > 0) {
    for (const v of groupDiff.variantChanges) {
      const oldRanks = v.oldRanks.length ? `ranks ${v.oldRanks.join(',')}` : 'no ranks';
      const newRanks = v.newRanks.length ? `ranks ${v.newRanks.join(',')}` : 'no ranks';
      let desc = `Variants: **${v.oldCount}** → **${v.newCount}**\nRanks: ${oldRanks} → ${newRanks}${v.newProviders.length ? `\nProviders: ${v.newProviders.join(', ')}` : ''}`;
      // Append capability matrix if available
      if (v.capMatrix && v.capMatrix.length > 0) {
        desc += '\n\n**Capability matrix:**';
        for (const cap of v.capMatrix) {
          const pct = Math.round((cap.count / cap.total) * 100);
          const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
          desc += `\n${cap.emoji} ${cap.label}: \`${bar}\` ${cap.count}/${cap.total}`;
        }
      }
      embeds.push({
        color: 0x8b5cf6,
        title: `🔀 ${v.displayName}: ${v.oldCount} → ${v.newCount} variants`,
        description: desc,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Detail embeds for capability convergence
  if (groupDiff && groupDiff.convergence.length > 0) {
    for (const c of groupDiff.convergence) {
      embeds.push({
        color: 0x10b981,
        title: `🎯 ${c.displayName} — Converged`,
        description: `**${c.allNowHave.map(formatCapPath).join(', ')}** is now available across all **${c.variantCount}** variants.`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Detail embeds for possible reveals
  if (diff.possibleReveals && diff.possibleReveals.length > 0) {
    for (const pr of diff.possibleReveals) {
      const rem = pr.removed;
      const add = pr.added;
      const remCaps = capabilityEmoji(rem.capabilities);
      const addCaps = capabilityEmoji(add.capabilities);
      embeds.push({
        color: 0xf97316,
        title: `🔎 ${rem.displayName || rem.publicName} → ${add.displayName || add.publicName}?`,
        description: `**Removed:** \`${rem.displayName || rem.publicName}\` (stealth, no org)\n**Added:** **${add.displayName || add.publicName}**${add.organization ? ` (${add.organization})` : ''}\n**Match:** ${pr.match}\n**Capabilities:** ${remCaps} → ${addCaps}\n*(⚠️ not confirmed — same capabilities, different identity)*`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // No truncation — sendDiscordWebhook batches into multiple API calls
  return {
    username: 'LM Arena Watcher',
    avatar_url: LOGO_URL,
    embeds,
  };
}

export function createStringsDiffEmbed(appId, diffText) {
  const MAX_FIELD_VALUE = 950; // Under Discord's 1024 field value limit, accounting for ```diff\n and \n```
  const MAX_EMBEDS_PER_MESSAGE = 5; // Limit total embeds to stay under 6000 total chars

  // Escape triple backticks to prevent breaking code blocks
  const safeDiff = diffText.replace(/```/g, '`\u200b`\u200b`');
  const lines = safeDiff.split('\n');

  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  for (const line of lines) {
    // +1 accounts for the newline character
    if (currentLength + line.length + 1 > MAX_FIELD_VALUE && currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
      currentChunk = [line];
      currentLength = line.length;
    } else {
      currentChunk.push(line);
      currentLength += line.length + 1;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n'));
  }

  // If we have too many chunks, truncate and add a note
  const wasTruncated = chunks.length > MAX_EMBEDS_PER_MESSAGE;
  const displayChunks = chunks.slice(0, MAX_EMBEDS_PER_MESSAGE);
  const totalChunks = chunks.length;

  const embeds = [];

  for (let i = 0; i < displayChunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === displayChunks.length - 1;

    let value = '```diff\n' + displayChunks[i] + '\n```';
    if (isLast && wasTruncated) {
      value += `\n*(diff truncated: ${totalChunks - MAX_EMBEDS_PER_MESSAGE} more chunks)*`;
    }

    const embed = {
      color: 0x3B82F6,
      fields: [{
        name: totalChunks > 1 ? `Diff (${i + 1}/${totalChunks})` : 'Diff',
        value
      }],
      timestamp: new Date().toISOString()
    };

    if (isFirst) {
      embed.title = `\ud83d\udcf1 ${appId} — Strings Changed`;
      embed.description = 'Android app strings diff detected';
    }

    if (isLast) {
      embed.footer = {
        text: 'Android Strings Watcher',
        icon_url: LOGO_URL
      };
    }

    embeds.push(embed);
  }

  return {
    username: 'Android Strings Watcher',
    avatar_url: LOGO_URL,
    embeds
  };
}
