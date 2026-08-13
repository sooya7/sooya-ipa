import Foundation

enum SOOYAReleaseConfig {
    static let nativeBaseVersion = 3
    static let bridgeVersion = 3
    static let otaPublicKeyBase64 = "eOhhfPa5zY2cohy9/1WUWAYnRwLHtCszo0v+eGteIGo="
    static let capabilities = [
        "database.sqlite", "keychain.secrets", "http.native", "http.stream",
        "http.websocket", "mcp.native", "mcp.transport", "media.sandbox",
        "archive.zip", "oauth.system", "notifications.local",
        "notifications.push-client", "ota.updater", "ota.signature.ed25519"
    ]
}
