# Odoo Lifecycle Manager v1.5.2

Fixes incomplete email activation after duplication. Earlier versions stopped after the account-site activation link and skipped Odoo’s database activation redirect, which could leave a copy with a short expiry. The app now completes the validated redirect chain, then independently verifies the copy’s activation status and Manage-page expiry.

## Download

- **Odoo-Lifecycle-Manager-1.5.2-universal.dmg** — recommended installer for Apple Silicon and Intel Macs.
- **Odoo-Lifecycle-Manager-1.5.2-universal.zip** — the same application as a ZIP archive.
- **SHA256SUMS.txt** — checksums for both downloads.

Requires **macOS 13 Ventura or later** and **Google Chrome in /Applications**. Node.js is not needed. Open the DMG and drag the app to Applications. To upgrade, quit Lifecycle Manager first and replace the existing app; saved connections and local history remain in Application Support.

**This build is not Developer ID signed or notarized.** macOS may block its first launch. If you choose to trust it, follow [Apple’s app-specific Open Anyway instructions](https://support.apple.com/102445). Do not disable Gatekeeper globally.

## Changes

- Completes only the activation redirects bound to the tracked copy’s origin, UUID and current user. Completion HTML stays inert; no invitations are sent.
- Saves pending activation handoffs in macOS-encrypted checkpoints. **Complete activation** can resume an unsubmitted step or reread the completion page without replaying uncertain activation requests.
- Requires fresh activated status and positive, consistent Manage expiry before a copy can pass verification. An incomplete activation handoff blocks parent deletion.
- Adds **Keep both databases — close cycle** for verified copy-only runs. This closes the local record and prevents that record from continuing into deletion.
- Adds sanitized action diagnostics and regression coverage for redirect validation, restart recovery and confirmation controls.

A separately authorized live test of this fix produced an activated copy with **14 days remaining**, compared with 2 days in the earlier incomplete flow. Odoo determines expiry; this result does not guarantee an extension for every database. Existing copies are not reactivated automatically.

Safe mode remains on by default, with separate duplication and deletion confirmations. Automatic lifecycle rules remain off on fresh installations. Accounting exclusions remain enforced. Activation email reading currently supports **Viamail at mail.viamtl.com**.

## Validation

Release preparation uses synthetic accounts, temporary profiles and local fixture servers. It does not run a live database lifecycle. The installer includes no customer accounts, credentials, sessions, private screenshots or database metadata.

The release passes TypeScript checks, 218 unit tests, all 46 isolated desktop/browser integration tests and a production build. Universal architecture inspection checks both arm64 and x86_64 for the app and Chrome helper. Native desktop tests run on Apple Silicon; execution on separate Intel hardware has not been tested.
