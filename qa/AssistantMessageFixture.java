import java.sql.DriverManager;
import java.util.UUID;

class AssistantMessageFixture {
    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !args[1].startsWith("qa-history-")) {
            throw new IllegalArgumentException("Expected a test conversation ID and title");
        }
        String id = UUID.fromString(args[0]).toString();
        String database = env("QA_POSTGRES_URL");
        if (!database.startsWith("jdbc:postgresql://127.0.0.1:")
                && !database.startsWith("jdbc:postgresql://localhost:")) {
            throw new IllegalArgumentException("This fixture requires a local PostgreSQL test database");
        }
        try (var connection = DriverManager.getConnection(database, env("DB_USER"), env("DB_PWD"))) {
            connection.setAutoCommit(false);
            try (var lookup = connection.prepareStatement(
                    "SELECT id FROM assistant_conversation WHERE id = ? AND title = ? AND deleted_at IS NULL")) {
                lookup.setString(1, id);
                lookup.setString(2, args[1]);
                try (var rows = lookup.executeQuery()) {
                    if (!rows.next()) {
                        throw new IllegalStateException("Expected the synthetic conversation created by the HTTP probe");
                    }
                }
            }
            String first = UUID.randomUUID().toString();
            String second = UUID.randomUUID().toString();
            String parent = first.compareTo(second) < 0 ? first : second;
            String child = first.equals(parent) ? second : first;
            long now = System.currentTimeMillis();
            try (var insert = connection.prepareStatement("""
                    INSERT INTO assistant_chat_message
                        (id, conversation_id, parent_id, role, content, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """)) {
                insert.setString(1, parent);
                insert.setString(2, id);
                insert.setString(3, null);
                insert.setString(4, "user");
                insert.setString(5, "简体检索 繁體檢索 Mercury 100%");
                insert.setLong(6, now);
                insert.executeUpdate();
                insert.setString(1, child);
                insert.setString(3, parent);
                insert.setString(4, "assistant");
                insert.setString(5, "合成结果");
                insert.executeUpdate();
            }
            connection.commit();
        }
    }

    private static String env(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Missing fixture environment variable " + name);
        }
        return value;
    }
}
