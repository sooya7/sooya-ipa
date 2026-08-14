import UIKit
import Capacitor

/// Capacitor 8 does not auto-register app-local CAPBridgedPlugin classes.
/// Keep registration next to the bridge controller so every native launch has
/// the same plugin surface before the web bundle starts bootstrapping LocalCore.
class SOOYABridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SOOYADatabasePlugin())
        bridge?.registerPluginInstance(SOOYASecretsPlugin())
        bridge?.registerPluginInstance(SOOYAMediaPlugin())
        bridge?.registerPluginInstance(SOOYAHttpPlugin())
        bridge?.registerPluginInstance(SOOYAMcpPlugin())
        bridge?.registerPluginInstance(SOOYAArchivePlugin())
        bridge?.registerPluginInstance(SOOYAWebSocketPlugin())
        bridge?.registerPluginInstance(SOOYAReleasePlugin())
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = SOOYABridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
