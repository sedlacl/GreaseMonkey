# Jira – náhled přílohy (userscript) – návrh

Datum: 2026-10-16 · Autor: Lukáš Sedláček

## Cíl

Na issue v IndSoft Jira (`jira.indsoft.local`) přidat ke podporované příloze tlačítko **Náhled**. Náhled otevře nový panel prohlížeče a soubor v něm zobrazí. Klik na název přílohy dál stahuje soubor jako dnes.

První ověření je HTML dashboard na [IDSM-6362](http://jira.indsoft.local/browse/IDSM-6362): grafy se vykreslí (stránka používá vložený JavaScript a D3 z CDN).

## Rozsah

- Nový soubor `jira-attachment-preview.user.js`. Žádný doprovodný shim.
- Hostitel: `*://jira.indsoft.local/*`. Tlačítko vznikne jen u odkazů na přílohy v modulu Attachments na issue (náhledy i seznam).
- Mimo rozsah: jiné instance Jiry, mazání a nahrávání příloh, změna popisu issue, náhled v komentářích a v activity streamu.

## Ovládání

- U každé podporované přílohy je tlačítko s ikonou oka, přístupné z klávesnice, viditelné bez najetí myší.
- Přístupný název i tooltip: `Náhled: <název souboru>`.
- Tlačítko je v řádku názvu, hned za odkazem na soubor. Odkaz, datum, velikost ani koš se nemění.
- Nepodporovaný typ tlačítko nemá.
- Jira modul příloh překresluje. Pozorovatel DOM tlačítka doplní znovu a u jedné přílohy je vždy jen jedno.

## Tok náhledu

1. Kliknutí v uživatelském gestu hned otevře `about:blank` v novém panelu (`window.open`). Až potom se příloha stahuje. Když prohlížeč panel zablokuje, skript nic dalšího nedělá a stažení názvem zůstává.
2. `fetch` na stejný origin jako stránka, s cookies stránky (`credentials: "same-origin"`). Cíl musí být `http(s)` a origin `location.origin`. Typická adresa je `/secure/attachment/<id>/<název>`.
3. Limit je 10 MiB (`10 * 1024 * 1024`). Rozhoduje `Content-Length`, a když chybí, velikost stažených bajtů. Nad limitem se obsah nezobrazí; v novém panelu je věta „Příloha je větší než 10 MB, náhled se neotevře.“
4. Selhání sítě nebo odpověď mimo 2xx: panel zůstane otevřený s větou „Přílohu se nepodařilo načíst.“
5. Titulek panelu je název souboru.
6. Text se dekóduje podle `charset` v `Content-Type`. Když charset chybí, použije se UTF-8.

## Druhy souborů

Rozhoduje přípona (poslední suffix, bez ohledu na velikost písmen). Když přípona není v seznamu, rozhoduje MIME bez parametrů (`text/plain; charset=UTF-8` → `text/plain`). Známá přípona má přednost, protože Jira označuje JSON jako `text/plain` a SQL jako `application/x-sql`.

| Režim | Přípony | MIME, když přípona neřekne |
| --- | --- | --- |
| HTML | `html`, `htm` | `text/html` |
| Text | `txt`, `log`, `csv`, `tsv`, `sql`, `xml`, `json`, `jsonl`, `ndjson`, `md`, `markdown`, `yml`, `yaml`, `ini`, `conf`, `properties`, `css`, `js`, `mjs`, `cjs`, `ts`, `sh`, `ps1`, `bat`, `py`, `java`, `cs`, `diff`, `patch`, `toml` | `text/plain`, `text/csv`, `text/xml`, `text/markdown`, `text/css`, `text/javascript`, `application/json`, `application/xml`, `application/javascript`, `application/x-sql`, `text/x-sql` |
| Obrázek | `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`, `ico` | `image/*` |
| PDF | `pdf` | `application/pdf` |

Jinak se náhled nenabídne (zip, docx, xlsx, bin, `application/octet-stream` bez známé přípony).

### HTML

Obsah běží v izolovaném `iframe` v novém panelu, ne jako dokument horní úrovně.

- Atribut `sandbox`: `allow-scripts allow-popups allow-forms allow-modals allow-downloads`.
- `allow-same-origin` ani `allow-top-navigation` v atributu nejsou. Skripty tedy běží (vložený kód i D3 a fonty z absolutních adres), ale dokument má vlastní neprůhledný původ a nedosáhne na DOM ani cookies Jiry.
- HTML se do rámu předá vlastností `iframe.srcdoc`. Nesmí se složit jako text do HTML obálky.
- Horní panel se nesmí navigovat na blob URL přílohy. Taková adresa by zdědila původ Jiry a skripty by běžely s jejím přihlášením.
- Obálku panelu skládá skript z DOM. Jediný rám vyplní okno.
- Hotovo je až tehdy, když náhled dashboardu z IDSM-6362 grafy opravdu vykreslí. Když je v tom zabrání CSP Jiry, způsob vložení se upraví dřív, než se doplněk označí za funkční.

### Text

Nový panel obsahuje vlastní stránku a `<pre>`, kam se text vloží jako textový uzel. Obsah se nevyhodnocuje jako HTML.

Soubor `.json` a MIME `application/json` se zkusí naformátovat (`JSON.parse` a `JSON.stringify` s odsazením 2). Když to není platný JSON, ukáže se surový text. `jsonl` a `ndjson` zůstávají surové.

### Obrázky a PDF

- Rastrové obrázky a SVG jsou v obálce v `<img>`. SVG se neotevírá jako dokument, takže jeho skripty neběží.
- PDF: už otevřený panel přejde na blob URL s typem `application/pdf` a soubor ukáže vestavěný prohlížeč PDF.

## Rozhraní čisté logiky

Skript jde načíst z Node jako modul (stejný vzor jako `bookkit-file-manager.user.js`: při `module.exports` se nepouští prohlížečová část). Testy importují:

- `classifyAttachment({ filename, mimeType })` → `"html"` | `"text"` | `"image"` | `"pdf"` | `null`
- `isWithinPreviewLimit(byteLength)` → boolean, hranice 10 MiB včetně
- `sandboxAttribute()` → přesně `allow-scripts allow-popups allow-forms allow-modals allow-downloads`
- `formatJsonPreview(text)` → naformátovaný JSON, nebo původní text při neplatném JSON

## Ověření

Node: `node --test test/jira-attachment-preview.test.js` pokrývá tabulku druhů (včetně `.json` + `text/plain` a `.html` + `application/x-sql`), hranici 10 MiB, zákaz `allow-same-origin` a formátování JSON.

Prohlížeč, přihlášená IndSoft Jira, issue IDSM-6362:

- U obou HTML dashboardů je Náhled; klik na název soubor stáhne.
- Náhled novějšího dashboardu ukáže vykreslené grafy (D3).
- `06-ts-list-incident.json` je v novém panelu čitelný text.
- `07-manual-test-output-excerpt.txt` a jeden `.sql` jsou text v `<pre>`.
- `screenshot-1.png` je obrázek.
- Po chybě načtení zůstane v novém panelu chybová věta a odkaz na stažení na issue dál funguje.

## Dokumentace

- `@version 1.0.0`
- Nová sekce nahoře v `changelogs.md`
- Řádek v tabulce Installation v `README.md` a krátká věta v Notes
