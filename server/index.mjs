import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiMiddleware } from './apiMiddleware.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '../dist');
const portArgIdx = process.argv.indexOf('--port');
const cliPort = portArgIdx >= 0 ? Number(process.argv[portArgIdx + 1]) : NaN;
let currentPort = Number.isFinite(cliPort) ? cliPort : Number(process.env.PORT || 4188);
const HOST = process.env.HOST || '127.0.0.1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const apiMiddleware = createApiMiddleware();

const server = http.createServer(async (req, res) => {
  const handled = await apiMiddleware(req, res, null);
  if (handled) return;

  const urlPath = new URL(req.url || '/', 'http://localhost').pathname;
  let safeRel = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, '');
  if (safeRel === '/' || safeRel === '\\' || safeRel === '.') {
    safeRel = 'index.html';
  }

  let targetPath = path.join(DIST_DIR, safeRel);
  if (!targetPath.startsWith(DIST_DIR)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
    targetPath = path.join(DIST_DIR, 'index.html');
  }

  if (!fs.existsSync(targetPath)) {
    res.statusCode = 404;
    res.end('Build not found. Run "pnpm build" first.');
    return;
  }

  const ext = path.extname(targetPath).toLowerCase();
  res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
  fs.createReadStream(targetPath).pipe(res);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE' && currentPort < 4250) {
    currentPort += 1;
    server.listen(currentPort, HOST);
    return;
  }
  console.error(err);
  process.exit(1);
});

server.listen(currentPort, HOST, () => {
  console.log(`Sentinel Pong production server listening on http://${HOST}:${currentPort}`);
});
