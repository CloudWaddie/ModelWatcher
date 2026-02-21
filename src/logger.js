import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Logger class for JSON logging with change tracking
 */
export class Logger {
  constructor(config = {}) {
    this.outputDir = config.outputDir || './logs';
    this.historyDays = config.historyDays || 30;
    this.stateFile = path.join(this.outputDir, 'state.json');
    this.ensureOutputDir();
  }

  /**
   * Ensure output directory exists
   */
  ensureOutputDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Get previous scan state
   * @returns {Object|null} - Previous state or null
   */
  getPreviousState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = fs.readFileSync(this.stateFile, 'utf-8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.error('Failed to read previous state:', err.message);
    }
    return null;
  }

  /**
   * Strip timestamp fields from models to avoid unnecessary commits
   * The 'created' field is already ignored in comparison (scanner.js),
   * but we also strip it from saved state to prevent hash changes
   * @param {Array} models - Array of model objects
   * @returns {Array} - Models with timestamp fields removed
   */
  stripTimestamps(models) {
    if (!Array.isArray(models)) return models;
    
    const TIMESTAMP_FIELDS = ['created', 'updated', 'modified_at'];
    
    return models.map(model => {
      const stripped = { ...model };
      for (const field of TIMESTAMP_FIELDS) {
        delete stripped[field];
      }
      return stripped;
    });
  }

  /**
   * Save current scan state
   * @param {Array} results - Current scan results
   */
  saveState(results) {
    const state = {
      endpoints: {}
    };

    for (const result of results) {
      state.endpoints[result.endpoint] = {
        success: result.success,
        models: this.stripTimestamps(result.models || []),
        error: result.error
      };
    }

    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Failed to save state:', err.message);
    }
  }

  /**
   * Log scan results to a timestamped JSON file
   * @param {Array} results - Current scan results
   * @param {Object} changes - Changes detected
   * @returns {string} - Path to log file
   */
  logScan(results, changes) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(this.outputDir, `scan-${timestamp}.json`);

    const logEntry = {
      timestamp: new Date().toISOString(),
      scan: {
        totalEndpoints: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
      },
      results: results.map(r => ({
        endpoint: r.endpoint,
        success: r.success,
        modelCount: r.success ? r.models.length : 0,
        models: r.success ? r.models : undefined,
        error: r.error
      })),
      changes
    };

    try {
      fs.writeFileSync(logFile, JSON.stringify(logEntry, null, 2));
      console.log(`Log written to: ${logFile}`);
    } catch (err) {
      console.error('Failed to write log:', err.message);
    }

    return logFile;
  }

  /**
   * Log changes to repo/config (for git-tracked changes)
   * @param {Object} changeInfo - Information about what changed
   */
  logRepoChanges(changeInfo) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(this.outputDir, `repo-changes-${timestamp}.json`);

    const logEntry = {
      timestamp: new Date().toISOString(),
      type: 'repo_change',
      ...changeInfo
    };

    try {
      fs.writeFileSync(logFile, JSON.stringify(logEntry, null, 2));
      console.log(`Repo change log written to: ${logFile}`);
    } catch (err) {
      console.error('Failed to write repo change log:', err.message);
    }

    return logFile;
  }

  /**
   * Clean up old log files
   */
  cleanupOldLogs() {
    try {
      const files = fs.readdirSync(this.outputDir);
      const now = Date.now();
      const msPerDay = 24 * 60 * 60 * 1000;
      const cutoff = now - (this.historyDays * msPerDay);

      for (const file of files) {
        const filePath = path.join(this.outputDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          console.log(`Deleted old log: ${file}`);
        }
      }
    } catch (err) {
      console.error('Failed to cleanup old logs:', err.message);
    }
  }

  /**
   * Get recent logs
   * @param {number} count - Number of recent logs to return
   * @returns {Array} - Recent log entries
   */
  getRecentLogs(count = 10) {
    try {
      const files = fs.readdirSync(this.outputDir)
        .filter(f => f.startsWith('scan-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, count);

      return files.map(f => {
        const data = fs.readFileSync(path.join(this.outputDir, f), 'utf-8');
        return JSON.parse(data);
      });
    } catch (err) {
      console.error('Failed to read recent logs:', err.message);
      return [];
    }
  }
}

export default Logger;
