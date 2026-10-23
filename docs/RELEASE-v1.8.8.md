# Odoo Lifecycle Manager v1.8.8

Adds live-action debugging tools and a workspace switch in Settings.

- **Live actions → Live action log → Hide log / Show log** collapses the log without removing records. Visibility is remembered on this Mac.
- **Export debug log** offers last hour, today, last 7 days, last month, last 3 months, last year, all time, and custom dates. Export stays available while the log is hidden.
- Custom dates include the entire start and end days in the Mac’s time zone. Matching runs include their full step history; session diagnostics are limited to the chosen period.
- JSON exports contain local debugging context, database names and identifiers, timestamps, expiry readings, and outcomes. They omit browser sessions, activation URLs, email addresses, mailbox contents, backup references and integrity notes. Exporting performs no Odoo requests and never changes or removes the source log.
- **Settings → Workspace → Use my Odoo workspace** switches between sample data and the real Odoo account using saved sign-in when valid. If reconnecting fails, sample data stays selected and Connection provides manual sign-in.
- Switching workspaces pauses automation and clears the old scope. Viamail, saved sign-in and live history are kept. Review and save an Automation rule explicitly to enable scheduled work again.

Existing Safe mode and deletion checks remain in place. No real lifecycle is required to use or test these controls.

**Unsigned universal Mac build:** supports Apple Silicon and Intel Macs running macOS 13 or later, with Google Chrome installed. Download the DMG for manual installation into Applications, or use Settings → App updates from v1.8.4 or later. Versions 1.8.0–1.8.3 need a one-time manual upgrade. The ZIP supports in-app updates; SHA256SUMS.txt contains checksums for both downloads. This build is not Apple-signed or notarized.

Validation: 312 unit tests and 62 desktop/browser integration tests passed, including native export, invalid/custom ranges, cancellation, redaction, log visibility across restart, and saved-session workspace switching. The unsigned universal app was installed locally and its controls verified. The existing real workspace, saved settings, live log and lifecycle queue were preserved; no real lifecycle was run for verification.
