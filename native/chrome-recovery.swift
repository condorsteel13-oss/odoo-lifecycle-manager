import AppKit
import Foundation
import Darwin

// Only app-owned profile metadata is read. Never inspect cookies, tabs or URLs.
// No privilege elevation, lock-file deletion, or forced browser termination.
struct Identity: Codable, Equatable {
    let pid: Int32
    let seconds: UInt64
    let microseconds: UInt64
}
struct Lease: Codable {
    let version: Int
    let owner: Identity
    let token: String
    let port: Int
}
struct Browser {
    let identity: Identity
    let parent: Int32
    let port: Int
}
enum Failure: String, Error {
    case busy = "CHROME_PROFILE_BUSY"
    case unavailable = "CHROME_RECOVERY_UNAVAILABLE"
    case timeout = "CHROME_CLOSE_TIMEOUT"
}
let fm = FileManager.default
let chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
func canonical(_ path: String) -> String { URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path }
func info(_ pid: Int32) -> proc_bsdinfo? {
    var value = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &value, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size,
          value.pbi_uid == getuid() else { return nil }
    return value
}
func identity(_ pid: Int32) -> Identity? {
    guard let value = info(pid) else { return nil }
    return Identity(pid: pid, seconds: value.pbi_start_tvsec, microseconds: value.pbi_start_tvusec)
}
func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 || errno == EPERM }
func executable(_ pid: Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    return String(cString: buffer)
}
func arguments(_ pid: Int32) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, UInt32(mib.count), nil, &size, nil, 0) == 0, size > 4, size <= 1024 * 1024 else { return nil }
    var bytes = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, UInt32(mib.count), &bytes, &size, nil, 0) == 0 else { return nil }
    let count = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    guard count > 0, count < 4096 else { return nil }
    var offset = MemoryLayout<Int32>.size
    while offset < size && bytes[offset] != 0 { offset += 1 } // executable path
    while offset < size && bytes[offset] == 0 { offset += 1 }
    var result: [String] = []
    for _ in 0..<count {
        let start = offset
        while offset < size && bytes[offset] != 0 { offset += 1 }
        guard offset < size, let value = String(bytes: bytes[start..<offset], encoding: .utf8) else { return nil }
        result.append(value)
        offset += 1
    }
    return result
}
func profileArgument(_ args: [String], _ profile: String) -> Bool {
    let values = args.filter { $0.hasPrefix("--user-data-dir=") }
    return values.count == 1 && canonical(String(values[0].dropFirst("--user-data-dir=".count))) == profile
}
func browser(_ profile: String, port: Int? = nil) throws -> Browser? {
    let lock = profile + "/SingletonLock"
    var file = stat()
    if lstat(lock, &file) != 0 {
        if errno == ENOENT { return nil }
        throw Failure.busy
    }
    guard file.st_mode & S_IFMT == S_IFLNK, file.st_uid == getuid() else { throw Failure.busy }
    var hostname = [CChar](repeating: 0, count: 256)
    guard gethostname(&hostname, hostname.count) == 0 else { throw Failure.unavailable }
    let prefix = String(cString: hostname) + "-"
    let target = try fm.destinationOfSymbolicLink(atPath: lock)
    guard target.hasPrefix(prefix), let pid = Int32(target.dropFirst(prefix.count)), pid > 1 else { throw Failure.busy }
    if !alive(pid) { return nil } // Chrome removes its own stale singleton files.
    guard let data = info(pid), let id = identity(pid), let path = executable(pid), canonical(path) == canonical(chrome),
          let args = arguments(pid), profileArgument(args, profile),
          !args.contains(where: { $0 == "--type" || $0.hasPrefix("--type=") }),
          args.filter({ $0.hasPrefix("--remote-debugging-address=") }) == ["--remote-debugging-address=127.0.0.1"] else { throw Failure.busy }
    let ports = args.filter { $0.hasPrefix("--remote-debugging-port=") }
    guard ports.count == 1, let actualPort = Int(ports[0].dropFirst("--remote-debugging-port=".count)),
          (1...65535).contains(actualPort), port == nil || port == actualPort else { throw Failure.busy }
    return Browser(identity: id, parent: Int32(data.pbi_ppid), port: actualPort)
}
func stop(_ found: Browser, profile: String) throws {
    guard let current = try browser(profile, port: found.port), current.identity == found.identity else { throw Failure.busy }
    guard kill(found.identity.pid, SIGTERM) == 0 || errno == ESRCH else { throw Failure.busy }
    let deadline = Date().addingTimeInterval(5)
    while identity(found.identity.pid) == found.identity {
        if Date() >= deadline { throw Failure.timeout }
        Thread.sleep(forTimeInterval: 0.05)
    }
}
func hasLiveLegacyOwner(profile: String, caller: Int32) -> Bool {
    #if CHROME_RECOVERY_TESTING
    let checkApplications = profile.hasPrefix(canonical(fm.homeDirectoryForCurrentUser.path) + "/Library/Application Support/Odoo Lifecycle Manager/")
    #else
    let checkApplications = true
    #endif
    if checkApplications && NSRunningApplication.runningApplications(withBundleIdentifier: "local.odoo.lifecycle-manager").contains(where: { $0.processIdentifier != caller && !$0.isTerminated }) { return true }
    // Launch Services can parent background Chrome to launchd while its helper
    // still belongs to a live app. Such a browser is not abandoned.
    let count = proc_listallpids(nil, 0)
    guard count > 0 else { return true }
    var pids = [Int32](repeating: 0, count: Int(count) + 128)
    let actual = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<Int32>.size))
    guard actual > 0, actual < pids.count else { return true }
    for pid in pids.prefix(Int(actual)) where pid > 1 {
        if let path = executable(pid), URL(fileURLWithPath: path).lastPathComponent == "chrome-background" {
            guard let args = arguments(pid) else { return true }
            if profileArgument(args, profile) { return true }
        }
    }
    return false
}
func readLease(_ path: String) throws -> Lease? {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if fd < 0 {
        if errno == ENOENT { return nil }
        throw Failure.busy
    }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var value = stat()
    guard fstat(fd, &value) == 0, value.st_mode & S_IFMT == S_IFREG, value.st_uid == getuid(), value.st_size > 0, value.st_size <= 4096,
          let data = try handle.readToEnd(), let lease = try? JSONDecoder().decode(Lease.self, from: data),
          lease.version == 1, lease.owner.pid > 1, lease.owner.seconds > 0, UUID(uuidString: lease.token) != nil,
          (1...65535).contains(lease.port) else { throw Failure.busy }
    return lease
}
func writeLease(_ path: String, _ value: Lease) throws {
    let temporary = path + "." + UUID().uuidString
    let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw Failure.unavailable }
    defer { unlink(temporary) }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    try handle.write(contentsOf: JSONEncoder().encode(value))
    try handle.synchronize()
    guard rename(temporary, path) == 0 else { throw Failure.unavailable }
}
func run() throws -> [String: Any] {
    guard CommandLine.arguments.count == 5,
          ["acquire", "release"].contains(CommandLine.arguments[1]),
          let token = UUID(uuidString: CommandLine.arguments[3])?.uuidString,
          let port = Int(CommandLine.arguments[4]), (1...65535).contains(port),
          let owner = identity(getppid()), owner.pid > 1 else { throw Failure.unavailable }
    let action = CommandLine.arguments[1], supplied = CommandLine.arguments[2]
    let profile = canonical(supplied)
    let home = canonical(fm.homeDirectoryForCurrentUser.path)
    let allowed = ["chrome-profile", "chrome-profile-webmail"].map { home + "/Library/Application Support/Odoo Lifecycle Manager/" + $0 }
    #if CHROME_RECOVERY_TESTING
    let temporary = canonical(NSTemporaryDirectory()) + "/"
    let testProfile = (profile.hasPrefix(temporary) || profile.hasPrefix("/private/tmp/")) && ["chrome-profile", "chrome-profile-webmail"].contains(URL(fileURLWithPath: profile).lastPathComponent)
    guard allowed.contains(profile) || testProfile else { throw Failure.unavailable }
    #else
    guard allowed.contains(profile) else { throw Failure.unavailable }
    #endif
    var directory = stat()
    guard lstat(supplied, &directory) == 0, directory.st_mode & S_IFMT == S_IFDIR, directory.st_uid == getuid() else { throw Failure.unavailable }
    let lock = open(profile + "/.lifecycle-recovery.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard lock >= 0 else { throw Failure.busy }
    defer { close(lock) }
    var lockInfo = stat()
    guard fstat(lock, &lockInfo) == 0, lockInfo.st_mode & S_IFMT == S_IFREG, lockInfo.st_uid == getuid(), flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw Failure.busy }
    defer { flock(lock, LOCK_UN) }
    let path = profile + "/.lifecycle-browser-owner.json"
    let previous = try readLease(path)
    if action == "release" {
        guard let lease = previous else { return ["status": "released"] }
        guard lease.owner == owner, lease.token == token, lease.port == port else { throw Failure.busy }
        if let found = try browser(profile, port: port) { try stop(found, profile: profile) }
        guard unlink(path) == 0 || errno == ENOENT else { throw Failure.unavailable }
        return ["status": "released"]
    }
    if let lease = previous {
        if identity(lease.owner.pid) == lease.owner || (identity(lease.owner.pid) == nil && alive(lease.owner.pid)) { throw Failure.busy }
    }
    var recovered = false
    if let found = try browser(profile, port: previous?.port) {
        guard found.parent == 1 else { throw Failure.busy }
        if previous == nil && hasLiveLegacyOwner(profile: profile, caller: owner.pid) { throw Failure.busy }
        try stop(found, profile: profile)
        recovered = true
    }
    try writeLease(path, Lease(version: 1, owner: owner, token: token, port: port))
    return ["status": "acquired", "recovered": recovered]
}
do {
    let output = try run()
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output))
} catch {
    let code = (error as? Failure ?? .unavailable).rawValue
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: ["error": code]))
    exit(1)
}
