/**
 * Core file and shell tools for AtomCode Daemon
 * Provides safe file operations with permission checks
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { join, resolve, dirname, extname, basename } from 'path';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { platform } from 'os';

const execAsync = promisify(exec);

/**
 * Sensitive paths that require explicit confirmation
 */
const SENSITIVE_PATHS = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/sys',
  '/dev',
  '/proc',
  '/root',
  process.env.HOME + '/.ssh',
  process.env.HOME + '/.gnupg',
  process.env.HOME + '.atomcode',
];

/**
 * Destructive commands that require confirmation
 */
const DESTRUCTIVE_COMMANDS = [
  'rm', 'del', 'rmdir', 'rd',
  'mv', 'move',
  'dd',
  'mkfs',
  'fdisk',
  'format',
  'shutdown', 'reboot', 'poweroff',
  'init', 'systemctl',
];

/**
 * Check if a path is sensitive
 */
function isSensitivePath(filePath) {
  const resolved = resolve(filePath);
  return SENSITIVE_PATHS.some(sensitive => 
    resolved.startsWith(sensitive) || resolved === sensitive
  );
}

/**
 * Check if a command is destructive
 */
function isDestructiveCommand(command) {
  const cmd = command.trim().toLowerCase().split(/\s+/)[0];
  return DESTRUCTIVE_COMMANDS.includes(cmd);
}

/**
 * Validate and resolve path within workspace
 */
function resolvePath(baseDir, relativePath) {
  const resolved = resolve(join(baseDir, relativePath));
  const baseResolved = resolve(baseDir);
  
  // Ensure the resolved path is within the base directory
  if (!resolved.startsWith(baseResolved)) {
    throw new Error(`Path "${relativePath}" is outside the workspace`);
  }
  
  return resolved;
}

/**
 * Tool: Read file contents
 */
export async function readFile(baseDir, filePath, options = {}) {
  const { offset = 0, limit } = options;
  
  try {
    const resolved = resolvePath(baseDir, filePath);
    
    if (!existsSync(resolved)) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    
    const stats = statSync(resolved);
    if (stats.isDirectory()) {
      return { success: false, error: `"${filePath}" is a directory, not a file` };
    }
    
    let content = readFileSync(resolved, 'utf-8');
    const totalLines = content.split('\n').length;
    
    // Apply offset and limit
    if (offset > 0 || limit !== undefined) {
      const lines = content.split('\n');
      const start = Math.max(0, offset);
      const end = limit !== undefined ? Math.min(lines.length, start + limit) : lines.length;
      content = lines.slice(start, end).join('\n');
    }
    
    return {
      success: true,
      content,
      path: filePath,
      size: stats.size,
      lines: { total: totalLines, returned: content.split('\n').length, offset }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Tool: Write file contents
 */
export async function writeFile(baseDir, filePath, content, options = {}) {
  const { append = false, createDirs = true } = options;
  
  try {
    const resolved = resolvePath(baseDir, filePath);
    
    // Check if path is sensitive
    const needsConfirmation = isSensitivePath(resolved);
    
    // Create parent directories if needed
    if (createDirs) {
      const parentDir = dirname(resolved);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
    }
    
    // Check if file exists
    const exists = existsSync(resolved);
    
    if (append && exists) {
      const existing = readFileSync(resolved, 'utf-8');
      writeFileSync(resolved, existing + content, 'utf-8');
    } else {
      writeFileSync(resolved, content, 'utf-8');
    }
    
    return {
      success: true,
      path: filePath,
      operation: append ? 'append' : (exists ? 'overwrite' : 'create'),
      needsConfirmation
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Tool: Edit file (search and replace)
 */
export async function editFile(baseDir, filePath, search, replace) {
  try {
    const resolved = resolvePath(baseDir, filePath);
    
    if (!existsSync(resolved)) {
      return { success: false, error: `File not found: ${filePath}` };
    }
    
    const content = readFileSync(resolved, 'utf-8');
    const occurrences = content.split(search).length - 1;
    
    if (occurrences === 0) {
      return { success: false, error: `Search text not found in "${filePath}"` };
    }
    
    const newContent = content.split(search).join(replace);
    writeFileSync(resolved, newContent, 'utf-8');
    
    return {
      success: true,
      path: filePath,
      replacements: occurrences,
      preview: newContent.substring(0, 200) + (newContent.length > 200 ? '...' : '')
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Tool: List directory contents
 */
export async function listDirectory(baseDir, dirPath = '.', options = {}) {
  const { recursive = false, includeHidden = false } = options;
  
  try {
    const resolved = resolvePath(baseDir, dirPath);
    
    if (!existsSync(resolved)) {
      return { success: false, error: `Directory not found: ${dirPath}` };
    }
    
    const stats = statSync(resolved);
    if (!stats.isDirectory()) {
      return { success: false, error: `"${dirPath}" is not a directory` };
    }
    
    const entries = readdirSync(resolved, { withFileTypes: true });
    const items = [];
    
    for (const entry of entries) {
      // Skip hidden files unless requested
      if (!includeHidden && entry.name.startsWith('.')) {
        continue;
      }
      
      const entryPath = join(resolved, entry.name);
      const entryStats = statSync(entryPath);
      
      const item = {
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entryStats.size,
        modified: entryStats.mtime.toISOString(),
      };
      
      // Recursively list subdirectories
      if (recursive && entry.isDirectory()) {
        const subResult = await listDirectory(baseDir, join(dirPath, entry.name), { recursive, includeHidden });
        if (subResult.success) {
          item.children = subResult.items;
        }
      }
      
      items.push(item);
    }
    
    // Sort: directories first, then alphabetically
    items.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    
    return {
      success: true,
      path: dirPath,
      items,
      count: items.length
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Tool: Execute bash/shell command
 */
export async function bash(baseDir, command, options = {}) {
  const { 
    timeout = 60000, 
    captureOutput = true,
    env = {},
    requireConfirmation = true
  } = options;
  
  try {
    // Check for destructive commands
    const needsConfirmation = requireConfirmation && isDestructiveCommand(command);
    
    const shell = platform() === 'win32' ? 'cmd' : 'bash';
    const shellFlag = platform() === 'win32' ? '/c' : '-c';
    
    const { stdout, stderr } = await execAsync(`${shell} ${shellFlag} "${command.replace(/"/g, '\\"')}"`, {
      cwd: baseDir,
      timeout,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024 // 10MB output limit
    });
    
    return {
      success: true,
      command,
      stdout: captureOutput ? stdout : null,
      stderr: captureOutput ? stderr : null,
      needsConfirmation
    };
  } catch (err) {
    return {
      success: false,
      command,
      error: err.message,
      stdout: err.stdout,
      stderr: err.stderr,
      code: err.code
    };
  }
}

/**
 * Tool: Grep/search in files
 */
export async function grep(baseDir, pattern, options = {}) {
  const { 
    path = '.', 
    include = '*',
    caseSensitive = false 
  } = options;
  
  try {
    const resolved = resolvePath(baseDir, path);
    const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    const results = [];
    
    async function searchInDir(dir, relativeDir) {
      const entries = readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relativePath = join(relativeDir, entry.name);
        
        if (entry.isDirectory()) {
          await searchInDir(fullPath, relativePath);
        } else if (entry.isFile()) {
          // Check include pattern
          if (include !== '*' && !entry.name.match(include)) {
            continue;
          }
          
          try {
            const content = readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            const matches = [];
            
            lines.forEach((line, index) => {
              if (regex.test(line)) {
                matches.push({
                  line: index + 1,
                  content: line.trim()
                });
              }
            });
            
            if (matches.length > 0) {
              results.push({
                file: relativePath,
                matches
              });
            }
          } catch (err) {
            // Skip binary or unreadable files
          }
        }
      }
    }
    
    const stats = statSync(resolved);
    if (stats.isDirectory()) {
      await searchInDir(resolved, path);
    } else {
      // Single file
      const content = readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const matches = [];
      
      lines.forEach((line, index) => {
        if (regex.test(line)) {
          matches.push({
            line: index + 1,
            content: line.trim()
          });
        }
      });
      
      if (matches.length > 0) {
        results.push({
          file: path,
          matches
        });
      }
    }
    
    return {
      success: true,
      pattern,
      results,
      totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Tool: Glob file matching
 */
export async function glob(baseDir, pattern) {
  const results = [];
  
  function matchGlob(filename, pattern) {
    const regex = new RegExp(
      '^' + pattern
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.')
        .replace(/{{GLOBSTAR}}/g, '.*')
        + '$'
    );
    return regex.test(filename);
  }
  
  function traverse(dir, relativeDir) {
    const entries = readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = join(relativeDir, entry.name);
      
      if (entry.isDirectory()) {
        traverse(fullPath, relativePath);
      } else if (entry.isFile()) {
        if (matchGlob(relativePath, pattern)) {
          results.push(relativePath);
        }
      }
    }
  }
  
  try {
    const resolved = resolvePath(baseDir, '.');
    traverse(resolved, '.');
    
    return {
      success: true,
      pattern,
      matches: results,
      count: results.length
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Tool: Get file info
 */
export async function fileInfo(baseDir, filePath) {
  try {
    const resolved = resolvePath(baseDir, filePath);
    
    if (!existsSync(resolved)) {
      return { success: false, error: `Path not found: ${filePath}` };
    }
    
    const stats = statSync(resolved);
    
    return {
      success: true,
      path: filePath,
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      created: stats.birthtime.toISOString(),
      modified: stats.mtime.toISOString(),
      accessed: stats.atime.toISOString(),
      permissions: stats.mode.toString(8).slice(-3),
      extension: stats.isFile() ? extname(filePath) : null,
      name: basename(filePath)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Tool: Delete file or directory
 */
export async function deletePath(baseDir, filePath, options = {}) {
  const { recursive = false } = options;
  
  try {
    const resolved = resolvePath(baseDir, filePath);
    
    if (!existsSync(resolved)) {
      return { success: false, error: `Path not found: ${filePath}` };
    }
    
    const needsConfirmation = isSensitivePath(resolved);
    const stats = statSync(resolved);
    
    if (stats.isDirectory()) {
      if (recursive) {
        // Simple recursive delete
        function deleteRecursive(dir) {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              deleteRecursive(fullPath);
            } else {
              unlinkSync(fullPath);
            }
          }
          // Note: Node.js doesn't have rmdirSync in this version, using shell
        }
        deleteRecursive(resolved);
        await bash(baseDir, `rmdir /s /q "${resolved}"`, { requireConfirmation: false });
      } else {
        return { success: false, error: 'Directory not empty. Use recursive=true to delete recursively' };
      }
    } else {
      unlinkSync(resolved);
    }
    
    return {
      success: true,
      path: filePath,
      type: stats.isDirectory() ? 'directory' : 'file',
      needsConfirmation
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Tool: Rename/move file or directory
 */
export async function rename(baseDir, oldPath, newPath) {
  try {
    const resolvedOld = resolvePath(baseDir, oldPath);
    const resolvedNew = resolvePath(baseDir, newPath);
    
    if (!existsSync(resolvedOld)) {
      return { success: false, error: `Source not found: ${oldPath}` };
    }
    
    if (existsSync(resolvedNew)) {
      return { success: false, error: `Destination already exists: ${newPath}` };
    }
    
    const needsConfirmation = isSensitivePath(resolvedOld) || isSensitivePath(resolvedNew);
    
    renameSync(resolvedOld, resolvedNew);
    
    return {
      success: true,
      from: oldPath,
      to: newPath,
      needsConfirmation
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get all available tools
 */
export function getTools() {
  return {
    read_file: readFile,
    write_file: writeFile,
    edit_file: editFile,
    list_directory: listDirectory,
    bash: bash,
    grep: grep,
    glob: glob,
    file_info: fileInfo,
    delete: deletePath,
    rename: rename,
  };
}

/**
 * Execute a tool by name
 */
export async function executeTool(toolName, baseDir, ...args) {
  const tools = getTools();
  
  if (!(toolName in tools)) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }
  
  try {
    return await tools[toolName](baseDir, ...args);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export default {
  readFile,
  writeFile,
  editFile,
  listDirectory,
  bash,
  grep,
  glob,
  fileInfo,
  deletePath,
  rename,
  getTools,
  executeTool,
};
