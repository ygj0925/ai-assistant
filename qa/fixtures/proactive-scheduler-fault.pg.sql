-- Run only against a new, otherwise empty synthetic fault-test database.
-- psql variables are taken from the fixture-ready marker after both test users opted in silently.
\set ON_ERROR_STOP on
BEGIN;
DO $guard$
BEGIN
    IF current_database() !~ '^assistant_proactive_fault_qa_[a-f0-9]+$' THEN
        RAISE EXCEPTION 'Use a new dedicated proactive scheduler fault fixture database';
    END IF;
END;
$guard$;
SELECT EXISTS(
    SELECT 1 FROM assistant_proactive_preference p
    JOIN assistant_account a ON a.id = p.account_id
    JOIN assistant_workspace w ON w.id = p.workspace_id AND w.personal_owner_id = a.id
    WHERE p.account_id = :'bad_account' AND p.workspace_id = :'bad_workspace'
      AND a.username LIKE 'qa-proactive-fault-%' AND a.deleted_at IS NULL
      AND p.enabled AND p.role = 'schedule_planner' AND p.notification = 'silent'
      AND p.next_check_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM assistant_reminder r WHERE r.account_id = p.account_id AND r.workspace_id = p.workspace_id
      )
) AND EXISTS(
    SELECT 1 FROM assistant_proactive_preference p
    JOIN assistant_account a ON a.id = p.account_id
    JOIN assistant_workspace w ON w.id = p.workspace_id AND w.personal_owner_id = a.id
    WHERE p.account_id = :'healthy_account' AND p.workspace_id = :'healthy_workspace'
      AND a.username LIKE 'qa-proactive-healthy-%' AND a.deleted_at IS NULL
      AND p.enabled AND p.role = 'schedule_planner' AND p.notification = 'silent'
      AND p.next_check_at IS NULL AND EXISTS (
          SELECT 1 FROM assistant_reminder r WHERE r.account_id = p.account_id AND r.workspace_id = p.workspace_id
              AND r.status = 'active' AND r.next_wake_at > (extract(epoch FROM clock_timestamp()) * 1000)::bigint
      )
) AS qa_scopes_verified \gset
\if :qa_scopes_verified
\else
DO $guard$
BEGIN
    RAISE EXCEPTION 'The two synthetic scheduler scopes do not match the prepared fixtures';
END;
$guard$;
\endif

CREATE SEQUENCE qa_proactive_fault_rejections;
CREATE FUNCTION qa_proactive_reject_due_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fixture$
BEGIN
    IF OLD.account_id = TG_ARGV[0] AND OLD.workspace_id = TG_ARGV[1]
        AND OLD.enabled AND NEW.enabled AND OLD.notification = 'in_app' AND NEW.notification = 'in_app'
        AND NEW.next_check_at > OLD.next_check_at
        AND NEW.next_check_at < (extract(epoch FROM clock_timestamp()) * 1000)::bigint + 50000 THEN
        PERFORM nextval('public.qa_proactive_fault_rejections');
        RAISE EXCEPTION USING ERRCODE = '22000', MESSAGE = 'Synthetic local scheduler write rejected';
    END IF;
    RETURN NEW;
END;
$fixture$;

CREATE TRIGGER qa_proactive_fault
BEFORE UPDATE OF next_check_at ON assistant_proactive_preference
FOR EACH ROW EXECUTE FUNCTION qa_proactive_reject_due_update(:'bad_account', :'bad_workspace');

WITH stamp(now_ms) AS (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
UPDATE assistant_proactive_preference p
SET notification = 'in_app',
    next_check_at = stamp.now_ms - CASE WHEN p.account_id = :'bad_account' THEN 2 ELSE 1 END
FROM stamp
WHERE (p.account_id = :'bad_account' AND p.workspace_id = :'bad_workspace')
   OR (p.account_id = :'healthy_account' AND p.workspace_id = :'healthy_workspace');
COMMIT;
