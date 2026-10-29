# Odoo Lifecycle Manager v1.8.9

Moves workspace switching to the top-left sidebar, above the Lifecycle logo. A single Sample / Odoo switch is available from every screen, shows the current mode, and is disabled while an operation is running. Settings explains the switch instead of duplicating it. The sidebar stays usable at the minimum window size.

Switching keeps the existing behavior: reuse valid saved sign-in, pause automatic rules, preserve Viamail and action history, and ask for reconnection if the saved Odoo session has expired. No lifecycle is started by this interface change.

Repairs two build-only fs-extra lockfile entries that referenced an unavailable archive, using the compatible 11.3.1 version already present in the lockfile and local package cache. Runtime dependencies are unchanged.

Validation: the build, 14 desktop tests and 6 connection/workspace unit tests passed. UI checks cover placement above the logo, availability on every workspace screen, busy-state disabling, saved selection across restart, and minimum-window layout.

The unsigned universal v1.8.9 app was installed locally and the switch was visually verified above the Lifecycle logo. The existing Odoo workspace, settings, live action history and queue were preserved. No real lifecycle was started.

**Unsigned universal Mac build:** supports Apple Silicon and Intel Macs running macOS 13 or later. Google Chrome is required. Download the DMG for manual installation into Applications, or update through Settings → App updates from v1.8.4 or later. The ZIP supports in-app updates; SHA256SUMS.txt contains checksums for both downloads. This build is not Apple-signed or notarized.
