from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}\n--- OLD ---\n{old[:500]}")
    file.write_text(text.replace(old, new, 1))


# SOOYA is distributed as an unsigned IPA and then re-signed by the user.
# Hard-resolving and explicitly pinning kSecAttrAccessGroup is brittle across
# signing tools/teams. Omit it so iOS uses the app's actual signed default.
path = "ios/App/App/Plugins/SOOYASecretsPlugin.swift"
text = Path(path).read_text()
start = text.index("struct SOOYAKeychainIdentity {")
end = text.index("struct SOOYAKeychainResult {")
text = text[:start] + '''struct SOOYAKeychainIdentity {\n    static let service = "com.sooya.app.secrets.v1"\n    let service: String\n\n    init(service: String = SOOYAKeychainIdentity.service) {\n        self.service = service\n    }\n}\n\n''' + text[end:]
text = text.replace('''    case unresolvedAccessGroup\n''', '')
text = text.replace('''        case .unresolvedAccessGroup: return "Keychain access group could not be resolved"\n''', '')
resolver_start = text.index("/// Resolves the signed default access group")
resolver_end = text.index("/// Generic-password secret store.")
text = text[:resolver_start] + '''/// Generic-password secret store. Production queries intentionally omit\n/// kSecAttrAccessGroup so iOS uses the access group granted by the app's\n/// actual signing identity. This keeps unsigned IPA re-signing compatible.\n''' + text[resolver_end + len("/// Generic-password secret store. "):]
text = text.replace('''    init(client: SOOYAKeychainClient = SOOYASystemKeychainClient(), identity: SOOYAKeychainIdentity) {\n''', '''    init(client: SOOYAKeychainClient = SOOYASystemKeychainClient(), identity: SOOYAKeychainIdentity = SOOYAKeychainIdentity()) {\n''')
text = text.replace('''            kSecAttrAccessGroup as String: identity.accessGroup,\n''', '')
text = text.replace('''                    kSecAttrAccessGroup as String: identity.accessGroup,\n''', '')
text = text.replace('''    private lazy var storeResult: Result<SOOYAKeychainStore, Error> = Result {\n        let group = try SOOYAKeychainAccessGroupResolver().resolve()\n        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))\n    }\n\n    private func requireStore() throws -> SOOYAKeychainStore { try storeResult.get() }\n''', '''    private lazy var store = SOOYAKeychainStore()\n''')
text = text.replace('''            call.resolve(["present": try requireStore().has(key: key)])\n''', '''            call.resolve(["present": try store.has(key: key)])\n''')
text = text.replace('''            try requireStore().set(key: key, value: value)\n''', '''            try store.set(key: key, value: value)\n''')
text = text.replace('''            try requireStore().delete(key: key)\n''', '''            try store.delete(key: key)\n''')
Path(path).write_text(text)

path = "ios/App/App/Plugins/SOOYAHttpPlugin.swift"
replace_once(path, '''    private lazy var secretStoreResult: Result<SOOYAKeychainStore, Error> = Result {\n        let group = try SOOYAKeychainAccessGroupResolver().resolve()\n        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))\n    }\n''', '''    private lazy var secretStore = SOOYAKeychainStore()\n''')
replace_once(path, '''            guard let secret = try secretStoreResult.get().read(key: secretRef), !secret.isEmpty else {\n''', '''            guard let secret = try secretStore.read(key: secretRef), !secret.isEmpty else {\n''')

path = "ios/App/App/Plugins/SOOYAMcpPlugin.swift"
replace_once(path, '''final class SOOYAKeychainMcpTokenResolver: SOOYAMcpTokenResolving {\n    private lazy var storeResult: Result<SOOYAKeychainStore, Error> = Result {\n        let group = try SOOYAKeychainAccessGroupResolver().resolve()\n        return SOOYAKeychainStore(identity: SOOYAKeychainIdentity(accessGroup: group))\n    }\n\n    func token(for reference: String, serverID: String, kind: SOOYAMcpAuthKind) throws -> String? {\n        try storeResult.get().read(key: reference)\n    }\n}\n''', '''final class SOOYAKeychainMcpTokenResolver: SOOYAMcpTokenResolving {\n    private lazy var store = SOOYAKeychainStore()\n\n    func token(for reference: String, serverID: String, kind: SOOYAMcpAuthKind) throws -> String? {\n        try store.read(key: reference)\n    }\n}\n''')

path = "ios/App/AppTests/SOOYASecretsPluginTests.swift"
text = Path(path).read_text()
text = text.replace('''    private let identity = SOOYAKeychainIdentity(\n        service: "com.sooya.app.secrets.v1",\n        accessGroup: "TEAMID.com.sooya.app"\n    )\n''', '''    private let identity = SOOYAKeychainIdentity(service: "com.sooya.app.secrets.v1")\n''')
resolver_test_start = text.index("    func testStableKeychainNamespaceDoesNotDrift()")
resolver_test_end = text.index("    func testHasChecksOnlyExistenceAndNeverRequestsSecretData()")
replacement = '''    func testStableKeychainNamespaceDoesNotDrift() {\n        XCTAssertEqual(SOOYAKeychainIdentity.service, "com.sooya.app.secrets.v1")\n    }\n\n    func testProductionQueriesUseTheSigningIdentityDefaultAccessGroup() throws {\n        let client = RecordingKeychainClient()\n        client.copyResults = [.init(status: errSecItemNotFound)]\n        client.addResults = [.init(status: errSecSuccess)]\n        let store = SOOYAKeychainStore(client: client, identity: identity)\n\n        _ = try store.has(key: "provider.openai")\n        try store.set(key: "provider.openai", value: "secret")\n        try store.delete(key: "provider.openai")\n\n        XCTAssertNil(client.copyCalls[0][kSecAttrAccessGroup as String])\n        XCTAssertNil(client.addCalls[0][kSecAttrAccessGroup as String])\n        XCTAssertNil(client.deleteCalls[0][kSecAttrAccessGroup as String])\n    }\n\n'''
text = text[:resolver_test_start] + replacement + text[resolver_test_end:]
text = text.replace('''        XCTAssertEqual(query[kSecAttrAccessGroup as String] as? String, identity.accessGroup)\n''', '''        XCTAssertNil(query[kSecAttrAccessGroup as String])\n''')
text = text.replace('''        XCTAssertEqual(attributes[kSecAttrAccessGroup as String] as? String, identity.accessGroup)\n''', '''        XCTAssertNil(attributes[kSecAttrAccessGroup as String])\n''')
text = text.replace('''        XCTAssertEqual(update.query[kSecAttrAccessGroup as String] as? String, identity.accessGroup)\n''', '''        XCTAssertNil(update.query[kSecAttrAccessGroup as String])\n''')
Path(path).write_text(text)

replace_once("ios/App/App/Plugins/SOOYAReleaseConfig.swift", "    static let nativeBaseVersion = 9\n", "    static let nativeBaseVersion = 10\n")
Path("ios/App/App/native-base.version").write_text("10\n")
replace_once(".github/workflows/ota.yml", "            --native-min 9 --native-max 9\n", "            --native-min 10 --native-max 10\n")
