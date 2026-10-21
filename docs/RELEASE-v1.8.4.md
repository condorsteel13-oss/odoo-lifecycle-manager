# Odoo Lifecycle Manager v1.8.4

Fixes **Restart to install** failing after an update has downloaded successfully. Electron treated the replacement app's `app.asar` as a virtual archive during extraction and cleanup. The updater now uses Electron's native filesystem for these operations, while keeping normal ASAR support enabled for the running app.

Local installation errors identify the step that failed. The sidebar now shows the built version rather than a fixed 1.8.0 label. Lifecycle activity and pending confirmations continue to block installation; updates only restart after the user chooses **Restart to install**.

**One-time upgrade for 1.8.0–1.8.3:** install 1.8.4 using the universal DMG or ZIP. The older installed updater cannot extract its own repair. Subsequent releases can be installed from Settings → App updates.

Validation includes the real release ZIP inside Electron, an Electron regression test for extraction and cleanup, and the lifecycle/update coordination and native installer tests. Release preparation does not change any Odoo databases.
