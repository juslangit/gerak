//  gerak — the macOS app.
//
//  gerak's engine is a small Python server and a page of JavaScript, and both
//  are tested to death. This file does not reimplement any of it. It wraps it
//  in a real Mac application: one window with its own title bar, a menu bar,
//  a Dock icon, native dialogs, files you can drop or double-click, and a
//  server that starts and stops with the app instead of living in a terminal.
//
//  The division is worth stating plainly, because it is the whole design:
//
//      Python + JavaScript    what gerak does
//      this file              what gerak is, to macOS
//
//  Nothing here knows what a joint is.

import AppKit
import WebKit
import UniformTypeIdentifiers

// ───────────────────────────────────────────────────────────────────
// where things are, and writing down what happened
// ───────────────────────────────────────────────────────────────────

enum Paths {
    /// Everything the app runs is inside its own bundle, so the app can be
    /// moved, copied or reinstalled without caring where the source is.
    static var resources: URL { Bundle.main.resourceURL! }
    static var server: URL { resources.appendingPathComponent("server.py") }

    static var logFile: URL {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("gerak.log")
    }
}

/// One log, in one place, whether the app was opened from Finder or a
/// terminal. When something goes wrong this is the first thing to read.
func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] \(message)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    if let handle = try? FileHandle(forWritingTo: Paths.logFile) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8)!)
        try? handle.close()
    } else {
        try? line.write(to: Paths.logFile, atomically: true, encoding: .utf8)
    }
}

// ───────────────────────────────────────────────────────────────────
// the server
// ───────────────────────────────────────────────────────────────────

/// Starts gerak's Python server, waits for it to say it is ready, and kills
/// it when the app goes away.
///
/// The server picks its own free port (GERAK_PORT=0) rather than taking 8778,
/// so the app and a gerak running in a browser can both be open at once. It
/// announces the port and this run's token on one marked line, which is what
/// is being waited for here.
final class Server {
    private let process = Process()
    private let output = Pipe()
    private var buffer = Data()

    private(set) var url: URL?
    private(set) var token: String?
    private(set) var dataFolder: String?

    var onReady: ((URL) -> Void)?
    var onFailure: ((String) -> Void)?

    func start() {
        guard FileManager.default.fileExists(atPath: Paths.server.path) else {
            onFailure?("gerak's server is missing from the app bundle at \(Paths.server.path)")
            return
        }

        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [Paths.server.path, "--no-open"]
        process.currentDirectoryURL = Paths.resources

        var environment = ProcessInfo.processInfo.environment
        environment["GERAK_PORT"] = "0"          // let the system choose
        environment["PYTHONUNBUFFERED"] = "1"    // or the ready line sits in a buffer
        // If the app is force-quit, applicationWillTerminate never runs and
        // nothing here gets to stop the server. So the server is told whose
        // child it is, and lets itself out when that process disappears.
        environment["GERAK_PARENT"] = String(ProcessInfo.processInfo.processIdentifier)
        process.environment = environment

        process.standardOutput = output
        process.standardError = output

        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            self?.take(chunk)
        }

        process.terminationHandler = { [weak self] proc in
            guard let self else { return }
            if self.url == nil {
                DispatchQueue.main.async {
                    self.onFailure?("gerak's server stopped before it was ready "
                                    + "(exit \(proc.terminationStatus)). See ~/Library/Logs/gerak.log")
                }
            } else {
                log("server stopped, exit \(proc.terminationStatus)")
            }
        }

        do {
            try process.run()
            log("server started, pid \(process.processIdentifier)")
        } catch {
            onFailure?("gerak could not start Python: \(error.localizedDescription)")
        }
    }

    private func take(_ chunk: Data) {
        buffer.append(chunk)
        while let end = buffer.firstIndex(of: 0x0A) {
            let line = String(decoding: buffer[..<end], as: UTF8.self)
            buffer.removeSubrange(...end)
            handle(line: line)
        }
    }

    private static let readyMark = "@@GERAK-READY@@"

    private func handle(line: String) {
        if line.hasPrefix(Self.readyMark) {
            let json = String(line.dropFirst(Self.readyMark.count))
            guard
                let data = json.data(using: .utf8),
                let doc = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let text = doc["url"] as? String,
                let ready = URL(string: text + "&native=1")
            else {
                log("the server's ready line could not be read: \(line)")
                return
            }
            url = ready
            token = doc["token"] as? String
            dataFolder = doc["data"] as? String
            log("server ready on port \(doc["port"] ?? "?")")
            DispatchQueue.main.async { [weak self] in
                guard let self, let url = self.url else { return }
                self.onReady?(url)
            }
        } else if !line.trimmingCharacters(in: .whitespaces).isEmpty {
            log(line)
        }
    }

    func stop() {
        output.fileHandleForReading.readabilityHandler = nil
        guard process.isRunning else { return }
        process.terminate()
        // Give it a moment to close its socket, then insist.
        let deadline = Date().addingTimeInterval(2)
        while process.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        log("server shut down")
    }

    /// Ask the server to let gerak read a file from outside the folders it
    /// scans - which is what a dropped or hand-picked file is.
    func permit(_ paths: [String], then done: @escaping (Bool) -> Void) {
        guard let base = url, let token, let host = base.host, let port = base.port else {
            done(false); return
        }
        var request = URLRequest(url: URL(string: "/api/permit", relativeTo: base)!.absoluteURL)
        request.httpMethod = "POST"
        request.setValue(token, forHTTPHeaderField: "X-Gerak-Token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // An Origin is a scheme, a host and a port and nothing else. Sending
        // the whole page URL here looks nothing like the origin the server
        // expects, and every request was refused.
        request.setValue("http://\(host):\(port)", forHTTPHeaderField: "Origin")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["paths": paths])
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }
}

// ───────────────────────────────────────────────────────────────────
// a web view that accepts dropped files
// ───────────────────────────────────────────────────────────────────

/// A dropped file gives JavaScript its contents but never its path, and gerak
/// works in paths - it hands the server a path and the server reads the file
/// off the disk. So the drop is caught here, in AppKit, where the path is
/// still there, before the page ever sees it.
final class DropWebView: WKWebView {
    var onDropped: (([URL]) -> Void)?
    var onDragState: ((Bool) -> Void)?

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private static let openable: Set<String> = ["glb", "gltf"]

    private func models(in sender: NSDraggingInfo) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
            .urlReadingContentsConformToTypes: [UTType.data.identifier],
        ]
        let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self], options: options) as? [URL] ?? []
        return urls.filter { Self.openable.contains($0.pathExtension.lowercased()) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let found = !models(in: sender).isEmpty
        onDragState?(found)
        return found ? .copy : []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        models(in: sender).isEmpty ? [] : .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        onDragState?(false)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        onDragState?(false)
        let found = models(in: sender)
        guard !found.isEmpty else { return false }
        onDropped?(found)
        return true
    }

    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        onDragState?(false)
    }
}

// ───────────────────────────────────────────────────────────────────
// the app
// ───────────────────────────────────────────────────────────────────

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate,
                         WKNavigationDelegate, NSWindowDelegate {

    private let server = Server()
    private var window: NSWindow!
    private var web: DropWebView!
    private var titleObservation: NSKeyValueObservation?
    private var pendingFiles: [URL] = []
    private var ready = false

    /// `gerak --shot <file.png> [seconds]` opens the window, waits for the
    /// viewport to settle, photographs itself and quits. It is how the app is
    /// checked by eye without a person having to be sitting in front of it.
    private var shotPath: String?
    private var shotDelay: TimeInterval = 6

    /// `gerak --js '<script>'` runs a piece of JavaScript once the page is up.
    /// With --shot it runs first, so a test can put the app into whatever
    /// state is worth photographing. Its result is written to the log.
    private var script: String?

    // ── starting up ─────────────────────────────────────────────────

    func applicationDidFinishLaunching(_ note: Notification) {
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--js"), index + 1 < args.count {
            script = args[index + 1]
        }
        if let index = args.firstIndex(of: "--shot"), index + 1 < args.count {
            shotPath = args[index + 1]
            if index + 2 < args.count, let seconds = TimeInterval(args[index + 2]) {
                shotDelay = seconds
            }
        }

        buildWindow()
        buildMenu()

        server.onReady = { [weak self] url in self?.load(url) }
        server.onFailure = { [weak self] message in self?.fail(message) }
        server.start()

        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildWindow() {
        let size = NSSize(width: 1440, height: 900)
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)

        window.title = "gerak"
        window.minSize = NSSize(width: 1080, height: 680)
        window.delegate = self
        window.appearance = NSAppearance(named: .darkAqua)

        // The page draws its own top bar, so the window's title strip is
        // transparent and the page shows through it. That is why the CSS
        // leaves 92 points clear on the left for the traffic lights.
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(red: 0.086, green: 0.094, blue: 0.114, alpha: 1)

        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = false
        if #available(macOS 13.3, *) { config.preferences.isElementFullscreenEnabled = true }
        // Let the page ask for a WebGL context that will actually render.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        web = DropWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        web.uiDelegate = self
        web.navigationDelegate = self
        web.allowsBackForwardNavigationGestures = false

        web.onDropped = { [weak self] urls in self?.open(urls) }
        web.onDragState = { [weak self] dragging in
            self?.run("document.documentElement.classList.toggle('is-dropping', \(dragging));"
                      + "document.getElementById('drop-hint').hidden = \(!dragging);")
        }

        window.contentView = web

        // Come back the size and place it was left.
        window.setFrameAutosaveName("gerak.window")
        if window.frame.width < 200 { window.setContentSize(size) }
        window.center()
        window.setFrameUsingName("gerak.window")
        window.makeKeyAndOrderFront(nil)

        // The page names itself after whatever model is open; show that in
        // the window so ⌘-tab and Mission Control say something useful.
        titleObservation = web.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let title = view.title, !title.isEmpty else { return }
            self?.window.title = title
        }
    }

    private func load(_ url: URL) {
        log("loading \(url.absoluteString.replacingOccurrences(of: server.token ?? "", with: "…"))")
        web.load(URLRequest(url: url))
    }

    private func fail(_ message: String) {
        log("FAILED: \(message)")
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "gerak could not start"
        alert.informativeText = message
        alert.addButton(withTitle: "Show the log")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.activateFileViewerSelecting([Paths.logFile])
        }
        NSApp.terminate(nil)
    }

    // ── shutting down ───────────────────────────────────────────────

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    /// Ask the page whether there is unsaved work before the app goes away.
    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        guard ready else { return .terminateNow }
        // A run that is photographing itself has nobody to answer a dialog.
        guard shotPath == nil else { return .terminateNow }
        web.evaluateJavaScript("!!(window.gerak && window.gerak.state.clip.dirty)") { result, _ in
            let dirty = (result as? Bool) ?? false
            guard dirty else {
                NSApp.reply(toApplicationShouldTerminate: true)
                return
            }
            let alert = NSAlert()
            alert.messageText = "This clip has unsaved changes."
            alert.informativeText = "Quit anyway and the keys you have set will be lost."
            alert.addButton(withTitle: "Save…")
            alert.addButton(withTitle: "Quit without saving")
            alert.addButton(withTitle: "Cancel")
            switch alert.runModal() {
            case .alertFirstButtonReturn:
                self.run("window.gerak.command('save')")
                NSApp.reply(toApplicationShouldTerminate: false)
            case .alertSecondButtonReturn:
                NSApp.reply(toApplicationShouldTerminate: true)
            default:
                NSApp.reply(toApplicationShouldTerminate: false)
            }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ note: Notification) {
        server.stop()
    }

    // ── opening files ───────────────────────────────────────────────

    /// Finder hands files over this way: double-clicked, dropped on the Dock
    /// icon, or chosen through Open With.
    func application(_ app: NSApplication, open urls: [URL]) {
        log("Finder handed over: \(urls.map(\.lastPathComponent).joined(separator: ", "))")
        open(urls)
    }

    private func open(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        guard ready else {
            log("holding \(urls.count) file(s) until the page is up")
            pendingFiles.append(contentsOf: urls)   // still starting up
            return
        }
        let paths = urls.map(\.path)
        server.permit(paths) { [weak self] allowed in
            guard let self else { return }
            guard allowed else {
                log("the server refused: \(paths.joined(separator: ", "))")
                self.say("gerak could not read that file.", urls.first?.lastPathComponent ?? "")
                return
            }
            log("opening \(paths.count) file(s) in the page")
            // One at a time; the last one wins, which is what opening several
            // files in Finder should do when an app shows one at a time.
            for path in paths {
                self.run("return window.gerak.openPath(\(Self.js(path)))") { result in
                    let opened = (result as? Bool) ?? false
                    log(opened ? "opened \((path as NSString).lastPathComponent)"
                               : "the page could not open \((path as NSString).lastPathComponent)")
                }
            }
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc private func openDocument(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.title = "Open a model"
        panel.prompt = "Open"
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [UTType(filenameExtension: "glb"),
                                     UTType(filenameExtension: "gltf")].compactMap { $0 }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.open([url])
        }
    }

    // ── the menu bar ────────────────────────────────────────────────

    private func buildMenu() {
        let main = NSMenu()

        // gerak
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About gerak", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Show the clips and exports folder",
                        action: #selector(showData), keyEquivalent: "")
        appMenu.addItem(withTitle: "Show the log", action: #selector(showLog), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide gerak", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit gerak", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu: appMenu, title: "gerak")

        // File
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Open Model…", action: #selector(openDocument(_:)), keyEquivalent: "o")
        file.addItem(cmd: "rescan", title: "Scan the Mac Again", key: "r", target: self)
        file.addItem(.separator())
        file.addItem(cmd: "save", title: "Save Clip…", key: "s", target: self)
        file.addItem(cmd: "export", title: "Export…", key: "e", target: self)
        main.addItem(submenu: file, title: "File")

        // Edit — the standard one, so copy and paste work in the text fields
        // Undo and Redo go to gerak's own history, not to AppKit's - the
        // page is what holds the work, and NSText's undo knows nothing about
        // a keyframe. They are here rather than in Pose because ⌘Z belongs in
        // Edit and nowhere else.
        let edit = NSMenu(title: "Edit")
        edit.addItem(cmd: "undo", title: "Undo", key: "z", target: self)
        edit.addItem(cmd: "redo", title: "Redo", key: "Z",
                     modifiers: [.command, .shift], target: self)
        edit.addItem(.separator())
        // Copy and Paste mean the pose, because that is what gerak is for.
        // The page hands them back to the browser when the cursor is in a
        // text box, and runCommand hands them to macOS when a sheet is up.
        edit.addItem(cmd: "copy", title: "Copy Pose", key: "c", target: self)
        edit.addItem(cmd: "paste", title: "Paste Pose", key: "v", target: self)
        edit.addItem(cmd: "pasteFlipped", title: "Paste Pose Flipped", key: "V",
                     modifiers: [.command, .shift], target: self)
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(submenu: edit, title: "Edit")

        // Pose
        let pose = NSMenu(title: "Pose")
        pose.addItem(cmd: "key", title: "Key the Pose", key: "k", target: self)
        pose.addItem(cmd: "unkey", title: "Remove the Key Here", key: "\u{8}", target: self)
        pose.addItem(.separator())
        pose.addItem(cmd: "rotate", title: "Turn a Joint", key: "1", target: self)
        pose.addItem(cmd: "move", title: "Move a Joint", key: "2", target: self)
        pose.addItem(.separator())
        pose.addItem(cmd: "reset", title: "Reset the Selected Joint", key: "", target: self)
        pose.addItem(cmd: "mirror", title: "Mirror onto the Other Side", key: "m",
                     modifiers: [.command, .shift], target: self)
        pose.addItem(.separator())
        pose.addItem(cmd: "place", title: "Place a Skeleton", key: "", target: self)
        pose.addItem(cmd: "bind", title: "Bind the Skin", key: "b", target: self)
        main.addItem(submenu: pose, title: "Pose")

        // Play
        let play = NSMenu(title: "Play")
        play.addItem(cmd: "play", title: "Play / Pause", key: " ", target: self)
        play.addItem(.separator())
        play.addItem(cmd: "start", title: "Go to the First Frame", key: "\u{2190}",
                     modifiers: [.command], target: self)
        play.addItem(cmd: "end", title: "Go to the Last Frame", key: "\u{2192}",
                     modifiers: [.command], target: self)
        play.addItem(cmd: "prevKey", title: "Previous Key", key: "\u{2190}",
                     modifiers: [.command, .option], target: self)
        play.addItem(cmd: "nextKey", title: "Next Key", key: "\u{2192}",
                     modifiers: [.command, .option], target: self)
        main.addItem(submenu: play, title: "Play")

        // View
        let view = NSMenu(title: "View")
        view.addItem(cmd: "skeleton", title: "Show the Joints", key: "j", target: self)
        view.addItem(cmd: "mesh", title: "Show the Model", key: "d", target: self)
        view.addItem(cmd: "floor", title: "Show the Floor", key: "g", target: self)
        view.addItem(.separator())
        view.addItem(cmd: "deselect", title: "Deselect", key: "\u{1b}", modifiers: [], target: self)
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen",
                     action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        main.addItem(submenu: view, title: "View")

        // Help
        let help = NSMenu(title: "Help")
        help.addItem(withTitle: "gerak Help", action: #selector(showHelp(_:)), keyEquivalent: "?")
        main.addItem(submenu: help, title: "Help")

        NSApp.mainMenu = main
        NSApp.helpMenu = help
    }

    @objc func runCommand(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }

        // While a sheet is up - naming a clip, say - Copy and Paste belong to
        // the text field in it, not to the character's pose.
        if window.attachedSheet != nil,
           let standard = Self.standardEdit[name] {
            NSApp.sendAction(standard, to: nil, from: sender)
            return
        }

        run("window.gerak && window.gerak.command(\(Self.js(name)))")
    }

    private static let standardEdit: [String: Selector] = [
        "copy": #selector(NSText.copy(_:)),
        "paste": #selector(NSText.paste(_:)),
        "undo": Selector(("undo:")),
        "redo": Selector(("redo:")),
    ]

    @objc private func about() {
        let alert = NSAlert()
        alert.messageText = "gerak"
        alert.informativeText = """
            An animation desk for the models on this Mac.

            Click a joint, turn it, key the pose. Models with no skeleton get \
            one from a template, bound by Blender.

            Your clips and exports are in \(server.dataFolder ?? "~/Documents/gerak").
            """
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    @objc private func showData() {
        let path = server.dataFolder
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Documents/gerak").path
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    @objc private func showLog() {
        NSWorkspace.shared.activateFileViewerSelecting([Paths.logFile])
    }

    @objc func showHelp(_ sender: Any?) {
        let readme = Paths.resources.appendingPathComponent("README.md")
        if FileManager.default.fileExists(atPath: readme.path) {
            NSWorkspace.shared.open(readme)
        } else {
            about()
        }
    }

    // ── native dialogs for the page ─────────────────────────────────
    //
    // A WKWebView shows nothing at all for alert(), confirm() and prompt()
    // unless it is told how, so gerak's own prompts - naming a clip, asking
    // about unsaved work - would silently do nothing. These turn each of them
    // into a real Mac dialog, which is better than what the browser gave.

    func webView(_ view: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler done: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "gerak"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in done() }
    }

    func webView(_ view: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler done: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            done(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ view: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler done: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field

        alert.beginSheetModal(for: window) { response in
            done(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    // ── navigation ──────────────────────────────────────────────────

    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        log("page loaded")

        if let script {
            // Give the page a moment to finish its first library scan before
            // asking it to do anything.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                // callAsyncJavaScript, not evaluateJavaScript: the second one
                // hands back the Promise itself and calls it "a result of an
                // unsupported type". This one waits for the answer.
                self?.web.callAsyncJavaScript(script, arguments: [:], in: nil,
                                              in: .page) { outcome in
                    switch outcome {
                    case .success(let value):
                        log("SCRIPT RESULT: \(String(describing: value))")
                    case .failure(let error):
                        log("SCRIPT FAILED: \(error.localizedDescription)")
                    }
                }
            }
        }

        if let shotPath {
            DispatchQueue.main.asyncAfter(deadline: .now() + shotDelay) { [weak self] in
                self?.photograph(into: shotPath)
            }
        }
        if !pendingFiles.isEmpty {
            let waiting = pendingFiles
            pendingFiles = []
            // Give the page a moment to finish its first library scan.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                self?.open(waiting)
            }
        }
    }

    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("The page would not load: \(error.localizedDescription)")
    }

    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        fail("gerak could not reach its own server: \(error.localizedDescription)")
    }

    /// Anything that is not gerak itself opens in the real browser, so a link
    /// never replaces the app with a web page.
    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler decide: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url else { decide(.allow); return }
        if target.host == "127.0.0.1" || target.host == "localhost" || target.isFileURL {
            decide(.allow)
        } else {
            NSWorkspace.shared.open(target)
            decide(.cancel)
        }
    }

    private func photograph(into path: String) {
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = true
        web.takeSnapshot(with: config) { image, error in
            defer { NSApp.terminate(nil) }
            guard
                let image,
                let tiff = image.tiffRepresentation,
                let bitmap = NSBitmapImageRep(data: tiff),
                let png = bitmap.representation(using: .png, properties: [:])
            else {
                log("could not photograph the window: \(error?.localizedDescription ?? "no image")")
                return
            }
            do {
                try png.write(to: URL(fileURLWithPath: path))
                log("photographed the window into \(path)")
            } catch {
                log("could not write the picture: \(error.localizedDescription)")
            }
        }
    }

    // ── odds and ends ───────────────────────────────────────────────

    /// Run a piece of JavaScript in the page.
    ///
    /// callAsyncJavaScript rather than evaluateJavaScript, because several of
    /// the page's functions are async and the older call hands back the
    /// Promise itself and then complains that a Promise is "a result of an
    /// unsupported type". This one waits for the answer. The script is a
    /// function body, so a plain statement works and `return` gives a result.
    private func run(_ script: String, then done: ((Any?) -> Void)? = nil) {
        web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { outcome in
            switch outcome {
            case .success(let value):
                done?(value)
            case .failure(let error):
                log("javascript failed: \(error.localizedDescription) — \(script)")
                done?(nil)
            }
        }
    }

    private func say(_ message: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = detail
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    /// A JavaScript string literal, quoted properly, so a file path with an
    /// apostrophe or a backslash in it cannot break the script it goes into.
    static func js(_ value: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [value])
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }
}

// ───────────────────────────────────────────────────────────────────
// small conveniences for building menus
// ───────────────────────────────────────────────────────────────────

extension NSMenu {
    func addItem(submenu: NSMenu, title: String) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        submenu.title = title
        item.submenu = submenu
        addItem(item)
    }

    /// A menu item that runs one of the page's commands.
    @discardableResult
    func addItem(cmd: String, title: String, key: String,
                 modifiers: NSEvent.ModifierFlags = [.command],
                 target: AppDelegate) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(AppDelegate.runCommand(_:)),
                              keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.representedObject = cmd
        item.target = target
        addItem(item)
        return item
    }
}

// ───────────────────────────────────────────────────────────────────

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
