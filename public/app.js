const $ = selector => document.querySelector(selector);
const state = { config: { mode: 'disconnected' }, sessions: [], selected: null, messages: [], cursor: null, busy: false, generation: 0, timer: null, polling: false, failures: 0, messageSignature: '', lastList: 0, drafts: new Map() };
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const idOf = session => session.session_id;
const displayStatus = session => ({ working: 'Working', waiting_for_user: 'Needs your input', waiting_for_approval: session?.provider === 'cli' ? 'Needs your approval' : 'Awaiting approval in Devin', finished: 'Finished', user_request: 'Stopped', inactivity: 'Sleeping' }[session?.status_detail] || session?.status_detail?.replaceAll('_', ' ') || session?.status || 'Ready');
const running = session => ['new', 'claimed', 'running', 'resuming'].includes(session?.status) && !['finished', 'waiting_for_user', 'waiting_for_approval'].includes(session?.status_detail);
function safeURL(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } }
function markdown(text) {
  const chunks = String(text || '').split(/```(?:[^\n`]*)\n([\s\S]*?)```/g);
  return chunks.map((chunk, i) => i % 2 ? `<pre><code>${escape(chunk)}</code></pre>` : escape(chunk).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')).join('');
}
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'X-Harness-Token': state.config.token || '', ...options.headers }, signal: AbortSignal.timeout(40000) });
  const data = await res.json();
  if (!res.ok) { const error = new Error(data.error || 'Request failed.'); error.retryAfter = Number(res.headers.get('Retry-After')) || 0; throw error; }
  return data;
}
function notice(message) { $('#notice span').textContent = message; $('#notice').hidden = false; }
function clearNotice() { $('#notice').hidden = true; }
function taskKey() { return state.selected ? idOf(state.selected) : 'new'; }
function saveDraft() { state.drafts.set(taskKey(), $('#prompt').value); }
function setBusy(value) {
  state.busy = value; $('#send').disabled = value; $('#connect-button').disabled = value;
  $('#new-task').disabled = value; $('#cli-connect').disabled = value;
}
function renderConfig() {
  const { mode, orgId } = state.config;
  $('#mode-badge').textContent = mode === 'cli' ? 'Devin CLI' : mode === 'demo' ? 'Offline demo' : mode === 'live' ? 'Devin connected' : 'Not connected';
  $('#connection-title').textContent = mode === 'cli' ? 'Devin CLI' : mode === 'live' ? 'Devin connected' : mode === 'demo' ? 'Offline demo' : 'Connect Devin';
  $('#connection-subtitle').textContent = mode === 'cli' ? (state.config.cli?.cwd || 'Local project') : mode === 'live' ? orgId : mode === 'demo' ? 'No API calls · No code execution' : 'Bring your own account';
  $('#connection-indicator').classList.toggle('live', mode === 'live' || (mode === 'cli' && state.config.cli?.auth?.state === 'authenticated'));
  $('#try-demo').hidden = mode !== 'disconnected';
  $('#disconnect').hidden = mode === 'disconnected';
  renderCliAuth();
}
function renderSessions() {
  const query = $('#search').value.toLowerCase();
  const sessions = state.sessions.filter(s => (s.title || s.session_id).toLowerCase().includes(query));
  $('#sessions').innerHTML = sessions.length ? sessions.map(s => `<button class="task ${state.selected && idOf(state.selected) === idOf(s) ? 'active' : ''}" data-id="${escape(idOf(s))}" title="${escape(s.title || idOf(s))}" ${state.selected && idOf(state.selected) === idOf(s) ? 'aria-current="true"' : ''}><span class="task-dot ${running(s) ? 'working' : s.status_detail?.startsWith('waiting_') ? 'attention' : ''}"></span><span class="task-text">${escape(s.title || 'Untitled task')}</span></button>`).join('') : `<p class="sidebar-empty">${query ? 'No matching tasks.' : state.config.mode === 'disconnected' ? 'Your coding tasks will appear here.' : 'No tasks yet. Start a conversation below.'}</p>`;
  $('#more-sessions').hidden = !state.cursor;
}
function renderDetails() {
  const session = state.selected, container = $('#details-content');
  if (!session) { container.innerHTML = '<p>Start a task to see its status, usage, and pull requests here.</p>'; return; }
  const url = safeURL(session.url), prs = session.pull_requests || [];
  container.innerHTML = `<dl><dt>Status</dt><dd>${escape(displayStatus(session))}</dd><dt>Session ID</dt><dd>${escape(idOf(session))}</dd><dt>ACUs consumed</dt><dd>${escape(session.acus_consumed ?? '—')}</dd><dt>Execution</dt><dd>${session.provider === 'cli' ? escape(session.cwd) : state.config.mode === 'demo' ? 'Offline simulation' : 'Devin cloud environment'}</dd></dl>${url ? `<h3>Workspace</h3><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">Open in Devin ↗</a>` : ''}<h3>Pull requests</h3>${prs.length ? prs.map(pr => { const href = safeURL(pr.pr_url); return href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(pr.pr_state || 'Pull request')} · ${escape(new URL(href).pathname)} ↗</a>` : ''; }).join('') : '<p>PR links appear here when Devin returns them.</p>'}${session.provider === 'cli' ? `<h3>Tool activity</h3>${(session.tools || []).map(tool => `<div class="tool-entry">${escape(tool.title || tool.toolCallId)}<small>${escape(tool.status || 'pending')}</small></div>`).join('') || '<p>No tool activity yet.</p>'}${session.usage?.cost ? `<p>Reported cost: ${escape(session.usage.cost.amount)} ${escape(session.usage.cost.currency)}</p>` : ''}` : ''}${session.structured_output ? `<h3>Structured output</h3><pre>${escape(JSON.stringify(session.structured_output, null, 2))}</pre>` : ''}${!['exit', 'error'].includes(session.status) ? '<button class="danger" id="stop">Stop session</button>' : ''}`;
}
function renderConversation() {
  const session = state.selected;
  $('#welcome').hidden = !!session; $('#transcript').hidden = !session;
  $('#task-title').textContent = session?.title || (session ? 'Untitled task' : 'New task');
  $('#repo').disabled = !!session; $('#acu').disabled = !!session;
  $('.repo-control').hidden = !!session || state.config.mode === 'cli'; $('.acu-control').hidden = !!session || state.config.mode === 'cli';
  const stopped = session && ['exit', 'error'].includes(session.status);
  $('#prompt').disabled = stopped; $('#send').disabled = state.busy || stopped || (session?.provider === 'cli' && (running(session) || session.status_detail === 'waiting_for_approval'));
  $('#prompt').placeholder = stopped ? 'This session has ended. Start a new task.' : session ? 'Send a follow-up to Devin…' : 'Describe a task, ask a question, or share context…';
  $('#composer-hint').textContent = state.config.mode === 'cli' ? `Local project · ${state.config.cli?.cwd || ''}` : state.config.mode === 'demo' ? 'Offline demo · No code is executed' : session ? 'Messages sync from Devin every 5 seconds' : 'Runs in Devin’s environment · Repository optional';
  $('#activity').hidden = !session;
  if (session) { $('#activity span:last-child').textContent = displayStatus(session); $('.pulse').hidden = !running(session); }
  const signature = JSON.stringify(state.messages);
  if (signature !== state.messageSignature) {
    const scroll = $('.conversation'), nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180;
    $('#transcript').innerHTML = state.messages.length ? state.messages.map(m => `<article class="message ${m.source === 'user' ? 'user' : 'assistant'}"><div class="message-heading">${m.source === 'devin' ? '<span class="engine-icon">D</span> Devin' : escape(m.username || (m.source === 'user' ? 'You' : m.source || 'Message'))}<small>${m.created_at ? escape(new Date(m.created_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : ''}</small></div><div class="message-body">${markdown(m.message)}</div></article>`).join('') : '<p class="muted">Waiting for messages from Devin…</p>';
    state.messageSignature = signature;
    if (nearBottom) requestAnimationFrame(() => scroll.scrollTo({ top: scroll.scrollHeight }));
  }
  renderDetails(); renderPermissions();
}
async function loadSessions(append = false) {
  if (state.config.mode === 'disconnected') return;
  const generation = state.generation;
  const page = await api(`/sessions${append && state.cursor ? `?after=${encodeURIComponent(state.cursor)}` : ''}`);
  if (generation !== state.generation) return;
  const merged = new Map((append ? state.sessions : []).map(s => [idOf(s), s]));
  for (const session of page.items || []) merged.set(idOf(session), session);
  state.sessions = [...merged.values()]; state.cursor = page.has_next_page ? page.end_cursor : null;
  state.lastList = Date.now(); renderSessions();
}
async function loadMessages(id) {
  const messages = new Map(), cursors = new Set(); let after;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const page = await api(`/sessions/${encodeURIComponent(id)}/messages${after ? `?after=${encodeURIComponent(after)}` : ''}`);
    for (const message of page.items || []) messages.set(message.event_id || `${message.created_at}:${message.source}:${message.message}`, message);
    if (!page.has_next_page) return [...messages.values()];
    if (!page.end_cursor || cursors.has(page.end_cursor)) throw new Error('Devin returned an invalid message cursor. Open this session in Devin.');
    after = page.end_cursor; cursors.add(after);
  }
  throw new Error('This conversation exceeds 10,000 messages. Open it in Devin to view its full history.');
}
async function syncSelected() {
  if (!state.selected) return;
  const id = idOf(state.selected), generation = state.generation;
  const [session, messages] = await Promise.all([api(`/sessions/${encodeURIComponent(id)}`), loadMessages(id)]);
  if (generation !== state.generation || idOf(state.selected || {}) !== id) return;
  state.selected = session; state.messages = messages;
  const index = state.sessions.findIndex(s => idOf(s) === id);
  if (index >= 0) state.sessions[index] = session;
  renderSessions(); renderConversation();
}
function schedulePoll(delay = state.config.mode === 'cli' ? 1000 : 5000) { clearTimeout(state.timer); if (state.config.mode !== 'disconnected') state.timer = setTimeout(poll, delay); }
async function poll() {
  if (state.polling || state.busy || document.hidden) return schedulePoll();
  state.polling = true; let delay = state.config.mode === 'cli' ? 1000 : 5000;
  try {
    if (state.config.mode === 'cli') { const generation = state.generation; const config = await api('/config'); if (generation === state.generation) { state.config = config; renderConfig(); } }
    if (Date.now() - state.lastList > 30000) await loadSessions();
    await syncSelected(); state.failures = 0;
  } catch (error) {
    state.failures++; delay = Math.max(error.retryAfter * 1000, Math.min(60000, 5000 * 2 ** state.failures));
    notice(`Sync paused: ${error.message} Retrying in ${Math.ceil(delay / 1000)} seconds.`);
  } finally { state.polling = false; schedulePoll(delay); }
}
async function selectSession(session) {
  saveDraft(); state.selected = session; state.messages = []; state.messageSignature = null;
  $('#prompt').value = state.drafts.get(taskKey()) || ''; renderSessions(); renderConversation();
  $('#sidebar').classList.remove('open'); clearNotice();
  try { await syncSelected(); } catch (error) { notice(error.message); }
  schedulePoll();
}
function newTask() {
  if (state.busy) return;
  saveDraft(); state.selected = null; state.messages = []; state.messageSignature = null;
  $('#prompt').value = state.drafts.get('new') || ''; renderSessions(); renderConversation();
  $('#sidebar').classList.remove('open'); $('#prompt').focus(); clearNotice();
}
async function changeConnection(input, keepOpen = false) {
  if (state.busy) throw new Error('Wait for the current task request to finish.');
  setBusy(true);
  try {
    const config = await api('/connection', { method: 'POST', body: JSON.stringify(input) });
    state.generation++; state.config = config; state.sessions = []; state.selected = null; state.messages = []; state.cursor = null; state.drafts.clear(); state.messageSignature = null;
    $('#prompt').value = ''; $('#search').value = ''; $('#api-key').value = '';
    renderConfig(); renderSessions(); renderConversation(); clearNotice();
    if (!keepOpen) $('#connection-dialog').close(); await loadSessions(); schedulePoll();
  } finally { setBusy(false); renderConversation(); }
}
$('#composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy) return;
  if (state.config.mode === 'disconnected') return openSettings();
  const prompt = $('#prompt').value.trim(); if (!prompt) return;
  const session = state.selected, key = taskKey(); setBusy(true); clearNotice();
  try {
    if (session) await api(`/sessions/${encodeURIComponent(idOf(session))}/messages`, { method: 'POST', body: JSON.stringify({ message: prompt }) });
    else {
      const created = await api('/sessions', { method: 'POST', body: JSON.stringify({ prompt, repo: $('#repo').value.trim(), max_acu_limit: Number($('#acu').value) }) });
      state.selected = created; state.sessions.unshift(created);
    }
    state.drafts.delete(key);
    if ((!session || idOf(state.selected || {}) === idOf(session)) && $('#prompt').value.trim() === prompt) $('#prompt').value = '';
    renderSessions(); renderConversation();
    try { await syncSelected(); } catch (error) { notice(`Message accepted, but refresh failed: ${error.message}`); }
    requestAnimationFrame(() => $('.conversation').scrollTo({ top: $('.conversation').scrollHeight }));
  } catch (error) { notice(error.message); }
  finally { setBusy(false); renderConversation(); schedulePoll(); $('#prompt').focus(); }
});
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#composer').requestSubmit(); } });
$('#prompt').addEventListener('input', () => { $('#prompt').style.height = 'auto'; $('#prompt').style.height = `${Math.min(220, $('#prompt').scrollHeight)}px`; });
$('#new-task').onclick = newTask;
$('#search').oninput = renderSessions;
$('#sessions').onclick = event => { const button = event.target.closest('[data-id]'); if (button && !state.busy) selectSession(state.sessions.find(s => idOf(s) === button.dataset.id)); };
$('#refresh').onclick = async () => { try { clearNotice(); await loadSessions(); await syncSelected(); } catch (error) { notice(error.message); } };
$('#more-sessions').onclick = async () => { $('#more-sessions').disabled = true; try { await loadSessions(true); } catch (error) { notice(error.message); } finally { $('#more-sessions').disabled = false; } };
$$Suggestions();
function $$Suggestions() { document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('#prompt').value = button.dataset.prompt.replaceAll('\\n', '\n'); $('#prompt').focus(); }; }); }
function openSettings() { $('#connection-error').hidden = true; $('#org-id').value = state.config.orgId || ''; if (state.config.cli?.cwd) $('#local-cwd').value = state.config.cli.cwd; renderCliAuth(); $('#connection-dialog').showModal(); }
$('#settings').onclick = openSettings;
$('#close-settings').onclick = () => { $('#api-key').value = ''; $('#connection-dialog').close(); };
$('#connection-dialog').addEventListener('close', () => { $('#api-key').value = ''; });
$('#connection-form').onsubmit = async event => { event.preventDefault(); $('#connection-error').hidden = true; try { await changeConnection({ mode: 'live', apiKey: $('#api-key').value, orgId: $('#org-id').value }); } catch (error) { $('#connection-error').textContent = error.message; $('#connection-error').hidden = false; } };
async function demo() { try { await changeConnection({ mode: 'demo' }); $('#prompt').focus(); } catch (error) { notice(error.message); } }
$('#try-demo').onclick = demo; $('#demo-settings').onclick = demo;
$('#disconnect').onclick = async () => { try { await changeConnection({ mode: 'disconnected' }); } catch (error) { notice(error.message); } };
function toggleDetails(show) { $('#details').hidden = !show; $('#details-toggle').setAttribute('aria-expanded', String(show)); }
$('#details-toggle').onclick = () => toggleDetails($('#details').hidden);
$('#close-details').onclick = () => toggleDetails(false);
let stopTarget;
$('#details-content').onclick = event => { if (event.target.id === 'stop') { stopTarget = idOf(state.selected); $('#stop-dialog').showModal(); } };
$('#cancel-stop').onclick = () => $('#stop-dialog').close();
$('#confirm-stop').onclick = async () => {
  if (state.busy) return;
  setBusy(true); $('#confirm-stop').disabled = true;
  try { await api(`/sessions/${encodeURIComponent(stopTarget)}`, { method: 'DELETE' }); $('#stop-dialog').close(); await syncSelected(); await loadSessions(); }
  catch (error) { $('#stop-dialog').close(); notice(error.message); }
  finally { $('#confirm-stop').disabled = false; setBusy(false); renderConversation(); }
};
$('#notice button').onclick = clearNotice;
$('#open-sidebar').onclick = () => $('#sidebar').classList.add('open');
$('#close-sidebar').onclick = () => $('#sidebar').classList.remove('open');
try { document.documentElement.dataset.theme = localStorage.getItem('relay-theme') || 'light'; } catch {}
$('#theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('relay-theme', theme); } catch {} };
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && !document.querySelector('dialog[open]')) { if (event.key.toLowerCase() === 'k') { event.preventDefault(); $('#sidebar').classList.add('open'); $('#search').focus(); } if (event.key.toLowerCase() === 'n') { event.preventDefault(); newTask(); } } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(0); });

let authSignature = '', permissionSignature = '';
function renderCliAuth() {
  const info = state.config.cli, signature = JSON.stringify(info);
  $('#cli-auth').hidden = state.config.mode !== 'cli';
  if (signature === authSignature) return;
  authSignature = signature;
  if (!info) return;
  $('#cli-status').textContent = info.closed ? 'CLI disconnected. Use Devin CLI above to reconnect.' : ({ pending: 'Complete sign-in in the browser Devin opened. Waiting for confirmation…', authenticated: 'Signed in with Devin. Your project is ready.', error: info.auth.error, unknown: 'CLI ready. Reuse your existing sign-in or log in below.' }[info.auth.state]);
  $('#cli-auth-methods').innerHTML = (info.authMethods || []).map(method => `<button type="button" class="primary" data-auth-method="${escape(method.id)}" ${info.auth.state === 'pending' || info.closed ? 'disabled' : ''}>${escape(method.name)}</button>`).join('');
}
function connectionError(error) { $('#connection-error').textContent = error.message; $('#connection-error').hidden = false; }
function connectionTab(kind) {
  for (const name of ['cli', 'api']) { $(`#${name}-panel`).hidden = name !== kind; $(`#${name}-tab`).setAttribute('aria-selected', String(name === kind)); }
  $('#connection-error').hidden = true;
}
$('#cli-tab').onclick = () => connectionTab('cli');
$('#api-tab').onclick = () => connectionTab('api');
for (const name of ['cli','api']) $(`#${name}-tab`).onkeydown = event => { if (['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const next = name === 'cli' ? 'api' : 'cli'; connectionTab(next); $(`#${next}-tab`).focus(); } };
$('#cli-form').onsubmit = async event => { event.preventDefault(); $('#connection-error').hidden = true; try { await changeConnection({ mode: 'cli', cwd: $('#local-cwd').value.trim() }, true); } catch (error) { connectionError(error); } };
$('#cli-auth-methods').onclick = async event => {
  const button = event.target.closest('[data-auth-method]'); if (!button) return;
  button.disabled = true;
  try { state.config.cli = await api('/cli/auth', { method: 'POST', body: JSON.stringify({ methodId: button.dataset.authMethod }) }); renderCliAuth(); schedulePoll(1000); }
  catch (error) { button.disabled = false; connectionError(error); }
};
$('#cli-ready').onclick = () => { $('#connection-dialog').close(); $('#sidebar').classList.remove('open'); $('#prompt').focus(); };
function renderPermissions() {
  const requests = state.selected?.permissions || [], signature = JSON.stringify([state.selected?.session_id,requests]);
  $('#permissions').hidden = requests.length === 0;
  if (permissionSignature === signature) return;
  permissionSignature = signature;
  $('#permissions').innerHTML = requests.map(request => `<section class="permission-card"><h3>${escape(request.toolCall?.title || 'Devin needs permission')}</h3><pre>${escape(JSON.stringify(request.toolCall?.rawInput || request.toolCall || {},null,2))}</pre><div class="permission-actions">${request.options.map(option => `<button data-permission="${escape(request.id)}" data-option="${escape(option.optionId)}">${escape(option.name)}</button>`).join('')}</div></section>`).join('');
}
$('#permissions').onclick = async event => {
  const button = event.target.closest('[data-permission]'); if (!button || !state.selected) return;
  const sessionId = idOf(state.selected); button.disabled = true;
  try { await api(`/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(button.dataset.permission)}`, { method: 'POST', body: JSON.stringify({ optionId: button.dataset.option }) }); await syncSelected(); }
  catch (error) { button.disabled = false; notice(error.message); }
};
try { state.config = await api('/config'); renderConfig(); renderConversation(); await loadSessions(); schedulePoll(); } catch (error) { notice(error.message); }
