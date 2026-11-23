import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    let player = PlayerViewController()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let ws = scene as? UIWindowScene else { return }
        let w = UIWindow(windowScene: ws)
        w.rootViewController = player
        w.backgroundColor = PlayerViewController.bg
        w.makeKeyAndVisible()
        window = w
        // opened from the Files app or the share sheet ("JDM 악보로 열기")
        for c in connectionOptions.urlContexts { player.openFile(c.url) }
    }
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for c in URLContexts { player.openFile(c.url) }
    }
}
