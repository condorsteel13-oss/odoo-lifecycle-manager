# Validation and release boundaries

The automated suite uses synthetic accounts, temporary app-data directories, and loopback-only servers. No real Odoo mutations are needed for the suite.

## Covered behavior

- Discovery reads the visible database list and Manage expiry while keeping remote application scripts inert.
- Safe mode defaults on, with separate creation and deletion reviews and native confirmations. Automatic rules default off. Old local state migrates to these defaults.
- Automatic execution requires an explicit mode opt-out and an explicit run or enabled rule. Identity, family, neutralization, activation, positive expiry and permission checks remain enforced. Backup and business-data integrity are not automatically proven.
- Rules accept fresh exact expiry or Manage countdowns, support all or selected databases, and move selected scope to a verified replacement after successful parent deletion.
- Accounting database names are excluded before individual access or lifecycle execution. Fixtures use synthetic names only.
- Durable intents and UUID-bound queue entries prevent blind mutation retries. Interrupted jobs need explicit continuation; uncertain deletion remains locked. Stop prevents subsequent actions but cannot undo an in-flight request.
- Inherited expiry does not immediately trigger repeated copy/delete cycles. No extension or indefinite renewal is promised.
- Session vaults are encrypted using macOS secure storage. Reports, release assets and Git history exclude cookies, tokens, private account metadata and local screenshots.
- Guard tests reject arbitrary methods, redirects, RPC, untrusted pages, and WebSockets. Activation messages are scoped to the exact copy and current Odoo user.

## Public release packaging

The universal app and Chrome helper contain arm64 and x86_64 slices and require macOS 13+. The public release includes a DMG, ZIP and SHA-256 checksums. The application is not Developer ID signed or notarized. The release page describes first-launch limitations and links to Apple's guidance.

Native desktop and browser tests run on Apple Silicon. Intel compatibility is checked through universal binary architecture inspection; native Intel execution has not been tested on separate Intel hardware. No customer sessions or data are shipped. See the release notes for the exact validation counts.
