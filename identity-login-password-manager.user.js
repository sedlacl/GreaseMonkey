// ==UserScript==
// @name         Plus4U - Identity login password manager bridge
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.6
// @description  Adds password-manager-friendly overlay fields to uuIdentity login forms and syncs them into the original access code inputs.
// @author       Lukáš Sedláček
// @match        *://*/uu-identitymanagement-maing01/*/login*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/identity-login-password-manager.user.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/identity-login-password-manager.user.js
// ==/UserScript==

(function () {
  "use strict";

  const STYLE_ID = "tm-password-manager-bridge-style";
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .tm-password-manager-host {
        position: relative;
      }

      .tm-password-manager-host .uu5-forms-text-input {
        position: relative;
        min-height: 40px;
      }

      .tm-password-manager-host .tm-password-manager-underlay {
        position: absolute !important;
        inset: 0 !important;
        width: 100% !important;
        height: 40px !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
        margin: 0 !important;
        z-index: 1 !important;
      }

      .tm-password-manager-host .tm-password-manager-overlay {
        position: absolute !important;
        inset: 0 !important;
        display: block !important;
        width: 100% !important;
        height: 40px !important;
        box-sizing: border-box !important;
        margin: 0 !important;
        padding: 9px 40px 10px 36px !important;
        border: 1px solid #bdbdbd !important;
        border-radius: 2px !important;
        background-color: #f7fbfc !important;
        color: rgba(0, 0, 0, 0.87) !important;
        font: inherit !important;
        z-index: 2 !important;
      }

      .tm-password-manager-host .tm-password-manager-overlay:focus {
        outline: none;
        border-color: #1976d2;
        box-shadow: 0 0 0 1px #1976d2;
      }

      .tm-password-manager-host .tm-password-manager-overlay--masked {
        -webkit-text-security: disc;
      }

      .tm-password-manager-host .tm-password-manager-icon {
        position: absolute !important;
        left: 12px !important;
        top: 50% !important;
        display: block !important;
        width: 16px !important;
        min-width: 16px !important;
        max-width: 16px !important;
        height: 16px !important;
        min-height: 16px !important;
        max-height: 16px !important;
        overflow: hidden !important;
        color: #607d8b !important;
        line-height: 0 !important;
        transform: translateY(-50%) !important;
        pointer-events: none !important;
        z-index: 3 !important;
      }

      .tm-password-manager-host .tm-password-manager-icon svg {
        display: block !important;
        width: 16px !important;
        height: 16px !important;
      }

      .tm-password-manager-host .uu5-forms-text-input-reveal-button,
      .tm-password-manager-host button,
      .tm-password-manager-host [role='button'] {
        position: absolute !important;
        top: 0 !important;
        right: 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 40px !important;
        height: 40px !important;
        opacity: 1 !important;
        visibility: visible !important;
        background: transparent !important;
        z-index: 4 !important;
      }

      .tm-password-manager-host .uu5-forms-text-input-reveal-icon,
      .tm-password-manager-host .uu5-bricks-icon {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 20px !important;
        height: 20px !important;
        font-size: 20px !important;
        line-height: 1 !important;
        color: #607d8b !important;
      }
    `;

    document.head.appendChild(style);
  }

  function driveOriginalField(field, value) {
    if (!field || !nativeInputValueSetter || field.value === value) {
      return;
    }

    nativeInputValueSetter.call(field, value);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function decorateAccessCodeField(field, index) {
    const wrapper = field?.closest(".uu5-forms-input");
    if (!field || !wrapper) {
      return;
    }

    wrapper.classList.add("tm-password-manager-host");
    field.classList.add("tm-password-manager-underlay");
    field.setAttribute("aria-hidden", "true");
    field.setAttribute("tabindex", "-1");
    field.setAttribute("data-lpignore", "true");
    field.setAttribute("data-1p-ignore", "true");

    if (!field.dataset.tmOriginalPlaceholder) {
      field.dataset.tmOriginalPlaceholder = field.placeholder || "";
    }

    if (index === 0) {
      field.placeholder = "Jméno";
    } else {
      field.placeholder = "Heslo";
    }
  }

  function findLoginForm() {
    const formCandidates = Array.from(document.querySelectorAll("form"));
    return (
      formCandidates.find((form) => {
        const accessCodeInputs = form.querySelectorAll('input[name="accessCode1"], input[name="accessCode2"]');
        return accessCodeInputs.length >= 2;
      }) || null
    );
  }

  function createIcon(iconType) {
    const icon = document.createElement("span");
    icon.className = "tm-password-manager-icon";
    icon.setAttribute("aria-hidden", "true");

    icon.innerHTML =
      iconType === "username"
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="7" r="4"></circle></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V8a5 5 0 0 1 10 0v3"></path></svg>';

    return icon;
  }

  function createOverlayField(field, index) {
    const wrapper = field.closest(".uu5-forms-input");
    if (!wrapper) {
      return;
    }

    const inputContainer = wrapper.querySelector(".uu5-forms-text-input");
    if (!inputContainer) {
      return;
    }

    let overlay = inputContainer.querySelector(".tm-password-manager-overlay");
    if (!overlay) {
      overlay = document.createElement("input");
      overlay.className = "tm-password-manager-overlay";
      overlay.type = index === 0 ? "text" : "password";
      overlay.name = index === 0 ? "username" : "password";
      overlay.autocomplete = index === 0 ? "username" : "current-password";
      overlay.inputMode = "text";
      overlay.spellcheck = false;
      overlay.placeholder = index === 0 ? "Jméno" : "Heslo";
      overlay.value = field.value;
      overlay.setAttribute("aria-label", overlay.placeholder);
      overlay.setAttribute("data-lpignore", "false");
      overlay.setAttribute("data-1p-ignore", "false");
      overlay.dataset.tmOverlayFor = field.name;

      if (index === 0) {
        overlay.classList.add("tm-password-manager-overlay--masked");
        overlay.dataset.tmMaskedUsername = "true";
      }

      inputContainer.prepend(overlay);

      overlay.addEventListener("input", () => {
        driveOriginalField(field, overlay.value);
      });

      overlay.addEventListener("change", () => {
        driveOriginalField(field, overlay.value);
      });

      field.addEventListener("input", () => {
        if (document.activeElement !== overlay && overlay.value !== field.value) {
          overlay.value = field.value;
        }
      });
    }

    if (!inputContainer.querySelector(".tm-password-manager-icon")) {
      inputContainer.prepend(createIcon(index === 0 ? "username" : "password"));
    }

    const visibilityToggle = wrapper.querySelector("button, [role='button']");
    if (visibilityToggle && visibilityToggle.dataset.tmPasswordManagerBound !== "true") {
      visibilityToggle.dataset.tmPasswordManagerBound = "true";
      visibilityToggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (overlay.dataset.tmMaskedUsername === "true") {
          overlay.classList.toggle("tm-password-manager-overlay--masked");
          return;
        }

        overlay.type = overlay.type === "password" ? "text" : "password";
      });
    }
  }

  function setupPasswordManagerBridge() {
    const form = findLoginForm();
    if (!form || form.dataset.tmPasswordManagerBridgeReady === "true") {
      return false;
    }

    const accessCode1 = form.querySelector('input[name="accessCode1"]');
    const accessCode2 = form.querySelector('input[name="accessCode2"]');
    if (!accessCode1 || !accessCode2) {
      return false;
    }

    ensureStyles();
    decorateAccessCodeField(accessCode1, 0);
    decorateAccessCodeField(accessCode2, 1);
    createOverlayField(accessCode1, 0);
    createOverlayField(accessCode2, 1);

    form.dataset.tmPasswordManagerBridgeReady = "true";

    return true;
  }

  const observer = new MutationObserver(() => {
    if (setupPasswordManagerBridge()) {
      observer.disconnect();
    }
  });

  if (!setupPasswordManagerBridge()) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener(
      "load",
      () => {
        if (setupPasswordManagerBridge()) {
          observer.disconnect();
        }
      },
      { once: true },
    );
  }
})();
