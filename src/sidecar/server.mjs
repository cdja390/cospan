#!/usr/bin/env node
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancelBoardJob, listWorkspaceBoard, readBoardJobDetail } from '../sidebar-state.mjs';

const SIDECAR_DIR = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(SIDECAR_DIR, '..', 'ui');
const BIND_HOST = '127.0.0.1';
const MAX_JSON_BODY_BYTES = 64 * 1024;

const STATIC_FILES = {
  '/board.css': {
    file: path.join(UI_DIR, 'cospan-board.css'),
    type: 'text/css; charset=utf-8',
  },
  '/board.js': {
    file: path.join(UI_DIR, 'cospan-board.js'),
    type: 'application/javascript; charset=utf-8',
  },
  '/sidecar-bridge.js': {
    file: path.join(SIDECAR_DIR, 'sidecar-bridge.js'),
    type: 'application/javascript; charset=utf-8',
  },
};

const INDEX_HTML =
  '<!DOCTYPE html>\n' +
  '<html lang="en">\n' +
  '<head>\n' +
  '  <meta charset="utf-8" />\n' +
  '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
  '  <title>Cospan</title>\n' +
  '  <link rel="stylesheet" href="/board.css" />\n' +
  '</head>\n' +
  '<body>\n' +
  '  <div id="cospan-root" style="height:100vh;width:100vw;overflow:hidden"></div>\n' +
  '  <script src="/board.js"></script>\n' +
  '  <script src="/sidecar-bridge.js"></script>\n' +
  '</body>\n' +
  '</html>\n';

function sendResponse(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  sendResponse(res, status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

function isAuthorizedRequest(req, url, expectedToken) {
  if (req.method === 'GET' || !expectedToken) return true;
  const headerTok = req.headers['x-sidecar-token'];
  const provided = Array.isArray(headerTok)
    ? headerTok[0]
    : headerTok || url.searchParams.get('token');
  return provided === expectedToken;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_JSON_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveGetRoute(res, url, workspaceFallback) {
  if (url.pathname === '/') {
    sendResponse(res, 200, 'text/html; charset=utf-8', INDEX_HTML);
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(STATIC_FILES, url.pathname)) {
    const asset = STATIC_FILES[url.pathname];
    const content = fs.readFileSync(asset.file, 'utf8');
    sendResponse(res, 200, asset.type, content);
    return true;
  }
  if (url.pathname === '/api/board') {
    const workspace = url.searchParams.get('workspace') || workspaceFallback || process.cwd();
    const conv =
      url.searchParams.get('conversationId') || process.env.ANTIGRAVITY_CONVERSATION_ID || null;
    const board = listWorkspaceBoard(workspace, { callerSessionId: conv });
    sendJson(res, 200, { ok: true, ...board });
    return true;
  }
  if (url.pathname === '/api/job') {
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id) {
      sendJson(res, 400, { ok: false, error: 'Missing job id' });
      return true;
    }
    const workspace = url.searchParams.get('workspace') || workspaceFallback || process.cwd();
    const detail = readBoardJobDetail(workspace, id);
    sendJson(res, detail.ok ? 200 : 404, detail);
    return true;
  }
  return false;
}

async function handleCancelRoute(req, res, url, workspaceFallback) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }
  const id = String(body?.id || body?.jobId || url.searchParams.get('id') || '').trim();
  if (!id) {
    sendJson(res, 400, { ok: false, error: 'Missing job id' });
    return;
  }
  const workspace =
    body?.workspace || url.searchParams.get('workspace') || workspaceFallback || process.cwd();
  const result = await cancelBoardJob(workspace, id);
  sendJson(res, 200, result);
}

export function startSidecarServer({ port, token, workspaceFallback, quiet = false } = {}) {
  const listenPort =
    port !== undefined ? Number(port) : Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0);
  const expectedToken =
    token !== undefined
      ? String(token || '')
      : String(process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '');

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${BIND_HOST}`);
      if (!isAuthorizedRequest(req, url, expectedToken)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      if (req.method === 'GET' && serveGetRoute(res, url, workspaceFallback)) {
        return;
      }
      if (url.pathname === '/api/cancel') {
        await handleCancelRoute(req, res, url, workspaceFallback);
        return;
      }
      sendJson(res, 404, { ok: false, error: 'Not Found' });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || 'Internal server error' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, BIND_HOST, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;
      if (!quiet) {
        process.stdout.write(`[sidecar] listening on ${BIND_HOST}:${actualPort}\n`);
      }
      resolve({
        server,
        host: BIND_HOST,
        port: actualPort,
        url: `http://${BIND_HOST}:${actualPort}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

function parseCliPortArg(argv) {
  const idx = argv.indexOf('--port');
  if (idx >= 0 && argv[idx + 1] !== undefined) return Number(argv[idx + 1]);
  return undefined;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cliPort = parseCliPortArg(process.argv.slice(2));
  const started = await startSidecarServer({ port: cliPort });
  const shutdown = () => {
    void started.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
