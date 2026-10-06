import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from './devin.mjs';

const now = () => Date.now() / 1000;
export class AcpTransport {
  constructor({ command = process.env.DEVIN_CLI_PATH || 'devin', cwd, spawnImpl = spawn, onNotification = () => {}, onRequest = () => {}, onClose = () => {} } = {}) {
    this.pending = new Map(); this.sequence = 0; this.buffer = ''; this.closed = false;
    const env = { ...process.env };
    // Optional isolated CLI profile; otherwise reuse the official CLI's normal sign-in.
    if (process.env.RELAY_DEVIN_DATA_HOME) env.XDG_DATA_HOME = process.env.RELAY_DEVIN_DATA_HOME;
    if (process.env.RELAY_DEVIN_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.RELAY_DEVIN_CONFIG_HOME;
    this.child = spawnImpl(command, ['--permission-mode', 'normal', 'acp'], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const fail = message => {
      if (this.closed) return;
      this.closed = true;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new ApiError(502, message)); }
      this.pending.clear(); onClose(message);
    };
    this.child.on('error', error => fail(error.code === 'ENOENT' ? 'Devin CLI is not installed. Install it from devin.ai/cli, or set DEVIN_CLI_PATH, then restart Relay.' : 'Devin CLI could not start. Check its installation and permissions.'));
    this.child.on('exit', () => fail('Devin CLI exited. Reconnect in settings.'));
    this.child.stdin.on('error', () => fail('Lost the connection to Devin CLI. Reconnect in settings.'));
    // Never expose raw stderr: authentication diagnostics can contain tokens or login URLs.
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) { fail('Devin CLI exceeded the response size limit.'); this.child.kill(); return; }
      let boundary;
      while ((boundary = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, boundary); this.buffer = this.buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail('Devin CLI sent an invalid protocol message.'); this.child.kill(); return; }
        if (message.method) {
          if (message.id !== undefined) onRequest(message, result => this.write({ jsonrpc: '2.0', id: message.id, result }));
          else onNotification(message);
        } else if (message.id !== undefined) {
          const item = this.pending.get(message.id); if (!item) continue;
          clearTimeout(item.timer); this.pending.delete(message.id);
          if (message.error) {
            // Authentication errors use the ACP-defined -32000 code. Keep raw protocol data private.
            const text = message.error.code === -32000 ? 'Devin requires sign-in. Open settings and choose Sign in with Devin.' : `Devin CLI rejected ${item.method} (code ${message.error.code}). Check your CLI account access and workspace trust.`;
            item.reject(new ApiError(message.error.code === -32000 ? 401 : 502, text));
          } else item.resolve(message.result || {});
        }
      }
    });
  }
  write(message) { if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params, timeout = 30000) {
    if (this.closed) return Promise.reject(new ApiError(502, 'Devin CLI is disconnected. Reconnect in settings.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new ApiError(504, `Devin CLI timed out during ${method}. Reconnect before retrying.`)); this.close(); }, timeout) : null;
      timer?.unref(); this.pending.set(id, { resolve, reject, timer, method });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }
  rejectRequest(id) { this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'This client capability is not supported.' } }); }
  close() { this.child.kill(); }
}

export class CliClient {
  constructor({ cwd, transportFactory = options => new AcpTransport(options) } = {}) {
    this.cwd = cwd; this.transportFactory = transportFactory; this.sessions = new Map(); this.remote = new Map(); this.history = new Map(); this.permissions = new Map(); this.auth = { state: 'unknown' }; this.closed = false;
  }
  async initialize() {
    if (!isAbsolute(this.cwd || '')) throw new ApiError(400, 'Enter an absolute local project folder path.');
    try { this.cwd = await realpath(this.cwd); if (!(await stat(this.cwd)).isDirectory()) throw 0; }
    catch { throw new ApiError(400, 'The local project folder does not exist or is not accessible.'); }
    this.transport = this.transportFactory({ cwd: this.cwd, onNotification: message => this.update(message), onRequest: (message, reply) => this.permission(message, reply), onClose: message => this.failed(message) });
    const result = await this.transport.request('initialize', { protocolVersion: 1, clientInfo: { name: 'relay', title: 'Relay', version: '1.1.0' }, clientCapabilities: {} });
    if (result.protocolVersion !== 1) { this.close(); throw new ApiError(502, 'Unsupported Devin ACP protocol version.'); }
    this.authMethods = (result.authMethods || []).filter(method => !method.type || method.type === 'agent');
    return this;
  }
  info() { return { cwd: this.cwd, auth: this.auth, authMethods: this.authMethods || [], closed: this.closed }; }
  hasWork() { return this.auth.state === 'pending' || [...this.sessions.values()].some(s => s.inFlight); }
  login(methodId) {
    if (this.closed) throw new ApiError(409, 'Reconnect the CLI before signing in.');
    if (this.hasWork()) throw new ApiError(409, 'Finish or stop the current task or sign-in first.');
    if (!this.authMethods.some(method => method.id === methodId)) throw new ApiError(400, 'Select an authentication method advertised by Devin.');
    this.auth = { state: 'pending' };
    this.transport.request('authenticate', { methodId }, 300000).then(() => { this.auth = { state: 'authenticated' }; }).catch(error => { this.auth = { state: 'error', error: error.message }; });
    return this.info();
  }
  list() { return { items: [...this.sessions.values()].map(s => this.publicSession(s)).sort((a,b) => b.updated_at - a.updated_at), has_next_page: false }; }
  publicSession(session) { const { remoteId, inFlight, currentMessage, cancelTimer, ...visible } = session; return visible; }
  session(id) { const result = this.sessions.get(id); if (!result) throw new ApiError(404, 'Local session not found.'); return result; }
  get(id) { return this.publicSession(this.session(id)); }
  messages(id) { this.session(id); return { items: this.history.get(id), has_next_page: false }; }
  add(session, source, message, eventId = randomUUID()) { const item = { event_id: eventId, source, message, created_at: now() }; this.history.get(session.session_id).push(item); return item; }
  async create(input) {
    this.validatePrompt(input.prompt);
    if (this.auth.state === 'pending') throw new ApiError(409, 'Complete browser sign-in first.');
    if (this.closed) throw new ApiError(409, 'Reconnect the CLI before starting a task.');
    const result = await this.transport.request('session/new', { cwd: this.cwd, mcpServers: [] });
    if (typeof result.sessionId !== 'string' || !result.sessionId) throw new ApiError(502, 'Devin CLI did not return a session ID.');
    const id = `local-${randomUUID()}`;
    const session = { session_id: id, remoteId: result.sessionId, title: input.prompt.trim().split('\n')[0].slice(0,100), status: 'running', status_detail: 'waiting_for_user', created_at: now(), updated_at: now(), pull_requests: [], cwd: this.cwd, provider: 'cli', permissions: [], tools: [], plan: [] };
    this.sessions.set(id, session); this.remote.set(result.sessionId, id); this.history.set(id, []); this.auth = { state: 'authenticated' };
    this.send(id, input.prompt); return this.publicSession(session);
  }
  validatePrompt(message) { if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new ApiError(400, 'Enter a message between 1 and 100,000 characters.'); }
  send(id, message) {
    this.validatePrompt(message); const session = this.session(id);
    if (this.closed || session.status === 'exit' || session.status === 'error') throw new ApiError(409, 'This local session has ended. Start a new task.');
    if (session.inFlight) throw new ApiError(409, 'Wait for this turn to finish, or stop it before sending another message.');
    session.inFlight = true; session.currentMessage = null; session.status_detail = 'working'; session.updated_at = now();
    this.add(session, 'user', message.trim());
    this.transport.request('session/prompt', { sessionId: session.remoteId, prompt: [{ type: 'text', text: message.trim() }] }, 0).then(result => {
      if (session.status !== 'exit') { session.status_detail = 'waiting_for_user'; session.stop_reason = result.stopReason; }
    }).catch(error => {
      if (session.status !== 'exit') { session.status = 'error'; session.status_detail = 'error'; this.add(session, 'system', error.message); }
    }).finally(() => { clearTimeout(session.cancelTimer); session.inFlight = false; session.currentMessage = null; this.cancelPermissions(session); session.updated_at = now(); });
    return {};
  }
  update(message) {
    if (message.method !== 'session/update') return;
    const { sessionId, update } = message.params || {}, localId = this.remote.get(sessionId);
    if (!localId || !update) return;
    const session = this.sessions.get(localId); if (session.status === 'exit') return;
    session.updated_at = now();
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const key = update.messageId || session.currentMessage || randomUUID();
      let entry = this.history.get(localId).find(item => item.event_id === key);
      if (!entry) entry = this.add(session, 'devin', '', key);
      entry.message += update.content.text; session.currentMessage = key;
    } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      session.currentMessage = null;
      let tool = session.tools.find(item => item.toolCallId === update.toolCallId);
      if (!tool) { tool = { toolCallId: update.toolCallId }; session.tools.push(tool); }
      Object.assign(tool, update);
    } else if (update.sessionUpdate === 'plan') session.plan = update.entries || [];
    else if (update.sessionUpdate === 'usage_update') session.usage = { used: update.used, size: update.size, cost: update.cost };
  }
  permission(message, reply) {
    if (message.method !== 'session/request_permission') return this.transport.rejectRequest(message.id);
    const localId = this.remote.get(message.params?.sessionId), session = this.sessions.get(localId);
    if (!session || session.status === 'exit') return reply({ outcome: { outcome: 'cancelled' } });
    const id = randomUUID();
    const request = { id, toolCall: message.params.toolCall, options: message.params.options || [] };
    this.permissions.set(id, { session, reply, request }); session.permissions.push(request); session.status_detail = 'waiting_for_approval';
  }
  decide(id, permissionId, optionId) {
    const pending = this.permissions.get(permissionId);
    if (!pending || pending.session.session_id !== id) throw new ApiError(404, 'This permission request is no longer active.');
    if (!pending.request.options.some(option => option.optionId === optionId)) throw new ApiError(400, 'Choose a permission option offered by Devin.');
    pending.reply({ outcome: { outcome: 'selected', optionId } }); this.permissions.delete(permissionId);
    pending.session.permissions = pending.session.permissions.filter(item => item.id !== permissionId);
    pending.session.status_detail = pending.session.permissions.length ? 'waiting_for_approval' : 'working';
    return {};
  }
  cancelPermissions(session) {
    for (const [id, pending] of this.permissions) if (pending.session === session) { pending.reply({ outcome: { outcome: 'cancelled' } }); this.permissions.delete(id); }
    session.permissions = [];
  }
  stop(id) {
    const session = this.session(id); session.status = 'exit'; session.status_detail = 'user_request';
    this.cancelPermissions(session);
    this.transport.notify('session/cancel', { sessionId: session.remoteId });
    if (session.inFlight) {
      // A non-cooperating agent must not continue running indefinitely after Stop.
      session.cancelTimer = setTimeout(() => { if (session.inFlight) this.close(); }, 5000); session.cancelTimer.unref();
    }
    return this.publicSession(session);
  }
  failed(message) {
    this.closed = true;
    for (const session of this.sessions.values()) {
      clearTimeout(session.cancelTimer); session.inFlight = false; this.cancelPermissions(session);
      if (session.status !== 'exit') { session.status = 'error'; session.status_detail = 'error'; this.add(session, 'system', message); }
    }
  }
  close() { for (const session of this.sessions.values()) this.cancelPermissions(session); this.transport?.close(); }
}
