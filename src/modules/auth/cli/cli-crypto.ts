import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';

/**
 * Secret material for the CLI flow. Everything here is a 256-bit random value
 * rather than a user-chosen password, which is why a plain sha256 is the right
 * digest at rest: there is nothing to brute-force, and bcrypt would only add
 * latency to the token-exchange path (which the device flow polls).
 */

/** Distinct prefixes so leak scanners (GitHub secret scanning, git-secrets) can pattern match. */
export const SESSION_SECRET_PREFIX = 'gsl_ss_';
export const AUTHORIZATION_CODE_PREFIX = 'gsl_ac_';
export const REFRESH_TOKEN_PREFIX = 'gsl_rt_';

/** 32 bytes -> 43 base64url characters, no padding. */
function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export const generateSessionSecret = () => randomToken(SESSION_SECRET_PREFIX);
export const generateAuthorizationCode = () =>
  randomToken(AUTHORIZATION_CODE_PREFIX);
export const generateRefreshToken = () => randomToken(REFRESH_TOKEN_PREFIX);

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * timingSafeEqual throws on a length mismatch, which would itself leak, so the
 * lengths are compared first - safe here because both sides are always the
 * fixed-width output of sha256Hex, never attacker-controlled input.
 */
export function safeHashEqual(
  a: string | null | undefined,
  b: string,
): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * PKCE S256 verification: base64url(sha256(verifier)) must equal the challenge
 * registered at session creation. "plain" is never accepted - allowing it would
 * make the authorization code sufficient on its own and undo the whole point of
 * PKCE on a loopback redirect.
 */
export function verifyPkceS256(
  codeVerifier: string,
  codeChallenge: string,
): boolean {
  const derived = createHash('sha256')
    .update(codeVerifier, 'ascii')
    .digest('base64url');
  if (derived.length !== codeChallenge.length) return false;
  return timingSafeEqual(
    Buffer.from(derived, 'utf8'),
    Buffer.from(codeChallenge, 'utf8'),
  );
}

/**
 * Ambiguity-free alphabet: 0/1/I/L/O/U removed. The first five because they are
 * unreadable in most terminal fonts, U because it turns otherwise innocent
 * 8-character codes into words nobody wants read aloud over a call.
 */
export const USER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const USER_CODE_LENGTH = 8;

/** Formatted XXXX-XXXX. 30^8 is roughly 6.6e11 for a code that lives 10 minutes. */
export function generateUserCode(): string {
  let raw = '';
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
    raw += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * Accepts what a human actually types: lower case, missing dash, stray spaces.
 * Returns the canonical XXXX-XXXX form, or null when the input cannot be one -
 * callers turn null into the same 404 an unknown code gets, so "malformed" and
 * "wrong" are indistinguishable from outside.
 */
export function normalizeUserCode(value: string): string | null {
  const stripped = (value ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[^A-Z0-9]/g, '');
  if (stripped.length !== USER_CODE_LENGTH) return null;
  for (const char of stripped) {
    if (!USER_CODE_ALPHABET.includes(char)) return null;
  }
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}
