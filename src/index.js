import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createServer } from 'http';
import { homedir } from 'os';
import { join, extname } from 'path';
import { existsSync, mkdirSync, createReadStream, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { loadConfig, getConfigManager } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { authManager } from './auth.js';
import { getTools } from './tools.js';

// ── Bootstrap ──
const config = loadConfig();
const configManager = getConfigManager();
const store = new Store(join(process.cwd(), 'data'));
const engine = new Engine(config, process.cwd());

// Enable config hot reload - auto-reload when AtomCode updates config.toml
configManager.enableHotReload((newConfig, oldConfig) => {
  console.log('[config] Hot reload complete');
  console.log(`  Providers: ${oldConfig.providers.length} → ${newConfig.providers.length}`);
  
  // Update engine config reference so it uses new providers/models
  engine.config = newConfig;
});

const app = express();
const httpServer = createServer(app);

// Current working directory
let currentDir = process.cwd();

// ── Uploads directory ──
const uploadsDir = join(homedir(), '.atomcode', 'uploads');
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

// Multer config for image uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname) || '.png';
      cb(null, randomUUID() + ext);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i;
    if (allowed.test(extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('仅支持图片文件 (jpg, png, gif, webp, bmp, svg)'));
    }
  },
});

// ── CORS configuration ──
const corsOptions = {
  origin: process.env.ATOMCODE_CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Auth-Token'],
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

// ── Authentication middleware ──
app.use(authManager.middleware());

// Serve uploaded images
app.get('/uploads/:fileId', (req, res) => {
  const filePath = join(uploadsDir, req.params.fileId);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(filePath);
});

// Serve web UI
const webUI = await import('./web-ui.js');
webUI.default(app);

// ────────────────────────────────────────────
//  GET / - API Information
// ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'AtomCode Daemon',
    version: '0.1.0',
    description: 'AtomCode Daemon - HTTP + SSE API service for AtomCode AI agent',
    auth: {
      enabled: authManager.isEnabled(),
      endpoints: authManager.isEnabled() ? 'Require Bearer token or X-Auth-Token header' : 'No authentication required'
    },
    endpoints: {
      health: 'GET /health',
      project: 'GET /project',
      chat: 'POST /chat (SSE streaming)',
      chatStop: 'POST /chat/stop',
      upload: 'POST /upload (multipart, image files)',
      models: 'GET /models',
      sessions: 'GET /sessions, POST /sessions',
      sessionsSearch: 'GET /sessions/search?q=query',
      projects: 'GET /projects',
      projectSessions: 'GET /projects/:hash/sessions',
      sessionDetail: 'GET /projects/:hash/sessions/:id',
      deleteSession: 'DELETE /projects/:hash/sessions/:id',
      renameSession: 'PATCH /projects/:hash/sessions/:id/rename',
      changeDir: 'POST /cd',
      authStatus: 'GET /auth/status',
      authGenerate: 'POST /auth/token (admin only)',
      authRevoke: 'DELETE /auth/token/:token (admin only)',
    },
  });
});

// ────────────────────────────────────────────
//  GET /health
// ────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
    cliAvailable: engine.available,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    auth: authManager.getStats(),
  });
});

// ────────────────────────────────────────────
//  Authentication endpoints
// ────────────────────────────────────────────
app.get('/auth/status', (req, res) => {
  res.json({
    enabled: authManager.isEnabled(),
    ...authManager.getStats()
  });
});

app.post('/auth/token', (req, res) => {
  // Simple admin check - in production, use proper admin authentication
  const adminKey = req.headers['x-admin-key'];
  if (process.env.ATOMCODE_ADMIN_KEY && adminKey !== process.env.ATOMCODE_ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin authentication required' });
  }

  const token = authManager.generateToken();
  res.status(201).json({ token, message: 'Token generated successfully' });
});

app.delete('/auth/token/:token', (req, res) => {
  // Simple admin check
  const adminKey = req.headers['x-admin-key'];
  if (process.env.ATOMCODE_ADMIN_KEY && adminKey !== process.env.ATOMCODE_ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin authentication required' });
  }

  const revoked = authManager.revokeToken(req.params.token);
  if (revoked) {
    res.json({ message: 'Token revoked successfully' });
  } else {
    res.status(404).json({ error: 'Token not found' });
  }
});

// ────────────────────────────────────────────
//  GET /project
// ────────────────────────────────────────────
app.get('/project', (req, res) => {
  const hash = store.hashPath(currentDir);
  const project = store.getProject(hash) || {
    hash,
    path: currentDir,
    name: currentDir.split(/[\\/]/).pop() || currentDir,
  };
  res.json({
    currentDir,
    project,
  });
});

// ────────────────────────────────────────────
//  POST /cd
// ────────────────────────────────────────────
app.post('/cd', (req, res) => {
  const { path } = req.body || {};
  if (!path) {
    return res.status(400).json({ error: 'Missing "path" in request body' });
  }
  // Support both absolute and relative paths
  const resolved = path.startsWith('/') || path.match(/^[A-Za-z]:/) 
    ? path  // absolute path
    : join(currentDir, path);  // relative path
  try {
    // Verify the directory exists
    if (!existsSync(resolved)) {
      return res.status(404).json({ error: `Directory not found: ${resolved}` });
    }
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: `Not a directory: ${resolved}` });
    }
    currentDir = resolved;
    // Update engine's workingDir so API calls know the project context
    engine.workingDir = currentDir;
    console.log(`[daemon] Changed working directory to: ${currentDir}`);
    res.json({ currentDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────
//  GET /models
// ────────────────────────────────────────────
app.get('/models', (req, res) => {
  const models = config.providers.map(p => ({
    provider: p.name,
    type: p.type,
    models: p.models,
    baseUrl: p.baseUrl || null,
  }));

  // Also detect CLI availability
  if (engine.available) {
    models.unshift({
      provider: 'cli',
      type: 'atomcode-cli',
      models: ['default'],
      baseUrl: null,
    });
  }

  // Always include mock for development
  models.push({
    provider: 'mock',
    type: 'builtin',
    models: ['default'],
    baseUrl: null,
    description: '内置模拟响应（开发调试用）',
  });

  res.json({ models, defaultProvider: config.defaultProvider, defaultModel: config.defaultModel });
});

// ────────────────────────────────────────────
//  GET /sessions
// ────────────────────────────────────────────
app.get('/sessions', (req, res) => {
  const { project } = req.query;
  const sessions = store.listSessions(project || undefined);
  res.json({ sessions });
});

// ────────────────────────────────────────────
//  POST /sessions
// ────────────────────────────────────────────
app.post('/sessions', (req, res) => {
  const { project } = req.body || {};
  const session = store.createSession(project || currentDir);
  res.status(201).json({ session });
});

// ────────────────────────────────────────────
//  GET /sessions/search
// ────────────────────────────────────────────
app.get('/sessions/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query parameter "q"' });
  const results = store.searchSessions(q);
  res.json({ results });
});

// ────────────────────────────────────────────
//  GET /projects
// ────────────────────────────────────────────
app.get('/projects', (req, res) => {
  res.json({ projects: store.listProjects() });
});

// ────────────────────────────────────────────
//  GET /projects/:hash/sessions
// ────────────────────────────────────────────
app.get('/projects/:hash/sessions', (req, res) => {
  const sessions = store.listSessions(req.params.hash);
  res.json({ sessions });
});

// ────────────────────────────────────────────
//  GET /projects/:hash/sessions/:id
// ────────────────────────────────────────────
app.get('/projects/:hash/sessions/:id', (req, res) => {
  const session = store.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

// ────────────────────────────────────────────
//  DELETE /projects/:hash/sessions/:id
// ────────────────────────────────────────────
app.delete('/projects/:hash/sessions/:id', (req, res) => {
  const deleted = store.deleteSession(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Session not found' });
  res.json({ status: 'deleted' });
});

// ────────────────────────────────────────────
//  PATCH /projects/:hash/sessions/:id/rename
// ────────────────────────────────────────────
app.patch('/projects/:hash/sessions/:id/rename', (req, res) => {
  const { title } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Missing "title" in request body' });
  const session = store.renameSession(req.params.id, title);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

// ────────────────────────────────────────────
//  POST /upload  — Upload images
// ────────────────────────────────────────────
app.post('/upload', upload.single('image'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  res.json({
    id: file.filename,
    originalName: file.originalname,
    url: `/uploads/${file.filename}`,
    size: file.size,
    mimeType: file.mimetype,
  });
});

// Multer error handler
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '文件过大，最大支持 10MB' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err.message?.includes('仅支持图片')) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: err.message });
});

// ────────────────────────────────────────────
//  POST /chat  — SSE streaming (supports images)
// ────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  const { prompt, sessionId, provider, model, images } = req.body || {};
  if (!prompt && (!images || images.length === 0)) {
    return res.status(400).json({ error: 'Missing "prompt" or "images" in request body' });
  }

  // Create or reuse session
  let session;
  if (sessionId) {
    session = store.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
  } else {
    session = store.createSession(currentDir);
  }

  // Add user message (with optional images)
  store.addMessage(session.id, 'user', prompt || '', { images: images || [] });

  // Enrich images with localPath and mimeType before passing to engine
  const lastMsg = session.messages[session.messages.length - 1];
  if (lastMsg && lastMsg.images && lastMsg.images.length > 0) {
    for (const img of lastMsg.images) {
      // Extract filename from url (e.g. '/uploads/abc.png' -> 'abc.png')
      const filename = img.url.replace(/^\/uploads\//, '');
      img.localPath = join(uploadsDir, filename);
      // Determine mimeType from extension
      const ext = extname(filename).toLowerCase();
      const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
      };
      img.mimeType = mimeMap[ext] || `image/${ext.replace('.', '')}`;
    }
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Abort controller for stop
  const abortController = new AbortController();
  store.registerActiveChat(session.id, abortController);

  let fullResponse = '';

  try {
    const generator = engine.generate(session.id, session.messages, { provider, model }, abortController.signal);

    for await (const event of generator) {
      // SSE format: "event: <type>\ndata: <json>\n\n"
      const data = JSON.stringify(event);
      res.write(`event: ${event.type}\ndata: ${data}\n\n`);

      if (event.type === 'delta') {
        fullResponse += event.content || '';
      }

      if (event.type === 'done' || event.type === 'error' || event.type === 'stopped') {
        break;
      }
    }
  } catch (err) {
    const errData = JSON.stringify({ type: 'error', content: err.message, sessionId: session.id });
    res.write(`event: error\ndata: ${errData}\n\n`);
  } finally {
    store.unregisterActiveChat(session.id);
    // Save the assistant response
    if (fullResponse) {
      store.addMessage(session.id, 'assistant', fullResponse);
    }
    res.end();
  }
});

// ────────────────────────────────────────────
//  POST /chat/stop
// ────────────────────────────────────────────
app.post('/chat/stop', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Missing "sessionId" in request body' });

  const stopped = store.stopChat(sessionId);
  res.json({ stopped, sessionId });
});

// ────────────────────────────────────────────
//  Tools API - File and Shell Operations
// ────────────────────────────────────────────

// List available tools
app.get('/tools', (req, res) => {
  const tools = Object.keys(getTools()).map(name => ({
    name,
    description: getToolDescription(name)
  }));
  res.json({ tools });
});

// Execute a tool
app.post('/tools/:toolName', async (req, res) => {
  const { toolName } = req.params;
  const params = req.body || {};
  
  const tools = getTools();
  if (!(toolName in tools)) {
    return res.status(404).json({ error: `Unknown tool: ${toolName}` });
  }
  
  try {
    const result = await tools[toolName](currentDir, ...params.args, params.options || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Specific tool endpoints for convenience

// Read file
app.get('/tools/file/read', async (req, res) => {
  const { path, offset, limit } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing "path" parameter' });
  
  const tools = getTools();
  const result = await tools.read_file(currentDir, path, { offset: parseInt(offset) || 0, limit: limit ? parseInt(limit) : undefined });
  res.json(result);
});

// Write file
app.post('/tools/file/write', async (req, res) => {
  const { path, content, append } = req.body || {};
  if (!path) return res.status(400).json({ error: 'Missing "path" in request body' });
  if (content === undefined) return res.status(400).json({ error: 'Missing "content" in request body' });
  
  const tools = getTools();
  const result = await tools.write_file(currentDir, path, content, { append: !!append });
  res.json(result);
});

// Edit file (search/replace)
app.post('/tools/file/edit', async (req, res) => {
  const { path, search, replace } = req.body || {};
  if (!path || !search || replace === undefined) {
    return res.status(400).json({ error: 'Missing required fields: path, search, replace' });
  }
  
  const tools = getTools();
  const result = await tools.edit_file(currentDir, path, search, replace);
  res.json(result);
});

// List directory
app.get('/tools/dir/list', async (req, res) => {
  const { path, recursive, includeHidden } = req.query;
  
  const tools = getTools();
  const result = await tools.list_directory(currentDir, path || '.', { 
    recursive: recursive === 'true', 
    includeHidden: includeHidden === 'true' 
  });
  res.json(result);
});

// Execute bash command
app.post('/tools/bash', async (req, res) => {
  const { command, timeout } = req.body || {};
  if (!command) return res.status(400).json({ error: 'Missing "command" in request body' });
  
  const tools = getTools();
  const result = await tools.bash(currentDir, command, { timeout: timeout || 60000 });
  res.json(result);
});

// Grep search
app.get('/tools/grep', async (req, res) => {
  const { pattern, path, include, caseSensitive } = req.query;
  if (!pattern) return res.status(400).json({ error: 'Missing "pattern" parameter' });
  
  const tools = getTools();
  const result = await tools.grep(currentDir, pattern, { 
    path: path || '.', 
    include: include || '*',
    caseSensitive: caseSensitive === 'true'
  });
  res.json(result);
});

// Glob file matching
app.get('/tools/glob', async (req, res) => {
  const { pattern } = req.query;
  if (!pattern) return res.status(400).json({ error: 'Missing "pattern" parameter' });
  
  const tools = getTools();
  const result = await tools.glob(currentDir, pattern);
  res.json(result);
});

// File info
app.get('/tools/file/info', async (req, res) => {
  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing "path" parameter' });
  
  const tools = getTools();
  const result = await tools.file_info(currentDir, path);
  res.json(result);
});

// Delete file/directory
app.delete('/tools/file/delete', async (req, res) => {
  const { path, recursive } = req.body || {};
  if (!path) return res.status(400).json({ error: 'Missing "path" in request body' });
  
  const tools = getTools();
  const result = await tools.delete(currentDir, path, { recursive: !!recursive });
  res.json(result);
});

// Rename/move file
app.post('/tools/file/rename', async (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'Missing "from" or "to" in request body' });
  
  const tools = getTools();
  const result = await tools.rename(currentDir, from, to);
  res.json(result);
});

// Helper function to get tool descriptions
function getToolDescription(name) {
  const descriptions = {
    read_file: 'Read file contents with optional offset and limit',
    write_file: 'Write or append content to a file',
    edit_file: 'Search and replace text in a file',
    list_directory: 'List directory contents',
    bash: 'Execute shell commands',
    grep: 'Search for patterns in files',
    glob: 'Find files matching a glob pattern',
    file_info: 'Get file metadata',
    delete: 'Delete files or directories',
    rename: 'Rename or move files'
  };
  return descriptions[name] || 'No description available';
}

// ────────────────────────────────────────────
//  Config reload endpoint
// ────────────────────────────────────────────
app.post('/config/reload', (req, res) => {
  const oldConfig = { ...configManager.get() };
  configManager.load();
  res.json({ 
    success: true, 
    message: 'Configuration reloaded',
    providers: configManager.get().providers.length
  });
});

// ── Start ─
const host = config.daemon?.host || '127.0.0.1';
const port = config.daemon?.port || 18788;

// Pre-check CLI availability before printing startup log
await engine._checkAvailable();

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ❌  Port ${port} is already in use!`);
    console.error(`  💡  Try: netstat -ano | findstr :${port}`);
    console.error(`  💡  Or change port in ~/.atomcode/config.toml\n`);
    process.exit(1);
  }
  throw err;
});

httpServer.listen(port, host, () => {
  console.log(`\n  ⚛  AtomCode Daemon v0.1.0`);
  console.log(`  ─────────────────────────`);
  console.log(`  🌐  http://${host}:${port}`);
  console.log(`  💓  GET /health`);
  console.log(`  💬  POST /chat (SSE streaming)`);
  console.log(`  📁  CWD: ${currentDir}`);
  console.log(`  🔧  CLI available: ${engine.available}`);
  console.log(`  📦  Sessions: ${store.sessions.size}, Projects: ${store.projects.size}`);
  console.log(`  🔐  Auth: ${authManager.isEnabled() ? 'enabled' : 'disabled'}`);
  if (authManager.isEnabled()) {
    console.log(`      Tokens: ${authManager.getStats().tokenCount}`);
  }
  console.log('');
});
