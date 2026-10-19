# Odoo Online research — 19 October 2026

## Sources and observations

- Current official 19.0 documentation source: https://github.com/odoo/documentation/blob/19.0/content/administration/odoo_online.rst (read on 2026-10-19; the rendered documentation endpoint timed out).
- Earlier official 16.0 documentation: https://www.odoo.com/documentation/16.0/administration/odoo_online.html
- Official TOTP controller: https://github.com/odoo/odoo/blob/19.0/addons/auth_totp/controllers/home.py
- Public, unauthenticated GET of https://www.odoo.com/my/databases: redirects to the official login form. The form posts to `/web/login`, uses CSRF, and accepts a redirect. Current scripts load from `odoocdn.com/web/assets/`. Its frontend includes reCAPTCHA and Cloudflare Turnstile integrations. No account credentials were used during research.

## Findings and unresolved questions

| Question | Evidence / V1 decision |
|---|---|
| How are databases listed? | The official manager is `/my/databases`, accessed as an administrator. The docs describe selecting a database and its Manage control. V1 reads server-rendered list markup and follows only observed, unfiltered list pagination links. |
| Where is expiration shown? | The public documentation does not specify an authenticated expiration field or guarantee its presence. V1.1 reads explicit list fields and the authenticated database session-information expiration field. Missing, ambiguous, relative-only, or conflicting dates remain Unknown. |
| Trial vs. duplicate expiry? | Current documentation specifies a 15-day lifetime for duplicates. It does not establish a universal trial expiry in this page. Never calculate expiry by adding 15 days to creation. |
| Can a duplicate be duplicated? | Not established by the reviewed official documentation. Report Requires verification. |
| Duplicate limits? | Current documentation specifies five duplicates per source, with support able to extend the limit. Never infer the remaining quota from visible database counts. |
| Does deleting the original extend a copy's expiry or free quota? | No supporting evidence in the reviewed official sources. Never promise either effect. |
| Can an expiring trial be duplicated? | Not established. Visible availability is evidence of a control, not a guarantee of backend eligibility. |
| Can subscriptions/states prevent deletion? | Earlier 16.0 docs prohibit deletion for expired or subscription-linked databases. Current 19.0 docs describe deletion closing the subscription. This changed: report account-specific verification, not the old restriction as universal fact. |
| Can Playwright automate the operations? | The UI exposes the actions, but automation reliability and permission rules have not been tested on this account. V1 contains no implementation or tests that invoke live mutations. |
| Is indefinite renewal supported? | Not established. A supported read-only monitoring tool is feasible; a copy/delete renewal loop is unproven and must not be represented as a supported Odoo workflow. |

## Current reader (V1.1)

The public manager asset uses `/odoo-enterprise/databases` with `{share: false}` for the account's visible list. V1.1 requests exactly that method after manual sign-in, validates identities/origins, and discards authentication URLs and unrelated fields. The app discovered seven real databases on 2026-10-19; the account list itself did not expose expiration dates.

The user demonstrated **database settings → Manage**. Its visible expiry banner for one trial database showed 31 days. The page embeds `https://www.odoo.com/my/database` in an iframe. No Duplicate, Delete, Rename or subscription controls were invoked.

The public database web-client asset reviewed during development, `MyDatabase._get_info()`, obtains the iframe token from `POST /saas_worker/db/info/json` with body `{}`. The token is transient, used only for that fixed information-page GET, and never stored or reported. The reader never loads the database application itself.

The information page is client-rendered too. Its `openerp_enterprise.MyDatabaseInfo` component supplies JSON props. The [official Manage frontend asset](https://odoocdn.com/web/assets/1/f7d9854/openerp_enterprise.my_database.min.js) defines the precise display conditions:

- A Trial plan renders `subinfo.expireIn` as the trial's days remaining, including zero/negative counts.
- A subscription outside Edu/OneAppFree renders a days-valid badge only when `days_valid > 0 && days_valid < 30`.
- A subscription with `until_str` renders it as an explicit expiration date.
- `next_invoice_date` and `start_date` participate in billing controls; they are not expiration sources.

The reader checks the component's database name, UUID and canonical origin against the account list. It reads only the displayed expiry fields and discards tokens, prices, contacts and all other props. No component scripts execute. Days-only observations retain their read time; no exact date is calculated from the counter. Unknown or conflicting values stay unknown.

The actual Manage handoff is `GET /my/databases/connect/<uuid>?manage_db=true`, which returns an auto-submit form. The app parses it inertly and accepts only a POST to that listed database's `/saas_trial/trial-connect`, with exactly `db_uuid`, `token`, and `redirect`. The observed redirect is the same database's `/odoo/my-subscription`. Native fetch uses manual redirect handling, so that application navigation is never sent. The authenticated identity is then checked via `/web/session/get_session_info` before reading Manage metadata. The [official session controller](https://github.com/odoo/odoo/blob/19.0/addons/web/controllers/session.py) marks this endpoint `auth='user', readonly=True`.

An alternate OEA redirect is limited to the [official existing-user controller](https://github.com/odoo/odoo/blob/19.0/addons/auth_oauth/controllers/main.py), which sets `no_user_creation: True`. It is covered by offline tests; the observed live Manage flow uses the form above. General OAuth signup, arbitrary redirects and management actions are unsupported.

Installed Chrome handles the initial manual login with no automation attachment until the user clicks Read databases. Its dedicated profile follows [Chrome remote-debugging guidance](https://developer.chrome.com/blog/remote-debugging-port). The previous automated-browser Cloudflare failure was not bypassed. The prior HTML guard remains for regression tests and is not the production transport. No API key is created or requested.

## Platform references

- Playwright routing and service-worker caveats: https://playwright.dev/docs/api/class-browsercontext#browser-context-route
- Playwright WebSocket routing: https://playwright.dev/docs/api/class-browsercontext#browser-context-route-web-socket
- Electron security guidance: https://www.electronjs.org/docs/latest/tutorial/security

## Public login compatibility review

The visible Chromium smoke check additionally observed public GETs for `/saas_worker/const.json` and `/website/translations` with `hash` and `lang`. Direct unauthenticated inspection returned website constants and translation dictionaries respectively. These exact, parameter-validated reads are permitted only during authentication. The official translation implementation is documented in source at https://github.com/odoo/odoo/blob/19.0/addons/web/controllers/webclient.py (the live website uses the observed `/website/translations` route). Arbitrary RPC, bootstrap methods, and account methods remain blocked. Country-flag images are static assets with bounded image/cache parameters. Google Fonts and favicon requests are omitted locally.

Redirect tests exposed that native request continuation could allow redirect hops outside the normal routing callback. V1 consequently fetches every approved request with redirect following disabled and converts approved document redirects into fresh navigations. This includes authentication redirects; tests verify session-cookie continuity. Authenticated manager HTML never executes.

The public frontend also uses the source-reviewed `/web/webclient/bootstrap_translations` and `/web/webclient/version_info` POST handlers. Their official implementations read local translation files or server version metadata: https://github.com/odoo/odoo/blob/19.0/addons/web/controllers/webclient.py. Only the exact JSON-RPC call envelope with empty params is permitted during authentication. This is not a general JSON-RPC allowlist; all database-management RPC remains blocked.
## Live login compatibility — 19 October 2026

The official login script `openerp_enterprise` calls `POST /openerp_enterprise/exists` when the account field loses focus, with JSON-RPC parameters containing only `login`. Its Boolean result controls the account-exists validation message. Verified in the [official public frontend asset](https://odoocdn.com/web/assets/1/7c3ac32/web.assets_frontend_lazy.min.js). The policy permits this exact authentication check only from the official login page, with one bounded account identifier and no extra parameters. It remains blocked during discovery. No credential values are logged.

## Authenticated UI observations — 19 October 2026

These observations supersede the earlier unauthenticated assumptions about list markup. Regular Chrome's existing authenticated session displayed a client-rendered `.odoo-oe-databases-table` with `.oe_database_row` rows, including parent and child databases. Information menus show a version and Paid/Trial label, with no expiration field on the observed account. The public [manager JavaScript](https://odoocdn.com/web/assets/1/0336dda/openerp_enterprise.my_databases.min.js) implements `fetchDatabases()` using `/odoo-enterprise/databases` with a `share` parameter. It also contains unrelated mutation handlers; the full script must not execute in the guarded app. V1.1 implements this exact listing adapter with strict metadata projection. It does not execute the manager script.

The same source shows Manage navigating via `/my/databases/connect/<uuid>?manage_db=true` to the database's My Subscription view. Two such read-only UI visits returned blank subscription views and Odoo server errors. No expiry could be verified there. Database names, tags, parent/child relationships, and Trial labels do not establish expiration or permission to duplicate/delete.

Cloudflare verification failed in the Playwright-managed login. Its [supported-browser documentation](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/) lists automation frameworks as unsupported for production challenges. No stealth flags, forged tokens, test keys, CAPTCHA solvers, or copied browser credentials were used.


## V1.2 manual live adapters — 19 October 2026

User scope: implement manual duplicate and delete with separate confirmations; do not run them; exclude accounting. The user confirms that duplication extends expiry for this account. This is recorded as account-specific expected behavior; actual new-copy expiry must still be read.

The official public Manage asset at `https://odoocdn.com/web/assets/1/f7d9854/openerp_enterprise.my_database.min.js` supplies the request contracts:

- `DuplicateDialog.submit`: read-only `/odoo-enterprise/trial-check` with `dbname`; then database-origin `/saas_worker/dup/json` with `to`, `oauth_token`, `stay_on_portal`, `test`, `support`. Our adapter fixes the latter three to false, true, false respectively, matching the Manage-page testing flow. It never navigates to `success`.
- `DeletePage._drop_db`: account-origin `/my/databases/delete` with `token`, `access_token`, `is_paid` and optional `sub_id`; only after `result` succeeds, database-origin `/saas_worker/drop/json` with `oauth_token`, `db_name`, `db_uuid`. A first-step failure blocks the drop. A partial outcome is not retried.
- `MyDatabaseInfo` supplies the source identity, auth material, plan and neutralization flag; `upgrade_info.db` supplies administrator/upgrade state. All required values and canonical origins are checked in memory. Missing or changed contracts fail closed.
- `parent_uuid` from Odoo’s database list binds the new copy to the original. A same-name database alone is insufficient evidence.

These are observed frontend interfaces, not a guaranteed public mutation API. Live execution has intentionally **not** been tested on this account. Local fixtures exercise the exact adapters, failures and confirmations. The official 19.0 documentation warns that deletion also closes the related subscription and permanently removes data; the native deletion confirmation explicitly states both consequences. No subscription change, duplication or deletion was invoked for research or testing.


## Email activation, observed 19 October 2026

The official `saas_trial` client reads `/saas_worker/trial_info` with an empty JSON-RPC payload. The response exposes `status`, `user_email`, `activation_email`, `expiry_oe`, and `expiry`. Odoo’s Resend modal posts `/saas_worker/send_activation_email` with only `activation_email: user_email`. The app independently re-reads these fields before sending; a successful send is not proof of activation.

The real activation email uses `https://www.odoo.com/odoo-enterprise/confirm-database/<copy-name>/<opaque-token>` with exactly `username`, `email` and `country_id` query fields. Both email fields must match the current Odoo user. The app follows one validated link without following its response redirect, then independently reads activation and Manage expiry. The real copy changed from `to_activate` to `activated`; tokens and email bodies were not saved.

The supplied webmail host runs SmarterMail. Its public client uses `/api/v1/mail/messages` with an Inbox owner, exact-copy query and bounded pagination; `/api/v1/mail/message` reads one selected UID. The adapter verifies browser-held account claims, keeps the access token inside the browser, and guards both exact native-fetch requests. It does not call seen/flag/delete/receipt APIs. Login remains manual in the app-owned normal Chrome profile.

Live expiry reconciliation remains unresolved: activated trial expiry, session expiry and Manage countdown differ. The app displays the trial timestamp separately and does not substitute it silently for Manage’s countdown or unlock deletion.

## V1.4 persistent Viamail connection

The same public SmarterMail frontend bundle identifies `authStorage.getToken()`, `getRefreshToken()`, and `claimsService.getEmailAddress()`. `GET /api/v1/settings/user-mail` is a read-only settings request returning `userMailSettings`. Session refresh uses `POST /api/v1/auth/refresh-token` with `{token: refreshToken, iswebmailrefresh: true}` and the existing bearer token, returning new access/refresh tokens. Token identity must remain the same non-impersonated email. A rotated token is encrypted before another read. Authentication refresh is not a mailbox/business mutation.

Legacy profile migration projects only one unambiguous entry from this app-owned origin’s `localStorage.userTokens`, through an inert intercepted document. It does not load the webmail application, read messages or inspect another Chrome profile. Normal login handoff remains manual.


## V1.4.1 windowless normal Chrome

The Odoo account accepted its encrypted saved session in normal Chrome but returned HTTP 403 with `--headless=new`. The response alone does not establish the server’s rejection mechanism. Normal Chrome can run without a startup window and host hidden CDP reader targets; these targets have no native browser window and keep normal browser identity. This uses the app-owned profile and its existing encrypted session, with no user-agent overrides or CAPTCHA automation.

Primary sources: [Chromium no-startup-window switch](https://github.com/chromium/chromium/blob/main/chrome/common/chrome_switches.h), [Chrome DevTools hidden target contract](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Target.pdl). The pinned Playwright version exposes its built-in `PW_CHROMIUM_ATTACH_TO_OTHER` adapter for Chrome’s hidden `other` targets. Regression tests verify that these pages retain request routing, have no browser window, and are closed after each read. Compatibility failures preserve the encrypted login and stop without a visible fallback.


Chrome’s `Target.createTarget(hidden=true)` checks for an existing frame target, even when the debugging port is enabled. The empty saved profile therefore needs a bootstrap; merely retrying did not fix it. A bundled Swift helper uses macOS `NSWorkspace.OpenConfiguration` with `createsNewApplicationInstance=true`, `activates=false`, and `hides=true`. It waits until the owned Chrome instance reports hidden before permitting a blank background bootstrap, then the installed request guard creates a windowless anchor and closes the bootstrap. Only inert hidden targets remain. The helper terminates its own Chrome instance when the app closes; it does not control the personal Chrome process. See [Apple’s hidden launch setting](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/hides) and [Chromium’s hidden target prerequisite](https://chromium.googlesource.com/chromium/src/%2B/111ecbc657c45da1115a6bb97157721e11cbb82c/content/browser/devtools/protocol/target_handler.cc).


## V1.5 observed expiry correction — 19 October 2026

The user subsequently reported that the newly activated copy showed two days remaining and inherited its parent's expiry. This supersedes the earlier expectation that duplication would extend expiry. The app accepts an inherited positive, verified expiry; it does not predict extension or require a later date than the original. Manage and trial-service readings must still pass the existing consistency check. Automatic lifecycle scheduling deduplicates that expiry event so the resulting copy cannot immediately start another copy/delete cycle. No new remote interfaces were introduced for automatic execution; it uses the existing guarded adapters.
