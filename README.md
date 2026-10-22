# Redmine MCP bridge

Claude Code → MCP (HTTP, loopback) → local daemon → WebSocket → Chrome extension → your Redmine, using your logged-in browser session. Cookies never leave Chrome. Design: [PLAN.md](PLAN.md). Status: [PROGRESS.md](PROGRESS.md).

## Requirements

Node 22+, Chrome (or Chromium-based browser), Claude Code. Each member runs their **own** daemon and uses their **own** Redmine login; nothing is shared between members.

## Setup (per member)

1. Install and build: `npm install && npm run build:ext`
2. Start the daemon and leave it running: `npm run daemon`
   - `READ_ONLY=1 npm run daemon` disables every write tool (recommended until you trust it).
   - Port clash: `REDMINE_MCP_PORT=7400 npm run daemon`, then use the same port in steps 4 and 6.
3. Chrome: open `chrome://extensions`, enable Developer mode, **Load unpacked**, select `extension/dist`.
4. Click the extension icon: enter your Redmine address (e.g. `https://redmine.example.com`) and the daemon port (default 7399), then **Save**. Chrome asks you once to allow the extension to access that site (the badge shows `?` until an address is saved). The popup shows whether the daemon is connected and the toolbar badge shows `ON`.
5. In that same Chrome profile, log in to your Redmine (including any protection layer in front of it). Log in again whenever the session expires.
6. Register the MCP server with Claude Code. The repo ships `.mcp.json`: start `claude` from this repo and approve the `redmine-bridge` server. To use it from another project instead:
   ```bash
   claude mcp add --transport http redmine-bridge http://127.0.0.1:7399/mcp
   ```
7. Verify: `npm run smoke` prints your user and 3 of your assigned issues. `curl localhost:7399/health` shows whether the extension is connected and which build.

## How authentication works

Redmine ignores session cookies on `.json` URLs and wants an API key. The extension reads your API access key itself from your logged-in session (`/my/api_key` over XHR as the "Show" button does, falling back to the account page HTML), keeps it only in the extension's memory and sends it as `X-Redmine-API-Key` from your browser, so the protection layer still sees a normal browser request. You never create or paste a key. The key is stripped from every result and error before anything reaches the daemon or Claude, and is re-read automatically if you regenerate it.

## Daily use

Start the daemon, open Chrome (logged in to Redmine), then use Claude Code. Example prompts: "list my open issues", "show issue 1234 with comments", "set issue 1234 to In Progress and add a note".

Write tools (`update_issue`, `add_note`, `create_issue`, `log_time`) act as you in Redmine. Claude Code asks before running them unless you allowed them. Every write is appended to `~/.local/state/redmine-mcp/audit.log`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `NOT_CONNECTED` | Daemon not running, extension badge not `ON`, or wrong port in the extension popup. |
| `AUTH_REQUIRED: could not read the API access key` | Your account page shows no API key: the REST API is disabled in Redmine (Administration → Settings → API) or your account may not use it. Ask a Redmine admin. |
| `AUTH_REQUIRED` | Redmine or protection-layer session expired or you are not logged in: open Redmine in Chrome and log in. If it persists while logged in, the extension's fetch is being challenged; tell the maintainers (fallback: content-script mode, see PLAN.md). |
| `FORBIDDEN_PATH` | The endpoint is not on the allowlist in `shared/protocol.ts` (by design). |
| `VALIDATION: ...` | Redmine rejected the data, e.g. an invalid status for the workflow. Use `list_statuses`, `list_trackers` etc. to get valid ids. |
| `CSRF` | Token rejected twice; reload the Redmine tab, log in again. |
| Extension changes not taking effect | After `npm run build:ext`, remove and re-add the unpacked extension (or reload it) and compare the `build` value in `curl localhost:7399/health` with the stamp in `extension/dist/worker.js`. |
| `EADDRINUSE` on daemon start | A daemon is already running on that port; stop it (`pkill -f "[d]aemon/src/index.ts"`) or use another `REDMINE_MCP_PORT`. |
| `TIMEOUT` | Chrome asleep or worker restarting; retry. |
| Tools missing | Daemon started with `READ_ONLY=1`, or the MCP server is not approved in Claude Code. |

## Security notes

- Cookies and your API key never leave Chrome; the daemon and Claude only see Redmine API responses.
- The daemon has no token. It listens on `127.0.0.1` only, rejects any `Host` that is not loopback (DNS rebinding), rejects `/mcp` requests that carry a browser `Origin`, and only accepts the WebSocket from a `chrome-extension://` origin (pin it with `REDMINE_MCP_EXTENSION_ID=<id>`). Any process running as you on this machine can still call the tools, so use `READ_ONLY=1` if that matters.
- The extension only talks to the Redmine address you saved in the popup (https only, or http for localhost; Chrome asks you to grant access to that site) and only to allowlisted endpoints. There is no delete tool.
- Issue text is untrusted input to Claude (prompt injection): keep write approval on.

## Tools

Read: `get_current_user`, `list_projects`, `list_issues`, `get_issue`, `search_issues`, `list_statuses`, `list_trackers`, `list_project_trackers`, `list_priorities`, `list_time_entry_activities`, `list_versions`, `list_project_members`.
Write: `update_issue`, `add_note`, `create_issue`, `log_time`.

Tip: a project only accepts its enabled trackers. Redmine silently falls back to the default tracker when `create_issue` gets one that is not enabled (project Support only has the `AILAB - *` trackers). Call `list_project_trackers` first; `create_issue` returns a `warning` when the tracker differs.

## Development

`npm test` (unit, integration, end-to-end with a fake Redmine), `npm run typecheck`. Project conventions for Claude are in `CLAUDE.md`; a hook typechecks after every `.ts` edit.
