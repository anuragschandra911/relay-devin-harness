import test from 'node:test';
import assert from 'node:assert/strict';
import { DevinClient, DemoClient, createPayload, sessionId } from '../devin.mjs';

test('v3 adapter uses the documented routes, bearer credential and payloads', async () => {
  const calls = [];
  const client = new DevinClient({ apiKey: 'secret-token', orgId: 'org-test', fetchImpl: async (url, options) => { calls.push({ url, ...options }); return new Response(JSON.stringify({ items: [], session_id: 'abc' })); } });
  await client.create({ prompt: 'Fix the bug', repo: 'acme/project', max_acu_limit: 12 });
  await client.get('abc'); await client.messages('devin-abc', 'opaque+cursor'); await client.send('abc', 'Run tests'); await client.stop('abc'); await client.list('next');
  assert.equal(calls[0].url, 'https://api.devin.ai/v3/organizations/org-test/sessions');
  assert.deepEqual(JSON.parse(calls[0].body), { prompt: 'Fix the bug', title: 'Fix the bug', repos: ['acme/project'], max_acu_limit: 12 });
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[1].url.endsWith('/devin-abc'), true);
  assert.equal(calls[2].url.endsWith('/devin-abc/messages?first=200&after=opaque%2Bcursor'), true);
  assert.deepEqual(JSON.parse(calls[3].body), { message: 'Run tests' });
  assert.equal(calls[4].method, 'DELETE');
  assert.equal(calls[5].url.endsWith('?first=100&after=next'), true);
  assert.equal(calls[0].redirect, 'error');
});
test('rejects unsafe identifiers, empty tasks and invalid budgets before API calls', () => {
  for (const id of ['../secrets', 'a?x=1', '', 'a/b']) assert.throws(() => sessionId(id));
  for (const input of [{ prompt: '' }, { prompt: 'x', max_acu_limit: -1 }, { prompt: 'x', max_acu_limit: 1.5 }, { prompt: 'x', repo: '../../etc/passwd' }]) assert.throws(() => createPayload(input));
  assert.equal(sessionId('devin-abc'), 'devin-abc');
  assert.equal(createPayload({ prompt: 'task' }).max_acu_limit, 10);
});
test('propagates rate limits, redacts credentials and never retries mutations', async () => {
  let calls = 0;
  const client = new DevinClient({ apiKey: 'private-token', orgId: 'org-test', fetchImpl: async () => { calls++; return new Response(JSON.stringify({ detail: 'Limit for private-token' }), { status: 429, headers: { 'Retry-After': '20' } }); } });
  await assert.rejects(client.send('abc', 'message'), error => error.status === 429 && error.retryAfter === '20' && !error.message.includes('private-token'));
  assert.equal(calls, 1);
});
test('ambiguous mutation failure warns against blind retry', async () => {
  const client = new DevinClient({ apiKey: 'secret', orgId: 'org-test', fetchImpl: async () => { throw new Error('timeout'); } });
  await assert.rejects(client.create({ prompt: 'Build' }), /may have been accepted/);
});
test('offline demo isolates sessions and stops pending responses', async () => {
  const client = new DemoClient();
  const first = client.create({ prompt: 'First' }), second = client.create({ prompt: 'Second' });
  client.send(first.session_id, 'Follow up');
  assert.equal(client.messages(first.session_id).items.length, 3);
  assert.equal(client.messages(second.session_id).items.length, 2);
  client.stop(first.session_id); client.stop(second.session_id);
  assert.equal(client.get(first.session_id).status, 'exit');
  assert.equal(client.timers.size, 0);
  assert.throws(() => client.send(first.session_id, 'Again'), /stopped/);
});
