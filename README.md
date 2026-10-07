# Relay — a local Devin coding harness

A Codex-inspired local chat workspace with two Devin connections: **Devin CLI browser sign-in over ACP** and the **Devin Cloud v3 API**. The dependency-free Node.js server runs locally. CLI mode works on your local project; Cloud API mode executes in Devin’s cloud environment.

## Run

Requires Node.js 22 or newer. No install step or external packages.

```sh
cd relay-devin-harness
npm start
```

Open **http://127.0.0.1:4317**. For Cloud API mode, choose **Connect Devin → API token** and enter a v3 service-user credential or personal access token and an organization ID (`org-…`). Relay checks access before switching the connection. Credentials entered in the UI stay in server memory and are cleared when the process exits; they are never placed in browser storage or returned by the API.

### Devin sign-in (no Cloud API token)

1. Install the [official Devin CLI](https://devin.ai/cli) if it is not installed. Relay finds `devin` on PATH, or uses the absolute path in `DEVIN_CLI_PATH`.
2. In settings, choose **Devin sign-in**, enter an absolute local project folder, and click **Use Devin CLI**.
3. Click **Log in with browser** and complete Devin's sign-in yourself. Relay uses the authentication method advertised by the CLI and waits for the CLI to confirm success. Alternatively, it reuses credentials already saved by `devin auth login`.
4. Choose **Continue to workspace**, then send a task.

Your account must have Devin CLI access. This uses that access and its billing; it does not bypass your organization's entitlements. The CLI holds and stores credentials in its own profile. Relay does not read credential files or browser cookies. The Cloud API connection remains available separately.

Optional isolated profile: set `RELAY_DEVIN_DATA_HOME` and `RELAY_DEVIN_CONFIG_HOME` in `.env` to private local directories. Omit both to reuse your normal system CLI sign-in. Relay does not distribute the Devin CLI binary; install it from the official source.

Local CLI sessions use `--permission-mode normal`. Permission requests emitted by Devin appear in the chat with the agent's actual choices. Relay never chooses an approval automatically; existing Devin policy still controls operations that do not generate an approval request. Unknown client-side tool methods are rejected. Tool activity and streamed text appear as they arrive (the UI refreshes local state every second). No API ACU cap is sent for CLI sessions; account limits apply and the Cloud-only cap control is hidden.

For this first CLI integration, Relay's local conversation index and transcripts last for the connected server process. Refreshing the page preserves them. Disconnecting/reconnecting or restarting Relay loses that UI history; it does not revoke the CLI's saved sign-in. Sessions created by other CLI clients are not imported. Stop sends ACP cancellation; if Devin fails to end the turn within five seconds, Relay closes the shared CLI process, which also interrupts any other local sessions. Connection switching is blocked while a local prompt or sign-in is in progress.

### Models, modes and slash commands (CLI mode)

Relay shows whatever Devin advertises over ACP, the same way ACP editors do, so new models and commands appear without a Relay update.

- **Model, mode and other settings.** When the CLI connects, Relay prepares a Devin session in the background so the composer can show Devin's selectors before your first message (model, mode such as Normal / Plan / Accept Edits, and any other options like reasoning level). Changes apply immediately and carry into the task. They can also be changed mid-session, including while Devin is working. Relay uses ACP session config options and falls back to the older `session/set_model` / `session/set_mode` methods for agents that only support those.
- **Slash commands.** Type `/` in the composer to open Devin's command palette with descriptions and argument hints. Use ↑/↓ to move, Tab or Enter to pick, Esc to close. Commands are sent to Devin as normal prompts, as ACP specifies. Devin's ACP set includes `/plan`, `/ask`, `/compact`, `/context`, `/fast`, `/loop`, `/btw`, `/session-stats`, `/mcp` and `/bug`, plus your own skills. Terminal-only commands (for example `/theme`, `/copy`, `/mouse`) are not offered because Devin does not advertise them to ACP hosts.
- **Default model.** Set `RELAY_DEVIN_MODEL` in `.env` (for example `opus`) to pass `--model` to `devin acp` for every new session.

These controls are CLI-only. The Cloud API v3 connection does not expose model or command selection.

### Cloud API configuration

Alternatively, copy `.env.example` to `.env`, populate `DEVIN_API_KEY` and `DEVIN_ORG_ID`, and restart. This explicitly stores the credentials on disk; `.env` is git-ignored. Keep it private. Environment credentials are read at startup; disconnecting clears the active connection until you reconnect or restart.

Choose **Explore the offline demo** to test the full chat lifecycle without an account. Demo messages are clearly labeled and no API calls, repository operations, or code execution occur. Demo sessions last only for this server process.

## Use

- Type a task, optionally enter `owner/repository`, and set the maximum ACUs before sending. The default cap is 10. Live tasks consume Devin credits.
- Follow existing sessions in the sidebar. The API token determines which organization sessions are visible.
- Send follow-ups with Enter; insert new lines with Shift+Enter. Cmd/Ctrl+N starts a task; Cmd/Ctrl+K focuses task search.
- Inspect status, actual ACU consumption, returned PR links, and structured output in **Session details**. **Open in Devin** exposes Devin's full workspace, including approval interactions.
- **Stop session** calls Devin's terminate endpoint after confirmation. Disconnecting or closing Relay does **not** stop cloud sessions.
- Search filters loaded tasks. **Load more tasks** retrieves the next server page. Messages follow API pagination (up to 10,000 messages per conversation).
- The theme preference persists in this browser. Drafts live only in this page's memory; session history lives in Devin. Reloading loses unsent drafts.

## Architecture and limits

`public/` is the chat UI; `server.mjs` binds only to `127.0.0.1`; `devin.mjs` owns the Cloud adapter and offline simulator; `acp.mjs` runs the official CLI as a subprocess using newline-delimited JSON-RPC. The adapter can be replaced without changing the UI routes. The server has an explicit route allowlist, Host/Origin checks, a mutation token, bounded JSON bodies, a restrictive CSP, and no arbitrary shell-command endpoint. In CLI mode, the official agent can execute commands and edit files under its own permission policies. Do not expose this single-user server on a public network.

In Cloud API mode, the browser polls messages and status every five seconds, slows down after errors, respects numeric Retry-After values, and suspends polling while hidden. It refreshes the first session page every 30 seconds. API mutations are never automatically retried because an uncertain response may already have created a paid task or sent a message. On uncertain failures, refresh and inspect Devin before retrying.

This is a working local browser app, not a packaged native application. It does not implement local worktree management, an embedded terminal, filesystem synchronization, attachments, or inline code diffs. In CLI mode, the project directory and Devin CLI provide local file access and execution; Cloud API mode uses Devin Cloud. Repository selection uses Devin's `repos` field; the repository must already be accessible to the Devin organization. Token streaming, terminal output, and diffs are not fabricated from the session-message API. The UI renders plain text, fenced code, inline code, and bold formatting; PR/workspace links are separately validated as HTTPS.

## Validation

```sh
npm run check
npm test
```

Tests use an injected mock transport and local HTTP server. They cover v3 routes and payloads, credentials, input validation, rate limits, ambiguous mutation failures, session isolation, stop behavior, HTTP lifecycle, origin/CSRF guards, traversal prevention, and transactional connection changes. ACP tests additionally cover browser authentication negotiation, streamed turns, tool updates, permission validation and cancellation, process errors, and JSON-RPC framing. A handshake against the official Devin CLI has also been verified during development. Authenticated execution needs your sign-in and is not verified by the offline tests.

## Protocol and API references

- [Devin ACP integration](https://docs.devin.ai/cli/acp/zed)
- [Devin CLI commands and authentication](https://docs.devin.ai/cli/reference/commands)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/initialization)

- [Authentication](https://docs.devin.ai/api-reference/authentication)
- [Create session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions)
- [List sessions](https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions)
- [Get session](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session)
- [List messages](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages)
- [Send message](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages)
- [Terminate session](https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions)

Independent client; not affiliated with OpenAI or Cognition.
