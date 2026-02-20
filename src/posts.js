import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use GitHub raw URL for logo
const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

/**
 * Load configuration from posts-config.json
 * @returns {Object} Configuration object
 */
function loadConfig() {
  const configPath = './posts-config.json';
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
  return { users: {} };
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

/**
 * Convert x.com and twitter.com links to fixupx.com
 * @param {string} text - Text containing x.com or twitter.com links
 * @returns {string} Text with x.com or twitter.com links replaced by fixupx.com
 */
function convertToFixupx(text) {
  if (!text) return '';
  return text.replace(/x\.com\//g, 'fixupx.com/').replace(/twitter\.com\//g, 'fixupx.com/');
}

/**
 * Fetch RSS feed for a user from xcancel
 * @param {string} username - Twitter username
 * @returns {Promise<Array>} Array of feed items
 */
async function fetchUserFeed(username) {
  const url = `https://xcancel.com/${username}/rss`;
  console.log(`Fetching RSS feed for @${username}...`);
  
  try {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'User-Agent': 'ModelWatcher/1.0'
      }
    });
    
    // Parse RSS XML
    const items = parseRSS(response.data);
    console.log(`Found ${items.length} items for @${username}`);
    return items;
  } catch (error) {
    console.error(`Failed to fetch feed for @${username}:`, error.message);
    return [];
  }
}

/**
 * Simple RSS parser
 * @param {string} xml - RSS XML string
 * @returns {Array} Array of items
 */
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const item = {};
    
    // Extract title
    const titleMatch = itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    item.title = titleMatch ? (titleMatch[1] || titleMatch[2] || '').trim() : '';
    
    // Extract link
    const linkMatch = itemXml.match(/<link>(.*?)<\/link>/);
    item.link = linkMatch ? linkMatch[1].trim() : '';
    
    // Extract description
    const descMatch = itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/);
    item.description = descMatch ? (descMatch[1] || descMatch[2] || '').trim() : '';
    
    // Extract pubDate
    const pubDateMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/);
    item.pubDate = pubDateMatch ? pubDateMatch[1].trim() : '';
    
    // Extract guid
    const guidMatch = itemXml.match(/<guid>(.*?)<\/guid>/);
    item.guid = guidMatch ? guidMatch[1].trim() : item.link;
    
    // Convert links in title and description to fixupx
    item.title = convertToFixupx(item.title);
    item.description = convertToFixupx(item.description);
    item.link = convertToFixupx(item.link);
    
    items.push(item);
  }
  
  return items;
}

/**
 * Extract post ID from link or guid
 * @param {string} linkOrGuid - Link or guid string
 * @returns {string} Post ID
 */
function extractPostId(linkOrGuid) {
  // Extract status ID from link like https://fixupx.com/username/status/1234567890
  const match = linkOrGuid.match(/status\/(\d+)/);
  return match ? match[1] : linkOrGuid;
}

/**
 * Send a Discord webhook notification for new posts
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
 * Create Discord embed for new posts
 * @param {string} username - Twitter username
 * @param {Array} posts - Array of new posts
 * @returns {Object} Discord embed object
 */
function createNewPostsEmbed(username, posts) {
  const maxPerField = 5;
  const maxTotal = 10;
  const fields = [];
  
  // If too many posts, just show count
  if (posts.length > maxTotal) {
    return {
      username: 'Twitter Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🐦 New Posts from @' + username,
        description: `@${username} posted **${posts.length}** new tweets!\n\nCheck the timeline for details.`,
        color: 0x1DA1F2,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Twitter Watcher • XCancel RSS',
          icon_url: LOGO_URL
        }
      }]
    };
  }
  
  for (let i = 0; i < posts.length; i += maxPerField) {
    const chunk = posts.slice(i, i + maxPerField);
    const postList = chunk.map(p => {
      const postId = extractPostId(p.guid || p.link);
      const title = p.title.substring(0, 80);
      return `[${title}...](${p.link})`;
    }).join('\n');
    
    const label = posts.length > maxPerField 
      ? `Posts (${i + 1}-${Math.min(i + maxPerField, posts.length)})`
      : 'Recent Posts';
    
    fields.push({
      name: label,
      value: postList
    });
  }

  return {
    username: 'Twitter Watcher',
    avatar_url: LOGO_URL,
    embeds: [{
      title: '🐦 New Posts from @' + username,
      description: `@${username} just posted ${posts.length} new tweet${posts.length > 1 ? 's' : ''}!`,
      color: 0x1DA1F2,
      fields,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Twitter Watcher • XCancel RSS',
        icon_url: LOGO_URL
      }
    }]
  };
}

/**
 * Main function to check feeds and post notifications
 */
async function main() {
  console.log('=== Twitter/X RSS Watcher ===');
  console.log('Starting feed check...');
  
  const config = loadConfig();
  const statePath = config.state?.file || './logs/posts-state.json';
  const state = loadState(statePath);
  
  const webhookUrl = process.env[config.webhook?.webhookEnv];
  
  if (!webhookUrl) {
    console.error(`Webhook URL not configured (${config.webhook?.webhookEnv} env not set), exiting`);
    process.exit(1);
  }
  
  const users = config.xcancel?.users || [];
  console.log(`Watching ${users.length} users: ${users.join(', ')}`);
  
  let totalNewPosts = 0;
  
  for (const username of users) {
    const items = await fetchUserFeed(username);
    
    if (items.length === 0) {
      continue;
    }
    
    // Initialize user state if needed
    if (!state.users[username]) {
      state.users[username] = { seenIds: [] };
    }
    
    // Find new posts (not in seenIds)
    const seenIds = state.users[username].seenIds;
    const newPosts = items.filter(item => {
      const postId = extractPostId(item.guid || item.link);
      return !seenIds.includes(postId);
    });
    
    // Sort new posts by date (newest first)
    newPosts.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    
    if (newPosts.length > 0) {
      console.log(`Found ${newPosts.length} new posts from @${username}`);
      
      // Send webhook notification
      const embed = createNewPostsEmbed(username, newPosts);
      await sendDiscordWebhook(webhookUrl, embed);
      
      totalNewPosts += newPosts.length;
      
      // Update seen IDs
      const newIds = newPosts.map(p => extractPostId(p.guid || p.link));
      state.users[username].seenIds = [...newIds, ...seenIds].slice(0, 100); // Keep last 100
    } else {
      console.log(`No new posts from @${username}`);
    }
  }
  
  // Save state
  saveState(statePath, state);
  
  console.log(`=== Feed check complete: ${totalNewPosts} new posts ===`);
}

// Run main function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
