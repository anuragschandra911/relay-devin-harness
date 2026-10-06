import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AcpTransport, CliClient } from '../acp.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));

function agent() {
  const state = { calls: [], notices: [], replies: [], prompts: [], closed: false };
  state.factory = handlers => {
    state.handlers = handlers;
    return {
      request: async (method, params) => {
        state.calls.push({ method, params });
        if (method === 'initialize') return { protocolVersion: 1, authMethods: [{ id: 'devin-browser', name: 'Log in with browser' }] };
        if (method === 'authenticate') return {};
        if (method === 'session/new') return { sessionId: `remote-${state.calls.length}` };
        if (method === 'session/prompt') return new Promise(resolve => state.prompts.push(resolve));
      },
      notify: (method, params) => { state.notices.push({ method, params }); if (method === 'session/cancel') state.prompts.shift()?.({ stopReason: 'cancelled' }); },
      rejectRequest: id => state.rejected = id,
      close: () => { state.closed = true; handlers.onClose('closed'); }
    };
  };
  return state;
}
async function client(t) {
  const fake = agent(), cli = new CliClient({ cwd: process.cwd(), transportFactory: fake.factory });
  await cli.initialize(); t.after(() => cli.close()); return { fake, cli };
}
test('CLI auth uses the advertised browser method, no cloud API token', async t => {
  const { fake, cli } = await client(t);
  assert.equal(cli.info().auth.state, 'unknown');
  assert.throws(() => cli.login('invented'), /advertised/);
  cli.login('devin-browser'); assert.equal(cli.info().auth.state, 'pending'); await tick();
  assert.equal(cli.info().auth.state, 'authenticated');
  assert.deepEqual(fake.calls[1], { method: 'authenticate', params: { methodId: 'devin-browser' } });
  assert.deepEqual(fake.calls[0].params.clientCapabilities, {});
});
test('CLI streams separate turns, blocks overlapping prompts, surfaces tools', async t => {
  const { cli, fake } = await client(t);
  const session = await cli.create({ prompt: 'Inspect project' });
  const remoteId = fake.calls.find(call => call.method === 'session/prompt').params.sessionId;
  const update = value => fake.handlers.onNotification({ method: 'session/update', params: { sessionId: remoteId, update: value } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
  assert.equal(cli.messages(session.session_id).items[1].message, 'Hello world');
  assert.throws(() => cli.send(session.session_id, 'overlap'), /finish/);
  update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read file', status: 'in_progress' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' });
  assert.equal(cli.get(session.session_id).tools[0].title, 'Read file');
  assert.equal(cli.get(session.session_id).tools[0].status, 'completed');
  fake.prompts.shift()({ stopReason: 'end_turn' }); await tick();
  cli.send(session.session_id, 'Next turn');
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A new reply' } });
  assert.equal(cli.messages(session.session_id).items.length, 4);
  cli.stop(session.session_id); await tick();
});
test('tool permission decisions are scoped, validated and never auto-approved', async t => {
  const { cli, fake } = await client(t);
  const session = await cli.create({ prompt: 'Edit' });
  const remoteId = fake.calls.find(call => call.method === 'session/prompt').params.sessionId;
  let result;
  fake.handlers.onRequest({ id: 50, method: 'session/request_permission', params: { sessionId: remoteId, toolCall: { title: 'Write file', rawInput: { path: 'test.txt' } }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }, { optionId: 'deny', kind: 'reject_once', name: 'Reject' }] } }, value => result = value);
  assert.equal(result, undefined);
  const permission = cli.get(session.session_id).permissions[0];
  assert.equal(cli.get(session.session_id).status_detail, 'waiting_for_approval');
  assert.throws(() => cli.decide('another-session', permission.id, 'allow'), /no longer/);
  assert.throws(() => cli.decide(session.session_id, permission.id, 'invalid'), /offered/);
  cli.decide(session.session_id, permission.id, 'deny');
  assert.deepEqual(result, { outcome: { outcome: 'selected', optionId: 'deny' } });
  assert.equal(cli.get(session.session_id).permissions.length, 0);
  cli.stop(session.session_id); await tick();
});
test('stop cancels pending permissions and notifies the agent', async t => {
  const { cli, fake } = await client(t), session = await cli.create({ prompt: 'task' });
  const remoteId = fake.calls.find(call => call.method === 'session/prompt').params.sessionId;
  let result;
  fake.handlers.onRequest({ id: 7, method: 'session/request_permission', params: { sessionId: remoteId, options: [] } }, value => result = value);
  cli.stop(session.session_id); await tick();
  assert.deepEqual(result, { outcome: { outcome: 'cancelled' } });
  assert.equal(cli.get(session.session_id).status, 'exit');
  assert.equal(fake.notices[0].method, 'session/cancel');
  assert.throws(() => cli.send(session.session_id, 'new'), /ended/);
});
test('rejects missing folders before launching a process', async () => {
  let spawned = false;
  const cli = new CliClient({ cwd: 'relative', transportFactory: () => { spawned = true; } });
  await assert.rejects(cli.initialize(), /absolute/); assert.equal(spawned, false);
});
test('stdio transport handles split JSON, concurrent replies and process failure', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('exit', 0);
  const launched = [], transport = new AcpTransport({ cwd: process.cwd(), spawnImpl: (...args) => { launched.push(args); return child; } });
  assert.deepEqual(launched[0][1], ['--permission-mode', 'normal', 'acp']); assert.equal(launched[0][2].shell, false);
  const first = transport.request('first', {}), second = transport.request('second', {});
  child.stdout.write('{"jsonrpc":"2.0","id":2,"result":'); child.stdout.write('{"ok":true}}\n{"id":1,"result":{"ok":false}}\n');
  assert.deepEqual(await second, { ok: true }); assert.deepEqual(await first, { ok: false });
  const pending = transport.request('pending', {}); child.kill(); await assert.rejects(pending, /exited/);
});
