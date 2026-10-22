# Redmine MCP bridge

Claude Code → MCP (HTTP, loopback) → local daemon → WebSocket → Chrome extension → your Redmine, using your logged-in browser session. Cookies never leave Chrome. Design: [DESIGN.md](DESIGN.md).

## Requirements

Node 22+, Chrome (or a Chromium-based browser), Claude Code, git. Each member runs their **own** daemon and uses their **own** Redmine login; nothing is shared between members.

## Setup

Chrome starts the daemon itself through Chrome's Native Messaging feature, so there is no daemon to launch by hand: you install the extension once and run one registration command. Steps marked **Human** need the Chrome UI or your Redmine login and cannot be done by an agent; the others are plain terminal work. Each step ends with a check and the output to expect. Linux and macOS are supported (Windows needs a registry entry and is not done yet; use the manual daemon below).

### For an AI agent doing this setup

- Run the **Agent** steps in order and stop at step 2: print the Human instructions, then wait for the user to say they are done. Do not try to drive Chrome or log in to Redmine, and never ask for or type credentials.
- Use `npm run smoke:check` (step 4) and not `npm run smoke`: the latter prints the user's name and issues.
- Do not paste the contents of `~/.local/state/redmine-mcp/` or any browser data into the chat. This project has no token or secret to configure.
- If a check fails, use the Troubleshooting table; do not retry in a loop.

### 1. Get the code and register the native host (Agent)

```bash
git clone https://github.com/g2s-solution/redmine-browser-mcp.git
cd redmine-browser-mcp
node -v            # must print v22 or newer
npm ci && npm run build:ext
npm run install-host
```

Check: `npm run install-host` prints the extension id `nhcphgmoomfcfoakphjjjpdbbdjeioaj` and the files it wrote. It registers the host for every Chrome, Chromium, Brave or Edge profile directory it finds, so start your browser once before running it. Re-run it after moving the repository. Options: `npm run install-host -- --read-only` removes every write tool (recommended until you trust it), `-- --port 7400` changes the daemon port, `npm run uninstall-host` removes everything.

### 2. Load the extension and log in (Human)

1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** and select the `extension/dist` folder from step 1 (or an unzipped release, see "Install the extension from a release"). The extension id must be `nhcphgmoomfcfoakphjjjpdbbdjeioaj`; it is fixed by the manifest.
3. Click the extension's toolbar icon, enter your Redmine address (for example `https://redmine.example.com`), then **Save**. Chrome asks once to allow the extension to access that site; accept. The badge shows `?` until an address is saved and `ON` once connected.
4. In the same browser profile, open your Redmine and log in, including any protection layer in front of it. Log in again whenever the session expires.

Check: the popup says "Connected (native host started by Chrome)" and `curl -s localhost:7399/health` shows `"extensionConnected":true`.

### 3. Register the MCP server with Claude Code (Agent)

The server is registered as a **stdio** command, not as an HTTP URL. Claude Code sends MCP-over-HTTP through the `HTTPS_PROXY` it is configured with, and a corporate proxy cannot reach `127.0.0.1` (the symptom is a 503 with a Squid error page). `npm run -s mcp-stdio` is a small relay that Claude Code spawns; it forwards each message to the daemon directly and never uses the proxy.

Either start `claude` from this repository once (it ships `.mcp.json`; approve the `redmine-bridge` server), or register it for all projects, using the absolute path of your clone:

```bash
claude mcp add --scope user redmine-bridge -- npm --prefix "$(pwd)" run -s mcp-stdio
```

A non-default daemon port is passed through the environment: `claude mcp add --scope user -e REDMINE_MCP_PORT=7400 redmine-bridge -- npm --prefix "$(pwd)" run -s mcp-stdio`.

Check: `claude mcp list` shows `redmine-bridge` as connected (a project-scope server first shows "Pending approval" until you approve it in `claude`). On a machine with no proxy, plain HTTP also works: `claude mcp add --transport http redmine-bridge http://127.0.0.1:7399/mcp`.

### 4. Verify (Agent)

```bash
npm run smoke:check
```

Check: two lines, `OK   get_current_user: (data hidden)` and `OK   list_issues: (data hidden)`, and exit code 0. On failure it prints the error (for example `AUTH_REQUIRED` or `NOT_CONNECTED`) and exits 1. `npm run smoke` prints the actual data and is for people.

### 5. Use it

Keep the browser open and logged in to Redmine, then use Claude Code. Example prompts: "list my open issues", "show issue 1234 with comments", "set issue 1234 to In Progress and add a note".

Write tools (`update_issue`, `add_note`, `create_issue`, `log_time`) act as you in Redmine. Claude Code asks before running them unless you allowed them. Every write is appended to `~/.local/state/redmine-mcp/audit.log`.

### Alternative: run the daemon yourself

Use this on Windows, for development, or if you do not want the native host. Run `npm run daemon` from the repository (or detached: `mkdir -p ~/.local/state/redmine-mcp && setsid nohup npm run daemon > ~/.local/state/redmine-mcp/daemon.log 2>&1 &`). When the extension finds no native host, or the host cannot start because a daemon already owns the port, it connects to that daemon over a WebSocket on its own; the popup then says "daemon over WebSocket" and uses the port from the popup. Environment variables for the manual daemon:

| Variable                   | Effect                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `READ_ONLY=1`              | Removes every write tool.                                                                                |
| `REDMINE_MCP_PORT`         | Port, default 7399. Keep it the same in the popup, in `install-host --port` and in the MCP registration. |
| `REDMINE_MCP_EXTENSION_ID` | Pins the one extension allowed to connect over WebSocket; the id is shown at the bottom of the popup.    |
| `REDMINE_MCP_TIMEOUT_MS`   | Per-request timeout, default 20000.                                                                      |
| `REDMINE_MCP_STATE_DIR`    | Where the audit log goes, default `~/.local/state/redmine-mcp`.                                          |

Invalid values stop the daemon at startup with a message in the log. Stop a manual daemon with `pkill -f "[d]aemon/src/index.ts"`.

## Install the extension from a release

Chrome cannot install an extension straight from a GitHub URL, but you do not need to build it:

1. Download `redmine-bridge-extension-<version>.zip` from the [Releases](../../releases) page and unzip it somewhere permanent (Chrome loads it from that folder).
2. `chrome://extensions` → Developer mode → **Load unpacked** → select the unzipped folder.
3. To update, download the newer zip, replace the folder contents and click the reload icon on the extension.

The daemon and the native host still run from a clone of this repo (step 1).

Maintainers: bump `version` in `extension/manifest.json` and `package.json`, merge, then push a tag `v<version>`; the Release workflow verifies the tag matches the manifest, runs `npm run ci`, zips `extension/dist` and publishes the release.

## How authentication works

Redmine ignores session cookies on `.json` URLs and wants an API key. The extension reads your API access key itself from your logged-in session (`/my/api_key` over XHR as the "Show" button does, falling back to the account page HTML), keeps it only in the extension's memory and sends it as `X-Redmine-API-Key` from your browser, so the protection layer still sees a normal browser request. You never create or paste a key. The key is stripped from every result and error before anything reaches the daemon or Claude, and is re-read automatically if you regenerate it.

## Troubleshooting

| Symptom                                                                              | Cause / fix                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redmine-bridge` fails to connect with `503` and a Squid error page                  | Claude Code routed the loopback HTTP request through your corporate proxy. Register the server as stdio (step 5), not as an HTTP URL.                                                                                                                                                                                                                |
| Popup says "daemon over WebSocket" or the badge is `OFF` although `install-host` ran | Chrome could not start the native host: the extension id differs from the one printed by `install-host` (load the same `extension/dist`; the id is fixed by the manifest), the browser profile directory did not exist when you ran it (start the browser once, run `install-host` again), or the repository moved. Reload the extension afterwards. |
| `NOT_CONNECTED`                                                                      | Daemon not running, extension badge not `ON`, or wrong port in the extension popup. `curl -s localhost:7399/health` tells you which.                                                                                                                                                                                                                 |
| `AUTH_REQUIRED: could not read the API access key`                                   | Your account page shows no API key: the REST API is disabled in Redmine (Administration → Settings → API) or your account may not use it. Ask a Redmine admin.                                                                                                                                                                                       |
| `AUTH_REQUIRED`                                                                      | Redmine or protection-layer session expired or you are not logged in: open Redmine in Chrome and log in. If it persists while logged in, the extension's fetch is being challenged; tell the maintainers (a content-script fetch is the possible fallback, see DESIGN.md).                                                                           |
| `FORBIDDEN_PATH`                                                                     | The endpoint is not on the allowlist in `shared/protocol.ts` (by design).                                                                                                                                                                                                                                                                            |
| `VALIDATION: ...`                                                                    | Redmine rejected the data, e.g. an invalid status for the workflow. Use `list_statuses`, `list_trackers` etc. to get valid ids.                                                                                                                                                                                                                      |
| `CSRF`                                                                               | Token rejected twice; reload the Redmine tab, log in again.                                                                                                                                                                                                                                                                                          |
| Extension changes not taking effect                                                  | After `npm run build:ext`, remove and re-add the unpacked extension (or reload it) and compare the `build` value in `curl localhost:7399/health` with the stamp in `extension/dist/worker.js`.                                                                                                                                                       |
| `EADDRINUSE` on daemon start                                                         | A daemon is already running on that port; stop it (`pkill -f "[d]aemon/src/index.ts"`) or use another `REDMINE_MCP_PORT`.                                                                                                                                                                                                                            |
| `TIMEOUT`                                                                            | Chrome asleep or worker restarting; retry. For a write tool the outcome is unknown: check in Redmine before retrying.                                                                                                                                                                                                                                |
| Tools missing                                                                        | Daemon started with `READ_ONLY=1`, or the MCP server is not approved in Claude Code (`claude mcp list`).                                                                                                                                                                                                                                             |

## Security notes

- Cookies and your API key never leave Chrome; the daemon and Claude only see Redmine API responses.
- The daemon has no token. It listens on `127.0.0.1` only, rejects any `Host` that is not loopback (DNS rebinding), rejects `/mcp` requests that carry a browser `Origin`, and only accepts the WebSocket from a `chrome-extension://` origin (pin it with `REDMINE_MCP_EXTENSION_ID`). Any process running as you on this machine can still call the tools, so use `READ_ONLY=1` if that matters.
- The extension only talks to the Redmine address you saved in the popup (https, or http for localhost; Chrome asks you to grant access to that site) and only to allowlisted endpoints. There is no delete tool.
- Issue text is untrusted input to Claude (prompt injection): keep write approval on.

## Tools

Read: `get_current_user`, `list_projects`, `list_issues`, `get_issue`, `search_issues`, `list_statuses`, `list_trackers`, `list_project_trackers`, `list_priorities`, `list_time_entry_activities`, `list_versions`, `list_project_members`.
Write: `update_issue`, `add_note`, `create_issue`, `log_time`.

Tip: a project only accepts its enabled trackers. Redmine silently falls back to the default tracker when `create_issue` gets one that is not enabled for the project. Call `list_project_trackers` first; `create_issue` returns a `warning` when the tracker differs.

## Development

`npm run ci` runs what GitHub Actions runs: typecheck, ESLint, Prettier check, tests with coverage, and the extension build. Individually: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format` (writes), `npm run format:check`, `npm run test:coverage`. A pull request needs a green CI before merging. Project conventions for Claude are in `CLAUDE.md`; a hook typechecks after every `.ts` edit.
