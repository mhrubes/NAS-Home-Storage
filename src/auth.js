// Overeni prihlaseni: scrypt hash z ENV + stateless podepsany cookie token.
const { scryptSync, timingSafeEqual, createHmac } = require('crypto');

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

const sign = (exp) => createHmac('sha256', secret).update(String(exp)).digest('hex');

// token = <expirace>.<hmac>
function signToken(ttlMs) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${sign(exp)}`;
}

function verifyToken(token) {
  const [exp, sig] = String(token ?? '').split('.');
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return safeEqual(Buffer.from(sig), Buffer.from(sign(exp)));
}

module.exports = { checkLogin, signToken, verifyToken };
