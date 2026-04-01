const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const USERSCRIPT_PATH = path.resolve(__dirname, "..", "jsonata-java-checker.js");
const USERSCRIPT_SOURCE = fs.readFileSync(USERSCRIPT_PATH, "utf8");

(async () => {
  const requests = [];
  let expectedEditorValues = null;

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  try {
    const page = await browser.newPage();
    await page.setBypassCSP(true);

    page.on("console", (msg) => {
      console.log("PAGE", msg.type(), msg.text());
    });

    await page.exposeFunction("__jsonataJavaCheckerMockRequest", async (details) => {
      requests.push(details);

      const payload = JSON.parse(details.data || "{}");
      assert.ok(expectedEditorValues, "Expected editor values should be captured before the Java check runs.");
      assert.equal(payload.expression, expectedEditorValues.expression, "Userscript should send the expression from the JSONata editor.");
      assert.equal(payload.inputValue, expectedEditorValues.input, "Userscript should send the JSON input from the JSON editor.");

      return {
        status: 200,
        responseText: JSON.stringify(JSON.parse(expectedEditorValues.result)),
      };
    });

    await page.evaluateOnNewDocument(() => {
      window.unsafeWindow = window;
      window.GM_xmlhttpRequest = (details) => {
        window
          .__jsonataJavaCheckerMockRequest({
            method: details.method || "GET",
            url: details.url || "",
            headers: details.headers || {},
            data: details.data || null,
          })
          .then((response) => {
            details.onload?.(response);
          })
          .catch((error) => {
            details.onerror?.({
              message: error?.message || String(error),
            });
          });
      };
    });

    await page.goto("https://try.jsonata.org/", { waitUntil: "networkidle2", timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.monaco?.editor?.getModels), { timeout: 60000 });
    await page.addScriptTag({ content: USERSCRIPT_SOURCE });

    await page.waitForFunction(() => Boolean(document.getElementById("jsonata-java-checker-run")), { timeout: 30000 });

    expectedEditorValues = await page.evaluate(() => {
      const models = window.monaco.editor.getModels();
      return {
        input: models[0].getValue().trim(),
        expression: models[2].getValue().trim(),
        result: models[3].getValue().trim(),
      };
    });

    await page.click("#jsonata-java-checker-run");

    await page.waitForFunction(
      () => {
        const button = document.getElementById("jsonata-java-checker-run");
        return button && !button.textContent.includes("Running");
      },
      { timeout: 30000 },
    );

    const uiState = await page.evaluate(() => {
      const button = document.getElementById("jsonata-java-checker-run");
      const toggle = document.getElementById("jsonata-java-checker-toggle-inline");
      const settings = document.getElementById("jsonata-java-checker-settings");

      return {
        buttonLabel: button?.textContent || null,
        statusTone: button?.dataset?.statusTone || null,
        toggleHidden: toggle?.hidden ?? null,
        settingsTitle: settings?.title || null,
        panelText: document.querySelector('[data-role="inline-output-fallback"]')?.textContent || null,
      };
    });

    assert.equal(requests.length, 1, "Expected exactly one mocked backend call after clicking Java check.");
    assert.match(requests[0].url, /^http:\/\/localhost:8097\//, "Userscript should call the configured local endpoint.");
    assert.equal(requests[0].method, "POST", "Userscript should use POST for the Java check call.");
    assert.ok(expectedEditorValues.input.includes('"Account"'), "Test should use the default JSON sample from try.jsonata.org.");
    assert.match(expectedEditorValues.expression, /^\$sum\(/, "Test should use the default JSONata sample from try.jsonata.org.");
    assert.equal(uiState.buttonLabel, "Java check: OK", "Java check button should report success after a matching response.");
    assert.equal(uiState.statusTone, "is-success", "Java check button should use success styling after a matching response.");
    assert.equal(uiState.toggleHidden, false, "Detail toggle should be visible after a successful Java check.");
    assert.match(uiState.settingsTitle || "", /localhost:8097/, "Settings button should expose the configured endpoint in its title.");

    console.log(JSON.stringify({ expectedEditorValues, requests, uiState }, null, 2));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
