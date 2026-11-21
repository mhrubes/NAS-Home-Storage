// Overeni prihlaseni: scrypt hash z ENV + stateless podepsany cookie token (obsahuje id relace).
const { scryptSync, timingSafeEqual, createHmac, randomBytes } = require('crypto');

const [salt, hash] = (process.env.APP_PASSWORD_HASH || '').split(':');
const secret = process.env.SESSION_SECRET;

if (!process.env.APP_USER || !salt || !hash || !secret) {
  console.error('Chybi APP_USER, APP_PASSWORD_HASH (salt:hash) nebo SESSION_SECRET v .env');
  process.exit(1); // fail-fast, zadny fallback
}

const hashBuf = Buffer.from(hash, 'hex');
const userBuf = Buffer.from(process.env.APP_USER);

function safeEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkLogin(user, password) {
  const passOk = safeEqual(scryptSync(String(password ?? ''), salt, hashBuf.length), hashBuf);
  const userOk = safeEqual(Buffer.from(String(user ?? '')), userBuf);
  return passOk && userOk;
}

const sign = (payload) => createHmac('sha256', secret).update(payload).digest('hex');

// token = <expirace>.<id relace>.<hmac>
function signToken(ttlMs, sid = randomBytes(12).toString('hex')) {
  const payload = `${Date.now() + ttlMs}.${sid}`;
  return `${payload}.${sign(payload)}`;
}

// vrati { exp, sid } u platneho tokenu, jinak null
function parseToken(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [exp, sid, sig] = parts;
  if (!/^\d+$/.test(exp) || !/^[0-9a-f]{24}$/.test(sid) || !(Number(exp) > Date.now())) return null;
  return safeEqual(Buffer.from(sig), Buffer.from(sign(`${exp}.${sid}`))) ? { exp: Number(exp), sid } : null;
}

const verifyToken = (token) => parseToken(token) !== null;
const tokenExpiry = (token) => parseToken(token)?.exp ?? 0;

module.exports = { checkLogin, signToken, parseToken, verifyToken, tokenExpiry };
