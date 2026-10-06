export class ApiError extends Error {
  constructor(status, message, retryAfter) {
    super(message); this.status = status; this.retryAfter = retryAfter;
  }
}
export function sessionId(value) {
  if (typeof value !== 'string' || !/^(?:devin-)?[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new ApiError(400, 'Invalid session ID.');
  return value.startsWith('devin-') ? value : `devin-${value}`;
}
export function createPayload(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt || prompt.length > 100000) throw new ApiError(400, 'Enter a task between 1 and 100,000 characters.');
  const max = Number(input.max_acu_limit ?? 10);
  if (!Number.isInteger(max) || max < 1 || max > 1000) throw new ApiError(400, 'ACU limit must be an integer between 1 and 1,000.');
  const repos = input.repo ? [String(input.repo).trim()] : [];
  if (repos.some(repo => !/^[\w.-]+\/[\w.-]+$/.test(repo))) throw new ApiError(400, 'Use a repository name like owner/repository.');
  return { prompt, title: prompt.split('\n')[0].slice(0, 100), max_acu_limit: max, ...(repos.length ? { repos } : {}) };
}
export class DevinClient {
  constructor({ apiKey, orgId, fetchImpl = fetch }) {
    if (!apiKey || !/^org-[\w-]+$/.test(orgId || '')) throw new ApiError(400, 'Enter a Devin API token and an organization ID beginning with org-.');
    this.apiKey = apiKey; this.orgId = orgId; this.fetch = fetchImpl;
  }
  async request(path, method = 'GET', body) {
    let response;
    try {
      response = await this.fetch(`https://api.devin.ai/v3/organizations/${encodeURIComponent(this.orgId)}/sessions${path}`, {
        method, headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000), redirect: 'error'
      });
    } catch {
      throw new ApiError(502, method === 'GET' ? 'Could not reach Devin. Check your connection and try again.' : 'Devin did not confirm this request. Refresh sessions before retrying; it may have been accepted.');
    }
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new ApiError(502, 'Devin returned an unreadable response.'); }
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : `Devin returned HTTP ${response.status}.`;
      throw new ApiError(response.status, detail.replaceAll(this.apiKey, '[redacted]').slice(0, 800), response.headers.get('retry-after'));
    }
    return data;
  }
  list(after) { return this.request(`?first=100${after ? `&after=${encodeURIComponent(after)}` : ''}`); }
  create(input) { return this.request('', 'POST', createPayload(input)); }
  get(id) { return this.request(`/${sessionId(id)}`); }
  messages(id, after) { return this.request(`/${sessionId(id)}/messages?first=200${after ? `&after=${encodeURIComponent(after)}` : ''}`); }
  send(id, message) {
    if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new ApiError(400, 'Enter a message between 1 and 100,000 characters.');
    return this.request(`/${sessionId(id)}/messages`, 'POST', { message: message.trim() });
  }
  stop(id) { return this.request(`/${sessionId(id)}`, 'DELETE'); }
}

// Explicit offline demo. Never calls Devin or represents output as real coding work.
export class DemoClient {
  constructor() { this.sessions = new Map(); this.history = new Map(); this.timers = new Map(); }
  list() { return { items: [...this.sessions.values()].sort((a, b) => b.updated_at - a.updated_at), has_next_page: false }; }
  create(input) {
    const payload = createPayload(input), id = `devin-demo-${crypto.randomUUID()}`;
    const session = { session_id: id, title: payload.title, status: 'running', status_detail: 'working', created_at: Date.now() / 1000, updated_at: Date.now() / 1000, acus_consumed: 0, pull_requests: [], tags: ['demo'] };
    this.sessions.set(id, session); this.history.set(id, []);
    this.add(id, 'user', payload.prompt);
    this.add(id, 'devin', 'This is an offline demo. In connected mode, your task is sent to Devin and its actual messages appear here.\n\nYou can send a follow-up, inspect the session details, or stop this demo session.');
    this.schedule(id, 'The demo session is ready for your next instruction. No repository was accessed and no code was changed.');
    return session;
  }
  get(id) { const session = this.sessions.get(id); if (!session) throw new ApiError(404, 'Session not found.'); return session; }
  messages(id) { this.get(id); return { items: this.history.get(id), has_next_page: false }; }
  add(id, source, message) { this.history.get(id).push({ event_id: crypto.randomUUID(), source, message, created_at: Date.now() / 1000 }); }
  schedule(id, message) {
    clearTimeout(this.timers.get(id));
    const timer = setTimeout(() => { this.add(id, 'devin', message); Object.assign(this.get(id), { status_detail: 'waiting_for_user', updated_at: Date.now() / 1000 }); this.timers.delete(id); }, 1600);
    timer.unref(); this.timers.set(id, timer);
  }
  send(id, message) {
    const session = this.get(id);
    if (session.status === 'exit') throw new ApiError(409, 'This session has stopped. Start a new task.');
    if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new ApiError(400, 'Enter a message between 1 and 100,000 characters.');
    this.add(id, 'user', message.trim()); session.status_detail = 'working'; session.updated_at = Date.now() / 1000;
    this.schedule(id, 'Follow-up received in demo mode. Connect your Devin account to execute tasks and receive real results.');
    return {};
  }
  stop(id) { clearTimeout(this.timers.get(id)); this.timers.delete(id); return Object.assign(this.get(id), { status: 'exit', status_detail: 'user_request' }); }
}
