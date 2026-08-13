import Foundation
import Capacitor

@objc(SOOYAReleasePlugin)
public final class SOOYAReleasePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SOOYAReleasePlugin"
    public let jsName = "SOOYARelease"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getReleaseInfo", returnType: CAPPluginReturnPromise)
    ]

    @objc public func getReleaseInfo(_ call: CAPPluginCall) {
        call.resolve([
            "nativeBaseVersion": SOOYAReleaseConfig.nativeBaseVersion,
            "bridgeVersion": SOOYAReleaseConfig.bridgeVersion,
            "capabilities": SOOYAReleaseConfig.capabilities,
            "otaPublicKey": SOOYAReleaseConfig.otaPublicKeyBase64
        ])
    }
}
