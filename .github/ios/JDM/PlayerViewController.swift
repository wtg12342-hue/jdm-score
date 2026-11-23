import UIKit
import WebKit
import UniformTypeIdentifiers

/// The score player itself is the JDM web app (same as on Android and the web), shown full screen.
/// What the iPhone adds: scores opened straight from the Files app / share sheet, sound with the silent switch on,
/// the screen kept on while playing, a tap felt on each count-in beat, and a native look (dark, edge to edge).
final class PlayerViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    static let bg = UIColor(red: 11/255, green: 10/255, blue: 8/255, alpha: 1)
    static let home = URL(string: "https://wtg12342-hue.github.io/jdm-score/?src=ios")!
    private var web: WKWebView!
    private var ready = false
    private var pending: [(String, String, String)] = []
    private let light = UIImpactFeedbackGenerator(style: .light)
    private let strong = UIImpactFeedbackGenerator(style: .rigid)
    private let offline = UILabel()

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.applicationNameForUserAgent = "JDMiOS/1.0 Mobile/15E148 Safari/604.1"
        cfg.userContentController.add(self, name: "jdm")
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = Self.bg
        web.scrollView.backgroundColor = Self.bg
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        web.navigationDelegate = self
        web.uiDelegate = self
        if #available(iOS 16.4, *) { web.isInspectable = false }
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        offline.text = "인터넷에 연결되면 다시 열려요"
        offline.textColor = UIColor(white: 0.8, alpha: 1)
        offline.font = .systemFont(ofSize: 15, weight: .semibold)
        offline.textAlignment = .center
        offline.isHidden = true
        offline.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(offline)
        NSLayoutConstraint.activate([offline.centerXAnchor.constraint(equalTo: view.centerXAnchor), offline.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
        web.load(URLRequest(url: Self.home, cachePolicy: .useProtocolCachePolicy))
    }

    // MARK: files from outside the app
    func openFile(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let type = UTType(filenameExtension: url.pathExtension.lowercased())
        let mime = type?.preferredMIMEType ?? (url.pathExtension.lowercased() == "pdf" ? "application/pdf" : "application/octet-stream")
        let item = (url.lastPathComponent, mime, data.base64EncodedString())
        if ready { send(item) } else { pending.append(item) }
    }
    private func send(_ it: (String, String, String)) {
        let name = it.0.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        web.evaluateJavaScript("window.jdmNativeOpen&&jdmNativeOpen('\(name)','\(it.1)','\(it.2)')")
    }

    // MARK: messages from the page
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let t = m["t"] as? String else { return }
        switch t {
        case "awake": UIApplication.shared.isIdleTimerDisabled = (m["on"] as? Bool) ?? false
        case "tick": ((m["k"] as? String) == "strong" ? strong : light).impactOccurred()
        case "ready":
            ready = true
            let p = pending; pending = []
            p.forEach(send)
        default: break
        }
    }

    // MARK: navigation: the player stays inside; other sites open in Safari
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = a.request.url else { return decisionHandler(.allow) }
        let main = a.targetFrame?.isMainFrame ?? true
        if main, a.navigationType == .linkActivated || a.targetFrame == nil, u.host != Self.home.host, ["http", "https"].contains(u.scheme ?? "") {
            UIApplication.shared.open(u); return decisionHandler(.cancel)
        }
        if !["http", "https", "about", "blob", "data"].contains(u.scheme ?? "") { UIApplication.shared.open(u); return decisionHandler(.cancel) }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { UIApplication.shared.open(u) }
        return nil
    }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { offline.isHidden = true }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) {
        offline.isHidden = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.web.load(URLRequest(url: Self.home)) }
    }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

    // MARK: alert / confirm / prompt
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: msg, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "확인", style: .default) { _ in done() })
        present(a, animated: true)
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: msg, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in done(false) })
        a.addAction(UIAlertAction(title: "확인", style: .default) { _ in done(true) })
        present(a, animated: true)
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler done: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: p, preferredStyle: .alert)
        a.addTextField { $0.text = d }
        a.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in done(nil) })
        a.addAction(UIAlertAction(title: "확인", style: .default) { _ in done(a.textFields?.first?.text) })
        present(a, animated: true)
    }
}
