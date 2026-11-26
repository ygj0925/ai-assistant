#!/usr/bin/env bash
set -euo pipefail

# Use PostgreSQL 16+ with an empty, dedicated synthetic assistant database.
[[ ${PGDATABASE:-} =~ ^assistant_[a-z0-9_]*moderation_lock_[a-z0-9_]+$ ]]
[[ ${PGHOST:-} = 127.0.0.1 || ${PGHOST:-} = /* ]]
[[ $# = 1 ]]
folder=$(cd "$1" && pwd)
[[ $folder =~ ^/[A-Za-z0-9._/-]+$ ]]
[[ ! -e "$folder/reporter-session-locked" && ! -e "$folder/commit-revocation" ]]
psql=${ASSISTANT_QA_PSQL:-psql}
pg_options=(-X -qAt -v ON_ERROR_STOP=1)

wait_for_marker() {
  for (( attempt=0; attempt<250; attempt++ )); do
    if [[ -f "$folder/$1" ]]; then return; fi
    sleep .1
  done
  return 1
}

wait_for_marker reporter-ready
coordinates=$(python3 - "$folder/reporter-ready" <<'PY'
import json
import sys
from uuid import UUID

with open(sys.argv[1], encoding='utf-8') as stream:
    ready = json.load(stream)
print(*(str(UUID(ready[key])) for key in ('reporterAccountId', 'workspaceId', 'shareId')))
PY
)
read -r account workspace share <<< "$coordinates"

"$psql" "${pg_options[@]}" <<SQL &
BEGIN;
SET LOCAL application_name = 'assistant QA session revoker';
SELECT id AS fixture_session FROM assistant_session WHERE account_id = '$account' FOR UPDATE
\gset
\! touch '$folder/reporter-session-locked' && timeout 28s bash -c 'until test -f "\$1"; do sleep .1; done' _ '$folder/commit-revocation'
\if :SHELL_ERROR
ROLLBACK;
\quit
\endif
DELETE FROM assistant_session WHERE account_id = '$account' AND id = :'fixture_session';
COMMIT;
SQL
blocker_pid=$!
trap 'kill "$blocker_pid" 2>/dev/null || true' EXIT
wait_for_marker reporter-session-locked

observed=false
for (( attempt=0; attempt<200; attempt++ )); do
  blocked=$("$psql" "${pg_options[@]}" -c "
    SELECT count(*) FROM pg_stat_activity waiter
     WHERE waiter.datname = current_database() AND waiter.wait_event_type = 'Lock'
       AND waiter.query LIKE '%FROM assistant_session s%' AND waiter.query LIKE '%FOR UPDATE%'
       AND EXISTS (SELECT 1 FROM pg_stat_activity blocker
                   WHERE blocker.application_name = 'assistant QA session revoker'
                     AND blocker.pid = ANY(pg_blocking_pids(waiter.pid)))")
  if [[ "$blocked" == 1 ]]; then observed=true; break; fi
  sleep .1
done
[[ $observed == true ]]
touch "$folder/commit-revocation"
wait "$blocker_pid"
trap - EXIT
wait_for_marker revoked-report-denied

remaining_sessions=$("$psql" "${pg_options[@]}" -c "SELECT count(*) FROM assistant_session WHERE account_id = '$account'")
stale_receipts=$("$psql" "${pg_options[@]}" -c "SELECT count(*) FROM assistant_content_report
  WHERE workspace_id = '$workspace' AND reporter_account_id = '$account' AND target_type = 'shared_reply' AND target_id = '$share'")
[[ $remaining_sessions == 0 && $stale_receipts == 0 ]]
touch "$folder/denial-count-verified"
printf '%s\n' 'PostgreSQL observed report admission wait on the exact old device row; session removed and stale receipt count 0.'
