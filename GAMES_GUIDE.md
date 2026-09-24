# Games in Little Log

Choose **Games** from the menu. Each card opens a game in a separate tab:

- **Diaper Atelier:** 3 LiDollcoins per roll, a saved collection and shared diaper bank.
- **Cozy Hangman:** 1 LiDollcoin to start; each newly revealed letter position pays 1 coin.
- **Prism Drop:** choose a landing pocket and bet 1, 5, 10, 25, 50 or 100 LiDollcoins.
  Exact guesses return 2x the stake, one pocket away returns 1.5x rounded up,
  two away returns the stake, and larger misses return zero. Coin pegs add bonuses
  even on misses. Returns include the stake; replaying a saved drop is free.
- **LidollQuest-Companion:** view your LiDollQuest character (level, class and
  equipped items) and her bank between adventures, and sell stored loot for
  LiDollCoins without walking back to an in-game shop. Free to open; a sale pays
  the item's own server-set price against your account's daily coin allowance.

Press **Sign in with LiD0llID** on the game page. Anyone with a LiD0llID account
can play; Discord membership is optional. Register if needed and approve wallet
access for game purchases and rewards. An existing LiD0llID browser login can
be reused. Existing Discord-linked players keep their saved collections.

LidollQuest-Companion is the one card that is **not** a MommyBot redirect. It is
a tracker page at `{base}companion/`, alongside `coins/`, because the browser
wallet gateway is same-origin only: `server/coin-browser-api.mjs` refuses any
cross-site request or foreign `Origin`, and its `__Secure-lidollquest_wallet`
cookie is `Path`-scoped to `api/lidollcoin/browser/` on the tracker origin. A
bot-origin page could neither send that cookie nor use the bearer path, which is
locked to `client_id=lidollquest`. Hosting the page here needs no change to
either check.

The page calls `api/lidollcoin/browser/session` to see whether a wallet
connection exists, `api/lidollcoin/browser/zones?view=companion&bank_page=N` for
the character list, wallet and bank, `api/lidollcoin/browser/zones/inspect` for
the character sheet, and `api/lidollcoin/browser/zones/action` with `bank_sell`
to sell a stored item. The tracker only proxies those calls; characters, banks,
prices and the daily coin allowance all live in the LiDollQuest service.

An unlinked visitor gets a **Connect LiDollQuest** button pointing at
`api/lidollcoin/browser/connect?view=companion`. That is a third fixed consent
destination beside `standalone` and `embedded`; an unknown `view` still falls
back to `standalone`, so no caller can supply a return URL. Signing in first
routes through the `game-wallet-companion` entry in the `server/login.mjs`
`returnTo` allowlist.

Touhou Trader is no longer listed in the Games menu. `/tracker/games/touhou`
still redirects to the bot so old bookmarks keep working; remove `touhou` from
`server/games.mjs` too if the game itself is retired.

All collections, saved rounds, battle rules and payment recovery remain in
MommyBot. Little Log opens the existing games using the same online wallet.
For a pending Prism Drop payment, use **Retry payment** in the game to settle
the saved drop without charging or rolling again.

Games have separate eight-hour sessions. Signing out of Little Log does not sign
out of an open game. Use each game's Sign out button on shared devices. Unlinking
in Discord invalidates game sessions without deleting collections or balances.
The Games page is available offline; opening games and spending/recovering coins
requires a connection. The games are never embedded in an iframe.

## Operator setup

Deploy the matching MommyBot changes first, then this PWA. After committing and
pushing both repositories, run the existing Fedora updater for MommyBot
(`bash scripts/update-fedora.sh` from its checkout), then:

```bash
sudo bash /opt/lidoll/current/deploy/fedora-update.sh
```

`LIDOLLBOT_PUBLIC_ORIGIN` in the tracker service environment defaults to
`https://bot.lidoll.dev`. Change it only if the bot uses another HTTPS origin;
do not include `/touhou/`, `/auth/` or any other path. Local development permits
HTTP loopback origins outside production. This variable is separate from the
tracker's own `PUBLIC_ORIGIN` and the bot's `LIDOLLID_PUBLIC_ORIGIN`.

The existing `lidollbot` OIDC registration and `/auth/callback` remain in use;
no identity-provider registration change is needed. On the bot's Nginx host,
forward `/auth/`, `/diapers/`, `/hangman/`, `/touhou/` and `/balldrop/` to its existing HTTP
listener. A virtual host that already proxies `/` needs no additional location.
On the tracker host, route `/tracker/games/` to Node with the rest of the app.

`server/games.mjs` redirects only fixed game names to trusted bot login paths.
It forwards no query parameters, tokens or account identifiers. `lib/games.js`
handles offline presentation. The service worker caches the public Games shell
and its module, never game redirects, cookies, API responses or payments. Both
Little Log and Caregiver Tracker themes share the same Games navigation.

Prism Drop uses `/tracker/games/balldrop`, which redirects to the configured
bot origin at `/balldrop/login`. Deploy MommyBot with its balldrop routes before
launching the new card.

Reload the installed PWA after deployment. Verify each card reaches its game,
complete one sign-in with an already linked account and confirm the expected
collection. Unit/browser fixtures cannot verify production
Nginx, Discord membership or the live identity provider.

## Checks

Run `npm test` for the configured-origin and fixed-redirect tests. With local
`PUPPETEER_MODULE` and `CHROME_PATH` set, run `node tests/games-browser.mjs` and
`node tests/theme-browser.mjs` for navigation, both themes, responsive layouts,
preserved form drafts, cached offline navigation and reconnect behavior. They
use disposable data and never spend real coins.


The potty tracker's top-right **Join Discord** link opens https://discord.gg/DBzvxxdvXt in a new tab, including before sign-in.


## Complete companion character view

The companion now shows the selected owned character's equipment, carried inventory with rolled stats, health/MP/core/needs stats and Tush Status (text and absorption meter only) alongside the bank. The companion renders no game artwork at all: no paperdoll and no rear-view art, because the art assets are not licensed for use outside the game. It follows current/latest online presence by default or a manually selected character, refreshing every 15 seconds while visible. Reads never acquire the game's controller lease. The private sheet comes from committed online state or a non-stale cloud save; public player inspection is unchanged. Unsynced local progress is unavailable and the source is labeled.

Carried items are grouped by the game's own category tabs — All, Clothes, Wpns, Food, Drinks — matching the in-game item viewer, with a count on each tab. All is the catch-all that keeps quest items reachable. Switching tabs filters the sheet already loaded, so it costs no request, and the chosen tab survives the 15-second refresh.

Deploy the matching quest service first, then Little Log. The companion ships no game artwork: companion/paperdoll.js, art.json and assets/ were removed and must not be re-added or allowlisted (tests/companion.test.mjs asserts they are not served). Do not run the game-side python/export_companion_assets.py for the tracker. No new game client or database reset is needed. Existing bank sale rights, receipts and daily cap remain authoritative.


The companion supports Equip on carried gear and Unequip on worn gear. Curses, full bags, dresses and used-diaper disposal follow game rules. Commands use character revision plus an equipment-source token; stale selections, combat, pending needs turns and uploads are rejected before mutation. Online characters update their committed loadout without acquiring the game controller; an offline cloud edit publishes a new complete save revision. Unsynced local-only progress remains unavailable. Rolled stats and item identity survive swaps.

## Diaper Atelier and Clothes Emporium

The companion's shops card replaces the retired MommyBot `/diapers` and `/clothes` gacha. Each roll costs LiDollCoins from the player's own LiDollQuest wallet grant, through the same durable debit the hub merchants use. The rolled item goes to the **selected character's bank** with a resale right capped at the price paid, so it can be sold straight away (bank Sell, or Sell on the reveal) or worn (**Wear now** withdraws it and equips it; bank rows also offer **Withdraw**). The Atelier rolls diapers and pull-ups; the Emporium rolls every other generated garment, diaper covers included.

Everything is server-side in LiDollQuest (`server/companion-shops.mjs`, actions `companion_roll` and `companion_withdraw`). The tracker gateway only forwards them, so Little Log needs no new route or secret. The roll is fixed when the purchase is reserved, and the page keeps one request ID until the server answers definitively, so a dropped connection shows **Retry roll** and never charges twice. The page sends the price it showed, and the server refuses the roll if the price has since changed. Prices, odds and item-level bands are tuned in the LiDollQuest `/gm` Loot tab (see its guide). The card stays hidden until the quest service advertises `companionShops`, so deploy LiDollQuest first.

With `PUPPETEER_MODULE` and `CHROME_PATH` set, `node tests/companion-shops-browser.mjs` drives the whole flow against a stubbed gateway and saves screenshots.
