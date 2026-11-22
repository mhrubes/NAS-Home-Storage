# Changelog

## 1.2.0

### Nové
- **Koš:** smazané položky se přesunou do koše (`TRASH_DAYS`, výchozí 30 dní), jdou obnovit na původní místo i se zámky, koš jde vysypat. `TRASH_DAYS=0` koš vypne.
- **Stažení složky nebo výběru jako ZIP** (streamovaně, bez ZIP64, limit asi 4 GB) a ikona stažení u souboru.
- **Výběr více položek:** hromadné stažení ZIP, přesun (výběr cílové složky), zamčení a smazání.
- **Řazení** podle názvu, velikosti a data (pamatuje se) a **hledání** v názvech v podsložkách bez ohledu na diakritiku (klávesa `/`).
- **Náhled souborů:** obrázky, PDF, video, audio a text, listování šipkami.
- **Nahrávání po částech** s ukazatelem průběhu, zrušením a navázáním po výpadku (i po restartu serveru), nahrávání celých složek a volba při shodě názvu (přepsat / ponechat obě / přeskočit, i pro všechny).
- **Sdílení odkazem** s platností 1 hodina až 30 dní, seznam a rušení odkazů, veřejná stránka ke stažení, nikdy pro zamčené položky.
- **Volné místo na disku** v hlavičce.

### Změny
- Frontend je rozdělený na `index.html` a `app.js`.
- Služební data v úložišti mají předponu `.nas-` a jsou skrytá (`.nas-locks.json`, `.nas-shares.json`, `.nas-trash/`, `.nas-uploads/`).
- Nové ENV: `TRASH_DAYS`.

## 1.1.0
- Zámky souborů a složek s vlastním heslem, odhlášení při nečinnosti, ikonová tlačítka s tooltipem, verze aplikace v patičce.

## 1.0.0
- První verze: přihlášení (scrypt), výpis, nahrávání, stahování, složky, přejmenování a přesun.
