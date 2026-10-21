import Foundation
import Darwin

// Runs from the private update cache, never from the bundle being replaced.
// No elevation, forced termination, database access, or Gatekeeper modifications.
struct Job: Decodable {
    let source: String
    let target: String
    let currentVersion: String
    let version: String
    let parentPID: Int32
    let result: String
}
enum Failure: Error { case invalid, cancelled, timeout, launch }
let fm = FileManager.default
let bundleName = "Odoo Lifecycle Manager.app"
let bundleID = "local.odoo.lifecycle-manager"
func validate(_ url: URL, version: String? = nil) throws {
    guard url.resolvingSymlinksInPath().path == url.standardizedFileURL.path,
          let data = fm.contents(atPath: url.appendingPathComponent("Contents/Info.plist").path),
          let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
          info["CFBundleIdentifier"] as? String == bundleID,
          info["CFBundleExecutable"] as? String == "Odoo Lifecycle Manager",
          version == nil || info["CFBundleShortVersionString"] as? String == version,
          fm.isExecutableFile(atPath: url.appendingPathComponent("Contents/MacOS/Odoo Lifecycle Manager").path)
    else { throw Failure.invalid }
}
func report(_ job: Job, _ status: String) {
    let data = try? JSONSerialization.data(withJSONObject: ["status": status, "version": job.version])
    try? data?.write(to: URL(fileURLWithPath: job.result), options: [.atomic])
}
func launch(_ url: URL) throws {
    #if UPDATE_INSTALLER_TESTING
    if fm.fileExists(atPath: url.appendingPathComponent("fail-launch").path) { throw Failure.launch }
    #else
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-n", url.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    if process.terminationStatus != 0 { throw Failure.launch }
    #endif
}
func install(_ job: Job) throws {
    let source = URL(fileURLWithPath: job.source).standardizedFileURL
    let target = URL(fileURLWithPath: job.target).standardizedFileURL
    let parent = target.deletingLastPathComponent()
    #if UPDATE_INSTALLER_TESTING
    let testRoot = URL(fileURLWithPath: NSTemporaryDirectory()).resolvingSymlinksInPath().path + "/"
    guard parent.path.hasPrefix(testRoot), target.lastPathComponent == bundleName else { throw Failure.invalid }
    #else
    let personal = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications").appendingPathComponent(bundleName).path
    guard ["/Applications/\(bundleName)", personal].contains(target.path) else { throw Failure.invalid }
    #endif
    guard job.parentPID == getppid(), job.parentPID > 1,
          source.path != target.path,
          fm.isWritableFile(atPath: parent.path),
          parent.resolvingSymlinksInPath().path == parent.path else { throw Failure.invalid }
    try validate(source, version: job.version)
    try validate(target, version: job.currentVersion)
    let prepared = parent.appendingPathComponent(".odoo-update-\(UUID().uuidString).app")
    let backup = parent.appendingPathComponent(".Odoo Lifecycle Manager.previous.app")
    // Copy before asking the app to quit, on the same volume as the final bundle.
    defer { try? fm.removeItem(at: prepared) }
    try fm.copyItem(at: source, to: prepared)
    try validate(prepared, version: job.version)
    FileHandle.standardOutput.write(Data("READY\n".utf8))
    guard readLine() == "INSTALL" else { throw Failure.cancelled }
    FileHandle.standardOutput.write(Data("ACCEPTED\n".utf8))
    let deadline = Date().addingTimeInterval(120)
    while kill(job.parentPID, 0) == 0 || errno == EPERM {
        if Date() > deadline { throw Failure.timeout }
        Thread.sleep(forTimeInterval: 0.1)
    }
    // Recheck the target after exit. Never overwrite a different app/version.
    try validate(target, version: job.currentVersion)
    if fm.fileExists(atPath: backup.path) { try validate(backup); try fm.removeItem(at: backup) }
    try fm.moveItem(at: target, to: backup)
    do {
        try fm.moveItem(at: prepared, to: target)
        try validate(target, version: job.version)
        try launch(target)
        report(job, "installed")
    } catch {
        // Restore the original if replacement or launch fails. Keep the failed build for diagnostics.
        if fm.fileExists(atPath: target.path) { try fm.moveItem(at: target, to: prepared) }
        try fm.moveItem(at: backup, to: target)
        report(job, "failed")
        try? launch(target)
        throw error
    }
}
do {
    guard CommandLine.arguments.count == 2 else { throw Failure.invalid }
    let job = try JSONDecoder().decode(Job.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    do { try install(job) }
    catch { report(job, "failed"); throw error }
} catch { exit(1) }
