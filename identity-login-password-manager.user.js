// ==UserScript==
// @name         Plus4U - Identity login password manager bridge
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.1
// @description  Adds password-manager-friendly proxy fields to uuIdentity login forms and syncs them into the original access code inputs.
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
  const USERNAME_SELECTOR = [
    'input[name="username"]',
    'input[name="login"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
  ].join(", ");

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .tm-password-manager-source-wrapper {
        display: none !important;
      }

      .tm-password-manager-proxy {
        position: relative;
      }

      .tm-password-manager-proxy .uu5-forms-input-form-item {
        background-color: #f7fbfc;
        padding-left: 36px;
      }

      .tm-password-manager-proxy__icon {
        position: absolute;
        left: 12px;
        top: 50%;
        z-index: 2;
        width: 16px;
        height: 16px;
        color: #607d8b;
        transform: translateY(-50%);
        pointer-events: none;
      }

      .tm-password-manager-proxy__icon svg {
        display: block;
        width: 100%;
        height: 100%;
      }
    `;

    document.head.appendChild(style);
  }

  function dispatchInputLikeEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function copyValue(source, target) {
    if (!target || target.value === source.value) {
      return;
    }

    target.value = source.value;
    dispatchInputLikeEvents(target);
  }

  function decorateUsernameField(field) {
    if (!field || field.dataset.tmPasswordManagerDecorated === "true") {
      return;
    }

    field.dataset.tmPasswordManagerDecorated = "true";
    field.autocomplete = "username";
    if (!field.name || /^input/u.test(field.name)) {
      field.name = "username";
    }

    if (!field.id) {
      field.id = "tm-login-username";
    }
  }

  function decorateAccessCodeField(field, index) {
    if (!field) {
      return;
    }

    field.type = "hidden";
    field.removeAttribute("autocomplete");
    field.setAttribute("aria-hidden", "true");
    field.setAttribute("tabindex", "-1");
    field.setAttribute("data-lpignore", "true");
    field.setAttribute("data-1p-ignore", "true");
    field.setAttribute("data-form-type", "other");
    field.dataset.tmPasswordManagerDecorated = "true";
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
    icon.className = "tm-password-manager-proxy__icon";
    icon.setAttribute("aria-hidden", "true");

    icon.innerHTML =
      iconType === "username"
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="7" r="4"></circle></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><path d="M7 11V8a5 5 0 0 1 10 0v3"></path></svg>';

    return icon;
  }

  function createProxyField({ form, target, fieldName, type, autocomplete, inputMode, iconType, placeholder }) {
    const sourceWrapper = target.closest(".uu5-forms-input");
    if (!sourceWrapper || sourceWrapper.previousElementSibling?.dataset.tmPasswordManagerProxy === "true") {
      return;
    }

    const wrapper = sourceWrapper.cloneNode(true);
    wrapper.classList.add("tm-password-manager-proxy");
    wrapper.dataset.tmPasswordManagerProxy = "true";

    const input = wrapper.querySelector("input");
    if (!input) {
      return;
    }

    input.value = target.value;
    input.name = fieldName;
    input.type = type;
    input.autocomplete = autocomplete;
    input.inputMode = inputMode;
    input.spellcheck = false;
    input.placeholder = placeholder || target.placeholder || "";
    input.style.paddingLeft = "36px";
    input.setAttribute("data-lpignore", "false");
    input.setAttribute("data-1p-ignore", "false");
    input.setAttribute("aria-label", target.placeholder || fieldName);

    const proxyId = `tm-password-manager-${fieldName}`;
    input.id = proxyId;
    wrapper.querySelectorAll("label").forEach((label) => {
      label.htmlFor = proxyId;
    });

    const inputContainer = wrapper.querySelector(".uu5-forms-text-input");
    if (inputContainer) {
      inputContainer.prepend(createIcon(iconType));
    }

    sourceWrapper.classList.add("tm-password-manager-source-wrapper");

    const syncToTarget = () => {
      copyValue(input, target);
    };

    input.addEventListener("input", syncToTarget);
    input.addEventListener("change", syncToTarget);
    input.addEventListener("blur", syncToTarget);

    target.addEventListener("input", () => {
      if (document.activeElement !== input && input.value !== target.value) {
        input.value = target.value;
      }
    });

    const visibilityToggle = wrapper.querySelector("button, [role='button']");
    if (visibilityToggle) {
      visibilityToggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        input.type = input.type === "password" ? "text" : "password";
      });
    }

    sourceWrapper.before(wrapper);

    form.addEventListener("submit", syncToTarget, { capture: true });
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

    const usernameField = form.querySelector(USERNAME_SELECTOR);
    decorateUsernameField(usernameField);
    decorateAccessCodeField(accessCode1, 0);
    decorateAccessCodeField(accessCode2, 1);

    form.dataset.tmPasswordManagerBridgeReady = "true";

    createProxyField({
      form,
      target: accessCode1,
      fieldName: "username",
      type: "text",
      autocomplete: "username",
      inputMode: "text",
      iconType: "username",
      placeholder: "Jméno",
    });

    createProxyField({
      form,
      target: accessCode2,
      fieldName: "password",
      type: "password",
      autocomplete: "current-password",
      inputMode: "text",
      iconType: "password",
      placeholder: "Heslo",
    });

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
