// OpenAgent — native macOS window (WKWebView) that hosts the local agent.
// Starts the bundled Node server, then shows it in a real app window (no browser).
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    let port = 3001

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        startServer()
        loadWhenReady()
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: server
    func resource(_ name: String) -> String { (Bundle.main.resourcePath ?? "") + "/" + name }

    func findNode() -> String? {
        var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        if let home = ProcessInfo.processInfo.environment["HOME"] {
            candidates.append(home + "/.volta/bin/node")
            if let versions = try? FileManager.default.contentsOfDirectory(atPath: home + "/.nvm/versions/node") {
                for v in versions { candidates.append("\(home)/.nvm/versions/node/\(v)/bin/node") }
            }
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    func startServer() {
        // If a server is already up on the port, reuse it.
        if let u = URL(string: "http://localhost:\(port)/"),
           (try? Data(contentsOf: u)) != nil { return }
        guard let node = findNode() else {
            let a = NSAlert()
            a.messageText = "Node.js is required"
            a.informativeText = "Open·Agent needs Node.js to run.\nInstall it from nodejs.org (or: brew install node), then reopen the app."
            a.addButton(withTitle: "Get Node.js")
            a.addButton(withTitle: "Quit")
            if a.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(URL(string: "https://nodejs.org/en/download")!)
            }
            NSApp.terminate(nil); return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [resource("openrouter-agent.js")]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        server = p
    }

    // MARK: window
    func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1180, height: 820)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Open·Agent"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 720, height: 560)
        window.center()
        window.setFrameAutosaveName("OpenAgentMain")
        window.backgroundColor = NSColor(red: 0.047, green: 0.055, blue: 0.078, alpha: 1) // #0C0E14

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default() // persist localStorage (API key, rules, skills)
        webView = WKWebView(frame: rect, configuration: cfg)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground") // avoid white flash
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
    }

    func loadWhenReady() {
        let url = URL(string: "http://localhost:\(port)/")!
        DispatchQueue.global().async {
            for _ in 0..<60 {
                if (try? Data(contentsOf: url)) != nil {
                    DispatchQueue.main.async { self.webView.load(URLRequest(url: url)) }
                    return
                }
                Thread.sleep(forTimeInterval: 0.5)
            }
            DispatchQueue.main.async { self.webView.load(URLRequest(url: url)) } // last attempt
        }
    }

    // MARK: menu (enables Cmd-Q / copy-paste in inputs)
    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Open·Agent", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Open·Agent", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Open·Agent", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = viewMenu

        NSApp.mainMenu = main
    }

    @objc func reload() { webView.reload() }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) { server?.terminate() }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
