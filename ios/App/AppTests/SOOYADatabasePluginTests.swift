import XCTest
@testable import App

final class SOOYADatabasePluginTests: XCTestCase {
    private var temporaryDirectory: URL!
    private var applicationSupportDirectory: URL!
    private var database: SOOYADatabaseStore!

    override func setUpWithError() throws {
        try super.setUpWithError()

        temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SOOYADatabasePluginTests-\(UUID().uuidString)", isDirectory: true)
        applicationSupportDirectory = temporaryDirectory
            .appendingPathComponent("Application Support", isDirectory: true)
        database = SOOYADatabaseStore(applicationSupportDirectory: applicationSupportDirectory)
    }

    override func tearDownWithError() throws {
        try database?.close()
        if let temporaryDirectory {
            try? FileManager.default.removeItem(at: temporaryDirectory)
        }

        database = nil
        applicationSupportDirectory = nil
        temporaryDirectory = nil
        try super.tearDownWithError()
    }

    func testPluginPublishesOnlyTheNativeDatabaseContract() {
        let plugin = SOOYADatabasePlugin()

        XCTAssertEqual(
            Set(plugin.pluginMethods.map(\.name)),
            Set([
                "open", "close", "execute", "run", "query", "transaction",
                "checkpoint", "integrity", "backup", "restore", "databaseInfo"
            ])
        )
    }

    func testOpenUsesTheFixedSOOYADirectoryAndAppliesConnectionPragmas() throws {
        let info = try database.open()

        XCTAssertEqual(
            database.databaseURL.standardizedFileURL,
            applicationSupportDirectory
                .appendingPathComponent("SOOYA", isDirectory: true)
                .appendingPathComponent("sooya.sqlite3", isDirectory: false)
                .standardizedFileURL
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: database.databaseURL.path))
        XCTAssertTrue(info.isOpen)
        XCTAssertEqual(info.journalMode, "wal")
        XCTAssertTrue(info.foreignKeysEnabled)
        XCTAssertEqual(info.synchronous, "normal")
        XCTAssertEqual(info.busyTimeoutMilliseconds, 5_000)
        XCTAssertEqual(info.tempStore, "memory")
        XCTAssertGreaterThan(info.pageSize, 0)
        XCTAssertFalse(info.sqliteVersion.isEmpty)
    }

    func testOpenProbesFTS5TrigramWithoutLeavingATemporaryTable() throws {
        let info = try database.open()
        var independentlyAvailable = false

        do {
            _ = try database.execute(
                "CREATE VIRTUAL TABLE temp.manual_trigram_probe USING fts5(value, tokenize='trigram')"
            )
            independentlyAvailable = true
            _ = try database.execute("DROP TABLE temp.manual_trigram_probe")
        } catch {
            independentlyAvailable = false
        }

        XCTAssertEqual(info.fts5TrigramSupported, independentlyAvailable)
        let probeRows = try database.query(
            "SELECT name FROM sqlite_temp_master WHERE name LIKE '__sooya_fts5_trigram_probe%'"
        )
        XCTAssertTrue(probeRows.rows.isEmpty)
    }

    func testExecuteSupportsMultipleStatementsAndReportsAllChanges() throws {
        _ = try database.open()

        let result = try database.execute("""
            CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
            INSERT INTO items(label) VALUES ('one');
            INSERT INTO items(label) VALUES ('two');
            """)

        XCTAssertEqual(result.changes, 1)
        XCTAssertEqual(result.totalChanges, 2)
        XCTAssertEqual(try scalarInteger("SELECT count(*) AS value FROM items"), 2)
    }

    func testRunBindsValuesAndQueryRoundTripsSQLiteTypes() throws {
        _ = try database.open()
        _ = try database.execute("""
            CREATE TABLE values_table (
                id INTEGER PRIMARY KEY,
                text_value TEXT,
                integer_value INTEGER,
                real_value REAL,
                blob_value BLOB,
                null_value TEXT
            )
            """)

        let blob = Data([0x00, 0x7f, 0xff])
        let inserted = try database.run(
            """
            INSERT INTO values_table(text_value, integer_value, real_value, blob_value, null_value)
            VALUES (?, ?, ?, ?, ?)
            """,
            values: [.text("hello"), .integer(42), .real(1.25), .blob(blob), .null]
        )

        XCTAssertEqual(inserted.changes, 1)
        XCTAssertGreaterThan(inserted.lastInsertRowID, 0)

        let result = try database.query(
            """
            SELECT text_value, integer_value, real_value, blob_value, null_value
            FROM values_table WHERE id = ?
            """,
            values: [.integer(inserted.lastInsertRowID)]
        )

        XCTAssertEqual(
            result.columns,
            ["text_value", "integer_value", "real_value", "blob_value", "null_value"]
        )
        XCTAssertEqual(result.rows.count, 1)
        XCTAssertEqual(result.rows[0]["text_value"], .text("hello"))
        XCTAssertEqual(result.rows[0]["integer_value"], .integer(42))
        XCTAssertEqual(result.rows[0]["real_value"], .real(1.25))
        XCTAssertEqual(result.rows[0]["blob_value"], .blob(blob))
        XCTAssertEqual(result.rows[0]["null_value"], .null)
    }

    func testRunRejectsMoreThanOnePreparedStatement() throws {
        _ = try database.open()
        _ = try database.execute("CREATE TABLE guarded (value TEXT NOT NULL)")

        XCTAssertThrowsError(
            try database.run(
                "INSERT INTO guarded(value) VALUES (?); INSERT INTO guarded(value) VALUES (?)",
                values: [.text("first"), .text("second")]
            )
        )
        XCTAssertEqual(try scalarInteger("SELECT count(*) AS value FROM guarded"), 0)
    }

    func testQueryCannotMutateTheDatabase() throws {
        _ = try database.open()
        _ = try database.execute("CREATE TABLE read_only_guard (value INTEGER NOT NULL)")

        XCTAssertThrowsError(try database.query("INSERT INTO read_only_guard(value) VALUES (1)"))
        XCTAssertEqual(try scalarInteger("SELECT count(*) AS value FROM read_only_guard"), 0)
    }

    func testNativeBatchTransactionCommitsAllStatementsTogether() throws {
        _ = try database.open()
        _ = try database.execute("CREATE TABLE batch_items (id TEXT PRIMARY KEY, value INTEGER NOT NULL)")

        let result = try database.transaction([
            SOOYASQLStatement(
                sql: "INSERT INTO batch_items(id, value) VALUES (?, ?)",
                values: [.text("one"), .integer(1)]
            ),
            SOOYASQLStatement(
                sql: "INSERT INTO batch_items(id, value) VALUES (?, ?)",
                values: [.text("two"), .integer(2)]
            )
        ], mode: .immediate)

        XCTAssertEqual(result.results.map(\.changes), [1, 1])
        XCTAssertEqual(result.totalChanges, 2)
        XCTAssertEqual(try scalarInteger("SELECT count(*) AS value FROM batch_items"), 2)
    }

    func testNativeBatchTransactionRollsBackEveryStatementOnFailure() throws {
        _ = try database.open()
        _ = try database.execute("CREATE TABLE unique_items (id TEXT PRIMARY KEY)")

        XCTAssertThrowsError(
            try database.transaction([
                SOOYASQLStatement(
                    sql: "INSERT INTO unique_items(id) VALUES (?)",
                    values: [.text("duplicate")]
                ),
                SOOYASQLStatement(
                    sql: "INSERT INTO unique_items(id) VALUES (?)",
                    values: [.text("duplicate")]
                )
            ])
        )

        XCTAssertEqual(try scalarInteger("SELECT count(*) AS value FROM unique_items"), 0)
    }

    func testTransactionRejectsCallerControlledTransactionBoundaries() throws {
        _ = try database.open()

        XCTAssertThrowsError(
            try database.transaction([SOOYASQLStatement(sql: "COMMIT")])
        )
    }

    func testCheckpointAndIntegrityExposeNativeSQLiteResults() throws {
        _ = try database.open()
        _ = try database.execute("CREATE TABLE health_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        _ = try database.run(
            "INSERT INTO health_items(value) VALUES (?)",
            values: [.text("healthy")]
        )

        let checkpoint = try database.checkpoint(mode: .truncate)
        let integrity = try database.integrity()

        XCTAssertEqual(checkpoint.mode, .truncate)
        XCTAssertGreaterThanOrEqual(checkpoint.logFrames, 0)
        XCTAssertGreaterThanOrEqual(checkpoint.checkpointedFrames, 0)
        XCTAssertFalse(checkpoint.busy)
        XCTAssertTrue(integrity.ok)
        XCTAssertEqual(integrity.messages, ["ok"])
        XCTAssertEqual(integrity.foreignKeyViolations, 0)
    }

    func testBackupAndRestoreStayInsideSOOYAAndRestoreTheSnapshot() throws {
        _ = try database.open()
        _ = try database.execute("CREATE TABLE snapshots (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
        _ = try database.run(
            "INSERT INTO snapshots(value) VALUES (?)",
            values: [.text("before")]
        )

        let backup = try database.backup(named: "before-restore.sqlite3")
        XCTAssertTrue(backup.verified)
        XCTAssertEqual(backup.fileName, "before-restore.sqlite3")
        XCTAssertEqual(
            backup.fileURL.deletingLastPathComponent().standardizedFileURL,
            database.backupsDirectoryURL.standardizedFileURL
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: backup.fileURL.path))

        _ = try database.run(
            "UPDATE snapshots SET value = ? WHERE id = 1",
            values: [.text("after")]
        )
        let restored = try database.restore(named: backup.fileName)

        XCTAssertEqual(restored.fileName, backup.fileName)
        XCTAssertTrue(restored.integrity.ok)
        let rows = try database.query("SELECT value FROM snapshots WHERE id = 1")
        XCTAssertEqual(rows.rows.first?["value"], .text("before"))

        let info = try database.databaseInfo()
        XCTAssertEqual(info.journalMode, "wal")
        XCTAssertTrue(info.foreignKeysEnabled)
        XCTAssertEqual(info.synchronous, "normal")
    }

    func testBackupAndRestoreRejectPathTraversal() throws {
        _ = try database.open()

        XCTAssertThrowsError(try database.backup(named: "../outside.sqlite3"))
        XCTAssertThrowsError(try database.backup(named: "folder/outside.sqlite3"))
        XCTAssertThrowsError(try database.restore(named: "..\\outside.sqlite3"))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: applicationSupportDirectory.appendingPathComponent("outside.sqlite3").path
            )
        )
    }

    func testCloseIsIdempotentAndReopenPreservesData() throws {
        _ = try database.open()
        _ = try database.execute("CREATE TABLE persisted (value TEXT NOT NULL)")
        _ = try database.run(
            "INSERT INTO persisted(value) VALUES (?)",
            values: [.text("still here")]
        )

        try database.close()
        try database.close()
        XCTAssertThrowsError(try database.query("SELECT value FROM persisted"))

        _ = try database.open()
        let rows = try database.query("SELECT value FROM persisted")
        XCTAssertEqual(rows.rows.first?["value"], .text("still here"))
    }

    func testErrorsNeverEchoSQLThatMayContainASecret() throws {
        _ = try database.open()
        let secret = "database-secret-that-must-not-leak"

        do {
            _ = try database.execute("THIS IS INVALID SQL '\(secret)'")
            XCTFail("Expected invalid SQL to throw")
        } catch {
            XCTAssertFalse(String(describing: error).contains(secret))
            XCTAssertFalse((error as NSError).localizedDescription.contains(secret))
        }
    }

    private func scalarInteger(_ sql: String) throws -> Int64 {
        let result = try database.query(sql)
        guard case let .integer(value)? = result.rows.first?["value"] else {
            XCTFail("Expected one integer column named value")
            return -1
        }
        return value
    }
}
