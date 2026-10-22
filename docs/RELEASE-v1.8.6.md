# Odoo Lifecycle Manager v1.8.6

Accounting databases now participate in discovery, expiry reads, selection, simulations, monitoring and live actions. The previous accounting-name exclusion is removed; ordinary access and identity checks still apply.

Settings → Live actions and the Live actions screen now expose **Delete original database after successful activation**. This shares the existing Automation choice. With deletion on, Run lifecycle deletes the original only after the copy passes identity, activation and positive-expiry verification. With deletion off, it keeps both databases. Saving the choice starts no work and does not reset the automatic rule schedule.

Safe mode on asks before duplication, sending activation email, activating or resuming activation of the copy, and original deletion. Cancelling stops before that step's request and prevents subsequent steps. Read-only checks continue automatically. Safe mode off follows the deletion choice without per-step prompts.

Explicitly continuing an unfinished cycle uses the current deletion choice. Completed cycles remain closed. Turning deletion off invalidates an open deletion review and prevents manual or automatic deletion submission.

Validation uses mocked Odoo and mailbox fixtures, isolated Electron state and empty temporary Chrome profiles. No production database actions are needed.

All 301 unit tests and 52 desktop tests passed, including the four Safe mode/deletion combinations, cancellation before each activation mutation, accounting discovery and selection, preference persistence, and settings changes that do not start work.

The unsigned universal package passed architecture and real ZIP extraction/cleanup checks in Node and Electron. The local app was upgraded from 1.8.5 to 1.8.6 while idle with automatic rules off. Both saved connections restored, accounting selection is enabled, and Settings → Live actions shows the preserved deletion choice. No real database actions were run.
