# Little Log security audit — 2026-09-16

Reviewed commit: `5cf9c4b7dc3bae3733e885a9093be238e057dc4a`.
This is a source review with bounded, local reproductions against synthetic data.
No production endpoint, account, subscription or wallet was exercised. Application
code was not changed during the initial audit. The findings below describe that
original revision. Local remediation now covers findings 1-4 and the tracker/bot
trust boundary in finding 5; LiDollQuest gameplay integration now uses the separate authoritative arena service.
See [SECURITY_ROLLOUT.md](SECURITY_ROLLOUT.md) for rollout requirements and limits.
These changes have not been deployed by this work.

## Findings, in recommended repair order

### 1. High — Identity revocation does not revoke Little Log sessions

**Locations:** `auth/store.mjs:47`, `auth/store.mjs:80`,
`server/sessions.mjs:26`, `server/sessions.mjs:5`.

Resetting a password or disabling an account in LiD0llID deletes identity-service
OIDC records. Little Log independently accepts its existing session whenever its
local participant remains enabled. It never checks whether that identity was
disabled or its credentials changed. An attacker with a previously stolen app
cookie can therefore retain access to that account's records, Social and, for an
admin account, admin functions after the operator resets the password. Active use
can renew the cookie up to its original 180-day absolute expiry.

**Verified:** Created a disposable identity and tracker session, reset its password,
then disabled the identity. The original tracker session was accepted after both
operations. This is an existing, documented architectural limitation in
`AUTH_GUIDE.md:127`, rather than a regression in the recent Social gate.

**Fix:** Propagate authenticated revocation events or check an identity revocation
version with a short, bounded cache. Apply the policy to app and wallet sessions;
define separately whether administrator integration credentials should survive a
password reset. Until implemented, incident response must also revoke Little Log
sessions or disable Little Log access. Revoke affected integration/wallet tokens
explicitly where needed. Preserve normal device persistence between revocations.

This follows the session-invalidation guidance in the
[OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

### 2. Medium, potentially high if reachable publicly — Malformed request targets crash both services

**Locations:** `scripts/serve.mjs:67`, `scripts/auth-server.mjs:48`.

Both async HTTP handlers construct a URL before entering an error boundary. An
invalid URL throws, leaving a rejected handler promise unhandled and terminating
Node under its default rejection policy. Authentication is not reached.

**Verified:** One raw `GET //[ HTTP/1.1` request to each disposable loopback service
caused exit code 1 with `ERR_INVALID_URL`. Both the tracker and identity service
were affected. Only these child processes were stopped by the reproduction.

**Exposure limit:** This proves the Node service defect, not an exploit through
the deployed proxy. Nginx may reject, normalize or route this request elsewhere;
the live behavior and firewall were not inspected. A systemd restart does not
prevent repeated availability loss if an attacker can reach the handler.

**Fix:** Reject malformed request targets with HTTP 400 inside a top-level request
error boundary. Catch asynchronous handler failures and keep the service alive.
Add a subprocess regression that sends the malformed request and then confirms
an ordinary request still succeeds. Continue restricting backend ports to the
proxy. The throwing behavior is documented by
[Node's URL API](https://nodejs.org/docs/latest-v24.x/api/url.html#new-urlinput-base).

### 3. Medium — Upload limits run after expensive image processing

**Locations:** `server/social.mjs:59`, `server/social.mjs:88`,
`server/social.mjs:91`, `server/social.mjs:92`; `deploy/nginx-proxy.conf`.

Status pictures are decoded, rotated, resized and JPEG-encoded before the
10-post/minute or 100 MB storage checks. Profile replacements have version checks
but no rate or concurrent-processing limit. Sequential pictures within one request
do not bound concurrent requests. A registered member can repeatedly consume
image-processing resources even when their post allowance is exhausted or their
profile version will lose a race. The checked-in proxy snippets bound body size
but do not set request or connection rate limits.

**Verified:** After exhausting the post allowance, a normal post returned 429 but
a new picture post reached picture validation and returned 400. Source inspection
confirms valid images reach Sharp before the 429 check. No load test or deliberate
memory exhaustion was performed, so outage thresholds are not established.

**Fix:** Reserve bounded per-account and global processing slots before reading
large request bodies or invoking Sharp. Rate-limit profile updates too. Reject or
queue excess work with bounded queue length, and retain transaction-time checks
for races. Keep existing format, pixel, byte and metadata protections. These are
complementary to the controls described in the
[OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html).

### 4. Medium — Automatic record posts bypass Social throttling and amplify notifications

**Locations:** `server/social.mjs:74`, `server/social.mjs:79`,
`server/social.mjs:81`, `server/database.mjs:198`, `server/activity.mjs:34`.

Opted-in record synchronization inserts posts directly, bypassing the normal post
rate limiter. Every new eligible record also creates a friend-post alert for each
accepted friend. Sync accepts up to 100 changes per request, so one account can
rapidly fill the public feed and friends' notification histories. Configured push
subscribers also get delivery rows. The 50,000-record lifetime cap does not provide
a useful short-window abuse limit. Activity pruning scans all unwithdrawn history
on each list read, increasing the impact of a growing history.

**Verified:** A single batch of 12 records created 12 public posts and 12 stored
notifications for one synthetic friend. An ordinary post immediately afterward
returned 429. No pushes were sent.

**Fix:** Give automatic posts and notifications a shared, bounded publication
budget. Preserve legitimate offline sync by saving records independently and
coalescing, deferring or suppressing excess Social announcements. Bound delivery
queries and notification retention/work per request. Test both bulk offline
imports and deliberately repeated new record IDs.

### 5. Medium — Shared currency trusts self-reported rewards and public-client credits

**Locations:** `server/performance-bonus.mjs:5`, `server/database.mjs:199`,
`server/coin-api-store.mjs:6`, `server/coin-api-store.mjs:47`,
`server/coin-api-store.mjs:62`, `server/coin-api-store.mjs:126`.

A new diaper-change record can claim 10,000 wettings and earn 50,005 coins. Fresh
IDs generate fresh entitlements; the once-daily login bonus restriction does not
limit these record rewards. Separately, public device authorization lets a member
request a configured client's write scopes, approve their own wallet, and submit
an arbitrary credit up to that client's daily cap. There is no proof that the
configured game or bot produced the earning event. The built-in LiDollQuest
configuration permits 1,000,000 coins/day and an inherited 20,000 diamonds/day.

**Verified:** One accepted synthetic change increased its wallet by 50,005 coins.
A self-approved `lidollquest` device grant credited 100 diamonds without any game
event or server credential. This affects the caller's wallet; no cross-account
debit or private-record access was demonstrated. It is a trust-model weakness,
especially because earnings enter the shared market, rather than an ownership
check bypass. Whether deliberately self-awarded game currency is acceptable is a
product decision.

**Fix:** Separate permission to spend one's balance from authority to mint rewards.
Have trusted game/bot servers issue bounded, idempotent reward events; never embed
a shared minting secret in a distributed client. Cap record-derived payouts using
server-time budgets and sensible per-record limits while preserving the original
tracking data. Review live client caps before rollout; they were not available in
this audit.

## Surfaces reviewed and existing protections

- Authentication: OIDC state/nonce/PKCE, callback destination allowlists, password
  hashing and login/registration throttles, cookie flags and local role checks.
- APIs: owner-scoped sync, friend sharing, public/private posts and images, messages,
  moderation, report/statistics bearer scopes, wallet/browser grants and CSRF/CORS.
- Rendering: sampled HTML interpolation and DOM sinks, CSP, social text rendering,
  profile images and gallery access. No obvious stored-script or SQL-injection path
  was established in the inspected code.
- Files/network: static asset allowlist, private API cache headers, service-worker
  allowlist, image re-encoding, push-service hostname restrictions, fixed game
  redirects and configured AI/bridge destinations with redirect rejection.
- Operations: supplied Nginx configs, service isolation and filesystem permissions.
  Production service units use unprivileged accounts, private writable directories,
  `UMask=0077`, `NoNewPrivileges`, `PrivateTmp` and filesystem protection.

Live role/ownership checks and separately scoped integration credentials are strong
existing defenses. Their presence does not resolve the findings above.

## Validation and limits

- `npm test`: **268 passed, 0 failed**. Existing tests passing did not detect the
  issues reproduced here.
- `npm audit --omit=dev --json`: **0 reported vulnerabilities**, retrieved during
  this audit. This covers registry advisories for the dependency tree, not the
  deployed Node binary, nginx, OS, local model server or all native-library risks.
- Bounded reproduction script: `artifacts/security-audit-repro.mjs`.
  Run from the repository root with Node 24 or later. It creates only disposable
  databases and loopback child services; it records the original vulnerable behavior
  and will need updating after fixes.
- Recorded results: `artifacts/security-audit-anWDnN/results.json`.
  Dependency and regression outputs: `artifacts/security-npm-audit.json` and
  `artifacts/security-audit-tests.log`. These are local ignored artifacts.
- Not assessed: live TLS/firewall/proxy behavior, deployed software versions,
  backup access, actual secrets and token grants, full MommyBot/LiDollQuest code,
  Discord permissions, hardware clients, or production load capacity. The repository
  review is not a claim that the live deployment has no other vulnerabilities.

Prioritize centralized revocation and the request crash fix, then upload admission
limits and automatic-post throttling. Resolve the reward trust model before relying
on balances as resistant to deliberate manipulation.

## Remediation verification

Local follow-up: 279 tracker tests pass, including signed identity revocation, malformed HTTP against both real services, upload admission, bounded auto-post fanout/activity retention, daily reward budgets and key provisioning. The actual MommyBot WalletClient passes credit/retry/debit/refund integration against a disposable tracker API; 66 focused bot tests pass. Browser sign-in, social and registration-gate checks passed against local services. Deployment remains outstanding. LiDollQuest now uses its own service for verified hub arenas, with the tracker acting only as its authenticated gateway and wallet.
