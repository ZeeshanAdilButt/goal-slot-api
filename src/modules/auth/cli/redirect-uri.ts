/**
 * Loopback redirect URI allowlist.
 *
 * Validated once, at session creation, and then stored. The approval endpoint
 * composes the final URL from the stored value and never from request input,
 * so there is no later point at which a crafted approval link could steer the
 * browser somewhere else. There is also no HTTP 3xx anywhere in the CLI flow -
 * the API returns the composed URL as JSON and the browser navigates
 * client-side - so this is not an open-redirect surface in the usual sense; it
 * is the boundary that keeps an authorization code from being delivered
 * off-machine.
 */

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost']);

// Below 1024 is privileged on POSIX, and a CLI asking to bind there is either
// broken or trying to hijack a well-known port.
const MIN_PORT = 1024;
const MAX_PORT = 65535;

export function isValidLoopbackRedirectUri(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // http only. https on loopback would need a certificate the CLI cannot have,
  // and every other scheme (file:, custom app schemes, javascript:) is a way to
  // hand the code to something that is not a local listener.
  if (url.protocol !== 'http:') return false;

  // `hostname` is already lowercased and has IPv6 brackets stripped by URL, so
  // "::1" cannot sneak through this set. IPv6 loopback is deliberately not
  // accepted: browser behaviour around http://[::1] is inconsistent enough that
  // supporting it would cost more than it buys.
  if (!ALLOWED_HOSTS.has(url.hostname)) return false;

  if (url.pathname !== '/callback') return false;

  // No query, no fragment: the API appends `code` and `state` itself, and
  // anything already there would either collide with those or be a smuggled
  // parameter for whatever is listening.
  if (url.search !== '' || url.hash !== '') return false;

  // http://user:pass@127.0.0.1 - userinfo is a classic way to make a URL read
  // as one host while resolving to another.
  if (url.username !== '' || url.password !== '') return false;

  // A blank port means 80, which is privileged and never what the CLI binds.
  if (!/^\d+$/.test(url.port)) return false;
  const port = Number(url.port);
  if (port < MIN_PORT || port > MAX_PORT) return false;

  return true;
}

/**
 * Appends the authorization code and state to an already-validated redirect
 * URI. Uses URL/URLSearchParams rather than string concatenation so the values
 * are percent-encoded.
 */
export function composeRedirectUri(
  redirectUri: string,
  code: string,
  state?: string,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}
