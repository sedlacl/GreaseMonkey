---
name: upload-to-browser
description: >-
  Inject a local Tampermonkey userscript into the Cursor IDE browser as if
  Tampermonkey had started (UploadToBrowser). Use when the user asks to inject
  a .user.js into a Cursor browser tab, simulate Tampermonkey, test a userscript
  without BrowserBridge, or mentions UploadToBrowser, injektuj skript, vlastní
  inject, or Cursor browser without Tampermonkey.
---

# UploadToBrowser

Simuluje start Tampermonkey v **Cursor IDE browseru** (`cursor-ide-browser` MCP).
Tampermonkey tam není. HTTPS stránka **nesmí** tahat skript z `http://127.0.0.1`
(mixed content). BrowserBridge nepoužívej, pokud ho uživatel výslovně nechce.

Podporuje jen `@grant none`. Privilegovaná GM API neemuluj.

## Kdy otevřít nový tab

1. Uživatel řekne otevři URL v `@Browser` / Cursor browseru → `browser_navigate` (`newTab: true` jen když má vzniknout nový tab).
2. Přiložený tab nejde locknout/snapshotnout (`No browser tab available`) → **nevolej** `browser_navigate` na ten viewId. Otevři **nový** Cursor tab se stejnou URL.
3. Uživatel zakáže navigaci na přiloženém tabu → skonči s blockerem, nový tab nevytvářej.

Pořadí: `browser_navigate` → `browser_lock` → práce → na konci `browser_lock` s akcí `unlock`.

## Inject (povinný postup)

1. Do cílového tabu nastav přes MCP `Runtime.evaluate` unikátní marker:

```javascript
window.__uploadToBrowserTargetMarker = "<random-uuid>"
```

2. Použij přímý lokální DevTools inject. Zdroj se tak nepřepisuje ručně do tool callů:

```bash
node .cursor/skills/upload-to-browser/scripts/inject-devtools.mjs \
  --script "<abs-path.user.js>" \
  --marker "<stejny-random-uuid>" \
  --url-substring "<část location.href>"
```

Výstup musí obsahovat `result.ok: true`, správné `name`, `version`, počet `bytes`
a `gmInfo: true`.

3. Pokud lokální DevTools endpoint není dostupný, použij chunk fallback — **spusť**
generátor, nevytvářej vlastní chunker:

```bash
node .cursor/skills/upload-to-browser/scripts/prepare-inject.mjs --script "<abs-path.user.js>"
```

Příklad (spouštěj z kořene repa):

```bash
node .cursor/skills/upload-to-browser/scripts/prepare-inject.mjs --script "R:/External/GreaseMonkey/bookkit-file-manager.user.js"
```

Generátor vypíše JSON `manifest` (`evalDir`, `steps`, `meta`).

4. Ověř `meta.grant` je jen `none` a že `location.href` sedí na `@match`. Jinak stop.

5. CDP `Runtime.evaluate` s `returnByValue: true`, výraz = **přesný obsah** souboru z `evalDir`:
   - `00-bootstrap.js` → `"ready"`
   - všechny `01-chunk-NNN.js` lze poslat paralelně; každý vrátí `{ index, received, total }`
   - `99-commit.js` → `{ ok, bytes, version, name, gmInfo }`

   Bootstrap musí doběhnout před chunky a commit až po všech chunkech. Soubor čti z disku a vlož do `params.expression`. Nesahej na obsah. Když tool call spadne na velikosti, sniž `--chunk-bytes` (např. 2500) a připrav znovu.

6. Po injectu ověř runtime: `GM_info.scriptHandler === "UploadToBrowser"`, `GM_info.script.version`, UI skriptu (tlačítka/flag). Netvrď verzi, kterou nevidíš.

7. `@run-at document-start` po načtení stránky **nejde** dodržet. Inject je `document-idle`. Pro start před page JS: `Page.addScriptToEvaluateOnNewDocument` se stejným zdrojem a teprve potom navigate — jen pokud CDP přijme celý zdroj najednou; jinak zůstaň u post-load inject a přiznej omezení.

## Zakázané zkratky

- `fetch('http://127.0.0.1:...')` ze stránky
- `script.src` na localhost
- BrowserBridge bootstrap (`tools/bookkit-*.bootstrap.js`) jako výchozí cesta v Cursor browseru
- Předstírat `@grant` GM_* API
- Reload/navigace jen proto, že lock selhal na cizím tabu

## Úklid

Generované soubory patří do gitignored `.cursor/.tmp/upload-to-browser/`.
Konkrétní běh smaž po úspěšném injectu. HTTP static server kvůli injectu nespouštěj.
