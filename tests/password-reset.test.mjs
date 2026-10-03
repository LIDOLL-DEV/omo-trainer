import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openAuthStore } from '../auth/store.mjs';
import { adminToken, createAdminReset } from '../auth/admin-reset.mjs';
import { createPasswordReset } from '../server/password-reset.mjs';
import { openDatabase } from '../server/database.mjs';
import { createApi } from '../server/api.mjs';

const TOKEN = 'a'.repeat(43);
async function tempStore(prefix) {
  await mkdir('artifacts', { recursive: true });
  return openAuthStore(await mkdtemp(resolve('artifacts/' + prefix)));
}
async function listen(handler) {
  const server = createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise(done => server.close(done)) };
}

test('reset by account ID issues a fresh password, revokes OIDC sessions, advances the security version and keeps the subject', async () => {
  const store = await tempStore('reset-store-');
  try {
    const account = await store.setPassword('alice', 'original-password-123', true);
    await new store.Adapter('Session').upsert('session-1', { accountId: account.id }, 600);
    const before = store.security(account.id).version;
    const result = await store.resetPasswordById(account.id);
    assert.equal(result.username, 'alice'); assert.equal(result.disabled, false);
    assert.match(result.password, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(await store.verify('alice', 'original-password-123'), null);
    assert.equal((await store.verify('alice', result.password)).id, account.id);
    assert.equal(store.security(account.id).version, before + 1);
    assert.equal(await new store.Adapter('Session').find('session-1'), undefined);
    assert.equal(await store.resetPasswordById('no-such-account'), null);
    store.disable('alice');
    const disabled = await store.resetPasswordById(account.id);
    assert.equal(disabled.disabled, true);
    assert.equal(await store.verify('alice', disabled.password), null, 'A reset never re-enables a disabled identity');
  } finally { store.close(); }
});

test('the identity reset endpoint is off without a token, hidden behind the proxy, and requires the bearer secret', async () => {
  assert.equal(adminToken(''), null);
  for (const weak of ['short', 'x'.repeat(31), 'has spaces '.repeat(4)]) assert.throws(() => adminToken(weak));
  const store = await tempStore('reset-endpoint-');
  const account = await store.setPassword('bob', 'original-password-123', true);
  const off = await listen(createAdminReset(store, null)), on = await listen(createAdminReset(store, TOKEN));
  const call = (base, { token = TOKEN, body = { subject: account.id }, headers = {}, method = 'POST' } = {}) =>
    fetch(base + '/admin/reset-password', { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  try {
    assert.equal((await call(off.url)).status, 404);
    assert.equal((await call(on.url, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).status, 404);
    assert.equal((await call(on.url, { headers: { 'X-Real-IP': '203.0.113.9' } })).status, 404);
    assert.equal((await call(on.url, { method: 'GET' })).status, 405);
    assert.equal((await call(on.url, { token: 'b'.repeat(43) })).status, 401);
    assert.equal((await call(on.url, { body: { subject: '../etc' } })).status, 400);
    assert.equal((await call(on.url, { body: { subject: 'missing-account' } })).status, 404);
    assert.ok(await store.verify('bob', 'original-password-123'), 'Rejected calls never change the password');
    const response = await call(on.url);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json();
    assert.equal(value.subject, account.id); assert.equal(value.username, 'bob');
    assert.equal((await store.verify('bob', value.password)).id, account.id);
    let limited = false;
    for (let index = 0; index < 30 && !limited; index++) limited = (await call(on.url, { token: 'c'.repeat(43) })).status === 429;
    assert.ok(limited, 'Wrong-token attempts are rate limited too');
  } finally { await off.close(); await on.close(); store.close(); }
});

test('the tracker client only calls a private configured URL and validates the identity response', async () => {
  const env = { AUTH_ADMIN_URL: 'http://10.1.1.23:4180/admin/reset-password', AUTH_ADMIN_TOKEN: TOKEN, OIDC_ISSUER: 'https://auth.example' };
  const off = createPasswordReset({ env: {} });
  assert.equal(off.configured, false);
  await assert.rejects(off.reset({ issuer: 'https://auth.example', subject: 's' }), error => error.status === 503);
  for (const AUTH_ADMIN_URL of ['http://203.0.113.5:4180/admin/reset-password', 'http://10.1.1.23:4180/wallet/identity', 'https://user:pw@auth.example/admin/reset-password', 'not a url'])
    assert.throws(() => createPasswordReset({ env: { ...env, AUTH_ADMIN_URL } }));
  assert.throws(() => createPasswordReset({ env: { ...env, AUTH_ADMIN_TOKEN: 'short' } }));
  const calls = [];
  const respond = (status, body) => async (url, options) => { calls.push({ url: String(url), options }); return new Response(JSON.stringify(body), { status }); };
  const identity = { issuer: 'https://auth.example', subject: 'subject-1' };
  const good = createPasswordReset({ env, fetcher: respond(200, { subject: 'subject-1', username: 'carol', disabled: false, password: 'p'.repeat(32) }) });
  assert.deepEqual(await good.reset(identity), { username: 'carol', disabled: false, password: 'p'.repeat(32) });
  assert.equal(calls[0].url, env.AUTH_ADMIN_URL); assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.deepEqual(JSON.parse(calls[0].options.body), { subject: 'subject-1' });
  await assert.rejects(good.reset({ issuer: 'https://other.example', subject: 'subject-1' }), error => error.status === 409);
  await assert.rejects(createPasswordReset({ env, fetcher: respond(200, { subject: 'someone-else', username: 'x', disabled: false, password: 'p'.repeat(32) }) }).reset(identity), error => error.status === 503);
  await assert.rejects(createPasswordReset({ env, fetcher: respond(404, {}) }).reset(identity), error => error.status === 404);
  await assert.rejects(createPasswordReset({ env, fetcher: respond(429, {}) }).reset(identity), error => error.status === 429);
  await assert.rejects(createPasswordReset({ env, fetcher: async () => { throw Error('offline'); } }).reset(identity), error => error.status === 503);
});

test('admin password reset requires an admin and CSRF, refuses self-resets, revokes the target and audits without the password', async () => {
  const db = openDatabase(':memory:');
  const admin = db.ensureParticipant('https://auth.example', 'admin-sub', 'lid0ll'), alice = db.ensureParticipant('https://auth.example', 'alice-sub', 'Alice');
  db.admin.bootstrap(admin.id);
  const token = db.createSession(admin.id), aliceSession = db.createSession(alice.id);
  const requests = [];
  const passwordReset = { configured: true, async reset(identity) { requests.push(identity); return { username: 'alice', disabled: false, password: 's'.repeat(32) }; } };
  const login = { origin: '', session: request => db.session(request.headers.cookie) };
  const api = createApi(db, login, { passwordReset });
  const app = await listen((req, res) => api(req, res, new URL(req.url, 'http://localhost').pathname.slice(1)));
  login.origin = app.url;
  const post = (cookie, body, headers = {}) => fetch(app.url + '/admin/password-reset', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: app.url, ...headers }, body: JSON.stringify(body) });
  try {
    const users = await (await fetch(app.url + '/admin/users', { headers: { Cookie: token } })).json();
    assert.equal(users.passwordReset, true);
    const csrf = users.csrf;
    assert.equal((await post(aliceSession, { id: admin.id })).status, 403, 'Ordinary users cannot reach the route');
    assert.equal((await post(token, { id: alice.id })).status, 403, 'CSRF token required');
    assert.equal((await post(token, { id: admin.id }, { 'X-CSRF-Token': csrf })).status, 400, 'No self-reset from the console');
    assert.equal((await post(token, { id: 'missing' }, { 'X-CSRF-Token': csrf })).status, 404);
    assert.equal(requests.length, 0, 'Rejected requests never reach the identity service');
    const response = await post(token, { id: alice.id }, { 'X-CSRF-Token': csrf });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.password, 's'.repeat(32)); assert.equal(result.id, alice.id);
    assert.deepEqual({ issuer: requests[0].issuer, subject: requests[0].subject }, { issuer: 'https://auth.example', subject: 'alice-sub' });
    assert.equal(db.session(aliceSession), null, 'The target is signed out of Little Log immediately');
    const entry = db.admin.auditList(admin.id).find(row => row.action === 'reset-password');
    assert.equal(entry.target_id, alice.id); assert.equal(entry.actor_id, admin.id);
    assert.ok(!JSON.stringify(entry).includes('s'.repeat(32)), 'The password never reaches the audit log');
  } finally { await app.close(); db.close(); }
});
