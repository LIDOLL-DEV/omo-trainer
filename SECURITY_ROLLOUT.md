# Security update rollout

These changes require coordinated updates to **lidoll-auth**, **lidoll-tracker** and
MommyBot. They are local source changes until a release is deployed. Preserve
normal online SQLite backups of the identity, scientific, market and bot databases
before upgrading. No balance reset or account deletion is required.

## Reward signing configuration

MommyBot now signs credit and refund operations. The tracker verifies the proof
against a server-only key. Ordinary wallet grants still authorize reads and debits;
they cannot authorize minting, including coins, stars or diamonds.

On the host containing both environment files, run this from the updated tracker
checkout with Node 24 or newer:

```sh
sudo /usr/bin/node-24 scripts/configure-reward-authority.mjs \
  --tracker-env /etc/lidoll/tracker.env \
  --bot-env /etc/mommybot/mommybot.env
```

Use the actual environment paths if these differ. The helper generates a random
key, preserves unrelated settings and Linux ownership/mode, and makes private
backups. It reuses a matching existing key on repeated runs and prints no secret.
It does not restart services. For separate hosts, securely provision the same
random base64url key in the two settings below; do not paste it in chat or logs.

- Tracker: `LIDOLLCOIN_REWARD_KEYS` is a JSON object mapping `lidollbot` to the key.
- Bot: `LIDOLLCOIN_REWARD_KEY` is that key, for `LIDOLLCOIN_CLIENT_ID=lidollbot`.

The key is separate from OIDC, report, statistics and wallet tokens. Do not place
it in `LIDOLLCOIN_APPS`, browser code, GameMaker builds or downloadable config.

## Deployment order

1. Configure the signing key on both services.
2. Deploy and restart the updated MommyBot. It can send signatures to the old
   tracker while the remaining rollout proceeds. Verify the key before allowing
   purchases that may need a refund.
3. Deploy and restart the updated identity service. Verify its `/jwks` and
   `POST /account/status` routes are reachable by the tracker using the configured
   `OIDC_ISSUER`. The status route accepts a subject and random nonce, and returns
   a signed status containing no username or password information.
4. Deploy and restart the updated tracker. Its first database open performs the
   additive migrations automatically. Keep the identity and tracker versions
   compatible; an old identity service makes new authenticated tracker requests
   fail closed once the short status cache expires.
5. Verify sign-in, record saving, ordinary image upload and a controlled bot
   reward/refund. Review service logs for configuration errors. Do not use a live
   account for attack reproduction or send test community notifications.

LiDollQuest's former client-generated credits/refunds are rejected by this tracker
release. Deploy its compatible gameplay integration before restoring those online
reward flows. Rebuilding the old adapter alone cannot prove local gameplay.

## Policies after upgrade

- Password reset or identity disable advances a persistent security version.
  Authenticated requests recheck signed identity status, cached for at most 30
  seconds. A change revokes app sessions, connected-wallet grants and admin-owned
  report/statistics tokens. Reconnect or recreate those integrations after a reset.
  In-flight requests may finish; this is not cancellation of work already accepted.
  Identity-service outages return 503 after the cache expires.
- Both HTTP services contain malformed request targets and rejected async handlers
  at their request boundary. Invalid targets return an error without killing Node.
- Uploads reserve capacity before reading request bodies or decoding images:
  four active requests per tracker process, two per account, and 20 attempts per
  account per minute persisted across restarts. Existing body/pixel limits remain.
- Manual and automatic timeline posts share a ten-post-per-minute account budget.
  Excess automatic posts are suppressed, while records still save. Retrying or
  editing those records does not later publish them.
- Activity retains the newest 1,000 notifications per account, with corresponding
  old delivery rows removed. Push workers read bounded pages and attempt at most
  100 deliveries per tick. These bounds do not guarantee capacity under all loads.
- New record rewards are capped at 50 coins per change and 250 performance coins
  per account per UTC server day. Sticker rewards are capped at 20 and chart stars
  at 50 per account per UTC server day. Limits survive restarts; old or zero-award
  receipts cannot collect again tomorrow. Records/chart data remain intact. Welcome
  coins and daily check-in bonuses follow their separate policies. Existing awarded
  balances and pending entitlements are preserved.

Self-reported records remain self-reported: these limits bound their economic
impact; they do not prove that an observation occurred. Shared-currency gameplay
rewards require server-owned gameplay decisions, not a claimed score or win.

## Verification

`npm test` includes the security regression suites. They cover malformed raw HTTP,
identity reset/disable, signed status tampering, revoked tokens, upload admission,
post fanout, activity retention, reward ceilings/restarts and signing configuration.
`node tests/mommybot-diamonds-integration.mjs` checks the actual bot wallet client
against a disposable tracker API without Discord or live wallets.
