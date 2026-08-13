import XCTest
@testable import App

final class SOOYAMediaPluginTests: XCTestCase {
    private var root: URL!
    private var store: SOOYAMediaStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("sooya-media-tests-\(UUID().uuidString)", isDirectory: true)
        store = try SOOYAMediaStore(root: root, maxBytes: 1_024 * 1_024)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        store = nil
        root = nil
    }

    func testSaveReadMetadataHashAndDelete() throws {
        let data = Data("hello media".utf8)
        let saved = try store.save(data: data, mimeType: "text/plain", originalName: "hello.txt")

        XCTAssertTrue(SOOYAMediaID.isValid(saved.id))
        XCTAssertEqual(saved.bytes, data.count)
        XCTAssertEqual(saved.mimeType, "text/plain")
        XCTAssertEqual(try store.read(id: saved.id), data)
        XCTAssertEqual(try store.sha256(id: saved.id), "d28d2954ff97ac68052c4beff8c84ad0960d1408540fc486256cdd7cd68dd1fe")
        XCTAssertEqual(try store.metadata(id: saved.id).originalName, "hello.txt")
        XCTAssertTrue(try store.delete(id: saved.id))
        XCTAssertFalse(try store.delete(id: saved.id))
    }

    func testRejectsTraversalAndOversizedData() throws {
        for value in ["../secret", "a/b", "", ".hidden", "A B"] {
            XCTAssertThrowsError(try store.read(id: value))
        }
        XCTAssertThrowsError(try store.save(data: Data(repeating: 0, count: 1_024 * 1_024 + 1), mimeType: "application/octet-stream")) { error in
            XCTAssertEqual(error as? SOOYAMediaError, .tooLarge)
        }
    }

    func testImportExportAndTemporaryCleanupStayInsideManagedRoots() throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("sooya-import-\(UUID().uuidString).txt")
        defer { try? FileManager.default.removeItem(at: source) }
        try Data("imported".utf8).write(to: source)
        let imported = try store.importFile(at: source, mimeType: "text/plain")
        let exported = try store.export(id: imported.id)

        XCTAssertTrue(exported.path.hasPrefix(store.exportsRoot.path + "/"))
        XCTAssertEqual(try Data(contentsOf: exported), Data("imported".utf8))

        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: exported.path)
        XCTAssertEqual(try store.cleanupTemporaryFiles(olderThan: Date()), 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: exported.path))
    }

    func testImageThumbnailIsPersistedWithControlledID() throws {
        let png = try XCTUnwrap(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII="))
        let image = try store.save(data: png, mimeType: "image/png", originalName: "pixel.png")
        let thumbnail = try store.thumbnail(id: image.id, maxPixelSize: 64)

        XCTAssertEqual(thumbnail.mimeType, "image/jpeg")
        XCTAssertTrue(SOOYAMediaID.isValid(thumbnail.id))
        XCTAssertFalse(try store.read(id: thumbnail.id).isEmpty)
    }

    func testAtomicSaveLeavesNoPartialFiles() throws {
        _ = try store.save(data: Data("atomic".utf8), mimeType: "text/plain")
        let names = try FileManager.default.contentsOfDirectory(atPath: store.objectsRoot.path)
        XCTAssertFalse(names.contains { $0.hasSuffix(".partial") })
    }
}
