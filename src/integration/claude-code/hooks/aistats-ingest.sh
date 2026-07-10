#!/bin/sh
# aistats-ingest.sh — Claude Code live-trigger shim for aistats (DESIGN.md §3.1/§13).
#
# Wired to the `Stop` and `SessionEnd` hook events in ~/.claude/settings.json (see
# `aistats install --claude-code` for the exact hooks snippet to add). Reads the hook
# event JSON from stdin, finds the transcript this hook fired for, and kicks off an
# incremental `aistats ingest` in a detached background process so the local store
# stays warm without ever slowing down the tool loop. All logic lives in the CLI —
# this shim only decides which `ingest` flavor to run and detaches it.
#
# Must never block: always exits 0 immediately; the real work happens in the
# background after this script has already returned control to Claude Code.

command -v aistats >/dev/null 2>&1 || exit 0

input="$(cat 2>/dev/null || true)"

if command -v jq >/dev/null 2>&1; then
  transcript="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)"
else
  # Portable fallback when jq isn't installed: pull the first "transcript_path":"..."
  # value out of the (single-line) JSON without a real parser.
  transcript="$(printf '%s' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi

# Detach so the ingest keeps running (and can't be killed) once this hook process
# exits. `setsid` is Linux-only, so fall back to plain backgrounding elsewhere.
run_detached() {
  if command -v setsid >/dev/null 2>&1; then
    ( setsid "$@" >/dev/null 2>&1 & ) 2>/dev/null
  else
    ( "$@" >/dev/null 2>&1 & ) 2>/dev/null
  fi
}

case "$transcript" in
  # A subagent's own transcript (or no transcript at all) can't be resolved by
  # `--session <path>` — fall back to a plain incremental `--tool cc` ingest.
  */subagents/*|"")
    run_detached aistats ingest --tool cc
    ;;
  *)
    run_detached aistats ingest --session "$transcript"
    ;;
esac

exit 0
