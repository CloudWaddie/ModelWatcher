import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { sendDiscordWebhook } from './webhook.js';

const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

/**
 * Load configuration from releases-config.json
 */
function loadConfig() {
  const configPath = './releases-config.json';
  const configContent = readFileSync(configPath, 'utf-8');
  return JSON.parse(configContent);
}

/**
 * Load state from state file
 */
function loadState(statePath) {
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, 'utf-8'));
    } catch (e) {
      console.error('Failed to parse state file, starting fresh:', e.message);
    }
  }
  return { github: {}, npm: {} };
}

/**
 * Save state to state file
 */
function saveState(statePath, state) {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Fetch latest release from a GitHub repository
 */
async function fetchGitHubRelease(owner, repo) {
  try {
    const response = await axios.get(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      timeout: 10000,
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ModelWatcher/1.0'
      }
    });
    
    return {
      owner,
      repo,
      name: response.data.name || response.data.tag_name,
      tag: response.data.tag_name,
      url: response.data.html_url,
      published: response.data.published_at,
      body: response.data.body?.substring(0, 500) || ''
    };
  } catch (error) {
    console.error(`Failed to fetch ${owner}/${repo}:`, error.message);
    return null;
  }
}

/**
 * Fetch latest version from npm package
 */
async function fetchNpmVersion(packageName) {
  try {
    const response = await axios.get(`https://registry.npmjs.org/${packageName}/latest`, {
      timeout: 10000
    });
    
    return {
      package: packageName,
      version: response.data.version,
      name: response.data.name,
      url: `https://www.npmjs.com/package/${packageName}`,
      description: response.data.description?.substring(0, 200) || ''
    };
  } catch (error) {
    console.error(`Failed to fetch npm ${packageName}:`, error.message);
    return null;
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
 * Create Discord message for new releases
 */
function createReleasesMessage(type, items) {
  const embeds = [];
  
  for (const item of items) {
    const embed = {
      title: type === 'github' ? `${item.owner}/${item.repo}` : item.package,
      description: type === 'github' 
        ? `**${item.name}**\n${item.body}`
        : `**v${item.version}**\n${item.description || ''}`,
      url: item.url,
      color: type === 'github' ? 0x238636 : 0xCB0000,
      timestamp: new Date().toISOString(),
      footer: {
        text: type === 'github' ? 'GitHub Release' : 'npm Package',
        icon_url: type === 'github' ? 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png' : 'https://www.npmjs.com/static/images/touchicons/open-graph.svg'
      }
    };
    
    embeds.push(embed);
  }
  
  const typeLabel = type === 'github' ? 'GitHub Releases' : 'npm Packages';
  
  return {
    username: 'Releases Watcher',
    avatar_url: LOGO_URL,
    content: `📦 **New ${typeLabel}**\n\nFound ${items.length} new release${items.length > 1 ? 's' : ''} ${getRelativeTimestamp()}!`,
    embeds: embeds
  };
}

/**
 * Main function
 */
async function main() {
  console.log('=== Releases Watcher (GitHub/npm) ===');
  console.log('Starting release check...');

  const config = loadConfig();
  const statePath = config.state?.file || './logs/releases-state.json';
  const state = loadState(statePath);

  const webhookUrl = process.env[config.webhook?.webhookEnv];

  if (!webhookUrl) {
    console.error(`Webhook URL not configured (${config.webhook?.webhookEnv} env not set), exiting`);
    process.exit(1);
  }

  let totalNewReleases = 0;

  // Check GitHub releases
  const github = config.github?.repositories || [];
  console.log(`\nChecking ${github.length} GitHub repositories...`);
  
  const githubNewReleases = [];
  
  for (const repo of github) {
    const release = await fetchGitHubRelease(repo.owner, repo.repo);
    
    if (!release) continue;
    
    const key = `${repo.owner}/${repo.repo}`;
    
    // Initialize state if needed
    if (!state.github[key]) {
      state.github[key] = { tag: null, version: null };
    }
    
    // Check if new
    const isNew = release.tag !== state.github[key].tag;
    
    if (isNew) {
      console.log(`  ✨ New: ${key} - ${release.tag}`);
      githubNewReleases.push(release);
      state.github[key].tag = release.tag;
    } else {
      console.log(`  ✓ ${key} - ${release.tag} (no change)`);
    }
  }

  // Check npm packages
  const npm = config.npm?.packages || [];
  console.log(`\nChecking ${npm.length} npm packages...`);
  
  const npmNewReleases = [];
  
  for (const packageName of npm) {
    const pkg = await fetchNpmVersion(packageName);
    
    if (!pkg) continue;
    
    // Initialize state if needed
    if (!state.npm[packageName]) {
      state.npm[packageName] = null;
    }
    
    // Check if new
    const isNew = pkg.version !== state.npm[packageName];
    
    if (isNew) {
      console.log(`  ✨ New: ${packageName} - v${pkg.version}`);
      npmNewReleases.push(pkg);
      state.npm[packageName] = pkg.version;
    } else {
      console.log(`  ✓ ${packageName} - v${pkg.version} (no change)`);
    }
  }

  // Send notifications using shared webhook utility
  if (githubNewReleases.length > 0) {
    const message = createReleasesMessage('github', githubNewReleases);
    await sendDiscordWebhook(webhookUrl, message);
    totalNewReleases += githubNewReleases.length;
  }
  
  if (npmNewReleases.length > 0) {
    const message = createReleasesMessage('npm', npmNewReleases);
    await sendDiscordWebhook(webhookUrl, message);
    totalNewReleases += npmNewReleases.length;
  }

  // Save state
  saveState(statePath, state);

  console.log(`\n=== Release check complete: ${totalNewReleases} new releases ===`);
}

// Run main function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
