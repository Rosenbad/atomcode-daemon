import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { homedir } from 'os';

/**
 * AI Engine: wraps the atomcode CLI headless mode.
 * Falls back to a mock if atomcode CLI is not available.
 * Supports Vision API for image analysis.
 */
class Engine {
  constructor(config, workingDir) {
    this.config = config;
    this._available = null; // lazy check
    this.workingDir = workingDir || process.cwd();
  }

  async _checkAvailable() {
    if (this._available !== null) return this._available;
    const path = await import('path');
    const fs = await import('fs');
    
    // Search in PATH environment variable
    const pathEnv = process.env.PATH || '';
    const pathDirs = pathEnv.split(/[;]+/);
    console.log('[engine] Searching for atomcode CLI...');
    console.log('[engine] PATH dirs:', pathDirs.length);
    
    // Additional hardcoded search paths for Windows
    const extraPaths = [
      'D:\\AtomCode',
      'C:\\Program Files\\AtomCode',
      'C:\\Program Files (x86)\\AtomCode',
      join(homedir(), 'AppData', 'Local', 'AtomCode'),
      join(homedir(), 'AppData', 'Roaming', 'AtomCode'),
    ];
    const allDirs = [...pathDirs, ...extraPaths];
    
    for (const dir of allDirs) {
      const exePaths = ['atomcode.exe', 'atomcode'];
      for (const name of exePaths) {
        const full = path.join(dir, name);
        try {
          fs.accessSync(full, fs.constants.F_OK);
          console.log('[engine] Found atomcode:', full);
          this._available = true;
          this._cliPath = full;
          return this._available;
        } catch {}
      }
    }
    console.log('[engine] atomcode NOT found, will use API/Mock mode');
    this._available = false;
    return this._available;
  }

  get available() {
    return this._available === true;
  }

  /**
   * Load API access token from ~/.atomcode/auth.toml
   */
  _loadAuthToken() {
    if (this._authToken !== undefined) return this._authToken;
    const authPath = join(homedir(), '.atomcode', 'auth.toml');
    try {
      if (!existsSync(authPath)) {
        this._authToken = null;
        return null;
      }
      const raw = readFileSync(authPath, 'utf-8');
      const match = raw.match(/^access_token\s*=\s*"([^"]+)"/m);
      this._authToken = match ? match[1] : null;
      console.log('[engine] Loaded auth token from', authPath, this._authToken ? '(ok)' : '(not found)');
      return this._authToken;
    } catch (err) {
      console.warn('[engine] Failed to load auth token:', err.message);
      this._authToken = null;
      return null;
    }
  }

  /**
   * Find a provider config by name from config.providers
   */
  _findProvider(name) {
    if (!name) return null;
    return this.config.providers.find(p => p.name === name) || null;
  }

  /**
   * Find the best provider for Vision API calls.
   * Priority: visionPreprocessorProvider > defaultProvider > first openai-type provider
   */
  _findVisionProvider(requestedProvider) {
    // Priority: ① visionPreprocessorProvider (配置的视觉模型) → ② requested provider (前端指定) → ③ default provider → ④ 第一个 openai provider
    const vpp = this._findProvider(this.config.visionPreprocessorProvider);
    if (vpp && vpp.baseUrl) return vpp;
    if (requestedProvider) {
      const p = this._findProvider(requestedProvider);
      if (p && p.type === 'openai' && p.baseUrl) return p;
    }
    // 3. Default provider
    const dp = this._findProvider(this.config.defaultProvider);
    if (dp && dp.type === 'openai' && dp.baseUrl) return dp;
    // 4. First openai-type provider with baseUrl
    return this.config.providers.find(p => p.type === 'openai' && p.baseUrl) || null;
  }

  /**
   * Build OpenAI-compatible messages array with image_url content parts.
   */
  _buildApiMessages(messages) {
    const apiMessages = [];
    for (const msg of messages) {
      const hasImages = msg.images && msg.images.length > 0;
      
      if (hasImages) {
        const contentParts = [];
        
        if (msg.content && msg.content.trim()) {
          contentParts.push({ type: 'text', text: msg.content.trim() });
        }
        
        for (const img of msg.images) {
          try {
            const localPath = img.localPath;
            if (!localPath || !existsSync(localPath)) {
              contentParts.push({ type: 'text', text: `\n[图片文件不存在: ${img.originalName || 'unknown'}]` });
              continue;
            }
            const buffer = readFileSync(localPath);
            const base64 = buffer.toString('base64');
            const mimeType = img.mimeType || 'image/png';
            const dataUrl = `data:${mimeType};base64,${base64}`;
            
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: dataUrl,
                detail: 'high'
              }
            });
          } catch (err) {
            console.error('[engine] Failed to read image:', err.message);
            contentParts.push({ type: 'text', text: `\n[图片读取失败: ${img.originalName || 'unknown'}]` });
          }
        }
        
        apiMessages.push({ role: msg.role, content: contentParts });
      } else {
        apiMessages.push({ role: msg.role, content: msg.content || '' });
      }
    }
    return apiMessages;
  }

  /**
   * Generate a response. Returns an async generator of events.
   * When messages contain images, uses Vision API directly.
   */
  async *generate(sessionId, messages, { provider, model } = {}, signal) {
    const available = await this._checkAvailable();
    const lastMsg = messages[messages.length - 1];
    const hasImages = lastMsg?.images?.length > 0;

    // Explicit mock provider always uses built-in mock
    if (provider === 'mock') {
      yield* this._mockGenerate(sessionId, messages, signal);
      return;
    }

    // If user explicitly specified a provider, respect their choice
    if (provider && provider !== 'cli') {
      const providerConfig = this._findProvider(provider);
      if (providerConfig) {
        if (providerConfig.type === 'openai' && providerConfig.baseUrl) {
          // API-based provider - use API mode
          yield* this._useApi(sessionId, messages, { provider, model }, signal);
          return;
        } else if (providerConfig.type === 'cli') {
          // CLI-based provider
          if (available) {
            yield* this._useCli(sessionId, messages, provider, model, signal);
          } else {
            yield* this._mockGenerate(sessionId, messages, signal);
          }
          return;
        }
      }
    }

    // Default behavior when no explicit provider or provider not found
    if (hasImages) {
      yield* this._useApi(sessionId, messages, { provider, model }, signal);
    } else if (available) {
      yield* this._useCli(sessionId, messages, provider, model, signal);
    } else {
      yield* this._mockGenerate(sessionId, messages, signal);
    }
  }

  /**
   * Direct OpenAI-compatible Vision API call with streaming.
   */
  async *_useApi(sessionId, messages, { provider, model } = {}, signal) {
    // First try to find the provider the user explicitly selected
    let providerConfig = null;
    if (provider) {
      providerConfig = this._findProvider(provider);
    }
    
    // If no explicit provider or not found, fall back to vision provider
    if (!providerConfig) {
      providerConfig = this._findVisionProvider(provider);
    }
    
    if (!providerConfig) {
      yield { type: 'status', content: '⚠️ 未找到可用的 Provider', sessionId };
      yield { type: 'error', content: '未配置支持的 API Provider。请在 config.toml 中配置 OpenAI 兼容的 Provider（需含 base_url）。', sessionId };
      return;
    }

    if (!providerConfig.baseUrl) {
      yield { type: 'status', content: '⚠️ Provider 配置不完整', sessionId };
      yield { type: 'error', content: `Provider "${providerConfig.name}" 缺少 base_url 配置，请检查 config.toml。`, sessionId };
      return;
    }

    const modelName = model || providerConfig.models[0] || 'gpt-4o';
    const apiKey = providerConfig.apiKey || this._loadAuthToken() || process.env.ATOMCODE_API_KEY || process.env.OPENAI_API_KEY || '';
    const baseUrl = providerConfig.baseUrl.replace(/\/+$/, '');

    console.log(`[engine] Using API: ${providerConfig.name}, model: ${modelName}, base: ${baseUrl}`);

    // Show status based on whether we have images
    const lastMsg = messages[messages.length - 1];
    const hasImages = lastMsg?.images?.length > 0;
    yield { type: 'status', content: hasImages ? '🖼️ 正在分析图片...' : '🤔 思考中...', sessionId };

    // Build API messages
    const apiMessages = this._buildApiMessages(messages);

    // Inject system message with project context so the AI knows about the local working directory
    const systemMessage = {
      role: 'system',
      content: `你是一个本地 AI 助手，运行在用户的电脑上。当前工作目录是: ${this.workingDir}。当用户提到"项目"或询问目录信息时，请基于这个工作目录来回答。`
    };
    const messagesWithContext = [systemMessage, ...apiMessages];

    // Build request body
    const requestBody = {
      model: modelName,
      messages: messagesWithContext,
      stream: true,
      max_tokens: 4096,
    };

    // Queue-based async generator (same pattern as _useCli)
    const queue = [];
    let resolveNext = null;
    let closed = false;
    let finalContent = '';

    const push = (event) => {
      if (closed) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };

    const closeIter = () => {
      closed = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    };

    // Make the API call
    try {
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'AtomCode/1.0',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      console.log(`[engine] API request to: ${baseUrl}/chat/completions`);
      console.log(`[engine] Model: ${modelName}, Messages: ${apiMessages.length}`);
      console.log(`[engine] Has API key: ${!!apiKey}`);

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal,
      });

      console.log(`[engine] API response status: ${response.status}`);

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[engine] API error: ${response.status} - ${errText}`);
        push({ type: 'error', content: `请求失败: ${response.status} ${errText.slice(0, 500)}`, sessionId });
        closeIter();
        return;
      }

      // Parse SSE stream from API
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const processLines = () => {
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            push({ type: 'done', content: finalContent.trim(), sessionId, usage: {} });
            closeIter();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              finalContent += delta;
              push({ type: 'delta', content: delta, sessionId });
            }
            // Check for finish_reason
            const finishReason = parsed.choices?.[0]?.finish_reason;
            if (finishReason && finishReason !== 'null') {
              const usage = parsed.usage || {};
              push({ type: 'done', content: finalContent.trim(), sessionId, usage });
              closeIter();
              return;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      };

      // Read loop
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              // Stream ended without [DONE]
              if (finalContent) {
                push({ type: 'done', content: finalContent.trim(), sessionId, usage: {} });
              } else {
                push({ type: 'error', content: 'API 返回了空响应', sessionId });
              }
              closeIter();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            processLines();
            if (closed) return;
          }
        } catch (err) {
          if (err.name === 'AbortError') {
            push({ type: 'stopped', content: '已停止', sessionId });
          } else {
            push({ type: 'error', content: `API 流读取错误: ${err.message}`, sessionId });
          }
          closeIter();
        }
      })();

    } catch (err) {
      if (err.name === 'AbortError') {
        push({ type: 'stopped', content: '已停止', sessionId });
      } else {
        push({ type: 'error', content: `API 调用失败: ${err.message}`, sessionId });
      }
      closeIter();
    }

    // Yield from queue
    while (!closed) {
      if (queue.length > 0) {
        yield queue.shift();
      } else {
        const next = await new Promise(r => { resolveNext = r; });
        if (next.done) break;
        yield next.value;
      }
    }
  }

  /**
   * Shell out to atomcode -p headless mode — but yield events
   * by wrapping callbacks into an async generator pattern.
   */
  async *_useCli(sessionId, messages, provider, model, signal) {
    const lastMsg = messages[messages.length - 1]?.content || '';

    // Build prompt from recent messages, handling both string and array content
    const safeContent = (msg) => {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter(p => p.type === 'text')
          .map(p => p.text || '')
          .join(' ');
      }
      return '';
    };

    // CLI -p expects just the user's prompt, not conversation history
    const prompt = safeContent(messages[messages.length - 1] || {});

    const args = ['-p', prompt];
    if (provider && provider !== 'cli' && provider !== 'mock') args.push('--provider', provider);
    // Skip --model if model is "default" or undefined
    if (model && model !== 'default') args.push('--model', model);

    console.log('[engine] CLI args:', JSON.stringify(args));
    console.log('[engine] CLI cwd:', this.workingDir);
    console.log('[engine] Prompt (first 200 chars):', prompt.slice(0, 200));

    yield { type: 'status', content: '🤔 思考中...', sessionId };

    // Use a queue-based approach to convert callbacks into iterator
    const cliPath = this._cliPath || 'atomcode';
    const child = spawn(cliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd: this.workingDir,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', CI: '1' },
    });
    let done = false;
    let finalContent = '';
    let cliError = null;

    // ANSI escape sequence filter
    const ansiRegex = /[\x1b\x9b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
    const stripAnsi = (text) => text.replace(ansiRegex, '');

    // We'll push events into a queue and pull from it
    const queue = [];
    let resolveNext = null;
    let closed = false;

    const push = (event) => {
      if (closed) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: event, done: false });
      } else {
        queue.push(event);
      }
    };

    const closeIter = () => {
      closed = true;
      if (resolveNext) {
        resolveNext({ value: undefined, done: true });
        resolveNext = null;
      }
    };

    child.stdout.on('data', (chunk) => {
      let text = stripAnsi(chunk.toString());
      if (!text) return;

      // Remove CLI interactive confirmation placeholders ($1, $2, etc.)
      text = text.replace(/\$\d+/g, '');

      finalContent += text;
      push({ type: 'delta', content: text, sessionId });
    });

    child.stderr.on('data', (chunk) => {
      const text = stripAnsi(chunk.toString());
      if (!text) return;
      push({ type: 'verbose', content: text, sessionId });
    });

    child.on('close', (code) => {
      done = true;
      clearTimeout(timeoutTimer);
      if (code === 0) {
        const cleaned = finalContent.trim().replace(/\$\d+/g, '').trim();
        push({ type: 'done', content: cleaned, sessionId, code });
      } else {
        push({ type: 'error', content: `进程退出码: ${code}`, sessionId, code });
      }
      closeIter();
    });

    child.on('error', (err) => {
      push({ type: 'error', content: err.message, sessionId });
      closeIter();
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        child.kill();
        push({ type: 'stopped', content: '已停止', sessionId });
        closeIter();
      }, { once: true });
    }

    // Timeout: kill the CLI process if it takes too long (default 120s)
    const CLI_TIMEOUT = 120_000; // 2 minutes
    const timeoutTimer = setTimeout(() => {
      if (!done && !closed) {
        child.kill('SIGTERM');
        push({ type: 'error', content: `请求超时（超过 ${CLI_TIMEOUT / 1000} 秒），请检查 AI Provider 配置或网络连接`, sessionId });
        closeIter();
      }
    }, CLI_TIMEOUT);

    // Yield from queue
    while (!closed) {
      if (queue.length > 0) {
        yield queue.shift();
      } else if (done) {
        break;
      } else {
        const next = await new Promise(r => { resolveNext = r; });
        if (next.done) break;
        yield next.value;
      }
    }
  }

  /**
   * Mock generator for development/testing
   */
  async *_mockGenerate(sessionId, messages, signal) {
    const lastMsg = messages[messages.length - 1];
    const hasImages = lastMsg?.images?.length > 0;
    const lastContent = lastMsg?.content || '';
    const responseText = _mockResponse(lastContent, hasImages);

    yield { type: 'status', content: hasImages ? '🖼️ 分析图片中...' : '🤔 分析中...', sessionId };

    const words = responseText.split(/(?<=\s)/);
    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) {
        yield { type: 'stopped', content: '已停止', sessionId };
        return;
      }
      yield { type: 'delta', content: words[i], sessionId };
      await _sleep(30);
    }

    yield {
      type: 'done',
      content: responseText,
      sessionId,
      usage: {
        promptTokens: Math.ceil(lastContent.length / 4),
        completionTokens: Math.ceil(responseText.length / 4),
        totalTokens: Math.ceil((lastContent.length + responseText.length) / 4),
      },
    };
  }
}

function _mockResponse(prompt, hasImages) {
  const lower = prompt.toLowerCase();
  if (hasImages) {
    return '我收到了你发送的图片！当前运行在模拟模式下，无法真正分析图片内容。\n如需图片分析功能，请安装 atomcode CLI 并配置支持视觉的 Provider（如 AtomGit-Qwen-Qwen3-VL-8B-Instruct）。\n';
  }
  if (lower.includes('hello') || lower.includes('hi') || lower.includes('你好')) {
    return '你好！我是 AtomCode AI 助手，有什么可以帮助你的吗？\n';
  }
  if (lower.includes('explain') || lower.includes('解释')) {
    return '好的，我来解释一下：\n\n这是一个基于 AI 的代码助手系统。它能够理解代码上下文，帮助开发者完成编码、调试和重构等任务。\n\n核心功能包括：\n1. 代码理解与分析\n2. 智能补全与生成\n3. 自动化重构\n4. Bug 检测与修复\n';
  }
  if (lower.includes('summarize') || lower.includes('总结') || lower.includes('summary')) {
    return '## 项目总结\n\n该项目是一个 AI 驱动的开发辅助工具，主要特点：\n\n- **模块化架构**：core/CLI/daemon 分层设计\n- **多模型支持**：可接入 OpenAI、Ollama 等多种 Provider\n- **流式响应**：基于 SSE 的实时交互\n- **会话管理**：完整的历史记录与搜索\n\n';
  }
  return `收到你的消息：「${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}」\n\n我是 AtomCode AI，当前运行在 daemon 模式下（模拟响应）。\n如需真正的 AI 能力，请安装 atomcode CLI 并配置 Provider。\n`;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export { Engine };
