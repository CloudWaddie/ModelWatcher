import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

// Comprehensive key mapping for model properties
const KEY_MAP = {
  apiProvider: 'API Provider',
  isInternal: 'Internal',
  maxTokens: 'Max Tokens',
  model: 'Model Enum',
  modelProvider: 'Model Provider',
  promptTemplaterType: 'Prompt Templater',
  quotaInfo: 'Quota Info',
  requiresLeadInGeneration: 'Requires Lead-in Generation',
  supportsCumulativeContext: 'Supports Cumulative Context',
  supportsEstimateTokenCounter: 'Supports Token Counter',
  tokenizerType: 'Tokenizer',
  toolFormatterType: 'Tool Formatter',
  addCursorToFindReplaceTarget: 'Add Cursor to Find/Replace',
  tabJumpPrintLineRange: 'Tab Jump Print Line Range',
  displayName: 'Display Name',
  maxOutputTokens: 'Max Output Tokens',
  modelExperiments: 'Model Experiments',
  recommended: 'Recommended',
  supportedMimeTypes: 'Supported MIME Types',
  supportsImages: 'Supports Images',
  supportsThinking: 'Supports Thinking',
  thinkingBudget: 'Thinking Budget',
  vertexModelId: 'Vertex Model ID',
  minThinkingBudget: 'Min Thinking Budget',
  supportsVideo: 'Supports Video',
  tagDescription: 'Tag Description',
  tagTitle: 'Tag Title',
  requiresImageOutputOutsideFunctionResponses: 'Requires Image Output Outside Functions',
  modelRole: 'Model Role'
};

function getReadableKey(key) {
  return KEY_MAP[key] || key;
}

function formatValue(val, depth = 0) {
  if (val === null || val === undefined) return 'N/A';
  if (typeof val === 'boolean') return val ? '✅' : '❌';
  if (typeof val === 'number') return val.toLocaleString();
  if (typeof val === 'string') {
    if (val.length > 200) return val.substring(0, 197) + '...';
    return val;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return 'None';
    if (depth > 0) return `[${val.length} items]`;
    return val.map(v => formatValue(v, depth + 1)).join(', ');
  }
  if (typeof val === 'object') {
    // Truncate stringValue deeply
    const cloned = JSON.parse(JSON.stringify(val));
    function truncateStringValues(obj) {
      for (const k in obj) {
        if (k === 'stringValue' && typeof obj[k] === 'string') {
          obj[k] = obj[k].length > 100 ? obj[k].substring(0, 97) + '...' : obj[k];
        } else if (typeof obj[k] === 'object' && obj[k] !== null) {
          truncateStringValues(obj[k]);
        }
      }
    }
    truncateStringValues(cloned);
    return '```json\n' + JSON.stringify(cloned, null, 2).substring(0, 900) + '\n```';
  }
  return String(val);
}

function loadConfig() {
  const configPath = join(__dirname, '..', 'github-file-config.json');
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

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

function saveState(statePath, state) {
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

async function fetchLatestCommit(fileConfig, timeout) {
  const { owner, repo, path } = fileConfig;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1`;
  console.log(`Fetching latest commit for ${owner}/${repo}/${path}...`);
  try {
    const response = await axios.get(apiUrl, {
      timeout,
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'ModelWatcher/1.0' }
    });
    if (!response.data || response.data.length === 0) {
      return { success: false, error: 'No commits found for path' };
    }
    const commit = response.data[0];
    return {
      success: true,
      sha: commit.sha,
      html_url: commit.html_url,
      message: commit.commit?.message || '',
      author: commit.commit?.author?.name || '',
      date: commit.commit?.author?.date || ''
    };
  } catch (error) {
    console.error('Failed to fetch latest commit:', error.message);
    return { success: false, error: error.message };
  }
}

async function fetchRawFile(fileConfig, commitSha, timeout) {
  const { owner, repo, path, branch } = fileConfig;
  const ref = commitSha || branch || 'main';
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  console.log(`Fetching raw file from ${rawUrl}...`);
  try {
    const response = await axios.get(rawUrl, {
      timeout,
      headers: { 'Accept': 'application/json', 'User-Agent': 'ModelWatcher/1.0' }
    });
    return { success: true, data: response.data };
  } catch (error) {
    console.error('Failed to fetch raw file:', error.message);
    return { success: false, error: error.message };
  }
}

function getModelSummary(modelId, modelData) {
  const dn = modelData?.displayName || modelId;
  return dn !== modelId ? `${dn} (\`${modelId}\`)` : `\`${modelId}\``;
}

function buildModelDetails(modelData) {
  const lines = [];
  for (const [key, val] of Object.entries(modelData)) {
    lines.push(`**${getReadableKey(key)}:** ${formatValue(val)}`);
  }
  return lines.join('\n');
}

function detectModelChanges(currentData, previousData) {
  const currentIds = new Set(Object.keys(currentData));
  const previousIds = new Set(Object.keys(previousData));

  const added = [];
  const removed = [];
  const edited = [];

  for (const id of currentIds) {
    if (!previousIds.has(id)) {
      added.push({ id, data: currentData[id] });
    } else {
      const curr = currentData[id];
      const prev = previousData[id];
      const diffs = [];
      const allKeys = new Set([...Object.keys(curr), ...Object.keys(prev)]);
      for (const key of allKeys) {
        const c = JSON.stringify(curr[key]);
        const p = JSON.stringify(prev[key]);
        if (c !== p) {
          diffs.push({
            key,
            readable: getReadableKey(key),
            old: prev[key],
            new: curr[key]
          });
        }
      }
      if (diffs.length > 0) {
        edited.push({ id, data: curr, diffs });
      }
    }
  }

  for (const id of previousIds) {
    if (!currentIds.has(id)) {
      removed.push({ id, data: previousData[id] });
    }
  }

  return { added, removed, edited };
}

async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.log('Discord webhook URL not configured, skipping notification');
    return false;
  }
  try {
    const safePayload = {
      ...payload,
      embeds: (payload.embeds || []).map(safeEmbed)
    };
    await axios.post(webhookUrl, safePayload, {
      headers: { 'Content-Type': 'application/json' }
    });
    return true;
  } catch (err) {
    const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Failed to send Discord webhook:', err.response?.status, details);
    return false;
  }
}

function getRelativeTimestamp() {
  const unixSeconds = Math.floor(Date.now() / 1000);
  return `<t:${unixSeconds}:R>`;
}

function truncate(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

const MAX_EMBED_DESC = 2048;
const MAX_FIELD_VALUE = 1024;
const MAX_EMBED_TOTAL = 6000;

function safeEmbed(embed) {
  if (embed.title && embed.title.length > 256) embed.title = truncate(embed.title, 256);
  if (embed.description && embed.description.length > MAX_EMBED_DESC) embed.description = truncate(embed.description, MAX_EMBED_DESC);
  if (embed.fields) {
    for (const field of embed.fields) {
      if (field.name && field.name.length > 256) field.name = truncate(field.name, 256);
      if (field.value && field.value.length > MAX_FIELD_VALUE) field.value = truncate(field.value, MAX_FIELD_VALUE);
    }
  }
  return embed;
}

function embedCharCount(embed) {
  let count = (embed.title || '').length + (embed.description || '').length;
  if (embed.fields) {
    for (const f of embed.fields) count += (f.name || '').length + (f.value || '').length;
  }
  if (embed.footer && embed.footer.text) count += embed.footer.text.length;
  return count;
}

function createNewModelEmbed(modelId, modelData) {
  const details = buildModelDetails(modelData);
  return {
    username: 'Tombstone Tracker',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🆕 New Model',
      description: `**${getModelSummary(modelId, modelData)}** added ${getRelativeTimestamp()}`,
      color: 0x10B981,
      fields: [{
        name: 'Details',
        value: truncate(details, 1024)
      }],
      timestamp: new Date().toISOString(),
      footer: { text: 'Tombstone Tracker', icon_url: LOGO_URL }
    }]
  };
}

function createRemovedModelEmbed(modelId, modelData) {
  const details = buildModelDetails(modelData);
  return {
    username: 'Tombstone Tracker',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🗑️ Removed Model',
      description: `**${getModelSummary(modelId, modelData)}** removed ${getRelativeTimestamp()}`,
      color: 0xEF4444,
      fields: [{
        name: 'Last Known Details',
        value: truncate(details, 1024)
      }],
      timestamp: new Date().toISOString(),
      footer: { text: 'Tombstone Tracker', icon_url: LOGO_URL }
    }]
  };
}

function createEditedModelEmbed(modelId, modelData, diffs) {
  const changeLines = diffs.map(d => {
    const oldVal = formatValue(d.old);
    const newVal = formatValue(d.new);
    return `**${d.readable}**\n- ${oldVal}\n+ ${newVal}`;
  }).join('\n\n');

  return {
    username: 'Tombstone Tracker',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '📝 Model Updated',
      description: `**${getModelSummary(modelId, modelData)}** edited ${getRelativeTimestamp()}`,
      color: 0xF59E0B,
      fields: [{
        name: 'Changes',
        value: truncate(changeLines, 1024)
      }],
      timestamp: new Date().toISOString(),
      footer: { text: 'Tombstone Tracker', icon_url: LOGO_URL }
    }]
  };
}

function createSummaryEmbed(commitInfo, modelChanges, totalModels, fileConfig) {
  return {
    username: 'Tombstone Tracker',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '📄 Update Detected',
      description: `**Tombstone Tracker** detected an update ${getRelativeTimestamp()}`,
      color: 0x8B5CF6,
      fields: [
        {
          name: '📊 Changes',
          value: `🆕 ${modelChanges.added.length} added | 🗑️ ${modelChanges.removed.length} removed | 📝 ${modelChanges.edited.length} edited | 🤖 ${totalModels} total`,
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Tombstone Tracker', icon_url: LOGO_URL }
    }]
  };
}

function createInitialEmbed(commitInfo, currentData, fileConfig) {
  const models = currentData.models || {};
  const modelCount = Object.keys(models).length;

  const providerBreakdown = {};
  for (const [id, info] of Object.entries(models)) {
    const provider = info?.modelProvider || 'Unknown';
    providerBreakdown[provider] = (providerBreakdown[provider] || 0) + 1;
  }

  const providerList = Object.entries(providerBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([p, c]) => `- ${p.replace('MODEL_PROVIDER_', '')}: ${c}`)
    .join('\n');

  return {
    username: 'Tombstone Tracker',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '📄 Tombstone Tracker Started',
      description: `**Tombstone Tracker** is now watching ${getRelativeTimestamp()}`,
      color: 0x3B82F6,
      fields: [
        { name: '🤖 Models', value: `**Total:** ${modelCount}`, inline: true },
        { name: '🏢 Providers', value: truncate(providerList, 1000) || 'N/A', inline: true }
      ],
      timestamp: new Date().toISOString(),
      footer: { text: 'Tombstone Tracker', icon_url: LOGO_URL }
    }]
  };
}

async function main() {
  console.log('=== Tombstone Tracker ===');
  console.log('Starting file check...');

  const config = loadConfig();
  const statePath = join(__dirname, '..', config.state?.file || 'logs/github-file-state.json');
  const previousState = loadState(statePath);

  const webhookUrl = process.env[config.webhook?.webhookEnv];
  if (!webhookUrl) {
    console.error(`Webhook URL not configured (${config.webhook?.webhookEnv} env not set), exiting`);
    process.exit(1);
  }

  const timeout = config.scan?.timeout || 30000;

  const commitInfo = await fetchLatestCommit(config.file, timeout);
  if (!commitInfo.success) {
    console.error('Failed to fetch latest commit:', commitInfo.error);
    process.exit(1);
  }

  console.log(`Latest commit: ${commitInfo.sha}`);

  const previousSha = previousState.commitSha || null;
  if (previousSha === commitInfo.sha) {
    console.log('No new commits detected, exiting');
    console.log(`=== File check complete ===`);
    return;
  }

  console.log(`New commit detected: ${previousSha || '(none)'} -> ${commitInfo.sha}`);

  const rawResult = await fetchRawFile(config.file, commitInfo.sha, timeout);
  if (!rawResult.success) {
    console.error('Failed to fetch raw file:', rawResult.error);
    process.exit(1);
  }

  const currentData = rawResult.data || {};
  const currentModels = currentData.models || {};
  const previousModels = previousState.raw?.models || {};

  const modelChanges = detectModelChanges(currentModels, previousModels);
  const totalModels = Object.keys(currentModels).length;

  console.log(`Models: ${modelChanges.added.length} added, ${modelChanges.removed.length} removed, ${modelChanges.edited.length} edited`);

  if (previousSha) {
    // Send summary first
    const summaryEmbed = createSummaryEmbed(commitInfo, modelChanges, totalModels, config.file);
    await sendDiscordWebhook(webhookUrl, summaryEmbed);

    // Send individual new model embeds
    for (const { id, data } of modelChanges.added) {
      const embed = createNewModelEmbed(id, data);
      await sendDiscordWebhook(webhookUrl, embed);
    }

    // Send individual removed model embeds
    for (const { id, data } of modelChanges.removed) {
      const embed = createRemovedModelEmbed(id, data);
      await sendDiscordWebhook(webhookUrl, embed);
    }

    // Send individual edited model embeds
    for (const { id, data, diffs } of modelChanges.edited) {
      const embed = createEditedModelEmbed(id, data, diffs);
      await sendDiscordWebhook(webhookUrl, embed);
    }
  } else {
    // First run
    console.log('First run, sending initial tracking embed');
    const embed = createInitialEmbed(commitInfo, currentData, config.file);
    await sendDiscordWebhook(webhookUrl, embed);
  }

  // Save full raw state for accurate future diffs
  const newState = {
    timestamp: Date.now(),
    commitSha: commitInfo.sha,
    raw: currentData
  };
  saveState(statePath, newState);

  console.log(`=== File check complete: ${totalModels} models tracked ===`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
