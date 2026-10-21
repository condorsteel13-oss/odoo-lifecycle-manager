# Odoo Lifecycle Manager v1.8.3

This patch fixes a Chrome startup race in manual sign-in. When macOS exits the Chrome launcher before the app's private DevTools endpoint is ready, sign-in now waits through the full startup window. Cleanup closes a handed-off Chrome process only after the endpoint has been confirmed ready, preventing Viamail's login window from being closed during startup.

Validation: TypeScript typecheck, unit tests, production build, and universal macOS installer integrity checks. No Odoo databases are accessed or changed during release preparation.
