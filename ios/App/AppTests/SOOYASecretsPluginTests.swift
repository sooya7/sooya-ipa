import Security
import XCTest
@testable import App

final class SOOYASecretsPluginTests: XCTestCase {
    private let identity = SOOYAKeychainIdentity(
        service: "com.sooya.app.secrets.v1",
        accessGroup: "TEAMID.com.sooya.app"
    )

    func testPluginPublishesHasSetDeleteButNoRawSecretGetter() {
        let plugin = SOOYASecretsPlugin()
        let names = Set(plugin.pluginMethods.map(\.name))

        XCTAssertEqual(names, Set(["has", "set", "delete"]))
        XCTAssertFalse(names.contains("get"))
    }

    func testStableKeychainNamespaceDoesNotDrift() {
        XCTAssertEqual(SOOYAKeychainIdentity.service, "com.sooya.app.secrets.v1")
        XCTAssertEqual(
            SOOYAKeychainAccessGroupResolver.probeService,
            "com.sooya.app.secrets.access-group-probe.v1"
        )
        XCTAssertEqual(SOOYAKeychainAccessGroupResolver.requiredBundleIdentifier, "com.sooya.app")
    }

    func testAccessGroupResolverDiscoversTheSignedDefaultGroupAndRemovesItsProbe() throws {
        let client = RecordingKeychainClient()
        client.addResults = [.init(status: errSecSuccess)]
        client.copyResults = [
            .init(
                status: errSecSuccess,
                value: [kSecAttrAccessGroup as String: "TEAMID.com.sooya.app"]
            )
        ]
        let resolver = SOOYAKeychainAccessGroupResolver(
            client: client,
            makeProbeAccount: { "fixed-probe" }
        )

        let accessGroup = try resolver.resolve()

        XCTAssertEqual(accessGroup, "TEAMID.com.sooya.app")
        XCTAssertEqual(client.addCalls.count, 1)
        XCTAssertEqual(client.copyCalls.count, 1)
        XCTAssertEqual(client.deleteCalls.count, 1)
        XCTAssertEqual(
            client.addCalls[0][kSecAttrService as String] as? String,
            SOOYAKeychainAccessGroupResolver.probeService
        )
        XCTAssertEqual(client.addCalls[0][kSecAttrAccount as String] as? String, "fixed-probe")
        XCTAssertNil(client.addCalls[0][kSecAttrAccessGroup as String])
        XCTAssertNil(client.copyCalls[0][kSecReturnData as String])
    }

    func testAccessGroupResolverRejectsAGroupForAnotherBundle() {
        let client = RecordingKeychainClient()
        client.addResults = [.init(status: errSecSuccess)]
        client.copyResults = [
            .init(
                status: errSecSuccess,
                value: [kSecAttrAccessGroup as String: "TEAMID.com.other.app"]
            )
        ]
        let resolver = SOOYAKeychainAccessGroupResolver(
            client: client,
            makeProbeAccount: { "fixed-probe" }
        )

        XCTAssertThrowsError(try resolver.resolve())
        XCTAssertEqual(client.deleteCalls.count, 1)
    }

    func testHasChecksOnlyExistenceAndNeverRequestsSecretData() throws {
        let client = RecordingKeychainClient()
        client.copyResults = [.init(status: errSecSuccess)]
        let store = SOOYAKeychainStore(client: client, identity: identity)

        XCTAssertTrue(try store.has(key: "provider.openai"))
        XCTAssertEqual(client.copyCalls.count, 1)

        let query = client.copyCalls[0]
        XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(query[kSecAttrService as String] as? String, identity.service)
        XCTAssertEqual(query[kSecAttrAccessGroup as String] as? String, identity.accessGroup)
        XCTAssertEqual(query[kSecAttrAccount as String] as? String, "provider.openai")
        XCTAssertEqual(query[kSecMatchLimit as String] as? String, kSecMatchLimitOne as String)
        XCTAssertNil(query[kSecReturnData as String])
        XCTAssertNil(query[kSecReturnAttributes as String])
    }

    func testHasReturnsFalseOnlyForItemNotFound() throws {
        let client = RecordingKeychainClient()
        client.copyResults = [.init(status: errSecItemNotFound)]
        let store = SOOYAKeychainStore(client: client, identity: identity)

        XCTAssertFalse(try store.has(key: "provider.openai"))
    }

    func testSetAddsAThisDeviceOnlySecretWithoutReturningIt() throws {
        let client = RecordingKeychainClient()
        client.addResults = [.init(status: errSecSuccess)]
        let store = SOOYAKeychainStore(client: client, identity: identity)

        try store.set(key: "provider.openai", value: "top-secret-value")

        XCTAssertEqual(client.addCalls.count, 1)
        XCTAssertEqual(client.updateCalls.count, 0)
        let attributes = client.addCalls[0]
        XCTAssertEqual(attributes[kSecAttrService as String] as? String, identity.service)
        XCTAssertEqual(attributes[kSecAttrAccessGroup as String] as? String, identity.accessGroup)
        XCTAssertEqual(attributes[kSecAttrAccount as String] as? String, "provider.openai")
        XCTAssertEqual(
            attributes[kSecAttrAccessible as String] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String
        )
        XCTAssertEqual(
            attributes[kSecValueData as String] as? Data,
            Data("top-secret-value".utf8)
        )
    }

    func testSetUpdatesAnExistingSecretAtomically() throws {
        let client = RecordingKeychainClient()
        client.addResults = [.init(status: errSecDuplicateItem)]
        client.updateStatuses = [errSecSuccess]
        let store = SOOYAKeychainStore(client: client, identity: identity)

        try store.set(key: "provider.openai", value: "replacement-secret")

        XCTAssertEqual(client.updateCalls.count, 1)
        let update = client.updateCalls[0]
        XCTAssertEqual(update.query[kSecAttrService as String] as? String, identity.service)
        XCTAssertEqual(update.query[kSecAttrAccessGroup as String] as? String, identity.accessGroup)
        XCTAssertEqual(update.query[kSecAttrAccount as String] as? String, "provider.openai")
        XCTAssertNil(update.query[kSecValueData as String])
        XCTAssertEqual(
            update.attributes[kSecValueData as String] as? Data,
            Data("replacement-secret".utf8)
        )
    }

    func testDeleteIsIdempotent() throws {
        let client = RecordingKeychainClient()
        client.deleteStatuses = [errSecItemNotFound, errSecSuccess]
        let store = SOOYAKeychainStore(client: client, identity: identity)

        XCTAssertNoThrow(try store.delete(key: "provider.openai"))
        XCTAssertNoThrow(try store.delete(key: "provider.openai"))
        XCTAssertEqual(client.deleteCalls.count, 2)
    }

    func testKeychainErrorsNeverContainTheKeyOrSecret() {
        let client = RecordingKeychainClient()
        client.addResults = [.init(status: errSecAuthFailed)]
        let store = SOOYAKeychainStore(client: client, identity: identity)
        let key = "private-provider-name"
        let secret = "secret-value-that-must-not-leak"

        do {
            try store.set(key: key, value: secret)
            XCTFail("Expected Keychain failure")
        } catch {
            let rendered = String(describing: error)
            let localized = (error as NSError).localizedDescription
            XCTAssertFalse(rendered.contains(key))
            XCTAssertFalse(rendered.contains(secret))
            XCTAssertFalse(localized.contains(key))
            XCTAssertFalse(localized.contains(secret))
        }
    }

    func testInvalidInputsAreRejectedBeforeTouchingKeychain() {
        let client = RecordingKeychainClient()
        let store = SOOYAKeychainStore(client: client, identity: identity)

        XCTAssertThrowsError(try store.has(key: ""))
        XCTAssertThrowsError(try store.set(key: "valid-key", value: ""))
        XCTAssertThrowsError(try store.delete(key: "line\nbreak"))
        XCTAssertTrue(client.addCalls.isEmpty)
        XCTAssertTrue(client.copyCalls.isEmpty)
        XCTAssertTrue(client.deleteCalls.isEmpty)
    }
}

private final class RecordingKeychainClient: SOOYAKeychainClient {
    struct UpdateCall {
        let query: [String: Any]
        let attributes: [String: Any]
    }

    var addResults: [SOOYAKeychainResult] = []
    var copyResults: [SOOYAKeychainResult] = []
    var updateStatuses: [OSStatus] = []
    var deleteStatuses: [OSStatus] = []

    private(set) var addCalls: [[String: Any]] = []
    private(set) var copyCalls: [[String: Any]] = []
    private(set) var updateCalls: [UpdateCall] = []
    private(set) var deleteCalls: [[String: Any]] = []

    func add(_ attributes: [String: Any]) -> SOOYAKeychainResult {
        addCalls.append(attributes)
        return addResults.isEmpty
            ? SOOYAKeychainResult(status: errSecSuccess)
            : addResults.removeFirst()
    }

    func copyMatching(_ query: [String: Any]) -> SOOYAKeychainResult {
        copyCalls.append(query)
        return copyResults.isEmpty
            ? SOOYAKeychainResult(status: errSecItemNotFound)
            : copyResults.removeFirst()
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        updateCalls.append(UpdateCall(query: query, attributes: attributes))
        return updateStatuses.isEmpty ? errSecSuccess : updateStatuses.removeFirst()
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        deleteCalls.append(query)
        return deleteStatuses.isEmpty ? errSecSuccess : deleteStatuses.removeFirst()
    }
}
