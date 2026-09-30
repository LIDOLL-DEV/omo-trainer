# Diamond store (PayPal Checkout) — design

Players buy **diamond packs** on the Little Log website with PayPal. The tracker owns the wallet, so the store lives in the tracker (`server/store.mjs`) and credits diamonds through the same atomic market ledger every other reward uses. Coins are not sold directly: the existing one-way exchange (1 diamond = 50 LiDollCoins) turns bought diamonds into coins, which keeps a single price anchor and rules out arbitrage between two catalogues.

Every fulfilled purchase also grants **30 days of supporter status**: a small star beside the buyer's name in Little Log (posts, comments, friends, profile) and in LiDollQuest online rooms (peer labels and the player's own HUD). Buying again while the star is active extends it by another 30 days from the current end.

## Why PayPal Checkout with the Orders API

| Option | Verdict |
| --- | --- |
| **Checkout (JS SDK buttons) + Orders API v2** | **Chosen.** Our server creates the order with the catalogue price and captures it, so the payment is bound to the signed-in account and the amount can be verified before crediting. Guest card checkout is included with no extra vetting. |
| Hosted Buy Now buttons + webhooks | Fulfilment depends only on the webhook and the account has to travel in a custom field. Weaker binding, worse UX. |
| Payment links / invoices | Manual fulfilment through the admin grant tool. Kept as the fallback for closed betas and support cases. |
| Advanced card fields | Extra PayPal vetting and PCI scope for no gain; Checkout already takes cards. |

Ask PayPal for **micropayments pricing** on the business account before launch: small packs are otherwise eaten by the fixed per-transaction fee.

**Policy risk, stated plainly:** PayPal's acceptable use policy restricts sexually oriented digital goods. Storefront copy sells "diamonds for LiDollQuest" and nothing themed; keep it that way. Plan B if the account is ever reviewed: itch.io keys redeemed through the admin grant tool, or an adult-friendly processor.

## Money flow

```
browser (lib/store.js)                tracker (server/store.mjs)                     PayPal
────────────────────────              ─────────────────────────────                  ──────────
GET api/store ───────────────────────► catalogue, own purchases, supporter_until,
                                       paypal client id + environment
click pack  ─► POST api/store/order ─► insert store_purchases(pending, sku, price) ─► POST /v2/checkout/orders
             ◄──── order id ─────────◄ (order id becomes the purchase id)          ◄─ id, status CREATED
PayPal buttons approve …………………………………………………………………………………………………………………………………………………► buyer approves
onApprove ──► POST api/store/capture ─► owner + status check ─────────────────────► POST /v2/checkout/orders/{id}/capture
                                       verify COMPLETED, amount, currency,         ◄─ capture id, payer id
                                       custom_id == purchase id
                                       BEGIN: adjust(owner,'diamonds',+n)
                                             ledger "Diamond pack purchase"
                                             store_supporters until += 30 d
                                             status → fulfilled          COMMIT
             ◄──── receipt ──────────◄
PayPal webhook ─────────────────────► POST api/store/paypal-webhook (no session)
                                       verify-webhook-signature via PayPal API
                                       PAYMENT.CAPTURE.COMPLETED → fulfil if still pending/captured (fallback)
                                       PAYMENT.CAPTURE.REFUNDED / REVERSED / DENIED,
                                       CUSTOMER.DISPUTE.CREATED → clawback + flag
```

Rules that never bend:

- **The server owns the price.** The browser sends a SKU, never an amount. Capture is refused unless PayPal reports `COMPLETED`, the captured value and currency equal the catalogue row, and the order's `custom_id` is the purchase id we created.
- **One fulfilment per order.** Each purchase row has our own uuid as `id` (sent to PayPal as `custom_id`) and the PayPal order id in the unique `order_id` column; the diamond credit uses the ledger operation `store:<purchase id>`. Capture retries, duplicate webhooks and a webhook racing the capture all resolve to the same single credit.
- **Purchases bypass the per-app diamond daily cap.** That cap (`diamondDailyLimit`) guards *earned* credits from external apps. Paid diamonds go through `adjust()` directly, exactly as streak rewards do.
- **No cash out.** Diamonds and coins stay one-way. This keeps the store out of money-transmitter territory.
- **Clawbacks never push a balance negative.** A refund or dispute debits up to the current diamond balance and records any shortfall on the purchase row (`clawback_short`) for staff to see; supporter days from that purchase are removed.
- **Secrets stay server-side.** `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID` never reach the browser; the client id and environment do.

## Data (market.sqlite)

Tables are created idempotently inside `createEconomy`; the market schema version stays at 9 because nothing existing changes.

```sql
store_purchases(
  id TEXT PRIMARY KEY,            -- our uuid, also PayPal's custom_id
  owner TEXT NOT NULL REFERENCES economy_wallets(owner),
  request_id TEXT,                -- browser idempotency key (unique per owner)
  order_id TEXT UNIQUE,           -- PayPal order id (NULL for staff grants)
  sku TEXT NOT NULL, diamonds INTEGER NOT NULL, price_cents INTEGER NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','fulfilled','refunded','disputed','failed','cancelled')),
  capture_id TEXT, payer_id TEXT, clawback_short INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',  -- staff-visible reason for manual grants/refunds
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
store_events(id TEXT PRIMARY KEY, type TEXT NOT NULL, purchase_id TEXT, received_at TEXT NOT NULL) -- webhook replay guard
store_supporters(owner TEXT PRIMARY KEY REFERENCES economy_wallets(owner), until INTEGER NOT NULL)      -- epoch ms
```

Ledger reasons: `Diamond pack purchase`, `Diamond pack refund`, `Diamond pack dispute`, `Staff diamond grant`.

## Catalogue

Defaults live in `server/store.mjs` (`DEFAULT_CATALOG`) and can be replaced with the `STORE_CATALOG` environment variable (JSON array of `{sku, name, diamonds, price_cents, currency}`). Prices are whole cents; the currency is a single ISO code for the whole catalogue.

| SKU | Diamonds | Price (USD) |
| --- | --- | --- |
| handful | 5 | 1.99 |
| pouch | 15 | 4.99 |
| chest | 40 | 9.99 |
| hoard | 100 | 19.99 |

Doll sets the final numbers; these are placeholders anchored to the 50-coin exchange.

## Routes (tracker)

Session + CSRF protected, same-origin, under `api/`:

- `GET store` → `{participant, csrf, enabled, environment, client_id, currency, catalog, purchases, supporter_until}`.
- `POST store/order` `{sku, requestId}` → `{id, order_id, status}`. `requestId` is the browser's idempotency key so a double click cannot open two PayPal orders; the SDK's `createOrder` returns `order_id`.
- `POST store/capture` `{id}` → `{id, status, diamonds, balance, supporter_until}`. Idempotent.

No session (PayPal calls it), registered before the origin/session checks in `server/api.mjs`:

- `POST store/paypal-webhook` → `200 {ok:true}` after signature verification; `400` on a bad signature; unknown event types are recorded and ignored.

Admin (`requireAdmin`, audited):

- `GET admin/store` → recent purchases with owner labels, catalogue, environment.
- `POST admin/store/grant` `{owner, sku, reason}` → manual fulfilment (payment links, itch.io keys, goodwill). Supporter days included.
- `POST admin/store/refund` `{id, reason}` → PayPal refund of the capture, then clawback.

External wallet route `GET lidollcoin/v1/wallet?client_id=lidollquest` gains `supporter_until` so the quest server can show the star.

## Supporter star

- Tracker: `social.avatarInfo(owner)` adds `supporter:true` while `store_supporters.until > now`. Every place that already spreads `avatarInfo` (post authors, comment authors, friends, member profile, the session participant) picks it up. `lib/avatar.js#createIdentity` and the member heading render `★` with the title "Supporter".
- Quest server: `wallet.mjs#authenticate` reads `supporter_until`; `zones.mjs` keeps a per-owner map (like `staffOwners`) and sets `supporter:true` on peers plus `supporter_until` on the snapshot.
- GML: `online_peer_label()` prefixes `★ ` for supporters, so the label and the right-click hit test stay one string; the HUD shows the player's own star while `supporter_until` is in the future.

## Configuration

```
PAYPAL_CLIENT_ID=        # from the REST app in developer.paypal.com
PAYPAL_CLIENT_SECRET=    # server only
PAYPAL_ENV=sandbox       # or live
PAYPAL_WEBHOOK_ID=       # id of the webhook you registered for <PUBLIC_ORIGIN>/tracker/api/store/paypal-webhook
STORE_CATALOG=           # optional JSON override of the packs
```

The store is disabled (routes answer 503, no card on the page, no PayPal hosts in the CSP) until `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set. Webhook events are rejected until `PAYPAL_WEBHOOK_ID` is set, so register the webhook before enabling live mode.

Webhook events to subscribe: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.RESOLVED`.

## Content-Security-Policy

When the store is enabled, `scripts/serve.mjs` adds the PayPal hosts for the active environment: `script-src` and `connect-src` gain `https://www.paypal.com` (sandbox: `https://www.sandbox.paypal.com`), `frame-src` allows the same, `img-src` allows `https://www.paypalobjects.com`, and `style-src` gains `'unsafe-inline'` because the buttons SDK injects inline styles for its frame. Nothing else in the policy loosens, and the strict policy returns the moment the store is disabled.

## Go-live checklist (Doll)

1. Create a REST app (sandbox) in the PayPal developer dashboard; note client id and secret. Create a sandbox buyer account.
2. Register the sandbox webhook URL and event list above; note the webhook id.
3. Set the four `PAYPAL_*` variables in `tracker.env`, restart, buy a pack with the sandbox buyer, refund it from the sandbox dashboard, confirm the diamonds come back out and the star disappears.
4. Request micropayments pricing for the business account.
5. Decide packs and prices; set `STORE_CATALOG` if the defaults change.
6. Publish terms of sale: 18+, digital goods, non-refundable except where required by law, no cash out. Sales tax and VAT are the merchant's job; start US-only if you want to defer that.
7. Repeat steps 1–3 with live credentials and `PAYPAL_ENV=live`.

## Housekeeping and disputes

The 30-second reward timer calls `store.expirePending()`, which marks checkouts still pending after three days as `cancelled` (PayPal orders expire on roughly that schedule). `CUSTOMER.DISPUTE.CREATED` claws back immediately; `CUSTOMER.DISPUTE.RESOLVED` is only recorded in `store_events`, so a dispute won in the seller's favour is restored by a staff grant with the dispute id as the reason.

## Tests

`tests/store.test.mjs` runs a fake PayPal HTTP server (OAuth, create order, capture, webhook verification, refund) against `createApi` with real session cookies. It covers: catalogue and disabled state, server-side pricing, capture that credits diamonds and supporter days once, retry and cross-account idempotency, amount/currency mismatch refusal, webhook signature rejection, webhook fallback fulfilment, refund and dispute clawback with shortfall recording, supporter expiry, admin grant/refund audit rows, and the `supporter_until` wallet field.
