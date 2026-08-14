import Foundation

enum SOOYAReleaseConfig {
    static let nativeBaseVersion = 11
    static let bridgeVersion = 5
    static let otaPublicKeyBase64 = "8Xv0j12IoENRjTFUnRbX08ZGi+Kqxv+N0FpqEsztKsk="
    static let capabilities = [
        "database.sqlite", "keychain.secrets", "http.native", "http.stream",
        "http.websocket", "mcp.native", "mcp.transport", "media.sandbox",
        "archive.zip", "backup.full", "oauth.system", "notifications.local",
        "notifications.push-client", "ota.updater", "ota.signature.ed25519"
    ]
}
