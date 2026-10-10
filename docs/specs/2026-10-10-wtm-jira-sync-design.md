# WTM ← Jira sync (userscript) – návrh

Datum: 2026-10-10 · Autor: Lukáš Sedláček (s Claude)

## Cíl

Na stránce WTM „Výkazy za měsíc“ (`uu-specialistwtm-maing01/…/workerMonthlyDetail`) jednosměrně dorovnat
WTM podle worklogů v Jiře (`jira.indsoft.local`). Jira je zdroj pravdy. ManicTime ani jiný tooling se nepoužívá.

## Rozsah

- Jeden soubor `wtm-jira-sync.user.js` (jen `.user.js`, bez shimu – viz `agent.md`).
- Zobrazený měsíc na stránce `workerMonthlyDetail`.
- Jen vlastní worklogy přihlášeného uživatele Jiry a vlastní položky WTM.
- Mimo rozsah: mazání ve WTM, zápis do Jiry, jiné instance Jiry, ManicTime.

## Architektura a tok dat

1. **WTM data** – skript běží `@run-at document-start` a zachytí odpověď příkazu
   `listWorkerTimesheetItemsByMonth` (POST, dtoIn `{yearMonth:"YYYYMM"}`), kterou si stránka načítá sama
   (zachycení XHR/fetch). Z `timesheetItemList` bere `id, datetimeFrom, datetimeTo, category, description,
   subject, subjectName, state`.
2. **Jira data** – přes `GM_xmlhttpRequest` (`@connect jira.indsoft.local`) s cookies prohlížeče:
   - `GET /rest/api/2/myself`
   - `GET /rest/api/2/search?jql=worklogAuthor = currentUser() AND worklogDate >= "<první den>" AND worklogDate <= "<poslední den>"&fields=summary,labels`
   - `GET /rest/api/2/issue/{key}/worklog` → filtr na autora a den v rozsahu měsíce (Europe/Prague).
3. **Párování** (čistá funkce) – viz Stavy.
4. **Vykreslení** – doplnění značek a virtuálních řádků do DOM výpisu dne; `MutationObserver` při
   překreslení (React) doplní znovu.
5. **Page agent** – malý kód vložený do stránky jako inline `<script>` (CSP stránky je jen
   `frame-ancestors 'self'`, inline skript povolen). Běží ve světě stránky, zachytává XHR/fetch
   (odpověď měsíce + hlavičku `Authorization` volání WTM) a na pokyn userscriptu volá
   `createTimesheetItem` / `updateTimesheetItem` (POST `<BASE_URI>/<cmd>`) se zachyceným tokenem.
   Komunikace s userscriptem (sandbox Tampermonkey) přes `window.postMessage`. Důvod: v Tampermonkey MV3
   není jisté, že `unsafeWindow` dovolí patchovat prototypy stránky. Po zápisu userscript stránku znovu
   načte (`location.reload()`), stránka si měsíc načte sama a agent ho zachytí.
6. **Nastavení** (úložiště Tampermonkey, `GM_getValue/GM_setValue`):
   - tabulka **label → artefakt** (URL `subject` artefaktu v uuBusinessTerritory); při prvním spuštění
     předvyplněná z položek WTM (subjectName začínající `W_` → subject), uživatel ji upravuje;
   - base URL Jiry (výchozí `http://jira.indsoft.local`).

### dtoIn WTM (z frontendu `public/3.7.9/index.js`)

```
createTimesheetItem: { datetimeFrom, datetimeTo, subject, category, description, highRate }
updateTimesheetItem: { id, datetimeFrom, datetimeTo, subject, category, description, highRate }
```
`datetimeFrom/To` jsou ISO UTC (`2026-10-09T05:45:00.000Z`), `subject` je URL artefaktu
`…/uu-businessterritory-maing01/<awid>/artifactInfo?id=<id>`.

### Mapování worklog → položka WTM

- `category` = klíč ticketu
- `description` = `<KLÍČ> <komentář worklogu>` (prázdný komentář → jen klíč)
- `datetimeFrom` = `started` worklogu, `datetimeTo` = `started + timeSpentSeconds`
- `subject` = artefakt z tabulky podle W_ labelu ticketu (první label `W_*`)
- `highRate` = false

## Stavy

Párování za den (Europe/Prague):

1. **OK** – shodný den, ticket, začátek i délka (a popis).
2. **Liší se** – zbylé worklogy a položky se stejným dnem a ticketem se spárují podle pořadí začátku;
   liší se začátek, délka nebo popis.
3. **Chybí ve WTM** – worklog bez položky.
4. **Není v Jiře** – položka WTM bez worklogu.

| Stav | Zobrazení | Akce |
|---|---|---|
| OK | zelený štítek s ID ticketu (odkaz do Jiry) | – |
| Liší se | oranžový štítek + „Jira: 13:15–14:00 · 45 min“ | **Upravit podle Jiry** |
| Chybí ve WTM | virtuální řádek (šrafovaný okraj) na pozici podle času: čas, délka, ticket, komentář, artefakt | **Zapsat do WTM** |
| Není v Jiře | červený štítek „není v Jiře“ | – (mazání ručně košem WTM) |

- Hlavička dne: souhrn „Jira 10:45 · WTM 10:00 · 2 chybí · 1 liší se“ + **Zapsat vše** (create + update za den).
- Potvrzené položky (`state !== "active"`) jsou jen značené, bez akcí.
- Neznámý artefakt (bez W_ labelu / label není v tabulce) → u virtuálního řádku výběr ze známých artefaktů;
  zápis až po výběru.
- Předkontroly pravidel WTM (akce zablokovaná s důvodem): překryv s jinou položkou, starší než 7 dní,
  mimo aktuální/předchozí měsíc.
- Plovoucí ikona skriptu vpravo nahoře: stav Jiry, souhrn měsíce, Obnovit, Nastavení.
- Den, který má worklogy v Jiře, ale ve WTM žádnou položku (WTM ho nevypíše), se zobrazí jako
  virtuální blok dne na správném místě v seznamu.

## Chyby

- Jira 401 / síť → ikona červeně „Přihlásit do Jiry“ (odkaz), žádné značky, žádný zápis.
- Nezachycená odpověď WTM → hláška v panelu, nic se nevykreslí (žádné hádání z DOM).
- Chyba zápisu → hláška u řádku; „Zapsat vše“ pokračuje a na konci shrne; bez automatického opakování.
- Ochrana proti dvojímu zápisu: tlačítka zamčená během zápisu, další akce až po novém načtení měsíce.

## Testování

- Node testy v `test/` (vzor stávajících `*.test.js`) pro čistou logiku: párování, převod worklog → dtoIn
  (časová zóna, letní/zimní čas), výběr artefaktu, předkontroly pravidel WTM.
- Ruční test přes browser bridge (`tools/browser-bridge-*.mjs`) ve skutečném Chrome: říjen 2026, týden
  5.–9. 10. musí být celý OK (data teď přesně sedí); jeden virtuální řádek na testovacím worklogu;
  české i anglické popisky. Zápis naostro jen s výslovným svolením uživatele.
