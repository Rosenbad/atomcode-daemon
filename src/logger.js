/**
 * Structured logging for AtomCode Daemon
 * Supports multiple log levels and output formats
 */

import { createWriteStream } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const COLORS = {
  DEBUG: '\x1b[36m', // Cyan
  INFO: '\x1b[32m',  // Green
  WARN: '\x1b[33m',  // Yellow
  ERROR: '\x1b[31m', // Red
  RESET: '\x1b[0m',
};

class Logger {
  constructor(options = {}) {
    this.level = LOG_LEVELS[options.level?.toUpperCase()] ?? LOG_LEVELS.INFO;
    this.useColors = options.colors ?? true;
    this.useTimestamp = options.timestamp ?? true;
    this.logFile = options.logFile;
    this.fileStream = null;
    
    if (this.logFile) {
      this.fileStream = createWriteStream(this.logFile, { flags: 'a' });
    }
  }

  /**
   * Format a log message
   */
  _format(level, message, meta = {}) {
    const parts = [];
    
    if (this.useTimestamp) {
      parts.push(new Date().toISOString());
    }
    
    parts.push(`[${level}]`);
    parts.push(message);
    
    if (Object.keys(meta).length > 0) {
      parts.push(JSON.stringify(meta));
    }
    
    return parts.join(' ');
  }

  /**
   * Write to console and/or file
   */
  _write(level, formattedMessage, color) {
    // Console output
    if (this.useColors && color) {
      console.log(`${color}${formattedMessage}${COLORS.RESET}`);
    } else {
      console.log(formattedMessage);
    }
    
    // File output (without colors)
    if (this.fileStream) {
      this.fileStream.write(formattedMessage + '\n');
    }
  }

  /**
   * Log at a specific level
   */
  _log(levelName, message, meta) {
    const level = LOG_LEVELS[levelName];
    if (level < this.level) return;
    
    const formatted = this._format(levelName, message, meta);
    this._write(levelName, formatted, this.useColors ? COLORS[levelName] : null);
  }

  debug(message, meta) {
    this._log('DEBUG', message, meta);
  }

  info(message, meta) {
    this._log('INFO', message, meta);
  }

  warn(message, meta) {
    this._log('WARN', message, meta);
  }

  error(message, meta) {
    this._log('ERROR', message, meta);
  }

  /**
   * Log HTTP request
   */
  request(req, res, duration) {
    const meta = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
    };
    this.info('HTTP Request', meta);
  }

  /**
   * Log tool execution
   */
  tool(toolName, params, result) {
    const meta = {
      tool: toolName,
      params: typeof params === 'object' ? Object.keys(params) : params,
      success: result?.success,
    };
    this.info('Tool Execution', meta);
  }

  /**
   * Close file stream
   */
  close() {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }
}

// Create default logger
const defaultLogger = new Logger({
  level: process.env.LOG_LEVEL || 'INFO',
  colors: process.env.NODE_ENV !== 'production',
  logFile: process.env.LOG_FILE || join(homedir(), '.atomcode', 'daemon.log'),
});

export { Logger, LOG_LEVELS, defaultLogger };
export default defaultLogger;
