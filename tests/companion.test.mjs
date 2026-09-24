import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.PORT = '0'; // Ephemeral port so the suite never disturbs a local preview server.
process.env.HOST = '127.0.0.1';
process.env.BASE_PATH = '/tracker/';
await mkdir('artifacts', { recursive: true });
process.env.DATA_DIR = await mkdtemp(resolve('artifacts/companion-'));
const { server } = await import('../scripts/serve.mjs');
if (!server.listening) await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => new Promise(done => server.close(done)));
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the companion is served from the tracker origin with its own assets', async () => {
  const bare = await fetch(`${origin}/tracker/companion`, { redirect: 'manual' });
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get('location'), '/tracker/companion/');
  const page = await fetch(`${origin}/tracker/companion/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /LidollQuest-Companion/);
  assert.doesNotMatch(html, /<iframe/i);
  for (const asset of ['companion/app.js', 'companion/style.css']) {
    const response = await fetch(`${origin}/tracker/${asset}`);
    assert.equal(response.status, 200, `${asset} must be served`);
  }
  for (const asset of ['companion/paperdoll.js', 'companion/art.json', 'companion/assets/TQ_Base_3.png']) { // Game artwork is disallowed: it is neither shipped nor served.
    const response = await fetch(`${origin}/tracker/${asset}`);
    assert.notEqual(response.status, 200, `${asset} must not be served`);
  }
  assert.doesNotMatch(read('companion/app.js'), /paperdoll|art\.json|drawCharacter|drawTush/); // The companion never renders character artwork.
  assert.doesNotMatch(read('companion/index.html'), /id="paperdoll"|id="tush-art"/);
});

test('the companion calls the gateway same-origin and never carries a bot origin or a token', () => {
  const app = read('companion/app.js');
  assert.match(app, /'\.\.\/api\/lidollcoin\/browser\/'/); // Relative so the wallet cookie's Path scope matches and no cross-origin request is ever made.
  assert.match(app, /credentials:'same-origin'/);
  assert.match(app, /view=companion/);
  assert.match(app, /action:'bank_sell'/);
  assert.doesNotMatch(app, /bot\.lidoll\.dev|Bearer|LIDOLLBOT/); // The page holds no bearer token and points at no bot origin.
  assert.doesNotMatch(app, /zones\/inspect/); // The sheet rides along in the companion view: zones/inspect needs an arena presence a companion never has.
  assert.doesNotMatch(read('server/games.mjs'), /lidollquest-companion/); // The companion is not a bot redirect.
  assert.match(read('index.html'), /href="\.\/companion\/"/);
});

test('the item tabs mirror the game’s own categories and filter without another request', () => {
  const app = read('companion/app.js');
  assert.match(app, /\{id:'all',label:'ALL'/); // The All catch-all is what keeps quest items and any future category reachable.
  for (const group of ['clothes', 'weapons', 'food', 'drinks']) assert.match(app, new RegExp(`id:'${group}'`), `${group} mirrors inv_battle_overlay_groups()`);
  assert.match(app, /const drink=item=>item\.category==='drink'\|\|item\.is_drink===true/); // inv_item_is_drink: bottled food belongs on Drinks.
  assert.match(app, /match:item=>item\.category==='food'&&!drink\(item\)/); // ...and must therefore leave the Food tab.
  assert.match(app, /diaper_cover:'Cover'/); // The Type column uses inv_category_short_label, not the raw category id.
  assert.match(app, /sessionStorage\.setItem\('lidoll\.companion\.tab'/); // The chosen tab survives the 15-second refresh instead of snapping back to All.
  for (const name of ['renderInventory', 'selectTab']) { // Switching tabs filters the sheet already in hand; it never re-reads the gateway.
    const body = app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
    assert.ok(body, `${name} must exist`);
    assert.doesNotMatch(body, /\brequest\(|\bfetch\(/, `${name} must filter the snapshot locally, not call the gateway`);
  }
  assert.match(read('companion/index.html'), /id="inventory-tabs"[^>]*role="tablist"/);
  assert.doesNotMatch(read('companion/style.css'), /var\(--accent/); // No theme defines --accent; the pills and meter must use real theme tokens.
});

test('the consent flow keeps a fixed companion return destination', () => {
  const api = read('server/coin-browser-api.mjs');
  assert.match(api, /companion:\{login:'game-wallet-companion',form:'companion',back:base\+'companion\/'\}/);
  assert.match(api, /views\[value\]\?\?views\.standalone/); // An unknown view falls back to standalone rather than to an attacker-supplied URL.
  const login = read('server/login.mjs');
  assert.match(login, /'game-wallet-companion'/);
  assert.match(login, /game-wallet-companion' \? `\$\{base\}api\/lidollcoin\/browser\/connect\?view=companion`/);
});

test('an unlinked visitor is offered the companion consent view rather than an error', async () => {
  const response = await fetch(`${origin}/tracker/api/lidollcoin/browser/session`, { redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { linked: false }); // The page turns this into a Connect button, not a failure.
  const html = read('companion/index.html');
  assert.match(html, /connect\?view=companion/);
});

test('the gateway still refuses a cross-origin companion request', async () => {
  for (const headers of [{ Origin: 'https://bot.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(`${origin}/tracker/api/lidollcoin/browser/zones?view=companion`, { headers, redirect: 'manual' });
    assert.equal(response.status, 403, `cross-origin companion reads must stay refused (${JSON.stringify(headers)})`);
  }
});

test('the Diaper Atelier and Clothes Emporium roll through the same gateway and retry one request', () => {
  const app = read('companion/app.js');
  assert.match(app, /action:'companion_roll'/);
  assert.match(app, /action:'companion_withdraw'/);
  assert.match(app, /price:mode==='diamond'\?shop\.diamond\.price:shop\.price/); // The player confirms the shown price; the server refuses a roll once it has changed.
  assert.match(app, /mode,price:/); // Diamond rolls send mode:'diamond' with the one-diamond price.
  assert.match(app, /companionDiamondRolls/); // The diamond block only renders when the server advertises it.
  assert.match(app, /Not enough diamonds\. Nothing was rolled\./);
  assert.match(app, /if\(error\.status&&error\.status<500&&error\.status!==429\)pendingRoll=null/); // Only a definite refusal forgets the request; a lost reply retries the same roll.
  assert.match(read('companion/index.html'), /id="shops-card"[^>]*hidden/); // Hidden until a server advertising the shops answers.
});
