# Redmine MCP bridge — design

Design of the implemented system, verified against a real Redmine 6 instance behind a protection layer (read and write). Usage: [README.md](README.md).

Goal: Claude reads and updates Redmine tasks through MCP tools while the user's browser session stays the only credential. The site sits behind an external protection layer, so a script outside the browser cannot reach it.

## 1. Architecture

```
Claude Code ──(MCP, streamable HTTP, 127.0.0.1:7399/mcp)──> Bridge daemon (Node/TS)
                                                                │  WebSocket 127.0.0.1:7399/ext
                                                                ▼
                                               Chrome extension (MV3 service worker)
                                                                │  fetch(credentials: include) + X-Redmine-API-Key
                                                                ▼
                                                     your Redmine (REST JSON)
```

- **Daemon** (`daemon/src`): exposes the MCP server and the extension WebSocket. Turns a tool call into a request message, waits for the reply (20 s timeout), shapes the response into compact JSON. `/health` reports whether an extension is connected and its build stamp.
- **Extension** (`extension/src`): `core.ts` executes allowlisted requests and maps errors; `link.ts` keeps the WebSocket alive (ping every 20 s, reconnect with backoff); `worker.ts` wires it to Chrome; `popup.ts` is the toolbar popup where the user enters the Redmine address (validated by `settings.ts`: https, or http for localhost only; access granted at runtime through `optional_host_permissions`) and the daemon port. It knows nothing about tools.
- **Why a daemon, not Native Messaging**: Chrome would spawn the native host while Claude spawns the MCP server, so they would still need IPC. One loopback daemon serves several Claude sessions and outlives them.
- **Shared** (`shared/protocol.ts`): message types and `isAllowedRequest`, the single allowlist of method plus path pairs.

## 2. Authentication (what the real site required)

1. The browser session (protection-layer cookie plus Redmine session) is attached automatically to the extension's `fetch`.
2. Redmine ignores session cookies on `.json` URLs and answers `401 WWW-Authenticate: Basic realm="Redmine API"`. So the extension reads the user's own API key from the logged-in session and sends it as `X-Redmine-API-Key`.
3. Key retrieval order: `GET /my/api_key` as an XHR (Redmine 6 leaves the key out of the account page and loads it when "Show" is clicked), then the same URL as HTML, then `/my/account`. The key is cached in memory only and re-read once after a 401 (regenerated key).
4. The key never leaves `core.ts`: `api_key` fields are removed from every result (Redmine returns it in `/users/current.json`), the key value is redacted from error text, and diagnostics only carry masked snippets. `/my/account` and `/my/api_key` are not on the daemon-visible allowlist.
5. Writes also send an `X-CSRF-Token` read from `/my/account`; a bare 422 refreshes the token and retries once.

Rejected alternatives: scraping HTML/CSV (large, brittle, no `DOMParser` in the MV3 worker); a content-script fetch inside a Redmine tab (kept as a fallback, never needed).

## 3. Security model

- Daemon binds to `127.0.0.1` only. There is no shared token (decision: simpler setup). Instead it rejects any non-loopback `Host` (DNS rebinding), rejects `/mcp` requests that carry a browser `Origin`, and accepts the WebSocket only from `chrome-extension://` (optionally pinned with `REDMINE_MCP_EXTENSION_ID`). Trade-off: any local process running as the user can call the tools; `READ_ONLY=1` removes the write tools.
- A write whose reply is lost (timeout, reconnect) may still have been applied; the tool error says so, because retrying `create_issue` or `log_time` could duplicate it.
- The extension reaches only the Redmine origin the user saved in the popup: access to that origin is granted at runtime through a Chrome permission prompt (`optional_host_permissions`); there are no static host permissions. No `cookies` permission.
- Fixed, typed tools only; no generic "fetch any URL" tool; no delete.
- Write tools are hidden under `READ_ONLY=1`, carry MCP annotations so Claude Code asks for approval, and are appended to `~/.local/state/redmine-mcp/audit.log` (tool, arguments, outcome; no secrets).
- Long journal entries are truncated; attachments are metadata only.

## 4. MCP tools

Read: `get_current_user`, `list_projects`, `list_issues`, `get_issue`, `search_issues`, `list_statuses`, `list_trackers`, `list_project_trackers`, `list_priorities`, `list_time_entry_activities`, `list_versions`, `list_project_members`.
Write: `update_issue` (tracker, status, assignee, priority, done ratio, version, due date, subject, note), `add_note`, `create_issue`, `log_time`.

Gotcha found on the real site: `create_issue` with a tracker that is not enabled for the project is not rejected; Redmine silently uses the default tracker (project Support only enables the `AILAB - *` trackers). Use `list_project_trackers` first; `create_issue` returns a `warning` when the tracker differs.

Out of scope: delete, wiki, news, file upload, project and member management, Gantt and dashboards.

## 5. Message protocol (daemon ⇄ extension)

```
→ {id, type:"http", method:GET|POST|PUT, path, query?, body?}
← {id, type:"http-result", ok:true, status, json?}
← {id, type:"http-result", ok:false, error:{code, message, status?, details?}}
   code: AUTH_REQUIRED | CSRF | NETWORK | FORBIDDEN_PATH | NOT_FOUND | VALIDATION | HTTP | TIMEOUT | NOT_CONNECTED
↔ {type:"ping"} / {type:"pong"}
← {type:"hello", version, build}          // on connect
```

`AUTH_REQUIRED` covers redirects, 401, HTML 403 or 200 (login or protection page), and a missing API key; its `details` hold status, headers and a masked snippet, never the key.

## 6. Repository layout

```
shared/protocol.ts            allowlist + message types
daemon/src/{index,app,bridge,config,redmine,mcp,audit}.ts, tools/{index,shape}.ts
extension/src/{core,link,worker,popup,settings}.ts
extension/{manifest.json,popup.html,build.mjs}
test/e2e.test.ts              MCP client -> daemon -> extension core -> fake Redmine
daemon/test, extension/test   unit and integration tests
scripts/smoke.ts              calls get_current_user and list_issues on a running daemon
.mcp.json, CLAUDE.md, .claude/settings.json, .claude/hooks/typecheck.sh
```

## 7. Testing

- Unit and integration (vitest): allowlist, bridge auth/round trip/timeout/disconnect, tools through an in-memory MCP client, executor error mapping and key handling, link reconnect.
- End to end: real daemon, real MCP client over HTTP, extension core over a real WebSocket, a fake Redmine that mimics the real behaviour (401 on `.json` without the key header, key via XHR, CSRF, session expiry, key regeneration). The fake must keep mirroring the real site: it once accepted session cookies on `.json`, which hid the main integration problem.
- Manual on the real site: `npm run smoke`, then one write on a scratch issue.

## 8. Risks and open points

| Risk                                         | Mitigation                                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Session or protection-layer cookie expires   | `AUTH_REQUIRED` with an instruction to log in again; no blind retries.                                                                    |
| Admin disables the REST API or hides the key | Clear `AUTH_REQUIRED` message; no fallback implemented.                                                                                   |
| Redmine upgrade changes the key page         | Three retrieval strategies plus masked diagnostics.                                                                                       |
| Chrome closed or wrong profile               | `NOT_CONNECTED` fails fast.                                                                                                               |
| Any local process can use the daemon         | Loopback and Host/Origin checks, `READ_ONLY=1`; accepted trade-off.                                                                       |
| Prompt injection through issue text          | Write approval stays on; no generic fetch; no delete.                                                                                     |
| MV3 worker sleeps                            | Ping keep-alive, `chrome.alarms` restart, reconnect with backoff; `restart()` is serialised so overlapping events cannot start two links. |

Not built (by choice): a systemd unit for the daemon, a content-script fallback (never needed), delete tools, a generic fetch tool.
