// Zamky souboru a slozek, kazdy s vlastnim heslem.
// - Zamcene cesty a hashe jejich hesel (scrypt) jsou trvale ulozene v souboru v uloziste,
//   zamek plati i pro vse uvnitr zamcene slozky.
// - Odemknuti plati jen v ramci relace (v pameti serveru) a zanika odhlasenim nebo vyprsenim relace.
// Klice jsou relativni cesty s '/', normalizovane (NFC, mala pisme), aby zamek neslo obejit jinou velikosti pisma.
const fs = require('fs');
const fsp = fs.promises;
const { scryptSync, randomBytes, timingSafeEqual } = require('crypto');

class LockedError extends Error {
  constructor(message = 'Item is locked') { super(message); this.status = 423; }
}

const norm = (rel) => String(rel ?? '').split('\\').join('/').replace(/^\/+|\/+$/g, '').normalize('NFC').toLowerCase();
const covers = (key, rel) => rel === key || rel.startsWith(key + '/'); // klic je predek nebo shodny s cestou

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const given = scryptSync(String(password ?? ''), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

class LockStore {
  constructor(file) {
    this.file = file;
    this.entries = new Map(); // klic -> "salt:hash" hesla
    this.sessions = new Map(); // sid -> { open: Set<klic>, seen: ms }
    this.writing = Promise.resolve();
  }

  // pri poskozenem souboru se nespusti (zamky se nesmi tise ztratit)
  load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new Error(`Cannot read locks file ${this.file}: ${err.message}`);
    }
    let data;
    try { data = JSON.parse(raw); } catch (err) {
      throw new Error(`Invalid locks file ${this.file}: ${err.message}`);
    }
    const locks = data && data.locks;
    if (!locks || typeof locks !== 'object' || Array.isArray(locks)) {
      throw new Error(`Unsupported locks file format ${this.file}: expected { "locks": { "<path>": "<salt:hash>" } }`);
    }
    for (const [key, stored] of Object.entries(locks)) {
      if (typeof stored !== 'string' || !/^[0-9a-f]+:[0-9a-f]+$/.test(stored)) {
        throw new Error(`Invalid lock entry "${key}" in ${this.file}`);
      }
      const k = norm(key);
      if (k) this.entries.set(k, stored);
    }
  }

  save() {
    const body = JSON.stringify({ locks: Object.fromEntries([...this.entries].sort(([a], [b]) => a.localeCompare(b))) }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.writing = this.writing.then(async () => {
      await fsp.writeFile(tmp, body, 'utf8');
      await fsp.rename(tmp, this.file);
    });
    return this.writing;
  }

  // --- relace ---
  session(sid) {
    let s = this.sessions.get(sid);
    if (!s) { s = { open: new Set(), seen: Date.now() }; this.sessions.set(sid, s); }
    s.seen = Date.now();
    return s;
  }
  dropSession(sid) { this.sessions.delete(sid); }
  prune(maxAgeMs) {
    const limit = Date.now() - maxAgeMs;
    for (const [sid, s] of this.sessions) if (s.seen < limit) this.sessions.delete(sid);
  }

  // --- dotazy ---
  has(rel) { return this.entries.has(norm(rel)); }
  covering(rel) { const r = norm(rel); return [...this.entries.keys()].filter((k) => covers(k, r)); } // predkove (i shodny)
  below(rel) { const r = norm(rel); return [...this.entries.keys()].filter((k) => k !== r && covers(r, k)); } // potomci

  verify(rel, password) { // heslo zamku prave teto polozky
    const stored = this.entries.get(norm(rel));
    return !!stored && checkPassword(password, stored);
  }

  isOpen(sid, rel) { // je cesta pristupna (vsechny zamky nad ni odemcene)?
    const open = this.session(sid).open;
    return this.covering(rel).every((k) => open.has(k));
  }
  assertOpen(sid, rel) { if (!this.isOpen(sid, rel)) throw new LockedError(); }

  // pro mazani a presun: musi byt odemcene i zamky uvnitr (jinak by se zamcena data zrusila/presunula)
  assertRelatedOpen(sid, rel) {
    const open = this.session(sid).open;
    const all = [...this.covering(rel), ...this.below(rel)];
    if (!all.every((k) => open.has(k))) throw new LockedError();
  }

  // zruseni zamku koreni rel: musi byt odemcene vsechny zamky nad nim (sam zamek ne, ten rusi heslo)
  assertParentsOpen(sid, rel) {
    const r = norm(rel);
    const open = this.session(sid).open;
    if (!this.covering(r).filter((k) => k !== r).every((k) => open.has(k))) throw new LockedError();
  }

  info(sid, rel) { // pro vypis: null = bez zamku, jinak { root, unlocked }
    const cov = this.covering(rel);
    if (!cov.length) return null;
    const open = this.session(sid).open;
    return { root: this.has(rel), unlocked: cov.every((k) => open.has(k)) };
  }

  // --- zmeny ---
  async add(rel, password) {
    const r = norm(rel);
    if (!r) throw Object.assign(new Error('Cannot lock root'), { status: 400 });
    // bez omezeni delky a znaku, jen nesmi byt prazdne (velikost tela omezuje parser JSON)
    if (typeof password !== 'string' || password.length === 0) {
      throw Object.assign(new Error('Password required'), { status: 400 });
    }
    if (this.covering(r).length) throw Object.assign(new Error('Already locked'), { status: 409 });
    this.entries.set(r, hashPassword(password));
    await this.save();
  }

  unlock(sid, rel) { this.session(sid).open.add(norm(rel)); }
  relock(sid, rel) { this.session(sid).open.delete(norm(rel)); }

  async remove(rel) { // zruseni zamku natrvalo
    const r = norm(rel);
    this.entries.delete(r);
    for (const s of this.sessions.values()) s.open.delete(r);
    await this.save();
  }

  async rewrite(from, to) { // presun/prejmenovani: zamky (i hesla) se presunou spolu s polozkou
    const f = norm(from), t = norm(to);
    const swap = (k) => (covers(f, k) ? t + k.slice(f.length) : k);
    const changed = [...this.entries.keys()].some((k) => covers(f, k));
    this.entries = new Map([...this.entries].map(([k, v]) => [swap(k), v]));
    for (const s of this.sessions.values()) s.open = new Set([...s.open].map(swap));
    if (changed) await this.save();
  }

  async removeUnder(rel) { // smazani polozky: zamky uvnitr zanikaji
    const r = norm(rel);
    const gone = [...this.entries.keys()].filter((k) => covers(r, k));
    if (!gone.length) return;
    for (const k of gone) this.entries.delete(k);
    for (const s of this.sessions.values()) for (const k of gone) s.open.delete(k);
    await this.save();
  }
}

module.exports = { LockStore, LockedError, norm };
