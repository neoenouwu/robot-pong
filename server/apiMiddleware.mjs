import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LeaderboardStore, VALID_MODES } from './leaderboardStore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_FILE = path.resolve(__dirname, '../data/leaderboard.json');

const MAX_BODY_BYTES = 8 * 1024;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON request body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function createApiMiddleware(dataFilePath = DEFAULT_DATA_FILE) {
  const store = new LeaderboardStore(dataFilePath);

  return async function apiMiddleware(req, res, next) {
    const urlStr = req.url || '/';
    if (!urlStr.startsWith('/api/')) {
      if (next) return next();
      return false;
    }

    const parsed = new URL(urlStr, 'http://localhost');
    const pathname = parsed.pathname;

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.end();
      return true;
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, service: 'sentinel-pong-leaderboard' });
      return true;
    }

    if (pathname === '/api/leaderboard') {
      try {
        if (req.method === 'GET') {
          const modeParam = (parsed.searchParams.get('mode') || 'arcade').toLowerCase();
          if (!VALID_MODES.has(modeParam)) {
            sendJson(res, 400, { ok: false, error: 'Invalid mode parameter.' });
            return true;
          }
          const limit = Number(parsed.searchParams.get('limit') || 20);
          const result = await store.list(modeParam, limit);
          sendJson(res, 200, { ok: true, ...result });
          return true;
        }

        if (req.method === 'POST') {
          const body = await readBody(req);
          const result = await store.submit(body);
          if (!result.ok) {
            sendJson(res, result.status || 400, { ok: false, error: result.error });
            return true;
          }
          sendJson(res, 201, result);
          return true;
        }

        sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
        return true;
      } catch (err) {
        const status = err?.status || 500;
        sendJson(res, status, {
          ok: false,
          error: status >= 500 ? 'Internal leaderboard error.' : err.message,
        });
        return true;
      }
    }

    sendJson(res, 404, { ok: false, error: 'Unknown API endpoint.' });
    return true;
  };
}
