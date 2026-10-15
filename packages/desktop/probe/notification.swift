import AppKit
import UserNotifications
import WebKit

// 配布と同じ ad-hoc 署名で macOS の通知境界だけを先に検証する。
final class Probe: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var label: NSTextField!
    let center = UNUserNotificationCenter.current()
    var browser: WKWebView?
    var sidecar: Process?
    var baseURL: URL?
    var timer: Timer?
    var delivery: ProbeDelivery?
    var pendingIssue: String?
    var config: ProbeConfig?

    struct ProbeConfig: Decodable {
        let sidecarPath: String
        let webDir: String
        let stateDir: String
        let startupDelay: Double?
    }

    static func timestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        center.delegate = self
        if let resource = Bundle.main.url(forResource: "probe", withExtension: "json"),
           let data = try? Data(contentsOf: resource) { config = try? JSONDecoder().decode(ProbeConfig.self, from: data) }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: config == nil ? 300 : 800),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "nod 通知方式の検証"
        window.center()
        window.isReleasedWhenClosed = false
        let view = window.contentView!
        label = NSTextField(labelWithString: "許可要求を押してから通知を送信してください。")
        label.frame = NSRect(x: 30, y: 230, width: 640, height: 30)
        view.addSubview(label)
        for (index, entry) in [("通知の許可を要求", #selector(allow)), ("検証通知を送信", #selector(send)), ("OS 許可状態を確認", #selector(status))].enumerated() {
            let button = NSButton(title: entry.0, target: self, action: entry.1)
            button.frame = NSRect(x: 30 + index * 220, y: 155, width: 210, height: 40)
            view.addSubview(button)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "検証アプリを終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let root = NSMenuItem()
        root.submenu = appMenu
        menu.addItem(root)
        NSApp.mainMenu = menu
        if let config = config {
            let browser = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 640))
            browser.autoresizingMask = [.width, .height]
            browser.navigationDelegate = self
            view.addSubview(browser)
            self.browser = browser
            label.frame = NSRect(x: 30, y: 750, width: 1040, height: 30)
            for (index, button) in view.subviews.compactMap({ $0 as? NSButton }).enumerated() {
                button.frame = NSRect(x: 30 + index * 250, y: 680, width: 240, height: 40)
            }
            pendingIssue = try? String(contentsOfFile: config.stateDir + "/pending-issue", encoding: .utf8)
            restoreDelivery()
            DispatchQueue.main.asyncAfter(deadline: .now() + (config.startupDelay ?? 0)) { self.startSidecar(config) }
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in self.poll() }
        }
    }

    @objc func allow() {
        if let config = config {
            let path = config.stateDir + "/enabled-at"
            if !FileManager.default.fileExists(atPath: path) { try? Self.timestamp().write(toFile: path, atomically: true, encoding: .utf8) }
            restoreDelivery()
        }
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                self.label.stringValue = "許可要求: \(granted ? "許可" : "拒否") / \(error?.localizedDescription ?? "エラーなし")"
            }
        }
    }

    @objc func status() {
        center.getNotificationSettings { settings in
            DispatchQueue.main.async { self.label.stringValue = "OS 許可状態: \(settings.authorizationStatus.rawValue)（0未要求・1拒否・2許可）" }
        }
    }

    @objc func send() {
        let content = UNMutableNotificationContent()
        content.title = "nod 検証リマインダー"
        content.body = "通知をクリックすると対象 Issue の識別情報を表示します。"
        content.userInfo = ["issueId": "PROBE-1", "notificationId": 1]
        content.sound = .default
        label.stringValue = "3秒後に検証通知を送信します。閉窓して検証できます。"
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            self.center.add(UNNotificationRequest(identifier: "nod-probe-\(UUID().uuidString)", content: content, trigger: nil)) { error in
                DispatchQueue.main.async { self.label.stringValue = "OS 送信: \(error?.localizedDescription ?? "受理")" }
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        DispatchQueue.main.async {
            self.label.stringValue = "クリック受信: \(info["issueId"] ?? "なし") / Inbox #\(info["notificationId"] ?? "なし")"
            if let issue = info["issueId"] as? String, let config = self.config {
                self.pendingIssue = issue
                try? issue.write(toFile: config.stateDir + "/pending-issue", atomically: true, encoding: .utf8)
                self.openPending()
            }
            self.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        completionHandler()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
        if sidecar?.isRunning == true { sidecar?.terminate(); sidecar?.waitUntilExit() }
    }

    func restoreDelivery() {
        guard let config = config,
              let enabledAt = try? String(contentsOfFile: config.stateDir + "/enabled-at", encoding: .utf8) else { return }
        let path = config.stateDir + "/claimed.json"
        let claimed = (try? JSONDecoder().decode(Set<Int>.self, from: Data(contentsOf: URL(fileURLWithPath: path)))) ?? []
        delivery = ProbeDelivery(enabledAt: enabledAt, claimed: claimed, clock: Self.timestamp,
            claim: { ids in try JSONEncoder().encode(ids).write(to: URL(fileURLWithPath: path), options: .atomic) },
            send: { item in self.sendReminder(item) })
    }

    func startSidecar(_ config: ProbeConfig) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: config.sidecarPath)
        process.arguments = ["ui", "--port", "0", "--no-open", "--web-dir", config.webDir]
        var env = ProcessInfo.processInfo.environment
        env["NOD_DB"] = config.stateDir + "/nod.db"
        env["NOD_ORCA"] = "0"
        env["NOD_DOCS_DIR"] = config.stateDir + "/documents"
        env["NOD_ATTACHMENTS_DIR"] = config.stateDir + "/attachments"
        env["NOD_TOGGL_CONFIG"] = config.stateDir + "/toggl.json"
        process.environment = env
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.standardError
        var output = ""
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            output += String(decoding: data, as: UTF8.self)
            guard let range = output.range(of: "http://127\\.0\\.0\\.1:[0-9]+/", options: .regularExpression),
                  let url = URL(string: String(output[range])) else { return }
            DispatchQueue.main.async {
                guard self.baseURL == nil else { return }
                self.baseURL = url
                if self.pendingIssue != nil { self.openPending() } else { self.browser?.load(URLRequest(url: url)) }
                self.label.stringValue = "隔離 sidecar 接続済み: \(url.absoluteString)"
            }
        }
        do { try process.run(); sidecar = process }
        catch { label.stringValue = "隔離 sidecar を起動できません: \(error.localizedDescription)" }
    }

    func openPending() {
        guard let issue = pendingIssue, let base = baseURL,
              let escaped = issue.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "issues/\(escaped)", relativeTo: base) else { return }
        browser?.load(URLRequest(url: url))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let issue = pendingIssue, webView.url?.path == "/issues/\(issue)", let config = config else { return }
        // 試作はページの読み込みまで。製品では Issue の正常表示と個別既読の応答まで保持する。
        pendingIssue = nil
        try? FileManager.default.removeItem(atPath: config.stateDir + "/pending-issue")
    }

    func poll() {
        guard let base = baseURL, delivery != nil else { return }
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            URLSession.shared.dataTask(with: base.appendingPathComponent("api/notifications")) { data, _, error in
                guard error == nil, let data = data,
                      let candidates = try? JSONDecoder().decode([ReminderCandidate].self, from: data) else { return }
                DispatchQueue.main.async { try? self.delivery?.deliver(candidates) }
            }.resume()
        }
    }

    func sendReminder(_ item: ProbeNotification) {
        let content = UNMutableNotificationContent()
        content.title = item.title
        content.body = item.body
        content.userInfo = ["issueId": item.issueId, "notificationId": item.notificationId]
        content.sound = .default
        center.add(UNNotificationRequest(identifier: "nod-reminder-\(item.notificationId)", content: content, trigger: nil)) { error in
            DispatchQueue.main.async { self.label.stringValue = "Inbox #\(item.notificationId) OS送信: \(error?.localizedDescription ?? "受理")" }
        }
    }
}

@main
struct ProbeApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = Probe()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
