import { isIP } from 'node:net';
import { ApiError } from './database.mjs';

export function createPasswordReset({ env = process.env, fetcher = fetch } = {}) { // Asks the identity service to reset one account; the tracker never sees or stores password hashes.
  const raw = env.AUTH_ADMIN_URL ?? '', token = env.AUTH_ADMIN_TOKEN ?? '';
  if (!raw && !token) return { configured: false, async reset() { throw new ApiError(503, 'Password reset is not configured on this server.'); } };
  let url;
  try { url = new URL(raw); } catch { throw new Error('Set AUTH_ADMIN_URL to the identity service reset endpoint.'); }
  const [a, b] = url.hostname.split('.').map(Number);
  const privateIp = isIP(url.hostname) === 4 && (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/admin/reset-password' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && (privateIp || ['localhost', '[::1]'].includes(url.hostname)))) ||
      token.length < 32 || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid AUTH_ADMIN_URL or AUTH_ADMIN_TOKEN.'); // Plain HTTP only on loopback or a private LAN, never across the internet.
  const issuer = new URL(env.OIDC_ISSUER ?? 'http://127.0.0.1:4180').origin;
  return {
    configured: true,
    async reset(identity) {
      if (identity?.issuer !== issuer) throw new ApiError(409, 'This account signs in through a different identity service, so its password cannot be reset here.');
      let response;
      try {
        response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ subject: identity.subject }) });
      } catch { throw new ApiError(503, 'The identity service could not be reached. No password was changed.'); }
      if (response.status === 404) { await response.body?.cancel(); throw new ApiError(404, 'The identity service has no account for this user, or password reset is switched off there.'); }
      if (response.status === 429) { await response.body?.cancel(); throw new ApiError(429, 'Too many password resets. Wait 15 minutes and try again.'); }
      if (!response.ok) { await response.body?.cancel(); throw new ApiError(503, 'The identity service refused the reset. Check AUTH_ADMIN_TOKEN on both services.'); }
      let value;
      try { value = await response.json(); } catch { throw new ApiError(503, 'The identity service returned an invalid response. The password may have changed; reset again to be sure.'); }
      if (value?.subject !== identity.subject || typeof value.username !== 'string' || typeof value.disabled !== 'boolean' ||
          typeof value.password !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/.test(value.password)) throw new ApiError(503, 'The identity service returned an invalid response. The password may have changed; reset again to be sure.');
      return { username: value.username, disabled: value.disabled, password: value.password };
    },
  };
} // A lost response is safe to retry: each reset simply issues another fresh password.
