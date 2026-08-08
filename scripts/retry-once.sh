#!/usr/bin/env bash
# Retry a harness QA command once on failure, so a transient flake (network
# blip, external feed fetch, Convex cold start) can't red the nightly gate
# on its own.
#
#   Usage: bash scripts/retry-once.sh <log-file> <command...>
#
# - Attempt 1 output is tee'd to <log-file> (truncated); a retry appends,
#   so the uploaded artifact shows both attempts.
# - Only "checks failed" exits (code 1) are retried. Harness
#   misconfiguration (code 2 — missing secret / harness disabled) is
#   deterministic and never retried. A genuine regression still fails —
#   after the retry — and still triggers the job's alert step.
# - RETRY_DELAY (seconds, default 20) controls the pause between attempts.
#
# Note: the pipeline's status must be captured as a plain statement — `$?`
# after an `if pipeline` reflects the if statement, not the pipeline.
set -uo pipefail

log=$1
shift

delay="${RETRY_DELAY:-20}"

: > "$log"

for attempt in 1 2; do
  "$@" 2>&1 | tee -a "$log"
  status=$?
  if [ "$status" -eq 0 ]; then
    if [ "$attempt" -gt 1 ]; then
      echo "::warning::$* recovered on retry (attempt $attempt) — transient flake."
    fi
    exit 0
  fi
  if [ "$status" -ne 1 ] || [ "$attempt" -ge 2 ]; then
    exit "$status"
  fi
  echo "::warning::$* failed with exit $status on attempt 1 — retrying once in ${delay}s."
  sleep "$delay"
done

# Unreachable: the loop always exits on or before attempt 2. Kept so a
# logic mistake fails loudly instead of passing silently.
exit 1
