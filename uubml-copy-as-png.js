// ==UserScript==
// @name         Bookkit - Přidat tlačítko ke SVG + oprava výběru
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      1.9
// @description  Přidává tlačítko pro kopírování SVG jako PNG vedle existujících tlačítek a opravuje výběr SVG elementu.
// @author       Lukáš Sedláček
// @match        https://uuapp.plus4u.net/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/uubml-copy-as-png.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/uubml-copy-as-png.js
// ==/UserScript==

(function () {
  "use strict";

  function showCustomNotification(message, success = true) {
    const notification = document.createElement("div");
    notification.textContent = message;
    notification.style.position = "fixed";
    notification.style.bottom = "20px";
    notification.style.right = "20px";
    notification.style.backgroundColor = success ? "#28a745" : "#dc3545";
    notification.style.color = "white";
    notification.style.padding = "10px 15px";
    notification.style.borderRadius = "5px";
    notification.style.boxShadow = "0px 0px 10px rgba(0, 0, 0, 0.2)";
    notification.style.fontSize = "14px";
    notification.style.zIndex = "10000";
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), 3000);
  }

  async function copySvgToClipboard(svgElement) {
    if (!svgElement) {
      showCustomNotification("SVG nebylo nalezeno!", false);
      return;
    }

    const clonedSvg = svgElement.cloneNode(true);

    // Zkopírování všech computed style na klonované SVG
    function copyComputedStyles(source, target) {
      const computedStyle = window.getComputedStyle(source);
      for (let property of computedStyle) {
        if (!property.startsWith("-webkit-") && !property.startsWith("scale")) {
          target.style[property] = computedStyle.getPropertyValue(property);
        }
      }
    }

    function applyStylesRecursively(original, clone) {
      copyComputedStyles(original, clone);
    }

    applyStylesRecursively(svgElement, clonedSvg);

    // Resetování transformací na scale(1)
    clonedSvg.style.scale = 1;

    const width = svgElement.getAttribute("width");
    const height = svgElement.getAttribute("height");

    // Vložíme klonované SVG vedle původního (do stejného parenta)
    //const parent = svgElement.parentNode;
    //parent.appendChild(clonedSvg);
    document.body.appendChild(clonedSvg);

    // Převod SVG do Base64
    const serializer = new XMLSerializer();
    let svgString = serializer.serializeToString(clonedSvg);

    // Správná deklarace XML
    if (!svgString.startsWith("<?xml")) {
      svgString = '<?xml version="1.0" encoding="UTF-8"?>' + svgString;
    }

    const base64Svg = btoa(unescape(encodeURIComponent(svgString)));
    const imgSrc = `data:image/svg+xml;base64,${base64Svg}`;

    const img = new Image();

    img.onload = async function () {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");

      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(async (blob) => {
        if (!blob) {
          showCustomNotification("Chyba při převodu!", false);
          return;
        }

        try {
          const clipboardItem = new ClipboardItem({ "image/png": blob });
          await navigator.clipboard.write([clipboardItem]);
          showCustomNotification("Obrázek zkopírován do schránky!");
        } catch (err) {
          showCustomNotification("Chyba kopírování: " + err.message, false);
        }
      }, "image/png");

      // Po konverzi do canvas klon odstraníme
      clonedSvg.remove();
    };

    img.onerror = function () {
      showCustomNotification("Chyba při načítání obrázku!", false);
      clonedSvg.remove();
    };

    img.src = imgSrc;
  }

  function addButtonToControls() {
    document.querySelectorAll('svg[class^="uubml-draw-diagram-"]').forEach((svgElement) => {
      let parentDiv = svgElement.closest("section")?.querySelector("div > div > div ");
      if (!parentDiv || parentDiv.querySelector(".copy-svg-button")) return;

      const button = document.createElement("button");
      button.textContent = "📷 Kopírovat jako PNG";
      button.className = "copy-svg-button";
      button.style.margin = "5px";
      button.style.padding = "5px 10px";
      // button.style.backgroundColor = '#007bff';
      // button.style.color = 'white';
      button.style.border = "none";
      button.style.borderRadius = "5px";
      button.style.cursor = "pointer";
      button.style.fontSize = "12px";

      button.addEventListener("click", function () {
        copySvgToClipboard(svgElement);
      });

      parentDiv.prepend(button);
    });
  }

  function observeChanges() {
    const observer = new MutationObserver(() => {
      addButtonToControls();
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(addButtonToControls, 2000);
  }

  window.addEventListener("load", observeChanges);
})();
