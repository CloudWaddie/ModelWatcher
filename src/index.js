import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanEndpoints, compareModels } from './scanner.js';
import Logger from './logger.js';
import { processNotifications } from './webhook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// API key sanitization patterns
const API_KEY_PATTERNS = [
  /([a-zA-Z_]+API[_]?KEY)[^"'\s]*/gi,
  /Bearer\s+([a-zA-Z0-9\-_]+)/gi,
  /sk-([a-zA-Z0-9\-_]{20,})/gi,
  /api[-]?key["']?\s*[:=]\s*["']?([^"'\s]+)/gi
];

/**
 * Sanitize sensitive data from strings (API keys, tokens)
 * @param {string} text - Text to sanitize
 * @returns {string} - Sanitized text
 */
export function sanitize(text) {
  if (!text || typeof text !== 'string') return text;
  
  let sanitized = text;
  
  // Replace common API key patterns
  sanitized = sanitized.replace(/(sk-|AKIA|eyJ)[a-zA-Z0-9\-_]{10,}/gi, '[REDACTED]');
  sanitized = sanitized.replace(/"api[_-]?key"\s*:\s*"[^"]+"/gi, '"api_key": "[REDACTED]"');
  sanitized = sanitized.replace(/"bearer"\s*:\s*"[^"]+"/gi, '"bearer": "[REDACTED]"');
  sanitized = sanitized.replace(/Authorization:\s*Bearer\s+[^\s]+/gi, 'Authorization: Bearer [REDACTED]');
  
  return sanitized;
}

/**
 * Sanitize an object recursively
 * @param {Object} obj - Object to sanitize
 * @returns {Object} - Sanitized object
 */
export function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitize(obj);
  if (typeof obj !== 'object') return obj;
  
  const sanitized = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();
    
    // Skip known sensitive keys
    if (keyLower.includes('key') || keyLower.includes('token') || 
        keyLower.includes('secret') || keyLower.includes('password') ||
        keyLower.includes('bearer') || keyLower.includes('auth')) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      sanitized[key] = sanitize(value);
    } else if (typeof value === 'object') {
      sanitized[key] = sanitizeObject(value);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Load configuration
 * @returns {Object} - Configuration object
 */
function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  
  if (!fs.existsSync(configPath)) {
    console.error('Config file not found:', configPath);
    process.exit(1);
  }
  
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config;
}

/**
 * Main scan function
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Model Scanner starting...');
  console.log('='.repeat(50));
  
  // Load configuration
  const config = loadConfig();
  
  // Initialize logger
  const logger = new Logger(config.logging);
  
  // Get previous state
  const previousState = logger.getPreviousState();
  
  // Scan all endpoints
  console.log(`\nScanning ${config.endpoints.length} endpoints...`);
  const results = await scanEndpoints(config.endpoints, config.scan);
  
  // Build changes object
  const allChanges = {};
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalUpdated = 0;
  
  for (const result of results) {
    const endpointName = result.endpoint;
    
    if (result.success) {
      let oldModels = [];
      
      // Get previous models from state
      if (previousState && previousState.endpoints && previousState.endpoints[endpointName]) {
        oldModels = previousState.endpoints[endpointName].models || [];
      }
      
      // Compare with current
      const changes = compareModels(oldModels, result.models);
      allChanges[endpointName] = changes;
      
      totalAdded += changes.summary.addedCount;
      totalRemoved += changes.summary.removedCount;
      totalUpdated += changes.summary.updatedCount;
      
      console.log(`  ✓ ${endpointName}: ${result.models.length} models`);
      
      if (changes.summary.addedCount > 0) {
        console.log(`    +${changes.summary.addedCount} new models`);
      }
      if (changes.summary.removedCount > 0) {
        console.log(`    -${changes.summary.removedCount} removed models`);
      }
      if (changes.summary.updatedCount > 0) {
        console.log(`    ~${changes.summary.updatedCount} updated models`);
      }
    } else {
      console.log(`  ✗ ${endpointName}: ${result.error}`);
      allChanges[endpointName] = { error: result.error, added: [], removed: [], updated: [] };
    }
  }
  
  // Save current state
  logger.saveState(results);
  
  // Log scan results (sanitized)
  const sanitizedResults = sanitizeObject(results);
  const sanitizedChanges = sanitizeObject(allChanges);
  logger.logScan(sanitizedResults, sanitizedChanges);
  
  // Process Discord notifications
  console.log('\nProcessing notifications...');
  const commitSha = process.env.GITHUB_SHA || null;
  await processNotifications(config.discord, results, allChanges, config.endpoints, commitSha);
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('Scan complete!');
  console.log(`Total: +${totalAdded} added, -${totalRemoved} removed, ~${totalUpdated} updated`);
  console.log('='.repeat(50));
  
  // Cleanup old logs
  logger.cleanupOldLogs();
  
  // Exit with appropriate code - only fail if ALL endpoints failed
  const allFailed = results.every(r => !r.success);
  const hasChanges = totalAdded > 0 || totalRemoved > 0 || totalUpdated > 0;
  
  // Exit 0 if: at least one succeeded OR no API keys were configured (graceful)
  // Exit 1 only if: all endpoints failed (actual error)
  if (allFailed) {
    console.log('\nAll endpoints failed - check API keys and endpoints');
    process.exit(1);
  }
  
  process.exit(0);
}

// Run if called directly
main().catch(err => {
  console.error('Fatal error:', sanitize(err.message));
  process.exit(1);
});
