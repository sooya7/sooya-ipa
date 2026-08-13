import Foundation
import CryptoKit
import ImageIO
import AVFoundation
import UniformTypeIdentifiers
import Capacitor

enum SOOYAMediaError: Error, Equatable, LocalizedError {
    case invalidID
    case invalidSource
    case notFound
    case tooLarge
    case invalidMimeType
    case unsupportedThumbnail
    case invalidThumbnailSize
    case corruptMetadata
    case fileOperationFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidID: return "Invalid media id"
        case .invalidSource: return "Invalid media source"
        case .notFound: return "Media not found"
        case .tooLarge: return "Media exceeds the configured size limit"
        case .invalidMimeType: return "Invalid media MIME type"
        case .unsupportedThumbnail: return "This media type cannot produce a thumbnail"
        case .invalidThumbnailSize: return "Invalid thumbnail size"
        case .corruptMetadata: return "Media metadata is corrupt"
        case .fileOperationFailed(let message): return message
        }
    }
}

enum SOOYAMediaID {
    static func make() -> String { UUID().uuidString.lowercased() }

    static func isValid(_ value: String) -> Bool {
        guard value.count == 36, UUID(uuidString: value) != nil else { return false }
        return value == value.lowercased() && !value.contains("/") && !value.contains("\\")
    }
}

struct SOOYAMediaMetadata: Codable, Equatable {
    let id: String
    let mimeType: String
    let bytes: Int
    let originalName: String?
    let createdAt: Date
    let width: Int?
    let height: Int?
    let durationSeconds: Double?
    let sourceID: String?
}

final class SOOYAMediaStore {
    let root: URL
    let objectsRoot: URL
    let metadataRoot: URL
    let temporaryRoot: URL
    let exportsRoot: URL
    let maxBytes: Int

    private let fileManager: FileManager
    private let lock = NSRecursiveLock()
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(root: URL,
         maxBytes: Int = 128 * 1_024 * 1_024,
         fileManager: FileManager = .default) throws {
        guard root.isFileURL, maxBytes > 0 else { throw SOOYAMediaError.invalidSource }
        self.root = root.standardizedFileURL
        self.objectsRoot = root.appendingPathComponent("objects", isDirectory: true).standardizedFileURL
        self.metadataRoot = root.appendingPathComponent("metadata", isDirectory: true).standardizedFileURL
        self.temporaryRoot = root.appendingPathComponent("tmp", isDirectory: true).standardizedFileURL
        self.exportsRoot = root.appendingPathComponent("exports", isDirectory: true).standardizedFileURL
        self.maxBytes = maxBytes
        self.fileManager = fileManager
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        try [self.root, objectsRoot, metadataRoot, temporaryRoot, exportsRoot].forEach {
            try fileManager.createDirectory(at: $0, withIntermediateDirectories: true)
        }
        try cleanupOrphanedPartials()
    }

    convenience init(maxBytes: Int = 128 * 1_024 * 1_024) throws {
        guard let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw SOOYAMediaError.invalidSource
        }
        try self.init(root: applicationSupport.appendingPathComponent("SOOYA/Media", isDirectory: true), maxBytes: maxBytes)
    }

    func save(data: Data,
              mimeType: String,
              originalName: String? = nil,
              sourceID: String? = nil) throws -> SOOYAMediaMetadata {
        guard data.count <= maxBytes else { throw SOOYAMediaError.tooLarge }
        let normalizedMime = try normalizeMime(mimeType)
        if let sourceID, !SOOYAMediaID.isValid(sourceID) { throw SOOYAMediaError.invalidID }
        let safeName = sanitizeName(originalName)
        let id = SOOYAMediaID.make()
        let details = mediaDetails(data: data, mimeType: normalizedMime)
        let metadata = SOOYAMediaMetadata(
            id: id,
            mimeType: normalizedMime,
            bytes: data.count,
            originalName: safeName,
            createdAt: Date(),
            width: details.width,
            height: details.height,
            durationSeconds: nil,
            sourceID: sourceID
        )

        lock.lock(); defer { lock.unlock() }
        let object = try objectURL(id)
        let metadataURL = try sidecarURL(id)
        do {
            try atomicWrite(data, to: object)
            try atomicWrite(try encoder.encode(metadata), to: metadataURL)
            return metadata
        } catch {
            try? fileManager.removeItem(at: object)
            try? fileManager.removeItem(at: metadataURL)
            throw mapFileError(error)
        }
    }

    func read(id: String) throws -> Data {
        lock.lock(); defer { lock.unlock() }
        let url = try objectURL(id)
        guard fileManager.fileExists(atPath: url.path) else { throw SOOYAMediaError.notFound }
        let size = try fileSize(url)
        guard size <= maxBytes else { throw SOOYAMediaError.tooLarge }
        do { return try Data(contentsOf: url, options: .mappedIfSafe) }
        catch { throw mapFileError(error) }
    }

    func metadata(id: String) throws -> SOOYAMediaMetadata {
        lock.lock(); defer { lock.unlock() }
        let object = try objectURL(id)
        let sidecar = try sidecarURL(id)
        guard fileManager.fileExists(atPath: object.path), fileManager.fileExists(atPath: sidecar.path) else {
            throw SOOYAMediaError.notFound
        }
        do {
            let value = try decoder.decode(SOOYAMediaMetadata.self, from: Data(contentsOf: sidecar))
            guard value.id == id else { throw SOOYAMediaError.corruptMetadata }
            let size = try fileSize(object)
            guard value.bytes == size else { throw SOOYAMediaError.corruptMetadata }
            return value
        } catch let error as SOOYAMediaError { throw error }
        catch { throw SOOYAMediaError.corruptMetadata }
    }

    @discardableResult
    func delete(id: String) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        let object = try objectURL(id)
        let sidecar = try sidecarURL(id)
        let existed = fileManager.fileExists(atPath: object.path) || fileManager.fileExists(atPath: sidecar.path)
        guard existed else { return false }
        do {
            if fileManager.fileExists(atPath: object.path) { try fileManager.removeItem(at: object) }
            if fileManager.fileExists(atPath: sidecar.path) { try fileManager.removeItem(at: sidecar) }
            return true
        } catch { throw mapFileError(error) }
    }

    func sha256(id: String) throws -> String {
        lock.lock(); defer { lock.unlock() }
        let url = try objectURL(id)
        guard fileManager.fileExists(atPath: url.path) else { throw SOOYAMediaError.notFound }
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hasher = SHA256()
            while true {
                let chunk = try handle.read(upToCount: 1_024 * 1_024) ?? Data()
                if chunk.isEmpty { break }
                hasher.update(data: chunk)
            }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined()
        } catch { throw mapFileError(error) }
    }

    func importFile(at source: URL, mimeType: String? = nil) throws -> SOOYAMediaMetadata {
        guard source.isFileURL else { throw SOOYAMediaError.invalidSource }
        let standardized = source.standardizedFileURL
        guard fileManager.fileExists(atPath: standardized.path), !isInsideManagedRoot(standardized) else {
            throw SOOYAMediaError.invalidSource
        }
        let size = try fileSize(standardized)
        guard size <= maxBytes else { throw SOOYAMediaError.tooLarge }
        let inferred = mimeType ?? UTType(filenameExtension: standardized.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        do {
            return try save(data: Data(contentsOf: standardized, options: .mappedIfSafe), mimeType: inferred, originalName: standardized.lastPathComponent)
        } catch let error as SOOYAMediaError { throw error }
        catch { throw mapFileError(error) }
    }

    func export(id: String) throws -> URL {
        lock.lock(); defer { lock.unlock() }
        let source = try objectURL(id)
        let info = try metadata(id: id)
        guard fileManager.fileExists(atPath: source.path) else { throw SOOYAMediaError.notFound }
        let ext = exportExtension(metadata: info)
        let destination = exportsRoot.appendingPathComponent(SOOYAMediaID.make() + (ext.isEmpty ? "" : ".\(ext)"), isDirectory: false)
        do {
            try fileManager.copyItem(at: source, to: destination)
            return destination
        } catch { throw mapFileError(error) }
    }

    func thumbnail(id: String, maxPixelSize: Int = 512) throws -> SOOYAMediaMetadata {
        guard (1...4_096).contains(maxPixelSize) else { throw SOOYAMediaError.invalidThumbnailSize }
        let info = try metadata(id: id)
        let source = try objectURL(id)
        let image: CGImage
        if info.mimeType.hasPrefix("image/") {
            guard let provider = CGImageSourceCreateWithURL(source as CFURL, nil),
                  let result = CGImageSourceCreateThumbnailAtIndex(provider, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
                    kCGImageSourceCreateThumbnailWithTransform: true
                  ] as CFDictionary) else {
                throw SOOYAMediaError.unsupportedThumbnail
            }
            image = result
        } else if info.mimeType.hasPrefix("video/") {
            let asset = AVURLAsset(url: source)
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: maxPixelSize, height: maxPixelSize)
            do { image = try generator.copyCGImage(at: CMTime(seconds: 0, preferredTimescale: 600), actualTime: nil) }
            catch { throw SOOYAMediaError.unsupportedThumbnail }
        } else {
            throw SOOYAMediaError.unsupportedThumbnail
        }
        let jpeg = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(jpeg, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw SOOYAMediaError.unsupportedThumbnail
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw SOOYAMediaError.unsupportedThumbnail }
        return try save(data: jpeg as Data, mimeType: "image/jpeg", originalName: "thumbnail.jpg", sourceID: id)
    }

    @discardableResult
    func cleanupTemporaryFiles(olderThan cutoff: Date = Date()) throws -> Int {
        lock.lock(); defer { lock.unlock() }
        var removed = 0
        for directory in [temporaryRoot, exportsRoot] {
            let entries = try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey], options: [.skipsHiddenFiles])
            for entry in entries {
                let values = try entry.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey])
                guard values.isRegularFile == true, (values.contentModificationDate ?? .distantPast) < cutoff else { continue }
                try fileManager.removeItem(at: entry)
                removed += 1
            }
        }
        return removed
    }

    private func objectURL(_ id: String) throws -> URL {
        guard SOOYAMediaID.isValid(id) else { throw SOOYAMediaError.invalidID }
        return objectsRoot.appendingPathComponent(id, isDirectory: false)
    }

    private func sidecarURL(_ id: String) throws -> URL {
        guard SOOYAMediaID.isValid(id) else { throw SOOYAMediaError.invalidID }
        return metadataRoot.appendingPathComponent("\(id).json", isDirectory: false)
    }

    private func atomicWrite(_ data: Data, to destination: URL) throws {
        let partial = destination.deletingLastPathComponent().appendingPathComponent(".\(SOOYAMediaID.make()).partial")
        do {
            try data.write(to: partial, options: [.withoutOverwriting])
            try fileManager.moveItem(at: partial, to: destination)
        } catch {
            try? fileManager.removeItem(at: partial)
            throw error
        }
    }

    private func cleanupOrphanedPartials() throws {
        for directory in [objectsRoot, metadataRoot, temporaryRoot, exportsRoot] {
            for entry in try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where entry.lastPathComponent.hasSuffix(".partial") {
                try? fileManager.removeItem(at: entry)
            }
        }
    }

    private func fileSize(_ url: URL) throws -> Int {
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        guard let number = attributes[.size] as? NSNumber else { throw SOOYAMediaError.invalidSource }
        return number.intValue
    }

    private func normalizeMime(_ value: String) throws -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty, normalized.count <= 255,
              normalized.range(of: #"^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$"#, options: .regularExpression) != nil else {
            throw SOOYAMediaError.invalidMimeType
        }
        return normalized
    }

    private func sanitizeName(_ value: String?) -> String? {
        guard let value else { return nil }
        let name = URL(fileURLWithPath: value).lastPathComponent
            .replacingOccurrences(of: "\0", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? nil : String(name.prefix(255))
    }

    private func mediaDetails(data: Data, mimeType: String) -> (width: Int?, height: Int?) {
        guard mimeType.hasPrefix("image/"), let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return (nil, nil) }
        return ((properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
                (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue)
    }

    private func exportExtension(metadata: SOOYAMediaMetadata) -> String {
        if let original = metadata.originalName {
            let ext = URL(fileURLWithPath: original).pathExtension.lowercased()
            if !ext.isEmpty { return String(ext.prefix(16)) }
        }
        return UTType(mimeType: metadata.mimeType)?.preferredFilenameExtension ?? "bin"
    }

    private func isInsideManagedRoot(_ url: URL) -> Bool {
        let path = url.resolvingSymlinksInPath().standardizedFileURL.path
        let managed = root.resolvingSymlinksInPath().standardizedFileURL.path
        return path == managed || path.hasPrefix(managed + "/")
    }

    private func mapFileError(_ error: Error) -> SOOYAMediaError {
        if let value = error as? SOOYAMediaError { return value }
        return .fileOperationFailed(error.localizedDescription)
    }
}

@objc(SOOYAMediaPlugin)
public final class SOOYAMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SOOYAMediaPlugin"
    public let jsName = "SOOYAMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "metadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "thumbnail", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sha256", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "export", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanupTemporary", returnType: CAPPluginReturnPromise)
    ]

    private lazy var store: SOOYAMediaStore = {
        do { return try SOOYAMediaStore() }
        catch { preconditionFailure("Unable to initialize SOOYA media store: \(error.localizedDescription)") }
    }()
    private let queue = DispatchQueue(label: "sooya.media", qos: .utility)

    @objc public func save(_ call: CAPPluginCall) {
        queue.async {
            do {
                guard let base64 = call.getString("dataBase64"), let data = Data(base64Encoded: base64), let mime = call.getString("mimeType") else {
                    throw SOOYAMediaError.invalidSource
                }
                call.resolve(self.encode(try self.store.save(data: data, mimeType: mime, originalName: call.getString("name"))))
            } catch { self.reject(call, error) }
        }
    }

    @objc public func read(_ call: CAPPluginCall) {
        queue.async {
            do {
                let id = try self.requireID(call)
                call.resolve(["metadata": self.encode(try self.store.metadata(id: id)), "dataBase64": try self.store.read(id: id).base64EncodedString()])
            } catch { self.reject(call, error) }
        }
    }

    @objc public func delete(_ call: CAPPluginCall) {
        queue.async { do { call.resolve(["deleted": try self.store.delete(id: self.requireID(call))]) } catch { self.reject(call, error) } }
    }

    @objc public func metadata(_ call: CAPPluginCall) {
        queue.async { do { call.resolve(self.encode(try self.store.metadata(id: self.requireID(call)))) } catch { self.reject(call, error) } }
    }

    @objc public func thumbnail(_ call: CAPPluginCall) {
        queue.async { do { call.resolve(self.encode(try self.store.thumbnail(id: self.requireID(call), maxPixelSize: call.getInt("maxPixelSize") ?? 512))) } catch { self.reject(call, error) } }
    }

    @objc public func sha256(_ call: CAPPluginCall) {
        queue.async { do { call.resolve(["sha256": try self.store.sha256(id: self.requireID(call))]) } catch { self.reject(call, error) } }
    }

    @objc public func importFile(_ call: CAPPluginCall) {
        queue.async {
            do {
                guard let raw = call.getString("sourceURL"), let source = URL(string: raw), source.isFileURL else { throw SOOYAMediaError.invalidSource }
                call.resolve(self.encode(try self.store.importFile(at: source, mimeType: call.getString("mimeType"))))
            } catch { self.reject(call, error) }
        }
    }

    @objc public func export(_ call: CAPPluginCall) {
        queue.async { do { call.resolve(["fileURL": try self.store.export(id: self.requireID(call)).absoluteString]) } catch { self.reject(call, error) } }
    }

    @objc public func cleanupTemporary(_ call: CAPPluginCall) {
        queue.async {
            do {
                let age = max(0, call.getDouble("olderThanSeconds") ?? 86_400)
                call.resolve(["removed": try self.store.cleanupTemporaryFiles(olderThan: Date().addingTimeInterval(-age))])
            } catch { self.reject(call, error) }
        }
    }

    private func requireID(_ call: CAPPluginCall) throws -> String {
        guard let id = call.getString("id"), SOOYAMediaID.isValid(id) else { throw SOOYAMediaError.invalidID }
        return id
    }

    private func encode(_ value: SOOYAMediaMetadata) -> PluginCallResultData {
        [
            "id": value.id,
            "mimeType": value.mimeType,
            "bytes": value.bytes,
            "originalName": value.originalName.map { $0 as Any } ?? NSNull(),
            "createdAt": ISO8601DateFormatter().string(from: value.createdAt),
            "width": value.width.map { $0 as Any } ?? NSNull(),
            "height": value.height.map { $0 as Any } ?? NSNull(),
            "durationSeconds": value.durationSeconds.map { $0 as Any } ?? NSNull(),
            "sourceId": value.sourceID.map { $0 as Any } ?? NSNull()
        ]
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        call.reject(error.localizedDescription, String(describing: error), error)
    }
}

