# AtomCode Daemon

HTTP + SSE API service for AtomCode AI agent with file operation tools.

## Features

- **HTTP API** with SSE streaming chat
- **Web UI** for browser-based interaction
- **File Operations** - read, write, edit, list, search files
- **Shell Execution** - execute commands safely
- **Authentication** - optional token-based auth
- **Multi-Provider** - support for OpenAI, Claude, Ollama, etc.
- **Image Analysis** - vision API support
- **Session Management** - persistent conversation history

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Or start in development mode with auto-reload
npm run dev

# Run tests
npm test
```

## Configuration

Create `~/.atomcode/config.toml`:

```toml
default_provider = "openai"

[providers.openai]
type = "openai"
api_key = "sk-your-key"
model = "gpt-4o"
base_url = "https://api.openai.com/v1"

[daemon]
host = "127.0.0.1"
port = 18788
```

## API Endpoints

### Chat
- `POST /chat` - SSE streaming chat
- `POST /chat/stop` - Stop ongoing chat

### Sessions
- `GET /sessions` - List sessions
- `POST /sessions` - Create new session
- `GET /sessions/search?q=query` - Search sessions

### Tools
- `GET /tools` - List available tools
- `GET /tools/file/read?path=...` - Read file
- `POST /tools/file/write` - Write file
- `POST /tools/file/edit` - Search and replace
- `GET /tools/dir/list` - List directory
- `POST /tools/bash` - Execute command
- `GET /tools/grep?pattern=...` - Search in files
- `GET /tools/glob?pattern=...` - Find files

### Authentication
- `GET /auth/status` - Check auth status
- `POST /auth/token` - Generate token (admin)
- `DELETE /auth/token/:token` - Revoke token (admin)

### System
- `GET /health` - Health check
- `GET /models` - List available models
- `POST /config/reload` - Reload configuration

## Authentication

Enable authentication by setting environment variable:

```bash
ATOMCODE_AUTH_ENABLED=true
ATOMCODE_ADMIN_KEY=your-admin-key
```

Then use the token in requests:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:18788/tools/file/read?path=README.md
```

## File Operations

The daemon provides safe file operations with:
- Path validation (no escaping workspace)
- Sensitive path detection
- Destructive command confirmation
- Recursive operations support

Example:

```bash
# Read file
curl http://localhost:18788/tools/file/read?path=src/index.js

# Write file
curl -X POST http://localhost:18788/tools/file/write \
  -H "Content-Type: application/json" \
  -d '{"path": "test.txt", "content": "Hello World"}'

# Execute command
curl -X POST http://localhost:18788/tools/bash \
  -H "Content-Type: application/json" \
  -d '{"command": "ls -la"}'
```

## Project Structure

```
atomcode-daemon/
├── src/
│   ├── index.js          # Main server
│   ├── config.js         # Configuration management
│   ├── auth.js           # Authentication
│   ├── store.js          # Session storage
│   ├── engine.js         # AI engine
│   ├── tools.js          # File/shell tools
│   ├── toml-parser.js    # TOML parser
│   ├── logger.js         # Logging
│   └── web-ui.js         # Static file serving
├── public/
│   └── index.html        # Web UI
├── tests/
│   ├── toml-parser.test.js
│   └── tools.test.js
├── package.json
├── vitest.config.js
└── README.md
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ATOMCODE_AUTH_ENABLED` | Enable token authentication | `false` |
| `ATOMCODE_ADMIN_KEY` | Admin key for token management | - |
| `ATOMCODE_CORS_ORIGIN` | CORS origin | `*` |
| `LOG_LEVEL` | Log level (DEBUG, INFO, WARN, ERROR) | `INFO` |
| `LOG_FILE` | Log file path | `~/.atomcode/daemon.log` |

## Improvements Made

1. **Project Cleanup**
   - Added `.gitignore`
   - Removed debug scripts and logs

2. **Authentication**
   - Token-based auth system
   - Admin endpoints for token management
   - CORS configuration

3. **TOML Parser**
   - Robust TOML parser with error reporting
   - Support for all AtomCode config formats
   - Better error messages

4. **File Tools**
   - 10 file/shell operations
   - Path safety validation
   - Sensitive path detection
   - Destructive command protection

5. **Config Management**
   - Hot reload support
   - Better provider parsing
   - Path-based config access

6. **Testing**
   - Vitest test framework
   - TOML parser tests
   - File tools tests

7. **Logging**
   - Structured logging
   - Multiple log levels
   - File and console output

## License

MIT
