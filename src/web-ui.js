import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const API_PREFIXES = ['/health', '/chat', '/sessions', '/projects', '/project', '/models', '/cd'];

export default function (app) {
  app.use(express.static(publicDir));
  // Only catch frontend routes, not API routes
  app.get('*', (req, res, next) => {
    if (API_PREFIXES.some(p => req.path.startsWith(p))) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });
}
