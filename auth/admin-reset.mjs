import { createHash, timingSafeEqual } from 'node:crypto';

export const ADMIN_RESET_PATH = '/admin/reset-password';
const digest = value => createHash('sha256').update(value).digest();

export function adminToken(raw = process.env.AUTH_ADMIN_TOKEN ?? '') { // An unset token leaves the endpoint switched off; a weak one is a configuration error.
  if (!raw) return null;
  if (raw.length < 32 || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('AUTH_ADMIN_TOKEN must be 32-512 URL-safe characters.');
  return raw;
}

export function createAdminReset(store, token) { // Private service-to-service password reset; the tracker admin console is the only intended caller.
  const expected = token ? digest(token) : null;
  const reply = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  return async (request, response) => {
    // Unconfigured, or reached through the public reverse proxy (which always adds these headers): behave as if absent.
    if (!expected || request.headers['x-forwarded-for'] || request.headers['x-real-ip']) return reply(response, 404, { error: 'not_found' });
    if (request.method !== 'POST') return reply(response, 405, { error: 'method_not_allowed' });
    if (!store.rateLimit('admin-reset:global', 30)) return reply(response, 429, { error: 'rate_limited' }); // Counted before the token check, so guessing is throttled too.
    const supplied = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(request.headers.authorization ?? '')?.[1];
    if (!supplied || !timingSafeEqual(digest(supplied), expected)) return reply(response, 401, { error: 'invalid_token' });
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return reply(response, 415, { error: 'unsupported_media_type' });
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 1024) return reply(response, 413, { error: 'too_large' }); chunks.push(chunk); }
    let subject;
    try { subject = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.subject; } catch { return reply(response, 400, { error: 'invalid_request' }); }
    if (typeof subject !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(subject)) return reply(response, 400, { error: 'invalid_request' });
    const result = await store.resetPasswordById(subject);
    if (!result) return reply(response, 404, { error: 'account_not_found' });
    return reply(response, 200, { subject, username: result.username, disabled: result.disabled, password: result.password });
  };
} // The new password crosses only this private response; it is never logged or stored in plaintext.
