// What Sentry is told about the request behind an error. @sentry/node attaches
// the incoming request to every event it sends: the body (the raw JSON text,
// up to 10 KB), the cookies, the headers and the query string. Left alone, a
// crash during sign-up, sign-in, a password reset or a 2FA check would send
// the password or code with it, and every crash would carry the accessToken
// and refreshToken cookies. This blanks those values and keeps the rest, so a
// report still shows which fields came in.

export const FILTERED = '[Filtered]';

// Names are compared lowercased with everything but letters and digits
// removed, so newPassword, new_password and NEW-PASSWORD all match.
const SENSITIVE_NAMES = new Set([
  'code', 'otp', 'totp', 'pin', 'cvv', 'cvc', 'refresh', 'auth', 'credential', 'credentials',
]);
const SENSITIVE_PARTS = [
  'password', 'passwd', 'passcode', 'secret', 'token', 'apikey', 'privatekey', 'jwt',
  'cookie', 'authorization', 'session',
];
// One-time codes under longer names (otp_code, backupCodes, verification_code).
// coupon_code, referral_code and zip codes stay.
const SENSITIVE_CODE = /(otp|mfa|2fa|twofactor|verification|verify|backup|recovery|reset|auth)codes?$/;

// Deeper than any body this API takes; past it, the value is dropped.
const MAX_DEPTH = 20;

export function isSensitiveKey(name) {
  const key = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_NAMES.has(key)
    || SENSITIVE_PARTS.some((part) => key.includes(part))
    || SENSITIVE_CODE.test(key);
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Objects and arrays at any depth. A sensitive key loses its whole value,
// object or not. Returns a copy, so nothing the app still holds is changed.
function scrubValue(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return FILTERED;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? FILTERED : scrubValue(item, depth + 1);
  }
  return out;
}

// "name": in JSON, name="..." in a multipart form, name= in a URL-encoded one.
const FIELD_NAME = /"((?:[^"\\]|\\.){1,200})"\s*:|\bname="([^"]{1,200})"|(?:^|&)([^=&\s]{1,200})=/g;

// The body as Sentry captured it. JSON text is redacted field by field and
// stays text. Anything else (JSON cut off at Sentry's size limit, a file
// upload) can't be, so it's dropped whole if any field name in it is sensitive.
function scrubBodyText(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? JSON.stringify(scrubValue(parsed)) : text;
  } catch {
    const names = Array.from(text.matchAll(FIELD_NAME), (m) => m[1] ?? m[2] ?? m[3]);
    return names.some(isSensitiveKey) ? FILTERED : text;
  }
}

function decodeName(raw) {
  try { return decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { return raw; }
}

function scrubQueryString(qs) {
  return qs.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1 || !isSensitiveKey(decodeName(pair.slice(0, eq)))) return pair;
    return `${pair.slice(0, eq)}=${FILTERED}`;
  }).join('&');
}

function scrubUrl(url) {
  const start = url.indexOf('?');
  if (start === -1) return url;
  const hash = url.indexOf('#', start);
  const end = hash === -1 ? url.length : hash;
  return url.slice(0, start + 1) + scrubQueryString(url.slice(start + 1, end)) + url.slice(end);
}

function scrubQuery(query) {
  if (typeof query === 'string') return scrubQueryString(query);
  if (Array.isArray(query)) {
    return query.map((pair) => (Array.isArray(pair) && isSensitiveKey(pair[0]) ? [pair[0], FILTERED] : pair));
  }
  return scrubValue(query);
}

// For Sentry's beforeSend and beforeSendTransaction.
export function scrubSentryEvent(event) {
  const req = event?.request;
  if (!req) return event;
  try {
    if (typeof req.data === 'string') req.data = scrubBodyText(req.data);
    else if (req.data != null) req.data = scrubValue(req.data);
    if (req.headers) req.headers = scrubValue(req.headers);
    if (req.cookies) req.cookies = scrubValue(req.cookies);
    if (req.query_string != null) req.query_string = scrubQuery(req.query_string);
    if (typeof req.url === 'string') req.url = scrubUrl(req.url);
  } catch {
    // A scrubbing bug must not send the raw request: keep only what's safe.
    event.request = { method: req.method, url: typeof req.url === 'string' ? req.url.split('?')[0] : undefined };
  }
  return event;
}
