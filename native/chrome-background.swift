import AppKit
import Foundation
import Darwin

// Launch only the app-owned Chrome instance hidden, without activating it. The
// helper stays alive so its parent can terminate exactly this instance on exit.
guard CommandLine.arguments.count > 1 else { exit(64) }
let configuration = NSWorkspace.OpenConfiguration()
configuration.createsNewApplicationInstance = true
configuration.activates = false
configuration.hides = true
configuration.arguments = Array(CommandLine.arguments.dropFirst())
var owned: NSRunningApplication?
var stopping = false
var ready = false
let startupDeadline = Date().addingTimeInterval(8)
let owner = getppid()
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler {
    stopping = true
    owned?.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        owned?.forceTerminate()
        exit(0)
    }
}
termination.resume()
let watchdog = DispatchSource.makeTimerSource(queue: .main)
watchdog.schedule(deadline: .now() + 1, repeating: 0.25)
watchdog.setEventHandler {
    if getppid() != owner { owned?.terminate(); exit(0) }
    if let application = owned, application.isTerminated { exit(0) }
    if let application = owned, !ready, !stopping {
        if application.isFinishedLaunching {
            if !application.isHidden { application.hide() }
            if application.isHidden {
                ready = true
                FileHandle.standardOutput.write(Data("ready\n".utf8))
            }
        }
        if !ready && Date() > startupDeadline { application.terminate(); exit(71) }
    }
}
watchdog.resume()
NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/Applications/Google Chrome.app"), configuration: configuration) { application, error in
    guard error == nil, let application = application else { exit(70) }
    owned = application
    if stopping { application.terminate(); return }
    // The Launch Services configuration hides the app before it is presented.
    // Confirm it is hidden; never activate it or affect another Chrome instance.
    // isHidden updates asynchronously. The watchdog waits for the hidden state
    // before the parent is allowed to create even the blank bootstrap target.
}
RunLoop.main.run()
