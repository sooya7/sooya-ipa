from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}\n--- OLD ---\n{old[:500]}")
    file.write_text(text.replace(old, new, 1))


# SQLite reports bare PRAGMA journal_mode as sqlite3_stmt_readonly == 0 even when
# it is only being used to read the current mode. Keep the public query() guard
# strict and isolate this one trusted literal inside databaseInfoLocked.
path = "ios/App/App/Plugins/SOOYADatabasePlugin.swift"
replace_once(
    path,
    '            journalMode: try scalarTextLocked(connection, sql: "PRAGMA journal_mode").lowercased(),\n',
    '            journalMode: try journalModeLocked(connection),\n'
)
replace_once(
    path,
    '''    private func scalarTextLocked(_ connection: OpaquePointer, sql: String) throws -> String {\n        let result = try queryLocked(connection, sql: sql, values: [], requireReadOnly: true)\n        guard let value = result.rows.first?.values.first,\n              case let .text(text) = value else {\n            throw SOOYADatabaseError.configurationFailed\n        }\n        return text\n    }\n''',
    '''    private func journalModeLocked(_ connection: OpaquePointer) throws -> String {\n        // SQLite intentionally reports bare PRAGMA journal_mode as not read-only.\n        // This is a fixed internal literal used only to inspect the mode after we\n        // have explicitly configured WAL above. Never expose this bypass to query().\n        let result = try queryLocked(\n            connection,\n            sql: "PRAGMA journal_mode",\n            values: [],\n            requireReadOnly: false\n        )\n        guard let value = result.rows.first?.values.first,\n              case let .text(text) = value else {\n            throw SOOYADatabaseError.configurationFailed\n        }\n        return text.lowercased()\n    }\n\n    private func scalarTextLocked(_ connection: OpaquePointer, sql: String) throws -> String {\n        let result = try queryLocked(connection, sql: sql, values: [], requireReadOnly: true)\n        guard let value = result.rows.first?.values.first,\n              case let .text(text) = value else {\n            throw SOOYADatabaseError.configurationFailed\n        }\n        return text\n    }\n'''
)

# Web CI already reads the Swift source for cross-bridge contract checks. Add a
# regression test so a future refactor cannot route databaseInfo through the
# public read-only guard again or weaken query() globally.
path = "packages/web/src/local/nativeDatabaseContract.test.ts"
replace_once(
    path,
    '''  it('query envelope and row values are normalized by the web adapter', async () => {\n''',
    '''  it('keeps public queries read-only while allowing the trusted journal-mode inspection', () => {\n    const swift = readFileSync(path.resolve('../../ios/App/App/Plugins/SOOYADatabasePlugin.swift'), 'utf8');\n    expect(swift).toContain('return try queryLocked(connection, sql: sql, values: values, requireReadOnly: true)');\n    expect(swift).toContain('journalMode: try journalModeLocked(connection)');\n    expect(swift).toContain('sql: "PRAGMA journal_mode"');\n    expect(swift).toContain('requireReadOnly: false');\n  });\n\n  it('query envelope and row values are normalized by the web adapter', async () => {\n'''
)

# Native code changed, so Base 7 cannot receive this fix through OTA. Ship a new
# Base 8 binary while keeping the JS bridge contract version at 4.
replace_once(
    "ios/App/App/Plugins/SOOYAReleaseConfig.swift",
    "    static let nativeBaseVersion = 7\n",
    "    static let nativeBaseVersion = 8\n"
)
Path("ios/App/App/native-base.version").write_text("8\n")
replace_once(
    ".github/workflows/ota.yml",
    "            --native-min 7 --native-max 7\n",
    "            --native-min 8 --native-max 8\n"
)
