# Odoo Lifecycle Manager v1.5.1

A local Mac app for Odoo Online discovery, Manage-page expiry checks, simulations, and controlled duplicate → activate → verify → delete workflows.

## Download

- **Odoo-Lifecycle-Manager-1.5.1-universal.dmg** — recommended installer for Apple Silicon and Intel Macs.
- **Odoo-Lifecycle-Manager-1.5.1-universal.zip** — the same application as a ZIP archive.
- **SHA256SUMS.txt** — checksums for both downloads.

Requires **macOS 13 Ventura or later** and **Google Chrome in /Applications**. Node.js is not needed. Open the DMG, drag the app to Applications, then launch it and sign into your own accounts.

**This build is not Developer ID signed or notarized.** macOS may block its first launch. If you choose to trust it, follow [Apple's app-specific Open Anyway instructions](https://support.apple.com/102445). Do not disable Gatekeeper globally. An Apple-verified first launch requires a future Developer ID-signed and notarized release.

## Included

- Saved Odoo and Viamail connections, encrypted locally using macOS secure storage.
- Visible Chrome sign-in and optional Background mode with no Chrome windows afterward.
- Read-only database discovery, Manage expiry dates/countdowns, and simulations.
- Safe mode **on by default**, with separate duplication and deletion confirmations.
- Optional automatic lifecycle rules for all or selected databases at an expiry threshold.
- Copy activation and verification before parent deletion, durable action logs, Stop controls, and no blind mutation retries.
- Accounting database exclusions without embedding customer names in the source.

## Scope and limits

- Automatic email activation currently supports **Viamail at mail.viamtl.com**. Other mailbox providers are not integrated.
- Copies are neutralized testing databases, not production replacements. Parent deletion is permanent and may close a related subscription. Keep recoverable backups; the app cannot prove business-data completeness.
- A copy may inherit its parent's expiry. No expiry extension or perpetual renewal is promised; inherited expiry does not trigger repeated automatic cycles.
- Rules run while the app is open. Odoo permissions, quota, interface changes and authentication challenges can block a run.
- New installations start with Safe mode on and automatic rules off. No customer account data, credentials, cookies, session vaults or private screenshots are included.

## Validation

198 unit tests and 45 isolated desktop/browser integration tests. Universal architecture inspection checks both arm64 and x86_64 for the app and Chrome helper. Native desktop tests run on Apple Silicon; execution on separate Intel hardware has not been tested. This release preparation does not run a live database lifecycle.
