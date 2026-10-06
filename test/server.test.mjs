import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { once } from 'node:events';
import http from 'node:http';

async function fixture(t, options) {
  const server = createServer({ apiKey: '', orgId: '', ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await fetch(`${base}/api/config`).then(r => r.json());
  const request = (path, method = 'GET', data, headers = {}) => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Harness-Token': config.token, ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { base, request };
}
test('HTTP demo lifecycle: connect, create, follow up, stop, disconnect', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/sessions')).status, 428);
  assert.equal((await request('/api/connection', 'POST', { mode: 'demo' })).status, 200);
  const created = await request('/api/sessions', 'POST', { prompt: 'Build a task' }); assert.equal(created.status, 201);
  const session = await created.json();
  assert.equal((await request('/api/sessions').then(r => r.json())).items.length, 1);
  assert.equal((await request(`/api/sessions/${session.session_id}/messages`, 'POST', { message: 'Verify' })).status, 200);
  assert.equal((await request(`/api/sessions/${session.session_id}/messages`).then(r => r.json())).items.length, 3);
  assert.equal((await request(`/api/sessions/${session.session_id}`, 'DELETE').then(r => r.json())).status, 'exit');
  await request('/api/connection', 'POST', { mode: 'disconnected' });
  assert.equal((await request('/api/sessions')).status, 428);
});
test('local server rejects cross-origin traffic, missing CSRF tokens, invalid bodies and file traversal', async t => {
  const { base, request } = await fixture(t);
  assert.equal((await request('/api/config', 'GET', null, { Origin: 'https://evil.example' })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => { const req = http.get(`${base}/api/config`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await request('/api/config', 'GET', null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/connection', 'POST', { mode: 'demo' }, { 'X-Harness-Token': '' })).status, 403);
  assert.equal((await request('/api/connection', 'POST', { mode: 'demo' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('/.env')).status, 404);
  assert.equal((await request('/%2e%2e/server.mjs')).status, 404);
  const html = await fetch(base); assert.equal(html.status, 200); assert.match(html.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
});
test('connection verification is transactional and credentials are never returned', async t => {
  const { request } = await fixture(t, { clientFactory: ({ apiKey, orgId }) => ({ orgId, list: async () => { if (apiKey === 'bad') throw new Error('rejected'); return { items: [] }; } }) });
  await request('/api/connection', 'POST', { mode: 'demo' });
  assert.equal((await request('/api/connection', 'POST', { mode: 'live', apiKey: 'bad', orgId: 'org-test' })).status, 500);
  assert.equal((await request('/api/config').then(r => r.json())).mode, 'demo');
  const response = await request('/api/connection', 'POST', { mode: 'live', apiKey: 'very-private', orgId: 'org-test' }).then(r => r.json());
  assert.equal(response.mode, 'live'); assert.equal(JSON.stringify(response).includes('very-private'), false);
});

test('CLI connection exposes browser auth and scoped permission actions without API credentials', async t => {
  const calls = [];
  const cli = { initialize: async () => {}, info: () => ({ cwd: '/project', auth: { state: 'unknown' }, authMethods: [{ id: 'browser', name: 'Log in with browser' }] }), close: () => {}, hasWork: () => false, login: id => { calls.push(['login', id]); return { auth: { state: 'pending' } }; }, decide: (...args) => { calls.push(args); return {}; }, list: () => ({ items: [] }) };
  const { request } = await fixture(t, { cliFactory: () => cli });
  const config = await request('/api/connection', 'POST', { mode: 'cli', cwd: '/project' }).then(r => r.json());
  assert.equal(config.mode, 'cli'); assert.equal(config.cli.authMethods[0].id, 'browser');
  assert.equal((await request('/api/cli/auth', 'POST', { methodId: 'browser' })).status, 202);
  assert.equal((await request('/api/sessions/local-1/permissions/permission-1', 'POST', { optionId: 'reject' })).status, 200);
  assert.deepEqual(calls, [['login', 'browser'], ['local-1', 'permission-1', 'reject']]);
});
test('cannot switch away from a CLI with active work or pending sign-in', async t => {
  let active = false;
  const cli = { initialize: async () => {}, info: () => ({}), close: () => {}, hasWork: () => active };
  const { request } = await fixture(t, { cliFactory: () => cli });
  await request('/api/connection', 'POST', { mode: 'cli', cwd: '/project' }); active = true;
  assert.equal((await request('/api/connection', 'POST', { mode: 'disconnected' })).status, 409);
});
