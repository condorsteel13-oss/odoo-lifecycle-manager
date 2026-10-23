# Odoo Lifecycle Manager v1.8.7

Automation is easier to configure, and Background mode handles suspended or slow Chrome readers more reliably.

## Changes

- One Automation mode selector: **Off**, **Monitor only**, or **Run lifecycle**. Off disables both scheduled monitoring and scheduled live rules.
- A clear saved status shows the next check, whether originals will be deleted, and whether Safe mode requires confirmations. Unsaved edits stay separate from the active rule.
- The deletion choice remains shared with Live actions. Longer explanations are under **How it works**, and the workspace guide uses the new labels.
- Hidden app-owned Chrome disables background throttling and reactivates reader pages before Odoo and Viamail requests.
- App-side deadlines prevent stalled browser requests from waiting indefinitely. Closed Viamail readers can reconnect using their saved session.
- Duplication now allows 120 seconds for its response, within a 135-second overall request deadline. Submitted mutations are never automatically retried after an uncertain outcome.

Existing account sessions and saved rules are preserved. Keep the app open and the Mac awake for scheduled checks. Turning automation off does not stop an active lifecycle or remove queued jobs.

## Download and update

**Unsigned universal Mac build** for Apple Silicon and Intel, macOS 13 or later. Installed Google Chrome is required.

- Download the **DMG** for manual installation into Applications.
- The **ZIP** is used by the in-app updater. Versions 1.8.4 and later can install this release through Settings → App updates when operations are idle. Versions 1.8.0–1.8.3 need a one-time manual upgrade.
- This build is not Apple-signed or notarized, so macOS may require approval to open it.
- `SHA256SUMS.txt` contains the installer checksums.

## Validation

305 unit tests and 60 desktop/browser integration tests passed. Coverage includes the four legacy scheduling flag combinations, unsaved edits, restart persistence, suspended hidden readers, and a loopback-only delayed duplication/activation/deletion flow. The installed app's saved Odoo and Viamail connections also passed Background-mode checks. No new real lifecycle was run for this release verification.
