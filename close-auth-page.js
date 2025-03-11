// ==UserScript==
// @name         Plus4U - Autoclose authentication page
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.0
// @description  Automatically closes the authentication page after successful login.
// @author       Lukáš Sedláček
// @match        https://uuidentity.plus4u.net/uu-identitymanagement-maing01/*showAuthorizationCode*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/close-auth-page.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/close-auth-page.js
// ==/UserScript==

(function () {
  "use strict";

  const checkTextInterval = setInterval(() => {
    if (document.body && document.body.innerText.includes("Uzavřete prosím tuto stránku")) {
      clearInterval(checkTextInterval);
      window.close();
    }
  }, 500); // Kontrola každých 500 ms
})();
