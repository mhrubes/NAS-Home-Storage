// Kos: smazane polozky se presunou do skryte slozky v uloziste (rename, takze okamzite i u velkych slozek)
// a po TRASH_DAYS dnech se mazou natrvalo. Spolu s polozkou se uchovaji i jeji zamky (a po obnoveni vrati).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { randomBytes } = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;

class Trash {
  // enabledDays = 0 vypne kos (mazani je pak okamzite a trvale)
  constructor(root, enabledDays) {
    this.dir = path.join(root, '.nas-trash');
    this.indexFile = path.join(this.dir, 'index.json');
    this.days = enabledDays;
    this.items = new Map(); // id -> { id, name, rel, dir, deletedAt, size, locks }
    this.writing = Promise.resolve();
  }

  get enabled() { return this.days > 0; }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw;
    try { raw = fs.readFileSync(this.indexFile, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') return;
      throw new Error(`Cannot read trash index ${this.indexFile}: ${err.message}`);
    }
    let data;
    try { data = JSON.parse(raw); } catch (err) { throw new Error(`Invalid trash index ${this.indexFile}: ${err.message}`); }
    for (const it of Array.isArray(data.items) ? data.items : []) {
      if (it && /^[0-9a-z]+$/.test(it.id || '')) this.items.set(it.id, it);
    }
  }

  save() {
    const body = JSON.stringify({ items: [...this.items.values()] }, null, 2);
    const tmp = `${this.indexFile}.${process.pid}.tmp`;
    this.writing = this.writing.then(async () => {
      await fsp.writeFile(tmp, body, 'utf8');
      await fsp.rename(tmp, this.indexFile);
    });
    return this.writing;
  }

  // presune polozku do kose; rel = puvodni relativni cesta, detachedLocks = zamky odpojene od polozky
  async moveIn(full, rel, isDir, detachedLocks) {
    const id = Date.now().toString(36) + randomBytes(4).toString('hex');
    await fsp.rename(full, path.join(this.dir, id));
    const entry = { id, name: path.basename(full), rel, dir: isDir, deletedAt: Date.now(), size: null, locks: detachedLocks || {} };
    this.items.set(id, entry);
    await this.save();
    return entry;
  }

  get(id) { return this.items.get(id) || null; }

  list() { return [...this.items.values()].sort((a, b) => b.deletedAt - a.deletedAt); }

  daysLeft(entry) { return Math.max(0, Math.ceil((entry.deletedAt + this.days * DAY_MS - Date.now()) / DAY_MS)); }

  contentPath(id) { return path.join(this.dir, id); }

  // vrati polozku z kose na cestu target (volajici vyresi kolize a nadrazenou slozku)
  async restoreTo(id, target) {
    const entry = this.items.get(id);
    if (!entry) throw Object.assign(new Error('Not in trash'), { status: 404 });
    await fsp.rename(this.contentPath(id), target);
    this.items.delete(id);
    await this.save();
    return entry;
  }

  async purge(id) {
    if (!this.items.has(id)) throw Object.assign(new Error('Not in trash'), { status: 404 });
    this.items.delete(id);
    await this.save();
    await fsp.rm(this.contentPath(id), { recursive: true, force: true });
  }

  async empty() {
    const ids = [...this.items.keys()];
    this.items.clear();
    await this.save();
    for (const id of ids) await fsp.rm(this.contentPath(id), { recursive: true, force: true });
    return ids.length;
  }

  // smaze polozky starsi nez TRASH_DAYS a sirotky (soubory v kosi bez zaznamu)
  async purgeExpired() {
    if (!this.enabled) return 0;
    const limit = Date.now() - this.days * DAY_MS;
    let n = 0;
    for (const it of [...this.items.values()]) {
      if (it.deletedAt < limit) { await this.purge(it.id); n++; }
    }
    for (const name of await fsp.readdir(this.dir).catch(() => [])) {
      if (name === 'index.json' || name.startsWith('index.json.') || this.items.has(name)) continue;
      await fsp.rm(path.join(this.dir, name), { recursive: true, force: true }); // zbytek po nedokoncene operaci
    }
    return n;
  }

  async setSize(id, size) {
    const it = this.items.get(id);
    if (it) { it.size = size; await this.save(); }
  }
}

module.exports = { Trash };
