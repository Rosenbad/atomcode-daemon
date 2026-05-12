# AtomCode Daemon

HTTP + SSE API service for AtomCode AI agent with file operation tools.

## Prerequisites

- **Node.js** >= 18.0.0
- **AtomCode CLI** — installed and logged in (`atomcode login`)
- **config.toml** — auto-generated at `~/.atomcode/config.toml` after first login

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/Rosenbad/atomcode-daemon.git
cd atomcode-daemon

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

You'll see:
```
  🌐  http://127.0.0.1:18788
  🔧  CLI available: true
```

Open `http://127.0.0.1:18788` in your browser to use the web UI.

## How It Works

1. The daemon reads your AtomCode configuration from `~/.atomcode/config.toml` automatically.
2. It spawns the `atomcode` CLI in headless mode (`atomcode -p "..."`) for AI responses.
3. All providers defined in your config.toml appear in the UI dropdown.
4. The CLI has built-in file tools — no separate tool server is needed.
5. Sessions and messages are stored locally in `data/store.json`.

## Configuration

Create or edit `~/.atomcode/config.toml`:

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

The daemon hot-reloads config.toml when it changes — no restart needed.

## Features

- **HTTP API** with SSE streaming chat
- **Web UI** for browser-based interaction
- **CLI Mode** — uses atomcode CLI headless mode with built-in file tools
- **API Mode** — direct OpenAI-compatible API calls for Vision models
- **Image Analysis** — vision API support
- **Session Management** — persistent conversation history (local)
- **Authentication** — optional token-based auth
- **Directory Switching** — change working directory from UI or `/cd` endpoint

## API Endpoints

### Chat
- `POST /chat` — SSE streaming chat
- `POST /chat/stop` — Stop ongoing chat

### Sessions
- `GET /sessions` — List sessions
- `POST /sessions` — Create new session
- `GET /sessions/search?q=query` — Search sessions

### Tools
- `GET /tools` — List available tools
- `GET /tools/file/read?path=...` — Read file
- `POST /tools/file/write` — Write file
- `POST /tools/file/edit` — Search and replace
- `GET /tools/dir/list` — List directory
- `POST /tools/bash` — Execute command
- `GET /tools/grep?pattern=...` — Search in files
- `GET /tools/glob?pattern=...` — Find files

### System
- `GET /health` — Health check
- `GET /models` — List available models
- `POST /config/reload` — Reload configuration
- `POST /cd` — Change working directory

## Authentication

Enable authentication by setting environment variables:

```bash
ATOMCODE_AUTH_ENABLED=true
ATOMCODE_ADMIN_KEY=your-admin-key
```

Then use the token in requests:

```bash
curl -H "Authorization: Bearer <token>" http://localhost:18788/tools/file/read?path=README.md
```

## Important Notes

- The daemon must be running while you use the web UI.
- The `data/` directory stores session history. Deleting it resets all conversations.
- The daemon binds to `127.0.0.1` by default — not accessible from other machines.
- If `CLI available: false`, make sure `atomcode` is in your PATH or installed at `D:\AtomCode\`.
- Windows users: the daemon searches common AtomCode install paths automatically.

## Project Structure

```
atomcode-daemon/
├── src/
│   ├── index.js          # Main server
│   ├── config.js         # Configuration management + hot reload
│   ├── auth.js           # Token authentication
│   ├── store.js          # Session storage (local JSON)
│   ├── engine.js         # AI engine (CLI + API modes)
│   ├── tools.js          # 10 file/shell operations
│   ├── toml-parser.js    # TOML config parser
│   ├── logger.js         # Structured logging
│   └── web-ui.js         # Static file serving
├── public/
│   └── index.html        # Web UI
├── data/
│   └── store.json        # Session data (generated at runtime)
├── .gitignore
├── package.json
└── README.md
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ATOMCODE_AUTH_ENABLED` | Enable token authentication | `false` |
| `ATOMCODE_ADMIN_KEY` | Admin key for token management | - |
| `ATOMCODE_CORS_ORIGIN` | CORS origin | `*` |
| `LOG_LEVEL` | Log level (DEBUG, INFO, WARN, ERROR) | `INFO` |

## License

MIT
