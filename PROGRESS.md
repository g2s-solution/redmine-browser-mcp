# Progress

Last updated 2026-10-22. Design: [PLAN.md](PLAN.md). Usage: [README.md](README.md).

## Status: working end to end on the real site

- Daemon, extension, 16 MCP tools, docs and tests are done. 93 tests pass, `npm run typecheck` is clean.
- Verified on a real Redmine 6 instance behind a protection layer: `get_current_user`, `list_issues`, `list_projects` (29 projects), `create_issue` (issue #263 in project Support) and `update_issue`.
- Not yet verified on the real site: `add_note`, `log_time`, `search_issues`, `get_issue` with journals, `list_project_members`, `list_versions`; a long soak of the MV3 worker; a session expiry on the real protection layer.

## Milestones
- [x] Scaffold, daemon, extension, tests, README
- [x] Remove the daemon token (Host/Origin checks instead)
- [x] Phase 0 on the real site: session cookie alone is rejected on `.json`; extension now reads the API key itself (Redmine 6 loads it via XHR)
- [x] Read and write verified on the real site
- [ ] Verify the remaining tools on a scratch issue
- [ ] Put the repo in git on the internal GitLab and share with teammates (open a merge request; do not commit to the default branch)
- [ ] Optional: systemd user unit for the daemon, `.claude/settings.json` cleanup (stale deny rule for `~/.config/redmine-mcp`)

## Log (newest last)
- Built the scaffold, daemon, extension and 70 tests; two real bugs found by tests (WebSocket error recursion, CSRF double-422).
- Added member README, `CLAUDE.md`, `.claude/settings.json` (permissions plus typecheck hook), `.mcp.json`.
- Removed the daemon token; added Host/Origin checks, connection logging, a build stamp in `/health`.
- Real site: `.json` with cookie only gives `401 Basic realm="Redmine API"`. Implemented the in-memory API key; scrubbed it from all output; removed `/my/account` from the daemon allowlist; 80 tests.
- Real site: the account page leaves the key out, `/my/api_key` over XHR returns it; reordered retrieval; smoke OK.
- Toolbar popup: the Redmine address and port are entered in the extension popup (replaces the options page); other origins are granted via a Chrome permission prompt. Unit tests for address parsing; 93 tests. Not yet tried in Chrome.
- Created issue #263 (Support). The tracker silently fell back to the default because Support enables only `AILAB - *` trackers; fixed it with `update_issue`. Added `list_project_trackers`, `tracker_id` on `update_issue` and a `create_issue` warning; 82 tests.

## Operational notes
- Run `npm run daemon` in one terminal; after changing extension code run `npm run build:ext` and reload the extension (`/health` shows the build stamp so you can check which build is connected). Port 7399 busy means a daemon is already running.
- `scripts/smoke.ts` prints user data on success; do not paste its output into a shared place.
