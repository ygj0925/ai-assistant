import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import liquibase.Contexts;
import liquibase.LabelExpression;
import liquibase.Liquibase;
import liquibase.database.jvm.JdbcConnection;
import liquibase.resource.ClassLoaderResourceAccessor;

class ContiNewMigrationProbe {
    private static final String CHANGELOG = "db/changelog/db.changelog-postgresql.yaml";

    public static void main(String[] args) throws Exception {
        try (Connection connection = DriverManager.getConnection(
                variable("QA_POSTGRES_URL"), variable("DB_USER"), variable("DB_PWD"));
                Liquibase liquibase = new Liquibase(
                        CHANGELOG, new ClassLoaderResourceAccessor(), new JdbcConnection(connection))) {
            expect(scalar(connection,
                    "SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema()") == 0,
                    "Use an empty, dedicated PostgreSQL database for this probe");
            expect(scalar(connection, "SELECT count(*) FROM pg_roles WHERE rolname = current_user AND rolsuper") == 0,
                    "The application test database role must not be a cluster superuser");

            Contexts contexts = new Contexts();
            LabelExpression labels = new LabelExpression();
            liquibase.update(1, contexts, labels);
            int beforeUpgrade = scalar(connection, "SELECT count(*) FROM databasechangelog");
            expect(beforeUpgrade == 1, "Expected the first changeset to be recorded");

            liquibase.update(contexts, labels);
            int afterUpgrade = scalar(connection, "SELECT count(*) FROM databasechangelog");
            expect(afterUpgrade > beforeUpgrade, "Expected an incremental upgrade");
            expect(scalar(connection, "SELECT count(*) FROM sys_user WHERE username = 'admin'") == 1,
                    "Expected exactly one seeded administrator");

            liquibase.update(contexts, labels);
            expect(scalar(connection, "SELECT count(*) FROM databasechangelog") == afterUpgrade,
                    "An already applied release must leave the changeset history unchanged");
            System.out.printf("PostgreSQL migration passed: %d -> %d -> %d changesets%n",
                    beforeUpgrade, afterUpgrade, afterUpgrade);
        }
    }

    private static int scalar(Connection connection, String sql) throws SQLException {
        try (var statement = connection.createStatement(); var rows = statement.executeQuery(sql)) {
            if (!rows.next()) {
                throw new SQLException("Migration probe expected one row");
            }
            return rows.getInt(1);
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
