import Cocoa
import WebKit

// The drag surface carries real AppKit mouse events. Web scripts never synthesize
// window drags, and the content below it remains a normal interactive WKWebView.
final class WindowDragSurface: NSView {
    var onZoom: (() -> Void)?
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { onZoom?() }
        else { window?.performDrag(with: event) }
    }
}

// The three floating surfaces keep their DOM outlines and use the same solid
// light gray palette. Their backgrounds are independent of desktop contents.
final class NativeSurfaceRegionView: NSView {
    private(set) var radius: CGFloat = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        clipsToBounds = true
        layer?.masksToBounds = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(rect: NSRect, radius newRadius: CGFloat, dark: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        frame = rect
        radius = min(max(0, newRadius), min(rect.width, rect.height) / 2)
        layer?.cornerRadius = radius
        layer?.backgroundColor = NSColor(srgbRed: 232 / 255, green: 234 / 255, blue: 237 / 255, alpha: 1).cgColor
        layer?.borderColor = NSColor.black.withAlphaComponent(0.10).cgColor
        layer?.borderWidth = 0.7
        CATransaction.commit()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var serverURL: URL?
    private var logPipe: Pipe?
    private var logBuffer = ""
    private var quitting = false
    private var backdropContainer: NSView!
    private var glassRegionViews: [NativeSurfaceRegionView] = []
    private var windowControls: NSView?
    private var closeWindowButton: NSButton?
    private var minimizeWindowButton: NSButton?
    private var zoomWindowButton: NSButton?
    private var restoreWindowFrame: NSRect?
    private var changingWindowFrame = false
    private var rejectedGeometryMessages = 0

    private var isWindowExpanded: Bool { restoreWindowFrame != nil }
    private var nativeGlassKind = "light-gray"
    private var smokeZoomResult: [String: Any]?
    private var didRunSmokeZoom = false
    private var windowStateUpdateScheduled = false
    private var glassRegions: [(rect: NSRect, radius: CGFloat)] = []

    private var isSmoke: Bool { ProcessInfo.processInfo.environment["FRAMEFLOW_SMOKE_REPORT"] != nil }
    private var reducesTransparency: Bool {
        if isSmoke, let override = ProcessInfo.processInfo.environment["FRAMEFLOW_SMOKE_REDUCE_TRANSPARENCY"] {
            return override == "1"
        }
        return NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let smokeEnvironment = ProcessInfo.processInfo.environment
        let isSmoke = smokeEnvironment["FRAMEFLOW_SMOKE_REPORT"] != nil
        if isSmoke { configuration.websiteDataStore = .nonPersistent() }
        let savedTheme = isSmoke ? (smokeEnvironment["FRAMEFLOW_SMOKE_THEME"] ?? UserDefaults.standard.string(forKey: "FrameFlowTheme")) : UserDefaults.standard.string(forKey: "FrameFlowTheme")
        let themeLiteral = ["light", "dark"].contains(savedTheme ?? "") ? "'\(savedTheme!)'" : "null"
        let bootstrapScript = """
        document.documentElement.lang='zh-CN';
        document.documentElement.dataset.native='macos';
        document.documentElement.dataset.reduceTransparency='\(reducesTransparency ? "true" : "false")';
        try { const theme=\(themeLiteral); if(theme) localStorage.setItem('vimax-web-theme',theme); } catch {}
        new MutationObserver(()=>{const theme=document.documentElement.dataset.theme;if(theme==='light'||theme==='dark')window.webkit.messageHandlers.frameflowTheme.postMessage(theme)}).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
        """
        configuration.userContentController.add(self, name: "frameflowTheme")
        configuration.userContentController.add(self, name: "frameflowWindow")
        let languageScript = WKUserScript(source: bootstrapScript, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        configuration.userContentController.addUserScript(languageScript)
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.underPageBackgroundColor = .clear
        // AppKit WebKit still paints a default page backdrop even when CSS and
        // underPageBackgroundColor are clear. Mirror WebKit MiniBrowser's
        // guarded local transparency path; future builds without this setter
        // retain the readable opaque fallback.
        if webView.responds(to: NSSelectorFromString("setDrawsBackground:")) || webView.responds(to: NSSelectorFromString("_setDrawsBackground:")) {
            webView.setValue(false, forKey: "drawsBackground")
        }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "FrameFlow"
        window.delegate = self
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.collectionBehavior = [.fullScreenNone]
        window.standardWindowButton(.zoomButton)?.isHidden = true
        if let savedTheme = savedTheme {
            window.appearance = NSAppearance(named: savedTheme == "dark" ? .darkAqua : .aqua)
        }
        window.minSize = NSSize(width: 900, height: 640)
        if !isSmoke { window.setFrameAutosaveName("FrameFlowMainWindow") }
        installGlassContent()
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(accessibilityDisplayChanged), name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        if isSmoke, let width = smokeEnvironment["FRAMEFLOW_SMOKE_WIDTH"].flatMap(Double.init),
           let height = smokeEnvironment["FRAMEFLOW_SMOKE_HEIGHT"].flatMap(Double.init) {
            window.setContentSize(NSSize(width: max(900, width), height: max(618, height)))
        }
        window.center()
        if isSmoke && smokeEnvironment["FRAMEFLOW_SMOKE_BACKGROUND"] == "1" {
            window.orderBack(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        showLoading()
        startServer()
    }

    private func installGlassContent() {
        let container = NSView(frame: NSRect(origin: .zero, size: window.frame.size))
        container.autoresizingMask = [.width, .height]
        container.wantsLayer = true

        backdropContainer = NSView(frame: container.bounds)
        backdropContainer.autoresizingMask = [.width, .height]
        backdropContainer.wantsLayer = true
        backdropContainer.clipsToBounds = true
        container.addSubview(backdropContainer)

        webView.frame = container.bounds
        webView.autoresizingMask = [.width, .height]
        container.addSubview(webView)

        let dragSurface = WindowDragSurface(frame: NSRect(x: 0, y: container.bounds.height - 32, width: container.bounds.width, height: 32))
        dragSurface.autoresizingMask = [.width, .minYMargin]
        dragSurface.setAccessibilityLabel("拖动窗口，双击放大或还原")
        dragSurface.onZoom = { [weak self] in self?.toggleWindowZoom() }
        container.addSubview(dragSurface)
        window.contentView = container
        installWindowControls(in: container, above: dragSurface)
        updateNativeTransparency()
    }

    private func installWindowControls(in container: NSView, above dragSurface: NSView) {
        // These are AppKit's genuine traffic-light controls, hosted in our
        // content layer so WebKit and glass never obscure titlebar chrome.
        let controls = NSView(frame: NSRect(x: 20, y: container.bounds.height - 32, width: 58, height: 32))
        controls.autoresizingMask = [.minYMargin]
        closeWindowButton = NSWindow.standardWindowButton(.closeButton, for: window.styleMask)
        minimizeWindowButton = NSWindow.standardWindowButton(.miniaturizeButton, for: window.styleMask)
        zoomWindowButton = NSWindow.standardWindowButton(.zoomButton, for: window.styleMask)
        for (index, button) in [closeWindowButton, minimizeWindowButton, zoomWindowButton].enumerated() {
            guard let button = button else { continue }
            button.target = index == 2 ? self : window
            switch index {
            case 0: button.action = #selector(NSWindow.performClose(_:))
            case 1: button.action = #selector(NSWindow.performMiniaturize(_:))
            default: button.action = #selector(toggleWindowZoom)
            }
            let label = index == 0 ? "关闭窗口" : index == 1 ? "最小化窗口" : "放大窗口"
            button.toolTip = label
            button.setAccessibilityLabel(label)
            button.setFrameOrigin(NSPoint(x: CGFloat(index) * 20, y: (32 - button.frame.height) / 2))
            controls.addSubview(button)
        }
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(type)?.isHidden = true
        }
        container.addSubview(controls, positioned: .above, relativeTo: dragSurface)
        windowControls = controls
    }

    @objc private func accessibilityDisplayChanged() { updateNativeTransparency() }

    private func updateNativeTransparency() {
        updateNativeGlassViews()
        webView.evaluateJavaScript("document.documentElement.dataset.reduceTransparency='\(reducesTransparency ? "true" : "false")';", completionHandler: nil)
    }

    private func updateNativeGlassViews() {
        guard backdropContainer != nil else { return }
        let dark = window.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        for (index, region) in glassRegions.enumerated() where index < glassRegionViews.count {
            glassRegionViews[index].update(rect: region.rect, radius: region.radius, dark: dark)
        }
    }

    private func updateGlassRegions(_ values: [[String: Any]]) {
        guard values.count <= 8 else { return }
        let bounds = backdropContainer.bounds
        var regions: [(rect: NSRect, radius: CGFloat)] = []
        for value in values {
            guard let x = value["x"] as? Double, let y = value["y"] as? Double,
                  let width = value["width"] as? Double, let height = value["height"] as? Double,
                  let radius = value["radius"] as? Double,
                  [x, y, width, height, radius].allSatisfy({ $0.isFinite }),
                  width > 0, height > 0 else { continue }
            let rect = NSRect(x: x, y: bounds.height - y - height, width: width, height: height).intersection(bounds)
            guard !rect.isEmpty else { continue }
            regions.append((rect: rect, radius: max(0, min(radius, min(rect.width, rect.height) / 2))))
        }
        guard !regions.isEmpty else { return }
        glassRegions = regions
        while glassRegionViews.count > regions.count {
            glassRegionViews.removeLast().removeFromSuperview()
        }
        while glassRegionViews.count < regions.count {
            let surface = NativeSurfaceRegionView(frame: .zero)
            backdropContainer.addSubview(surface)
            glassRegionViews.append(surface)
        }
        updateNativeGlassViews()
        positionWindowButtons()
        window.invalidateShadow()
    }

    private func positionWindowButtons() {
        guard let main = glassRegions.first, let content = window.contentView else { return }
        windowControls?.setFrameOrigin(NSPoint(x: main.rect.minX + 20, y: content.bounds.height - 32))
        let zoomLabel = isWindowExpanded ? "还原窗口" : "放大窗口"
        zoomWindowButton?.toolTip = zoomLabel
        zoomWindowButton?.setAccessibilityLabel(zoomLabel)
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(type)?.isHidden = true
        }
    }

    private func nativeWindowButtonDiagnostics() -> [String: Any] {
        var buttons: [String: Any] = [:]
        for (name, button) in [("close", closeWindowButton), ("minimize", minimizeWindowButton), ("zoom", zoomWindowButton)] {
            guard let button = button else { continue }
            buttons[name] = [
                "frame": NSStringFromRect(button.frame),
                "contentFrame": NSStringFromRect(button.convert(button.bounds, to: window.contentView)),
                "visibleRect": NSStringFromRect(button.visibleRect),
                "hidden": button.isHidden,
                "hiddenByAncestor": button.isHiddenOrHasHiddenAncestor,
                "enabled": button.isEnabled,
                "alpha": button.alphaValue,
                "parentClass": button.superview.map { NSStringFromClass(type(of: $0)) } ?? "nil",
                "parentFrame": button.superview.map { NSStringFromRect($0.frame) } ?? "nil",
                "parentBounds": button.superview.map { NSStringFromRect($0.bounds) } ?? "nil",
                "parentClipsToBounds": button.superview?.clipsToBounds ?? false,
                "nativeFactoryButton": true,
                "targetIsWindow": button.target as AnyObject? === window,
                "targetIsAppDelegate": button.target as AnyObject? === self,
                "action": button.action.map(NSStringFromSelector) ?? "nil",
            ]
        }
        if let main = glassRegions.first {
            buttons["workspaceX"] = main.rect.minX
            buttons["expectedCloseX"] = main.rect.minX + 20
            buttons["expectedMinimizeX"] = main.rect.minX + 40
            buttons["expectedZoomX"] = main.rect.minX + 60
        }
        buttons["originalButtonsHidden"] = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].allSatisfy { window.standardWindowButton($0)?.isHidden == true }
        return buttons
    }

    private func isTrustedMainFrame(_ message: WKScriptMessage) -> Bool {
        guard message.frameInfo.isMainFrame, let serverURL = serverURL, let port = serverURL.port,
              message.frameInfo.securityOrigin.protocol == "http",
              message.frameInfo.securityOrigin.host == "127.0.0.1",
              message.frameInfo.securityOrigin.port == port,
              message.frameInfo.request.url?.scheme == "http",
              message.frameInfo.request.url?.host == "127.0.0.1",
              message.frameInfo.request.url?.port == port else { return false }
        return true
    }

    @objc private func toggleWindowZoom() {
        guard !changingWindowFrame, let screen = window.screen ?? NSScreen.main else { return }
        changingWindowFrame = true
        let destination: NSRect
        if let original = restoreWindowFrame {
            destination = original
            restoreWindowFrame = nil
        } else {
            restoreWindowFrame = window.frame
            destination = screen.visibleFrame.insetBy(dx: 12, dy: 12)
        }
        // AppKit's animated zoom can retain a window-sized snapshot of glass
        // and WebKit. Set the exact frame without a second cached zoom surface.
        window.setFrame(destination, display: true, animate: false)
        synchronizeNativeLayout()
        changingWindowFrame = false
        sendWindowState()
    }

    private func sendWindowState() {
        guard !quitting, webView.url?.host == "127.0.0.1", webView.url?.port == serverURL?.port else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('frameflow:window-state',{detail:{zoomed:\(isWindowExpanded ? "true" : "false")}}));", completionHandler: nil)
    }

    private func requestGlassGeometry() {
        guard !quitting, webView.url?.host == "127.0.0.1", webView.url?.port == serverURL?.port else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('frameflow:geometry'));", completionHandler: nil)
    }

    private func synchronizeNativeLayout() {
        guard let content = window.contentView else { return }
        content.layoutSubtreeIfNeeded()
        backdropContainer.frame = content.bounds
        webView.frame = content.bounds
        positionWindowButtons()
        webView.needsDisplay = true
        requestGlassGeometry()
    }

    func windowWillUseStandardFrame(_ window: NSWindow, defaultFrame newFrame: NSRect) -> NSRect {
        return (window.screen ?? NSScreen.main)?.visibleFrame.insetBy(dx: 12, dy: 12) ?? newFrame
    }

    func windowWillStartLiveResize(_ notification: Notification) {
        if !changingWindowFrame { restoreWindowFrame = nil }
        positionWindowButtons()
        sendWindowState()
    }

    func windowDidResize(_ notification: Notification) {
        guard !windowStateUpdateScheduled else { return }
        windowStateUpdateScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.windowStateUpdateScheduled = false
            self.synchronizeNativeLayout()
            self.sendWindowState()
        }
    }

    private func buildMenu() {
        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        menu.addItem(applicationItem)
        let applicationMenu = NSMenu(title: "FrameFlow")
        applicationItem.submenu = applicationMenu
        addItem("关于 FrameFlow", action: #selector(showAbout), key: "", menu: applicationMenu)
        applicationMenu.addItem(.separator())
        addItem("设置…", action: #selector(showSettings), key: ",", menu: applicationMenu)
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "隐藏 FrameFlow", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = applicationMenu.addItem(withTitle: "隐藏其他应用", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        applicationMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "退出 FrameFlow", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit
        menu.addItem(editItem)
        let viewItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        let view = NSMenu(title: "窗口")
        addItem("重新加载", action: #selector(reload), key: "r", menu: view)
        addItem("显示项目文件夹", action: #selector(revealWorkspace), key: "", menu: view)
        view.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        addItem("放大 / 还原", action: #selector(toggleWindowZoom), key: "", menu: view)
        viewItem.submenu = view
        menu.addItem(viewItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = view
    }

    private func addItem(_ title: String, action: Selector, key: String, menu: NSMenu) {
        let item = menu.addItem(withTitle: title, action: action, keyEquivalent: key)
        item.target = self
    }

    private var workspace: URL {
        URL(fileURLWithPath: Bundle.main.object(forInfoDictionaryKey: "FrameFlowWorkspacePath") as? String ?? "")
    }

    private func showLoading() {
        let background = "#E8EAED"
        let foreground = "#25282D"
        let secondary = "#626770"
        webView.loadHTMLString("""
        <!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
        body{margin:0;height:100vh;display:grid;place-content:center;background:\(background);color:\(foreground);font-family:-apple-system,'PingFang SC',sans-serif;text-align:center}
        .mark{margin:auto;width:68px;height:68px;border-radius:20px;background:\(foreground);color:\(background);font-size:44px;font-weight:700;line-height:68px}
        h1{font-size:25px;margin:22px 0 10px}p{font-size:14px;color:\(secondary)}
        </style><div class="mark">F</div><h1>FrameFlow</h1><p>正在打开视频创作工作室…</p></html>
        """, baseURL: nil)
    }

    private func startServer() {
        let nodePath = Bundle.main.object(forInfoDictionaryKey: "FrameFlowNodePath") as? String ?? "/usr/local/bin/node"
        let pythonPath = workspace.appendingPathComponent(".venv/bin/python3").path
        let scriptPath = workspace.appendingPathComponent("web/server.mjs").path
        guard FileManager.default.isExecutableFile(atPath: nodePath),
              FileManager.default.isExecutableFile(atPath: pythonPath),
              FileManager.default.fileExists(atPath: workspace.appendingPathComponent("web/dist/index.html").path),
              FileManager.default.fileExists(atPath: scriptPath) else {
            showError("未找到完整的本地运行环境。请保留 FrameFlow 项目目录，并重新运行 desktop/build-macos.sh。")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [scriptPath]
        // Finder-launched Node can block while resolving a working directory
        // beneath Documents. All server paths are anchored to the script URL.
        process.currentDirectoryURL = Bundle.main.resourceURL
        var environment = ProcessInfo.processInfo.environment
        environment["VIMAX_PYTHON_CMD"] = pythonPath
        environment["VIMAX_WEB_HOST"] = "127.0.0.1"
        environment["VIMAX_WEB_PORT"] = "0"
        environment["LANG"] = "zh_CN.UTF-8"
        environment["LC_CTYPE"] = "UTF-8"
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        logPipe = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.consumeServerOutput(text) }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.server = nil
                self.showError("本地创作服务已停止。请退出后重新打开 FrameFlow。（状态码：\(process.terminationStatus)）")
            }
        }
        server = process
        do { try process.run() } catch {
            server = nil
            showError("无法启动本地创作服务：\(error.localizedDescription)")
        }
    }

    private func consumeServerOutput(_ text: String) {
        logBuffer = String((logBuffer + text).suffix(16_384))
        guard serverURL == nil,
              let match = logBuffer.range(of: "http://127\\.0\\.0\\.1:[0-9]+", options: .regularExpression),
              let url = URL(string: String(logBuffer[match])), url.port != 0 else { return }
        serverURL = url
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.host == "127.0.0.1", webView.url?.port == serverURL?.port else { return }
        updateNativeTransparency()
        sendWindowState()
        guard let reportPath = ProcessInfo.processInfo.environment["FRAMEFLOW_SMOKE_REPORT"] else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self = self else { return }
            let smokeView = ProcessInfo.processInfo.environment["FRAMEFLOW_SMOKE_VIEW"]
            if smokeView == "settings" { self.showSettings() }
            if smokeView == "director" || smokeView == "video_editor" {
                self.webView.evaluateJavaScript("Array.from(document.querySelectorAll('.primary-nav button')).find(b=>b.textContent.trim()==='导演台')?.click();", completionHandler: nil)
            }
            if smokeView == "project" {
                self.webView.evaluateJavaScript("Array.from(document.querySelectorAll('.primary-nav button')).find(b=>b.textContent.trim()==='新建项目')?.click();", completionHandler: nil)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitForSmokeContent(reportPath: reportPath) }
        }
    }

    private func waitForSmokeContent(reportPath: String, attempt: Int = 0) {
        let smokeView = ProcessInfo.processInfo.environment["FRAMEFLOW_SMOKE_VIEW"]
        guard (smokeView == "settings" || smokeView == "startup_error" || smokeView == "director" || smokeView == "video_editor" || smokeView == "assistant"), attempt < 40 else {
            finishSmoke(reportPath: reportPath)
            return
        }
        let check: String
        switch smokeView {
        case "assistant":
            check = "Boolean(document.querySelector('.app-shell[data-view=\"workspace\"] .assistant-dock textarea[aria-label=\"向 FrameFlow 发送消息\"]') && document.querySelector('.assistant-prompt-hints'))"
        case "director":
            check = "(() => { if (document.querySelector('.director-project-settings')) return true; Array.from(document.querySelectorAll('.primary-nav button')).find(b=>b.textContent.trim()==='导演台')?.click(); return false; })()"
        case "video_editor":
            check = "(() => { if (document.querySelector('.video-editor-command select')) return true; if (!document.querySelector('.director-project-settings')) { Array.from(document.querySelectorAll('.primary-nav button')).find(b=>b.textContent.trim()==='导演台')?.click(); return false; } Array.from(document.querySelectorAll('.director-header-actions button')).find(b=>b.textContent.trim()==='剪辑已有视频')?.click(); return false; })()"
        default:
            let selector = smokeView == "startup_error" ? ".message-error-action" : ".local-agent-grid"
            check = "Boolean(document.querySelector('\(selector)'))"
        }
        webView.evaluateJavaScript(check) { result, _ in
            if result as? Bool == true { self.finishSmoke(reportPath: reportPath) }
            else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.waitForSmokeContent(reportPath: reportPath, attempt: attempt + 1)
                }
            }
        }
    }

    private func runSmokeWindowChecks(reportPath: String) {
        let startingFrame = window.frame
        var checks: [[String: Any]] = []
        var manualResizeReset = false

        func checkCycle(_ label: String, completion: @escaping () -> Void) {
            let original = self.window.frame
            let initialZoomed = self.isWindowExpanded
            self.zoomWindowButton?.performClick(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                let expanded = self.window.frame
                let expandedZoomed = self.isWindowExpanded
                self.zoomWindowButton?.performClick(nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                    checks.append([
                        "name": label,
                        "initialZoomed": initialZoomed,
                        "expandedZoomed": expandedZoomed,
                        "restoredZoomed": self.isWindowExpanded,
                        "expanded": expanded.width > original.width || expanded.height > original.height,
                        "restored": self.window.frame.equalTo(original),
                        "originalFrame": NSStringFromRect(original),
                        "restoredFrame": NSStringFromRect(self.window.frame),
                        "enteredFullScreen": self.window.styleMask.contains(.fullScreen),
                    ])
                    completion()
                }
            }
        }

        func resizedFrame(_ original: NSRect) -> NSRect {
            var frame = original
            frame.size.width = max(self.window.minSize.width, original.width - 120)
            frame.size.height = max(self.window.minSize.height, original.height - 90)
            return frame
        }

        func completeChecks() {
            self.restoreWindowFrame = nil
            self.window.setFrame(startingFrame, display: true, animate: false)
            self.synchronizeNativeLayout()
            self.smokeZoomResult = [
                "source": "native-green-button",
                "cycles": checks,
                "cycleCount": checks.count,
                "expanded": checks.allSatisfy { $0["expanded"] as? Bool == true },
                "restored": checks.allSatisfy { $0["restored"] as? Bool == true },
                "enteredFullScreen": checks.contains { $0["enteredFullScreen"] as? Bool == true },
                "manualResizeResetExpandedState": manualResizeReset,
            ]
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                self.finishSmoke(reportPath: reportPath)
            }
        }

        func resizeWhileExpanded() {
            self.zoomWindowButton?.performClick(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                // Exercise the same delegate notification as a real mouse resize
                // without interacting with the user's foreground window.
                self.windowWillStartLiveResize(Notification(name: NSWindow.willStartLiveResizeNotification, object: self.window))
                self.window.setFrame(resizedFrame(startingFrame), display: true, animate: false)
                self.synchronizeNativeLayout()
                manualResizeReset = !self.isWindowExpanded
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                    checkCycle("resize-while-expanded") { completeChecks() }
                }
            }
        }

        func resizeBeforeZoom() {
            self.windowWillStartLiveResize(Notification(name: NSWindow.willStartLiveResizeNotification, object: self.window))
            self.window.setFrame(resizedFrame(startingFrame), display: true, animate: false)
            self.synchronizeNativeLayout()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                checkCycle("resize-before-zoom") { resizeWhileExpanded() }
            }
        }

        func repeatedCycles(_ index: Int) {
            guard index < 3 else { resizeBeforeZoom(); return }
            checkCycle("original-size-\(index + 1)") { repeatedCycles(index + 1) }
        }
        repeatedCycles(0)
    }

    private func finishSmoke(reportPath: String) {
        if ProcessInfo.processInfo.environment["FRAMEFLOW_SMOKE_WINDOW_ZOOM"] == "1", !didRunSmokeZoom {
            didRunSmokeZoom = true
            runSmokeWindowChecks(reportPath: reportPath)
            return
        }
        let script = "JSON.stringify({title:document.title,lang:document.documentElement.lang,text:document.body.innerText,buttons:Array.from(document.querySelectorAll('button')).map(b=>b.getAttribute('aria-label')||b.textContent.trim()),placeholders:Array.from(document.querySelectorAll('input')).map(i=>i.placeholder)})"
        webView.evaluateJavaScript(script) { result, error in
            var report = ((result as? String)?.data(using: .utf8)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            report["native"] = [
                "glass": self.nativeGlassKind,
                "behindWindowBlur": false,
                "transparentTitlebar": self.window.titlebarAppearsTransparent,
                "titleHidden": self.window.titleVisibility == .hidden,
                "windowShadow": self.window.hasShadow,
                "fullSizeContent": self.window.styleMask.contains(.fullSizeContentView),
                "fullScreenDisabled": self.window.collectionBehavior.contains(.fullScreenNone),
                "nativeZoomButtonHidden": self.window.standardWindowButton(.zoomButton)?.isHidden ?? false,
                "nativeWindowButtons": self.nativeWindowButtonDiagnostics(),
                "webBackgroundClear": self.webView.underPageBackgroundColor.alphaComponent == 0,
                "pageBackgroundDisabled": !self.webView.isOpaque,
                "drawsBackground": self.webView.responds(to: NSSelectorFromString("_drawsBackground")) || self.webView.responds(to: NSSelectorFromString("drawsBackground")) ? (self.webView.value(forKey: "drawsBackground") as? Bool ?? true) : true,
                "reduceTransparency": self.reducesTransparency,
                "zoomed": self.isWindowExpanded,
                "glassRegionCount": self.glassRegions.count,
                "glassRegionMask": self.glassRegionViews.allSatisfy { $0.layer?.masksToBounds == true },
                "glassRegionsIndependent": true,
                "webBounds": NSStringFromRect(self.webView.bounds),
                "nativeBounds": NSStringFromRect(self.backdropContainer.bounds),
                "glassRegionFramesMatch": zip(self.glassRegions, self.glassRegionViews).allSatisfy { $0.0.rect.equalTo($0.1.frame) },
                "glassRegionViews": self.glassRegionViews.map { ["frame": NSStringFromRect($0.frame), "bounds": NSStringFromRect($0.bounds), "radius": $0.radius, "maskImage": false] as [String: Any] },
                "rejectedGeometryMessages": self.rejectedGeometryMessages,
                "zoomCheck": self.smokeZoomResult ?? [:],
            ]
            if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: URL(fileURLWithPath: reportPath), options: .atomic)
            }
            self.webView.takeSnapshot(with: nil) { image, error in
                if let image = image, let data = image.tiffRepresentation,
                   let bitmap = NSBitmapImageRep(data: data),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: reportPath + ".png"))
                }
                NSApp.terminate(nil)
            }
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "FrameFlow 遇到问题"
        alert.informativeText = message
        alert.addButton(withTitle: "知道了")
        alert.beginSheetModal(for: window)
    }

    @objc private func reload() { if let url = serverURL { webView.load(URLRequest(url: url)) } }
    @objc private func revealWorkspace() { NSWorkspace.shared.open(workspace) }
    @objc private func showSettings() {
        webView.evaluateJavaScript("Array.from(document.querySelectorAll('.primary-nav button')).find(b=>b.textContent.trim()==='设置')?.click();", completionHandler: nil)
    }
    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = "FrameFlow"
        alert.informativeText = "视频创作工作室 · 中文桌面版\n让灵感流动成画面。\n\n基于 HKUDS ViMax 开源引擎（MIT 许可证）。"
        alert.addButton(withTitle: "完成")
        alert.beginSheetModal(for: window)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard isTrustedMainFrame(message) else { return }
        if message.name == "frameflowWindow", let body = message.body as? [String: Any], let action = body["action"] as? String {
            switch action {
            case "zoom", "toggle": toggleWindowZoom()
            case "status": sendWindowState()
            case "glass-regions":
                if let width = body["viewportWidth"] as? Double, let height = body["viewportHeight"] as? Double,
                   width.isFinite, height.isFinite,
                   abs(width - webView.bounds.width) <= 1, abs(height - webView.bounds.height) <= 1,
                   let regions = body["regions"] as? [[String: Any]] {
                    updateGlassRegions(regions)
                } else {
                    rejectedGeometryMessages += 1
                    requestGlassGeometry()
                }
            default: break
            }
        }
        if message.name == "frameflowTheme", let theme = message.body as? String, ["light", "dark"].contains(theme) {
            if !isSmoke { UserDefaults.standard.set(theme, forKey: "FrameFlowTheme") }
            window.appearance = NSAppearance(named: theme == "dark" ? .darkAqua : .aqua)
            updateNativeTransparency()
            DispatchQueue.main.async { [weak self] in self?.positionWindowButtons() }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        quitting = true
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        logPipe?.fileHandleForReading.readabilityHandler = nil
        if let server = server, server.isRunning { server.terminate() }
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.host == "127.0.0.1" && url.port == serverURL?.port) {
            if navigationAction.shouldPerformDownload { decisionHandler(.download) } else { decisionHandler(.allow) }
            return
        }
        if navigationAction.navigationType == .linkActivated, ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            if url.host == "127.0.0.1" && url.port == serverURL?.port { webView.load(URLRequest(url: url)) }
            else if ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "选择创作素材"
        panel.prompt = "选择"
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "FrameFlow"; alert.informativeText = message
        alert.addButton(withTitle: "确定"); alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "FrameFlow"; alert.informativeText = message
        alert.addButton(withTitle: "确定"); alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.title = "保存创作文件"; panel.prompt = "保存"; panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.url : nil) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { showError("文件保存失败：\(error.localizedDescription)") }
}

func renderIcon(at path: String) {
    let size = NSSize(width: 1024, height: 1024)
    let image = NSImage(size: size)
    image.lockFocus()
    let shape = NSBezierPath(roundedRect: NSRect(x: 48, y: 48, width: 928, height: 928), xRadius: 235, yRadius: 235)
    NSGradient(starting: NSColor(red: 0.16, green: 0.47, blue: 0.93, alpha: 1), ending: NSColor(red: 0.38, green: 0.27, blue: 0.86, alpha: 1))!.draw(in: shape, angle: -45)
    NSColor.white.setFill()
    let f = NSBezierPath()
    for (i, point) in [NSPoint(x: 278,y: 236), NSPoint(x: 410,y: 236), NSPoint(x: 410,y: 416), NSPoint(x: 660,y: 416), NSPoint(x: 660,y: 545), NSPoint(x: 410,y: 545), NSPoint(x: 410,y: 668), NSPoint(x: 726,y: 668), NSPoint(x: 726,y: 798), NSPoint(x: 278,y: 798)].enumerated() {
        if i == 0 { f.move(to: point) } else { f.line(to: point) }
    }
    f.close(); f.fill()
    NSColor(red: 0.68, green: 0.94, blue: 1, alpha: 1).setFill()
    let play = NSBezierPath(); play.move(to: NSPoint(x: 665,y: 210)); play.line(to: NSPoint(x: 665,y: 388)); play.line(to: NSPoint(x: 818,y: 299)); play.close(); play.fill()
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--render-icon" {
    renderIcon(at: CommandLine.arguments[2])
} else {
    let app = NSApplication.shared
    let backgroundSmoke = ProcessInfo.processInfo.environment["FRAMEFLOW_SMOKE_REPORT"] != nil && ProcessInfo.processInfo.environment["FRAMEFLOW_SMOKE_BACKGROUND"] == "1"
    app.setActivationPolicy(backgroundSmoke ? .accessory : .regular)
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
