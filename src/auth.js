import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Simple token-based authentication for AtomCode Daemon
 * Tokens are stored in ~/.atomcode/daemon/tokens.json
 */

const TOKENS_FILE = join(homedir(), '.atomcode', 'daemon', 'tokens.json');
const AUTH_ENABLED_KEY = 'ATOMCODE_AUTH_ENABLED';
const AUTH_TOKEN_KEY = 'ATOMCODE_AUTH_TOKEN';

class AuthManager {
  constructor() {
    this.tokens = new Set();
    this.enabled = this._isAuthEnabled();
    this._loadTokens();
  }

  /**
   * Check if authentication is enabled via environment variable
   */
  _isAuthEnabled() {
    const envValue = process.env[AUTH_ENABLED_KEY];
    return envValue === 'true' || envValue === '1';
  }

  /**
   * Load tokens from file
   */
  _loadTokens() {
    if (!existsSync(TOKENS_FILE)) {
      return;
    }
    try {
      const data = JSON.parse(readFileSync(TOKENS_FILE, 'utf-8'));
      if (Array.isArray(data.tokens)) {
        this.tokens = new Set(data.tokens);
      }
    } catch (err) {
      console.warn('[auth] Failed to load tokens:', err.message);
    }
  }

  /**
   * Save tokens to file
   */
  _saveTokens() {
    try {
      const dir = join(homedir(), '.atomcode', 'daemon');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(TOKENS_FILE, JSON.stringify({
        tokens: Array.from(this.tokens),
        updatedAt: new Date().toISOString()
      }, null, 2));
    } catch (err) {
      console.warn('[auth] Failed to save tokens:', err.message);
    }
  }

  /**
   * Check if authentication is enabled
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Enable authentication
   */
  enable() {
    this.enabled = true;
    process.env[AUTH_ENABLED_KEY] = 'true';
    console.log('[auth] Authentication enabled');
  }

  /**
   * Disable authentication
   */
  disable() {
    this.enabled = false;
    process.env[AUTH_ENABLED_KEY] = 'false';
    console.log('[auth] Authentication disabled');
  }

  /**
   * Generate a new random token
   */
  generateToken() {
    const token = randomBytes(32).toString('hex');
    this.tokens.add(token);
    this._saveTokens();
    return token;
  }

  /**
   * Revoke a token
   */
  revokeToken(token) {
    const deleted = this.tokens.delete(token);
    if (deleted) {
      this._saveTokens();
    }
    return deleted;
  }

  /**
   * Validate a token
   */
  validateToken(token) {
    if (!this.enabled) {
      return true;
    }
    if (!token) {
      return false;
    }
    return this.tokens.has(token);
  }

  /**
   * Get the token from request headers or query params
   */
  extractToken(req) {
    // Check Authorization header: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }
    // Check X-Auth-Token header
    const authTokenHeader = req.headers['x-auth-token'];
    if (authTokenHeader) {
      return authTokenHeader;
    }
    // Check query param
    return req.query?.token || null;
  }

  /**
   * Express middleware to check authentication
   */
  middleware() {
    return (req, res, next) => {
      // Skip auth for health check and root info
      if (req.path === '/health' || req.path === '/') {
        return next();
      }

      if (!this.enabled) {
        return next();
      }

      const token = this.extractToken(req);
      if (!token) {
        return res.status(401).json({
          error: 'Authentication required',
          message: 'Please provide a valid token via Authorization header (Bearer <token>) or X-Auth-Token header'
        });
      }

      if (!this.validateToken(token)) {
        return res.status(403).json({
          error: 'Invalid token',
          message: 'The provided token is invalid or has been revoked'
        });
      }

      next();
    };
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      enabled: this.enabled,
      tokenCount: this.tokens.size
    };
  }
}

// Singleton instance
const authManager = new AuthManager();

export { authManager, AuthManager };
