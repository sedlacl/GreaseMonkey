# Changelogs

Záznamy změn userscriptů v tomto repozitáři. Nejnovější verze je vždy nahoře v sekci skriptu.
Pravidlo: při každém bumpnutí `@version` doplň záznam zde (viz `.cursor/rules/changelogs.mdc`).

---

## bookkit-file-manager.user.js

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
