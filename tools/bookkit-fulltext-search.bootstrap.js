(function () {
  "use strict";

  const MINISEARCH_URL = "https://cdn.jsdelivr.net/npm/minisearch@7.1.2/dist/umd/index.min.js";
  const bootstrapSrc = document.currentScript?.src || "";
  const bridgeRoot = bootstrapSrc
    ? bootstrapSrc.includes("/tools/")
      ? bootstrapSrc.replace(/\/tools\/[^/]+$/, "/")
      : bootstrapSrc.replace(/\/[^/]+$/, "/")
    : "http://127.0.0.1:8766/";
  const USER_SCRIPT_URL = `${bridgeRoot}bookkit-fulltext-search.user.js`;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve(src);
      script.onerror = () => reject(new Error(`Failed to load: ${src}`));
      document.head.appendChild(script);
    });
  }

  function teardown() {
    try {
      window.__gmBookKitFulltextState?.db?.close();
    } catch {
      // Ignore already closed database connections.
    }
    delete window.__gmBookKitFulltextSearch;
    delete window.__gmBookKitFulltextState;
    document.getElementById("gm-bookkit-fulltext-triggers")?.remove();
    document.getElementById("gm-bookkit-fulltext-modal")?.remove();
    document.getElementById("gm-bookkit-fulltext-style")?.remove();
    document.getElementById("gm-bookkit-fulltext-nav-menu")?.remove();
    document.getElementById("gm-bookkit-fulltext-trigger")?.remove();
  }

  teardown();

  (async () => {
    try {
      if (!window.MiniSearch) {
        await loadScript(MINISEARCH_URL);
      }
      await loadScript(USER_SCRIPT_URL);
      console.log("[gm-bookkit-fulltext] loaded", {
        trigger: !!document.getElementById("gm-bookkit-fulltext-trigger"),
        miniSearch: typeof window.MiniSearch,
        userScript: USER_SCRIPT_URL,
      });
    } catch (error) {
      console.error("[gm-bookkit-fulltext] bootstrap failed", error);
    }
  })();
})();
