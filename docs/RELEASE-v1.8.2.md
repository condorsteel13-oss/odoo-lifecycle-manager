# Odoo Lifecycle Manager v1.8.2

This patch fixes manual Chrome sign-in being cancelled when macOS hands Chrome's launch off to a separate browser process. Odoo and Viamail sign-in now use the app-owned, loopback-only Chrome DevTools endpoint to determine whether the login session remains available.

Validation: TypeScript typecheck, 284 unit tests, production build, and installer integrity checks. No Odoo databases are accessed or changed during release preparation.
