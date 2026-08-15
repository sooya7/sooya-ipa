import Foundation
import Capacitor
import ZIPFoundation
import CryptoKit
import UIKit
import UniformTypeIdentifiers
import Security

private struct SOOYAFullBackupManifest: Codable {
    let format: String
    let createdAt: String
    let schemaVersion: Int
    let mediaIncluded: Bool
    let secretsIncluded: Bool
    let databaseFile: String
}

private struct SOOYAEncryptedSecretsEnvelope: Codable {
    let format: String
    let kdf: String
    let iterations: Int
    let salt: String
    let combined: String
}

private struct SOOYAPreparedFullImport {
    let importRoot: URL
    let incomingArchive: URL
    let restoreName: String
    let mediaIncluded: Bool
    let secrets: [String: String]?
}

/// Sandboxed archive bridge used by migration, backup and OTA staging. Large
/// media stays native-side. Full backup adds a system document picker, database
/// snapshot + Media packaging and optional password-encrypted Keychain export.
@objc(SOOYAArchivePlugin)
public final class SOOYAArchivePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "SOOYAArchivePlugin"
    public let jsName = "SOOYAArchive"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "extract", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createFullBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFullBackup", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareFullImport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "commitFullImport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abortFullImport", returnType: CAPPluginReturnPromise)
    ]

    private let fileManager = FileManager.default
    private let maxFiles = 10_000
    private let maxBytes: UInt64 = 512 * 1_024 * 1_024
    private let passwordIterations = 100_000
    private let preparedLock = NSLock()
    private var preparedImports: [String: SOOYAPreparedFullImport] = [:]
    private var pendingPickerCall: CAPPluginCall?

    @objc public func create(_ call: CAPPluginCall) {
        resolve(call) {
            let source = try self.resolveRelative(call.getString("sourcePath"))
            let archiveName = try self.safeRelative(call.getString("archiveName"))
            let archive = try self.resolveRelative(archiveName)
            guard self.fileManager.fileExists(atPath: source.path) else { throw ArchiveError.sourceMissing }
            guard !self.fileManager.fileExists(atPath: archive.path) else { throw ArchiveError.destinationExists }
            try self.fileManager.createDirectory(at: archive.deletingLastPathComponent(), withIntermediateDirectories: true)
            try self.fileManager.zipItem(at: source, to: archive, shouldKeepParent: false, compressionMethod: .deflate)
            let info = try self.inspect(archive)
            return ["name": archiveName, "bytes": info.bytes, "fileCount": info.fileCount, "sha256": try self.sha256File(archive)]
        }
    }

    @objc public func extract(_ call: CAPPluginCall) {
        resolve(call) {
            let archiveName = try self.safeRelative(call.getString("archiveName"))
            let destinationName = try self.safeRelative(call.getString("destinationPath"))
            let archive = try self.resolveRelative(archiveName)
            let destination = try self.resolveRelative(destinationName)
            guard self.fileManager.fileExists(atPath: archive.path) else { throw ArchiveError.archiveMissing }
            let inspected = try self.inspect(archive)
            try self.extractArchive(archive, to: destination)
            return ["path": destinationName, "bytes": inspected.bytes, "fileCount": inspected.fileCount, "sha256": try self.sha256File(archive)]
        }
    }

    @objc public func verify(_ call: CAPPluginCall) {
        resolve(call) {
            let archiveName = try self.safeRelative(call.getString("archiveName"))
            let archive = try self.resolveRelative(archiveName)
            let inspected = try self.inspect(archive)
            let actual = try self.sha256File(archive)
            if let expected = call.getString("sha256"), expected.lowercased() != actual { throw ArchiveError.checksumMismatch }
            return ["name": archiveName, "bytes": inspected.bytes, "fileCount": inspected.fileCount, "sha256": actual, "verified": true]
        }
    }

    @objc public func cleanup(_ call: CAPPluginCall) {
        resolve(call) {
            let relative = try self.safeRelative(call.getString("path"))
            let url = try self.resolveRelative(relative)
            if self.fileManager.fileExists(atPath: url.path) { try self.fileManager.removeItem(at: url) }
            return ["removed": true, "path": relative]
        }
    }

    @objc public func createFullBackup(_ call: CAPPluginCall) {
        resolveAsync(call) {
            let schemaVersion = call.getInt("schemaVersion") ?? 0
            let includeSecrets = call.getBool("includeSecrets") ?? false
            let password = call.getString("password") ?? ""
            guard schemaVersion > 0 else { throw ArchiveError.invalidBackupPackage }
            if includeSecrets && password.count < 10 { throw ArchiveError.backupPasswordRequired }
            return try self.makeFullBackup(schemaVersion: schemaVersion, includeSecrets: includeSecrets, password: password)
        }
    }

    @objc public func pickFullBackup(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pendingPickerCall == nil else {
                call.reject("A backup picker is already open", ArchiveError.pickerBusy.code)
                return
            }
            guard let presenting = self.bridge?.viewController else {
                call.reject("Native document picker is unavailable", ArchiveError.pickerUnavailable.code)
                return
            }
            self.pendingPickerCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.zip], asCopy: true)
            picker.delegate = self
            picker.allowsMultipleSelection = false
            presenting.present(picker, animated: true)
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let call = pendingPickerCall else { return }
        pendingPickerCall = nil
        call.resolve(["cancelled": true])
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingPickerCall else { return }
        pendingPickerCall = nil
        guard let source = urls.first else {
            call.resolve(["cancelled": true])
            return
        }
        let scoped = source.startAccessingSecurityScopedResource()
        resolveAsync(call) {
            defer { if scoped { source.stopAccessingSecurityScopedResource() } }
            let root = try self.rootURL()
            let imports = root.appendingPathComponent("imports", isDirectory: true)
            try self.fileManager.createDirectory(at: imports, withIntermediateDirectories: true)
            let relative = "imports/incoming-\(UUID().uuidString.lowercased()).zip"
            let destination = try self.resolveRelative(relative)
            let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true else { throw ArchiveError.invalidBackupPackage }
            let bytes = UInt64(max(0, values.fileSize ?? 0))
            guard bytes <= self.maxBytes else { throw ArchiveError.archiveTooLarge }
            try self.fileManager.copyItem(at: source, to: destination)
            return ["archiveName": relative, "displayName": source.lastPathComponent, "bytes": bytes]
        }
    }

    @objc public func prepareFullImport(_ call: CAPPluginCall) {
        resolveAsync(call) {
            guard let archiveName = call.getString("archiveName") else { throw ArchiveError.invalidBackupPackage }
            let currentSchemaVersion = call.getInt("currentSchemaVersion") ?? 0
            let password = call.getString("password") ?? ""
            return try self.prepareFullImport(archiveName: archiveName, currentSchemaVersion: currentSchemaVersion, password: password)
        }
    }

    @objc public func commitFullImport(_ call: CAPPluginCall) {
        resolveAsync(call) {
            guard let importId = call.getString("importId") else { throw ArchiveError.importNotPrepared }
            return try self.commitFullImport(importId: importId)
        }
    }

    @objc public func abortFullImport(_ call: CAPPluginCall) {
        resolveAsync(call) {
            guard let importId = call.getString("importId") else { throw ArchiveError.importNotPrepared }
            self.preparedLock.lock()
            let prepared = self.preparedImports.removeValue(forKey: importId)
            self.preparedLock.unlock()
            if let prepared { self.cleanupPreparedImport(prepared) }
            return ["aborted": true, "importId": importId]
        }
    }

    private func makeFullBackup(schemaVersion: Int, includeSecrets: Bool, password: String) throws -> [String: Any] {
        let root = try rootURL()
        let exports = root.appendingPathComponent("exports", isDirectory: true)
        try fileManager.createDirectory(at: exports, withIntermediateDirectories: true)
        let staging = root.appendingPathComponent(".full-export-\(UUID().uuidString.lowercased())", isDirectory: true)
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: staging) }

        let databaseStore = SOOYADatabaseStore()
        _ = try databaseStore.open()
        let snapshotName = SOOYADatabaseStore.generatedBackupName(prefix: "full-export")
        let snapshot: SOOYABackupInfo
        do {
            snapshot = try databaseStore.backup(named: snapshotName)
            try databaseStore.close()
        } catch {
            try? databaseStore.close()
            throw error
        }
        defer { try? fileManager.removeItem(at: snapshot.fileURL) }
        try fileManager.copyItem(at: snapshot.fileURL, to: staging.appendingPathComponent("database.sqlite3", isDirectory: false))

        let stagedMedia = staging.appendingPathComponent("Media", isDirectory: true)
        try fileManager.createDirectory(at: stagedMedia, withIntermediateDirectories: true)
        let mediaRoot = root.appendingPathComponent("Media", isDirectory: true)
        for name in ["objects", "metadata"] {
            let source = mediaRoot.appendingPathComponent(name, isDirectory: true)
            let destination = stagedMedia.appendingPathComponent(name, isDirectory: true)
            if fileManager.fileExists(atPath: source.path) {
                try fileManager.copyItem(at: source, to: destination)
            } else {
                try fileManager.createDirectory(at: destination, withIntermediateDirectories: true)
            }
        }

        let createdAt = ISO8601DateFormatter().string(from: Date())
        let manifest = SOOYAFullBackupManifest(
            format: "sooya-full-backup/v1",
            createdAt: createdAt,
            schemaVersion: schemaVersion,
            mediaIncluded: true,
            secretsIncluded: includeSecrets,
            databaseFile: "database.sqlite3"
        )
        try JSONEncoder().encode(manifest).write(to: staging.appendingPathComponent("manifest.json"), options: .atomic)

        if includeSecrets {
            let secrets = try readAllSecrets()
            let encrypted = try encryptSecrets(secrets, password: password)
            try encrypted.write(to: staging.appendingPathComponent("secrets.enc.json"), options: .atomic)
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let fileName = "SOOYA-backup-\(formatter.string(from: Date()))-\(UUID().uuidString.lowercased().prefix(8)).zip"
        let relative = "exports/\(fileName)"
        let archive = exports.appendingPathComponent(fileName, isDirectory: false)
        do {
            try fileManager.zipItem(at: staging, to: archive, shouldKeepParent: false, compressionMethod: .deflate)
            let info = try inspect(archive)
            return [
                "name": fileName,
                "path": relative,
                "url": archive.absoluteString,
                "bytes": try fileSize(archive),
                "fileCount": info.fileCount,
                "sha256": try sha256File(archive),
                "secretsIncluded": includeSecrets
            ]
        } catch {
            try? fileManager.removeItem(at: archive)
            throw error
        }
    }

    private func prepareFullImport(archiveName: String, currentSchemaVersion: Int, password: String) throws -> [String: Any] {
        guard currentSchemaVersion > 0 else { throw ArchiveError.invalidBackupPackage }
        let incoming = try resolveRelative(archiveName)
        guard fileManager.fileExists(atPath: incoming.path) else { throw ArchiveError.archiveMissing }
        _ = try inspect(incoming)

        let importId = UUID().uuidString.lowercased()
        let root = try rootURL()
        let importRoot = root.appendingPathComponent("imports/\(importId)", isDirectory: true)
        let payload = importRoot.appendingPathComponent("payload", isDirectory: true)
        var restoreURL: URL?
        do {
            try fileManager.createDirectory(at: importRoot, withIntermediateDirectories: true)
            try extractArchive(incoming, to: payload)

            let manifestURL = payload.appendingPathComponent("manifest.json", isDirectory: false)
            let manifest = try JSONDecoder().decode(SOOYAFullBackupManifest.self, from: Data(contentsOf: manifestURL))
            guard manifest.format == "sooya-full-backup/v1",
                  manifest.schemaVersion > 0,
                  manifest.schemaVersion <= currentSchemaVersion,
                  manifest.databaseFile == "database.sqlite3",
                  manifest.mediaIncluded else {
                if manifest.schemaVersion > currentSchemaVersion { throw ArchiveError.backupSchemaTooNew }
                throw ArchiveError.invalidBackupPackage
            }

            let database = payload.appendingPathComponent(manifest.databaseFile, isDirectory: false)
            let databaseValues = try database.resourceValues(forKeys: [.isRegularFileKey])
            guard databaseValues.isRegularFile == true else { throw ArchiveError.invalidBackupPackage }
            let media = payload.appendingPathComponent("Media", isDirectory: true)
            guard fileManager.fileExists(atPath: media.path) else { throw ArchiveError.invalidBackupPackage }

            let backups = root.appendingPathComponent("backups", isDirectory: true)
            try fileManager.createDirectory(at: backups, withIntermediateDirectories: true)
            let restoreName = "import-\(importId).sqlite3"
            let destination = backups.appendingPathComponent(restoreName, isDirectory: false)
            restoreURL = destination
            try fileManager.copyItem(at: database, to: destination)

            var secrets: [String: String]?
            if manifest.secretsIncluded {
                guard password.count >= 10 else { throw ArchiveError.backupPasswordRequired }
                let encryptedURL = payload.appendingPathComponent("secrets.enc.json", isDirectory: false)
                guard fileManager.fileExists(atPath: encryptedURL.path) else { throw ArchiveError.invalidBackupPackage }
                secrets = try decryptSecrets(Data(contentsOf: encryptedURL), password: password)
            }

            let prepared = SOOYAPreparedFullImport(
                importRoot: importRoot,
                incomingArchive: incoming,
                restoreName: restoreName,
                mediaIncluded: manifest.mediaIncluded,
                secrets: secrets
            )
            preparedLock.lock()
            preparedImports[importId] = prepared
            preparedLock.unlock()
            return [
                "importId": importId,
                "restoreName": restoreName,
                "createdAt": manifest.createdAt,
                "schemaVersion": manifest.schemaVersion,
                "mediaIncluded": manifest.mediaIncluded,
                "secretsIncluded": manifest.secretsIncluded
            ]
        } catch {
            if let restoreURL { try? fileManager.removeItem(at: restoreURL) }
            try? fileManager.removeItem(at: importRoot)
            throw error
        }
    }

    private func commitFullImport(importId: String) throws -> [String: Any] {
        preparedLock.lock()
        guard let prepared = preparedImports[importId] else {
            preparedLock.unlock()
            throw ArchiveError.importNotPrepared
        }
        preparedLock.unlock()

        let root = try rootURL()
        let sourceMedia = prepared.importRoot.appendingPathComponent("payload/Media", isDirectory: true)
        let targetMedia = root.appendingPathComponent("Media", isDirectory: true)
        let rollbackMedia = prepared.importRoot.appendingPathComponent("rollback-Media", isDirectory: true)
        var movedCurrentMedia = false
        var installedImportedMedia = false

        do {
            if prepared.mediaIncluded {
                guard fileManager.fileExists(atPath: sourceMedia.path) else { throw ArchiveError.invalidBackupPackage }
                if fileManager.fileExists(atPath: rollbackMedia.path) { try fileManager.removeItem(at: rollbackMedia) }
                if fileManager.fileExists(atPath: targetMedia.path) {
                    try fileManager.moveItem(at: targetMedia, to: rollbackMedia)
                    movedCurrentMedia = true
                }
                try fileManager.moveItem(at: sourceMedia, to: targetMedia)
                installedImportedMedia = true
            }

            if let secrets = prepared.secrets { try applySecretsWithRollback(secrets) }

            if fileManager.fileExists(atPath: rollbackMedia.path) { try? fileManager.removeItem(at: rollbackMedia) }
            preparedLock.lock()
            preparedImports.removeValue(forKey: importId)
            preparedLock.unlock()
            cleanupPreparedImport(prepared)
            return ["importId": importId, "committed": true, "secretCount": prepared.secrets?.count ?? 0]
        } catch {
            if installedImportedMedia && fileManager.fileExists(atPath: targetMedia.path) {
                try? fileManager.removeItem(at: targetMedia)
            }
            if movedCurrentMedia && fileManager.fileExists(atPath: rollbackMedia.path) {
                try? fileManager.moveItem(at: rollbackMedia, to: targetMedia)
            }
            throw error
        }
    }

    private func cleanupPreparedImport(_ prepared: SOOYAPreparedFullImport) {
        let root = try? rootURL()
        if fileManager.fileExists(atPath: prepared.importRoot.path) { try? fileManager.removeItem(at: prepared.importRoot) }
        if fileManager.fileExists(atPath: prepared.incomingArchive.path) { try? fileManager.removeItem(at: prepared.incomingArchive) }
        if let root {
            let restore = root.appendingPathComponent("backups/\(prepared.restoreName)", isDirectory: false)
            if fileManager.fileExists(atPath: restore.path) { try? fileManager.removeItem(at: restore) }
        }
    }

    private func extractArchive(_ archiveURL: URL, to destination: URL) throws {
        let inspected = try inspect(archiveURL)
        guard inspected.fileCount <= maxFiles, inspected.bytes <= maxBytes else { throw ArchiveError.archiveTooLarge }
        let staging = destination.deletingLastPathComponent().appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: staging) }
        guard let source = Archive(url: archiveURL, accessMode: .read) else { throw ArchiveError.invalidArchive }
        for entry in source {
            try validateEntry(entry.path)
            guard entry.type == .file || entry.type == .directory else { throw ArchiveError.invalidArchive }
            let target = staging.appendingPathComponent(entry.path)
            if entry.type == .directory {
                try fileManager.createDirectory(at: target, withIntermediateDirectories: true)
            } else {
                try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try source.extract(entry, to: target)
            }
        }
        if fileManager.fileExists(atPath: destination.path) { try fileManager.removeItem(at: destination) }
        try fileManager.moveItem(at: staging, to: destination)
    }

    private func inspect(_ url: URL) throws -> (bytes: UInt64, fileCount: Int) {
        guard let archive = Archive(url: url, accessMode: .read) else { throw ArchiveError.invalidArchive }
        var total: UInt64 = 0
        var files = 0
        for entry in archive {
            try validateEntry(entry.path)
            guard entry.type == .file || entry.type == .directory else { throw ArchiveError.invalidArchive }
            if entry.type == .file {
                files += 1
                let result = total.addingReportingOverflow(entry.uncompressedSize)
                guard !result.overflow else { throw ArchiveError.archiveTooLarge }
                total = result.partialValue
                if files > maxFiles || total > maxBytes { throw ArchiveError.archiveTooLarge }
            }
        }
        return (total, files)
    }

    private func rootURL() throws -> URL {
        let root = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("SOOYA", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        return root.standardizedFileURL
    }

    private func resolveRelative(_ value: String?) throws -> URL {
        let relative = try safeRelative(value)
        let root = try rootURL()
        let url = root.appendingPathComponent(relative).standardizedFileURL
        guard url.path.hasPrefix(root.path + "/") else { throw ArchiveError.unsafePath }
        return url
    }

    private func safeRelative(_ value: String?) throws -> String {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty, raw.utf8.count <= 300,
              !raw.hasPrefix("/"), !raw.contains("\\"), !raw.split(separator: "/").contains(where: { $0 == ".." }), !raw.contains(":") else { throw ArchiveError.unsafePath }
        return raw
    }

    private func validateEntry(_ value: String) throws {
        let trimmed = value.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmed.isEmpty else { return }
        _ = try safeRelative(trimmed)
    }

    private func fileSize(_ url: URL) throws -> UInt64 {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        return UInt64(max(0, values.fileSize ?? 0))
    }

    private func sha256File(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1_024 * 1_024) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func randomBytes(count: Int) throws -> Data {
        var data = Data(count: count)
        let status = data.withUnsafeMutableBytes { rawBuffer -> Int32 in
            guard let base = rawBuffer.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, count, base)
        }
        guard status == errSecSuccess else { throw ArchiveError.keychainFailed }
        return data
    }

    private func derivePasswordKey(password: String, salt: Data, iterations: Int) -> SymmetricKey {
        let passwordData = Data(password.utf8)
        var initial = Data()
        initial.append(passwordData)
        initial.append(salt)
        var digest = Data(SHA256.hash(data: initial))
        if iterations > 1 {
            for _ in 1..<iterations {
                var block = Data()
                block.append(digest)
                block.append(passwordData)
                block.append(salt)
                digest = Data(SHA256.hash(data: block))
            }
        }
        return SymmetricKey(data: digest)
    }

    private func encryptSecrets(_ secrets: [String: String], password: String) throws -> Data {
        let plain = try JSONEncoder().encode(secrets)
        let salt = try randomBytes(count: 16)
        let key = derivePasswordKey(password: password, salt: salt, iterations: passwordIterations)
        let sealed = try AES.GCM.seal(plain, using: key)
        guard let combined = sealed.combined else { throw ArchiveError.secretEncryptionFailed }
        let envelope = SOOYAEncryptedSecretsEnvelope(
            format: "sooya-secrets/v1",
            kdf: "sha256-iter-v1",
            iterations: passwordIterations,
            salt: salt.base64EncodedString(),
            combined: combined.base64EncodedString()
        )
        return try JSONEncoder().encode(envelope)
    }

    private func decryptSecrets(_ data: Data, password: String) throws -> [String: String] {
        do {
            let envelope = try JSONDecoder().decode(SOOYAEncryptedSecretsEnvelope.self, from: data)
            guard envelope.format == "sooya-secrets/v1",
                  envelope.kdf == "sha256-iter-v1",
                  (10_000...500_000).contains(envelope.iterations),
                  let salt = Data(base64Encoded: envelope.salt),
                  let combined = Data(base64Encoded: envelope.combined) else { throw ArchiveError.invalidBackupPackage }
            let key = derivePasswordKey(password: password, salt: salt, iterations: envelope.iterations)
            let box = try AES.GCM.SealedBox(combined: combined)
            let plain = try AES.GCM.open(box, using: key)
            return try JSONDecoder().decode([String: String].self, from: plain)
        } catch let error as ArchiveError {
            throw error
        } catch {
            throw ArchiveError.backupPasswordIncorrect
        }
    }

    private func readAllSecrets() throws -> [String: String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: SOOYAKeychainIdentity.service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true
        ]
        var raw: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &raw)
        if status == errSecItemNotFound { return [:] }
        guard status == errSecSuccess else { throw ArchiveError.keychainFailed }

        let items: [[String: Any]]
        if let array = raw as? [[String: Any]] { items = array }
        else if let item = raw as? [String: Any] { items = [item] }
        else { throw ArchiveError.keychainFailed }

        var result: [String: String] = [:]
        for item in items {
            guard let key = item[kSecAttrAccount as String] as? String,
                  let data = item[kSecValueData as String] as? Data,
                  let value = String(data: data, encoding: .utf8) else { continue }
            result[key] = value
        }
        return result
    }

    private func applySecretsWithRollback(_ secrets: [String: String]) throws {
        let store = SOOYAKeychainStore()
        var previous: [String: String] = [:]
        var missing = Set<String>()
        for key in secrets.keys {
            if let value = try store.read(key: key) { previous[key] = value }
            else { missing.insert(key) }
        }
        do {
            for key in secrets.keys.sorted() {
                guard let value = secrets[key] else { continue }
                try store.set(key: key, value: value)
            }
        } catch {
            for key in secrets.keys {
                if let value = previous[key] { try? store.set(key: key, value: value) }
                else if missing.contains(key) { try? store.delete(key: key) }
            }
            throw ArchiveError.keychainFailed
        }
    }

    private func resolve(_ call: CAPPluginCall, operation: () throws -> [String: Any]) {
        do { call.resolve(try operation()) }
        catch let error as ArchiveError { call.reject(error.localizedDescription, error.code) }
        catch { call.reject("Archive operation failed", "ARCHIVE_FAILED") }
    }

    private func resolveAsync(_ call: CAPPluginCall, operation: @escaping () throws -> [String: Any]) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let value = try operation()
                DispatchQueue.main.async { call.resolve(value) }
            } catch let error as ArchiveError {
                DispatchQueue.main.async { call.reject(error.localizedDescription, error.code) }
            } catch {
                DispatchQueue.main.async { call.reject("Archive operation failed", "ARCHIVE_FAILED") }
            }
        }
    }
}

private enum ArchiveError: Error, LocalizedError {
    case unsafePath
    case sourceMissing
    case archiveMissing
    case destinationExists
    case invalidArchive
    case archiveTooLarge
    case checksumMismatch
    case invalidBackupPackage
    case backupSchemaTooNew
    case backupPasswordRequired
    case backupPasswordIncorrect
    case secretEncryptionFailed
    case keychainFailed
    case importNotPrepared
    case pickerBusy
    case pickerUnavailable

    var code: String {
        switch self {
        case .unsafePath: return "ARCHIVE_UNSAFE_PATH"
        case .sourceMissing: return "ARCHIVE_SOURCE_MISSING"
        case .archiveMissing: return "ARCHIVE_MISSING"
        case .destinationExists: return "ARCHIVE_DESTINATION_EXISTS"
        case .invalidArchive: return "ARCHIVE_INVALID"
        case .archiveTooLarge: return "ARCHIVE_TOO_LARGE"
        case .checksumMismatch: return "ARCHIVE_CHECKSUM_MISMATCH"
        case .invalidBackupPackage: return "BACKUP_INVALID"
        case .backupSchemaTooNew: return "BACKUP_SCHEMA_TOO_NEW"
        case .backupPasswordRequired: return "BACKUP_PASSWORD_REQUIRED"
        case .backupPasswordIncorrect: return "BACKUP_PASSWORD_INCORRECT"
        case .secretEncryptionFailed: return "BACKUP_SECRET_ENCRYPTION_FAILED"
        case .keychainFailed: return "BACKUP_KEYCHAIN_FAILED"
        case .importNotPrepared: return "BACKUP_IMPORT_NOT_PREPARED"
        case .pickerBusy: return "BACKUP_PICKER_BUSY"
        case .pickerUnavailable: return "BACKUP_PICKER_UNAVAILABLE"
        }
    }

    var errorDescription: String? {
        switch self {
        case .unsafePath: return "Backup path is unsafe"
        case .sourceMissing: return "Archive source is missing"
        case .archiveMissing: return "Backup archive was not found"
        case .destinationExists: return "Archive destination already exists"
        case .invalidArchive: return "Backup archive is invalid"
        case .archiveTooLarge: return "Backup archive is too large"
        case .checksumMismatch: return "Backup checksum verification failed"
        case .invalidBackupPackage: return "这不是有效的 SOOYA 完整备份"
        case .backupSchemaTooNew: return "备份来自更新的数据版本，请先升级 SOOYA 后再导入"
        case .backupPasswordRequired: return "该备份包含加密密钥，请输入至少 10 个字符的备份密码"
        case .backupPasswordIncorrect: return "备份密码不正确或密钥区已损坏"
        case .secretEncryptionFailed: return "备份密钥加密失败"
        case .keychainFailed: return "Keychain 密钥备份或恢复失败"
        case .importNotPrepared: return "完整备份尚未准备好恢复"
        case .pickerBusy: return "备份文件选择器已经打开"
        case .pickerUnavailable: return "无法打开 iOS 文件选择器"
        }
    }
}
