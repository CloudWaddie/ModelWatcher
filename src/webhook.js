import axios from 'axios';

// Use GitHub raw URL for logo
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_TOTAL_CHARS = 6000;
const MAX_DESCRIPTION = 4000;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_TITLE = 256;
const MAX_FOOTER = 2048;

/**
 * Truncate a string safely to a specific length
 * @param {string} str - String to truncate
 * @param {number} maxLen - Maximum length
 * @returns {string} - Truncated string
 */
export function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

/**
 * Splits fields into multiple embeds if they exceed limits.
 * @param {Array} fields - Array of field objects
 * @returns {Array<Array>} - Array of field chunks (max 25 per chunk)
 */
function chunkFields(fields) {
  if (!fields) return [];
  const chunks = [];
  for (let i = 0; i < fields.length; i += 25) {
    chunks.push(fields.slice(i, i + 25));
  }
  return chunks;
}

/**
 * Ensures an embed stays within Discord limits by returning an array of embeds if necessary.
 */
function splitEmbed(embed) {
  const embeds = [];
  
  // Truncate non-field properties
  const baseEmbed = { ...embed };
  if (baseEmbed.title) baseEmbed.title = truncate(baseEmbed.title, MAX_TITLE);
  if (baseEmbed.description) baseEmbed.description = truncate(baseEmbed.description, MAX_DESCRIPTION);
  if (baseEmbed.footer?.text) baseEmbed.footer.text = truncate(baseEmbed.footer.text, MAX_FOOTER);
  if (baseEmbed.author?.name) baseEmbed.author.name = truncate(baseEmbed.author.name, MAX_TITLE);

  const fieldChunks = chunkFields(embed.fields);
  
  if (fieldChunks.length === 0) {
    embeds.push(baseEmbed);
    return embeds;
  }

  for (let i = 0; i < fieldChunks.length; i++) {
    const chunk = fieldChunks[i].map(f => ({
      name: truncate(f.name, MAX_FIELD_NAME),
      value: truncate(f.value, MAX_FIELD_VALUE),
      inline: f.inline
    }));

    const newEmbed = { 
      ...baseEmbed, 
      fields: chunk 
    };

    // Only keep title/description/author on the first embed of a split
    if (i > 0) {
      delete newEmbed.title;
      delete newEmbed.description;
      delete newEmbed.author;
      delete newEmbed.thumbnail;
      if (baseEmbed.title) newEmbed.title = `${baseEmbed.title} (cont. ${i + 1})`;
    }
    
    embeds.push(newEmbed);
  }

  return embeds;
}

/**
 * Processes a payload and returns an array of payloads, each within Discord message limits.
 */
export function chunkPayload(payload) {
  const allEmbeds = [];
  if (payload.embeds) {
    for (const embed of payload.embeds) {
      allEmbeds.push(...splitEmbed(embed));
    }
  }

  const payloads = [];
  let currentEmbeds = [];
  let currentTotalChars = 0;

  for (const embed of allEmbeds) {
    const embedChars = (embed.title?.length || 0) + 
                       (embed.description?.length || 0) + 
                       (embed.footer?.text?.length || 0) + 
                       (embed.author?.name?.length || 0) + 
                       (embed.fields?.reduce((acc, f) => acc + f.name.length + f.value.length, 0) || 0);

    if ((currentEmbeds.length >= MAX_EMBEDS_PER_MESSAGE || currentTotalChars + embedChars > MAX_TOTAL_CHARS) && currentEmbeds.length > 0) {
      payloads.push({
        ...payload,
        embeds: currentEmbeds
      });
      currentEmbeds = [];
      currentTotalChars = 0;
    }

    currentEmbeds.push(embed);
    currentTotalChars += embedChars;
  }

  if (currentEmbeds.length > 0) {
    payloads.push({
      ...payload,
      embeds: currentEmbeds
    });
  }

  return payloads;
}

/**
 * Hard-truncate for legacy support, but now uses chunkPayload logic under the hood for send.
 */
export function safeEmbed(payload) {
  const chunks = chunkPayload(payload);
  return chunks[0] || payload;
}

export async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) return false;
  try {
    const payloads = chunkPayload(payload);
    for (const p of payloads) {
      await axios.post(webhookUrl, p, { headers: { 'Content-Type': 'application/json' } });
    }
    return true;
  } catch (err) {
    console.error('Failed to send Discord webhook:', err.response?.status, err.message);
    return false;
  }
}

function getRelativeTimestamp() {
  const unixSeconds = Math.floor(Date.now() / 1000);
  return `<t:${unixSeconds}:R>`;
}

export function createSummaryEmbed(summary, results, commitSha = null) {
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  
  const fields = [];
  fields.push({
    name: 'Changes This Scan',
    value: `➕ **${summary.addedCount}** added | ➖ **${summary.removedCount}** removed | 🔄 **${summary.updatedCount}** updated`,
    inline: false
  });

  for (const result of results) {
    const emoji = result.success ? '🟢' : '🔴';
    const count = result.success ? `${result.models.length} models` : 'Failed';
    fields.push({
      name: result.endpoint,
      value: `${emoji} ${count}`,
      inline: true
    });
  }
  
  const baseUrl = 'https://github.com/CloudWaddie/ModelWatcher';
  const diffUrl = commitSha ? `${baseUrl}/commit/${commitSha}` : `${baseUrl}/commits/master/logs/state.json`;

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🔍 Model Scan Complete',
      description: `Scanned **${results.length}** endpoints | ${successCount} success, ${failCount} failed ${getRelativeTimestamp()}\n\nView changes: [GitHub Diff](${diffUrl})`,
      color: summary.removedCount > 0 ? 0xEF4444 : (summary.addedCount > 0 ? 0x10B981 : 0x3B82F6),
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'Model Watcher • Hourly Scan', icon_url: LOGO_URL }
    }]
  };
}

export function createNewModelsEmbed(endpointName, models) {
  const fields = models.map(m => ({
    name: 'New Model',
    value: \`\${m.id}\`,
    inline: true
  }));

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🆕 New Models Detected',
      description: \`**\${endpointName}** just added \${models.length} new model\${models.length > 1 ? 's' : ''} \${getRelativeTimestamp()}!\`,
      color: 0x10B981,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'Model Watcher • AI Model Scanner', icon_url: LOGO_URL }
    }]
  };
}

export function createRemovedModelsEmbed(endpointName, models) {
  const fields = models.map(m => ({
    name: 'Removed Model',
    value: \`\${m.id}\`,
    inline: true
  }));

  return {
    username: 'Model Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🗑️ Models Removed',
      description: \`**\${endpointName}** removed \${models.length} model\${models.length > 1 ? 's' : ''} \${getRelativeTimestamp()}.\`,
      color: 0xEF4444,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'Model Watcher • AI Model Scanner', icon_url: LOGO_URL }
    }]
  };
}
