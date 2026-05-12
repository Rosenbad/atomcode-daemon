import { readFileSync, existsSync, watch } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parseTomlSafe } from './toml-parser.js';

/**
 * Load configuration from ~/.atomcode/config.toml
 * Falls back to defaults if file doesn't exist.
 * Supports hot reload via watch mode.
 */

const DEFAULT_CONFIG = {
  providers: [],
  defaultProvider: null,
  defaultModel: null,
  visionPreprocessorProvider: null,
  daemon: {
    host: '127.0.0.1',
    port: 18788,
  },
  storage: {
    dir: join(homedir(), '.atomcode', 'data'),
  },
};

class ConfigManager {
  constructor() {
    this.configPath = join(homedir(), '.atomcode', 'config.toml');
    this.config = { ...DEFAULT_CONFIG };
    this.watchers = [];
    this.loaded = false;
  }

  /**
   * Load configuration from file
   */
  load() {
    if (!existsSync(this.configPath)) {
      console.warn(`[config] No config found at ${this.configPath}, using defaults`);
      this._setupDefaultProvider();
      this.loaded = true;
      return this.config;
    }

    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const { data: parsed, errors, success } = parseTomlSafe(raw);
      
      if (!success) {
        console.warn('[config] TOML parsing errors:');
        errors.forEach(err => {
          console.warn(`  Line ${err.line}: ${err.message}`);
        });
      }

      this._applyParsedConfig(parsed);
      console.log(`[config] Loaded config from ${this.configPath}`);
      this.loaded = true;
    } catch (err) {
      console.warn(`[config] Failed to parse config: ${err.message}, using defaults`);
      this._setupDefaultProvider();
      this.loaded = true;
    }

    return this.config;
  }

  /**
   * Apply parsed TOML data to config object
   */
  _applyParsedConfig(parsed) {
    // Top-level fields
    if (parsed.default_provider) {
      this.config.defaultProvider = parsed.default_provider;
    }
    if (parsed.default_model) {
      this.config.defaultModel = parsed.default_model;
    }
    if (parsed.vision_preprocessor_provider) {
      this.config.visionPreprocessorProvider = parsed.vision_preprocessor_provider;
    }

    // Daemon settings
    if (parsed.daemon) {
      if (parsed.daemon.host) {
        this.config.daemon.host = parsed.daemon.host;
      }
      if (parsed.daemon.port) {
        this.config.daemon.port = parseInt(parsed.daemon.port, 10) || 18788;
      }
    }

    // Storage settings
    if (parsed.storage?.dir) {
      this.config.storage.dir = parsed.storage.dir;
    }

    // Parse providers - support both formats
    this.config.providers = [];
    
    // Format 1: [[providers]] array
    if (Array.isArray(parsed.providers)) {
      for (const p of parsed.providers) {
        this.config.providers.push(this._normalizeProvider(p));
      }
    }
    
    // Format 2: [providers.Name] table
    if (parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
      for (const [name, p] of Object.entries(parsed.providers)) {
        this.config.providers.push(this._normalizeProvider({ ...p, name }));
      }
    }

    // Set defaults if no providers configured
    if (this.config.providers.length === 0) {
      this._setupDefaultProvider();
    }
  }

  /**
   * Normalize provider config
   */
  _normalizeProvider(p) {
    let name = p.name || 'unnamed';
    // Strip quotes from provider names
    if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
      name = name.slice(1, -1);
    }
    
    return {
      name,
      type: p.type || 'openai',
      apiKey: p.api_key || p.apiKey,
      baseUrl: p.base_url || p.baseUrl,
      models: this._parseModels(p.models || p.model),
      contextWindow: parseInt(p.context_window || p.contextWindow, 10) || 64000,
      maxTokens: p.max_tokens || p.maxTokens,
      systemPrompt: p.system_prompt || p.systemPrompt,
      userAgent: p.user_agent || p.userAgent,
    };
  }

  /**
   * Parse models field (string or array)
   */
  _parseModels(models) {
    if (!models) return [];
    if (Array.isArray(models)) return models;
    if (typeof models === 'string') {
      return models.split(',').map(m => m.trim()).filter(Boolean);
    }
    return [];
  }

  /**
   * Setup default provider when no config exists
   */
  _setupDefaultProvider() {
    this.config.providers.push({
      name: 'default',
      type: 'cli',
      models: ['default'],
    });
    this.config.defaultProvider = 'default';
    this.config.defaultModel = 'default';
  }

  /**
   * Enable hot reload of config file
   */
  enableHotReload(callback) {
    if (!existsSync(this.configPath)) {
      return false;
    }

    const watcher = watch(this.configPath, (eventType) => {
      if (eventType === 'change') {
        console.log('[config] File changed, reloading...');
        const oldConfig = { ...this.config };
        this.load();
        if (callback) {
          callback(this.config, oldConfig);
        }
      }
    });

    this.watchers.push(watcher);
    return true;
  }

  /**
   * Stop watching config file
   */
  disableHotReload() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  /**
   * Get current config
   */
  get() {
    if (!this.loaded) {
      this.load();
    }
    return this.config;
  }

  /**
   * Get config value by path
   */
  getPath(path, defaultValue = undefined) {
    const parts = path.split('.');
    let current = this.get();
    
    for (const part of parts) {
      if (current === null || current === undefined || !(part in current)) {
        return defaultValue;
      }
      current = current[part];
    }
    
    return current;
  }

  /**
   * Get all providers
   */
  getProviders() {
    return this.get().providers;
  }

  /**
   * Get provider by name
   */
  getProvider(name) {
    return this.get().providers.find(p => p.name === name);
  }

  /**
   * Get default provider
   */
  getDefaultProvider() {
    const config = this.get();
    if (config.defaultProvider) {
      return this.getProvider(config.defaultProvider);
    }
    return config.providers[0] || null;
  }
}

// Singleton instance
const configManager = new ConfigManager();

/**
 * Load config - convenience function
 */
export function loadConfig() {
  return configManager.load();
}

/**
 * Get config manager instance
 */
export function getConfigManager() {
  return configManager;
}

export { ConfigManager, configManager, DEFAULT_CONFIG };
