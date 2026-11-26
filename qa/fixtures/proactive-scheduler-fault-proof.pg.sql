-- Read-only witness for the dedicated two-account scheduler fault fixture.
\set ON_ERROR_STOP on
SELECT json_build_object(
    'badAttempts', (SELECT CASE WHEN is_called THEN last_value ELSE 0 END
        FROM qa_proactive_fault_rejections),
    'badSuggestions', (SELECT COUNT(*) FROM assistant_proactive_suggestion
        WHERE account_id = :'bad_account' AND workspace_id = :'bad_workspace'),
    'healthySuggestions', (SELECT COUNT(*) FROM assistant_proactive_suggestion
        WHERE account_id = :'healthy_account' AND workspace_id = :'healthy_workspace'),
    'boundedBackoff', (SELECT next_check_at > (extract(epoch FROM clock_timestamp()) * 1000)::bigint + 20000
        FROM assistant_proactive_preference
        WHERE account_id = :'bad_account' AND workspace_id = :'bad_workspace')
);
