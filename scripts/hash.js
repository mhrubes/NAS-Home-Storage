// Vygeneruje APP_PASSWORD_HASH pro .env. Pouziti: npm run hash -- "mojeHeslo"
const { scryptSync, randomBytes } = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Pouziti: npm run hash -- "heslo"');
  process.exit(1);
}
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password, salt, 64).toString('hex');
console.log(`APP_PASSWORD_HASH=${salt}:${hash}`);
console.log(`SESSION_SECRET=${randomBytes(32).toString('hex')}`);
