#!/usr/bin/env bash
# PostToolUse hook: typecheck after a .ts edit; exit 2 feeds errors back to Claude.
file=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$file" in *.ts) ;; *) exit 0 ;; esac
cd "$CLAUDE_PROJECT_DIR" || exit 0
out=$(npx tsc --noEmit 2>&1) && exit 0
echo "$out" | head -20 >&2
exit 2
