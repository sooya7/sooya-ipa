from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}\n--- OLD ---\n{old[:500]}")
    file.write_text(text.replace(old, new, 1))


# 1) TypeScript <-> Capacitor database/media DTOs and startup fault isolation.
path = "packages/web/src/local/nativeBoot.ts"
replace_once(path,
"""type TransactionOperation = { type: 'execute' | 'run' | 'query'; sql: string; values?: DatabaseValue[] };

export function databaseTransactionCallOptions(operations: TransactionOperation[]): { statements: TransactionOperation[] } {
  return { statements: operations.map((op) => ({ ...op, values: normalizeValues(op.values ?? []) })) };
}
""",
"""type TransactionOperation = { type: 'execute' | 'run' | 'query'; sql: string; values?: DatabaseValue[] };
type NativeDatabaseValue = string | number | boolean | null | { type: 'blob'; base64: string } | { type: 'int64'; value: string };
type NativeTransactionStatement = { type: TransactionOperation['type']; sql: string; values: NativeDatabaseValue[] };

export function databaseTransactionCallOptions(operations: TransactionOperation[]): { statements: NativeTransactionStatement[] } {
  return { statements: operations.map((op) => ({ type: op.type, sql: op.sql, values: normalizeValues(op.values ?? []) })) };
}
""")

replace_once(path,
"""  async run(sql: string, values: DatabaseValue[] = []): Promise<RunResult> {
    return await this.plugin.call<RunResult>('run', { sql, values: normalizeValues(values) });
  }
  async query<T = Record<string, unknown>>(sql: string, values: DatabaseValue[] = []): Promise<T[]> {
    return await this.plugin.call<T[]>('query', { sql, values: normalizeValues(values) });
  }
  async transaction<T = unknown[]>(operations: TransactionOperation[]): Promise<T> {
    return await this.plugin.call<T>('transaction', databaseTransactionCallOptions(operations));
  }
  async integrityCheck(): Promise<DatabaseIntegrityResult> {
    return await this.plugin.call<DatabaseIntegrityResult>('integrity', {});
  }
""",
"""  async run(sql: string, values: DatabaseValue[] = []): Promise<RunResult> {
    const result = await this.plugin.call<{ changes?: number; lastInsertRowId?: unknown }>('run', { sql, values: normalizeValues(values) });
    const lastInsertRowid = decodeNativeDatabaseValue(result.lastInsertRowId);
    return {
      changes: typeof result.changes === 'number' ? result.changes : 0,
      ...(typeof lastInsertRowid === 'number' || typeof lastInsertRowid === 'bigint' ? { lastInsertRowid } : {})
    };
  }
  async query<T = Record<string, unknown>>(sql: string, values: DatabaseValue[] = []): Promise<T[]> {
    const result = await this.plugin.call<{ rows?: unknown[] }>('query', { sql, values: normalizeValues(values) });
    if (!Array.isArray(result.rows)) throw new Error('native database query returned an invalid row envelope');
    return result.rows.map((row) => decodeNativeDatabaseRow<T>(row));
  }
  async transaction<T = unknown[]>(operations: TransactionOperation[]): Promise<T> {
    const result = await this.plugin.call<{ results?: unknown[] }>('transaction', databaseTransactionCallOptions(operations));
    if (!Array.isArray(result.results)) throw new Error('native database transaction returned an invalid result envelope');
    return result.results.map(decodeNativeTransactionResult) as T;
  }
  async integrityCheck(): Promise<DatabaseIntegrityResult> {
    const result = await this.plugin.call<{ ok?: boolean; messages?: unknown[]; foreignKeyViolations?: number }>('integrity', {});
    const count = Number.isSafeInteger(result.foreignKeyViolations) && (result.foreignKeyViolations ?? 0) > 0 ? result.foreignKeyViolations! : 0;
    return {
      ok: result.ok === true,
      integrity: Array.isArray(result.messages) ? result.messages.filter((value): value is string => typeof value === 'string') : [],
      foreignKeys: Array.from({ length: count }, () => ({}))
    };
  }
""")

replace_once(path,
"""  async save(request: MediaSaveRequest): Promise<MediaRecord> {
    const bytes = request.data instanceof Uint8Array ? request.data : new Uint8Array(request.data);
    const result = await this.plugin.call<{ id: string; kind: MediaRecord['kind']; mime: string; bytes: number; sha256?: string }>('save', {
      kind: request.kind,
      mime: request.mime ?? 'application/octet-stream',
      name: request.name ?? null,
      dataBase64: bytesToBase64(bytes)
    });
    return { id: result.id, kind: result.kind, mime: result.mime, bytes: result.bytes, name: request.name };
  }
  async read(id: string): Promise<{ record: MediaRecord; data: Uint8Array } | null> {
    const result = await this.plugin.call<{ record: MediaRecord; dataBase64: string } | null>('read', { id });
    if (!result) return null;
    return { record: result.record, data: base64ToBytes(result.dataBase64) };
  }
  async remove(id: string): Promise<boolean> {
    return await this.plugin.call<{ removed: boolean }>('delete', { id }).then((r) => r.removed);
  }
""",
"""  async save(request: MediaSaveRequest): Promise<MediaRecord> {
    const bytes = request.data instanceof Uint8Array ? request.data : new Uint8Array(request.data);
    const result = await this.plugin.call<Record<string, unknown>>('save', {
      kind: request.kind,
      mimeType: request.mime ?? 'application/octet-stream',
      name: request.name ?? null,
      dataBase64: bytesToBase64(bytes)
    });
    return nativeMediaRecord(result, request.kind, request.name);
  }
  async read(id: string): Promise<{ record: MediaRecord; data: Uint8Array } | null> {
    try {
      const result = await this.plugin.call<{ metadata?: Record<string, unknown>; dataBase64?: string }>('read', { id });
      if (!isRecordValue(result.metadata) || typeof result.dataBase64 !== 'string') throw new Error('native media read returned an invalid payload');
      return { record: nativeMediaRecord(result.metadata), data: base64ToBytes(result.dataBase64) };
    } catch (error) {
      if (error instanceof Error && /media not found/iu.test(error.message)) return null;
      throw error;
    }
  }
  async remove(id: string): Promise<boolean> {
    return await this.plugin.call<{ deleted?: boolean }>('delete', { id }).then((r) => r.deleted === true);
  }
""")

replace_once(path,
"""  nativeOtaCore = core;
  nativeOtaUpdater = await prepareOtaUpdater(core, await getNativeReleaseInfo());
  void wireNativeLifecycle(core);
  return true;
}
""",
"""  nativeOtaCore = core;
  void wireNativeLifecycle(core).catch((error) => console.warn('Native lifecycle wiring is unavailable', error));
  try {
    nativeOtaUpdater = await prepareOtaUpdater(core, await getNativeReleaseInfo());
  } catch (error) {
    nativeOtaUpdater = null;
    console.warn('OTA updater is unavailable; LocalCore will continue without OTA', error);
  }
  return true;
}
""")

replace_once(path,
"""export async function notifyNativeAppReady(): Promise<void> {
  if (!nativeOtaUpdater || !nativeOtaCore) return;
  nativeOtaReady ??= (async () => {
    const updater = nativeOtaUpdater!;
    await afterAppReady(
      () => seedBuiltinStickersOnce(nativeOtaCore!.database, 'server-2026-08-14', BUILTIN_STICKERS),
      (ids) => nativeBuiltinMedia!.activate(ids),
      () => updater.notifyReady(),
      (result) => rollbackBuiltinStickerImport(nativeOtaCore!.database, result)
    );
    window.dispatchEvent(new Event('sooya:stickers-ready'));
    const manifestUrl = await nativeOtaCore!.configRepo.getPreference('ota.manifestUrl', '').catch(() => '');
    if (manifestUrl) void updater.checkAndApply(manifestUrl);
  })();
  await nativeOtaReady;
}
""",
"""export async function notifyNativeAppReady(): Promise<void> {
  if (!nativeOtaCore || !nativeBuiltinMedia) return;
  nativeOtaReady ??= (async () => {
    const updater = nativeOtaUpdater;
    await afterAppReady(
      () => seedBuiltinStickersOnce(nativeOtaCore!.database, 'server-2026-08-14', BUILTIN_STICKERS),
      (ids) => nativeBuiltinMedia!.activate(ids),
      () => updater ? updater.notifyReady() : Promise.resolve(),
      (result) => rollbackBuiltinStickerImport(nativeOtaCore!.database, result)
    );
    window.dispatchEvent(new Event('sooya:stickers-ready'));
    if (!updater) return;
    const manifestUrl = await nativeOtaCore!.configRepo.getPreference('ota.manifestUrl', '').catch(() => '');
    if (manifestUrl) void updater.checkAndApply(manifestUrl);
  })();
  await nativeOtaReady;
}
""")

replace_once(path,
"""function normalizeValues(values: DatabaseValue[]): DatabaseValue[] {
  return values.map((value) => (value instanceof Uint8Array ? value : value));
}

function bytesToBase64(bytes: Uint8Array): string {
""",
"""function normalizeValues(values: DatabaseValue[]): NativeDatabaseValue[] {
  return values.map((value): NativeDatabaseValue => {
    if (value instanceof Uint8Array) return { type: 'blob', base64: bytesToBase64(value) };
    if (value instanceof ArrayBuffer) return { type: 'blob', base64: bytesToBase64(new Uint8Array(value)) };
    if (typeof value === 'bigint') return { type: 'int64', value: value.toString() };
    return value;
  });
}

function decodeNativeDatabaseValue(value: unknown): unknown {
  if (!isRecordValue(value) || typeof value.type !== 'string') return value;
  if (value.type === 'blob' && typeof value.base64 === 'string') return base64ToBytes(value.base64);
  if (value.type === 'int64' && typeof value.value === 'string' && /^-?\\d+$/u.test(value.value)) return BigInt(value.value);
  return value;
}

function decodeNativeDatabaseRow<T>(value: unknown): T {
  if (!isRecordValue(value)) throw new Error('native database query returned a non-object row');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeNativeDatabaseValue(item)])) as T;
}

function decodeNativeTransactionResult(value: unknown): unknown {
  if (!isRecordValue(value)) return value;
  if (Array.isArray(value.rows)) return value.rows.map((row) => decodeNativeDatabaseRow<Record<string, unknown>>(row));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeNativeDatabaseValue(item)]));
}

function nativeMediaRecord(value: Record<string, unknown>, fallbackKind?: MediaRecord['kind'], fallbackName?: string): MediaRecord {
  const id = typeof value.id === 'string' ? value.id : '';
  const mime = typeof value.mimeType === 'string' ? value.mimeType : 'application/octet-stream';
  const bytes = typeof value.bytes === 'number' ? value.bytes : 0;
  if (!id) throw new Error('native media metadata is missing id');
  const rawKind = typeof value.kind === 'string' ? value.kind : undefined;
  const kind: MediaRecord['kind'] = rawKind === 'image' || rawKind === 'audio' || rawKind === 'sticker' || rawKind === 'file'
    ? rawKind
    : fallbackKind ?? inferMediaKind(mime);
  const name = typeof value.originalName === 'string' ? value.originalName : fallbackName;
  return {
    id, kind, mime, bytes,
    ...(name ? { name } : {}),
    ...(typeof value.width === 'number' ? { width: value.width } : {}),
    ...(typeof value.height === 'number' ? { height: value.height } : {}),
    ...(typeof value.durationSeconds === 'number' ? { durationSec: value.durationSeconds } : {})
  };
}

function inferMediaKind(mime: string): MediaRecord['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function bytesToBase64(bytes: Uint8Array): string {
""")

# 2) Native SQLite contract: operation-aware transaction, BigInt/BLOB round-trip.
path = "ios/App/App/Plugins/SOOYADatabasePlugin.swift"
replace_once(path,
"""        if let value = bridgeValue as? [String: Any],
           value[\"type\"] as? String == \"blob\",
           let encoded = value[\"base64\"] as? String,
           let data = Data(base64Encoded: encoded) {
            self = .blob(data)
            return
        }
""",
"""        if let value = bridgeValue as? [String: Any],
           value[\"type\"] as? String == \"int64\",
           let encoded = value[\"value\"] as? String,
           let integer = Int64(encoded) {
            self = .integer(integer)
            return
        }
        if let value = bridgeValue as? [String: Any],
           value[\"type\"] as? String == \"blob\",
           let encoded = value[\"base64\"] as? String,
           let data = Data(base64Encoded: encoded) {
            self = .blob(data)
            return
        }
""")
replace_once(path,
"""        if let value = bridgeValue as? NSDictionary,
           value[\"type\"] as? String == \"blob\",
           let encoded = value[\"base64\"] as? String,
           let data = Data(base64Encoded: encoded) {
            self = .blob(data)
            return
        }
""",
"""        if let value = bridgeValue as? NSDictionary,
           value[\"type\"] as? String == \"int64\",
           let encoded = value[\"value\"] as? String,
           let integer = Int64(encoded) {
            self = .integer(integer)
            return
        }
        if let value = bridgeValue as? NSDictionary,
           value[\"type\"] as? String == \"blob\",
           let encoded = value[\"base64\"] as? String,
           let data = Data(base64Encoded: encoded) {
            self = .blob(data)
            return
        }
""")
replace_once(path,
"""        case let .integer(value):
            return NSNumber(value: value)
""",
"""        case let .integer(value):
            if value > 9_007_199_254_740_991 || value < -9_007_199_254_740_991 {
                return [\"type\": \"int64\", \"value\": String(value)]
            }
            return NSNumber(value: value)
""")
replace_once(path,
"""struct SOOYASQLStatement {
    let sql: String
    let values: [SOOYASQLValue]

    init(sql: String, values: [SOOYASQLValue] = []) {
        self.sql = sql
        self.values = values
    }
}
""",
"""struct SOOYASQLStatement {
    let type: String
    let sql: String
    let values: [SOOYASQLValue]

    init(type: String = \"run\", sql: String, values: [SOOYASQLValue] = []) {
        self.type = type
        self.sql = sql
        self.values = values
    }
}
""")
replace_once(path,
"""struct SOOYATransactionResult {
    let results: [SOOYARunResult]
    let totalChanges: Int64
}
""",
"""struct SOOYATransactionResult {
    let results: [Any]
    let totalChanges: Int64
}
""")
replace_once(path,
"""            do {
                var results: [SOOYARunResult] = []
                results.reserveCapacity(statements.count)
                for statement in statements {
                    results.append(
                        try runLocked(connection, sql: statement.sql, values: statement.values)
                    )
                }
                try executeTransactionControlLocked(connection, sql: \"COMMIT\")
""",
"""            do {
                var results: [Any] = []
                results.reserveCapacity(statements.count)
                for statement in statements {
                    switch statement.type {
                    case \"execute\":
                        try validateSQL(statement.sql)
                        let beforeStatement = Int64(sqlite3_total_changes(connection))
                        let code = sqlite3_exec(connection, statement.sql, nil, nil, nil)
                        guard code == SQLITE_OK else {
                            throw sqliteError(connection, operation: \"execute\", fallbackCode: code)
                        }
                        results.append([
                            \"changes\": Int64(sqlite3_changes(connection)),
                            \"totalChanges\": Int64(sqlite3_total_changes(connection)) - beforeStatement
                        ])
                    case \"run\":
                        results.append(try runLocked(connection, sql: statement.sql, values: statement.values).bridgeObject)
                    case \"query\":
                        results.append(try queryLocked(connection, sql: statement.sql, values: statement.values, requireReadOnly: true).bridgeObject)
                    default:
                        throw SOOYADatabaseError.invalidRequest
                    }
                }
                try executeTransactionControlLocked(connection, sql: \"COMMIT\")
""")
replace_once(path,
"""                let rawValues = object[\"values\"] as? JSArray
                return SOOYASQLStatement(sql: sql, values: try self.values(from: rawValues))
""",
"""                let rawValues = object[\"values\"] as? JSArray
                let type = object[\"type\"] as? String ?? \"run\"
                return SOOYASQLStatement(type: type, sql: sql, values: try self.values(from: rawValues))
""")
replace_once(path,
"""private extension SOOYATransactionResult {
    var bridgeObject: [String: Any] {
        [\"results\": results.map(\\.bridgeObject), \"totalChanges\": totalChanges]
    }
}
""",
"""private extension SOOYATransactionResult {
    var bridgeObject: [String: Any] {
        [\"results\": results, \"totalChanges\": totalChanges]
    }
}
""")

# 3) Persist media kind and keep older sidecars readable.
path = "ios/App/App/Plugins/SOOYAMediaPlugin.swift"
replace_once(path,
"""struct SOOYAMediaMetadata: Codable, Equatable {
    let id: String
    let mimeType: String
""",
"""struct SOOYAMediaMetadata: Codable, Equatable {
    let id: String
    var kind: String? = nil
    let mimeType: String
""")
replace_once(path,
"""    func save(data: Data,
              mimeType: String,
              originalName: String? = nil,
              sourceID: String? = nil) throws -> SOOYAMediaMetadata {
""",
"""    func save(data: Data,
              mimeType: String,
              originalName: String? = nil,
              sourceID: String? = nil,
              kind: String? = nil) throws -> SOOYAMediaMetadata {
""")
replace_once(path,
"""        let metadata = SOOYAMediaMetadata(
            id: id,
            mimeType: normalizedMime,
""",
"""        var metadata = SOOYAMediaMetadata(
            id: id,
            mimeType: normalizedMime,
""")
replace_once(path,
"""            sourceID: sourceID
        )

        lock.lock(); defer { lock.unlock() }
""",
"""            sourceID: sourceID
        )
        metadata.kind = kind

        lock.lock(); defer { lock.unlock() }
""")
replace_once(path,
"""                call.resolve(self.encode(try self.store.save(data: data, mimeType: mime, originalName: call.getString(\"name\"))))
""",
"""                call.resolve(self.encode(try self.store.save(data: data, mimeType: mime, originalName: call.getString(\"name\"), kind: call.getString(\"kind\"))))
""")
replace_once(path,
"""            \"id\": value.id,
            \"mimeType\": value.mimeType,
""",
"""            \"id\": value.id,
            \"kind\": value.kind.map { $0 as Any } ?? NSNull(),
            \"mimeType\": value.mimeType,
""")

# 4) Fail closed when Keychain access-group discovery fails instead of using a fake TEAMID.
path = "ios/App/App/Plugins/SOOYASecretsPlugin.swift"
replace_once(path,
"""    private lazy var store: SOOYAKeychainStore = {
        let resolver = SOOYAKeychainAccessGroupResolver()
        // The default group for this bundle is stable per install; resolve
        // once lazily. Failures surface through the plugin as generic errors
        // without leaking the probe account or any secret.
        let group = (try? resolver.resolve()) ?? \"TEAMID.com.sooya.app\"
        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))
    }()
""",
"""    private lazy var storeResult: Result<SOOYAKeychainStore, Error> = Result {
        let group = try SOOYAKeychainAccessGroupResolver().resolve()
        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))
    }

    private func requireStore() throws -> SOOYAKeychainStore { try storeResult.get() }
""")
replace_once(path, "try store.has(key: key)", "try requireStore().has(key: key)")
replace_once(path, "try store.set(key: key, value: value)", "try requireStore().set(key: key, value: value)")
replace_once(path, "try store.delete(key: key)", "try requireStore().delete(key: key)")

path = "ios/App/App/Plugins/SOOYAHttpPlugin.swift"
replace_once(path,
"""    private lazy var secretStore: SOOYAKeychainStore = {
        let group = (try? SOOYAKeychainAccessGroupResolver().resolve()) ?? \"TEAMID.com.sooya.app\"
        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))
    }()
""",
"""    private lazy var secretStoreResult: Result<SOOYAKeychainStore, Error> = Result {
        let group = try SOOYAKeychainAccessGroupResolver().resolve()
        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))
    }
""")
replace_once(path,
"""            guard let secret = try secretStore.read(key: secretRef), !secret.isEmpty else {
""",
"""            guard let secret = try secretStoreResult.get().read(key: secretRef), !secret.isEmpty else {
""")

path = "ios/App/App/Plugins/SOOYAMcpPlugin.swift"
replace_once(path,
"""final class SOOYAKeychainMcpTokenResolver: SOOYAMcpTokenResolving {
    private lazy var store: SOOYAKeychainStore = {
        let group = (try? SOOYAKeychainAccessGroupResolver().resolve()) ?? \"TEAMID.com.sooya.app\"
        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))
    }()

    func token(for reference: String, serverID: String, kind: SOOYAMcpAuthKind) throws -> String? {
        try store.read(key: reference)
    }
}
""",
"""final class SOOYAKeychainMcpTokenResolver: SOOYAMcpTokenResolving {
    private lazy var storeResult: Result<SOOYAKeychainStore, Error> = Result {
        let group = try SOOYAKeychainAccessGroupResolver().resolve()
        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))
    }

    func token(for reference: String, serverID: String, kind: SOOYAMcpAuthKind) throws -> String? {
        try storeResult.get().read(key: reference)
    }
}
""")

# 5) Native Base 7: Swift bridge contract changed. OTA is gated to this base later.
Path("ios/App/App/native-base.version").write_text("7\n")
path = "ios/App/App/Plugins/SOOYAReleaseConfig.swift"
replace_once(path, "static let nativeBaseVersion = 6", "static let nativeBaseVersion = 7")
replace_once(path, "static let bridgeVersion = 3", "static let bridgeVersion = 4")

# 6) Tighten contract tests so CI catches the exact bugs that escaped before.
Path("packages/web/src/local/nativeDatabaseContract.test.ts").write_text(r'''import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CapacitorDatabase, databaseTransactionCallOptions } from './nativeBoot.js';

describe('SOOYADatabase bridge contract', () => {
  it('preserves operation types and encodes binary/int64 values for Swift', () => {
    const options = databaseTransactionCallOptions([
      { type: 'execute', sql: 'CREATE TABLE t(v BLOB)' },
      { type: 'run', sql: 'INSERT INTO t(v) VALUES (?)', values: [new Uint8Array([1, 2]), 9_007_199_254_740_993n] },
      { type: 'query', sql: 'SELECT v FROM t' }
    ]);
    expect(options.statements.map((value) => value.type)).toEqual(['execute', 'run', 'query']);
    expect(options.statements[1]?.values).toEqual([
      { type: 'blob', base64: 'AQI=' },
      { type: 'int64', value: '9007199254740993' }
    ]);
  });

  it('Swift transaction dispatches execute/run/query instead of treating every statement as run', () => {
    const swift = readFileSync(path.resolve('../../ios/App/App/Plugins/SOOYADatabasePlugin.swift'), 'utf8');
    expect(swift).toContain('let type = object["type"] as? String ?? "run"');
    expect(swift).toContain('case "execute":');
    expect(swift).toContain('case "query":');
    expect(swift).toContain('sqlite3_exec(connection, statement.sql');
  });

  it('query envelope and row values are normalized by the web adapter', async () => {
    const database = Object.create(CapacitorDatabase.prototype) as CapacitorDatabase & { plugin: unknown };
    Object.defineProperty(database, 'plugin', { value: {
      call: async () => ({ rows: [{ id: { type: 'int64', value: '9007199254740993' }, payload: { type: 'blob', base64: 'AQI=' } }] })
    }});
    const rows = await database.query<{ id: bigint; payload: Uint8Array }>('SELECT id,payload FROM t');
    expect(rows[0]?.id).toBe(9_007_199_254_740_993n);
    expect(Array.from(rows[0]?.payload ?? [])).toEqual([1, 2]);
  });
});
''')

Path("packages/web/src/local/nativeMediaContract.test.ts").write_text(r'''import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CapacitorMedia } from './nativeBoot.js';

describe('SOOYAMedia bridge contract', () => {
  it('uses the Swift mimeType field and normalizes metadata/read/delete envelopes', async () => {
    const calls: Array<{ method: string; options: Record<string, unknown> }> = [];
    const media = Object.create(CapacitorMedia.prototype) as CapacitorMedia & { plugin: unknown };
    Object.defineProperty(media, 'plugin', { value: {
      call: async (method: string, options: Record<string, unknown>) => {
        calls.push({ method, options });
        if (method === 'save') return { id: 'm1', kind: 'sticker', mimeType: 'image/webp', bytes: 2, originalName: 'x.webp' };
        if (method === 'read') return { metadata: { id: 'm1', kind: 'sticker', mimeType: 'image/webp', bytes: 2, originalName: 'x.webp' }, dataBase64: 'AQI=' };
        if (method === 'delete') return { deleted: true };
        return {};
      }
    }});
    expect((await media.save({ kind: 'sticker', mime: 'image/webp', name: 'x.webp', data: new Uint8Array([1, 2]) })).kind).toBe('sticker');
    expect(calls[0]?.options.mimeType).toBe('image/webp');
    expect((await media.read('m1'))?.record.mime).toBe('image/webp');
    expect(await media.remove('m1')).toBe(true);
  });

  it('persists media kind in native sidecars while remaining optional for older files', () => {
    const swift = readFileSync(path.resolve('../../ios/App/App/Plugins/SOOYAMediaPlugin.swift'), 'utf8');
    expect(swift).toContain('var kind: String? = nil');
    expect(swift).toContain('kind: call.getString("kind")');
  });
});
''')

print('native contracts repaired')
