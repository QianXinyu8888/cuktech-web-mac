import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let base = Bundle.main.bundleURL.deletingLastPathComponent()
        let manager = base.appendingPathComponent("macos/manage.sh")
        let python = base.appendingPathComponent(".venv/bin/python")
        do {
            guard FileManager.default.fileExists(atPath: manager.path) else {
                throw LaunchError.message("请将本应用留在 cuktech-web-mac 文件夹中，与其余文件放在一起。")
            }
            guard FileManager.default.isExecutableFile(atPath: python.path) else {
                throw LaunchError.message("请先双击同一文件夹内的「安装环境.command」，安装完成后再打开本应用。")
            }
            let runtime = base.appendingPathComponent("runtime", isDirectory: true)
            try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let log = runtime.appendingPathComponent("app-launch.log")
            if !FileManager.default.fileExists(atPath: log.path) {
                FileManager.default.createFile(atPath: log.path, contents: nil)
            }
            let output = try FileHandle(forWritingTo: log)
            try output.seekToEnd()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [manager.path, "run"]
            process.currentDirectoryURL = base
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = output
            process.standardError = output
            let report = runtime.appendingPathComponent("startup-" + UUID().uuidString)
            var environment = ProcessInfo.processInfo.environment
            environment["CUKTECH_STARTUP_REPORT"] = report.path
            process.environment = environment
            try process.run()
            try output.close()
            let deadline = Date().addingTimeInterval(90)
            Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { timer in
                let ready = FileManager.default.fileExists(atPath: report.path)
                if ready || !process.isRunning || Date() > deadline {
                    timer.invalidate()
                    try? FileManager.default.removeItem(at: report)
                    if !ready {
                        let alert = NSAlert()
                        alert.messageText = "酷态站 启动失败"
                        alert.informativeText = "服务未能就绪，请查看日志：\n" + log.path + "\n" + (base.appendingPathComponent("runtime/service.log").path)
                        alert.addButton(withTitle: "好")
                        alert.runModal()
                    }
                    NSApp.terminate(nil)
                }
            }
            return
        } catch {
            let alert = NSAlert()
            alert.messageText = "酷态站"
            alert.informativeText = error.localizedDescription
            alert.addButton(withTitle: "好")
            alert.runModal()
        }
        NSApp.terminate(nil)
    }
}

enum LaunchError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): return text }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
