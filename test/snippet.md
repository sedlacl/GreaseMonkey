# Lokální reload uuBookKit Fulltext Search

Nejdřív spusť bridge server ve složce `tools` (servíruje i dev skripty):

```bash
cd tools
npm start
```

V prohlížeči musí běžet userscript `tools/browser-bridge.user.js` (polling na port 8766).

## Bookmarklet (jeden řádek)

### Varianta A — nejkratší (doporučená)

Vlož do záložky prohlížeče jako URL (Chrome někdy `javascript:` v omnibaru blokuje, záložka funguje spolehlivě):

```
javascript:void(document.head.appendChild(Object.assign(document.createElement("script"),{src:"http://127.0.0.1:8766/tools/bookkit-fulltext-search.bootstrap.js"})))
```

### Varianta B — syntaxe `load("...")`

```
javascript:load=function(u){document.head.appendChild(Object.assign(document.createElement("script"),{src:u}))};load("http://127.0.0.1:8766/tools/bookkit-fulltext-search.bootstrap.js")
```

Obě varianty načtou bootstrap z bridge serveru, který smaže starou instanci, dočte MiniSearch a pak hlavní skript z kořene repa.

## Konzole

```javascript
void document.head.appendChild(
  Object.assign(document.createElement("script"), {
    src: "http://127.0.0.1:8766/tools/bookkit-fulltext-search.bootstrap.js",
  }),
);
```

## Ověření

Bridge health:

```bash
cd tools
npm run bridge:health
```

Po načtení skriptu v konzoli uvidíš:

```
[gm-bookkit-fulltext] loaded { trigger: true, miniSearch: "function", userScript: "..." }
```
