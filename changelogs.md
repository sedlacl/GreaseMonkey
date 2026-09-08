# Changelogs

Záznamy změn userscriptů v tomto repozitáři. Nejnovější verze je vždy nahoře v sekci skriptu.
Pravidlo: při každém bumpnutí `@version` doplň záznam zde (viz `.cursor/rules/changelogs.mdc`).

---

## bookkit-file-manager.user.js

### 1.4.12 — 2026-09-08

- Rychlejší občasný plný scan: adaptivní `loadPage` pacing 75 ms → 15 ms (dříve 100 ms → 25 ms); success streak (10), pokles o 20 % a failure backoff floor 250 ms / max 2000 ms beze změny. Knihy nad 1000 stránek mají 2 paralelní workery se sdíleným globálním rate gate (max 2 in-flight, starty rozestoupené); malé knihy beze změny.
- Odstraněna persistentní cache výsledků usage scanu — každý stisk „Check attachment usage“ vždy provede čerstvý průchod knihou. In-memory stav po dokončení zůstává pro badge a Select candidates; fail-closed u chyb beze změny.

### 1.4.11 — 2026-09-08

- **Příčina z trace:** `pullCodesFromPattern` synchronně dokončil celý `while (pattern.exec)` v jednom 80k okně — až 57 s blokace hlavního vlákna po `loadPage` (93,8 % CPU v decode/normalize).
- Regex scan je kooperativní: yield mezi dávkami matchů (7 ms / 200 matchů), deduplikace syrových kandidátů před decode, fast path bez `&`/`%`, fail-closed limit 50 000 matchů na stránku.
- UI během scanu zůstává responsivní; při překročení limitu se stránka započte jako selhaná bez cache a kandidátů.

### 1.4.10 — 2026-09-08

- `loadPage` používá adaptivní pacing: začíná na 100 ms, po stabilních sériích úspěchů postupně klesá k 25 ms a po chybě/timeoutu se bezpečně vrací až k 2000 ms.
- Rate controller reaguje na skutečné chyby serverového požadavku bez dodatečné penalizace za pomalou, ale úspěšnou odpověď; cílem je chránit BookKit při zachování concurrency 1 u velkých knih.

### 1.4.9 — 2026-09-08

- Deduplikace zásahů používá interní `Set` index, takže opakované reference nerostou kvadraticky a veřejné pořadí `pathsByCode` zůstává stejné.
- Živý scan zpracovává traversal i regex po kooperativních chunky s macrotask yieldem; během scanu se dlaždice nepřekreslují a po dokončení proběhne finální render.
- Kontrola stavu FileManageru čte text stránky jednou přes `textContent`, bez zbytečného forced layoutu.

### 1.4.8 — 2026-09-08

- **Zasek JS, ne plus4u:** během scanu se po každém `loadPage` překreslovaly všechny dlaždice (React fiber + MutationObserver na celý dokument). Po stovkách stránek to zablokovalo hlavní vlákno — proto i CDP polling na ~2 minuty ztichl, ačkoli `loadPage` kolem indexu 660 je ~60 ms a payload ~150–240 kB.
- **Scan:** progress jen aktualizuje tlačítko; značky na dlaždicích až po dokončení. MutationObserver během běhu nic nepřekresluje.
- **Haystack:** přeskakuje DOM/host objekty, `sys`/`session` a dlouhé `data:` URI; regex nad velkým textem jde po 80 kB oknech, ať jedna obří uu5 stránka nespustí minutový parse.

### 1.4.7 — 2026-09-08

- **Příčina zasekávání:** full scan posílal `loadPage` tempem ~30 req/s; po ~600 stránkách BookKit spadl na „Unknown Error“, FileManager zmizel a UI vypadalo jako freeze. Samotné stránky kolem indexu 610–680 jsou rychlé (~60 ms).
- **Tempo:** globální rate-limit 150 ms mezi starty `loadPage` (~6–7 req/s); nad 1000 stránek jediný worker, pod tím dva místo čtyř.
- **Fail-fast:** když FileManager nebo stránka zmizí (Unknown Error / reload), scan se zastaví místo dalších stovek requestů.

### 1.4.6 — 2026-09-07

- **Stabilita full scanu:** progress UI je throttlované a zpracování stránek pravidelně uvolňuje browser macrotask, takže vykreslení, BrowserBridge a timeouty dostanou prostor i u tisíců stránek.
- **Paměť a fail-closed:** page haystack používá jednoprůchodový cycle-safe traversal s limity 100 000 uzlů / 5 MB stringů; překročení se započte jako selhaná stránka bez cache a kandidátů.
- **Velké knihy:** nad 1 000 stránek se concurrency sníží ze 4 na 2; zachován 15s `loadPage` timeout a volitelný 404 intro.

### 1.4.5 — 2026-09-07

- **Scan:** každý `loadPage` má 15s timeout, takže zavěšený AppClient Promise nezablokuje celý scan; stránka se započte jako selhaná a další stránky pokračují bez automatického retry.
- **Bezpečnost výsledku:** pozdní dokončení původního timeoutovaného requestu už nemůže změnit `pathsByCode`; při částečném selhání se nezapíše cache, nezobrazí definitivní 0× a **Označit kandidáty** zůstane vypnuté.
- **Testy:** přidán obecný Promise timeout helper a testy úspěchu, odmítnutí, timeoutu a pokračování `mapPool` po selhání stránky.

### 1.4.4 — 2026-08-28

- **Scan:** legitimní absence intro (HTTP 404, uuApp kódy typu `introDoesNotExist`) scan neukončí — pokračuje bez intra, bez navýšení `failedCount`; prázdná úspěšná odpověď je nefatální.
- **Scan:** auth (401/403), síť/timeout, 5xx, parsovací a neznámé chyby `getIntro` zůstávají fail-closed (`usageScan.error`, `done=false`, bez cache/kandidátů); `listPages` povinné beze změny.
- **Testy:** unit testy pro `isMissingIntroError` a `loadOptionalIntro`.

### 1.4.3 — 2026-08-27

- **Detekce:** `pageHaystack` rekurzivně sbírá stringy z celého payloadu stránky včetně bezpečné JSON serializace; rozšířené vzory pro `src`, `dataUri`, `srcUri`, `href` (atributy, JSON, URL s `?code=`) a normalizace HTML entit / URL-encodingu.
- **Scan:** selhání `listPages` nebo `getIntro` ukončí scan chybou (`usageScan.error`, `done=false`), bez cache a bez kandidátů — fail-closed.
- Tlačítko přejmenováno na **Označit kandidáty** / **Select candidates** (heuristický výsledek, ne definitivní „nepoužité“).

### 1.4.2 — 2026-08-27

- Přidáno tlačítko **Označit nepoužité**, které se zpřístupní jen po úplném ověření bez chyb a přidá rozpoznané nepoužité přílohy do nativního výběru pro hromadné akce.
- Výběr pracuje i s nevykreslenými položkami virtualizovaného FileManageru a zachová již označené soubory.

### 1.4.1 — 2026-08-27

- Adopce kolegova **uuBookKit – FileManager 1.4.0** (autor Lukáš Vyleťal; SHA-256 `C3035143B5C2AF747F5BFF6D2CF700F2A9757F4C2399105836942FC18E8B8850`) do repozitáře pod MIT (jen tento skript / `LICENSES/MIT.txt`).
- **Auth:** žádné odposlouchávání `Authorization` z XHR/fetch; BookKit uuCmd přes `Plus4U5.Utils.AppClient` s fallbackem same-origin fetch + sessionStorage token scan (jako fulltext search).
- **Síť:** pasivní hook pouze pro velikosti z `listBinaries`/`listDictionaryEntries`/`listPublicDictionaryEntries`; aktivní dotaz velikostí jednou na AWID při zobrazeném FileManageru.
- **Usage scan:** heuristika rozšířena (`binaryCode`, `attachmentCode`, `fileCode`, `srcUri`); nepoužité přílohy se označí jen po úplném scanu bez chyb; při selhání stránek varování na tlačítku, ne definitivní červená; cache `gm-bk-att-usage:v4:` se při chybách nezapisuje.
- AWID parser včetně prefixovaných workspace ID; singleton lifecycle; size sorter retry max 10 s; factory pattern + unit testy; bez `@include`.

---

## message-registry-preview-downloads.user.js (uuCloudg02)

### 1.39 — 2026-08-06

- **Ikona message source (`<>`) chyběla u zpráv bez interního payloadu** (např. Rejected s jediným tlačítkem „Stáhnout externí obsah“). Kotva se hledala výhradně na `internal-payload-button`, takže ikona nikdy nevznikla, i když `message/get` funguje.
- Kotvení nově na jakékoli payload tlačítko (`PAYLOAD_BUTTON_SELECTOR`), interní má přednost; na jednu skupinu tlačítek se přidá právě jedna ikona, takže u zpráv s interním i externím payloadem se chování nemění.

### 1.38 — 2026-08-06

- Merge kolegových úprav (draft 1.37) do g02; verze **1.38** přebíjí jeho 1.37 při update v Tampermonkey.
- **Env mapování maing01 → commproxy:** kromě trial doplněno int (`004172011…` → `004172017…`) a prod (`004111011…` → `004111017…`), aby preview payloadů / message source fungovalo i mimo trial.
- **Message ID podle místa kliknutí:** v modalu se ID bere z DOM modalu (URL ukazuje jinou zprávu); mimo modal z hlavní stránky, URL jen jako fallback. Opravy preview v linkované zprávě.
- **Open in new window u Links:** u Message ID v sekci Odkazy ikona `target="_blank"` (bez otevření modalu) na `…/dataFlows/messages?displayMessageId=` nebo legacy `…/messageDetail?messageId=`.
- **Zachováno z 1.34:** oddělení HTTP status řádku (`HTTP/1.x …`) od body při formátování / highlight preview (`splitHttpStatusPrefix` / `splitPreviewPrefix`).
- Platí jen pro uuCloudg02 (`message-registry-preview-downloads.user.js`); varianta uucloud1 beze změny.

### 1.34 — 2026-08-06

- Structured prefix detection rozšířeno o HTTP status řádek; preview umí oddělit `HTTP/…` od JSON/XML body.
- Promise-safe fetch interceptor (GM/Firefox): bez `async` / `.then` na návratové hodnotě `fetch`.

### 1.32

- Efektivnější refresh injectované UI na message detail.

### 1.31

- Hover styly pro řádky audit logu.

### 1.30

- Lepší vizuální handling stavů audit logu (schema / styly).

### 1.29

- Rozšíření message detail context a UI aktualizací.

### 1.24

- Indikátory severity v audit logu.

### 1.23

- Caching message source a request handling.

### 1.21

- První `MESSAGE_API_BASE_URI_OVERRIDES` (trial maing01 → commproxy) pro payload/source API.

### 1.20

- Vylepšení zjišťování message detail contextu.

---

## message-registry-preview-downloads.uucloud1.user.js (UUCloud1)

### 1.20 — 2026-08-06

- Promise-safe fetch interceptor (GM/Firefox) a duck-typing `isRequestLike` (bez `instanceof Request`).
- Verze sladěna s údržbou fetch interceptoru; funkční parity s g02 mimo cloud-specific match / API cesty.

---

## cursor-usage-statistics.user.js

### 1.3.13 — 2026-08-06

- **Panel se nenasadil po klientském přechodu na Usage.** `@match` pokrýval jen `/dashboard/usage*`, takže při vstupu přes `cursor.com/dashboard` (SPA) se skript vůbec nespustil a bylo nutné stránku ručně refreshovat. `@match` je nově `https://cursor.com/dashboard*`.
- Detekce změny routy hlídáním `location.href` (+ `popstate` / `hashchange`) místo patchování `history.pushState` — vyhýbá se Xray problémům ve Firefoxu.
- Mount panelu i načítání dat je nově omezeno na `/dashboard/usage`, aby se panel neobjevoval a usage API nestahovalo na ostatních routách dashboardu.
- Při odchodu z Usage se panel (včetně nápovědy) odstraní; při návratu se překreslí z cache, bez zbytečného reloadu.
