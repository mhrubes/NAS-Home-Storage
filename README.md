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
| `TRASH_DAYS` | po kolika dnech se smažou položky v koši, default `30`; `0` koš vypne a mazání je trvalé |
| `SESSION_TIMEOUT_MIN` | odhlášení po nečinnosti v minutách, default `10` (platí kladná čísla do 1440, i desetinná) |
| `COOKIE_SECURE` | `true` za HTTPS |
| `TRUST_PROXY` | `true` za reverse proxy (správná IP pro rate limit) |

Bez `APP_USER`, `APP_PASSWORD_HASH` nebo `SESSION_SECRET` aplikace okamžitě skončí.

## Funkce

- **Soubory a složky:** výpis s velikostmi složek (dopočítávají se na pozadí), řazení podle názvu, velikosti a data (klik na záhlaví sloupce, pamatuje se), hledání v názvech (`/` zaostří pole, hledá se i v podsložkách bez ohledu na diakritiku), volné místo na disku v hlavičce.
- **Výběr více položek** (zaškrtávátka): hromadně stáhnout jako ZIP, přesunout (výběr cílové složky), zamknout, smazat. Taháním myší jde přesunout i celý výběr.
- **Stahování:** ikona stažení u souboru; složka nebo výběr se stáhne jako **ZIP** (streamuje se, nenačítá se celý do paměti). ZIP je bez ZIP64, takže je omezen na zhruba 4 GB a 65 000 položek, větší se odmítne předem.
- **Náhled** v prohlížeči po kliknutí na název: obrázky, PDF, video, audio a text (do 512 KB, HTML se zobrazí jako text a nespustí se). Mezi soubory ve složce listuješ šipkami.
- **Nahrávání** souborů i celých složek (tlačítko nebo přetažení) **po částech po 8 MB** s ukazatelem průběhu u každého souboru, možností zrušit a automatickým navázáním po výpadku spojení (i po restartu serveru, stejný soubor se dokončí od místa přerušení). Při shodě názvu se nabídne **přepsat / ponechat obě / přeskočit** (volbu lze použít pro všechny další soubory).
- **Koš:** smazané položky se přesunou do koše (`TRASH_DAYS`, výchozí 30 dní) a jdou obnovit na původní místo, i se zámky. Kdo nechce koš, nastaví `TRASH_DAYS=0` a mazání je pak okamžité a trvalé.
- **Sdílení odkazem:** soubor nebo složka (jako ZIP) se sdílí odkazem `/s/<token>` s platností 1 hodina až 30 dní. Odkaz funguje bez přihlášení, jde zrušit v seznamu sdílených odkazů a **nikdy nefunguje pro zamčené položky**. Přejmenování položky odkaz zachová, smazání ho zruší.
- **Zámky** (viz níže) a automatické **odhlášení při nečinnosti**.

## Verze

Verze aplikace je jen v `package.json` (`"version"`). Zobrazuje se dole uprostřed stránky („NAS Files v1.2.0“, i na přihlašovací obrazovce), vypisuje ji server při startu a vrací ji `GET /api/health`. Zvýšit ji jde bez ruční úpravy souboru:

```sh
npm version patch --no-git-tag-version   # 1.2.0 -> 1.2.1 (minor: nové funkce, major: nekompatibilní změna)
```

Po zvýšení stačí commit, na NASu `git pull` a `docker compose up -d --build`. Podle čísla na stránce poznáš, která verze na NASu opravdu běží.

## Zámky souborů a složek

U každé položky je ikona zámku. Zamčená položka zůstává vidět v seznamu s označením (žlutý zámek), ale nejde ji otevřít, stáhnout, přejmenovat, přesunout ani smazat a nejde do ní nahrávat.

- **Zamknout:** ikona zámku u položky, okno pro **vlastní heslo této položky** (zadává se dvakrát, bez omezení délky a znaků, jen nesmí být prázdné). Každá položka má své heslo. Zámek platí i pro všechny podsložky a soubory uvnitř.
- **Odemknout do odhlášení:** klik na zamčenou položku, zadání jejího hesla. Odemčení platí jen v této relaci (zelený zámek), zaniká odhlášením i vypršením nečinnosti. Jiná relace zůstává zamčená. Odemčenou položku lze **zamknout znovu** (ikona zámku, bez hesla).
- **Zrušit zámek natrvalo:** ikona otevřeného zámku a heslo položky, zámek zmizí úplně (při dalším zamknutí lze zvolit nové heslo).
- Přihlašovací heslo zámek neodemkne. Špatná hesla se omezují na 5 pokusů na IP za 15 minut.
- **Přesun a přejmenování** odemčené položky zámek (i s heslem) přenese s ní. Při smazání do koše se zámek (i s heslem) uschová a po obnovení se vrátí, trvalým smazáním zaniká.
- Složku, která obsahuje zamčenou podsložku, nejde smazat ani přesunout, dokud není ta podsložka odemčená.
- **Zapomenuté heslo nejde obnovit z aplikace.** Správce NASu může zámek odebrat ručně: smazat příslušný řádek v `.nas-locks.json` ve složce úložiště a restartovat kontejner.
- Seznam zámků a hashe hesel (scrypt, s náhodnou solí, nikdy ne heslo samotné) jsou v úložišti v souboru `.nas-locks.json`. Všechny služební položky v úložišti (`.nas-locks.json`, `.nas-shares.json`, `.nas-trash/`, `.nas-uploads/`, obecně cokoli s předponou `.nas-`) jsou ve výpisu skryté a nejde s nimi nijak manipulovat přes aplikaci. Při poškozeném souboru se aplikace nespustí, aby se zámky tiše neztratily. Odemčení v relaci je jen v paměti serveru, po restartu je vše znovu zamčeno.

Zámek chrání proti změnám a otevření přes aplikaci. Soubory ale zůstávají na disku NASu, kdo má přístup k úložišti přímo (SMB, File Station, SSH), je vidí bez omezení. Není to šifrování.
## Bezpečnost

- Na internet jen přes HTTPS reverse proxy (Caddy, Nginx Proxy Manager) s `COOKIE_SECURE=true` a `TRUST_PROXY=true`, ideálně jen přes VPN.
- Login: max. 5 pokusů na IP za 15 min (v paměti, po restartu se nuluje).
- Automatické odhlášení při nečinnosti: po přihlášení se vlevo dole zobrazí kolečko s odpočtem (min:s). Ubývá každou sekundu nečinnosti (i při přepnutí na jinou záložku), pohyb myší, psaní, kliknutí, dotyk, scroll nebo probíhající upload ho vrátí na plnou hodnotu `SESSION_TIMEOUT_MIN`. Posledních 30 s je kolečko žluté, posledních 10 s červené. Po vypršení se stránka odhlásí a zavře rozepsaný dialog. Server relaci při aktivitě obnovuje nejvýš jednou za 10 s (`/api/keepalive`) a drží 15 s rezervu.
- Cesty jsou omezené na `STORAGE_DIR` (ochrana proti path traversal), symlinky se ve výpisu ignorují.
- Upload nepřepisuje existující soubory (409).

## API

| Metoda | Cesta | Popis |
|---|---|---|
| POST | `/api/login` | `{user, password}` → nastaví cookie |
| POST | `/api/logout` | smaže cookie |
| GET | `/api/me` | kontrola relace, vrací `timeoutSec` a `remainingSec` |
| POST | `/api/keepalive` | obnoví relaci při aktivitě uživatele |
| GET | `/api/files?path=` | výpis složky |
| GET | `/api/download?path=` | stažení souboru |
| PUT | `/api/upload?path=&name=` | upload, tělo = obsah souboru |
| POST | `/api/mkdir` | `{path, name, ensure?}` (`ensure`: existující složka není chyba) |
| POST | `/api/move` | `{from, to}` presun nebo prejmenovani (409 pokud cil existuje) |
| POST | `/api/lock` | `{path, password}` zamkne polozku s vlastnim heslem (400 prazdne heslo, 409 kryje ji zamcena slozka) |
| POST | `/api/unlock` | `{path, password}` odemkne do odhlaseni heslem teto polozky (403 spatne heslo, 429 limit pokusu) |
| POST | `/api/relock` | `{path}` znovu zamkne v teto relaci |
| POST | `/api/lock/remove` | `{path, password}` zrusi zamek natrvalo |
| DELETE | `/api/files?path=` | smazání souboru/složky |
| GET | `/api/search?path=&q=` | hledání v názvech od složky dolů (max. 300 výsledků, zamčené neodemčené složky se neprohledávají) |
| GET | `/api/space` | volné a celkové místo na disku |
| GET | `/api/preview?path=` | náhled souboru (inline, podporuje Range) |
| GET | `/api/zip?path=` | složka nebo soubor jako ZIP (`dry=1` jen ověří a vrátí počet souborů a velikost) |
| POST | `/api/zip` | formulář s polem `paths` (JSON pole cest): výběr více položek jako ZIP |
| POST | `/api/upload/init` | `{path, name, size, fp?, onConflict?}` zahájí nahrávání po částech (409 při shodě názvu, `onConflict`: `overwrite` / `rename`); stejný `fp` naváže na přerušené nahrávání |
| GET | `/api/upload/:id` | stav nahrávání (`received`, `size`) |
| PUT | `/api/upload/:id?offset=` | blok dat (offset musí navazovat, jinak 409 s aktuálním `received`) |
| POST | `/api/upload/:id/finish` | dokončí nahrávání a uloží soubor |
| DELETE | `/api/upload/:id` | zruší rozpracované nahrávání |
| DELETE | `/api/files?path=` | smaže položku (do koše, pokud je zapnutý) |
| GET | `/api/trash` | obsah koše |
| POST | `/api/trash/restore` | `{id}` obnoví položku (při kolizi jako „název (1)“) |
| DELETE | `/api/trash/:id`, `/api/trash` | trvale smaže jednu položku, resp. vysype koš |
| POST | `/api/share` | `{path, hours}` vytvoří sdílený odkaz (1 až 720 h, 409 u zamčených) |
| GET | `/api/shares` | aktivní odkazy |
| DELETE | `/api/share/:token` | zruší odkaz |
| GET | `/s/:token`, `/api/s/:token`, `/s/:token/download` | veřejná stránka, informace a stažení sdílené položky (bez přihlášení, 120 požadavků za minutu na IP) |
| GET | `/api/health` | healthcheck, vrací `{ok, version}` |
