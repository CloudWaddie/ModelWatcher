import gplay from 'google-play-scraper';
import store from 'app-store-scraper';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createPatch } from 'diff';
import { sendDiscordWebhook, sendRawDiffWebhook, createAppVersionEmbed, createStringsDiffEmbed } from './webhook.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STRINGS_DIR = join(__dirname, '..', 'strings');

function loadConfig() {
  const configPath = join(__dirname, '..', 'app-version-config.json');
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
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

function getStringsPath(appId) {
  return join(STRINGS_DIR, `${appId}.b64`);
}

function loadStrings(appId) {
  const path = getStringsPath(appId);
  if (existsSync(path)) {
    try {
      const b64 = readFileSync(path, 'utf-8');
      return Buffer.from(b64, 'base64').toString('utf-8');
    } catch (e) {
      console.error(`Failed to read strings for ${appId}:`, e.message);
    }
  }
  return '';
}

function saveStrings(appId, content) {
  if (!existsSync(STRINGS_DIR)) {
    mkdirSync(STRINGS_DIR, { recursive: true });
  }
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  writeFileSync(getStringsPath(appId), b64, 'utf-8');
}

// --- APK download & string extraction ---

async function downloadApk(appId, apkDir) {
  return new Promise((resolve, reject) => {
    const apkeepPath = join(process.cwd(), 'apkeep');
    const args = [
      '--accept-tos',
      '-d', 'google-play',
      '--aas-token', process.env.AAS_TOKEN,
      '-e', process.env.APK_EMAIL,
      '-a', appId,
      apkDir
    ];
    console.log(`[${appId}] Running apkeep...`);
    const proc = spawn(apkeepPath, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`apkeep exited with code ${code}. stderr: ${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn apkeep: ${err.message}`));
    });
  });
}

async function extractStrings(apkPath, outputDir) {
  const apktoolPath = join(process.cwd(), 'apktool.jar');
  const command = `java -jar "${apktoolPath}" d -f -o "${outputDir}" --no-src --no-assets "${apkPath}"`;
  console.log(`[${apkPath}] Extracting with apktool...`);

  const util = await import('util');
  const { exec } = await import('child_process');
  const execAsync = util.promisify(exec);

  await execAsync(command);

  const stringsPath = join(outputDir, 'res', 'values', 'strings.xml');
  if (!existsSync(stringsPath)) {
    throw new Error(`strings.xml not found at ${stringsPath}`);
  }
  return stringsPath;
}

function cleanupApk(appId) {
  try {
    const apkDir = join(process.cwd(), 'apk-files');
    const extractDir = join(process.cwd(), 'apk-extracted', appId);
    const apkPath = join(apkDir, `${appId}.apk`);

    if (existsSync(apkPath)) rmSync(apkPath);
    if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  } catch (e) {
    console.error(`Cleanup error for ${appId}:`, e.message);
  }
}

async function compareAndroidStrings(appId) {
  const apkDir = join(process.cwd(), 'apk-files');
  if (!existsSync(apkDir)) mkdirSync(apkDir, { recursive: true });

  await downloadApk(appId, apkDir);

  const apkPath = join(apkDir, `${appId}.apk`);
  if (!existsSync(apkPath)) {
    throw new Error('APK not found after download');
  }

  const extractDir = join(process.cwd(), 'apk-extracted', appId);
  const stringsPath = await extractStrings(apkPath, extractDir);

  const newStrings = readFileSync(stringsPath, 'utf-8');
  const oldStrings = loadStrings(appId);

  cleanupApk(appId);

  if (oldStrings === newStrings) {
    return { changed: false, newStrings };
  }

  const diff = createPatch(`${appId}-strings.xml`, oldStrings, newStrings, 'Previous', 'Current', { context: 3 });

  const hasChanges = diff.split('\n').some(line =>
    (line.startsWith('+') && !line.startsWith('+++')) ||
    (line.startsWith('-') && !line.startsWith('---'))
  );

  if (!hasChanges) {
    return { changed: false, newStrings };
  }

  // Filter out Firebase Crashlytics mapping_file_id changes
  const diffLines = diff.split('\n');
  const meaningfulChanges = diffLines.filter(line =>
    (line.startsWith('+') && !line.startsWith('+++')) ||
    (line.startsWith('-') && !line.startsWith('---'))
  ).filter(line => !line.includes('com.google.firebase.crashlytics.mapping_file_id'));

  if (meaningfulChanges.length === 0) {
    console.log(`[${appId}] Only Firebase Crashlytics mapping_file_id changed — suppressing webhook`);
    return { changed: false, newStrings };
  }

  // Filter firebase lines from diff for the notification, keep surrounding context clean
  const filteredDiff = diffLines.filter(line =>
    !line.includes('com.google.firebase.crashlytics.mapping_file_id')
  ).join('\n');

  return { changed: true, diff: filteredDiff, newStrings };
}

// --- App version checking ---

async function checkAndroidApp(appId, state) {
  const previous = state[appId] || null;
  const appDetails = await gplay.app({ appId });
  const lastUpdated = appDetails?.updated;

  if (!lastUpdated) {
    throw new Error('No updated timestamp from Google Play');
  }

  const isFirstRun = !previous;
  const isNewVersion = previous && lastUpdated > previous.lastUpdated;

  if (isFirstRun || isNewVersion) {
    console.log(`[Android] ${isFirstRun ? 'First run' : 'New version'} for ${appId}: ${appDetails.version}`);

    let stringsResult = { changed: false };
    try {
      stringsResult = await compareAndroidStrings(appId);
      if (stringsResult.newStrings) {
        saveStrings(appId, stringsResult.newStrings);
      }
    } catch (e) {
      console.error(`[Android] Strings check failed for ${appId}:`, e.message);
    }

    return {
      isNew: true,
      platform: 'android',
      appId,
      title: appDetails.title,
      version: appDetails.version,
      icon: appDetails.icon,
      description: appDetails.description,
      recentChanges: appDetails.recentChanges,
      developer: appDetails.developer,
      url: `https://play.google.com/store/apps/details?id=${appId}`,
      lastUpdated,
      stringsDiff: stringsResult.diff || null,
      stringsChanged: stringsResult.changed,
      isFirstRun
    };
  }

  return { isNew: false };
}

async function checkIosApp(appId, state) {
  const previous = state[appId] || null;
  const numericId = parseInt(appId, 10);

  if (isNaN(numericId)) {
    throw new Error(`Invalid iOS app ID: ${appId}`);
  }

  const appDetails = await store.app({ id: numericId });
  const lastUpdatedStr = appDetails?.updated;

  if (!lastUpdatedStr) {
    throw new Error('No updated timestamp from App Store');
  }

  const lastUpdated = Date.parse(lastUpdatedStr);
  if (isNaN(lastUpdated)) {
    throw new Error('Invalid date from App Store');
  }

  if (!previous || lastUpdated > previous.lastUpdated) {
    console.log(`[iOS] New version for ${appId}: ${appDetails.version}`);

    return {
      isNew: true,
      platform: 'ios',
      appId: appDetails.appId,
      title: appDetails.title,
      version: appDetails.version,
      icon: appDetails.icon,
      description: appDetails.description,
      recentChanges: appDetails.releaseNotes,
      developer: appDetails.developer,
      url: appDetails.url,
      lastUpdated
    };
  }

  return { isNew: false };
}

// --- Main ---

async function main() {
  console.log('=== App Version Watcher ===');

  const config = loadConfig();
  const statePath = join(__dirname, '..', config.state?.file || 'logs/app-version-state.json');
  const state = loadState(statePath);

  const appWebhookUrl = process.env[config.webhooks?.app?.webhookEnv];

  if (!appWebhookUrl) {
    console.error(`App webhook URL not configured (${config.webhooks?.app?.webhookEnv} env not set)`);
    process.exit(1);
  }

  const apps = config.apps || [];
  console.log(`Checking ${apps.length} app(s)`);

  for (const app of apps) {
    console.log(`Checking ${app.id} (${app.platform})...`);
    try {
      let result;
      if (app.platform === 'android') {
        result = await checkAndroidApp(app.id, state);
      } else if (app.platform === 'ios') {
        result = await checkIosApp(app.id, state);
      } else {
        console.warn(`Unknown platform: ${app.platform}`);
        continue;
      }

      if (result.isNew) {
        state[app.id] = {
          lastUpdated: result.lastUpdated,
          version: result.version
        };

        // Send app version embed
        const appPayload = createAppVersionEmbed(result);
        await sendDiscordWebhook(appWebhookUrl, appPayload);

        // If Android and strings changed, send diff embed
        if (result.platform === 'android' && result.stringsChanged && !result.isFirstRun) {
          const stringsPayload = createStringsDiffEmbed(app.id, result.stringsDiff);
          await sendRawDiffWebhook(appWebhookUrl, stringsPayload);
        }
      } else {
        console.log(`  No update for ${app.id}`);
      }
    } catch (error) {
      console.error(`Error checking ${app.id}:`, error.message);
    }
  }

  saveState(statePath, state);
  console.log('=== App Version Watcher complete ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
