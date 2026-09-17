# Quest accounts gateway

Little Log owns sign-in, display names and friendships. Quest retains its existing opaque SHA-256 account identifier; `quest_social_accounts` resolves it internally. Acting identity always comes from a validated grant. No second friendship database or tracking-record access is introduced.

Deploy the tracker and auth service, then the standalone Quest service, then the rebuilt game. Existing grants retain currency access. New account features require renewed consent for `social:read social:write saves:read saves:write`. The default Quest OIDC scope list includes these; explicit custom client scope lists must be updated as well. Other clients' defaults are unchanged.

Both `/tracker/api/lidollcoin/browser/` and `/tracker/api/lidollcoin/v1/` expose:

| Method and route | Scope | Parameters |
| --- | --- | --- |
| GET `social` | social:read | Optional `q` display-name search, or `account_id` for one relationship |
| POST `social` | social:write | `action: request` with `account_id`; `accept` or `remove` with friendship `id` |
| GET `zones/inspect` | social:read | Owned `character_id`, remote `target`, current `controller` |
| GET `cloud` | saves:read | Omit character for roster; otherwise `character_id`, optional `history=1` or `revision`, optional zero-based `part` |
| POST `cloud/action` | saves:write | Standalone service's `begin`, `chunk`, `commit` upload protocol |

Native requests also supply `client_id=lidollquest` and an Authorization bearer grant. Browser requests use the HttpOnly game cookie; writes require the same origin and session `X-CSRF-Token`. Explicit method/route allowlists reject unsupported operations. Disabled accounts, relationship acceptance, the 200-relationship limit and revocation use the existing Little Log implementation.

Cloud and inspection are proxied to `LIDOLLQUEST_API_URL`. A chunk is 128 KiB decoded, fitting within the existing 256 KiB gameplay request/response limits. Ordinary wallet/social requests remain limited to 8 KiB. No blanket proxy-limit increase is needed. Keep the standalone service private and preserve existing TLS/proxy configuration.

Run `npm test`. The Quest social and browser API regressions cover shared relationships, native grants, old-scope denial, continued wallet access, origin/CSRF checks, verbs and disabled accounts. The game's two-browser fixture covers the complete experience against both services.
