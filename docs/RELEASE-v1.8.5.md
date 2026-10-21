# Odoo Lifecycle Manager v1.8.5

Automatically recovers abandoned app-owned Chrome processes before reconnecting to Odoo or Viamail. A browser left behind after an app crash can no longer silently hold the Viamail profile and prevent its login window from staying open.

The app checks the previous owner's process start time, the Chrome executable, the exact dedicated profile and local debugging port. It closes only a verified orphan, preserves saved sessions and retries the normal connection startup. An active owner or uncertain identity stops recovery with a connection error. Personal Chrome profiles are never cleanup targets, and Chrome is never force-killed.

Startup failures also release their own Chrome process even if the launcher exited before the connection became ready. The native recovery helper ships for both Apple Silicon and Intel Macs.

Validation uses isolated, empty Chrome profiles to reproduce app-owner crashes and test automatic reconnection, active-owner protection, process-ID reuse, unrelated profiles, mismatched ports and invalid ownership records. No Odoo database changes are required to test recovery.

Local validation on macOS: all 294 unit tests and 51 desktop tests passed. The universal package passed architecture checks and real ZIP extraction/cleanup in both Node and Electron. The installed app was updated from 1.8.4 to 1.8.5 while idle; both Odoo and Viamail restored their saved connections without another login. Automatic monitoring and lifecycle rules were confirmed off before the restart. No database actions were run.

This release remains unsigned. Version 1.8.4 supports installing this update through Settings → App updates after publication. Versions 1.8.0–1.8.3 require a one-time manual installation using the universal DMG or ZIP.
