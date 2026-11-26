import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;

class AssistantRunLedgerProbe {
    public static void main(String[] args) throws SQLException {
        try (Connection connection = DriverManager.getConnection(
                variable("QA_POSTGRES_URL"), variable("DB_USER"), variable("DB_PWD"))) {
            connection.setReadOnly(true);
            connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            connection.setAutoCommit(false);
            expect(scalar(connection, """
                    SELECT count(*) WHERE current_database() = 'assistant_m1_runs'
                    """) == 1, "Use the isolated assistant_m1_runs smoke-test database");
            long runs = scalar(connection, "SELECT count(*) FROM assistant_run");
            expect(runs >= 9, "Execute the standard HTTP run smoke first");
            expect(scalar(connection, """
                    SELECT count(*) FROM assistant_run r LEFT JOIN assistant_run_charge c ON c.run_id = r.id
                    WHERE r.state IN ('queued', 'running') OR c.settled_units IS NULL
                        OR c.settled_units <> char_length(r.content)
                    """) == 0, "Every finished run must settle its output exactly once");
            expect(scalar(connection, """
                    SELECT count(*) FROM assistant_run r
                    WHERE (SELECT count(*) FROM assistant_run_event e
                           WHERE e.run_id = r.id AND e.type IN ('run.completed', 'run.cancelled', 'run.failed')) <> 1
                       OR NOT EXISTS (SELECT 1 FROM assistant_run_event e
                           WHERE e.run_id = r.id AND e.sequence = r.last_sequence AND e.type = 'run.' || r.state)
                    """) == 0, "Every standard-retention run must have exactly one matching terminal event");
            expect(scalar(connection, """
                    SELECT count(*) FROM assistant_usage_account a
                    WHERE a.reserved_units <> 0 OR a.used_units <> COALESCE((
                        SELECT sum(c.settled_units) FROM assistant_run_charge c WHERE c.account_id = a.account_id), 0)
                    """) == 0, "Terminal runs must release reservations and reconcile account totals");
            long cancelled = scalar(connection, "SELECT count(*) FROM assistant_run WHERE state = 'cancelled'");
            expect(cancelled >= 2, "Exercise active and conversation deletion cancellation");
            long afterDeletion = scalar(connection, """
                    SELECT count(*) FROM assistant_run r
                        JOIN assistant_conversation c ON c.id = r.conversation_id
                        JOIN assistant_chat_message m ON m.id = r.prompt_message_id
                    WHERE c.deleted_at IS NOT NULL AND m.content LIKE '生成中删除会话%'
                        AND r.state = 'cancelled' AND r.response_message_id IS NULL
                    """);
            expect(afterDeletion >= 1, "An active deleted conversation must not receive a published reply");
            System.out.printf("{\"suite\":\"assistant-run-ledger\",\"status\":\"passed\","
                    + "\"runs\":%d,\"cancelled\":%d,\"cancelledAfterDeletion\":%d}%n", runs, cancelled, afterDeletion);
        }
    }

    private static long scalar(Connection connection, String sql) throws SQLException {
        try (var statement = connection.createStatement(); var rows = statement.executeQuery(sql)) {
            if (!rows.next()) {
                throw new SQLException("Ledger probe expected one row");
            }
            return rows.getLong(1);
        }
    }

    private static String variable(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Environment variable required: " + name);
        }
        return value;
    }

    private static void expect(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }
}
