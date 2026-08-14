from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    file.write_text(text.replace(old, new, 1))


# SecItemCopyMatching only returns item attributes when kSecReturnAttributes is
# requested. The resolver needs kSecAttrAccessGroup from those attributes.
replace_once(
    "ios/App/App/Plugins/SOOYASecretsPlugin.swift",
    '''            kSecAttrAccount as String: account,\n            kSecMatchLimit as String: kSecMatchLimitOne as String\n''',
    '''            kSecAttrAccount as String: account,\n            kSecMatchLimit as String: kSecMatchLimitOne as String,\n            kSecReturnAttributes as String: true\n'''
)

# Keep the native Swift test honest about the real Security query contract.
replace_once(
    "ios/App/AppTests/SOOYASecretsPluginTests.swift",
    '''        XCTAssertNil(client.copyCalls[0][kSecReturnData as String])\n''',
    '''        XCTAssertNil(client.copyCalls[0][kSecReturnData as String])\n        XCTAssertEqual(client.copyCalls[0][kSecReturnAttributes as String] as? Bool, true)\n'''
)

# Native code changed, so this cannot be delivered to Base 8 via OTA.
replace_once(
    "ios/App/App/Plugins/SOOYAReleaseConfig.swift",
    "    static let nativeBaseVersion = 8\n",
    "    static let nativeBaseVersion = 9\n"
)
Path("ios/App/App/native-base.version").write_text("9\n")
