import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError, DevinClient, DemoClient } from './devin.mjs';
import { CliClient } from './acp.mjs';

const publicDir = new URL('./public/', import.meta.url);
const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
function respond(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); }
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, 'Expected JSON.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 512000) throw new ApiError(413, 'Request is too large.'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || Array.isArray(value) || typeof value !== 'object') throw 0; return value; }
  catch { throw new ApiError(400, 'Invalid JSON request.'); }
}
export function createServer({ apiKey = process.env.DEVIN_API_KEY, orgId = process.env.DEVIN_ORG_ID, clientFactory = options => new DevinClient(options), cliFactory = options => new CliClient(options) } = {}) {
  let client = apiKey && orgId ? clientFactory({ apiKey, orgId }) : null;
  let mode = client ? 'live' : 'disconnected';
  const demo = new DemoClient(), token = randomBytes(32).toString('hex');
  let changing = false, mutations = 0;
  const config = () => ({ mode, orgId: mode === 'live' ? client.orgId : null, cli: mode === 'cli' ? client.info() : null, token });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new ApiError(403, 'Local access only.');
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== `http://${host}`)) throw new ApiError(403, 'Cross-origin access denied.');
      const url = new URL(req.url, `http://${host}`), path = url.pathname;
      if (path.startsWith('/api/')) {
        if (req.method !== 'GET') {
          const supplied = Buffer.from(String(req.headers['x-harness-token'] || ''));
          if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) throw new ApiError(403, 'Refresh the app to restore your connection.');
        }
        if (path === '/api/config' && req.method === 'GET') return respond(res, 200, config());
        if (path === '/api/connection' && req.method === 'POST') {
          if (changing || mutations || (mode === 'cli' && client.hasWork())) throw new ApiError(409, 'Wait for the current request before switching connections.');
          changing = true;
          try {
            const input = await body(req);
            const previous = client;
            if (input.mode === 'demo') { client = demo; mode = 'demo'; }
            else if (input.mode === 'disconnected') { client = null; mode = 'disconnected'; }
            else if (input.mode === 'cli') {
              const candidate = cliFactory({ cwd: input.cwd });
              try { await candidate.initialize(); } catch (error) { candidate.close(); throw error; }
              client = candidate; mode = 'cli';
            }
            else if (input.mode === 'live') {
              const candidate = clientFactory({ apiKey: String(input.apiKey || '').trim(), orgId: String(input.orgId || '').trim() });
              await candidate.list(); client = candidate; mode = 'live';
            } else throw new ApiError(400, 'Unknown connection mode.');
            if (previous && previous !== client && previous.close) previous.close();
            return respond(res, 200, config());
          } finally { changing = false; }
        }
        if (!client) throw new ApiError(428, 'Connect Devin or try the offline demo first.');
        if (changing) throw new ApiError(409, 'Connection is changing. Try again shortly.');
        if (path === '/api/cli/auth' && req.method === 'POST') {
          if (mode !== 'cli') throw new ApiError(409, 'Connect Devin CLI first.');
          return respond(res, 202, client.login((await body(req)).methodId));
        }
        const permissionRoute = path.match(/^\/api\/sessions\/([\w-]+)\/permissions\/([\w-]+)$/);
        if (permissionRoute && req.method === 'POST') {
          if (mode !== 'cli') throw new ApiError(409, 'Permission requests require a CLI session.');
          return respond(res, 200, client.decide(permissionRoute[1], permissionRoute[2], (await body(req)).optionId));
        }
        const activeClient = client;
        const mutation = req.method !== 'GET';
        if (mutation) mutations++;
        try {
          if (path === '/api/sessions' && req.method === 'GET') return respond(res, 200, await activeClient.list(url.searchParams.get('after')));
          if (path === '/api/sessions' && req.method === 'POST') return respond(res, 201, await activeClient.create(await body(req)));
          const match = path.match(/^\/api\/sessions\/([\w-]+)(\/messages)?$/);
          if (match) {
            const [, id, messages] = match;
            if (req.method === 'GET') return respond(res, 200, await (messages ? activeClient.messages(id, url.searchParams.get('after')) : activeClient.get(id)));
            if (messages && req.method === 'POST') return respond(res, 200, await activeClient.send(id, (await body(req)).message));
            if (!messages && req.method === 'DELETE') return respond(res, 200, await activeClient.stop(id));
          }
          throw new ApiError(404, 'Endpoint not found.');
        } finally { if (mutation) mutations--; }
      }
      const file = files.get(path);
      if (!file || req.method !== 'GET') throw new ApiError(404, 'Not found.');
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
      res.end(await readFile(new URL(file[0], publicDir)));
    } catch (error) {
      if (error.retryAfter) res.setHeader('Retry-After', error.retryAfter);
      respond(res, error.status >= 400 && error.status <= 599 ? error.status : 500, { error: error instanceof ApiError ? error.message : 'An unexpected server error occurred.' });
    }
  });
  server.on('close', () => client?.close?.());
  server.requestTimeout = 45000;
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  const server = createServer();
  server.listen(port, '127.0.0.1', () => console.log(`Relay is running at http://127.0.0.1:${port}`));
  server.on('error', err => { console.error(`Could not start Relay: ${err.message}`); process.exitCode = 1; });
}
