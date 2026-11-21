# nas-storage

Jednoduché domácí úložiště: přihlašovací stránka, výpis složek, nahrávání (i drag & drop), stahování, mazání, vytvoření složky. Jediná závislost je `express`, hash hesla je nativní `crypto.scrypt`.

## Rychlý start (lokálně)

```bash
npm install
npm run hash -- "mojeHeslo"      # vypíše APP_PASSWORD_HASH a SESSION_SECRET
cp .env.example .env             # vlož vygenerované hodnoty
npm run dev                      # http://localhost:3000
```

## Nasazení na NAS (Docker)

1. Nahraj repozitář na GitHub (`.env` je v `.gitignore`).
2. Na NASu `git clone`, vytvoř `.env` (viz `.env.example`), nastav `STORAGE_PATH` na složku s daty.
3. `docker compose up -d --build`

Složka `STORAGE_PATH` musí být zapisovatelná pro uid 1000 (uživatel `node` v kontejneru).

## ENV

| Proměnná | Význam |
|---|---|
| `APP_USER` | přihlašovací jméno |
| `APP_PASSWORD_HASH` | `salt:hash` ze `scripts/hash.js` (bez `$`, aby ho compose neinterpoloval) |
| `SESSION_SECRET` | tajný klíč pro podpis cookie (min. 32 B hex) |
| `STORAGE_DIR` | kořen úložiště (v kontejneru `/data`) |
| `STORAGE_PATH` | cesta na hostu pro compose volume |
| `MAX_UPLOAD_MB` | limit jednoho souboru, default 2048 |
| `COOKIE_SECURE` | `true` za HTTPS |
| `TRUST_PROXY` | `true` za reverse proxy (správná IP pro rate limit) |

Bez `APP_USER`, `APP_PASSWORD_HASH` nebo `SESSION_SECRET` aplikace okamžitě skončí.

## Bezpečnost

- Na internet jen přes HTTPS reverse proxy (Caddy, Nginx Proxy Manager) s `COOKIE_SECURE=true` a `TRUST_PROXY=true`, ideálně jen přes VPN.
- Login: max. 5 pokusů na IP za 15 min (v paměti, po restartu se nuluje).
- Cesty jsou omezené na `STORAGE_DIR` (ochrana proti path traversal), symlinky se ve výpisu ignorují.
- Upload nepřepisuje existující soubory (409).

## API

| Metoda | Cesta | Popis |
|---|---|---|
| POST | `/api/login` | `{user, password}` → nastaví cookie |
| POST | `/api/logout` | smaže cookie |
| GET | `/api/files?path=` | výpis složky |
| GET | `/api/download?path=` | stažení souboru |
| PUT | `/api/upload?path=&name=` | upload, tělo = obsah souboru |
| POST | `/api/mkdir` | `{path, name}` |
| POST | `/api/move` | `{from, to}` presun nebo prejmenovani (409 pokud cil existuje) |
| DELETE | `/api/files?path=` | smazání souboru/složky |
| GET | `/api/health` | healthcheck |
