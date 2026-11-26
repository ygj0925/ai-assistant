#!/usr/bin/env bash
set -euo pipefail

# Dedicated PostgreSQL fixture. Only its synthetic binding row is locked.
[[ ${PGDATABASE:-} =~ ^assistant_[a-z0-9_]*scim_[0-9]+$ ]]
[[ ${PGHOST:-} = 127.0.0.1 || ${PGHOST:-} = /* ]]
[[ $# = 1 ]]
folder=$(cd "$1" && pwd)
[[ $folder =~ ^/[A-Za-z0-9._/-]+$ ]]
[[ ! -e "$folder/account-binding-locked" && ! -e "$folder/account-hold-read-denied" ]]
psql=${ASSISTANT_QA_PSQL:-psql}
opts=(-X -qAt -v ON_ERROR_STOP=1)

wait_for_marker() {
  for (( attempt=0; attempt<$2; attempt++ )); do
    if [[ -f "$folder/$1" ]]; then return; fi
    sleep .1
  done
  return 1
}

wait_for_marker account-hold-ready 1200
binding=$(python3 - "$folder/account-hold-ready" <<'PY'
import json
import sys
from uuid import UUID

with open(sys.argv[1], encoding='utf-8') as source:
    print(UUID(json.load(source)['bindingId']))
PY
)

"$psql" "${opts[@]}" <<SQL &
BEGIN;
SET LOCAL application_name = 'assistant QA directory erasure gate';
SELECT id FROM assistant_organization_directory_user WHERE id = '$binding' FOR UPDATE
\gset
\! touch '$folder/account-binding-locked' && timeout 10s bash -c 'until test -f "\$1"; do sleep .1; done' _ '$folder/account-hold-read-denied'
\if :SHELL_ERROR
ROLLBACK;
\quit
\endif
COMMIT;
SQL
gate=$!
trap 'kill "$gate" 2>/dev/null || true' EXIT
wait_for_marker account-binding-locked 80

seen=false
for (( attempt=0; attempt<60; attempt++ )); do
  waiting=$("$psql" "${opts[@]}" -c "
    SELECT count(*) FROM pg_stat_activity waiter
     WHERE waiter.datname = current_database() AND waiter.wait_event_type = 'Lock'
       AND waiter.query LIKE 'DELETE FROM assistant_organization_directory_user%'
       AND EXISTS (SELECT 1 FROM pg_stat_activity blocker
                   WHERE blocker.application_name = 'assistant QA directory erasure gate'
                     AND blocker.pid = ANY(pg_blocking_pids(waiter.pid)))")
  if [[ "$waiting" == 1 ]]; then seen=true; break; fi
  sleep .1
done
[[ $seen == true ]]
touch "$folder/account-erasure-waiting"
wait_for_marker account-hold-read-denied 50
wait "$gate"
trap - EXIT
printf '%s\n' 'The exact account erasure waited on a live directory binding row; pending SCIM GET was denied before the database write committed.'
