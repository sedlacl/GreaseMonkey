(function () {
  "use strict";

  const bootstrapSrc = document.currentScript?.src || "";
  const bridgeRoot = bootstrapSrc
    ? bootstrapSrc.includes("/tools/")
      ? bootstrapSrc.replace(/\/tools\/[^/]+$/, "/")
      : bootstrapSrc.replace(/\/[^/]+$/, "/")
    : "http://127.0.0.1:8766/";
  const USER_SCRIPT_URL = `${bridgeRoot}bookkit-file-manager.user.js`;

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
    document.getElementById("gm-bk-file-manager-style")?.remove();
    document
      .querySelectorAll(
        ".bk-attachment-usage-btn, .bk-attachment-select-unused-btn, .bk-attachment-usage-btn-fallback",
      )
      .forEach((node) => node.remove());
    document.querySelectorAll(".bk-attachment-corner, .bk-attachment-unused-overlay").forEach((node) => node.remove());
    document.querySelectorAll(".bk-attachment-unused").forEach((node) => node.classList.remove("bk-attachment-unused"));
    try {
      delete window.__gmBookKitFileManager;
      delete window.__gmBkFmNetHooked;
      delete window.__gmBkSizeSorterHooked;
    } catch {
      // Ignore non-configurable flags from a previous Tampermonkey instance.
    }
  }

  teardown();

  (async () => {
    try {
      await loadScript(USER_SCRIPT_URL);
      console.log("[gm-bookkit-file-manager] loaded", {
        version: window.__gmBookKitFileManager ? "flag-set" : "unknown",
        button: !!document.querySelector(".bk-attachment-usage-btn"),
        userScript: USER_SCRIPT_URL,
      });
    } catch (error) {
      console.error("[gm-bookkit-file-manager] bootstrap failed", error);
    }
  })();
})();
