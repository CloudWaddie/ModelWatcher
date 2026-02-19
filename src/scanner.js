import axios from 'axios';

/**
 * Fetches models from an OpenAI-compatible API endpoint
 * @param {Object} endpoint - Endpoint configuration
 * @param {string} endpoint.baseUrl - Base URL for the API
 * @param {string} endpoint.apiKeyEnv - Environment variable name for API key
 * @param {string} endpoint.modelsEndpoint - Path to models endpoint
 * @param {Object} endpoint.headers - Additional headers
 * @param {number} timeout - Request timeout in ms
 * @returns {Promise<Object>} - Models data or error
 */
export async function fetchModels(endpoint, timeout = 30000) {
  const apiKey = process.env[endpoint.apiKeyEnv];
  
  if (!apiKey) {
    return {
      success: false,
      configured: false, // Not an error - user just didn't configure this endpoint
      error: `API key not found in env variable: ${endpoint.apiKeyEnv}`,
      endpoint: endpoint.name
    };
  }

  const url = `${endpoint.baseUrl.replace(/\/$/, '')}${endpoint.modelsEndpoint}`;
  
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...endpoint.headers
  };

  // Some APIs use different auth/headers
  if (endpoint.name === 'Anthropic') {
    headers['x-api-key'] = apiKey;
    delete headers['Authorization'];
  }

  // GitHub Models uses different headers
  if (endpoint.name === 'GitHub Models') {
    headers['Accept'] = 'application/vnd.github+json';
    headers['X-GitHub-Api-Version'] = '2022-11-28';
  }

  try {
    const response = await axios.get(url, {
      headers,
      timeout,
      validateStatus: () => true // Don't throw on non-2xx
    });

    if (response.status >= 200 && response.status < 300) {
      // Normalize response to common format
      const models = normalizeModels(response.data, endpoint);
      return {
        success: true,
        endpoint: endpoint.name,
        models,
        raw: response.data
      };
    } else {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        endpoint: endpoint.name,
        details: response.data
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err.message,
      endpoint: endpoint.name,
      code: err.code
    };
  }
}

/**
 * Normalize different API response formats to a common structure
 * @param {Object} data - Raw API response
 * @param {Object} endpoint - Endpoint configuration
 * @returns {Array} - Normalized models array
 */
function normalizeModels(data, endpoint) {
  // Handle different response formats
  let models = [];

  // OpenAI format: { data: [{ id: ..., ... }] }
  if (data.data && Array.isArray(data.data)) {
    models = data.data.map(m => ({
      id: m.id,
      name: m.id,
      created: m.created,
      owned_by: m.owned_by,
      permission: m.permission,
      root: m.root,
      parent: m.parent,
      // Additional fields
      object: m.object,
      ...m
    }));
  }
  // GitHub Models format: [{ id: ..., name: ..., publisher: ..., ... }]
  else if (endpoint.name === 'GitHub Models' && Array.isArray(data)) {
    models = data.map(m => ({
      id: m.id,
      name: m.name || m.id,
      publisher: m.publisher,
      registry: m.registry,
      summary: m.summary,
      html_url: m.html_url,
      ...m
    }));
  }
  // Anthropic/Ollama/Cohere/Mistral format: array or { models: [...] }
  else if (Array.isArray(data)) {
    models = data.map(m => ({
      id: m.id || m.name,
      name: m.id || m.name,
      ...m
    }));
  }
  // Ollama format: { models: [{ name: ..., ... }] }
  else if (data.models && Array.isArray(data.models)) {
    models = data.models.map(m => ({
      id: m.name,
      name: m.name,
      model: m.name,
      modified_at: m.modified_at,
      size: m.size,
      digest: m.digest,
      details: m.details
    }));
  }
  // Cohere format: { models: [...] }
  else if (data.models && Array.isArray(data.models)) {
    models = data.models.map(m => ({
      id: m.name || m.id,
      name: m.name || m.id,
      ...m
    }));
  }
  // Mistral format: { data: [...] }
  else if (data.data && Array.isArray(data.data)) {
    models = data.data.map(m => ({
      id: m.id,
      name: m.id,
      ...m
    }));
  }

  // Sort by ID
  models.sort((a, b) => a.id.localeCompare(b.id));

  return models;
}

/**
 * Scan all configured endpoints
 * @param {Array} endpoints - Array of endpoint configurations
 * @param {Object} scanConfig - Scan settings (timeout, retries)
 * @returns {Promise<Array>} - Results from all endpoints
 */
export async function scanEndpoints(endpoints, scanConfig = {}) {
  const { timeout = 30000, retryAttempts = 2, retryDelay = 1000 } = scanConfig;
  
  const results = await Promise.all(
    endpoints.map(async (endpoint) => {
      // Try with retries
      for (let attempt = 0; attempt <= retryAttempts; attempt++) {
        const result = await fetchModels(endpoint, timeout);
        
        if (result.success) {
          return result;
        }
        
        // Wait before retry (except on last attempt)
        if (attempt < retryAttempts && retryDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
      
      // Return last result after all retries
      return await fetchModels(endpoint, timeout);
    })
  );

  return results;
}

/**
 * Compare two model lists and find differences
 * @param {Array} oldModels - Previous scan models
 * @param {Array} newModels - Current scan models
 * @returns {Object} - Differences found
 */
export function compareModels(oldModels, newModels) {
  const oldIds = new Set(oldModels.map(m => m.id));
  const newIds = new Set(newModels.map(m => m.id));

  const added = newModels.filter(m => !oldIds.has(m.id));
  const removed = oldModels.filter(m => !newIds.has(m.id));
  
  // Find updated models (same ID but different properties)
  const updated = [];
  for (const newModel of newModels) {
    const oldModel = oldModels.find(m => m.id === newModel.id);
    if (oldModel) {
      const changes = getModelChanges(oldModel, newModel);
      if (Object.keys(changes).length > 0) {
        updated.push({
          model: newModel,
          changes
        });
      }
    }
  }

  return {
    added,
    removed,
    updated,
    summary: {
      addedCount: added.length,
      removedCount: removed.length,
      updatedCount: updated.length
    }
  };
}

/**
 * Get changes between two model objects
 * @param {Object} oldModel - Previous model state
 * @param {Object} newModel - Current model state
 * @returns {Object} - Changed properties
 */
function getModelChanges(oldModel, newModel) {
  const changes = {};
  
  // Compare all properties
  const allKeys = new Set([...Object.keys(oldModel), ...Object.keys(newModel)]);
  
  for (const key of allKeys) {
    const oldVal = JSON.stringify(oldModel[key]);
    const newVal = JSON.stringify(newModel[key]);
    
    if (oldVal !== newVal) {
      changes[key] = {
        old: oldModel[key],
        new: newModel[key]
      };
    }
  }
  
  return changes;
}
