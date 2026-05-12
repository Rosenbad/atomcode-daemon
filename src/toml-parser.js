/**
 * Robust TOML parser for AtomCode configuration
 * Supports the TOML spec subset needed for AtomCode config files
 */

class TomlParser {
  constructor() {
    this.errors = [];
  }

  /**
   * Parse TOML string into JavaScript object
   */
  parse(toml) {
    this.errors = [];
    const result = {};
    let currentTable = result;
    const tableStack = [];
    
    const lines = toml.split('\n');
    let lineNumber = 0;
    let inMultiLineString = false;
    let multiLineBuffer = '';
    let multiLineKey = '';
    let multiLineTable = null;

    for (const rawLine of lines) {
      lineNumber++;
      const line = rawLine.trim();

      // Skip empty lines and comments (unless in multiline string)
      if (!inMultiLineString) {
        if (!line || line.startsWith('#')) continue;
      }

      // Handle multiline strings (""" or ''')
      if (inMultiLineString) {
        const endMatch = rawLine.match(/^(.*?)"""\s*$/);
        if (endMatch) {
          multiLineBuffer += endMatch[1];
          this._setValue(currentTable, multiLineKey, this._parseValue(`"""${multiLineBuffer}"""`));
          inMultiLineString = false;
          multiLineBuffer = '';
          multiLineKey = '';
          multiLineTable = null;
        } else {
          multiLineBuffer += rawLine + '\n';
        }
        continue;
      }

      // Check for multiline string start
      const multiLineMatch = line.match(/^([\w.]+)\s*=\s*"""\s*(.*?)$/);
      if (multiLineMatch) {
        const [, key, firstLine] = multiLineMatch;
        if (firstLine.includes('"""')) {
          // Single line multiline string
          const value = firstLine.replace(/"""\s*$/, '');
          this._setValue(currentTable, key, value);
        } else {
          inMultiLineString = true;
          multiLineKey = key;
          multiLineBuffer = firstLine ? firstLine + '\n' : '';
          multiLineTable = currentTable;
        }
        continue;
      }

      // Table array: [[table]]
      const tableArrayMatch = line.match(/^\[\[([^\]]+)\]\]\s*(?:#.*)?$/);
      if (tableArrayMatch) {
        const tablePath = tableArrayMatch[1].trim();
        currentTable = this._ensureArrayTable(result, tablePath);
        continue;
      }

      // Table: [table]
      const tableMatch = line.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
      if (tableMatch) {
        const tablePath = tableMatch[1].trim();
        currentTable = this._ensureTable(result, tablePath);
        continue;
      }

      // Key-value pair
      const kvMatch = line.match(/^([\w.-]+)\s*=\s*(.+)$/);
      if (kvMatch) {
        const [, key, rawValue] = kvMatch;
        try {
          const value = this._parseValue(rawValue.trim());
          this._setValue(currentTable, key, value);
        } catch (err) {
          this.errors.push({ line: lineNumber, message: err.message, line: rawLine });
        }
        continue;
      }

      // If we get here, the line couldn't be parsed
      if (line) {
        this.errors.push({ line: lineNumber, message: 'Unrecognized TOML syntax', content: rawLine });
      }
    }

    if (inMultiLineString) {
      this.errors.push({ line: lineNumber, message: 'Unclosed multiline string' });
    }

    return result;
  }

  /**
   * Parse a TOML value into JavaScript type
   */
  _parseValue(raw) {
    // String (double quoted)
    if (raw.startsWith('"') && raw.endsWith('"')) {
      return this._parseString(raw.slice(1, -1));
    }

    // String (single quoted - literal)
    if (raw.startsWith("'") && raw.endsWith("'")) {
      return raw.slice(1, -1);
    }

    // Multiline string (already handled in main parser, but just in case)
    if (raw.startsWith('"""') && raw.endsWith('"""')) {
      return this._parseString(raw.slice(3, -3));
    }

    // Array
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return this._parseArray(raw.slice(1, -1));
    }

    // Inline table
    if (raw.startsWith('{') && raw.endsWith('}')) {
      return this._parseInlineTable(raw.slice(1, -1));
    }

    // Boolean
    if (raw === 'true') return true;
    if (raw === 'false') return false;

    // Null
    if (raw === 'null') return null;

    // Number (integer or float)
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) {
      return parseFloat(raw);
    }

    // Date/DateTime (basic ISO format)
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      return new Date(raw);
    }

    // Bare string (unquoted)
    return raw;
  }

  /**
   * Parse escape sequences in strings
   */
  _parseString(str) {
    const escapes = {
      '\\n': '\n',
      '\\t': '\t',
      '\\r': '\r',
      '\\\\': '\\',
      '\\"': '"',
      '\\b': '\b',
      '\\f': '\f',
    };
    
    let result = str;
    for (const [escape, char] of Object.entries(escapes)) {
      result = result.split(escape).join(char);
    }
    
    // Handle unicode escapes \uXXXX
    result = result.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => 
      String.fromCharCode(parseInt(hex, 16))
    );
    
    return result;
  }

  /**
   * Parse array values
   */
  _parseArray(content) {
    const result = [];
    let depth = 0;
    let current = '';
    
    for (const char of content) {
      if (char === '[') depth++;
      if (char === ']') depth--;
      
      if (char === ',' && depth === 0) {
        const trimmed = current.trim();
        if (trimmed) {
          result.push(this._parseValue(trimmed));
        }
        current = '';
      } else {
        current += char;
      }
    }
    
    const trimmed = current.trim();
    if (trimmed) {
      result.push(this._parseValue(trimmed));
    }
    
    return result;
  }

  /**
   * Parse inline table
   */
  _parseInlineTable(content) {
    const result = {};
    const pairs = content.split(',');
    
    for (const pair of pairs) {
      const match = pair.match(/^\s*([\w-]+)\s*=\s*(.+?)\s*$/);
      if (match) {
        const [, key, value] = match;
        result[key] = this._parseValue(value);
      }
    }
    
    return result;
  }

  /**
   * Split a TOML table path like providers."AtomGit-GLM-5.1" into parts,
   * respecting quoted segments (which may contain dots).
   */
  _splitTablePath(path) {
    const parts = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';

    for (let i = 0; i < path.length; i++) {
      const char = path[i];

      if ((char === '"' || char === "'") && !inQuotes) {
        inQuotes = true;
        quoteChar = char;
        // Don't include the quote in current
      } else if (char === quoteChar && inQuotes) {
        inQuotes = false;
        quoteChar = '';
        // Don't include the quote in current
      } else if (char === '.' && !inQuotes) {
        // Segment boundary
        if (current) {
          parts.push(current);
        }
        current = '';
      } else {
        current += char;
      }
    }

    // Push the last segment
    if (current) {
      parts.push(current);
    }

    return parts;
  }

  /**
   * Ensure a table path exists and return it
   */
  _ensureTable(root, path) {
    const parts = this._splitTablePath(path);
    let current = root;

    for (const part of parts) {
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part];
    }

    return current;
  }

  /**
   * Ensure a table array path exists and return the last element
   */
  _ensureArrayTable(root, path) {
    const parts = this._splitTablePath(path);
    let current = root;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part];
    }

    const lastPart = parts[parts.length - 1];
    if (!(lastPart in current)) {
      current[lastPart] = [];
    }
    if (!Array.isArray(current[lastPart])) {
      current[lastPart] = [current[lastPart]];
    }

    const newTable = {};
    current[lastPart].push(newTable);
    return newTable;
  }

  /**
   * Set a value, handling dotted keys
   */
  _setValue(table, key, value) {
    const parts = key.split('.');
    let current = table;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part];
    }
    
    current[parts[parts.length - 1]] = value;
  }

  /**
   * Get parsing errors
   */
  getErrors() {
    return this.errors;
  }

  /**
   * Check if parsing had errors
   */
  hasErrors() {
    return this.errors.length > 0;
  }
}

/**
 * Parse TOML string - convenience function
 */
export function parseToml(toml) {
  const parser = new TomlParser();
  return parser.parse(toml);
}

/**
 * Parse TOML with error reporting
 */
export function parseTomlSafe(toml) {
  const parser = new TomlParser();
  const result = parser.parse(toml);
  return {
    data: result,
    errors: parser.getErrors(),
    success: !parser.hasErrors()
  };
}

export { TomlParser };
