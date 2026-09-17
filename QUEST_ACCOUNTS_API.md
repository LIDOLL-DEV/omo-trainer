# Quest accounts gateway

Little Log owns sign-in, display names and friendships. Quest retains its existing opaque SHA-256 account identifier; `quest_social_accounts` resolves it internally. Acting identity always comes from a validated grant. No second friendship database or tracking-record access is introduced.

Deploy the tracker and auth service, then the standalone Quest service, then the rebuilt game. Existing grants retain currency access. New account features require renewed consent for `social:read social:write saves:read saves:write`. The shipped browser and native game use Little Log browser consent and device-code consent respectively, so neither requires a separate `lidollquest` OIDC registration in `clients.json`. A missing entry is normal for these flows. Only a separate direct OIDC integration needs the Quest identity registration; its default scope list includes the new scopes, while an explicit custom list must be updated. Other clients' defaults are unchanged; do not expand the `little-log` identity client's scopes.

Both `/tracker/api/lidollcoin/browser/` and `/tracker/api/lidollcoin/v1/` expose:

| Method and route | Scope | Parameters |
| --- | --- | --- |
| GET `social` | social:read | Optional `q` display-name search, or `account_id` for one relationship |
| POST `social` | social:write | `action: request` with `account_id`; `accept` or `remove` with friendship `id` |
| GET `zones/inspect` | social:read | Owned `character_id`, remote `target`, current `controller` |
| GET `cloud` | saves:read | Omit character for roster; otherwise `character_id`, optional `history=1` or `revision`, optional zero-based `part` |
| POST `cloud/action` | saves:write | Standalone service's `begin`, `chunk`, `commit` upload protocol |
| POST `characters/action` | saves:write | Owned character `rename` (5 stars), `appearance` (1 star, paperdoll only), or confirmed `delete`; paid changes additionally require stars:write at the service |

Cloud actions also accept `rename`, `delete`, `clear`, `pause` and `resume`, using a stable request ID and expected cloud head revision. Labels are free and belong to individual versions. Clearing the last cloud version pauses uploads on all devices until explicitly resumed. NPC sprite changes retain the existing free gameplay action. Deploy this gateway before the updated Quest service/game; browser CSRF and native grant checks apply to management as well.

Native requests also supply `client_id=lidollquest` and an Authorization bearer grant. Browser requests use the HttpOnly game cookie; writes require the same origin and session `X-CSRF-Token`. Explicit method/route allowlists reject unsupported operations. Disabled accounts, relationship acceptance, the 200-relationship limit and revocation use the existing Little Log implementation.

Cloud and inspection are proxied to `LIDOLLQUEST_API_URL`. A chunk is 128 KiB decoded, fitting within the existing 256 KiB gameplay request/response limits. Ordinary wallet/social requests remain limited to 8 KiB. No blanket proxy-limit increase is needed. Keep the standalone service private and preserve existing TLS/proxy configuration.

Run `npm test`. The Quest social and browser API regressions cover shared relationships, native grants, old-scope denial, continued wallet access, origin/CSRF checks, verbs and disabled accounts. The game's two-browser fixture covers the complete experience against both services.

## LiDollQuest friend activity

Accepted friends can see Playing LiDollQuest in Friends and receive a stored activity entry when a linked game starts. The game also shows a Friends badge and a brief notice. Activity contains only the member display name and game name. Unfriending removes visibility; pending requests and strangers receive nothing.

Settings > Friends playing LiDollQuest is an optional push preference (`friendGames`, stored as `friend_games`), off by default. It uses existing device permission, subscriptions and quiet hours. Expired play sessions and ended friendships suppress queued alerts. The activity feed remains available with push disabled.

The existing scoped Quest social POST accepts `{action:"presence",session:"unique-window-id",playing:true}`; the authenticated grant determines the owner. Session IDs contain 8-80 letters, digits, underscores or hyphens. Heartbeats are expected every 30 seconds and expire after 90 seconds. Multiple windows coalesce; repeated starts have a five-minute notification cooldown. Send `playing:false` on leaving play. GET social and Friends rows expose `playing` and `gameStarted` only to accepted friends.

Additive SQLite tables preserve existing accounts, friendships, subscriptions and records. Deploy the tracker service/UI before the rebuilt game. `tests/game-presence.test.mjs` covers ownership, duplicate heartbeats, expiry, multiwindow behavior, push opt-in, quiet hours and unfriend suppression. The game repository also contains real two-player and tracker UI browser fixtures under `python/tests/fixtures/friend_activity*`.
