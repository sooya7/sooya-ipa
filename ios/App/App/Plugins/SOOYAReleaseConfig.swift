import Foundation

enum SOOYAReleaseConfig {
    static let nativeBaseVersion = 9
    static let bridgeVersion = 4
    static let otaPublicKeyBase64 = "8Xv0j12IoENRjTFUnRbX08ZGi+Kqxv+N0FpqEsztKsk="
    static let capabilities = [
        "database.sqlite", "keychain.secrets", "http.native", "http.stream",
        "http.websocket", "mcp.native", "mcp.transport", "media.sandbox",
        "archive.zip", "oauth.system", "notifications.local",
        "notifications.push-client", "ota.updater", "ota.signature.ed25519"
    ]
}
