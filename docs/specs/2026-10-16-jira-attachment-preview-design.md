# Jira – náhled přílohy (userscript) – návrh

Datum: 2026-10-16 · Autor: Lukáš Sedláček

## Cíl

Na issue v IndSoft Jira (`jira.indsoft.local`) v Jiře Unicorn (`jira.unicorn.com`) a v Jiře ČEPS (`jira-dc.ceps.cz`) přidat ke podporované příloze tlačítko **Náhled**. Náhled otevře nový panel prohlížeče a soubor v něm zobrazí. Panel má vlastní adresu s názvem souboru, takže jde obnovit (F5) i poslat dál a po nahrání nové verze ukáže novou verzi. Otevřený panel si novou verzi načte sám. Z HTML přílohy se tak dá udělat dashboard, který se aktualizuje nahráním souboru. Klik na název přílohy dál stahuje soubor jako dnes.

První ověření je HTML dashboard na [IDSM-6362](http://jira.indsoft.local/browse/IDSM-6362): grafy se vykreslí (stránka používá vložený JavaScript a D3 z CDN).

## Rozsah

- Nový soubor `jira-attachment-preview.user.js`. Žádný doprovodný shim.
- Hostitel: `*://jira.indsoft.local/*`, `https://jira.unicorn.com/*` a `https://jira-dc.ceps.cz/*` (stejné DOM modulu příloh i REST; ČEPS posílá jen CSP `frame-ancestors 'self'`). Tlačítko vznikne jen u odkazů na přílohy v modulu Attachments na issue (náhledy i seznam).
- Mimo rozsah: další instance Jiry, mazání a nahrávání příloh, změna popisu issue, náhled v komentářích a v activity streamu.

## Ovládání

- U každé podporované přílohy je tlačítko s ikonou oka, přístupné z klávesnice, viditelné bez najetí myší. Je to odkaz (`<a target="_blank">`), takže funguje i prostřední tlačítko myši.
- Přístupný název i tooltip: `Náhled: <název souboru>`.
- V zobrazení náhledů (`#attachment_thumbnails`) leží oko jako overlay v pravém horním rohu dlaždice: tlačítko 44 px, ikona 32 px, světlé kulaté pozadí se stínem. V seznamu je malé oko (16 px) hned za odkazem na soubor. Odkaz, datum, velikost ani koš se nemění.
- Nepodporovaný typ tlačítko nemá.
- Jira modul příloh překresluje. Pozorovatel DOM tlačítka doplní znovu a u jedné přílohy je vždy jen jedno.

## Tok náhledu

1. Oko otevře v novém panelu adresu `/browse/<KLÍČ>?viewAttachment=<název souboru>` (klíč z `meta[name="ajs-issue-key"]`, `#key-val` nebo z cesty; bez klíče oko není). Název, ne id: nová verze souboru má v Jiře nové id, adresa ale platí dál. Skript běží od `document-start`. Když v adrese najde `viewAttachment`, vymění kořenový `<html>` dokumentu za vlastní prázdnou obálku. Parser Jiry pak doběhne do odpojeného starého stromu: skripty mimo dokument se nespustí a stylesheety nic neblokují. `window.stop()` se nepoužívá: přeruší parser před `<body>` a Chrome pak panel nikdy nevykreslí (ověřeno na IDSM-6362). Tampermonkey skript spustí až po prvních skriptech v hlavičce Jiry. Události `readystatechange`, `DOMContentLoaded`, `load` a `popstate` proto skript zastaví na `window` dřív, než se dostanou k handlerům Jiry, a uzly, které do `<html>`, `<head>` nebo `<body>` vloží někdo jiný, hned odstraní. Obnovení panelu celý postup zopakuje.
2. Prázdný `viewAttachment` (nebo delší než 255 znaků) znamená běžné issue. Název z adresy se jen porovnává se seznamem příloh, do žádného požadavku se nedostane.
3. Příloha: `GET /rest/api/2/issue/<KLÍČ>?fields=attachment`, z ní nejnovější příloha s přesně tímto názvem (nejvyšší id; Jira nechává každé nahrání jako samostatnou přílohu). Obsah: `GET /secure/attachment/<id>/<název>`, cestu skládá skript z id a názvu z odpovědi Jiry. Obojí `fetch` na stejný origin s cookies stránky (`credentials: "same-origin"`).
4. Limit je 10 MiB (`10 * 1024 * 1024`). Rozhoduje `size` z REST, pak `Content-Length`, a když chybí, velikost stažených bajtů. Nad limitem se obsah nezobrazí; v panelu je věta „Příloha je větší než 10 MB, náhled se neotevře.“
5. Selhání sítě nebo odpověď mimo 2xx: panel zůstane otevřený s větou „Přílohu se nepodařilo načíst.“ Issue nemá přílohu s tímto názvem: „Příloha s tímto názvem na issue není.“ Nepodporovaný typ (např. ručně zadaná adresa se zipem): „Tento typ přílohy náhled nemá.“
6. Titulek panelu je název souboru.
7. Text se dekóduje podle `charset` v `Content-Type`. Když charset chybí, použije se UTF-8.
8. Aktualizace: když je panel viditelný, skript každých 30 s a hned po zviditelnění panelu znovu zjistí nejnovější přílohu s tím názvem. Má-li jiné id, obsah se načte a vykreslí znovu bez obnovení panelu. Beze změny se nic nepřekresluje. Když příloha zmizí (smazaná, nová ještě nenahraná), panel nechá poslední obsah a hledá dál. Chyba kontroly se jen zapíše do konzole.
9. Zpět: nový panel nemá historii, proto skript před náhled vloží záznam s adresou issue (`replaceState` na adresu bez `viewAttachment`, `pushState` zpět na náhled), jen když `history.length` je 1. Back i Forward mezi issue a náhledem může Chrome provést jen změnou adresy v témže dokumentu (`popstate`); skript pak stránku načte znovu pro to, co adresa chce, v režimu náhledu i na běžném issue.

## Druhy souborů

Rozhoduje přípona (poslední suffix, bez ohledu na velikost písmen). Když přípona není v seznamu, rozhoduje MIME bez parametrů (`text/plain; charset=UTF-8` → `text/plain`). Známá přípona má přednost, protože Jira označuje JSON jako `text/plain` a SQL jako `application/x-sql`.

| Režim | Přípony | MIME, když přípona neřekne |
| --- | --- | --- |
| HTML | `html`, `htm` | `text/html` |
| Text | `txt`, `log`, `csv`, `tsv`, `sql`, `xml`, `json`, `jsonl`, `ndjson`, `md`, `markdown`, `yml`, `yaml`, `ini`, `conf`, `properties`, `css`, `js`, `mjs`, `cjs`, `ts`, `sh`, `ps1`, `bat`, `py`, `java`, `cs`, `diff`, `patch`, `toml`, `jsonata` | `text/plain`, `text/csv`, `text/xml`, `text/markdown`, `text/css`, `text/javascript`, `application/json`, `application/xml`, `application/javascript`, `application/x-sql`, `text/x-sql` |
| Obrázek | `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `bmp`, `ico` | `image/*` |
| PDF | `pdf` | `application/pdf` |

Jinak se náhled nenabídne (zip, docx, xlsx, bin, `application/octet-stream` bez známé přípony).

### HTML

Obsah běží v izolovaném `iframe` v novém panelu, ne jako dokument horní úrovně.

- Atribut `sandbox`: `allow-scripts allow-popups allow-forms allow-modals allow-downloads`.
- `allow-same-origin` ani `allow-top-navigation` v atributu nejsou. Skripty tedy běží (vložený kód i D3 a fonty z absolutních adres), ale dokument má vlastní neprůhledný původ a nedosáhne na DOM ani cookies Jiry.
- Rám má `color-scheme: light dark`, takže `prefers-color-scheme` uvnitř odpovídá tématu systému.
- HTML se do rámu předá vlastností `iframe.srcdoc`. Nesmí se složit jako text do HTML obálky.
- Rám `srcdoc` dědí CSP stránky. Jira Unicorn posílá `script-src 'unsafe-eval' 'unsafe-inline' jira.unicorn.com 'self'`, takže skript z CDN by v rámu neběžel (ověřeno na AFLEX-3853). Skript proto před vložením HTML rozebere (`DOMParser`, nic se nespustí), každý `<script src>` s adresou http(s) stáhne (`fetch` bez cookies) a vloží jako inline skript; `integrity`, `crossorigin` a `async` odpadnou, `defer` skripty se přesunou na konec `<body>`. Skript, který se stáhnout nepodaří, zůstane s `src`. Styly, fonty a obrázky CSP Unicornu neomezuje.
- Horní panel se nesmí navigovat na blob URL přílohy. Taková adresa by zdědila původ Jiry a skripty by běžely s jejím přihlášením.
- Obálku panelu skládá skript z DOM. Jediný rám vyplní okno. Obálka má původ Jiry, ale obsahuje jen DOM skriptu; skripty stránky issue se nespustí, protože je parser vkládá do odpojeného stromu.
- Hotovo je až tehdy, když náhled dashboardu z IDSM-6362 grafy opravdu vykreslí. Když je v tom zabrání CSP Jiry, způsob vložení se upraví dřív, než se doplněk označí za funkční.

### Text

Nový panel obsahuje vlastní stránku a `<pre>`, kam se text vloží jako textový uzel. Obsah se nevyhodnocuje jako HTML.

Soubor `.json` a MIME `application/json` se zkusí naformátovat (`JSON.parse` a `JSON.stringify` s odsazením 2). Když to není platný JSON, ukáže se surový text. `jsonl` a `ndjson` zůstávají surové.

### Obrázky a PDF

- Rastrové obrázky a SVG jsou v obálce v `<img>`. SVG se neotevírá jako dokument, takže jeho skripty neběží.
- PDF: obálka má rám (bez `sandbox`, jinak by se prohlížeč PDF nespustil) s blob URL typu `application/pdf` a soubor ukáže vestavěný prohlížeč PDF. Panel si tak nechá svou adresu a jde obnovit.

## Rozhraní čisté logiky

Skript jde načíst z Node jako modul (stejný vzor jako `bookkit-file-manager.user.js`: při `module.exports` se nepouští prohlížečová část). Testy importují:

- `classifyAttachment({ filename, mimeType })` → `"html"` | `"text"` | `"image"` | `"pdf"` | `null`
- `isWithinPreviewLimit(byteLength)` → boolean, hranice 10 MiB včetně
- `sandboxAttribute()` → přesně `allow-scripts allow-popups allow-forms allow-modals allow-downloads`
- `formatJsonPreview(text)` → naformátovaný JSON, nebo původní text při neplatném JSON
- `previewAttachmentName(search)` → název souboru z `?viewAttachment=`, jinak `""`
- `issueKeyFromPath(pathname)` → klíč z `/browse/<KLÍČ>`, jinak `""`
- `previewPageUrl({ origin, issueKey, filename })` → adresa panelu náhledu, bez klíče `""`
- `latestAttachmentByName(attachments, filename)` → nejnovější příloha s tímto názvem, nebo `null`
- `issuePageUrl(previewHref)` → adresa issue za náhledem (bez `viewAttachment`)
- `attachmentContentPath(id, filename)` → `/secure/attachment/<id>/<zakódovaný název>`

## Ověření

Node: `node --test test/jira-attachment-preview.test.js` pokrývá tabulku druhů (včetně `.json` + `text/plain` a `.html` + `application/x-sql`), hranici 10 MiB, zákaz `allow-same-origin`, formátování JSON, parametr `viewAttachment` a výběr nejnovější přílohy podle názvu.

Chrome (puppeteer-core): `npm run test-jira-attachment-preview` ve složce `test` pustí falešnou stránku issue, REST a přílohy na lokálním serveru a skript vloží až po prvním skriptu hlavičky, jako to dělá Tampermonkey. Ověří umístění a velikost oka, překreslení modulu, otevření panelu kliknutím, Back a Forward, všechny druhy náhledu, vykreslení, obnovení panelu, novou verzi přílohy, smazání, limity a chybové věty.

Prohlížeč, přihlášená IndSoft Jira, issue IDSM-6362:

- U obou HTML dashboardů je Náhled; klik na název soubor stáhne.
- Náhled novějšího dashboardu ukáže vykreslené grafy (D3).
- `06-ts-list-incident.json` je v novém panelu čitelný text.
- Panel náhledu se opravdu vykreslí (screenshot projde, `requestAnimationFrame` proběhne), nejen že obsah je v DOM.
- `07-manual-test-output-excerpt.txt` a jeden `.sql` jsou text v `<pre>`.
- `screenshot-1.png` je obrázek.
- Po chybě načtení zůstane v novém panelu chybová věta a odkaz na stažení na issue dál funguje.
- F5 v panelu náhledu ukáže tentýž náhled znovu.
- Back v novém panelu vrátí issue, Forward zase náhled.
- Po nahrání nové verze dashboardu se otevřený panel do 30 s sám aktualizuje.

## Dokumentace

- `@version 1.2.0`
- Nová sekce nahoře v `changelogs.md`
- Řádek v tabulce Installation v `README.md` a krátká věta v Notes
