// ==UserScript==
// @name         JSONATA JAVA Checker
// @namespace    https://github.com/sedlacl/GreaseMonkey
// @version      0.3
// @description  JSONata kontrola přes lokální Java backend
// @author       Lukáš Sedláček
// @match        https://try.jsonata.org/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=jsonata.org
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/jsonata-java-checker.js
// @downloadURL  https://raw.githubusercontent.com/sedlacl/GreaseMonkey/refs/heads/main/jsonata-java-checker.js
// ==/UserScript==

(function () {
  "use strict";

  function getElementByXpath(path) {
    return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  }

  function postData(url = "", data = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: url,
        headers: {
          "Content-Type": "application/json",
        },
        data: JSON.stringify(data),
        onload: function (response) {
          try {
            const json = JSON.parse(response.responseText);
            resolve(json);
          } catch (e) {
            reject(e);
          }
        },
        onerror: function (err) {
          reject(err);
        },
        ontimeout: function (err) {
          reject(err);
        },
      });
    });
  }

  let layout = getElementByXpath("/html/body/div[1]/div/main/div/div/div[2]/div");

  let remoteOutputDivider = document.createElement("SPAN");
  remoteOutputDivider.classList.add("Resizer", "horizontal");
  layout.append(remoteOutputDivider);

  let remoteOutput = document.createElement("PRE");
  remoteOutput.style.cssText = "overflow:auto;flex: 1 1 0%; position: relative; color: khaki;";
  remoteOutput.innerText = "Click the button";
  layout.append(remoteOutput);

  let remoteOutputNotify = document.createElement("DIV");
  remoteOutputNotify.style.cssText = "color: red;";
  remoteOutputNotify.innerText = "Click the button";
  layout.append(remoteOutputNotify);

  let btn = document.createElement("BUTTON");
  btn.setAttribute("content", "test content");
  btn.setAttribute("class", "btn");
  btn.style.cssText = "padding: 5px;";
  btn.textContent = "http://localhost:8097/usy-idsmari-mddpg01/00361100020000000000000000000104";

  btn.onclick = () => {
    const monaco = unsafeWindow.monaco;

    const inputValue = monaco.editor
      .getModel("inmemory://model/1")
      .getValue()
      .replace(/&nbsp;/g, " ")
      .trim();
    const expression = monaco.editor
      .getModel("inmemory://model/3")
      .getValue()
      .replace(/&nbsp;/g, " ")
      .trim();
    const result = monaco.editor
      .getModel("inmemory://model/4")
      .getValue()
      .replace(/&nbsp;/g, " ")
      .trim();

    const dtoIn = {
      expression: expression,
      inputValue: inputValue,
    };

    remoteOutputNotify.innerText = "Calling localhost...";

    postData("http://localhost:8097/usy-idsmari-mddpg01/00361100020000000000000000000104/mddp/debug/jsonata", dtoIn)
      .then((data) => {
        remoteOutput.innerText = JSON.stringify(data, undefined, 2);
        try {
          remoteOutputNotify.innerText = JSON.stringify(JSON.parse(result)) === JSON.stringify(data) ? "OK (výsledek sedí)" : "NESHODA (výsledek nesedí)";
        } catch (e) {
          remoteOutputNotify.innerText = "Chyba při parsování lokálního výsledku: " + e;
        }
      })
      .catch((err) => {
        remoteOutput.innerText = "";
        remoteOutputNotify.innerText = "Chyba volání localhost: " + err;
        console.error(err);
      });
  };

  const rightMenu = document.getElementById("banner4");
  rightMenu.prepend(btn);
})();
