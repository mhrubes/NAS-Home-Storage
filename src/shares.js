// Sdilene odkazy: nahodny token -> polozka (soubor nebo slozka jako ZIP) s casovou platnosti.
// Odkaz funguje bez prihlaseni, ale jen do vyprseni nebo zruseni a nikdy pro zamcene polozky.
const fs = require('fs');
const fsp = fs.promises;
const { randomBytes } = require('crypto');

const HOUR_MS = 60 * 60 * 1000;
const MAX_HOURS = 24 * 30;
const MAX_SHARES = 200;

const norm = (rel) => String(rel ?? '').split('\\').join('/').replace(/^\/+|\/+$/g, '').normalize('NFC').toLowerCase();
const covers = (key, rel) => rel === key || rel.startsWith(key + '/');

class ShareStore {
  constructor(file) {
    this.file = file;
    this.entries = new Map(); // token -> { token, rel, name, dir, created, expires }
    this.writing = Promise.resolve();
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new Error(`Cannot read shares file ${this.file}: ${err.message}`);
    }
    let data;
    try { data = JSON.parse(raw); } catch (err) { throw new Error(`Invalid shares file ${this.file}: ${err.message}`); }
    for (const e of Array.isArray(data.shares) ? data.shares : []) {
      if (e && typeof e.token === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(e.token) && typeof e.rel === 'string') this.entries.set(e.token, e);
    }
  }

  save() {
    const body = JSON.stringify({ shares: [...this.entries.values()] }, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    this.writing = this.writing.then(async () => {
      await fsp.writeFile(tmp, body, 'utf8');
      await fsp.rename(tmp, this.file);
    });
    return this.writing;
  }

  async create(rel, name, isDir, hours) {
    const h = Number(hours);
    if (!Number.isFinite(h) || h < 1 || h > MAX_HOURS) throw Object.assign(new Error('Invalid share duration'), { status: 400 });
    await this.purgeExpired();
    if (this.entries.size >= MAX_SHARES) throw Object.assign(new Error('Too many shares'), { status: 400 });
    const token = randomBytes(24).toString('base64url'); // 192 bitu, neuhodnutelne
    const now = Date.now();
    const entry = { token, rel, name, dir: isDir, created: now, expires: now + Math.round(h * HOUR_MS) };
    this.entries.set(token, entry);
    await this.save();
    return entry;
  }

  // platny odkaz (nevyprsely), jinak null
  get(token) {
    const e = this.entries.get(String(token));
    return e && e.expires > Date.now() ? e : null;
  }

  list() { return [...this.entries.values()].filter((e) => e.expires > Date.now()).sort((a, b) => b.created - a.created); }

  hasPath(rel) {
    const r = norm(rel);
    for (const e of this.entries.values()) if (e.expires > Date.now() && norm(e.rel) === r) return true;
    return false;
  }

  async revoke(token) {
    if (!this.entries.delete(String(token))) throw Object.assign(new Error('Share not found'), { status: 404 });
    await this.save();
  }

  async purgeExpired() {
    const gone = [...this.entries.values()].filter((e) => e.expires <= Date.now());
    for (const e of gone) this.entries.delete(e.token);
    if (gone.length) await this.save();
    return gone.length;
  }

  async rewrite(from, to) { // presun/prejmenovani polozky: odkazy ji dal sledují
    const f = norm(from);
    let changed = false;
    for (const e of this.entries.values()) {
      const r = norm(e.rel);
      if (covers(f, r)) {
        e.rel = to + e.rel.slice(from.length);
        if (r === f) e.name = to.split('/').pop();
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async removeUnder(rel) { // smazani polozky: jeji odkazy zanikaji
    const r = norm(rel);
    const gone = [...this.entries.values()].filter((e) => covers(r, norm(e.rel)));
    for (const e of gone) this.entries.delete(e.token);
    if (gone.length) await this.save();
  }
}

module.exports = { ShareStore, MAX_HOURS };
