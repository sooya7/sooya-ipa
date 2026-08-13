import Foundation
import Capacitor
import ZIPFoundation
import CryptoKit

/// Sandboxed archive bridge used by migration, backup and OTA staging. The
/// archive format is handled natively so large media never crosses JS.
@objc(SOOYAArchivePlugin)
public final class SOOYAArchivePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SOOYAArchivePlugin"
    public let jsName = "SOOYAArchive"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "extract", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanup", returnType: CAPPluginReturnPromise)
    ]

    private let fileManager = FileManager.default
    private let maxFiles = 10_000
    private let maxBytes: UInt64 = 512 * 1_024 * 1_024

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
            return ["name": archiveName, "bytes": info.bytes, "fileCount": info.fileCount, "sha256": self.sha256(archive)]
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
            let staging = destination.deletingLastPathComponent().appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
            try self.fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
            defer { try? self.fileManager.removeItem(at: staging) }
            guard let source = Archive(url: archive, accessMode: .read) else { throw ArchiveError.invalidArchive }
            for entry in source {
                try self.validateEntry(entry.path)
                let target = staging.appendingPathComponent(entry.path)
                if entry.type == .directory {
                    try self.fileManager.createDirectory(at: target, withIntermediateDirectories: true)
                } else {
                    try self.fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try source.extract(entry, to: target)
                }
            }
            if self.fileManager.fileExists(atPath: destination.path) { try self.fileManager.removeItem(at: destination) }
            try self.fileManager.moveItem(at: staging, to: destination)
            return ["path": destinationName, "bytes": inspected.bytes, "fileCount": inspected.fileCount, "sha256": self.sha256(archive)]
        }
    }

    @objc public func verify(_ call: CAPPluginCall) {
        resolve(call) {
            let archiveName = try self.safeRelative(call.getString("archiveName"))
            let archive = try self.resolveRelative(archiveName)
            let inspected = try self.inspect(archive)
            if let expected = call.getString("sha256"), expected.lowercased() != self.sha256(archive) { throw ArchiveError.checksumMismatch }
            return ["name": archiveName, "bytes": inspected.bytes, "fileCount": inspected.fileCount, "sha256": self.sha256(archive), "verified": true]
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

    private func inspect(_ url: URL) throws -> (bytes: UInt64, fileCount: Int) {
        guard let archive = Archive(url: url, accessMode: .read) else { throw ArchiveError.invalidArchive }
        var total: UInt64 = 0
        var files = 0
        for entry in archive {
            try validateEntry(entry.path)
            if entry.type == .file {
                files += 1
                total = total.addingReportingOverflow(entry.uncompressedSize).partialValue
                if files > maxFiles || total > maxBytes { throw ArchiveError.archiveTooLarge }
            }
        }
        return (total, files)
    }

    private func resolveRelative(_ value: String?) throws -> URL {
        let relative = try safeRelative(value)
        let root = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("SOOYA", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        let url = root.appendingPathComponent(relative).standardizedFileURL
        guard url.path.hasPrefix(root.standardizedFileURL.path + "/") else { throw ArchiveError.unsafePath }
        return url
    }

    private func safeRelative(_ value: String?) throws -> String {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty, raw.utf8.count <= 300,
              !raw.hasPrefix("/"), !raw.contains("\\"), !raw.split(separator: "/").contains(where: { $0 == ".." }), !raw.contains(":") else { throw ArchiveError.unsafePath }
        return raw
    }

    private func validateEntry(_ value: String) throws {
        _ = try safeRelative(value.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
    }

    private func sha256(_ url: URL) -> String {
        guard let data = try? Data(contentsOf: url) else { return "" }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func resolve(_ call: CAPPluginCall, operation: () throws -> [String: Any]) {
        do { call.resolve(try operation()) }
        catch let error as ArchiveError { call.reject(error.localizedDescription, error.code) }
        catch { call.reject("Archive operation failed", "ARCHIVE_FAILED") }
    }
}

private enum ArchiveError: Error, LocalizedError {
    case unsafePath, sourceMissing, archiveMissing, destinationExists, invalidArchive, archiveTooLarge, checksumMismatch
    var code: String {
        switch self { case .unsafePath: return "ARCHIVE_UNSAFE_PATH"; case .sourceMissing: return "ARCHIVE_SOURCE_MISSING"; case .archiveMissing: return "ARCHIVE_MISSING"; case .destinationExists: return "ARCHIVE_DESTINATION_EXISTS"; case .invalidArchive: return "ARCHIVE_INVALID"; case .archiveTooLarge: return "ARCHIVE_TOO_LARGE"; case .checksumMismatch: return "ARCHIVE_CHECKSUM_MISMATCH" }
    }
    var errorDescription: String? { code }
}
