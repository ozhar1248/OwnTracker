import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openStore, AppError } from './store.js';
import { createReport, validDate, frequencies } from './public/domain.js';
import { config } from './public/config.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/cloud-client.js', ['cloud-client.js', 'text/javascript; charset=utf-8']],
  ['/domain.js', ['domain.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/install.js', ['install.js', 'text/javascript; charset=utf-8']],
  ['/icons/icon-192.png', ['icons/icon-192.png', 'image/png']],
  ['/icons/icon-512.png', ['icons/icon-512.png', 'image/png']],
  ['/icons/maskable-512.png', ['icons/maskable-512.png', 'image/png']],
]);

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'יש לשלוח JSON.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new AppError(413, 'הבקשה גדולה מדי.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new AppError(400, 'תוכן הבקשה לא תקין.'); }
}

export function createApp({ dbPath = resolve(root, 'data/owntracker.sqlite'), today, clientConfig = config } = {}) {
  const store = openStore(dbPath, today ? { today } : {});
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const cloudOrigin = clientConfig.mode === 'supabase' ? ` ${new URL(clientConfig.supabaseUrl).origin}` : '';
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${cloudOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const expectedHost = `127.0.0.1:${server.address()?.port}`;
      const allowedHosts = [expectedHost, `localhost:${server.address()?.port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new AppError(403, 'גישה מותרת מהמחשב המקומי בלבד.');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new AppError(403, 'מקור הבקשה אינו מורשה.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError(403, 'מקור הבקשה אינו מורשה.');
      const url = new URL(req.url, `http://${expectedHost}`);
      if (req.method === 'GET' && url.pathname === '/config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(`export const config = ${JSON.stringify(clientConfig)};`); return;
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        const body = await readFile(resolve(root, 'public', name));
        res.writeHead(200, { 'Content-Type': type }); res.end(body); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, store.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/backup') {
        res.setHeader('Content-Disposition', 'attachment; filename="owntracker-backup.json"');
        return json(200, { format: 'owntracker-v1', exported_at: new Date().toISOString(), ...store.snapshot() });
      }
      if (req.method === 'GET' && url.pathname === '/api/report') {
        const anchor = url.searchParams.get('date');
        const period = url.searchParams.get('period');
        if (!validDate(anchor) || !Object.hasOwn(frequencies, period)) throw new AppError(400, 'יש לבחור תאריך וסוג דוח תקינים.');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(createReport(store.snapshot(), anchor, period)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/changes') return json(201, store.createChange(await readBody(req)));
      const change = url.pathname.match(/^\/api\/changes\/([1-9]\d*)$/);
      if (change && req.method === 'PUT') return json(200, store.updateChange(Number(change[1]), await readBody(req)));
      if (change && req.method === 'DELETE') return json(200, store.archiveChange(Number(change[1]), await readBody(req)));
      const entry = url.pathname.match(/^\/api\/changes\/([1-9]\d*)\/entries$/);
      if (entry && ['POST', 'PUT'].includes(req.method)) return json(req.method === 'POST' ? 201 : 200, store.saveEntry(Number(entry[1]), await readBody(req), req.method === 'PUT'));
      throw new AppError(404, 'הכתובת לא נמצאה.');
    } catch (error) {
      if (!(error instanceof AppError)) console.error(error);
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : 'אירעה שגיאה בשמירה. אפשר לנסות שוב.', ...(error.details || {}) });
      else res.end();
    }
  });
  server.on('close', () => store.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const server = createApp({ dbPath: process.env.OWNTRACKER_DB ? resolve(process.env.OWNTRACKER_DB) : undefined, clientConfig: process.env.OWNTRACKER_MODE === 'local' ? { mode: 'local' } : config });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Set PORT to another port.` : error); process.exit(1); });
  server.listen(port, '127.0.0.1', () => console.log(`OwnTracker is ready at http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
