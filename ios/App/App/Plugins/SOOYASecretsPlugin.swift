import Foundation
import Capacitor
import Security

/// Fixed Keychain namespace for SOOYA secrets. The service name and bundle
/// id are part of the product contract: changing them breaks existing
/// installs (overwrite install must keep secrets).
struct SOOYAKeychainIdentity {
    static let service = "com.sooya.app.secrets.v1"
    let service: String
    let accessGroup: String

    init(service: String = SOOYAKeychainIdentity.service, accessGroup: String) {
        self.service = service
        self.accessGroup = accessGroup
    }
}

struct SOOYAKeychainResult {
    let status: OSStatus
    let value: [String: Any]?
}

/// Thin seam over the Security framework so tests can record every call and
/// stub OSStatus responses without touching a real keychain.
protocol SOOYAKeychainClient {
    func add(_ attributes: [String: Any]) -> SOOYAKeychainResult
    func copyMatching(_ query: [String: Any]) -> SOOYAKeychainResult
    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any]) -> OSStatus
}

final class SOOYASystemKeychainClient: SOOYAKeychainClient {
    func add(_ attributes: [String: Any]) -> SOOYAKeychainResult {
        let status = SecItemAdd(attributes as CFDictionary, nil)
        return SOOYAKeychainResult(status: status, value: nil)
    }

    func copyMatching(_ query: [String: Any]) -> SOOYAKeychainResult {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        let value = (result as? [String: Any])
        return SOOYAKeychainResult(status: status, value: value)
    }

    func update(_ query: [String: Any], attributes: [String: Any]) -> OSStatus {
        return SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }

    func delete(_ query: [String: Any]) -> OSStatus {
        return SecItemDelete(query as CFDictionary)
    }
}

enum SOOYAKeychainError: Error, LocalizedError {
    case emptyKey
    case newlineInKey
    case emptyValue
    case unresolvedAccessGroup
    case keychainFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .emptyKey: return "A key is required"
        case .newlineInKey: return "Keys cannot contain newlines"
        case .emptyValue: return "A value is required"
        case .unresolvedAccessGroup: return "Keychain access group could not be resolved"
        // Deliberately generic: never render the OSStatus description with
        // caller-controlled data, and never include the key or secret value.
        case .keychainFailed: return "Keychain operation failed"
        }
    }
}

/// Resolves the signed default access group for this bundle by writing a
/// throwaway probe item (without an explicit group), reading back the group
/// the system assigned, validating it, and removing the probe.
final class SOOYAKeychainAccessGroupResolver {
    static let probeService = "com.sooya.app.secrets.access-group-probe.v1"
    static let requiredBundleIdentifier = "com.sooya.app"

    private let client: SOOYAKeychainClient
    private let makeProbeAccount: () -> String

    init(client: SOOYAKeychainClient = SOOYASystemKeychainClient(), makeProbeAccount: @escaping () -> String = { UUID().uuidString }) {
        self.client = client
        self.makeProbeAccount = makeProbeAccount
    }

    func resolve() throws -> String {
        let account = makeProbeAccount()
        let addResult = client.add([
            kSecClass as String: kSecClassGenericPassword as String,
            kSecAttrService as String: Self.probeService,
            kSecAttrAccount as String: account
        ])
        guard addResult.status == errSecSuccess else {
            throw SOOYAKeychainError.keychainFailed(addResult.status)
        }
        defer { _ = client.delete([
            kSecClass as String: kSecClassGenericPassword as String,
            kSecAttrService as String: Self.probeService,
            kSecAttrAccount as String: account
        ]) }

        // Read the item attributes back WITHOUT requesting the secret data.
        let copyResult = client.copyMatching([
            kSecClass as String: kSecClassGenericPassword as String,
            kSecAttrService as String: Self.probeService,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne as String,
            kSecReturnAttributes as String: true
        ])
        guard copyResult.status == errSecSuccess,
              let group = copyResult.value?[kSecAttrAccessGroup as String] as? String else {
            throw SOOYAKeychainError.unresolvedAccessGroup
        }
        // Accept "<TeamID>.com.sooya.app"; reject groups bound to any other
        // bundle identifier.
        guard group.hasSuffix(".\(Self.requiredBundleIdentifier)") else {
            throw SOOYAKeychainError.unresolvedAccessGroup
        }
        return group
    }
}

/// Generic-password secret store. Secrets are device-only, survive until the
/// first unlock after reboot, and are never readable through the bridge.
final class SOOYAKeychainStore {
    private let client: SOOYAKeychainClient
    private let identity: SOOYAKeychainIdentity

    init(client: SOOYAKeychainClient = SOOYASystemKeychainClient(), identity: SOOYAKeychainIdentity) {
        self.client = client
        self.identity = identity
    }

    func has(key: String) throws -> Bool {
        try validateKey(key)
        let result = client.copyMatching([
            kSecClass as String: kSecClassGenericPassword as String,
            kSecAttrService as String: identity.service,
            kSecAttrAccessGroup as String: identity.accessGroup,
            kSecAttrAccount as String: key,
            kSecMatchLimit as String: kSecMatchLimitOne as String
        ])
        switch result.status {
        case errSecSuccess: return true
        case errSecItemNotFound: return false
        default: throw SOOYAKeychainError.keychainFailed(result.status)
        }
    }

    /// Internal-only resolver used by the native HTTP transport. This method
    /// is deliberately not exposed as a Capacitor plugin method, so API keys
    /// never cross into JavaScript or the web bundle.
    func read(key: String) throws -> String? {
        try validateKey(key)
        let result = client.copyMatching([
            kSecClass as String: kSecClassGenericPassword as String,
            kSecAttrService as String: identity.service,
            kSecAttrAccessGroup as String: identity.accessGroup,
            kSecAttrAccount as String: key,
            kSecMatchLimit as String: kSecMatchLimitOne as String,
            // Returning attributes together with the value makes Security
            // return a dictionary containing kSecValueData on device.
            kSecReturnData as String: true,
            kSecReturnAttributes as String: true
        ])
        switch result.status {
        case errSecItemNotFound: return nil
        case errSecSuccess:
            guard let data = result.value?[kSecValueData as String] as? Data else { throw SOOYAKeychainError.keychainFailed(result.status) }
            return String(data: data, encoding: .utf8)
        default: throw SOOYAKeychainError.keychainFailed(result.status)
        }
    }

    func set(key: String, value: String) throws {
        try validateKey(key)
        guard !value.isEmpty else { throw SOOYAKeychainError.emptyValue }
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword as String,
            kSecAttrService as String: identity.service,
            kSecAttrAccessGroup as String: identity.accessGroup,
            kSecAttrAccount as String: key,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String,
            kSecValueData as String: Data(value.utf8)
        ]
        let result = client.add(attributes)
        switch result.status {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            // Atomic value-only update: never re-fetches or echoes the secret.
            let updateStatus = client.update(
                [
                    kSecClass as String: kSecClassGenericPassword as String,
                    kSecAttrService as String: identity.service,
                    kSecAttrAccessGroup as String: identity.accessGroup,
                    kSecAttrAccount as String: key
                ],
                attributes: [
                    kSecValueData as String: Data(value.utf8)
                ]
            )
            guard updateStatus == errSecSuccess else { throw SOOYAKeychainError.keychainFailed(updateStatus) }
        default:
            throw SOOYAKeychainError.keychainFailed(result.status)
        }
    }

    func delete(key: String) throws {
        try validateKey(key)
        let status = client.delete([
            kSecClass as String: kSecClassGenericPassword as String,
            kSecAttrService as String: identity.service,
            kSecAttrAccessGroup as String: identity.accessGroup,
            kSecAttrAccount as String: key
        ])
        // Idempotent: deleting a missing item is not an error.
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SOOYAKeychainError.keychainFailed(status)
        }
    }

    private func validateKey(_ key: String) throws {
        guard !key.isEmpty else { throw SOOYAKeychainError.emptyKey }
        guard !key.contains("\n") else { throw SOOYAKeychainError.newlineInKey }
    }
}

public final class SOOYASecretsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SOOYASecretsPlugin"
    public let jsName = "SOOYASecrets"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "has", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise)
        // Deliberately no "get": secrets must never cross into JS.
    ]

    private lazy var storeResult: Result<SOOYAKeychainStore, Error> = Result {
        let group = try SOOYAKeychainAccessGroupResolver().resolve()
        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))
    }

    private func requireStore() throws -> SOOYAKeychainStore { try storeResult.get() }

    @objc public func has(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing key")
            return
        }
        do {
            call.resolve(["present": try requireStore().has(key: key)])
        } catch {
            call.reject((error as? LocalizedError)?.errorDescription ?? "Keychain operation failed")
        }
    }

    @objc public func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("Missing key or value")
            return
        }
        do {
            try requireStore().set(key: key, value: value)
            call.resolve()
        } catch {
            call.reject((error as? LocalizedError)?.errorDescription ?? "Keychain operation failed")
        }
    }

    @objc public func delete(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing key")
            return
        }
        do {
            try requireStore().delete(key: key)
            call.resolve()
        } catch {
            call.reject((error as? LocalizedError)?.errorDescription ?? "Keychain operation failed")
        }
    }
}
