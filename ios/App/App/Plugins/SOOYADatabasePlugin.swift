import Capacitor
import Foundation
import SQLite3
import CryptoKit

private let sooyaSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private final class SOOYASQLiteAuthorizationContext {
    var allowsTransactionControl = false
}

private let sooyaSQLiteAuthorizer: @convention(c) (
    UnsafeMutableRawPointer?,
    Int32,
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?
) -> Int32 = { contextPointer, action, _, _, _, _ in
    if action == SQLITE_ATTACH || action == SQLITE_DETACH {
        return SQLITE_DENY
    }

    guard let contextPointer else {
        return SQLITE_DENY
    }
    let context = Unmanaged<SOOYASQLiteAuthorizationContext>
        .fromOpaque(contextPointer)
        .takeUnretainedValue()
    if !context.allowsTransactionControl,
       action == SQLITE_TRANSACTION || action == SQLITE_SAVEPOINT {
        return SQLITE_DENY
    }
    return SQLITE_OK
}

enum SOOYASQLValue: Equatable {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob(Data)

    init(bridgeValue: Any) throws {
        if bridgeValue is NSNull {
            self = .null
            return
        }
        if let value = bridgeValue as? String {
            self = .text(value)
            return
        }
        if let value = bridgeValue as? Bool {
            self = .integer(value ? 1 : 0)
            return
        }
        if let value = bridgeValue as? NSNumber {
            if CFGetTypeID(value) == CFBooleanGetTypeID() {
                self = .integer(value.boolValue ? 1 : 0)
                return
            }
            if CFNumberIsFloatType(value) {
                let doubleValue = value.doubleValue
                guard doubleValue.isFinite else {
                    throw SOOYADatabaseError.invalidRequest
                }
                self = .real(doubleValue)
            } else {
                self = .integer(value.int64Value)
            }
            return
        }
        if let value = bridgeValue as? [String: Any],
           value["type"] as? String == "int64",
           let encoded = value["value"] as? String,
           let integer = Int64(encoded) {
            self = .integer(integer)
            return
        }
        if let value = bridgeValue as? [String: Any],
           value["type"] as? String == "blob",
           let encoded = value["base64"] as? String,
           let data = Data(base64Encoded: encoded) {
            self = .blob(data)
            return
        }
        if let value = bridgeValue as? NSDictionary,
           value["type"] as? String == "int64",
           let encoded = value["value"] as? String,
           let integer = Int64(encoded) {
            self = .integer(integer)
            return
        }
        if let value = bridgeValue as? NSDictionary,
           value["type"] as? String == "blob",
           let encoded = value["base64"] as? String,
           let data = Data(base64Encoded: encoded) {
            self = .blob(data)
            return
        }
        throw SOOYADatabaseError.invalidRequest
    }

    var bridgeValue: Any {
        switch self {
        case .null:
            return NSNull()
        case let .integer(value):
            if value > 9_007_199_254_740_991 || value < -9_007_199_254_740_991 {
                return ["type": "int64", "value": String(value)]
            }
            return NSNumber(value: value)
        case let .real(value):
            return NSNumber(value: value)
        case let .text(value):
            return value
        case let .blob(value):
            return ["type": "blob", "base64": value.base64EncodedString()]
        }
    }
}

struct SOOYASQLStatement {
    let type: String
    let sql: String
    let values: [SOOYASQLValue]

    init(type: String = "run", sql: String, values: [SOOYASQLValue] = []) {
        self.type = type
        self.sql = sql
        self.values = values
    }
}

struct SOOYAExecuteResult {
    let changes: Int64
    let totalChanges: Int64
}

struct SOOYARunResult {
    let changes: Int64
    let lastInsertRowID: Int64
}

struct SOOYAQueryResult {
    let columns: [String]
    let rows: [[String: SOOYASQLValue]]
}

enum SOOYATransactionMode: String {
    case deferred
    case immediate
    case exclusive

    var beginSQL: String {
        "BEGIN \(rawValue.uppercased()) TRANSACTION"
    }
}

struct SOOYATransactionResult {
    let results: [Any]
    let totalChanges: Int64
}

enum SOOYACheckpointMode: String, Equatable {
    case passive
    case full
    case restart
    case truncate

    var sqliteValue: Int32 {
        switch self {
        case .passive: return SQLITE_CHECKPOINT_PASSIVE
        case .full: return SQLITE_CHECKPOINT_FULL
        case .restart: return SQLITE_CHECKPOINT_RESTART
        case .truncate: return SQLITE_CHECKPOINT_TRUNCATE
        }
    }
}

struct SOOYACheckpointResult {
    let mode: SOOYACheckpointMode
    let busy: Bool
    let logFrames: Int32
    let checkpointedFrames: Int32
}

struct SOOYAIntegrityResult {
    let ok: Bool
    let messages: [String]
    let foreignKeyViolations: Int
}

struct SOOYADatabaseInfo {
    let isOpen: Bool
    let fileName: String
    let sizeBytes: Int64
    let walSizeBytes: Int64
    let pageSize: Int64
    let pageCount: Int64
    let userVersion: Int64
    let journalMode: String
    let foreignKeysEnabled: Bool
    let synchronous: String
    let busyTimeoutMilliseconds: Int32
    let tempStore: String
    let sqliteVersion: String
    let fts5TrigramSupported: Bool
}

struct SOOYABackupInfo {
    let fileName: String
    let fileURL: URL
    let sizeBytes: Int64
    let verified: Bool
    let createdAt: Date
}

struct SOOYARestoreInfo {
    let fileName: String
    let preRestoreBackupFileName: String
    let integrity: SOOYAIntegrityResult
    let databaseInfo: SOOYADatabaseInfo
}

enum SOOYADatabaseError: Error, LocalizedError, CustomStringConvertible {
    case unavailable
    case notOpen
    case invalidRequest
    case invalidBackupName
    case backupAlreadyExists
    case backupNotFound
    case invalidBackup
    case queryMustBeReadOnly
    case multipleStatements
    case parameterCountMismatch
    case sqlite(operation: String, code: Int32)
    case fileSystem(operation: String)
    case configurationFailed
    case restoreFailed
    case restoreRollbackFailed

    var bridgeCode: String {
        switch self {
        case .unavailable: return "DB_UNAVAILABLE"
        case .notOpen: return "DB_NOT_OPEN"
        case .invalidRequest: return "DB_INVALID_REQUEST"
        case .invalidBackupName: return "DB_INVALID_BACKUP_NAME"
        case .backupAlreadyExists: return "DB_BACKUP_EXISTS"
        case .backupNotFound: return "DB_BACKUP_NOT_FOUND"
        case .invalidBackup: return "DB_INVALID_BACKUP"
        case .queryMustBeReadOnly: return "DB_QUERY_NOT_READ_ONLY"
        case .multipleStatements: return "DB_MULTIPLE_STATEMENTS"
        case .parameterCountMismatch: return "DB_PARAMETER_COUNT"
        case .sqlite: return "DB_SQLITE_ERROR"
        case .fileSystem: return "DB_FILE_ERROR"
        case .configurationFailed: return "DB_CONFIGURATION_ERROR"
        case .restoreFailed: return "DB_RESTORE_FAILED"
        case .restoreRollbackFailed: return "DB_RESTORE_ROLLBACK_FAILED"
        }
    }

    var errorDescription: String? { safeMessage }
    var description: String { safeMessage }

    private var safeMessage: String {
        switch self {
        case .unavailable:
            return "Native database storage is unavailable."
        case .notOpen:
            return "Native database is not open."
        case .invalidRequest:
            return "Invalid native database request."
        case .invalidBackupName:
            return "Invalid database backup name."
        case .backupAlreadyExists:
            return "Database backup already exists."
        case .backupNotFound:
            return "Database backup was not found."
        case .invalidBackup:
            return "Database backup failed verification."
        case .queryMustBeReadOnly:
            return "Database query must be read-only."
        case .multipleStatements:
            return "Only one prepared statement is allowed."
        case .parameterCountMismatch:
            return "Database parameter count does not match."
        case let .sqlite(operation, code):
            return "Native database \(operation) failed (SQLite code \(code))."
        case let .fileSystem(operation):
            return "Native database \(operation) failed."
        case .configurationFailed:
            return "Native database connection configuration failed."
        case .restoreFailed:
            return "Native database restore failed; the previous database was recovered."
        case .restoreRollbackFailed:
            return "Native database restore and recovery failed."
        }
    }
}

final class SOOYADatabaseStore {
    static let directoryName = "SOOYA"
    static let databaseFileName = "sooya.sqlite3"
    static let backupsDirectoryName = "backups"
    static let busyTimeoutMilliseconds: Int32 = 5_000

    let applicationSupportDirectory: URL
    let rootDirectoryURL: URL
    let databaseURL: URL
    let backupsDirectoryURL: URL

    private let fileManager: FileManager
    private let lock = NSRecursiveLock()
    private let authorizationContext = SOOYASQLiteAuthorizationContext()
    private var connection: OpaquePointer?
    private var fts5TrigramSupported = false

    init(
        applicationSupportDirectory: URL? = nil,
        fileManager: FileManager = .default
    ) {
        self.fileManager = fileManager
        let supportDirectory = applicationSupportDirectory
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory.appendingPathComponent("Application Support", isDirectory: true)
        self.applicationSupportDirectory = supportDirectory
        rootDirectoryURL = supportDirectory.appendingPathComponent(Self.directoryName, isDirectory: true)
        databaseURL = rootDirectoryURL.appendingPathComponent(Self.databaseFileName, isDirectory: false)
        backupsDirectoryURL = rootDirectoryURL.appendingPathComponent(Self.backupsDirectoryName, isDirectory: true)
    }

    deinit {
        lock.lock()
        if let connection {
            _ = sqlite3_close_v2(connection)
        }
        connection = nil
        lock.unlock()
    }

    func open() throws -> SOOYADatabaseInfo {
        try lock.sooyaWithLock {
            if let connection {
                return try databaseInfoLocked(connection)
            }

            try createStorageDirectoriesLocked()
            var opened: OpaquePointer?
            let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
            let openCode = sqlite3_open_v2(databaseURL.path, &opened, flags, nil)
            guard openCode == SQLITE_OK, let opened else {
                if let opened { _ = sqlite3_close_v2(opened) }
                throw SOOYADatabaseError.sqlite(operation: "open", code: openCode)
            }

            connection = opened
            do {
                sqlite3_extended_result_codes(opened, 1)
                let contextPointer = Unmanaged.passUnretained(authorizationContext).toOpaque()
                guard sqlite3_set_authorizer(opened, sooyaSQLiteAuthorizer, contextPointer) == SQLITE_OK else {
                    throw SOOYADatabaseError.configurationFailed
                }
                try configureConnectionLocked(opened)
                try applyFileProtectionLocked(to: databaseURL)
                return try databaseInfoLocked(opened)
            } catch {
                _ = sqlite3_close_v2(opened)
                connection = nil
                fts5TrigramSupported = false
                throw sanitized(error)
            }
        }
    }

    func close() throws {
        try lock.sooyaWithLock {
            guard let connection else { return }
            let code = sqlite3_close_v2(connection)
            guard code == SQLITE_OK else {
                throw SOOYADatabaseError.sqlite(operation: "close", code: code)
            }
            self.connection = nil
            fts5TrigramSupported = false
        }
    }

    func execute(_ sql: String) throws -> SOOYAExecuteResult {
        try lock.sooyaWithLock {
            let connection = try requireConnectionLocked()
            try validateSQL(sql)
            let before = Int64(sqlite3_total_changes(connection))
            let code = sqlite3_exec(connection, sql, nil, nil, nil)
            guard code == SQLITE_OK else {
                throw sqliteError(connection, operation: "execute", fallbackCode: code)
            }
            return SOOYAExecuteResult(
                changes: Int64(sqlite3_changes(connection)),
                totalChanges: Int64(sqlite3_total_changes(connection)) - before
            )
        }
    }

    func run(_ sql: String, values: [SOOYASQLValue] = []) throws -> SOOYARunResult {
        try lock.sooyaWithLock {
            let connection = try requireConnectionLocked()
            return try runLocked(connection, sql: sql, values: values)
        }
    }

    func query(_ sql: String, values: [SOOYASQLValue] = []) throws -> SOOYAQueryResult {
        try lock.sooyaWithLock {
            let connection = try requireConnectionLocked()
            return try queryLocked(connection, sql: sql, values: values, requireReadOnly: true)
        }
    }

    func transaction(
        _ statements: [SOOYASQLStatement],
        mode: SOOYATransactionMode = .immediate
    ) throws -> SOOYATransactionResult {
        try lock.sooyaWithLock {
            let connection = try requireConnectionLocked()
            guard statements.count <= 10_000 else {
                throw SOOYADatabaseError.invalidRequest
            }
            let before = Int64(sqlite3_total_changes(connection))
            try executeTransactionControlLocked(connection, sql: mode.beginSQL)

            do {
                var results: [Any] = []
                results.reserveCapacity(statements.count)
                for statement in statements {
                    switch statement.type {
                    case "execute":
                        try validateSQL(statement.sql)
                        let beforeStatement = Int64(sqlite3_total_changes(connection))
                        let code = sqlite3_exec(connection, statement.sql, nil, nil, nil)
                        guard code == SQLITE_OK else {
                            throw sqliteError(connection, operation: "execute", fallbackCode: code)
                        }
                        results.append([
                            "changes": Int64(sqlite3_changes(connection)),
                            "totalChanges": Int64(sqlite3_total_changes(connection)) - beforeStatement
                        ])
                    case "run":
                        results.append(try runLocked(connection, sql: statement.sql, values: statement.values).bridgeObject)
                    case "query":
                        results.append(try queryLocked(connection, sql: statement.sql, values: statement.values, requireReadOnly: true).bridgeObject)
                    default:
                        throw SOOYADatabaseError.invalidRequest
                    }
                }
                try executeTransactionControlLocked(connection, sql: "COMMIT")
                return SOOYATransactionResult(
                    results: results,
                    totalChanges: Int64(sqlite3_total_changes(connection)) - before
                )
            } catch {
                try? executeTransactionControlLocked(connection, sql: "ROLLBACK")
                throw sanitized(error)
            }
        }
    }

    func checkpoint(mode: SOOYACheckpointMode = .passive) throws -> SOOYACheckpointResult {
        try lock.sooyaWithLock {
            let connection = try requireConnectionLocked()
            return try checkpointLocked(connection, mode: mode)
        }
    }

    func integrity() throws -> SOOYAIntegrityResult {
        try lock.sooyaWithLock {
            try integrityLocked(try requireConnectionLocked())
        }
    }

    func backup(named name: String) throws -> SOOYABackupInfo {
        try lock.sooyaWithLock {
            try backupLocked(named: name, connection: try requireConnectionLocked())
        }
    }

    func restore(named name: String) throws -> SOOYARestoreInfo {
        try lock.sooyaWithLock {
            let connection = try requireConnectionLocked()
            let backupURL = try existingBackupURLLocked(named: name)
            let source = try openSQLiteConnectionLocked(at: backupURL, readOnly: true, operation: "restore open")
            defer { _ = sqlite3_close_v2(source) }

            let sourceIntegrity = try integrityLocked(source)
            guard sourceIntegrity.ok else {
                throw SOOYADatabaseError.invalidBackup
            }

            let preRestoreName = Self.generatedBackupName(prefix: "pre-restore")
            let preRestore = try backupLocked(named: preRestoreName, connection: connection)
            do {
                let checkpoint = try checkpointLocked(connection, mode: .truncate)
                guard !checkpoint.busy else {
                    throw SOOYADatabaseError.sqlite(operation: "restore checkpoint", code: SQLITE_BUSY)
                }
                try copyDatabaseLocked(from: source, to: connection, operation: "restore")
                try configureConnectionLocked(connection)
                let restoredIntegrity = try integrityLocked(connection)
                guard restoredIntegrity.ok else {
                    throw SOOYADatabaseError.invalidBackup
                }
                try applyFileProtectionLocked(to: databaseURL)
                return SOOYARestoreInfo(
                    fileName: name,
                    preRestoreBackupFileName: preRestore.fileName,
                    integrity: restoredIntegrity,
                    databaseInfo: try databaseInfoLocked(connection)
                )
            } catch {
                do {
                    let rollback = try openSQLiteConnectionLocked(
                        at: preRestore.fileURL,
                        readOnly: true,
                        operation: "recovery open"
                    )
                    defer { _ = sqlite3_close_v2(rollback) }
                    try copyDatabaseLocked(from: rollback, to: connection, operation: "recovery")
                    try configureConnectionLocked(connection)
                    guard try integrityLocked(connection).ok else {
                        throw SOOYADatabaseError.restoreRollbackFailed
                    }
                } catch {
                    throw SOOYADatabaseError.restoreRollbackFailed
                }
                throw SOOYADatabaseError.restoreFailed
            }
        }
    }

    func databaseInfo() throws -> SOOYADatabaseInfo {
        try lock.sooyaWithLock {
            try databaseInfoLocked(try requireConnectionLocked())
        }
    }

    static func generatedBackupName(prefix: String = "backup") -> String {
        let milliseconds = Int64(Date().timeIntervalSince1970 * 1_000)
        let suffix = UUID().uuidString.lowercased().prefix(8)
        return "\(prefix)-\(milliseconds)-\(suffix).sqlite3"
    }

    private func requireConnectionLocked() throws -> OpaquePointer {
        guard let connection else {
            throw SOOYADatabaseError.notOpen
        }
        return connection
    }

    private func createStorageDirectoriesLocked() throws {
        do {
            try fileManager.createDirectory(
                at: backupsDirectoryURL,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
            )
            try applyFileProtectionLocked(to: rootDirectoryURL)
            try applyFileProtectionLocked(to: backupsDirectoryURL)
        } catch {
            throw SOOYADatabaseError.fileSystem(operation: "directory creation")
        }
    }

    private func applyFileProtectionLocked(to url: URL) throws {
        guard fileManager.fileExists(atPath: url.path) else { return }
        do {
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path
            )
        } catch {
            throw SOOYADatabaseError.fileSystem(operation: "file protection")
        }
    }

    private func configureConnectionLocked(_ connection: OpaquePointer) throws {
        guard sqlite3_busy_timeout(connection, Self.busyTimeoutMilliseconds) == SQLITE_OK else {
            throw SOOYADatabaseError.configurationFailed
        }
        try executeInternalLocked(connection, sql: "PRAGMA journal_mode = WAL")
        try executeInternalLocked(connection, sql: "PRAGMA foreign_keys = ON")
        try executeInternalLocked(connection, sql: "PRAGMA synchronous = NORMAL")
        try executeInternalLocked(connection, sql: "PRAGMA busy_timeout = \(Self.busyTimeoutMilliseconds)")
        try executeInternalLocked(connection, sql: "PRAGMA temp_store = MEMORY")
        fts5TrigramSupported = probeFTS5TrigramLocked(connection)

        let info = try databaseInfoLocked(connection)
        guard info.journalMode == "wal",
              info.foreignKeysEnabled,
              info.synchronous == "normal",
              info.busyTimeoutMilliseconds == Self.busyTimeoutMilliseconds,
              info.tempStore == "memory" else {
            throw SOOYADatabaseError.configurationFailed
        }
    }

    private func probeFTS5TrigramLocked(_ connection: OpaquePointer) -> Bool {
        let table = "temp.__sooya_fts5_trigram_probe"
        _ = sqlite3_exec(connection, "DROP TABLE IF EXISTS \(table)", nil, nil, nil)
        let createCode = sqlite3_exec(
            connection,
            "CREATE VIRTUAL TABLE \(table) USING fts5(value, tokenize='trigram')",
            nil,
            nil,
            nil
        )
        let supported = createCode == SQLITE_OK
        _ = sqlite3_exec(connection, "DROP TABLE IF EXISTS \(table)", nil, nil, nil)
        return supported
    }

    private func validateSQL(_ sql: String) throws {
        guard !sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              sql.utf8.count <= 8 * 1_024 * 1_024 else {
            throw SOOYADatabaseError.invalidRequest
        }
    }

    private func executeInternalLocked(_ connection: OpaquePointer, sql: String) throws {
        let code = sqlite3_exec(connection, sql, nil, nil, nil)
        guard code == SQLITE_OK else {
            throw sqliteError(connection, operation: "configuration", fallbackCode: code)
        }
    }

    private func executeTransactionControlLocked(_ connection: OpaquePointer, sql: String) throws {
        authorizationContext.allowsTransactionControl = true
        defer { authorizationContext.allowsTransactionControl = false }
        let code = sqlite3_exec(connection, sql, nil, nil, nil)
        guard code == SQLITE_OK else {
            throw sqliteError(connection, operation: "transaction", fallbackCode: code)
        }
    }

    private func runLocked(
        _ connection: OpaquePointer,
        sql: String,
        values: [SOOYASQLValue]
    ) throws -> SOOYARunResult {
        let statement = try prepareSingleStatementLocked(connection, sql: sql)
        defer { sqlite3_finalize(statement) }
        try bindLocked(values, to: statement, connection: connection)

        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { break }
            if code == SQLITE_ROW { continue }
            throw sqliteError(connection, operation: "run", fallbackCode: code)
        }
        return SOOYARunResult(
            changes: Int64(sqlite3_changes(connection)),
            lastInsertRowID: sqlite3_last_insert_rowid(connection)
        )
    }

    private func queryLocked(
        _ connection: OpaquePointer,
        sql: String,
        values: [SOOYASQLValue],
        requireReadOnly: Bool
    ) throws -> SOOYAQueryResult {
        let statement = try prepareSingleStatementLocked(connection, sql: sql)
        defer { sqlite3_finalize(statement) }
        if requireReadOnly, sqlite3_stmt_readonly(statement) == 0 {
            throw SOOYADatabaseError.queryMustBeReadOnly
        }
        try bindLocked(values, to: statement, connection: connection)

        let columnCount = Int(sqlite3_column_count(statement))
        let columns: [String] = (0..<columnCount).map { index in
            guard let name = sqlite3_column_name(statement, Int32(index)) else {
                return "column_\(index)"
            }
            return String(cString: name)
        }
        var rows: [[String: SOOYASQLValue]] = []
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_DONE { break }
            guard code == SQLITE_ROW else {
                throw sqliteError(connection, operation: "query", fallbackCode: code)
            }
            var row: [String: SOOYASQLValue] = [:]
            row.reserveCapacity(columnCount)
            for index in 0..<columnCount {
                row[columns[index]] = columnValueLocked(statement, index: Int32(index))
            }
            rows.append(row)
        }
        return SOOYAQueryResult(columns: columns, rows: rows)
    }

    private func prepareSingleStatementLocked(
        _ connection: OpaquePointer,
        sql: String
    ) throws -> OpaquePointer {
        try validateSQL(sql)
        return try sql.withCString { sqlPointer in
            var statement: OpaquePointer?
            var tail: UnsafePointer<CChar>?
            let code = sqlite3_prepare_v2(connection, sqlPointer, -1, &statement, &tail)
            guard code == SQLITE_OK, let statement else {
                if let statement { sqlite3_finalize(statement) }
                throw sqliteError(connection, operation: "prepare", fallbackCode: code)
            }
            do {
                try rejectAdditionalStatementsLocked(connection, tail: tail)
                return statement
            } catch {
                sqlite3_finalize(statement)
                throw error
            }
        }
    }

    private func rejectAdditionalStatementsLocked(
        _ connection: OpaquePointer,
        tail: UnsafePointer<CChar>?
    ) throws {
        var cursor = tail
        while let current = cursor, current.pointee != 0 {
            var extra: OpaquePointer?
            var next: UnsafePointer<CChar>?
            let code = sqlite3_prepare_v2(connection, current, -1, &extra, &next)
            if let extra {
                sqlite3_finalize(extra)
                throw SOOYADatabaseError.multipleStatements
            }
            guard code == SQLITE_OK else {
                throw sqliteError(connection, operation: "prepare", fallbackCode: code)
            }
            guard let next, next != current else { break }
            cursor = next
        }
    }

    private func bindLocked(
        _ values: [SOOYASQLValue],
        to statement: OpaquePointer,
        connection: OpaquePointer
    ) throws {
        guard sqlite3_bind_parameter_count(statement) == Int32(values.count) else {
            throw SOOYADatabaseError.parameterCountMismatch
        }
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let code: Int32
            switch value {
            case .null:
                code = sqlite3_bind_null(statement, index)
            case let .integer(value):
                code = sqlite3_bind_int64(statement, index, value)
            case let .real(value):
                code = sqlite3_bind_double(statement, index, value)
            case let .text(value):
                code = value.withCString {
                    sqlite3_bind_text(statement, index, $0, -1, sooyaSQLiteTransient)
                }
            case let .blob(value):
                if value.isEmpty {
                    code = sqlite3_bind_zeroblob(statement, index, 0)
                } else {
                    code = value.withUnsafeBytes {
                        sqlite3_bind_blob(
                            statement,
                            index,
                            $0.baseAddress,
                            Int32($0.count),
                            sooyaSQLiteTransient
                        )
                    }
                }
            }
            guard code == SQLITE_OK else {
                throw sqliteError(connection, operation: "bind", fallbackCode: code)
            }
        }
    }

    private func columnValueLocked(_ statement: OpaquePointer, index: Int32) -> SOOYASQLValue {
        switch sqlite3_column_type(statement, index) {
        case SQLITE_INTEGER:
            return .integer(sqlite3_column_int64(statement, index))
        case SQLITE_FLOAT:
            return .real(sqlite3_column_double(statement, index))
        case SQLITE_TEXT:
            let count = Int(sqlite3_column_bytes(statement, index))
            guard let pointer = sqlite3_column_text(statement, index) else {
                return .text("")
            }
            let bytes = UnsafeBufferPointer(start: pointer, count: count)
            return .text(String(decoding: bytes, as: UTF8.self))
        case SQLITE_BLOB:
            let count = Int(sqlite3_column_bytes(statement, index))
            guard count > 0, let pointer = sqlite3_column_blob(statement, index) else {
                return .blob(Data())
            }
            return .blob(Data(bytes: pointer, count: count))
        default:
            return .null
        }
    }

    private func checkpointLocked(
        _ connection: OpaquePointer,
        mode: SOOYACheckpointMode
    ) throws -> SOOYACheckpointResult {
        var logFrames: Int32 = 0
        var checkpointedFrames: Int32 = 0
        let code = sqlite3_wal_checkpoint_v2(
            connection,
            nil,
            mode.sqliteValue,
            &logFrames,
            &checkpointedFrames
        )
        guard code == SQLITE_OK || code == SQLITE_BUSY else {
            throw sqliteError(connection, operation: "checkpoint", fallbackCode: code)
        }
        return SOOYACheckpointResult(
            mode: mode,
            busy: code == SQLITE_BUSY,
            logFrames: max(0, logFrames),
            checkpointedFrames: max(0, checkpointedFrames)
        )
    }

    private func integrityLocked(_ connection: OpaquePointer) throws -> SOOYAIntegrityResult {
        let integrityRows = try queryLocked(
            connection,
            sql: "PRAGMA integrity_check",
            values: [],
            requireReadOnly: true
        )
        let messages = integrityRows.rows.compactMap { row -> String? in
            guard let value = row.values.first else { return nil }
            if case let .text(message) = value { return message }
            return nil
        }
        let foreignRows = try queryLocked(
            connection,
            sql: "PRAGMA foreign_key_check",
            values: [],
            requireReadOnly: true
        )
        return SOOYAIntegrityResult(
            ok: messages == ["ok"] && foreignRows.rows.isEmpty,
            messages: messages,
            foreignKeyViolations: foreignRows.rows.count
        )
    }

    private func databaseInfoLocked(_ connection: OpaquePointer) throws -> SOOYADatabaseInfo {
        let pageSize = try scalarIntegerLocked(connection, sql: "PRAGMA page_size")
        let pageCount = try scalarIntegerLocked(connection, sql: "PRAGMA page_count")
        let walURL = URL(fileURLWithPath: databaseURL.path + "-wal")
        return SOOYADatabaseInfo(
            isOpen: true,
            fileName: Self.databaseFileName,
            sizeBytes: pageSize * pageCount,
            walSizeBytes: fileSizeLocked(at: walURL),
            pageSize: pageSize,
            pageCount: pageCount,
            userVersion: try scalarIntegerLocked(connection, sql: "PRAGMA user_version"),
            journalMode: try journalModeLocked(connection),
            foreignKeysEnabled: try scalarIntegerLocked(connection, sql: "PRAGMA foreign_keys") == 1,
            synchronous: synchronousName(
                try scalarIntegerLocked(connection, sql: "PRAGMA synchronous")
            ),
            busyTimeoutMilliseconds: Int32(
                try scalarIntegerLocked(connection, sql: "PRAGMA busy_timeout")
            ),
            tempStore: tempStoreName(
                try scalarIntegerLocked(connection, sql: "PRAGMA temp_store")
            ),
            sqliteVersion: String(cString: sqlite3_libversion()),
            fts5TrigramSupported: fts5TrigramSupported
        )
    }

    private func scalarIntegerLocked(_ connection: OpaquePointer, sql: String) throws -> Int64 {
        let result = try queryLocked(connection, sql: sql, values: [], requireReadOnly: true)
        guard let value = result.rows.first?.values.first else {
            throw SOOYADatabaseError.configurationFailed
        }
        switch value {
        case let .integer(value): return value
        case let .real(value): return Int64(value)
        default: throw SOOYADatabaseError.configurationFailed
        }
    }

    private func journalModeLocked(_ connection: OpaquePointer) throws -> String {
        // SQLite intentionally reports bare PRAGMA journal_mode as not read-only.
        // This is a fixed internal literal used only to inspect the mode after we
        // have explicitly configured WAL above. Never expose this bypass to query().
        let result = try queryLocked(
            connection,
            sql: "PRAGMA journal_mode",
            values: [],
            requireReadOnly: false
        )
        guard let value = result.rows.first?.values.first,
              case let .text(text) = value else {
            throw SOOYADatabaseError.configurationFailed
        }
        return text.lowercased()
    }

    private func scalarTextLocked(_ connection: OpaquePointer, sql: String) throws -> String {
        let result = try queryLocked(connection, sql: sql, values: [], requireReadOnly: true)
        guard let value = result.rows.first?.values.first,
              case let .text(text) = value else {
            throw SOOYADatabaseError.configurationFailed
        }
        return text
    }

    private func synchronousName(_ value: Int64) -> String {
        switch value {
        case 0: return "off"
        case 1: return "normal"
        case 2: return "full"
        case 3: return "extra"
        default: return "unknown"
        }
    }

    private func tempStoreName(_ value: Int64) -> String {
        switch value {
        case 1: return "file"
        case 2: return "memory"
        default: return "default"
        }
    }

    private func backupLocked(named name: String, connection: OpaquePointer) throws -> SOOYABackupInfo {
        try validateBackupName(name)
        try createStorageDirectoriesLocked()
        let finalURL = backupsDirectoryURL.appendingPathComponent(name, isDirectory: false)
        guard !fileManager.fileExists(atPath: finalURL.path) else {
            throw SOOYADatabaseError.backupAlreadyExists
        }
        let temporaryURL = backupsDirectoryURL.appendingPathComponent(
            ".\(name).\(UUID().uuidString).tmp",
            isDirectory: false
        )
        defer { try? fileManager.removeItem(at: temporaryURL) }

        let destination = try openSQLiteConnectionLocked(
            at: temporaryURL,
            readOnly: false,
            operation: "backup open"
        )
        do {
            try copyDatabaseLocked(from: connection, to: destination, operation: "backup")
            let verification = try integrityLocked(destination)
            guard verification.ok else {
                throw SOOYADatabaseError.invalidBackup
            }
            let closeCode = sqlite3_close_v2(destination)
            guard closeCode == SQLITE_OK else {
                throw SOOYADatabaseError.sqlite(operation: "backup close", code: closeCode)
            }
        } catch {
            _ = sqlite3_close_v2(destination)
            throw sanitized(error)
        }

        do {
            try fileManager.moveItem(at: temporaryURL, to: finalURL)
            try applyFileProtectionLocked(to: finalURL)
        } catch {
            throw SOOYADatabaseError.fileSystem(operation: "backup finalize")
        }
        return SOOYABackupInfo(
            fileName: name,
            fileURL: finalURL,
            sizeBytes: fileSizeLocked(at: finalURL),
            verified: true,
            createdAt: Date()
        )
    }

    private func existingBackupURLLocked(named name: String) throws -> URL {
        try validateBackupName(name)
        let url = backupsDirectoryURL.appendingPathComponent(name, isDirectory: false)
        guard fileManager.fileExists(atPath: url.path) else {
            throw SOOYADatabaseError.backupNotFound
        }
        do {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
                throw SOOYADatabaseError.invalidBackup
            }
        } catch let error as SOOYADatabaseError {
            throw error
        } catch {
            throw SOOYADatabaseError.fileSystem(operation: "backup inspection")
        }
        return url
    }

    private func validateBackupName(_ name: String) throws {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        guard !name.isEmpty,
              name.utf8.count <= 160,
              name.hasSuffix(".sqlite3"),
              !name.hasPrefix("."),
              !name.contains("/"),
              !name.contains("\\"),
              name.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw SOOYADatabaseError.invalidBackupName
        }
    }

    private func openSQLiteConnectionLocked(
        at url: URL,
        readOnly: Bool,
        operation: String
    ) throws -> OpaquePointer {
        var opened: OpaquePointer?
        let flags = (readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
            | SQLITE_OPEN_FULLMUTEX
        let code = sqlite3_open_v2(url.path, &opened, flags, nil)
        guard code == SQLITE_OK, let opened else {
            if let opened { _ = sqlite3_close_v2(opened) }
            throw SOOYADatabaseError.sqlite(operation: operation, code: code)
        }
        sqlite3_extended_result_codes(opened, 1)
        _ = sqlite3_busy_timeout(opened, Self.busyTimeoutMilliseconds)
        return opened
    }

    private func copyDatabaseLocked(
        from source: OpaquePointer,
        to destination: OpaquePointer,
        operation: String
    ) throws {
        guard let backup = sqlite3_backup_init(destination, "main", source, "main") else {
            throw sqliteError(destination, operation: operation, fallbackCode: sqlite3_errcode(destination))
        }
        let deadline = Date().addingTimeInterval(5)
        var stepCode: Int32 = SQLITE_OK
        repeat {
            stepCode = sqlite3_backup_step(backup, 256)
            if stepCode == SQLITE_BUSY || stepCode == SQLITE_LOCKED {
                if Date() >= deadline { break }
                sqlite3_sleep(10)
            }
        } while stepCode == SQLITE_OK || stepCode == SQLITE_BUSY || stepCode == SQLITE_LOCKED

        let finishCode = sqlite3_backup_finish(backup)
        guard stepCode == SQLITE_DONE, finishCode == SQLITE_OK else {
            let code = finishCode == SQLITE_OK ? stepCode : finishCode
            throw sqliteError(destination, operation: operation, fallbackCode: code)
        }
    }

    private func fileSizeLocked(at url: URL) -> Int64 {
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber else {
            return 0
        }
        return size.int64Value
    }

    private func sqliteError(
        _ connection: OpaquePointer?,
        operation: String,
        fallbackCode: Int32
    ) -> SOOYADatabaseError {
        let code = connection.map(sqlite3_extended_errcode) ?? fallbackCode
        return .sqlite(operation: operation, code: code == SQLITE_OK ? fallbackCode : code)
    }

    private func sanitized(_ error: Error) -> SOOYADatabaseError {
        if let error = error as? SOOYADatabaseError { return error }
        return .unavailable
    }
}

@objc(SOOYADatabasePlugin)
public final class SOOYADatabasePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SOOYADatabasePlugin"
    public let jsName = "SOOYADatabase"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "run", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "query", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "transaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkpoint", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "integrity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "databaseInfo", returnType: CAPPluginReturnPromise)
    ]

    private let store = SOOYADatabaseStore()

    @objc public func open(_ call: CAPPluginCall) {
        resolve(call) { try self.store.open().bridgeObject }
    }

    @objc public func close(_ call: CAPPluginCall) {
        resolve(call) {
            try self.store.close()
            return ["closed": true]
        }
    }

    @objc public func execute(_ call: CAPPluginCall) {
        resolve(call) {
            guard let sql = call.getString("sql") else {
                throw SOOYADatabaseError.invalidRequest
            }
            return try self.store.execute(sql).bridgeObject
        }
    }

    @objc public func run(_ call: CAPPluginCall) {
        resolve(call) {
            guard let sql = call.getString("sql") else {
                throw SOOYADatabaseError.invalidRequest
            }
            return try self.store.run(sql, values: try self.values(from: call.getArray("values"))).bridgeObject
        }
    }

    @objc public func query(_ call: CAPPluginCall) {
        resolve(call) {
            guard let sql = call.getString("sql") else {
                throw SOOYADatabaseError.invalidRequest
            }
            return try self.store.query(sql, values: try self.values(from: call.getArray("values"))).bridgeObject
        }
    }

    @objc public func transaction(_ call: CAPPluginCall) {
        resolve(call) {
            guard let rawStatements = call.getArray("statements") else {
                throw SOOYADatabaseError.invalidRequest
            }
            let statements = try rawStatements.map { raw -> SOOYASQLStatement in
                guard let object = raw as? [String: Any],
                      let sql = object["sql"] as? String else {
                    throw SOOYADatabaseError.invalidRequest
                }
                let rawValues = object["values"] as? JSArray
                let type = object["type"] as? String ?? "run"
                return SOOYASQLStatement(type: type, sql: sql, values: try self.values(from: rawValues))
            }
            let modeValue = call.getString("mode", SOOYATransactionMode.immediate.rawValue)
            guard let mode = SOOYATransactionMode(rawValue: modeValue.lowercased()) else {
                throw SOOYADatabaseError.invalidRequest
            }
            return try self.store.transaction(statements, mode: mode).bridgeObject
        }
    }

    @objc public func checkpoint(_ call: CAPPluginCall) {
        resolve(call) {
            let modeValue = call.getString("mode", SOOYACheckpointMode.passive.rawValue)
            guard let mode = SOOYACheckpointMode(rawValue: modeValue.lowercased()) else {
                throw SOOYADatabaseError.invalidRequest
            }
            return try self.store.checkpoint(mode: mode).bridgeObject
        }
    }

    @objc public func integrity(_ call: CAPPluginCall) {
        resolve(call) { try self.store.integrity().bridgeObject }
    }

    @objc public func backup(_ call: CAPPluginCall) {
        resolve(call) {
            let name = call.getString("name") ?? SOOYADatabaseStore.generatedBackupName()
            return try self.store.backup(named: name).bridgeObject
        }
    }

    @objc public func restore(_ call: CAPPluginCall) {
        resolve(call) {
            guard let name = call.getString("name") else {
                throw SOOYADatabaseError.invalidRequest
            }
            return try self.store.restore(named: name).bridgeObject
        }
    }

    @objc public func databaseInfo(_ call: CAPPluginCall) {
        resolve(call) { try self.store.databaseInfo().bridgeObject }
    }

    private func resolve(_ call: CAPPluginCall, operation: () throws -> [String: Any]) {
        do {
            call.resolve(try operation())
        } catch let error as SOOYADatabaseError {
            call.reject(error.localizedDescription, error.bridgeCode)
        } catch {
            call.reject("Native database operation failed.", "DB_UNAVAILABLE")
        }
    }

    private func values(from rawValues: JSArray?) throws -> [SOOYASQLValue] {
        try (rawValues ?? []).map { try SOOYASQLValue(bridgeValue: $0) }
    }
}

private extension SOOYAExecuteResult {
    var bridgeObject: [String: Any] {
        ["changes": changes, "totalChanges": totalChanges]
    }
}

private extension SOOYARunResult {
    var bridgeObject: [String: Any] {
        ["changes": changes, "lastInsertRowId": lastInsertRowID]
    }
}

private extension SOOYAQueryResult {
    var bridgeObject: [String: Any] {
        return [
            "columns": columns,
            "rows": rows.map { row in row.mapValues(\.bridgeValue) }
        ]
    }
}

private extension SOOYATransactionResult {
    var bridgeObject: [String: Any] {
        ["results": results, "totalChanges": totalChanges]
    }
}

private extension SOOYACheckpointResult {
    var bridgeObject: [String: Any] {
        [
            "mode": mode.rawValue,
            "busy": busy,
            "logFrames": logFrames,
            "checkpointedFrames": checkpointedFrames
        ]
    }
}

private extension SOOYAIntegrityResult {
    var bridgeObject: [String: Any] {
        [
            "ok": ok,
            "messages": messages,
            "foreignKeyViolations": foreignKeyViolations
        ]
    }
}

private extension SOOYADatabaseInfo {
    var bridgeObject: [String: Any] {
        [
            "isOpen": isOpen,
            "fileName": fileName,
            "sizeBytes": sizeBytes,
            "walSizeBytes": walSizeBytes,
            "pageSize": pageSize,
            "pageCount": pageCount,
            "userVersion": userVersion,
            "journalMode": journalMode,
            "foreignKeysEnabled": foreignKeysEnabled,
            "synchronous": synchronous,
            "busyTimeoutMilliseconds": busyTimeoutMilliseconds,
            "tempStore": tempStore,
            "sqliteVersion": sqliteVersion,
            "fts5TrigramSupported": fts5TrigramSupported
        ]
    }
}

private extension SOOYABackupInfo {
    var bridgeObject: [String: Any] {
        let sha256: String = {
            guard let data = try? Data(contentsOf: fileURL) else { return "" }
            return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        }()
        return [
            "fileName": fileName,
            "sizeBytes": sizeBytes,
            "sha256": sha256,
            "verified": verified,
            "createdAt": ISO8601DateFormatter().string(from: createdAt)
        ]
    }
}

private extension SOOYARestoreInfo {
    var bridgeObject: [String: Any] {
        [
            "fileName": fileName,
            "preRestoreBackupFileName": preRestoreBackupFileName,
            "integrity": integrity.bridgeObject,
            "databaseInfo": databaseInfo.bridgeObject
        ]
    }
}

private extension NSRecursiveLock {
    func sooyaWithLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
