import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { v4 as uuidv4 } from 'uuid';

/**
 * In-memory store with optional JSON file persistence.
 * Manages sessions, projects, and conversation history.
 */
class Store {
  constructor(storageDir) {
    this.storageDir = storageDir;
    this.sessions = new Map();   // sessionId -> Session
    this.projects = new Map();   // projectHash -> { path, name, sessionIds[] }
    this.activeChats = new Map(); // sessionId -> AbortController
    this._load();
  }

  // ── Projects ──

  getProject(hash) {
    return this.projects.get(hash) || null;
  }

  listProjects() {
    return Array.from(this.projects.values());
  }

  _ensureProject(path) {
    const hash = this._hashPath(path);
    if (!this.projects.has(hash)) {
      this.projects.set(hash, {
        hash,
        path,
        name: path.split(/[\\/]/).pop() || path,
        sessionIds: [],
      });
      this._save();
    }
    return hash;
  }

  // ── Sessions ──

  createSession(projectPath) {
    const projectHash = this._ensureProject(projectPath);
    const session = {
      id: uuidv4().slice(0, 8),
      projectHash,
      projectPath,
      title: `Session ${Date.now()}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    this.sessions.set(session.id, session);
    this.projects.get(projectHash).sessionIds.push(session.id);
    this._save();
    return session;
  }

  getSession(id) {
    return this.sessions.get(id) || null;
  }

  listSessions(projectHash) {
    if (projectHash) {
      const project = this.projects.get(projectHash);
      if (!project) return [];
      return project.sessionIds
        .map(id => this.sessions.get(id))
        .filter(Boolean);
    }
    return Array.from(this.sessions.values());
  }

  searchSessions(query) {
    const q = query.toLowerCase();
    const results = [];
    for (const session of this.sessions.values()) {
      if (session.title.toLowerCase().includes(q) ||
          (session.messages.some(m =>
            typeof m.content === 'string' && m.content.toLowerCase().includes(q)
          ))) {
        results.push(session);
      }
    }
    return results;
  }

  addMessage(sessionId, role, content, meta = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const msg = {
      role,
      content,
      timestamp: new Date().toISOString(),
    };
    // Attach optional metadata (e.g. images)
    if (meta.images && meta.images.length > 0) {
      msg.images = meta.images;
    }
    session.messages.push(msg);
    session.updatedAt = new Date().toISOString();
    this._save();
    return msg;
  }

  renameSession(id, title) {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.title = title;
    session.updatedAt = new Date().toISOString();
    this._save();
    return session;
  }

  deleteSession(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    const project = this.projects.get(session.projectHash);
    if (project) {
      project.sessionIds = project.sessionIds.filter(sid => sid !== id);
    }
    this.sessions.delete(id);
    this._save();
    return true;
  }

  // ── Active Chat Tracking ──

  registerActiveChat(sessionId, controller) {
    this.activeChats.set(sessionId, controller);
  }

  stopChat(sessionId) {
    const controller = this.activeChats.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeChats.delete(sessionId);
      return true;
    }
    return false;
  }

  unregisterActiveChat(sessionId) {
    this.activeChats.delete(sessionId);
  }

  // ── Persistence ──

  _load() {
    const file = join(this.storageDir, 'store.json');
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      if (data.sessions) {
        for (const s of data.sessions) {
          this.sessions.set(s.id, s);
        }
      }
      if (data.projects) {
        for (const p of data.projects) {
          this.projects.set(p.hash, p);
        }
      }
      console.log(`[store] Loaded ${this.sessions.size} sessions, ${this.projects.size} projects`);
    } catch (err) {
      console.warn(`[store] Failed to load store: ${err.message}`);
    }
  }

  _save() {
    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }
      const data = {
        sessions: Array.from(this.sessions.values()),
        projects: Array.from(this.projects.values()),
      };
      const json = JSON.stringify(data, null, 2);
      const file = join(this.storageDir, 'store.json');
      // Write to temp file first, then rename (atomic, avoids file lock issues on Windows)
      const tmpFile = file + '.tmp';
      writeFileSync(tmpFile, json, 'utf-8');
      // On Windows, delete existing file first to avoid EPERM on rename
      try { writeFileSync(file, json, 'utf-8'); } catch {}
      try { require('fs').renameSync(tmpFile, file); } catch {}
    } catch (err) {
      // Silently fail - in-memory store still works
      console.warn(`[store] Save skipped: ${err.message}`);
    }
  }

  hashPath(path) {
    return this._hashPath(path);
  }

  _hashPath(path) {
    let hash = 0;
    for (let i = 0; i < path.length; i++) {
      const char = path.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).slice(0, 8);
  }
}

export { Store };
