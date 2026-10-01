#!/usr/bin/env bash
#
# Chorus log gate (Phase 0).
#
# Fails when a console.* or logger.* call has a string literal containing a
# sensitive keyword. Secrets must never reach logs, events, or the WS stream,
# and this gate is the mechanical check that keeps new call sites honest.
#
# Usage: bash scripts/check-log-gate.sh
# Exit:  0 = clean, 1 = violations found, 2 = gate could not run.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGETS=("$ROOT/apps" "$ROOT/packages")

CALL_PATTERN='(console\.(log|info|warn|error|debug|trace)|logger\.(log|info|warn|error|debug|trace))'
SECRET_PATTERN='(token|password|passwd|secret|api[_-]?key|key=|authorization|bearer)'

if command -v rg >/dev/null 2>&1; then
  scan() {
    rg --no-heading --line-number --color never \
      --glob '*.ts' --glob '*.tsx' \
      --glob '!**/*.test.ts' --glob '!**/*.test.tsx' \
      --glob '!**/*.d.ts' \
      --pcre2 \
      "$CALL_PATTERN" "${TARGETS[@]}" 2>/dev/null | grep -Ei "$SECRET_PATTERN" || true
  }
else
  scan() {
    grep -rnE "$CALL_PATTERN" \
      --include='*.ts' --include='*.tsx' \
      --exclude='*.test.ts' --exclude='*.test.tsx' \
      --exclude='*.d.ts' \
      "${TARGETS[@]}" 2>/dev/null | grep -Ei "$SECRET_PATTERN" || true
  }
fi

HITS="$(scan)"

if [ -z "$HITS" ]; then
  echo "log-gate: ok (no sensitive keywords in log/console string literals)"
  exit 0
fi

COUNT="$(printf '%s\n' "$HITS" | wc -l | tr -d ' ')"
{
  echo "log-gate: FAILED — ${COUNT} log/console call site(s) mention a sensitive keyword."
  echo
  echo "Never log tokens, passwords, secrets, or API keys. Log a boolean"
  echo "'hasToken' or a redacted fingerprint instead."
  echo
  printf '%s\n' "$HITS" | sed 's/^/  /'
} >&2

exit 1
