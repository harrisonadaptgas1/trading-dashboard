// Minimal static server for local preview. Web Crypto needs a secure context,
// and localhost counts as one, so this is enough to test the real decrypt flow.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 4173);
const run = promisify(execFile);

let scanning = false;

const json = (res, code, body) =>
  res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

/** These endpoints handle a secret, so refuse anything not from this machine. */
function isLocalRequest(req) {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => {
    data += c;
    if (data.length > 10_000) reject(new Error('Body too large'));
  });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

/**
 * Report only whether a key is stored, never the key itself.
 * A key set via the environment cannot be edited from the browser.
 */
async function handleSettings(req, res) {
  const { getT212Credentials, setT212Credentials, clearT212Credentials } = await import('../src/secrets.js');

  if (req.method === 'GET') {
    const { key, fromEnv } = await getT212Credentials();
    return json(res, 200, {
      t212: Boolean(key),
      fromEnv,
      hint: key ? `ends ...${key.slice(-4)}` : null,
    });
  }

  if (req.method === 'POST') {
    const { t212Key, t212Secret } = JSON.parse(await readBody(req) || '{}');
    if (!t212Key || t212Key.trim().length < 8) {
      return json(res, 400, { error: 'That does not look like a valid key.' });
    }
    // Check the credentials actually work before saving, so a typo fails here
    // rather than silently breaking the next scan.
    const { getPortfolio } = await import('../src/trading212.js');
    const result = await getPortfolio(t212Key.trim(), t212Secret?.trim());
    if (!result.available) return json(res, 400, { error: result.reason });

    await setT212Credentials(t212Key, t212Secret);
    return json(res, 200, {
      ok: true,
      accountType: result.accountType,
      positions: result.positions.length,
      currency: result.currency,
    });
  }

  if (req.method === 'DELETE') {
    await clearT212Credentials();
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'Method not allowed' });
}

/**
 * Run a full scan on this machine, on demand, so the dashboard's button works
 * locally without GitHub. Only ever reachable from localhost.
 */
async function handleScan(res) {
  if (!process.env.DASHBOARD_PASSWORD) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ error: 'Server was started without DASHBOARD_PASSWORD. Use start-dashboard.bat.' }));
    return;
  }
  if (scanning) {
    res.writeHead(409, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ error: 'A scan is already running.' }));
    return;
  }
  scanning = true;
  const started = Date.now();
  try {
    console.log('Scan requested from the dashboard...');
    await run(process.execPath, [join(ROOT, 'src/scan.js')], { cwd: ROOT, maxBuffer: 1024 * 1024 * 10 });
    await run(process.execPath, [join(ROOT, 'src/encrypt.js')], { cwd: ROOT });
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`Scan finished in ${secs}s`);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, seconds: Number(secs) }));
  } catch (err) {
    console.error('Scan failed:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' })
       .end(JSON.stringify({ error: (err.stderr || err.message || 'Scan failed').toString().slice(-300) }));
  } finally {
    scanning = false;
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    if (!isLocalRequest(req)) return json(res, 403, { error: 'Local requests only' });

    if (url.pathname === '/api/scan' && req.method === 'POST') return void await handleScan(res);
    if (url.pathname === '/api/settings') {
      try {
        return void await handleSettings(req, res);
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }
    return json(res, 404, { error: 'Unknown endpoint' });
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel === '/' || rel === '\\' ? 'index.html' : rel);

  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Serving public/ on http://localhost:${PORT}`));
