# redmine-mcp

Local MCP daemon + Chrome extension that lets Claude use Redmine through the user's logged-in browser session. See README.md (usage) and DESIGN.md (design); update them when behaviour changes.

## Commands

- `npm run ci` before a PR (typecheck, lint, format check, tests with coverage, build); `npm test` for tests only; `npm run format` writes Prettier formatting
- `npm run build:ext` builds `extension/dist`; `npm run daemon` starts the daemon; `npm run smoke` calls the running daemon.

## Layout

- `shared/protocol.ts`: message types and the request allowlist shared by daemon and extension. Change the allowlist here only.
- `daemon/src`: `bridge.ts` (WS to extension), `redmine.ts` (client), `tools/` (MCP tools), `app.ts` (HTTP server).
- `extension/src`: `core.ts` (executes requests, CSRF, error mapping), `link.ts` (WS + reconnect), `worker.ts`, `popup.ts` + `settings.ts` (Redmine address and port entered in the toolbar popup).

## Rules

- Cookies, CSRF tokens and the Redmine API key must never leave the extension: never add `chrome.cookies`, never log or return them. `/my/account` and `/my/api_key` stay out of the daemon-visible allowlist (the account page contains the key); `core.ts` scrubs `api_key` and redacts the key from all results.
- Never add a generic "fetch any URL" tool; new endpoints go through `isAllowedRequest` plus a typed tool.
- The daemon has no token by design (loopback only, Host and Origin checks in `daemon/src/app.ts` and `bridge.ts`); keep those checks when touching the server.
- New tool or error path needs a unit test, and an e2e test in `test/e2e.test.ts` when it crosses daemon and extension.
- Write tools must stay hidden when `READ_ONLY=1`.
- The fake Redmine in `test/e2e.test.ts` and `extension/test/core.test.ts` must mirror the real site (401 on `.json` without the key header, key via XHR); when the real site surprises you, teach the fake first, then fix the code.
- `create_issue` silently falls back to the default tracker on the real site; keep the tracker warning.
